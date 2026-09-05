// dsh-proxy-toggle — DSH 代理路由快捷开关（profile bundle 插件，主进程半边）
//
// 职责：
//   1. 在主进程安装一个全局 undici dispatcher 包装器：每个请求按短 TTL 热读
//      $DSH_HOME/vpn-proxy.json（默认 ~/.dsh/vpn-proxy.json），enabled 时把主进程
//      所有走全局 fetch 的流量（模型 API / Files API 等）隧道到本地代理端口，
//      关闭即直连。显式传入自有 undici dispatcher 的请求（例如
//      dsh-web-fetch-http）不经过此全局开关。内置 fetch 按请求读取全局 dispatcher
//      符号，且默认 dispatcher 只在首次请求时懒初始化——因此包装器永远挂在符号
//      上自行委托，绝不置 undefined。
//   2. 在 webServer（GUI 同源）注册控制路由：
//        GET  /vpn            状态 JSON（DSH 宿主会话、Bearer token 或浏览器会话）
//        GET  /vpn/ui         浏览器独立开关页（宿主会话直用；fallback 需显式启用）
//        POST /vpn/pair|renew|logout
//        POST /vpn/on|off|toggle|test|proxy（需要宿主会话或插件凭据）
//      控制面仅接受回环连接；转发头、Host 和 Origin 校验仍是部署防护，Web GUI
//      默认只复用 DSH connection 的宿主认证；只有 enableFallback=true 时，独立
//      回退端点才使用 $DSH_HOME/vpn-proxy.token、Bearer token 与持久化 HttpOnly 会话。
//   3. 经 tapIndex 向 Web GUI 注入右下角悬浮开关按钮（同源 fetch，无需 CORS）。
//   4. 全局热键（默认关闭，可在设置卡片启用）切换，并用系统通知反馈。
//   5. 设置卡片（设置 → 插件配置）：代理地址 / noProxy / 热键 / 悬浮按钮 / agent 指引。
//   6. systemPrompt 指引，让 agent 会话能替用户切换。
//
// 每一步失败都只记录日志，绝不阻断 DSH 启动。
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolveDshHome, dshHomeDisplay } from '@deepseek-ai/dsh-home-paths';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';
import z from '@deepseek-ai/schemastery';
import { createControlAuth } from './auth.js';
import { normalizeProxyServer, shouldProxy, isValidProxyUrl, normalizeUserProxy, proxyFromScutilOutput, isLoopbackHost } from './pure.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

let HOME = resolveDshHome();
let STATE_PATH = join(HOME, 'vpn-proxy.json');
function configureDshHome(configured) {
	const value = typeof configured === 'string' && configured.trim() !== '' ? configured : undefined;
	try {
		const next = resolveDshHome(value);
		if (next !== HOME) {
			HOME = next;
			STATE_PATH = join(HOME, 'vpn-proxy.json');
			cached = null;
			cachedAt = 0;
		}
	} catch (cause) {
		logErr('invalid dshHome configuration; using the current DSH home', cause);
	}
}
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
const DEFAULT_HOTKEY = ''; // 留空 = 默认不启用全局热键
const TAG = '[proxy-toggle]';

const log = (...a) => { try { console.log(TAG, ...a); } catch {} };
const logErr = (...a) => { try { console.error(TAG, ...a); } catch {} };

// Host-side UI language: follow the OS/app locale from Node ICU (zh -> the
// Chinese strings, anything else -> English). Renderer surfaces pick their
// own language independently (card/pill via navigator.language, the
// standalone page via Accept-Language), so each surface stays coherent.
const HOST_ZH = (() => {
	try {
		return String(Intl.DateTimeFormat().resolvedOptions().locale || 'zh').toLowerCase().startsWith('zh');
	} catch {
		return true;
	}
})();
const HOST = HOST_ZH ? {
	toggleTitle: 'DSH 代理开关',
	enabled: (proxy, suffix) => `已启用 → ${proxy}${suffix}`,
	disabled: (suffix) => `已关闭（直连）${suffix}`,
	switchedTo: (url) => `已自动切换 → ${url}`,
	scanNoSystem: (url) => `未探测到系统代理，端口扫描命中 ${url}`,
	scanHit: (url) => `已自动切换 → ${url}（端口扫描）`,
	proxyUnreachable: '代理端口无响应',
	lost: '代理失联，请求可能失败',
	recovered: '代理恢复',
	hintUnreachable: '代理端口无响应，检查代理客户端是否在运行',
	hintNoExit: '两个出口端点都不可达（网络不通或端点被墙）',
	hintCandidateDead: '代理路由未开启；所填代理端口无响应，检查客户端与端口',
	hintPending: '已通过该代理测得出口（代理路由未开启，打开开关后正式生效）',
	hintNoExitPending: '代理端口活着，但经它无法访问出口端点（该代理的出口不可用？）',
	hintAliveOnly: '代理端口存活（经代理的出口探测不可用）',
	hintDirectOff: '代理路由未开启，测试的是直连出口',
	dispatcherUnavailable: '代理 dispatcher 不可用，已拒绝开启以避免直连泄漏'
} : {
	toggleTitle: 'DSH Proxy Toggle',
	enabled: (proxy, suffix) => `Enabled → ${proxy}${suffix}`,
	disabled: (suffix) => `Off (direct)${suffix}`,
	switchedTo: (url) => `Auto-switched → ${url}`,
	scanNoSystem: (url) => `No system proxy found; port scan hit ${url}`,
	scanHit: (url) => `Auto-switched → ${url} (port scan)`,
	proxyUnreachable: 'Proxy port not responding',
	lost: 'Proxy lost - requests may fail',
	recovered: 'Proxy recovered',
	hintUnreachable: 'Proxy port not responding - check that the proxy client is running',
	hintNoExit: 'Neither exit endpoint is reachable (no network or the endpoint is blocked)',
	hintCandidateDead: 'Proxy routing is off; the configured proxy port is not responding - check client and port',
	hintPending: 'Exit reached through this proxy (proxy routing is off - flip the switch to apply it)',
	hintNoExitPending: 'Proxy port is alive but the exit is unreachable through it',
	hintAliveOnly: 'Proxy port is alive (exit probe through it unavailable)',
	hintDirectOff: 'Proxy routing is off - this tests the direct exit',
	dispatcherUnavailable: 'Proxy dispatcher unavailable; enabling is refused to prevent direct leakage'
};

// ---------------------------------------------------------------- state ----
function defaultState() {
	return { enabled: false, revision: 0, mode: 'all', proxy: '', proxySource: 'auto', noProxy: DEFAULT_NO_PROXY, allowProxy: '', note: '' };
}

function readState(statePath = STATE_PATH) {
	try {
		const raw = JSON.parse(readFileSync(statePath, 'utf8'));
		if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') {
			const candidate = typeof raw.proxy === 'string' ? normalizeUserProxy(raw.proxy) : '';
			const proxy = candidate !== '' && isValidProxyUrl(candidate) ? candidate : '';
			return {
				enabled: !!raw.enabled,
				revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
				// Old state files have no mode/allowProxy: treated as all mode, backward compatible
				mode: raw.mode === 'allowlist' || raw.mode === 'all' ? raw.mode : 'all',
				proxy,
				// A source marker makes endpoint edits survive a restart; old files remain auto mode
				// until the settings card or the endpoint explicitly establishes ownership.
				proxySource: proxy !== '' && (raw.proxySource === 'manual' || raw.proxySource === 'api') ? raw.proxySource : 'auto',
				noProxy: typeof raw.noProxy === 'string' ? raw.noProxy : DEFAULT_NO_PROXY,
				allowProxy: typeof raw.allowProxy === 'string' ? raw.allowProxy : '',
				// transient provenance of the last enable (auto-switch record)
				note: displayNote(typeof raw.note === 'string' ? raw.note : '')
			};
		}
	} catch {}
	return defaultState();
}

/** Redact proxy credentials before a status value can cross a network boundary. */
function displayProxy(raw) {
	const value = String(raw || '');
	if (value === '') return '';
	try {
		if (!isValidProxyUrl(value)) return '<configured proxy>';
		const url = new URL(value);
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return value.includes('@') || value.includes('?') || value.includes('#') ? '<configured proxy>' : value;
	}
}

/** Remove URL credentials and non-origin data from human-readable state notes. */
function displayNote(raw) {
	return String(raw || '').replace(/([a-z][a-z\d+.-]*:\/\/)([^\s]+)/gi, (full, scheme, rest) => {
		try {
			const url = new URL(scheme + rest.replace(/[),.;!?]+$/, ''));
			url.username = '';
			url.password = '';
			return scheme + url.host;
		} catch {
			return scheme + '<configured-proxy>';
		}
	});
}

let cached = null;
let cachedAt = 0;
const TTL_MS = 1200;
let currentHotkey = DEFAULT_HOTKEY;
// Registration result of the current accelerator, surfaced via statusSummary
// so the settings card can show "registered" vs "register failed (taken?)".
let hotkeyState = { accelerator: '', registered: false };
// Mirror of the showPill setting, surfaced via statusSummary.pill so the
// injected pill can remove/remount itself on already-open pages.
let currentShowPill = true;
let controlAuth = null;
let fallbackEnabled = false;
let controlHostConnection = null;
function state() {
	const now = Date.now();
	if (cached === null || now - cachedAt > TTL_MS) {
		cached = readState();
		cachedAt = now;
	}
	if (!dispatcherReady && (pendingEnabledRestore || dispatcherError === 'unavailable') && cached.enabled) {
		return { ...cached, enabled: false, note: HOST.dispatcherUnavailable };
	}
	return cached;
}

async function persistState(st, statePath = STATE_PATH) {
	await writeFileAtomic(statePath, JSON.stringify(st, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 });
}

let stateWriteTail = Promise.resolve();
function updateState(mutate) {
	const statePath = STATE_PATH;
	const run = stateWriteTail.then(async () => {
		mkdirSync(dirname(statePath), { recursive: true });
		return withFileLock(statePath, async () => {
			const st = readState(statePath);
			const previous = { enabled: st.enabled, proxy: st.proxy };
			const previousRevision = st.revision;
			mutate(st);
			st.revision = previousRevision + 1;
			await persistState(st, statePath);
			if (STATE_PATH === statePath) {
				cached = st;
				cachedAt = Date.now();
			}
			if (STATE_PATH === statePath && dispatcherStateChanged !== null && (previous.enabled !== st.enabled || previous.proxy !== st.proxy)) {
				try {
					dispatcherStateChanged(st, previous);
				} catch (cause) {
					logErr('dispatcher state-change cleanup failed', cause);
				}
			}
			return st;
		});
	});
	stateWriteTail = run.catch(() => {});
	return run;
}

function updateStateIfProxyUnchanged(expected, mutate, active = () => true) {
	let applied = false;
	return updateState((st) => {
		if (!active() || (expected.revision !== undefined && st.revision !== expected.revision) || st.proxy !== expected.proxy || st.proxySource !== expected.proxySource || (expected.enabled !== undefined && st.enabled !== expected.enabled)) return;
		mutate(st);
		applied = true;
	}).then((st) => applied ? st : null);
}

function updateStateIfUnchanged(expected, mutate, active = () => true) {
	let applied = false;
	return updateState((st) => {
		for (const key of ['revision', 'enabled', 'proxy', 'proxySource', 'mode', 'noProxy', 'allowProxy']) {
			if (expected[key] !== undefined && st[key] !== expected[key]) return;
		}
		if (!active()) return;
		mutate(st);
		applied = true;
	}).then((st) => applied ? st : null);
}

function readStateAfterWrites() {
	const statePath = STATE_PATH;
	return stateWriteTail.then(() => {
		const current = readState(statePath);
		if (STATE_PATH === statePath) {
			cached = current;
			cachedAt = Date.now();
		}
		return current;
	});
}

function ensureStateFile() {
	const statePath = STATE_PATH;
	const run = stateWriteTail.then(async () => {
		if (existsSync(statePath)) return;
		mkdirSync(dirname(statePath), { recursive: true });
		await withFileLock(statePath, async () => {
			if (!existsSync(statePath)) await persistState(defaultState(), statePath);
		});
	});
	stateWriteTail = run.catch(() => {});
	return run;
}

// ------------------------------------------------------------ dispatcher ----
let dispatcherReady = false;
let dispatcherError = '';
let dispatcherEpoch = 0;
let pendingEnabledRestore = false;
let pendingEnabledRestoreRevision = null;
let pluginActive = false;
let dispatcherStateChanged = null;

async function installDispatcher(epoch) {
	if (dispatcherReady || epoch !== dispatcherEpoch) return;
	let symbolS2;
	let symbolS1;
	let originalS2;
	let originalS1;
	let importedS2;
	let importedS1;
	let restoreS2Value;
	let restoreS1Value;
	let installedS2;
	let installedS1;
	let installedStateChanged;
	let closeFailure = async () => {};
	let restoreOnFailure = () => {};
	let failureCleaned = false;
	try {
		symbolS2 = Symbol.for('undici.globalDispatcher.2');
		symbolS1 = Symbol.for('undici.globalDispatcher.1');
		originalS2 = globalThis[symbolS2];
		originalS1 = globalThis[symbolS1];
		const S2 = symbolS2;
		const S1 = symbolS1;
		const undici = await import('undici');
		importedS2 = globalThis[S2];
		importedS1 = globalThis[S1];
		restoreS2Value = originalS2 ?? importedS2;
		restoreS1Value = originalS1 ?? importedS1;
		restoreOnFailure = () => {
			try {
				if ((installedS2 !== undefined && globalThis[S2] === installedS2) || globalThis[S2] === importedS2) globalThis[S2] = restoreS2Value;
			} catch (cause) {
				logErr('failed to restore undici v2 dispatcher symbol', cause);
			}
			try {
				if ((installedS1 !== undefined && globalThis[S1] === installedS1) || globalThis[S1] === importedS1) globalThis[S1] = restoreS1Value;
			} catch (cause) {
				logErr('failed to restore undici v1 dispatcher symbol', cause);
			}
		};
		if (epoch !== dispatcherEpoch) {
			restoreOnFailure();
			return;
		}
		const restoreS2 = restoreS2Value;
		const restoreS1 = restoreS1Value;
		const original = originalS2 ?? importedS2;
		const { Agent, ProxyAgent, Dispatcher, Dispatcher1Wrapper } = undici.default ?? undici;
		if (typeof Agent !== 'function' || typeof ProxyAgent !== 'function' || typeof Dispatcher !== 'function' || typeof Dispatcher1Wrapper !== 'function' || typeof Dispatcher1Wrapper.wrapHandler !== 'function') {
			throw new TypeError('undici Agent/ProxyAgent/Dispatcher compatibility API is unavailable');
		}
		let fallbackDirect = null;
		let proxied = null;
		let proxiedKey = '';
		let proxiedFailure = null;
		const getDirect = () => {
			if (original && typeof original.dispatch === 'function') return original;
			if (fallbackDirect === null) fallbackDirect = new Agent({ connect: { timeout: 15000 } });
			return fallbackDirect;
		};
		const closeTarget = (target, label) => {
			if (!target || typeof target.close !== 'function') return Promise.resolve();
			try {
				return Promise.resolve(target.close()).catch((cause) => logErr(`${label} close failed`, cause));
			} catch (cause) {
				logErr(`${label} close failed`, cause);
				return Promise.resolve();
			}
		};
		const closeOwned = () => Promise.all([
			closeTarget(proxied, 'proxy dispatcher'),
			closeTarget(fallbackDirect, 'fallback dispatcher')
		]).then(() => undefined);
		closeFailure = closeOwned;
		const closeReplacedProxy = () => {
			if (proxied === null) return;
			const old = proxied;
			proxied = null;
			if (typeof old.close !== 'function') return;
			try {
				const closing = old.close();
				if (closing && typeof closing.catch === 'function') closing.catch((cause) => logErr('old proxy close failed', cause));
			} catch (cause) {
				logErr('old proxy close failed', cause);
			}
		};
		const stateChanged = (st, previous) => {
			if (!st.enabled || st.proxy !== previous.proxy) {
				closeReplacedProxy();
				proxiedFailure = null;
				if (!st.enabled) proxiedKey = '';
			}
		};
		dispatcherStateChanged = stateChanged;
		installedStateChanged = stateChanged;
		const getProxied = (st) => {
			const key = st.proxy;
			if (proxied !== null && key === proxiedKey) return proxied;
			if (proxiedFailure !== null && key === proxiedKey) throw proxiedFailure;
			closeReplacedProxy();
			proxiedFailure = null;
			// Raw ProxyAgent: one tested path for http(s):// and socks5:// proxies
			// (EnvHttpProxyAgent's socks5 https route resets in the field).
			// Invalid configuration fails closed: an enabled proxy must never silently
			// send the request directly because ProxyAgent construction failed.
			if (!key || !isValidProxyUrl(key)) {
				const failure = new TypeError(key ? 'configured proxy URL is invalid' : 'proxy is enabled but no proxy is configured');
				proxiedKey = key;
				proxiedFailure = failure;
				logErr(key ? 'ProxyAgent build skipped for invalid proxy' : 'ProxyAgent build skipped because no proxy is configured', key ? displayProxy(key) : '');
				throw failure;
			}
			try {
				proxied = new ProxyAgent({ uri: key });
			} catch (cause) {
				const failure = new Error('configured proxy could not be initialized', { cause });
				logErr('ProxyAgent build failed for', displayProxy(key), cause && cause.message || cause);
				proxiedKey = key;
				proxiedFailure = failure;
				throw failure;
			}
			proxiedKey = key;
			return proxied;
		};
		const lifecycleTargets = () => {
			const targets = [];
			for (const target of [original, originalS1, fallbackDirect, proxied]) {
				if (target && !targets.includes(target)) targets.push(target);
			}
			return targets;
		};
		const lifecycle = (method, args, callback) => {
			const tasks = lifecycleTargets().map((target) => {
				const fn = typeof target[method] === 'function' ? target[method] : target.close;
				if (typeof fn !== 'function') return Promise.resolve();
				try {
					return Promise.resolve(fn.apply(target, args)).catch((cause) => {
						logErr(`dispatcher ${method} failed`, cause);
					});
				} catch (cause) {
					logErr(`dispatcher ${method} failed`, cause);
					return Promise.resolve();
				}
			});
			const done = Promise.all(tasks).then(() => undefined);
			if (typeof callback === 'function') {
				done.then(() => callback(), () => callback());
				return undefined;
			}
			return done;
		};
		const wrapper = new class extends Dispatcher {
			dispatch(opts, handler, ...rest) {
				const st = state();
				// S2 always receives a v2 handler from undici's modern API.
				if (shouldProxy(st, opts)) return getProxied(st).dispatch(opts, handler, ...rest);
				return getDirect().dispatch(opts, handler, ...rest);
			}
			close(callback) {
				return lifecycle('close', [], callback);
			}
			destroy(err, callback) {
				if (typeof err === 'function') {
					callback = err;
					err = undefined;
				}
				return lifecycle('destroy', err === undefined ? [] : [err], callback);
			}
		}();
		installedS2 = wrapper;
		// S1 receives legacy callbacks. Direct traffic stays on the original v1
		// dispatcher; only the proxy path is upgraded to a v2 handler.
		const legacyWrapper = new class extends Dispatcher {
			dispatch(opts, handler, ...rest) {
				if (opts && typeof opts === 'object' && opts.allowH2 !== false) opts = { ...opts, allowH2: false };
				const st = state();
				if (shouldProxy(st, opts)) return getProxied(st).dispatch(opts, Dispatcher1Wrapper.wrapHandler(handler), ...rest);
				if (originalS1 && typeof originalS1.dispatch === 'function') return originalS1.dispatch(opts, handler, ...rest);
				return getDirect().dispatch(opts, Dispatcher1Wrapper.wrapHandler(handler), ...rest);
			}
			close(callback) {
				return lifecycle('close', [], callback);
			}
			destroy(err, callback) {
				if (typeof err === 'function') {
					callback = err;
					err = undefined;
				}
				return lifecycle('destroy', err === undefined ? [] : [err], callback);
			}
		}();
		installedS1 = legacyWrapper;
		if (epoch !== dispatcherEpoch) {
			if (dispatcherStateChanged === stateChanged) dispatcherStateChanged = null;
			await closeOwned();
			restoreOnFailure();
			return;
		}
		try {
			globalThis[S2] = wrapper;
			globalThis[S1] = legacyWrapper;
		} catch (cause) {
			if (dispatcherStateChanged === stateChanged) dispatcherStateChanged = null;
			restoreOnFailure();
			await closeOwned();
			failureCleaned = true;
			throw cause;
		}
		dispatcherReady = true;
		dispatcherError = '';
		const st = state();
		log(`dispatcher installed; enabled=${st.enabled} proxy=${displayProxy(st.proxy) || '(unset)'}`);
		return async () => {
			if (dispatcherStateChanged === stateChanged) dispatcherStateChanged = null;
			if (globalThis[S2] === wrapper) globalThis[S2] = restoreS2;
			if (globalThis[S1] === legacyWrapper) globalThis[S1] = restoreS1;
			dispatcherReady = false;
			dispatcherError = '';
			await closeOwned();
		};
	} catch (cause) {
		dispatcherReady = false;
		if (dispatcherStateChanged === installedStateChanged) dispatcherStateChanged = null;
		restoreOnFailure();
		if (!failureCleaned) await closeFailure();
		if (epoch === dispatcherEpoch) {
			pluginActive = false;
			pendingEnabledRestore = false;
			pendingEnabledRestoreRevision = null;
			dispatcherError = 'unavailable';
			try {
				await updateState((s) => {
					s.enabled = false;
					s.note = HOST.dispatcherUnavailable;
				});
			} catch (stateCause) {
				logErr('failed to persist dispatcher unavailable state', stateCause);
			}
		}
		logErr('dispatcher install FAILED — proxy enabling is disabled', cause && cause.stack || cause);
	}
}

// ---------------------------------------------------------------- fence ----
// Reject requests that have crossed a conventional reverse proxy. This is a
// deployment fence, not authentication: a custom proxy can remove or forge
// these headers, so the control surface must still never be exposed remotely.
function hasForwardedHeaders(req) {
	const headers = req.headers || {};
	return ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'].some((name) => headers[name] !== undefined);
}

function isLoopbackRequest(req) {
	if (hasForwardedHeaders(req)) return false;
	const host = req.headers && req.headers.host;
	if (host !== undefined && !hostIsLocalish(host)) return false;
	const remote = String((req.socket && req.socket.remoteAddress) || '');
	return isLoopbackHost(remote);
}

/**
 * Host allowlist for the fence: an Origin that merely echoes an attacker
 * -chosen Host header must not pass — DNS rebinding (evil.com -> 127.0.0.1)
 * produces exactly that shape, origin === 'http://' + host. Accept loopback
 * names and loopback IP literals, plus single-label local hostnames; the route
 * itself remains loopback-only, so LAN/public listeners are not supported.
 */
function hostIsLocalish(hostHeader) {
	const host = String(hostHeader || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (host === '') return false;
	if (isLoopbackHost(host)) return true;
	if (net.isIP(host) !== 0 || host.includes(':')) return false;
	return !host.includes('.'); // single-label local hostname
}

/**
 * CSRF fence for state-changing routes: non-browser clients (curl, the agent
 * shell) send no Origin and stay allowed; a browser always sends Origin on
 * cross-site POST, so a mismatched Origin — or an explicit cross-site
 * Sec-Fetch-Site — is rejected. The echoed Host must also look local
 * (see hostIsLocalish) or the request is treated as rebinding.
 */
function sameOriginOk(req) {
	if (!isLoopbackRequest(req)) return false;
	const origin = req.headers.origin;
	if (origin !== undefined && origin !== '') {
		const host = req.headers.host;
		if (host === undefined || !hostIsLocalish(host)) return false;
		let originUrl;
		try {
			originUrl = new URL(String(origin));
		} catch {
			return false;
		}
		if (originUrl.protocol !== (req.socket?.encrypted ? 'https:' : 'http:')) return false;
		if (originUrl.host.toLowerCase() !== String(host).trim().toLowerCase()) return false;
	}
	return String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site';
}

// ---------------------------------------------------- system proxy detect ----
let proxyDetectCache = { at: 0, value: null };
let proxyDetectInFlight = null;
/** Windows registry/desktop proxy auto-detect; '' when unset or off-platform. */
async function detectSystemProxy(fresh, cancelSignal) {
	if (cancelSignal?.aborted) return '';
	const now = Date.now();
	if (!fresh && proxyDetectCache.value !== null && now - proxyDetectCache.at < 30000) return proxyDetectCache.value;
	if (proxyDetectInFlight !== null) {
		const value = await proxyDetectInFlight;
		return cancelSignal?.aborted ? '' : value;
	}
	const run = (async () => {
		let value = '';
		const commandSignal = AbortSignal.timeout(3500);
		const runCmd = async (cmd, args) => {
			const result = await execFileAsync(cmd, args, {
				encoding: 'utf8',
				maxBuffer: 65536,
				timeout: 3500,
				signal: commandSignal
			});
			return String(result.stdout || '');
		};
		try {
			if (process.platform === 'win32') {
				value = await detectWindowsProxy(runCmd);
			} else if (process.platform === 'darwin') {
				value = proxyFromScutilOutput(await runCmd('scutil', ['--proxy']));
			} else if (process.platform === 'linux') {
				value = await detectGnomeProxy(runCmd);
			}
		} catch {}
		if (!isValidProxyUrl(value)) value = '';
		if (value === '') {
			// Environment fallback must still run when the desktop probe is absent or
			// fails (common on headless Linux and locked-down Windows machines).
			const envValues = [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy];
			for (const raw of envValues) {
				if (typeof raw !== 'string' || raw.trim() === '') continue;
				const candidate = normalizeProxyServer(raw.trim());
				if (isValidProxyUrl(candidate)) {
					value = candidate;
					break;
				}
			}
		}
		proxyDetectCache = { at: Date.now(), value };
		return value;
	})();
	proxyDetectInFlight = run;
	try {
		const value = await run;
		return cancelSignal?.aborted ? '' : value;
	} finally {
		if (proxyDetectInFlight === run) proxyDetectInFlight = null;
	}
}

/** HKCU WinINET settings: ProxyEnable gate + ProxyServer value. */
async function detectWindowsProxy(runCmd) {
	const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
	const query = (name) => runCmd('reg', ['query', key, '/v', name]);
	if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(await query('ProxyEnable'))) {
		const match = (await query('ProxyServer')).match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
		if (match) return normalizeProxyServer(match[1]);
	}
	return '';
}

function canonicalDetectedProxy(scheme, host, port) {
	const bare = normalizeUserProxy(`${host}:${port}`);
	if (!bare || !isValidProxyUrl(bare)) return '';
	return scheme === 'http://' ? bare : scheme + bare.slice('http://'.length);
}

/** GNOME/gsettings (the common Linux desktop path): manual mode with
 *  per-scheme host/port pairs; HTTPS preferred, then HTTP, then SOCKS. */
async function detectGnomeProxy(runCmd) {
	let mode = '';
	try {
		mode = (await runCmd('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])).trim().replace(/^'|'$/g, '');
	} catch {
		return ''; // no gsettings (server / non-GNOME) -> port scan takes over
	}
	if (mode !== 'manual') return '';
	const pick = async (kind, scheme) => {
		try {
			const host = (await runCmd('gsettings', ['get', 'org.gnome.system.proxy.' + kind, 'host'])).trim().replace(/^'|'$/g, '');
			const rawPort = (await runCmd('gsettings', ['get', 'org.gnome.system.proxy.' + kind, 'port'])).trim();
			const portMatch = rawPort.match(/(\d+)\s*$/);
			const port = portMatch ? Number(portMatch[1]) : 0;
			if (host && Number.isInteger(port) && port >= 1 && port <= 65535) return canonicalDetectedProxy(scheme, host, port);
		} catch {}
		return '';
	};
	return await pick('https', 'http://') || await pick('http', 'http://') || await pick('socks', 'socks5://');
}

async function ensureProxyForEnable(isActive = () => true, signal) {
	const cur = await readStateAfterWrites();
	if (!isActive() || signal?.aborted) return false;
	if (cur.proxy !== '') return true;
	const detected = await detectSystemProxy(false, signal);
	if (detected === '' || !await probeProxyAlive(detected, 800, signal) || !isActive() || signal?.aborted) return false;
	const applied = await updateStateIfProxyUnchanged(cur, (s) => {
		s.proxy = detected;
		s.proxySource = 'auto';
	}, () => isActive() && !signal?.aborted);
	if (!isActive() || signal?.aborted) return false;
	return applied !== null || readState().proxy !== '';
}

// ------------------------------------------------------------ reachability ----
/**
 * Single TCP connect to the proxy port. http(s):// and socks5:// proxies are
 * both TCP-forwarding endpoints, so a successful connect means the proxy client
 * is listening — pure reachability, no protocol handshake. Resolves false on
 * timeout / parse failure / connect error.
 */
function probeProxyAlive(proxyUrl, timeoutMs = 800, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}
		let url;
		try {
			if (!isValidProxyUrl(proxyUrl)) {
				resolve(false);
				return;
			}
			url = new URL(String(proxyUrl || ''));
		} catch {
			resolve(false);
			return;
		}
		const protocol = url.protocol.toLowerCase();
		const port = url.port === '' ? protocol === 'socks5:' ? 1080 : protocol === 'https:' ? 443 : 80 : Number(url.port);
		if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
			resolve(false);
			return;
		}
		let socket;
		try {
			socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port });
		} catch {
			resolve(false);
			return;
		}
		let settled = false;
		const onAbort = () => done(false);
		const done = (ok) => {
			if (settled) return;
			settled = true;
			try {
				signal?.removeEventListener?.('abort', onAbort);
			} catch {}
			try {
				socket.destroy();
			} catch {}
			resolve(ok);
		};
		try {
			signal?.addEventListener?.('abort', onAbort, { once: true });
			if (signal?.aborted) return done(false);
			socket.setTimeout(Math.max(1, Number(timeoutMs) || 800), () => done(false));
			socket.once('connect', () => done(true));
			socket.once('error', () => done(false));
		} catch {
			done(false);
		}
	});
}

/** Ports commonly used by local proxy clients (Clash 7890/7897, v2rayN
 *  10808/10809, generic socks 1080, Privoxy 8118, Shadowsocks 2080). */
const COMMON_PROXY_PORTS = [7897, 7890, 10809, 10808, 2080, 1080, 8118];

/** Last-resort detect: probe common local proxy ports (loopback only, in
 * parallel), validate both HTTP and SOCKS5 candidates through exit probes,
 * and return the first working scheme in priority order. */
async function scanCommonProxyPorts(excludeUrls = [], signal) {
	const excluded = new Set(
		excludeUrls
			.map((u) => {
				try {
					return Number(new URL(u).port);
				} catch {
					return 0;
				}
			})
			.filter(Boolean)
	);
	const candidates = COMMON_PROXY_PORTS.filter((p) => !excluded.has(p));
	const detected = await Promise.all(candidates.map((p) => probeCommonProxyPort(p, signal)));
	for (const p of COMMON_PROXY_PORTS) {
		const index = candidates.indexOf(p);
		if (index !== -1 && detected[index]) return detected[index];
	}
	return '';
}

/**
 * Enable-side proxy resolution (route + hotkey paths). Uses bounded system and
 * protocol probes, and tries hard to land on a live port:
 *  1. empty proxy -> system auto-detect; none -> common-port scan -> else error
 *  2. current proxy alive -> done
 *  3. current dead -> FRESH system re-detect (bypasses the 30s cache — the
 *     proxy client may have just moved ports); different & alive -> adopt it
 *  4. still nothing -> common-port scan -> adopt
 *  5. all dead -> keep the configured value with a warning
 */
async function resolveProxyForEnable(isActive = () => true, signal) {
	if (!isActive() || signal?.aborted) return { error: 'cancelled' };
	let st = await readStateAfterWrites();
	if (!st.proxy) {
		if (!await ensureProxyForEnable(isActive, signal)) {
			if (!isActive()) return { error: 'cancelled' };
			const scanned = await scanCommonProxyPorts([], signal);
			if (!isActive()) return { error: 'cancelled' };
			if (!scanned) return { error: true };
			const applied = await updateStateIfProxyUnchanged(st, (s) => {
				s.proxy = scanned;
				s.proxySource = 'auto';
				s.note = HOST.scanNoSystem(displayProxy(scanned));
			}, () => isActive() && !signal?.aborted);
			if (!isActive()) return { error: 'cancelled' };
			if (applied === null) return {};
			return { switchedTo: displayProxy(scanned), note: HOST.scanNoSystem(displayProxy(scanned)) };
		}
		st = await readStateAfterWrites();
	}
	const currentAlive = await probeProxyAlive(st.proxy, 800, signal);
	if (!isActive()) return { error: 'cancelled' };
	if (st.proxy && currentAlive) return {};
	// A manually selected address is respected — dead or not. Auto mode may
	// recover from a changed system proxy or a common local port.
	if (st.proxySource !== 'auto') return { warning: HOST.proxyUnreachable };
	if (!isActive()) return { error: 'cancelled' };
	const detected = await detectSystemProxy(true, signal);
	if (detected && detected !== st.proxy && await probeProxyAlive(detected, 800, signal)) {
		if (!isActive()) return { error: 'cancelled' };
		const applied = await updateStateIfProxyUnchanged(st, (s) => {
			s.proxy = detected;
			s.proxySource = 'auto';
			s.note = HOST.switchedTo(displayProxy(detected));
		}, () => isActive() && !signal?.aborted);
		if (!isActive()) return { error: 'cancelled' };
		if (applied === null) return {};
		return { switchedTo: displayProxy(detected), note: HOST.switchedTo(displayProxy(detected)) };
	}
	if (!isActive()) return { error: 'cancelled' };
	const scanned = await scanCommonProxyPorts(detected ? [st.proxy, detected] : [st.proxy], signal);
	if (!isActive()) return { error: 'cancelled' };
	if (scanned) {
		const applied = await updateStateIfProxyUnchanged(st, (s) => {
			s.proxy = scanned;
			s.proxySource = 'auto';
			s.note = HOST.scanHit(displayProxy(scanned));
		}, () => isActive() && !signal?.aborted);
		if (!isActive()) return { error: 'cancelled' };
		if (applied === null) return {};
		return { switchedTo: displayProxy(scanned), note: HOST.scanHit(displayProxy(scanned)) };
	}
	return { warning: HOST.proxyUnreachable };
}

// ---------------------------------------------------------------- routes ----
function writeJson(res, code, body) {
	if (res.writableEnded || res.destroyed || res.req?.aborted) return;
	try {
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(code, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		});
		res.end(JSON.stringify(body));
	} catch (cause) {
		logErr('JSON response failed', cause);
		try {
			res.destroy();
		} catch {}
	}
}

function statusSummary(req, authMethod = 'unknown') {
	const st = state();
	const local = !req || isLoopbackRequest(req);
	return {
		enabled: st.enabled,
		mode: st.mode,
		proxy: displayProxy(st.proxy),
		proxySource: st.proxySource,
		revision: st.revision,
		noProxy: st.noProxy,
		allowProxy: st.allowProxy,
		hotkey: currentHotkey,
		hotkeyRegistered: hotkeyState.registered,
		pill: currentShowPill,
		note: displayNote(st.note),
		dispatcherReady,
		authMethod,
		fallbackEnabled,
		...(dispatcherError ? { warning: HOST.dispatcherUnavailable } : {}),
		...(local ? { file: `${dshHomeDisplay(HOME)}/vpn-proxy.json` } : {})
	};
}

function notifyState(st, note) {
	try {
		const electron = require('electron');
		const { Notification } = electron.default ?? electron;
		if (Notification.isSupported && !Notification.isSupported()) return;
		const suffix = note ? `（${displayNote(note)}）` : '';
		new Notification({
			title: HOST.toggleTitle,
			body: st.enabled ? HOST.enabled(displayProxy(st.proxy), suffix) : HOST.disabled(suffix),
			silent: true
		}).show();
	} catch {}
}

let toggleTail = Promise.resolve();
function enqueueToggle(task) {
	const run = toggleTail.then(task, task);
	toggleTail = run.catch(() => {});
	return run;
}

async function performToggle(want, source, requestActive = () => true, requestSignal) {
	const cur = await readStateAfterWrites();
	if (!requestActive()) return { error: 'cancelled' };
	const nextEnabled = want === null ? !cur.enabled : want;
	const toggleEpoch = dispatcherEpoch;
	let warning = '';
	let note = '';
	if (!requestActive()) return { error: 'cancelled' };
	if (nextEnabled && !pluginActive) return { error: 'dispatcher' };
	if (nextEnabled) {
		if (!dispatcherReady) return { error: 'dispatcher' };
		const needsConfiguredProxy = cur.mode !== 'allowlist' || String(cur.allowProxy || '').trim() !== '';
		const resolution = needsConfiguredProxy
			? await resolveProxyForEnable(() => pluginActive && requestActive() && dispatcherReady && dispatcherEpoch === toggleEpoch, requestSignal)
			: {};
		if (resolution.error === 'cancelled' || !requestActive() || !pluginActive || !dispatcherReady || dispatcherEpoch !== toggleEpoch) return { error: 'cancelled' };
		if (resolution.error) return { error: 'proxy' };
		warning = resolution.warning || '';
		note = resolution.note || '';
		const latest = await readStateAfterWrites();
		if (!requestActive()) return { error: 'cancelled' };
		if ((latest.mode !== 'allowlist' || String(latest.allowProxy || '').trim() !== '') && latest.proxy === '') return { error: 'proxy' };
	}
	let committed = false;
	const st = await updateState((s) => {
		if (!requestActive() || (nextEnabled && (!pluginActive || !dispatcherReady || dispatcherEpoch !== toggleEpoch))) return;
		if (!nextEnabled) {
			pendingEnabledRestore = false;
			pendingEnabledRestoreRevision = null;
		}
		s.enabled = nextEnabled;
		s.note = note;
		committed = true;
	});
	if (!committed) return requestActive() ? { error: 'dispatcher' } : { error: 'cancelled' };
	notifyState(st, note || warning);
	log(`toggle via ${source} -> ${st.enabled ? `ON ${displayProxy(st.proxy)}` : 'OFF'}${note ? ` (${note})` : warning ? ` (${warning})` : ''}`);
	return { st, warning, note };
}

function rejectUnexpectedBody(req, res) {
	const rawLength = req.headers['content-length'];
	const length = rawLength === undefined ? 0 : Number(rawLength);
	const chunked = String(req.headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
	if ((rawLength !== undefined && (!Number.isFinite(length) || length < 0)) || length > 0 || chunked) {
		writeJson(res, 413, { error: 'request body is not accepted on this endpoint' });
		try {
			req.destroy();
		} catch {}
		return true;
	}
	return false;
}

async function requireControlAuth(req, res, auth, hostConnection) {
	if (hostConnection && typeof hostConnection.requestRejection === 'function') {
		let rejection;
		try {
			rejection = hostConnection.requestRejection(req);
		} catch (cause) {
			logErr('host authentication check failed', cause);
			writeJson(res, 503, { error: 'host authentication unavailable' });
			return { ok: false };
		}
		if (rejection === undefined) return { ok: true, kind: 'host' };
		if (rejection === 403) {
			writeJson(res, 403, { error: 'host request trust check rejected' });
			return { ok: false };
		}
		if (rejection !== 401) {
			logErr('host authentication returned an unexpected rejection', rejection);
			writeJson(res, 503, { error: 'host authentication unavailable' });
			return { ok: false };
		}
	}
	if (auth === null) {
		if (hostConnection) {
			writeJson(res, 401, { error: 'host authentication required', fallbackEnabled });
		} else {
			writeJson(res, 503, { error: 'control authentication unavailable', fallbackEnabled });
		}
		return { ok: false };
	}
	const result = await auth.authorize(req);
	if (result.ok) return result;
	writeJson(res, result.unavailable ? 503 : 401, { error: result.unavailable ? 'control authentication unavailable' : 'authentication required', fallbackEnabled });
	return { ok: false };
}

function readSmallJson(req, maxBytes = 1024, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let total = 0;
		const chunks = [];
		const timeout = setTimeout(() => finish(new Error('request body timed out')), timeoutMs);
		timeout.unref?.();
		const cleanup = () => {
			clearTimeout(timeout);
			req.removeListener?.('data', onData);
			req.removeListener?.('end', onEnd);
			req.removeListener?.('aborted', onAborted);
			req.removeListener?.('error', onError);
		};
		const finish = (cause, value) => {
			if (settled) return;
			settled = true;
			cleanup();
			cause ? reject(cause) : resolve(value);
		};
		const onData = (chunk) => {
			if (settled) return;
			const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += piece.byteLength;
			if (total > maxBytes) {
				try { req.resume?.(); } catch {}
				finish(new RangeError('request body too large'));
				return;
			}
			chunks.push(piece);
		};
		const onEnd = () => {
			try {
				finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
			} catch (cause) {
				finish(cause);
			}
		};
		const onAborted = () => finish(new Error('request aborted'));
		const onError = (cause) => finish(cause);
		req.on('data', onData);
		req.once('end', onEnd);
		req.once('aborted', onAborted);
		req.once('error', onError);
	});
}

async function handlePairRequest(req, res, auth) {
	if (!sameOriginOk(req)) {
		writeJson(res, 403, { error: 'loopback origin required' });
		return;
	}
	try {
		const body = await readSmallJson(req);
		if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.token !== 'string' || body.token.length > 128) {
			writeJson(res, 400, { error: 'pairing token is required' });
			return;
		}
		if (auth === null) {
			writeJson(res, 503, { error: 'control authentication unavailable' });
			return;
		}
		const result = await auth.pair(req, body.token, res);
		writeJson(res, result.status || 200, result.ok ? { ok: true } : { error: result.error });
	} catch (cause) {
		const status = cause instanceof RangeError ? 413 : 400;
		writeJson(res, status, { error: status === 413 ? 'request body too large' : 'invalid pairing request' });
	}
}

async function handleLogoutRequest(req, res, auth) {
	if (!sameOriginOk(req)) {
		writeJson(res, 403, { error: 'loopback origin required' });
		return;
	}
	if (auth === null) {
		writeJson(res, 503, { error: 'control authentication unavailable' });
		return;
	}
	await auth.logout(req, res);
	writeJson(res, 200, { ok: true });
}

async function handleRenewRequest(req, res, auth) {
	if (!sameOriginOk(req)) {
		writeJson(res, 403, { error: 'loopback origin required' });
		return;
	}
	if (auth === null) {
		writeJson(res, 503, { error: 'control authentication unavailable' });
		return;
	}
	if (rejectUnexpectedBody(req, res)) return;
	const result = await auth.renew(req, res);
	writeJson(res, result.status || 200, result.ok ? { ok: true, expiresAt: result.expiresAt } : { error: result.error });
}

async function handleToggleRequest(req, path, res, auth, hostConnection) {
	if (!sameOriginOk(req)) {
		writeJson(res, 403, { error: 'cross-origin state change rejected' });
		return;
	}
	const authResult = await requireControlAuth(req, res, auth, hostConnection);
	if (!authResult.ok) return;
	if (rejectUnexpectedBody(req, res)) return;
	const want = path === '/vpn/on' ? true : path === '/vpn/off' ? false : null;
	let disconnected = !!req.aborted;
	const controller = new AbortController();
	if (disconnected) controller.abort();
	const markDisconnected = () => {
		disconnected = true;
		controller.abort();
	};
	req.once?.('aborted', markDisconnected);
	res.once?.('close', markDisconnected);
	try {
		req.setTimeout?.(10000, () => {
			markDisconnected();
			try {
				req.destroy();
			} catch {}
		});
		const result = await enqueueToggle(() => performToggle(want, path, () => !disconnected, controller.signal));
		if (result.error === 'cancelled') {
			writeJson(res, disconnected ? 499 : 503, { error: disconnected ? 'request cancelled' : 'toggle request cancelled; retry' });
			return;
		}
		if (result.error === 'dispatcher') {
			writeJson(res, 503, { error: dispatcherError ? HOST.dispatcherUnavailable : 'proxy dispatcher is still starting; retry shortly' });
			return;
		}
		if (result.error === 'proxy') {
			writeJson(res, 400, { error: 'proxy address is empty and system auto-detect found none; POST /vpn/proxy first or set it in the settings card', state: statusSummary(req, authResult.kind) });
			return;
		}
		const body = { ...statusSummary(req, authResult.kind), ...(result.warning ? { warning: result.warning } : {}), ...(result.note ? { note: result.note } : {}) };
		writeJson(res, 200, body);
	} catch (cause) {
		logErr(`toggle via ${path} failed`, cause);
		writeJson(res, 500, { error: 'proxy state could not be updated' });
	}
}

async function readResponseTextLimited(response, maxBytes = 65536) {
	const declared = Number(response.headers?.get?.('content-length') || 0);
	if (declared > maxBytes) {
		try {
			await response.body?.cancel();
		} catch {}
		return null;
	}
	if (!response.body || typeof response.body.getReader !== 'function') return null;
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			const chunk = Buffer.from(part.value || '');
			total += chunk.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, total).toString('utf8');
	} catch {
		try {
			await reader.cancel();
		} catch {}
		return null;
	}
}

/**
 * Exit-IP probe used by /vpn/test. `doFetch` defaults to the global fetch
 * (real current routing); the candidate-proxy preview passes a one-off
 * undici fetch bound to a temporary ProxyAgent instead.
 */
async function probeExit(doFetch, timeoutMs = 6000, outerSignal, routeFor) {
	const realFetch = doFetch || ((url, init) => fetch(url, init));
	const started = Date.now();
	for (const url of ['https://api.ipify.org/?format=json', 'https://ifconfig.me/ip']) {
		if (outerSignal?.aborted) return null;
		try {
			const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
			const r = await realFetch(url, { signal });
			if (!r.ok) {
				try {
					await r.body?.cancel();
				} catch {}
				continue;
			}
			let ip = '';
			const body = await readResponseTextLimited(r);
			if (body === null) continue;
			if (url.indexOf('ipify') !== -1) {
				try {
					ip = String((JSON.parse(body) || {}).ip || '');
				} catch {
					continue;
				}
			} else {
				ip = body.trim();
			}
			if (net.isIP(ip) !== 0) return { exitIp: ip, latencyMs: Date.now() - started, ...(routeFor ? { via: routeFor(url) } : {}) };
		} catch {}
	}
	return null;
}

async function probeProxyCandidate(proxyUrl, signal) {
	let agent;
	try {
		const undici = await import('undici');
		const { ProxyAgent, fetch: undiciFetch } = undici.default ?? undici;
		if (typeof ProxyAgent !== 'function' || typeof undiciFetch !== 'function' || !isValidProxyUrl(proxyUrl)) return false;
		agent = new ProxyAgent({ uri: proxyUrl });
		const result = await probeExit((url, init) => undiciFetch(url, Object.assign({}, init, { dispatcher: agent })), 1800, signal, () => 'proxy');
		return result !== null;
	} catch {
		return false;
	} finally {
		if (agent && typeof agent.close === 'function') {
			try {
				await agent.close();
			} catch {}
		}
	}
}

/**
 * Check a candidate with both common proxy protocols. A TCP listener alone is
 * not enough: SOCKS-only ports are common and must not be labeled http://.
 */
async function probeCommonProxyPort(port, signal) {
	const results = await Promise.all(['http://', 'socks5://'].map(async (scheme) => {
		const candidate = `${scheme}127.0.0.1:${port}`;
		if (!await probeProxyAlive(candidate, 400, signal)) return '';
		return await probeProxyCandidate(candidate, signal) ? candidate : '';
	}));
	return results.find(Boolean) || '';
}

/**
 * POST /vpn/test semantics:
 *  - enabled: the real current routing (global fetch through the wrapper);
 *    dead proxy port reports proxy-unreachable first.
 *  - disabled + proxy set: this is a candidate-proxy preview — probe the
 *    port, then push the exit probe through a one-off ProxyAgent so the
 *    user learns whether the newly typed proxy actually works, WITHOUT
 *    enabling it (the global dispatcher / real routing stays untouched).
 *  - disabled + no proxy: direct exit probe.
 */
async function handleTestRequest(req, res) {
	if (rejectUnexpectedBody(req, res)) return;
	const controller = new AbortController();
	const abort = () => controller.abort();
	req.once?.('aborted', abort);
	res.once?.('close', abort);
	try {
		req.setTimeout?.(15000, () => {
			abort();
			try {
				req.destroy();
			} catch {}
		});
		const st = await readStateAfterWrites();
		const proxy = displayProxy(st.proxy);
		const routeFor = (url) => shouldProxy(st, { origin: url }) ? 'proxy' : 'direct';
		const probeUrls = ['https://api.ipify.org/?format=json', 'https://ifconfig.me/ip'];
		const expectsProxy = probeUrls.some((url) => routeFor(url) === 'proxy');
		const via = expectsProxy ? 'proxy' : 'direct';
		if (st.enabled && !dispatcherReady) {
			writeJson(res, 503, { ok: false, stage: 'dispatcher-unavailable', mode: st.mode, hint: HOST.dispatcherUnavailable });
			return;
		}
		const allProxy = probeUrls.every((url) => routeFor(url) === 'proxy');
		if (st.enabled && allProxy && (!st.proxy || !(await probeProxyAlive(st.proxy, 800, controller.signal)))) {
			writeJson(res, 200, { ok: false, stage: 'proxy-unreachable', proxy, mode: st.mode, hint: HOST.hintUnreachable });
			return;
		}
		if (!st.enabled && st.proxy) {
			if (!(await probeProxyAlive(st.proxy, 800, controller.signal))) {
				writeJson(res, 200, { ok: false, stage: 'proxy-unreachable', proxy, mode: st.mode, enabled: false, hint: HOST.hintCandidateDead });
				return;
			}
			let mod = null;
			try {
				mod = await import('undici');
			} catch (cause) {
				logErr('undici unavailable for candidate test', cause);
			}
			const undici = mod && (mod.default ?? mod);
			if (undici && undici.ProxyAgent && undici.fetch) {
				let agent;
				try {
					agent = new undici.ProxyAgent({ uri: st.proxy });
				} catch (cause) {
					logErr('candidate ProxyAgent build failed for', displayProxy(st.proxy), cause);
					writeJson(res, 200, { ok: false, stage: 'candidate-proxy-invalid', proxy, mode: st.mode, enabled: false, hint: HOST.hintNoExitPending });
					return;
				}
				try {
					const result = await probeExit((url, init) => undici.fetch(url, Object.assign({}, init, { dispatcher: agent })), 6000, controller.signal, () => 'proxy');
					if (result) {
						writeJson(res, 200, { ok: true, exitIp: result.exitIp, latencyMs: result.latencyMs, via: 'proxy', pending: true, proxy, mode: st.mode, hint: HOST.hintPending });
					} else {
						writeJson(res, 200, { ok: false, stage: 'exit-probe-failed', via: 'proxy', proxy, mode: st.mode, enabled: false, hint: HOST.hintNoExitPending });
					}
				} catch (cause) {
					logErr('candidate proxy probe failed', cause);
					writeJson(res, 200, { ok: false, stage: 'candidate-probe-failed', proxy, mode: st.mode, enabled: false, hint: HOST.hintNoExitPending });
				} finally {
					try {
						await agent.close();
					} catch (cause) {
						logErr('candidate proxy close failed', cause);
					}
				}
				return;
			}
			// undici unavailable: report liveness only.
			writeJson(res, 200, { ok: false, stage: 'proxy-alive', proxy, mode: st.mode, enabled: false, hint: HOST.hintAliveOnly });
			return;
		}
		const result = await probeExit(undefined, 6000, controller.signal, routeFor);
		if (!result) {
			writeJson(res, 200, { ok: false, stage: 'exit-probe-failed', via, proxy, mode: st.mode, hint: st.enabled ? HOST.hintNoExit : HOST.hintDirectOff });
			return;
		}
		const pending = !st.enabled;
		writeJson(res, 200, Object.assign({ ok: true, exitIp: result.exitIp, latencyMs: result.latencyMs, via: pending ? (result.via || 'direct') : (result.via || via), proxy, mode: st.mode }, pending ? { pending: true, hint: HOST.hintDirectOff } : {}));
	} catch (cause) {
		if (!controller.signal.aborted) {
			logErr('connectivity test failed', cause);
			writeJson(res, 500, { ok: false, stage: 'test-failed', error: 'connectivity test failed' });
		}
	} finally {
		req.removeListener?.('aborted', abort);
		res.removeListener?.('close', abort);
	}
}

function standalonePage(req) {
	// The standalone page is served per request: pick the language from the
	// browser's Accept-Language header (no DSH internals involved).
	const zh = String((req && req.headers && req.headers['accept-language']) || '').toLowerCase().includes('zh');
	const T = zh ? {
		title: 'DSH 代理开关', h1: 'DeepSeek Harness · 代理路由开关', loading: '加载中…',
		authTitle: '首次使用需要授权', authHint: '如果当前页面不是已登录的 DSH GUI，请在本机终端运行 dsh-proxy-toggle-auth（或 npx --package dsh-proxy-toggle dsh-proxy-toggle-auth），复制输出的 token 粘贴到这里。独立浏览器会话空闲 7 天后过期，最长 30 天；token 不会显示在页面或 URL 中。', authPlaceholder: '粘贴本机授权 token', authButton: '授权', authing: '授权中…', authOk: '已授权', authRequired: '请先完成本机授权', hostAuthRequired: 'DSH 宿主会话已过期，请重新打开 DSH 启动时输出的认证 URL，然后刷新页面', renew: '延长授权 7 天', renewing: '续期中…', logout: '退出授权',
		on: '代理开', off: '代理关', testBtn: '测试连通性', testing: '测试中…',
		proxyLabel: 'proxy: ', fileLabel: '状态文件: ', prefixOn: '经 ', prefixOff: '直连 · ', unset: '未设置',
		testOk: (ip, ms, via) => `出口 ${ip} · ${ms}ms · ${via}`, viaProxy: '经代理', viaDirect: '直连',
		testBad: (m) => `测试未通过：${m}`, testErr: (e) => `测试失败：${e}`,
		footer: '每次请求即时生效 · 热键可在设置卡片启用'
	} : {
		title: 'DSH Proxy Toggle', h1: 'DeepSeek Harness · Proxy Routing Toggle', loading: 'Loading…',
		authTitle: 'Authorization required for standalone access', authHint: 'When this is not an already authenticated DSH GUI page, run dsh-proxy-toggle-auth (or npx --package dsh-proxy-toggle dsh-proxy-toggle-auth) in a local terminal and paste its token here. The standalone browser session expires after 7 days idle and at 30 days absolute; the token is never placed in the page or URL.', authPlaceholder: 'Paste the local authorization token', authButton: 'Authorize', authing: 'Authorizing…', authOk: 'Authorized', authRequired: 'Authorize this browser first', hostAuthRequired: 'The DSH host session expired; reopen the DSH authentication URL printed at startup, then refresh this page', renew: 'Renew for 7 days', renewing: 'Renewing…', logout: 'Log out',
		on: 'Proxy ON', off: 'Proxy OFF', testBtn: 'Test connectivity', testing: 'Testing…',
		proxyLabel: 'proxy: ', fileLabel: 'state file: ', prefixOn: 'via ', prefixOff: 'direct · ', unset: 'not set',
		testOk: (ip, ms, via) => `Exit ${ip} · ${ms}ms · ${via}`, viaProxy: 'via proxy', viaDirect: 'direct',
		testBad: (m) => `Test did not pass: ${m}`, testErr: (e) => `Test error: ${e}`,
		footer: 'Effective on the next request · enable the hotkey in the settings card'
	};
	if (!fallbackEnabled) T.authHint = T.hostAuthRequired;
	const authControls = fallbackEnabled ? `<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="${T.authPlaceholder}"><button id="pair" onclick="pair()">${T.authButton}</button><button id="renew" onclick="renew()" hidden>${T.renew}</button><button id="logout" onclick="logout()" hidden>${T.logout}</button>` : '';
	const serializedT = JSON.stringify(T);
	const serializedTestOk = T.testOk.toString();
	const serializedTestBad = T.testBad.toString();
	const serializedTestErr = T.testErr.toString();
	return `<!doctype html><html lang="${zh ? 'zh' : 'en'}"><head><meta charset="utf-8">
<title>${T.title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#111;color:#eee}
  .card{text-align:center;padding:40px 56px;border-radius:16px;background:#1b1b1f;box-shadow:0 8px 40px #0008}
  h1{font-size:18px;font-weight:500;margin:0 0 20px;color:#999}
  #sw{font-size:26px;padding:16px 46px;border-radius:12px;border:none;cursor:pointer;font-weight:600;color:#fff}
  .on{background:#2f9e44}.off{background:#5f6368}
  #t{margin-top:14px;padding:8px 22px;border-radius:10px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font:500 13px system-ui,sans-serif}
  #t:disabled{opacity:.5}
  p{color:#888;font-size:13px;margin-top:18px;line-height:1.6}
  #auth{margin:18px 0;text-align:left;padding:14px;border:1px solid #444;border-radius:8px}
  #auth h2{font-size:14px;margin:0 0 8px;color:#ddd}
  #auth p{margin:0 0 10px;font-size:12px}
  #token{width:100%;box-sizing:border-box;padding:8px;border:1px solid #555;border-radius:6px;background:#111;color:#eee}
  #pair,#renew,#logout{margin-top:10px;padding:7px 14px;border-radius:6px;border:1px solid #555;background:transparent;color:#ddd;cursor:pointer}
  #pair:disabled,#renew:disabled,#logout:disabled{opacity:.5}
</style></head><body><div class="card">
<h1>${T.h1}</h1>
<div id="auth"><h2>${T.authTitle}</h2><p id="authhint">${T.authHint}</p>${authControls}<p id="authmsg"></p></div>
<button id="sw" onclick="flip()" disabled>…</button>
<p id="info">${T.loading}</p>
<button id="t" onclick="testConn()">${T.testBtn}</button>
<p id="tres"></p>
<p>${T.footer}</p>
</div><script>
const T=${serializedT};
T.testOk=${serializedTestOk};
T.testBad=${serializedTestBad};
T.testErr=${serializedTestErr};
let flipping=false,testing=false,authorized=false,fallbackAvailable=false;
const tokenInput=document.getElementById('token'),pairButton=document.getElementById('pair'),renewButton=document.getElementById('renew'),logoutButton=document.getElementById('logout'),authPanel=document.getElementById('auth'),authHint=document.getElementById('authhint'),authMessage=document.getElementById('authmsg'),switchButton=document.getElementById('sw'),testButton=document.getElementById('t');
function setAuthRequired(message,canPair=fallbackAvailable){authorized=false;authPanel.hidden=false;authHint.textContent=canPair?T.authHint:T.hostAuthRequired;if(tokenInput)tokenInput.hidden=!canPair;if(pairButton)pairButton.hidden=!canPair;if(renewButton)renewButton.hidden=true;if(logoutButton)logoutButton.hidden=true;authMessage.textContent=message||T.authRequired;switchButton.disabled=true;testButton.disabled=true;}
function setAuthorized(hostSession){authorized=true;authPanel.hidden=hostSession===true;if(tokenInput)tokenInput.hidden=hostSession===true;if(pairButton)pairButton.hidden=hostSession===true;if(renewButton)renewButton.hidden=hostSession===true;if(logoutButton)logoutButton.hidden=hostSession===true;authMessage.textContent=T.authOk;switchButton.disabled=false;testButton.disabled=false;}
async function pair(){
 if(pairButton.disabled)return;
 const token=tokenInput.value.trim();
 if(!token){authMessage.textContent=T.authRequired;return;}
 pairButton.disabled=true;authMessage.textContent=T.authing;
 try{
  const r=await fetch('/vpn/pair',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error('HTTP '+r.status);
  tokenInput.value='';setAuthorized();await load();
 }catch(e){setAuthRequired(T.testErr(e));}
 finally{pairButton.disabled=false;}
}
async function renew(){
 if(!authorized||renewButton.disabled)return;
 renewButton.disabled=true;authMessage.textContent=T.renewing;
 try{
  const r=await fetch('/vpn/renew',{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(5000)});
  if(r.status===401){setAuthRequired(fallbackAvailable?T.authRequired:T.hostAuthRequired,fallbackAvailable);return;}
  if(!r.ok)throw new Error('HTTP '+r.status);
  authMessage.textContent=T.renew;
  await load();
 }catch(e){authMessage.textContent=T.testErr(e);}
 finally{renewButton.disabled=false;}
}
 async function logout(){
 try{await fetch('/vpn/logout',{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(3000)});}catch{}
 setAuthRequired(fallbackAvailable?T.authRequired:T.hostAuthRequired,fallbackAvailable);document.getElementById('info').textContent=fallbackAvailable?T.authRequired:T.hostAuthRequired;
}
async function load(){
 try{
  const r=await fetch('/vpn',{credentials:'same-origin',signal:AbortSignal.timeout(3000)});
  if(r.status===401){const detail=await r.json().catch(()=>null);fallbackAvailable=detail?.fallbackEnabled===true;const message=fallbackAvailable?T.authRequired:T.hostAuthRequired;setAuthRequired(message,fallbackAvailable);document.getElementById('info').textContent=message;return;}
  if(!r.ok)throw new Error('HTTP '+r.status);
  const s=await r.json();fallbackAvailable=s.fallbackEnabled===true;setAuthorized(s.authMethod === 'host');
  switchButton.className=s.enabled?'on':'off';switchButton.textContent=s.enabled?T.on:T.off;
  document.getElementById('info').textContent=(s.enabled?T.prefixOn:T.prefixOff)+T.proxyLabel+(s.proxy||T.unset)+(s.file?' | '+T.fileLabel+s.file:'');
 }catch(e){if(!authorized){if(fallbackAvailable)setAuthRequired(T.testErr(e));else authPanel.hidden=true;switchButton.disabled=true;testButton.disabled=true;document.getElementById('info').textContent=T.testErr(e);}else document.getElementById('info').textContent=T.testErr(e);}
}
async function flip(){
 if(!authorized||flipping||testing)return;
 flipping=true;switchButton.disabled=true;testButton.disabled=true;
 try{const r=await fetch('/vpn/toggle',{method:'POST',credentials:'same-origin'});if(r.status===401){setAuthRequired(fallbackAvailable?T.authRequired:T.hostAuthRequired,fallbackAvailable);return;}if(!r.ok)throw new Error('HTTP '+r.status);}
 catch(e){document.getElementById('info').textContent=T.testErr(e);}
 finally{flipping=false;if(authorized){switchButton.disabled=false;testButton.disabled=false;await load();}}
}
async function testConn(){
 if(!authorized||testButton.disabled||flipping||testing)return;
 testing=true;testButton.disabled=true;switchButton.disabled=true;const o=document.getElementById('tres');o.textContent=T.testing;
 try{
  const r=await fetch('/vpn/test',{method:'POST',credentials:'same-origin'});if(r.status===401){setAuthRequired(fallbackAvailable?T.authRequired:T.hostAuthRequired,fallbackAvailable);return;}if(!r.ok)throw new Error('HTTP '+r.status);
  const d=await r.json();o.textContent=d.ok?T.testOk(d.exitIp,d.latencyMs,d.via==='proxy'?T.viaProxy:T.viaDirect):T.testBad(d.hint||d.stage||'');
 }catch(e){o.textContent=T.testErr(e);}
 finally{testing=false;if(authorized){testButton.disabled=false;switchButton.disabled=false;}}
}
setAuthRequired(T.authRequired,false);load();setInterval(load,5000);
</script></body></html>`;
}

function makeRoutes(auth, getHostConnection = () => controlHostConnection) {
	const routes = [
		{
			kind: 'exact',
			path: '/vpn',
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'proxy endpoint is loopback-only' });
				if (req.method === 'OPTIONS') {
					res.writeHead(204, { 'cache-control': 'no-store' });
					res.end();
					return;
				}
				if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' });
				const authResult = await requireControlAuth(req, res, auth, getHostConnection());
				if (!authResult.ok) return;
				writeJson(res, 200, statusSummary(req, authResult.kind));
			}
		},
		{
			kind: 'exact',
			path: '/vpn/ui',
			handler: (req, res) => {
				if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'proxy endpoint is loopback-only' });
				if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' });
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
					'x-content-type-options': 'nosniff',
					'x-frame-options': 'DENY',
					'content-security-policy': "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
					'referrer-policy': 'no-referrer'
				});
				res.end(standalonePage(req));
			}
		},
		{
			kind: 'exact',
			path: '/vpn/pair',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				return handlePairRequest(req, res, auth);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/logout',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				return handleLogoutRequest(req, res, auth);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/renew',
			handler: async (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				return handleRenewRequest(req, res, auth);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/on',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				return handleToggleRequest(req, '/vpn/on', res, auth, getHostConnection());
			}
		},
		{
			kind: 'exact',
			path: '/vpn/off',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				return handleToggleRequest(req, '/vpn/off', res, auth, getHostConnection());
			}
		},
		{
			kind: 'exact',
			path: '/vpn/toggle',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				return handleToggleRequest(req, '/vpn/toggle', res, auth, getHostConnection());
			}
		},
		{
			kind: 'exact',
			path: '/vpn/test',
			handler: async (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				if (!sameOriginOk(req)) {
					writeJson(res, 403, { error: 'cross-origin state change rejected' });
					return;
				}
				const authResult = await requireControlAuth(req, res, auth, getHostConnection());
				if (!authResult.ok) return;
				return handleTestRequest(req, res);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/proxy',
			handler: async (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				if (!sameOriginOk(req)) {
					writeJson(res, 403, { error: 'cross-origin state change rejected' });
					return;
				}
				const authResult = await requireControlAuth(req, res, auth, getHostConnection());
				if (!authResult.ok) return;
				return new Promise((resolve) => {
					const finish = () => resolve();
					const maxBodyBytes = 65536;
				const rawLength = req.headers['content-length'];
				const declaredLength = rawLength === undefined ? 0 : Number(rawLength);
				if ((rawLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) || declaredLength > maxBodyBytes) {
					writeJson(res, declaredLength > maxBodyBytes ? 413 : 400, { error: declaredLength > maxBodyBytes ? 'request body too large' : 'invalid content-length' });
					try {
						req.destroy();
					} catch {}
					finish();
					return;
				}
				let chunks = [];
				let bodyBytes = 0;
				let tooLarge = false;
				let aborted = false;
				const timeout = setTimeout(() => {
					if (aborted || tooLarge || res.writableEnded) return;
					tooLarge = true;
					writeJson(res, 408, { error: 'request body timed out' });
					req.destroy();
					finish();
				}, 10000);
				timeout.unref?.();
				const rejectBody = () => {
					if (tooLarge || aborted) return;
					tooLarge = true;
					clearTimeout(timeout);
					writeJson(res, 413, { error: 'request body too large' });
					try {
						req.destroy();
					} catch {}
					finish();
				};
				req.on('aborted', () => {
					aborted = true;
					clearTimeout(timeout);
					finish();
				});
				req.on('error', (cause) => {
					if (!tooLarge && !aborted) logErr('proxy request body failed', cause);
					aborted = true;
					clearTimeout(timeout);
					finish();
				});
				req.on('data', (chunk) => {
					if (tooLarge || aborted) return;
					const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					bodyBytes += piece.byteLength;
					if (bodyBytes > maxBodyBytes) {
						rejectBody();
						return;
					}
					chunks.push(piece);
				});
				req.on('end', async () => {
					try {
						clearTimeout(timeout);
					if (tooLarge || aborted) return;
					let patch;
					try {
						const body = Buffer.concat(chunks).toString('utf8');
						patch = JSON.parse(body || '{}');
						if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('JSON body must be an object');
						const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
						for (const [key, maxLength] of [['proxy', MAX_PROXY_LENGTH], ['noProxy', MAX_LIST_LENGTH], ['allowProxy', MAX_LIST_LENGTH]]) {
							if (!has(key)) continue;
							if (typeof patch[key] !== 'string') throw new TypeError(`${key} must be a string`);
							if (patch[key].length > maxLength) throw new RangeError(`${key} is too long`);
						}
						if (has('mode') && patch.mode !== 'all' && patch.mode !== 'allowlist') throw new TypeError('mode must be all or allowlist');
					} catch (cause) {
						logErr('invalid proxy request body', cause);
						writeJson(res, 400, { error: 'request body has invalid fields' });
						return;
					}
					// Bare host:port is accepted and canonicalized to http://
					const candidate = typeof patch.proxy === 'string' ? normalizeUserProxy(patch.proxy) : undefined;
					// Reject unsupported schemes at write time so a garbage URI
					// can never reach ProxyAgent (empty string = auto mode).
					if (candidate !== undefined && candidate !== '' && !isValidProxyUrl(candidate)) {
						writeJson(res, 400, { error: 'proxy must be an http(s):// or socks5:// URL (or bare host:port)' });
						return;
					}
					try {
						// Sensitive routing fields are authoritative in the locked state file.
						// The settings scope mirrors them for display but never writes them.
						await updateState((s) => {
							if (candidate !== undefined) {
								s.proxy = candidate;
								s.proxySource = candidate === '' ? 'auto' : 'api';
							}
							if (typeof patch.noProxy === 'string') s.noProxy = patch.noProxy.trim();
							if (patch.mode === 'all' || patch.mode === 'allowlist') s.mode = patch.mode;
							if (typeof patch.allowProxy === 'string') s.allowProxy = patch.allowProxy.trim();
						});
						writeJson(res, 200, statusSummary(req, authResult.kind));
					} catch (cause) {
						logErr('proxy state update failed', cause);
						writeJson(res, 500, { error: 'proxy configuration could not be saved' });
					}
					} catch (cause) {
						logErr('proxy request processing failed', cause);
						writeJson(res, 500, { error: 'proxy configuration could not be processed' });
					} finally {
						finish();
					}
				});
				});
			}
		}
	];
	return routes;
}

// Optional fallback endpoint when webServer is unavailable: same routes on a private
// loopback port (43199+), reported via $DSH_HOME/vpn-proxy.port (default ~/.dsh).
function startStandaloneEndpoint() {
	try {
		const server = http.createServer((req, res) => {
			try {
				if (!isLoopbackRequest(req)) {
					res.writeHead(403);
					res.end();
					return;
				}
				const url = new URL(req.url, 'http://127.0.0.1');
				const path = url.pathname.replace(/\/+$/, '') || '/';
				const route = makeRoutes(controlAuth).find((r) => r.path === path);
				if (route) {
					const pending = route.handler(req, res);
					if (pending && typeof pending.catch === 'function') pending.catch((cause) => {
						logErr('standalone route failed', cause);
						if (!res.writableEnded) writeJson(res, 500, { error: 'proxy endpoint failed' });
					});
					return;
				}
				writeJson(res, 404, { error: 'unknown route' });
			} catch (cause) {
				logErr('standalone endpoint error', cause);
				try {
					if (!res.writableEnded) writeJson(res, 500, { error: 'proxy endpoint failed' });
				} catch {}
			}
		});
		// listen() never throws synchronously on EADDRINUSE — the error arrives
		// as an async 'error' event. Retry sequentially from that event, and keep
		// a listener attached at all times so a busy port can never surface as an
		// unhandled 'error' (which would crash the main process).
		let disposed = false;
		let boundPort = null;
		const portFile = join(HOME, 'vpn-proxy.port');
		try {
			mkdirSync(dirname(portFile), { recursive: true });
		} catch (cause) {
			logErr('standalone endpoint could not prepare DSH_HOME', cause);
		}
		const writePortFile = (port) => {
			try {
				mkdirSync(dirname(portFile), { recursive: true });
				writeFileSync(portFile, String(port), { encoding: 'utf8', mode: 0o600 });
				return true;
			} catch (cause) {
				logErr('standalone endpoint port file failed', cause);
				return false;
			}
		};
		const ports = [43199, 43200, 43201, 43202, 43203, 43204, 43205, 43206];
		let attempt = 0;
		const removeOwnedPortFile = () => {
			if (boundPort === null) return;
			try {
				if (readFileSync(portFile, 'utf8').trim() === String(boundPort)) unlinkSync(portFile);
			} catch {}
			boundPort = null;
		};
		const runtimeError = (cause) => logErr('standalone endpoint error', cause);
		const tryListen = () => {
			if (disposed || attempt >= ports.length) {
				if (!disposed) {
					logErr('standalone endpoint: no free port in 43199..43206');
					server.on('error', runtimeError);
				}
				return;
			}
			const port = ports[attempt];
			attempt += 1;
			const onListenError = (cause) => {
				if (disposed) return;
				if (cause && cause.code === 'EADDRINUSE') {
					tryListen();
				} else {
					logErr('standalone endpoint listen error', cause);
					server.on('error', runtimeError);
				}
			};
			server.once('error', onListenError);
			try {
				server.listen(port, '127.0.0.1', () => {
					server.removeAllListeners('error');
					server.on('error', runtimeError);
					if (disposed) {
						try {
							server.close();
						} catch {}
						return;
					}
					boundPort = port;
					writePortFile(port);
					log(`standalone endpoint: http://127.0.0.1:${port}/vpn`);
				});
			} catch (cause) {
				server.removeListener('error', onListenError);
				onListenError(cause);
			}
		};
		tryListen();
		return () => {
			disposed = true;
			removeOwnedPortFile();
			return new Promise((resolve) => {
				if (!server.listening) {
					resolve();
					return;
				}
				try {
					server.close(() => resolve());
				} catch {
					resolve();
				}
			});
		};
	} catch (cause) {
		logErr('standalone endpoint failed', cause);
	}
	return undefined;
}

// ------------------------------------------------------------------ pill ----
function injectedButtonSource(initialVisible = true) {
	return `(function(){if(window.__dshProxyBtn)return;window.__dshProxyBtn=true;
var ZH=(navigator.language||'').toLowerCase().indexOf('zh')===0;
var pill=document.createElement('button');
pill.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:8px 14px;border-radius:999px;border:none;cursor:pointer;font:600 13px/1.4 system-ui,sans-serif;color:#fff;background:#4b5563;box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:.88;transition:opacity .15s,background .15s';
pill.onmouseenter=function(){pill.style.opacity='1'};pill.onmouseleave=function(){pill.style.opacity='.88'};
var hidden=${initialVisible ? 'false' : 'true'},busy=false,lockedState=false;
function mount(){if(!pill.isConnected)(document.body||document.documentElement).appendChild(pill)}
function paint(text,bg,title){pill.textContent=text;pill.style.background=bg;pill.title=title}
function paintState(s){lockedState=false;if(s&&s.pill===false){hidden=true;if(pill.isConnected)pill.remove();return}
if(s&&s.pill===true)hidden=false;if(hidden)return;if(s)mount();
if(s&&s.enabled)paint((ZH?'代理':'Proxy')+' \\u25CF','#2f9e44',(ZH?'DSH 正走代理: ':'DSH using proxy: ')+s.proxy+'\\n'+(ZH?'点击关闭':'Click to turn off'));else if(s)paint((ZH?'代理':'Proxy')+' \\u25CB','#4b5563',(ZH?'DSH 直连\\n点击开启代理 (':'Direct\\nClick to enable proxy (')+(s.proxy||(ZH?'未设置':'not set'))+')');else paint((ZH?'代理':'Proxy')+' \\u00D7','#6b7280',ZH?'proxy-toggle 端点不可达（插件未加载？）':'proxy-toggle endpoint unreachable (plugin not loaded?)')}
function locked(){if(hidden)return;lockedState=true;mount();paint((ZH?'代理':'Proxy')+' \\uD83D\\uDD12','#6b7280',ZH?'请先打开 /vpn/ui 完成本机授权':'Open /vpn/ui to authorize this browser first')}
async function refresh(){try{const r=await fetch('/vpn',{credentials:'same-origin',signal:AbortSignal.timeout(2500)});if(r.status===401){locked();return}if(!r.ok)throw Error('HTTP '+r.status);paintState(await r.json())}catch(e){paintState(null)}}
pill.addEventListener('click',async function(){if(lockedState){location.href='/vpn/ui';return}if(busy)return;busy=true;try{const r=await fetch('/vpn/toggle',{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(3000)});if(r.status===401){locked();return}if(!r.ok)throw Error('HTTP '+r.status)}catch(e){}finally{busy=false}refresh();setTimeout(refresh,500)});
refresh();setInterval(refresh,5000);})();`;
}

function injectPill(html) {
	const tag = `<script>${injectedButtonSource(currentShowPill)}</script>`;
	if (typeof html !== 'string') return html;
	const lower = html.toLowerCase();
	const at = lower.lastIndexOf('</body>');
	if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
	return html + tag;
}

// ---------------------------------------------------------------- hotkey ----
function armHotkey(hotkey, onToggle) {
	if (!hotkey || !hotkey.trim()) {
		hotkeyState = { accelerator: '', registered: false };
		return () => {}; // 留空 = 不启用
	}
	let disposed = false;
	try {
		const electron = require('electron');
		const { app, globalShortcut } = electron.default ?? electron;
		app.whenReady().then(() => {
			if (disposed) return;
			try {
				const ok = globalShortcut.register(hotkey, onToggle);
				hotkeyState = { accelerator: hotkey, registered: ok };
				log(`global hotkey ${hotkey} ${ok ? 'registered' : 'register FAILED (key taken?)'}`);
			} catch (cause) {
				hotkeyState = { accelerator: hotkey, registered: false };
				logErr('hotkey register failed', cause);
			}
		});
	} catch (cause) {
		hotkeyState = { accelerator: hotkey, registered: false };
		logErr('electron unavailable for hotkey', cause);
	}
	return () => {
		disposed = true;
		hotkeyState = { accelerator: hotkey, registered: false };
		try {
			const electron = require('electron');
			const { globalShortcut } = electron.default ?? electron;
			globalShortcut.unregister(hotkey);
		} catch {}
	};
}

// --------------------------------------------------------------- guidance ----
// Agent guidance follows the host locale. It is agent-facing documentation,
// so an agent reading the "other" language still operates the endpoints fine.
const GUIDANCE = HOST_ZH ? [
	'本机已安装 dsh-proxy-toggle：它只包装主进程使用全局 undici dispatcher 的 fetch（模型 API、Files API 等）；显式传入自有 dispatcher 的请求（例如 dsh-web-fetch-http）不受此开关影响。',
	'用户说「开代理 / 关代理 / 切换代理」时：默认在已认证的 DSH GUI 中直接调用同源控制接口；只有插件配置显式 enableFallback=true 且当前页面是 fallback 端点时，才先在 /vpn/ui 完成本机配对，再 POST /vpn/on|/vpn/off|/vpn/toggle，随后 GET /vpn 查看状态。控制面仅限回环连接；默认不创建插件 token/session。不要把 token 写入日志、提示词或页面，也不能把控制面当作远程安全 API或通过反代暴露到 LAN/公网。',
	'用户说「续期授权」时：先 GET /vpn；只有 authMethod=session 时才 POST /vpn/renew。该接口只轮换仍有效的插件浏览器会话，不会恢复已过期会话，也不会延长 DSH 宿主会话。若宿主会话返回 401，应提示用户重新打开 DSH 启动时输出的认证 URL；若 fallback 会话过期，应提示用户在启用 fallback 后使用本机 token 重新配对，绝不要在聊天中索要或回显 token。',
	'状态文件位于 $DSH_HOME/vpn-proxy.json（未配置时为 ~/.dsh/vpn-proxy.json），字段包括 enabled/mode/proxy/proxySource/noProxy/allowProxy/note/revision。代理和分流字段由认证的 /vpn/proxy 写入状态文件；settings namespace 只保存热键、悬浮按钮和 agent 指引。仅在 enableFallback=true 时，命令行可用 `curl -H "Authorization: Bearer $(dsh-proxy-toggle-auth)" http://127.0.0.1:端口/vpn...` 发送 Bearer；不要把 token 写入日志、提示词或页面。代理只接受 http(s)://、socks5:// 或 bare host:port；凭据、路径、query 和 fragment 会被拒绝。',
	'开启时空代理会自动探测系统代理，再并行验证常见本地端口（7897/7890/10809/10808/2080/1080/8118）的 HTTP/SOCKS5 出口。all 模式若没有可用代理会拒绝开启以防止直连泄漏；allowlist 且 allowProxy 为空可以启用 direct-only。手动代理失联只给出警告，不会自动替换手动地址。',
	'分流模式：all = 全部非 noProxy 流量走代理；allowlist = 仅命中 allowProxy 的主机走代理，其余直连。列表支持 .example.com、* 和带端口的 host:port（带端口时只匹配该 origin 端口）；noProxy 优先级最高。遇到失败先 POST /vpn/off，再检查 proxy 客户端和代理端口。'
].join('') : [
	'dsh-proxy-toggle wraps only the main process global undici dispatcher used by fetch (model APIs, Files API, and similar traffic). Requests that pass their own explicit dispatcher, such as dsh-web-fetch-http, are outside this switch.',
	'For on/off/toggle, an authenticated DSH GUI should call the same-origin control endpoint directly. Only when `enableFallback=true` is explicitly configured and the current page is the fallback endpoint should it pair in /vpn/ui first, then POST /vpn/on|/vpn/off|/vpn/toggle and GET /vpn to confirm. The control surface is loopback-only; fallback token/session creation is disabled by default. Never put tokens in logs, prompts, or page content, and never expose the control surface through a reverse proxy to a LAN/public network.',
	'When the user asks to renew authorization, first GET /vpn; only POST /vpn/renew when authMethod=session. That endpoint rotates a still-valid plugin browser session, but cannot recover an expired session or extend the DSH host session. If the host session returns 401, tell the user to reopen the DSH authentication URL printed at startup; if an opt-in fallback session expires, tell the user to pair again with the local token without requesting or echoing that token in chat.',
	'The state file is $DSH_HOME/vpn-proxy.json (or ~/.dsh/vpn-proxy.json by default) with enabled/mode/proxy/proxySource/noProxy/allowProxy/note/revision. Routing fields are written authoritatively by authenticated /vpn/proxy; the settings namespace stores only the hotkey, pill, and agent-guidance preference. Only when `enableFallback=true` is configured may a local shell use `curl -H "Authorization: Bearer $(dsh-proxy-toggle-auth)" http://127.0.0.1:PORT/vpn...`; never put the token in logs, prompts, or page content. Only http(s)://, socks5://, or bare host:port are accepted; credentials, path, query, and fragment are rejected.',
	'When enabling with an empty proxy, the plugin detects the system proxy and then validates common local ports (7897/7890/10809/10808/2080/1080/8118) with HTTP/SOCKS5 exit probes. In all mode, enabling is refused when no usable proxy is found to prevent direct leakage; allowlist with an empty allowProxy intentionally enables direct-only routing. A dead manually selected proxy is warned about but never replaced automatically.',
	'Routing: all sends every non-noProxy target through the proxy; allowlist sends only hosts matching allowProxy through it. Lists support .example.com, *, and host:port entries (a port-qualified entry matches only that origin port); noProxy wins. If requests fail, POST /vpn/off first, then inspect the proxy client and proxy port.'
].join('');

// -------------------------------------------------------------- plugin ------
const name = 'proxy-toggle';
const inject = ['webServer', 'systemPrompt'];
const PROXY_SETTINGS_NAMESPACE = 'proxy-toggle';

const MAX_PROXY_LENGTH = 2048;
const MAX_LIST_LENGTH = 16384;
const MAX_HOTKEY_LENGTH = 128;

const Config = z.object({
	dshHome: z.string().max(4096).default('').description('DSH data home override; empty = use $DSH_HOME or the default ~/.dsh'),
	enableFallback: z.boolean().default(false).description('Advanced: enable the private fallback port, local token, and browser pairing when WebServer routes are unavailable'),
	proxy: z.string().max(MAX_PROXY_LENGTH).default('').description('代理软件在本机的入口地址（http(s)://、socks5:// 或 host:port）；留空 = 自动模式（自动探测系统代理，端口失效自动切换）'),
	noProxy: z.string().max(MAX_LIST_LENGTH).default(DEFAULT_NO_PROXY).description('永远直连、不走代理的地址（逗号分隔，支持 .example.com 后缀、IDN、带端口条目与 *）；优先级最高'),
	mode: z.union([z.const('all'), z.const('allowlist')]).default('all').description('分流模式：all = 全部流量走代理；allowlist（白名单）= 仅白名单内的网站走代理，其余直连'),
	allowProxy: z.string().max(MAX_LIST_LENGTH).default('').description('代理白名单：仅白名单模式下走代理的网站（逗号分隔，支持 .example.com 后缀、IDN 与带端口条目）；留空 = 全部直连'),
	hotkey: z.string().max(MAX_HOTKEY_LENGTH).default(DEFAULT_HOTKEY).description('全局热键：在任何界面按键即可开关代理（如 Control+Alt+V，可录制组合键）；留空不启用'),
	showPill: z.boolean().default(true).description('在 DSH 窗口右下角显示代理开关小圆钮'),
	announceToAgent: z.boolean().default(true).description('让 AI 助手（agent）知道如何帮你开关代理')
});

const SettingsConfig = z.object({
	hotkey: z.string().max(MAX_HOTKEY_LENGTH).default(DEFAULT_HOTKEY).description('全局热键'),
	showPill: z.boolean().default(true).description('在 DSH 窗口右下角显示代理开关小圆钮'),
	announceToAgent: z.boolean().default(true).description('让 AI 助手（agent）知道如何帮你开关代理')
});

function validateConfig(value) {
	const proxy = normalizeUserProxy(value?.proxy);
	if (proxy !== '' && !isValidProxyUrl(proxy)) throw new TypeError('proxy must be a valid http(s):// or socks5:// URL without credentials or path data');
}

/** Single-instance guard for the same package mounted from several sources. */
const MOUNTED = Symbol.for('dsh-proxy-toggle.mounted');
function mountOnce(packageName, fn) {
	return (...args) => {
		const registry = globalThis;
		const mounted = registry[MOUNTED] ??= new Set();
		if (mounted.has(packageName)) return;
		mounted.add(packageName);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			mounted.delete(packageName);
		};
		try {
			args[0]?.effect?.(() => release);
			return fn(...args);
		} catch (cause) {
			release();
			throw cause;
		}
	};
}

const apply = mountOnce('dsh-proxy-toggle', (ctx, config) => {
	const initialConfig = config ?? {};
	configureDshHome(initialConfig.dshHome);
	fallbackEnabled = initialConfig.enableFallback === true;
	controlAuth = fallbackEnabled ? createControlAuth(HOME, logErr) : null;
	try {
		ctx.inject(['connection'], (connectionCtx) => {
			controlHostConnection = connectionCtx.connection ?? null;
		});
	} catch (cause) {
		if (fallbackEnabled) logErr('host connection authentication is unavailable; using fallback plugin credentials', cause);
		else logErr('host connection authentication is unavailable; fallback endpoint is disabled', cause);
	}
	let current = () => initialConfig;
	let disposeHotkey;
	let disposePill;
	let disposeSection;
	let disposeStandalone;
	let applyActive = true;
	pluginActive = true;
	ctx.effect(() => () => {
		applyActive = false;
		pluginActive = false;
		fallbackEnabled = false;
		controlAuth = null;
		controlHostConnection = null;
	}, 'proxy-toggle: activity');
	let pauseSucceeded = true;
	let pausePromise = Promise.resolve(true);
	let initialStatePristine = false;
	try {
		const bootState = readState();
		initialStatePristine = bootState.revision === 0 && bootState.enabled === false && bootState.proxy === '' && bootState.proxySource === 'auto' && bootState.noProxy === DEFAULT_NO_PROXY && bootState.mode === 'all' && bootState.allowProxy === '';
		pendingEnabledRestore = bootState.enabled;
		pendingEnabledRestoreRevision = null;
		if (bootState.enabled) {
			pausePromise = updateState((s) => {
				s.enabled = false;
			}).then((paused) => {
				pendingEnabledRestoreRevision = paused.revision;
				return true;
			}).catch(async (cause) => {
				pauseSucceeded = false;
				dispatcherError = 'unavailable';
				pendingEnabledRestore = false;
				pendingEnabledRestoreRevision = null;
				pluginActive = false;
				logErr('failed to pause persisted proxy state before dispatcher install', cause);
				try {
					await updateState((s) => {
						s.enabled = false;
						s.note = HOST.dispatcherUnavailable;
					});
				} catch (stateCause) {
					logErr('failed to persist disabled state after pause failure', stateCause);
				}
				return false;
			});
		}
	} catch (cause) {
		pauseSucceeded = false;
		pendingEnabledRestore = false;
		pendingEnabledRestoreRevision = null;
		pluginActive = false;
		logErr('failed to pause persisted proxy state before dispatcher install', cause);
	}

	const requestToggle = async () => {
		if (!applyActive) return;
		try {
			const result = await enqueueToggle(() => performToggle(null, 'hotkey', () => applyActive && pluginActive));
			if (result.error === 'dispatcher') log('hotkey: proxy dispatcher is unavailable or still starting');
			else if (result.error === 'proxy') log('hotkey: cannot enable, no proxy configured and auto-detect/port-scan found none');
		} catch (cause) {
			logErr('hotkey toggle failed', cause);
		}
	};

	let sensitiveConfigSeeded = false;
	const sync = async () => {
		if (!applyActive || !pluginActive) return;
		const value = current();
		currentHotkey = value.hotkey ?? DEFAULT_HOTKEY;
		currentShowPill = (value.showPill ?? true) !== false;
		const before = await readStateAfterWrites();
		if (!applyActive || !pluginActive) return;
		let updated = before;
		const seedSensitive = !sensitiveConfigSeeded && initialStatePristine;
		if (seedSensitive) {
			const configured = typeof initialConfig.proxy === 'string' ? normalizeUserProxy(initialConfig.proxy) : '';
			const configuredValid = configured !== '' && isValidProxyUrl(configured);
			if (configured !== '' && !configuredValid) logErr('initial settings proxy is not a valid http(s)/socks5 URL, ignoring:', displayProxy(configured));
			let detected = '';
			if (configured === '') detected = await detectSystemProxy();
			if (!applyActive || !pluginActive) return;
			const seeded = await updateStateIfUnchanged(before, (s) => {
				if (configuredValid) {
					s.proxy = configured;
					s.proxySource = 'manual';
				} else if (detected !== '') {
					s.proxy = detected;
					s.proxySource = 'auto';
				}
				if (typeof initialConfig.noProxy === 'string') s.noProxy = initialConfig.noProxy.trim();
				if (initialConfig.mode === 'all' || initialConfig.mode === 'allowlist') s.mode = initialConfig.mode;
				if (typeof initialConfig.allowProxy === 'string') s.allowProxy = initialConfig.allowProxy.trim();
			}, () => applyActive && pluginActive);
			updated = seeded || await readStateAfterWrites();
			sensitiveConfigSeeded = true;
		} else {
			sensitiveConfigSeeded = true;
			if (before.proxy === '' && before.proxySource === 'auto') {
				const detected = await detectSystemProxy();
				if (!applyActive || !pluginActive) return;
				if (detected !== '') {
					updated = await updateStateIfProxyUnchanged(before, (s) => {
						s.proxy = detected;
						s.proxySource = 'auto';
					}, () => applyActive && pluginActive) || before;
				}
			}
		}
		if (!applyActive || !pluginActive) return;
		if (updated.enabled && updated.proxy === '' && dispatcherReady) {
			const resolution = await resolveProxyForEnable(() => applyActive && pluginActive && dispatcherReady);
			if (!applyActive || !pluginActive) return;
			if (resolution.error === true || resolution.warning) {
				await updateState((s) => {
					if (!applyActive || !pluginActive) return;
					s.note = displayNote(resolution.warning || HOST.proxyUnreachable);
				});
			}
		}
		if (!applyActive || !pluginActive) return;
		// hotkey
		if (disposeHotkey !== undefined) {
			disposeHotkey();
			disposeHotkey = undefined;
		}
		disposeHotkey = ctx.effect(() => armHotkey(value.hotkey ?? DEFAULT_HOTKEY, requestToggle), 'proxy-toggle: hotkey');
		// pill — always inject; the script's visibility is controlled live
		// by statusSummary.pill. Conditional injection would leave pages that
		// were opened while showPill=off with no poller at all, so turning it
		// back on could never take effect without a reload.
		if (disposePill !== undefined) {
			disposePill();
			disposePill = undefined;
		}
		try {
			disposePill = ctx.effect(() => ctx.webServer.tapIndex(injectPill), 'proxy-toggle: pill');
		} catch (cause) {
			logErr('pill tap failed', cause);
		}
		// agent guidance
		if (disposeSection !== undefined) {
			disposeSection();
			disposeSection = undefined;
		}
		if ((value.announceToAgent ?? true) !== false) {
			disposeSection = ctx.systemPrompt.section({
				name: 'plugin:dsh-proxy-toggle',
				order: 210,
				text: GUIDANCE
			});
		}
	};
	let syncTail = Promise.resolve();
	const safeSync = () => {
		const run = syncTail.then(() => applyActive && pluginActive ? sync() : undefined);
		syncTail = run.catch((cause) => {
			logErr('settings sync failed', cause);
		});
		return run;
	};

	// dispatcher（一次安装，fiber 退出时还原符号）
	ctx.effect(() => {
		const epoch = ++dispatcherEpoch;
		let disposer;
		const restorePending = async (expectedEpoch = null, allowInactive = false) => {
			if (!pendingEnabledRestore) return false;
			let restored = false;
			let skipped = false;
			await updateState((s) => {
				if (!pendingEnabledRestore || (expectedEpoch !== null && (dispatcherEpoch !== expectedEpoch || (!pluginActive && !allowInactive))) || (pendingEnabledRestoreRevision !== null && s.revision !== pendingEnabledRestoreRevision)) {
					skipped = true;
					return;
				}
				if (s.enabled) {
					restored = true;
					return;
				}
				s.enabled = true;
				restored = true;
			});
			if (restored || !pendingEnabledRestore) {
				pendingEnabledRestore = false;
				pendingEnabledRestoreRevision = null;
			}
			return restored ? true : skipped && pendingEnabledRestore ? null : false;
		};
		const prepareRestore = async () => {
			if (!pendingEnabledRestore) return true;
			await syncTail;
			const current = await readStateAfterWrites();
			if (!pluginActive || dispatcherEpoch !== epoch || !pendingEnabledRestore) return null;
			if (current.enabled) {
				pendingEnabledRestoreRevision = current.revision;
				return true;
			}
			const needsConfiguredProxy = current.mode !== 'allowlist' || String(current.allowProxy || '').trim() !== '';
			if (!needsConfiguredProxy) {
				pendingEnabledRestoreRevision = current.revision;
				return true;
			}
			const resolution = await resolveProxyForEnable(() => pluginActive && dispatcherReady && dispatcherEpoch === epoch);
			if (!pluginActive || dispatcherEpoch !== epoch || !pendingEnabledRestore) return null;
			if (resolution.error === true) {
				if (!pluginActive || dispatcherEpoch !== epoch || !pendingEnabledRestore) return null;
				let disabledPersisted = false;
				try {
					await updateState((s) => {
						if (!pluginActive || dispatcherEpoch !== epoch || !pendingEnabledRestore || s.revision !== current.revision || s.enabled !== current.enabled || s.proxy !== current.proxy || s.proxySource !== current.proxySource || s.mode !== current.mode || s.noProxy !== current.noProxy || s.allowProxy !== current.allowProxy) return;
						s.enabled = false;
						s.note = HOST.proxyUnreachable;
						disabledPersisted = true;
					});
				} catch (cause) {
					logErr('failed to persist disabled state after restore proxy resolution failed', cause);
				}
				if (!disabledPersisted) {
					if (!pendingEnabledRestore) return false;
					return 'retry';
				}
				pendingEnabledRestore = false;
				pendingEnabledRestoreRevision = null;
				return false;
			}
			const latest = await readStateAfterWrites();
			if (!pluginActive || dispatcherEpoch !== epoch || !pendingEnabledRestore) return null;
			pendingEnabledRestoreRevision = latest.revision;
			return true;
		};
		const prepareStableRestore = async () => {
			let decision = true;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				decision = await prepareRestore();
				if (decision !== 'retry') return decision;
			}
			return 'retry';
		};
		const installation = (async () => {
			if (!(await pausePromise) || !pauseSucceeded || !pluginActive) return;
			const cleanup = await installDispatcher(epoch);
			if (cleanup === undefined) return;
			if (epoch !== dispatcherEpoch || !pluginActive) {
				await cleanup();
				return;
			}
			const restoreDecision = await prepareStableRestore();
			if (restoreDecision === 'retry') {
				logErr('persisted proxy enabled state could not be safely restored after concurrent state changes; leaving it disabled');
				pendingEnabledRestore = false;
				pendingEnabledRestoreRevision = null;
				disposer = cleanup;
				return;
			}
			if (restoreDecision === null || epoch !== dispatcherEpoch || !pluginActive) {
				await cleanup();
				return;
			}
			if (restoreDecision === false) {
				disposer = cleanup;
				return;
			}
			if (pendingEnabledRestore) {
				let restored = false;
				for (let attempt = 0; attempt < 3 && pendingEnabledRestore; attempt += 1) {
					let result;
					try {
						result = await restorePending(epoch);
					} catch (cause) {
						logErr('failed to restore persisted proxy enabled state', cause);
						break;
					}
					if (result === true || !pendingEnabledRestore) {
						restored = result === true;
						break;
					}
					if (epoch !== dispatcherEpoch || !pluginActive) {
						await cleanup();
						return;
					}
					if (result !== null || attempt === 2) break;
					const retryDecision = await prepareStableRestore();
					if (retryDecision === 'retry') break;
					if (retryDecision === null || epoch !== dispatcherEpoch || !pluginActive) {
						await cleanup();
						return;
					}
					if (retryDecision === false) {
						disposer = cleanup;
						return;
					}
				}
				if (pendingEnabledRestore && !restored) {
					logErr('persisted proxy enabled state was not restored after concurrent state changes; leaving it disabled');
					pendingEnabledRestore = false;
					pendingEnabledRestoreRevision = null;
				}
			}
			if (epoch !== dispatcherEpoch || !pluginActive) {
				await cleanup();
				return;
			}
			disposer = cleanup;
		})();
		installation.catch((cause) => logErr('dispatcher lifecycle failed', cause));
		return async () => {
			const cleanupEpoch = dispatcherEpoch === epoch ? epoch + 1 : dispatcherEpoch;
			if (dispatcherEpoch === epoch) dispatcherEpoch = cleanupEpoch;
			pluginActive = false;
			const cleanup = disposer;
			disposer = undefined;
			if (cleanup !== undefined) await cleanup();
			await installation;
			if (pendingEnabledRestore && dispatcherEpoch === cleanupEpoch) {
				let restored = false;
				for (let attempt = 0; attempt < 3 && pendingEnabledRestore; attempt += 1) {
					let result;
					try {
						result = await restorePending(cleanupEpoch, true);
					} catch (cause) {
						logErr('failed to restore proxy preference during dispatcher dispose', cause);
						break;
					}
					if (result === true || !pendingEnabledRestore) {
						restored = result === true;
						break;
					}
					if (result !== null || dispatcherEpoch !== cleanupEpoch) break;
					const latest = await readStateAfterWrites();
					if (dispatcherEpoch !== cleanupEpoch || !pendingEnabledRestore) break;
					pendingEnabledRestoreRevision = latest.revision;
				}
				if (dispatcherEpoch === cleanupEpoch && pendingEnabledRestore && !restored) {
					logErr('proxy preference was not restored during dispatcher dispose; leaving it disabled');
					pendingEnabledRestore = false;
					pendingEnabledRestoreRevision = null;
				}
			}
		};
	}, 'proxy-toggle: dispatcher');

	// routes（默认仅 WebServer 同源；高级配置才启用独立回环端口）
	ctx.effect(() => {
		const disposers = [];
		try {
			for (const route of makeRoutes(controlAuth)) disposers.push(ctx.webServer.register(route));
			log('control routes registered on webServer (/vpn*)');
			return () => {
				for (const dispose of disposers.splice(0)) {
					try {
						dispose();
					} catch (cause) {
						logErr('webServer route dispose failed', cause);
					}
				}
			};
		} catch (cause) {
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch (disposeCause) {
					logErr('partial webServer route rollback failed', disposeCause);
				}
			}
			if (!fallbackEnabled) {
				logErr('webServer routes failed; fallback endpoint is disabled by configuration', cause);
				return () => {};
			}
			logErr('webServer routes failed, falling back to standalone endpoint', cause);
			disposeStandalone = startStandaloneEndpoint();
			return () => {
				if (disposeStandalone !== undefined) {
					const dispose = disposeStandalone;
					disposeStandalone = undefined;
					return dispose();
				}
			};
		}
	}, 'proxy-toggle: routes');

	// startup self-check + liveness watchdog. `enabled` persists in the state
	// file, so after a reboot the proxy client may be down or on another port:
	// the same resolution as a manual enable runs once shortly after mount,
	// with one late retry (the client may still be booting). While enabled, a
	// slow probe notifies on lost/regained connectivity — it NEVER falls back
	// to direct on its own, that would silently change where traffic goes.
	ctx.effect(() => {
		let stopped = false;
		let lastAlive = null;
		let retry;
		let checking = false;
		const check = async (attempt) => {
			if (stopped || !pluginActive || !dispatcherReady || checking) return;
			checking = true;
			try {
				const st = readState();
				if (!st.enabled) return;
				if (st.proxy && await probeProxyAlive(st.proxy)) {
					if (stopped || !pluginActive) return;
					if (st.note) await updateState((s) => {
						s.note = '';
					});
					return;
				}
				const resolution = await resolveProxyForEnable(() => !stopped && pluginActive && dispatcherReady);
				if (stopped || !pluginActive || resolution.error === 'cancelled') return;
				const note = resolution.note || resolution.warning || (resolution.error ? HOST.proxyUnreachable : '');
				if (note) {
					await updateState((s) => {
						s.note = displayNote(note);
					});
					if (stopped || !pluginActive) return;
					notifyState(readState(), note);
					log(`self-check: ${displayNote(note)}`);
				}
				const currentState = readState();
				if (!stopped && pluginActive && attempt === 0 && (resolution.warning || resolution.error) && currentState.proxySource === 'auto') {
					retry = setTimeout(() => {
						retry = undefined;
						if (!stopped && pluginActive) check(1).catch((cause) => logErr('self-check retry failed', cause));
					}, 20000);
					retry.unref?.();
				}
			} catch (cause) {
				if (!stopped) logErr('self-check failed', cause);
			} finally {
				checking = false;
			}
		};
		const boot = setTimeout(() => {
			check(0).catch((cause) => logErr('self-check boot failed', cause));
		}, 3000);
		boot.unref?.();
		const watchdog = async () => {
			if (stopped || !pluginActive || !dispatcherReady || checking) return;
			checking = true;
			try {
				const st = readState();
				if (!st.enabled) {
					lastAlive = null;
					return;
				}
				if (!st.proxy) {
					lastAlive = null;
					checking = false;
					await check(1);
					return;
				}
				const alive = await probeProxyAlive(st.proxy);
				if (stopped || !pluginActive) return;
				if (lastAlive === true && !alive) {
					await updateState((s) => {
						s.note = HOST.lost;
					});
					if (stopped || !pluginActive) return;
					notifyState(readState(), HOST.lost);
				} else if (lastAlive === false && alive) {
					await updateState((s) => {
						s.note = HOST.recovered;
					});
					if (stopped || !pluginActive) return;
					notifyState(readState(), HOST.recovered);
				}
				lastAlive = alive;
			} catch (cause) {
				if (!stopped) logErr('proxy watchdog failed', cause);
			} finally {
				checking = false;
			}
		};
		const timer = setInterval(() => {
			watchdog().catch((cause) => logErr('proxy watchdog failed', cause));
		}, 30000);
		timer.unref?.();
		return () => {
			stopped = true;
			clearTimeout(boot);
			if (retry !== undefined) clearTimeout(retry);
			clearInterval(timer);
		};
	}, 'proxy-toggle: self-check');

	// state file
	try {
		ensureStateFile().catch((cause) => logErr('state file init failed', cause));
	} catch (cause) {
		logErr('state file init failed', cause);
	}

	try {
		ctx.inject(['settings'], (settingsCtx) => {
			const sectionHooks = {
				validate: validateConfig,
				setSource: (source) => {
					current = source;
					safeSync();
				},
				onChange: safeSync
			};
			const settingsEntry = {
				hotkey: initialConfig.hotkey ?? DEFAULT_HOTKEY,
				showPill: initialConfig.showPill ?? true,
				announceToAgent: initialConfig.announceToAgent ?? true
			};
			try {
				settingsCtx.settings.installSection(ctx, PROXY_SETTINGS_NAMESPACE, SettingsConfig, settingsEntry, sectionHooks);
			} catch (cause) {
				// A legacy settings document may contain the old sensitive fields. Keep
				// the namespace available with the non-sensitive schema and let the
				// locked state file remain authoritative for routing.
				logErr('settings schema migration failed; opening read-only UI mode', cause);
				settingsCtx.settings.installSection(ctx, PROXY_SETTINGS_NAMESPACE, SettingsConfig, settingsEntry, {
					setSource: sectionHooks.setSource,
					onChange: sectionHooks.onChange
				});
			}
		});
	} catch (cause) {
		logErr('settings section failed', cause);
	}

	safeSync();
});

export { apply, Config, inject, name };
