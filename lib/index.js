// dsh-vpn-toggle — DSH VPN 快捷开关（profile bundle 插件，主进程半边）
//
// 职责：
//   1. 在主进程安装一个全局 undici dispatcher 包装器：每个请求热读取
//      ~/.dsh/vpn-proxy.json，enabled 时把主进程所有走全局 fetch 的流量
//      （模型 API / Files API / web 抓取）隧道到本地 VPN 代理端口，关闭即直连。
//      内置 fetch 按请求读取全局 dispatcher 符号，且默认 dispatcher 只在首次
//      请求时懒初始化——因此包装器永远挂在符号上自行委托，绝不置 undefined。
//   2. 在 webServer（GUI 同源）注册控制路由：
//        GET  /vpn            状态 JSON
//        GET  /vpn/ui         浏览器独立开关页
//        POST /vpn/on|off|toggle
//        POST /vpn/proxy      body {"proxy":"http://127.0.0.1:7897",
//                              "mode":"all|allowlist","allowProxy":"a.com,.b.com",
//                              "noProxy":"localhost,127.0.0.1,::1"}
//      POST 路由带同源（CSRF）校验；响应不带 CORS 头（全同源设计，
//      跨域读取状态属于隐私泄露）。回退独立端点仅限回环访问。
//   3. 经 tapIndex 向 Web GUI 注入右下角悬浮开关按钮（同源 fetch，无需 CORS）。
//   4. 全局热键（默认关闭，可在设置卡片启用）切换，并用系统通知反馈。
//   5. 设置卡片（设置 → 插件配置）：代理地址 / noProxy / 热键 / 悬浮按钮 / agent 指引。
//   6. systemPrompt 指引，让 agent 会话能替用户切换。
//
// 每一步失败都只记录日志，绝不阻断 DSH 启动。
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import z from 'schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { normalizeProxyServer, shouldProxy, isValidProxyUrl, proxyFromScutilOutput } from './pure.js';

const require = createRequire(import.meta.url);

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_PATH = join(HOME, 'vpn-proxy.json');
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
const DEFAULT_HOTKEY = ''; // 留空 = 默认不启用全局热键
const TAG = '[vpn-toggle]';

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
	toggleTitle: 'DSH VPN 开关',
	enabled: (proxy, suffix) => `已启用 → ${proxy}${suffix}`,
	disabled: (suffix) => `已关闭（直连）${suffix}`,
	switchedTo: (url) => `已自动切换 → ${url}`,
	scanNoSystem: (url) => `未探测到系统代理，端口扫描命中 ${url}`,
	scanHit: (url) => `已自动切换 → ${url}（端口扫描）`,
	proxyUnreachable: '代理端口无响应',
	lost: '代理失联，请求可能失败',
	recovered: '代理恢复',
	hintUnreachable: '代理端口无响应，检查 VPN 客户端是否在运行',
	hintNoExit: '两个出口端点都不可达（网络不通或端点被墙）'
} : {
	toggleTitle: 'DSH VPN Toggle',
	enabled: (proxy, suffix) => `Enabled → ${proxy}${suffix}`,
	disabled: (suffix) => `Off (direct)${suffix}`,
	switchedTo: (url) => `Auto-switched → ${url}`,
	scanNoSystem: (url) => `No system proxy found; port scan hit ${url}`,
	scanHit: (url) => `Auto-switched → ${url} (port scan)`,
	proxyUnreachable: 'Proxy port not responding',
	lost: 'Proxy lost - requests may fail',
	recovered: 'Proxy recovered',
	hintUnreachable: 'Proxy port not responding - check that the VPN client is running',
	hintNoExit: 'Neither exit endpoint is reachable (no network or the endpoint is blocked)'
};

// ---------------------------------------------------------------- state ----
function defaultState() {
	return { enabled: false, mode: 'all', proxy: '', noProxy: DEFAULT_NO_PROXY, allowProxy: '', note: '' };
}

function readState() {
	try {
		const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
		if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') {
			return {
				enabled: !!raw.enabled,
				// Old state files have no mode/allowProxy: treated as all mode, backward compatible
				mode: raw.mode === 'allowlist' || raw.mode === 'all' ? raw.mode : 'all',
				proxy: typeof raw.proxy === 'string' ? raw.proxy : '',
				noProxy: typeof raw.noProxy === 'string' && raw.noProxy.length > 0 ? raw.noProxy : DEFAULT_NO_PROXY,
				allowProxy: typeof raw.allowProxy === 'string' ? raw.allowProxy : '',
				// transient provenance of the last enable (auto-switch record)
				note: typeof raw.note === 'string' ? raw.note : ''
			};
		}
	} catch {}
	return defaultState();
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
// True when the user configured an explicit proxy address in the settings
// card (manual mode): the enable path then never overwrites it, dead or not.
// Empty settings = auto mode — the address is plugin-managed and may be
// re-detected / port-scanned freely.
let currentProxyConfigured = false;
function state() {
	const now = Date.now();
	if (cached === null || now - cachedAt > TTL_MS) {
		cached = readState();
		cachedAt = now;
	}
	return cached;
}

function updateState(mutate) {
	const st = readState();
	mutate(st);
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
	} catch {}
	writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + '\n', 'utf8');
	cached = st;
	cachedAt = Date.now();
	return st;
}

// ------------------------------------------------------------ dispatcher ----
let dispatcherReady = false;

async function installDispatcher() {
	if (dispatcherReady) return;
	try {
		const undici = await import('undici');
		const { Agent, ProxyAgent } = undici.default ?? undici;
		const S2 = Symbol.for('undici.globalDispatcher.2');
		const S1 = Symbol.for('undici.globalDispatcher.1');
		const original = globalThis[S2] ?? globalThis[S1];
		let fallbackDirect = null;
		let proxied = null;
		let proxiedKey = '';
		const getDirect = () => {
			if (original !== undefined) return original;
			if (fallbackDirect === null) fallbackDirect = new Agent({ connect: { timeout: 15000 } });
			return fallbackDirect;
		};
		const getProxied = (st) => {
			const key = st.proxy;
			if (proxied !== null && key === proxiedKey) return proxied;
			try {
				if (proxied !== null && typeof proxied.close === 'function') proxied.close();
			} catch {}
			// Raw ProxyAgent: one tested path for http(s):// and socks5:// proxies
			// (EnvHttpProxyAgent's socks5 https route resets in the field).
			// A stored garbage URI must never break the dispatch pipeline: fall
			// back to direct for this and later requests until it is fixed.
			try {
				proxied = new ProxyAgent({ uri: st.proxy });
			} catch (cause) {
				logErr('ProxyAgent build failed for', st.proxy, cause && cause.message || cause);
				proxied = null;
				proxiedKey = '';
				return getDirect();
			}
			proxiedKey = key;
			return proxied;
		};
		const wrapper = {
			dispatch(opts, handler, ...rest) {
				const st = state();
				// Single decision point (pure.js): noProxy always wins; in
				// allowlist mode only allowProxy hosts are tunneled.
				if (shouldProxy(st, opts)) {
					return getProxied(st).dispatch(opts, handler, ...rest);
				}
				return getDirect().dispatch(opts, handler, ...rest);
			}
		};
		globalThis[S2] = wrapper;
		globalThis[S1] = wrapper;
		dispatcherReady = true;
		const st = state();
		log(`dispatcher installed; enabled=${st.enabled} proxy=${st.proxy || '(unset)'}`);
	} catch (cause) {
		logErr('dispatcher install FAILED — routing stays direct', cause && cause.stack || cause);
	}
}

// ---------------------------------------------------------------- fence ----
function isLoopbackRequest(req) {
	const remote = String((req.socket && req.socket.remoteAddress) || '');
	return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === 'localhost';
}

/**
 * Host allowlist for the fence: an Origin that merely echoes an attacker
 * -chosen Host header must not pass — DNS rebinding (evil.com -> 127.0.0.1)
 * produces exactly that shape, origin === 'http://' + host. Accept loopback
 * names, any IP literal (the GUI may legitimately be exposed on the LAN) and
 * single-label LAN names; reject multi-label public domains, the rebinding
 * vector.
 */
function hostIsLocalish(hostHeader) {
	const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	if (host === '') return false;
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (!host.includes('.')) return true; // single-label LAN hostname
	return net.isIP(host) !== 0; // any IP literal
}

/**
 * CSRF fence for state-changing routes: non-browser clients (curl, the agent
 * shell) send no Origin and stay allowed; a browser always sends Origin on
 * cross-site POST, so a mismatched Origin — or an explicit cross-site
 * Sec-Fetch-Site — is rejected. The echoed Host must also look local
 * (see hostIsLocalish) or the request is treated as rebinding.
 */
function sameOriginOk(req) {
	const origin = req.headers.origin;
	if (origin !== undefined && origin !== '') {
		const host = req.headers.host;
		if (host === undefined) return false;
		if (origin !== 'http://' + host && origin !== 'https://' + host) return false;
		if (!hostIsLocalish(host)) return false;
	}
	if (req.headers['sec-fetch-site'] === 'cross-site') return false;
	return true;
}

// ---------------------------------------------------- system proxy detect ----
let proxyDetectCache = { at: 0, value: null };
/** Windows registry auto-detect; '' when unset or off-platform. Cached 30s
 *  unless `fresh` (used by the enable-path recovery, which must see a just
 *  changed system proxy instead of a stale cached value). */
function detectSystemProxy(fresh) {
	const now = Date.now();
	if (!fresh && proxyDetectCache.value !== null && now - proxyDetectCache.at < 30000) return proxyDetectCache.value;
	let value = '';
	try {
		const runCmd = (cmd, args) => String(execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
		if (process.platform === 'win32') {
			value = detectWindowsProxy(runCmd);
		} else if (process.platform === 'darwin') {
			value = proxyFromScutilOutput(runCmd('scutil', ['--proxy']));
		} else if (process.platform === 'linux') {
			value = detectGnomeProxy(runCmd);
		}
		if (value === '') {
			// Environment fallback on every platform: DSH's fetch ignores these
			// variables, but their presence is a strong "the user wants a proxy
			// here" signal (the standard on headless Linux especially).
			const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
			if (env.trim() !== '') value = normalizeProxyServer(env.trim());
		}
	} catch {}
	proxyDetectCache = { at: now, value };
	return value;
}

/** HKCU WinINET settings: ProxyEnable gate + ProxyServer value. */
function detectWindowsProxy(runCmd) {
	const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
	const query = (name) => runCmd('reg', ['query', key, '/v', name]);
	if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(query('ProxyEnable'))) {
		const match = query('ProxyServer').match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
		if (match) return normalizeProxyServer(match[1]);
	}
	return '';
}

/** GNOME/gsettings (the common Linux desktop path): manual mode with
 *  per-scheme host/port pairs; HTTPS preferred, then HTTP, then SOCKS. */
function detectGnomeProxy(runCmd) {
	let mode = '';
	try {
		mode = runCmd('gsettings', ['get', 'org.gnome.system.proxy', 'mode']).trim().replace(/^'|'$/g, '');
	} catch {
		return ''; // no gsettings (server / non-GNOME) -> port scan takes over
	}
	if (mode !== 'manual') return '';
	const pick = (kind, scheme) => {
		try {
			const host = runCmd('gsettings', ['get', 'org.gnome.system.proxy.' + kind, 'host']).trim().replace(/^'|'$/g, '');
			const port = Number(runCmd('gsettings', ['get', 'org.gnome.system.proxy.' + kind, 'port']).trim());
			if (host && port > 0) return scheme + host + ':' + port;
		} catch {}
		return '';
	};
	return pick('https', 'http://') || pick('http', 'http://') || pick('socks', 'socks5://');
}

/** Flip-on guard: with no configured proxy, try system auto-detect once. */
function ensureProxyForEnable() {
	const cur = readState();
	if (cur.proxy !== '') return true;
	const detected = detectSystemProxy();
	if (detected === '') return false;
	updateState((s) => {
		s.proxy = detected;
	});
	return true;
}

// ------------------------------------------------------------ reachability ----
/**
 * Single TCP connect to the proxy port. http(s):// and socks5:// proxies are
 * both TCP-forwarding endpoints, so a successful connect means the VPN client
 * is listening — pure reachability, no protocol handshake. Resolves false on
 * timeout / parse failure / connect error.
 */
function probeProxyAlive(proxyUrl, timeoutMs = 800) {
	return new Promise((resolve) => {
		let url;
		try {
			url = new URL(String(proxyUrl || ''));
		} catch {
			resolve(false);
			return;
		}
		const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
		if (!url.hostname || !port) {
			resolve(false);
			return;
		}
		const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port });
		const done = (ok) => {
			try {
				socket.destroy();
			} catch {}
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/** Ports commonly used by local proxy clients (Clash 7890/7897, v2rayN
 *  10808/10809, generic socks 1080, Privoxy 8118, Shadowsocks 2080). */
const COMMON_PROXY_PORTS = [7897, 7890, 10809, 10808, 2080, 1080, 8118];

/** Last-resort detect: TCP-probe the common local proxy ports (loopback only,
 *  in parallel) and return the first alive one in priority order, as an
 *  http:// URL. '' when none answers. Protocol is unknowable from a TCP
 *  connect — the http:// guess covers mixed-port clients; anything else
 *  surfaces via /vpn/test and manual correction. */
async function scanCommonProxyPorts(excludeUrls) {
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
	const alive = await Promise.all(candidates.map(async (p) => ((await probeProxyAlive(`http://127.0.0.1:${p}`, 400)) ? p : 0)));
	for (const p of COMMON_PROXY_PORTS) {
		if (alive.includes(p)) return `http://127.0.0.1:${p}`;
	}
	return '';
}

/**
 * Enable-side proxy resolution (route + hotkey paths). Never blocks on an
 * unusual setup, but tries hard to land on a live port:
 *  1. empty proxy -> system auto-detect; none -> common-port scan -> else error
 *  2. current proxy alive -> done
 *  3. current dead -> FRESH system re-detect (bypasses the 30s cache — the
 *     VPN client may have just moved ports); different & alive -> adopt it
 *  4. still nothing -> common-port scan -> adopt
 *  5. all dead -> keep the configured value with a warning
 */
async function resolveProxyForEnable() {
	let st = readState();
	if (!st.proxy) {
		if (!ensureProxyForEnable()) {
			const scanned = await scanCommonProxyPorts([]);
			if (!scanned) return { error: true };
			updateState((s) => {
				s.proxy = scanned;
				s.note = HOST.scanNoSystem(scanned);
			});
			return { switchedTo: scanned, note: HOST.scanNoSystem(scanned) };
		}
		st = readState();
	}
	if (!st.proxy || (await probeProxyAlive(st.proxy))) return {};
	// Dead port: auto-recover ONLY in auto mode (settings address empty, the
	// value itself is plugin-managed). A manually typed address is respected —
	// dead or not; overriding user intent silently would be worse than a
	// failed request the notification explains.
	if (currentProxyConfigured) return { warning: HOST.proxyUnreachable };
	const detected = detectSystemProxy(true);
	if (detected && detected !== st.proxy && (await probeProxyAlive(detected))) {
		updateState((s) => {
			s.proxy = detected;
			s.note = HOST.switchedTo(detected);
		});
		return { switchedTo: detected, note: HOST.switchedTo(detected) };
	}
	const scanned = await scanCommonProxyPorts(detected ? [st.proxy, detected] : [st.proxy]);
	if (scanned) {
		updateState((s) => {
			s.proxy = scanned;
			s.note = HOST.scanHit(scanned);
		});
		return { switchedTo: scanned, note: HOST.scanHit(scanned) };
	}
	return { warning: HOST.proxyUnreachable };
}

// ---------------------------------------------------------------- routes ----
function writeJson(res, code, body) {
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function statusSummary() {
	const st = state();
	return {
		enabled: st.enabled,
		mode: st.mode,
		proxy: st.proxy,
		noProxy: st.noProxy,
		allowProxy: st.allowProxy,
		hotkey: currentHotkey,
		hotkeyRegistered: hotkeyState.registered,
		pill: currentShowPill,
		note: st.note,
		file: STATE_PATH
	};
}

function notifyState(st, note) {
	try {
		const electron = require('electron');
		const { Notification } = electron.default ?? electron;
		if (Notification.isSupported && !Notification.isSupported()) return;
		const suffix = note ? `（${note}）` : '';
		new Notification({
			title: HOST.toggleTitle,
			body: st.enabled ? HOST.enabled(st.proxy, suffix) : HOST.disabled(suffix),
			silent: true
		}).show();
	} catch {}
}

async function handleToggleRequest(req, path, res) {
	if (!sameOriginOk(req)) {
		writeJson(res, 403, { error: 'cross-origin state change rejected' });
		return;
	}
	const want = path === '/vpn/on' ? true : path === '/vpn/off' ? false : null;
	const cur = readState();
	const nextEnabled = want === null ? !cur.enabled : want;
	let warning = '';
	let note = '';
	if (nextEnabled) {
		const resolution = await resolveProxyForEnable();
		if (resolution.error) {
			writeJson(res, 400, { error: 'proxy address is empty and system auto-detect found none; POST /vpn/proxy first or set it in the settings card', state: statusSummary() });
			return;
		}
		warning = resolution.warning || '';
		note = resolution.note || '';
	}
	const st = updateState((s) => {
		s.enabled = nextEnabled;
		s.note = note;
	});
	notifyState(st, note || warning);
	log(`toggle via ${path} -> ${st.enabled ? `ON ${st.proxy}` : 'OFF'}${note ? ` (${note})` : warning ? ` (${warning})` : ''}`);
	if (warning || note) {
		writeJson(res, 200, { ...statusSummary(), ...(warning ? { warning } : {}), ...(note ? { note } : {}) });
	} else {
		writeJson(res, 200, statusSummary());
	}
}

/**
 * POST /vpn/test: report real connectivity through the exact path the
 * dispatcher wrapper would take for the probe target (global fetch routes
 * through the wrapper; shouldProxy predicts the same decision).
 */
async function handleTestRequest(res) {
	const st = state();
	const via = shouldProxy(st, { origin: 'https://api.ipify.org/?format=json' }) ? 'proxy' : 'direct';
	if (st.enabled && st.proxy && !(await probeProxyAlive(st.proxy))) {
		writeJson(res, 200, { ok: false, stage: 'proxy-unreachable', proxy: st.proxy, mode: st.mode, hint: HOST.hintUnreachable });
		return;
	}
	const started = Date.now();
	let exitIp = '';
	try {
		const r = await fetch('https://api.ipify.org/?format=json', { signal: AbortSignal.timeout(6000) });
		if (r.ok) exitIp = String(((await r.json()) || {}).ip || '');
	} catch {}
	if (exitIp === '') {
		try {
			const r = await fetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(6000) });
			if (r.ok) exitIp = String(await r.text()).trim();
		} catch {}
	}
	if (exitIp === '') {
		writeJson(res, 200, { ok: false, stage: 'exit-probe-failed', via, proxy: st.proxy, mode: st.mode, hint: HOST.hintNoExit });
		return;
	}
	writeJson(res, 200, { ok: true, exitIp, latencyMs: Date.now() - started, via, proxy: st.proxy, mode: st.mode });
}

function standalonePage(req) {
	// The standalone page is served per request: pick the language from the
	// browser's Accept-Language header (no DSH internals involved).
	const zh = String((req && req.headers && req.headers['accept-language']) || '').toLowerCase().includes('zh');
	const T = zh ? {
		title: 'DSH VPN 开关', h1: 'DeepSeek Harness · VPN 路由开关', loading: '加载中…',
		on: 'VPN 开', off: 'VPN 关', testBtn: '测试连通性', testing: '测试中…',
		proxyLabel: 'proxy: ', fileLabel: '状态文件: ', prefixOn: '经 ', prefixOff: '直连 · ', unset: '未设置',
		testOk: (ip, ms, via) => `出口 ${ip} · ${ms}ms · ${via}`, viaProxy: '经代理', viaDirect: '直连',
		testBad: (m) => `测试未通过：${m}`, testErr: (e) => `测试失败：${e}`,
		footer: '每次请求即时生效 · 热键可在设置卡片启用'
	} : {
		title: 'DSH VPN Toggle', h1: 'DeepSeek Harness · VPN Routing Toggle', loading: 'Loading…',
		on: 'VPN ON', off: 'VPN OFF', testBtn: 'Test connectivity', testing: 'Testing…',
		proxyLabel: 'proxy: ', fileLabel: 'state file: ', prefixOn: 'via ', prefixOff: 'direct · ', unset: 'not set',
		testOk: (ip, ms, via) => `Exit ${ip} · ${ms}ms · ${via}`, viaProxy: 'via proxy', viaDirect: 'direct',
		testBad: (m) => `Test did not pass: ${m}`, testErr: (e) => `Test error: ${e}`,
		footer: 'Effective on the next request · enable the hotkey in the settings card'
	};
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
</style></head><body><div class="card">
<h1>${T.h1}</h1>
<button id="sw" onclick="flip()">…</button>
<p id="info">${T.loading}</p>
<button id="t" onclick="testConn()">${T.testBtn}</button>
<p id="tres"></p>
<p>${T.footer}</p>
</div><script>
const T=${JSON.stringify(T)};
async function load(){const r=await fetch('/vpn');const s=await r.json();
 const b=document.getElementById('sw');b.className=s.enabled?'on':'off';
 b.textContent=s.enabled?T.on:T.off;
 document.getElementById('info').textContent=(s.enabled?T.prefixOn:T.prefixOff)+'${T.proxyLabel}'+(s.proxy||T.unset)+' | ${T.fileLabel}'+s.file;}
async function flip(){await fetch('/vpn/toggle',{method:'POST'});load();}
async function testConn(){const t=document.getElementById('t'),o=document.getElementById('tres');t.disabled=true;o.textContent=T.testing;
 try{const r=await fetch('/vpn/test',{method:'POST'});const d=await r.json();
  o.textContent=d.ok?T.testOk(d.exitIp,d.latencyMs,d.via==='proxy'?T.viaProxy:T.viaDirect):T.testBad(d.hint||d.stage||'');}catch(e){o.textContent=T.testErr(e);}
 t.disabled=false;}
load();setInterval(load,5000);
</script></body></html>`;
}

function makeRoutes() {
	const routes = [
		{
			kind: 'exact',
			path: '/vpn',
			handler: (req, res) => {
				if (req.method === 'OPTIONS') {
					res.writeHead(204);
					res.end();
					return;
				}
				writeJson(res, 200, statusSummary());
			}
		},
		{
			kind: 'exact',
			path: '/vpn/ui',
			handler: (req, res) => {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end(standalonePage(req));
			}
		},
		{
			kind: 'exact',
			path: '/vpn/on',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				handleToggleRequest(req, '/vpn/on', res);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/off',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				handleToggleRequest(req, '/vpn/off', res);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/toggle',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				handleToggleRequest(req, '/vpn/toggle', res);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/test',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				if (!sameOriginOk(req)) {
					writeJson(res, 403, { error: 'cross-origin state change rejected' });
					return;
				}
				handleTestRequest(res);
			}
		},
		{
			kind: 'exact',
			path: '/vpn/proxy',
			handler: (req, res) => {
				if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' });
				if (!sameOriginOk(req)) {
					writeJson(res, 403, { error: 'cross-origin state change rejected' });
					return;
				}
				let body = '';
				req.on('data', (c) => {
					body += c;
					if (body.length > 65536) req.destroy();
				});
				req.on('end', () => {
					try {
						const patch = JSON.parse(body || '{}');
						const candidate = typeof patch.proxy === 'string' ? patch.proxy.trim() : undefined;
						// Reject unsupported schemes at write time so a garbage URI
						// can never reach ProxyAgent (empty string = auto mode).
						if (candidate !== undefined && candidate !== '' && !isValidProxyUrl(candidate)) {
							writeJson(res, 400, { error: 'proxy must be an http(s):// or socks5:// URL' });
							return;
						}
						updateState((s) => {
							if (candidate !== undefined) s.proxy = candidate;
							if (typeof patch.noProxy === 'string' && patch.noProxy.length > 0) s.noProxy = patch.noProxy.trim();
							// mode is validated before writing; unknown values are ignored
							if (patch.mode === 'all' || patch.mode === 'allowlist') s.mode = patch.mode;
							if (typeof patch.allowProxy === 'string') s.allowProxy = patch.allowProxy.trim();
						});
						writeJson(res, 200, statusSummary());
					} catch (cause) {
						writeJson(res, 400, { error: String(cause) });
					}
				});
			}
		}
	];
	return routes;
}

// Fallback endpoint when webServer is unavailable: same routes on a private
// loopback port (43199+), reported via ~/.dsh/vpn-proxy.port.
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
				const route = makeRoutes().find((r) => r.path === path);
				if (route) return route.handler(req, res);
				writeJson(res, 404, { error: 'unknown route' });
			} catch (cause) {
				logErr('standalone endpoint error', cause);
				try {
					res.writeHead(500);
					res.end();
				} catch {}
			}
		});
		// listen() never throws synchronously on EADDRINUSE — the error arrives
		// as an async 'error' event. Retry sequentially from that event, and keep
		// a listener attached at all times so a busy port can never surface as an
		// unhandled 'error' (which would crash the main process).
		let disposed = false;
		const ports = [43199, 43200, 43201, 43202, 43203, 43204, 43205, 43206];
		let attempt = 0;
		const tryListen = () => {
			if (disposed || attempt >= ports.length) {
				if (!disposed) logErr('standalone endpoint: no free port in 43199..43206');
				return;
			}
			const port = ports[attempt];
			attempt += 1;
			server.once('error', (cause) => {
				if (disposed) return;
				if (cause && cause.code === 'EADDRINUSE') tryListen();
				else logErr('standalone endpoint listen error', cause);
			});
			server.listen(port, '127.0.0.1', () => {
				// Successful bind retires the retry listener; runtime errors past
				// this point must log, never crash.
				server.removeAllListeners('error');
				server.on('error', (cause) => logErr('standalone endpoint error', cause));
				try {
					writeFileSync(join(HOME, 'vpn-proxy.port'), String(port), 'utf8');
				} catch {}
				log(`standalone endpoint: http://127.0.0.1:${port}/vpn`);
			});
		};
		tryListen();
		return () => {
			disposed = true;
			try {
				server.close();
			} catch {}
		};
	} catch (cause) {
		logErr('standalone endpoint failed', cause);
	}
	return undefined;
}

// ------------------------------------------------------------------ pill ----
function injectedButtonSource() {
	return `(function(){if(window.__dshVpnBtn)return;window.__dshVpnBtn=true;
var ZH=(navigator.language||'').toLowerCase().indexOf('zh')===0;
var pill=document.createElement('button');
pill.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:8px 14px;border-radius:999px;border:none;cursor:pointer;font:600 13px/1.4 system-ui,sans-serif;color:#fff;background:#4b5563;box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:.88;transition:opacity .15s,background .15s';
pill.onmouseenter=function(){pill.style.opacity='1'};pill.onmouseleave=function(){pill.style.opacity='.88'};
var hidden=false;
function mount(){if(!pill.isConnected)(document.body||document.documentElement).appendChild(pill)}
function paint(text,bg,title){pill.textContent=text;pill.style.background=bg;pill.title=title}
function paintState(s){if(s&&s.pill===false){hidden=true;if(pill.isConnected)pill.remove();return}
if(s&&s.pill===true)hidden=false;if(hidden)return;if(s)mount();
if(s&&s.enabled)paint('VPN \\u25CF','#2f9e44',(ZH?'DSH 正走 VPN: ':'DSH using VPN: ')+s.proxy+'\\n'+(ZH?'点击关闭':'Click to turn off'));else if(s)paint('VPN \\u25CB','#4b5563',(ZH?'DSH 直连\\n点击开启 VPN (':'Direct\\nClick to enable VPN (')+(s.proxy||(ZH?'未设置':'not set'))+')');else paint('VPN \\u00D7','#6b7280',ZH?'vpn-toggle 端点不可达（插件未加载？）':'vpn-toggle endpoint unreachable (plugin not loaded?)')}
async function refresh(){try{const r=await fetch('/vpn',{signal:AbortSignal.timeout(2500)});paintState(await r.json())}catch(e){paintState(null)}}
pill.addEventListener('click',async function(){try{await fetch('/vpn/toggle',{method:'POST',signal:AbortSignal.timeout(3000)})}catch(e){}refresh();setTimeout(refresh,500)});
refresh();setInterval(refresh,5000);})();`;
}

function injectPill(html) {
	const tag = `<script>${injectedButtonSource()}</script>`;
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
	'本机已安装 dsh-vpn-toggle 插件（DSH VPN 快捷开关）：DSH 主进程的模型 API / Files API / web 抓取等全局 fetch 流量可在「直连」与「本地 VPN 代理」之间按请求即时切换，无需重启。',
	'用户说「开VPN / 关VPN / 切换VPN」时：向本 Web GUI 同源端点 POST /vpn/on|/vpn/off|/vpn/toggle（例如 Invoke-RestMethod -Method Post http://127.0.0.1:<GUI端口>/vpn/toggle），GET /vpn 查看状态并原样汇报；状态持久化在 ~/.dsh/vpn-proxy.json（enabled/mode/proxy/noProxy/allowProxy/note），也可直接改它，1.2 秒内被下一个请求读取。',
	'界面右下角有 VPN 悬浮按钮，用户侧有系统通知；全局热键默认关闭，用户可在设置卡片自定义（如 Control+Alt+V）。回环地址始终绕过代理，开启不影响本机访问。',
	'若开启后模型请求失败：先 POST /vpn/off 恢复直连，再检查 VPN 客户端与代理端口；换端口用 POST /vpn/proxy（body {"proxy":"http://127.0.0.1:端口"}，支持 http(s):// 与 socks5://）或设置卡片；代理留空时自动探测系统代理。',
	'开启时若配置的代理端口无响应：仅在「自动模式」（设置卡片代理地址留空）下自动自救——重探系统代理（绕过缓存），仍不行再扫常见本地端口（7897/7890/10809/10808/2080/1080/8118），命中即自动切换并在通知、响应 note 字段与状态文件注明（如「已自动切换 → http://127.0.0.1:7890」）；手动填写的地址永不覆盖，只带「代理端口无响应」警告开启。',
	'分流模式（POST /vpn/proxy 的 body 可带 {"mode":"all|allowlist","allowProxy":"a.com,.b.com"}）：all = 全部流量走 VPN；allowlist = 仅命中 allowProxy 列表的主机走 VPN（如「模型 API 直连 + web 抓取走 VPN」场景，可设 allowProxy 为抓取目标域名）。noProxy 优先级最高：命中绕过列表的目标即使命中 allowProxy 也直连。GET /vpn 返回的 mode/allowProxy 可原样汇报。'
].join('') : [
	'The dsh-vpn-toggle plugin is installed (DSH VPN quick toggle): the DSH main process global fetch traffic (model API / Files API / web scraping) can be switched between "direct" and "local VPN proxy" per request, no restart needed.',
	'When the user asks to turn the VPN on/off/toggle: POST /vpn/on|/vpn/off|/vpn/toggle on the Web GUI origin (e.g. Invoke-RestMethod -Method Post http://127.0.0.1:<GUIport>/vpn/toggle), check GET /vpn and report it verbatim; state persists in ~/.dsh/vpn-proxy.json (enabled/mode/proxy/noProxy/allowProxy/note) and may also be edited directly - the next request reads it within 1.2 seconds.',
	'A VPN pill sits in the bottom-right corner of the GUI and the user gets system notifications; the global hotkey is off by default and can be set in the settings card (e.g. Control+Alt+V). Loopback addresses always bypass the proxy.',
	'If model requests fail after enabling: POST /vpn/off first to restore direct access, then check the VPN client and proxy port; change the port via POST /vpn/proxy (body {"proxy":"http://127.0.0.1:port"} - http(s):// and socks5:// are supported) or the settings card; with an empty address the system proxy is auto-detected.',
	'When the configured proxy port does not respond on enable: self-healing runs ONLY in auto mode (proxy address left empty in the settings card) - re-detect the system proxy (cache bypassed), then scan common local ports (7897/7890/10809/10808/2080/1080/8118); on a hit it switches automatically and records that in the notification, the note field and the state file. A manually entered address is never overridden - it only enables with a "proxy port not responding" warning.',
	'Routing modes (POST /vpn/proxy body accepts {"mode":"all|allowlist","allowProxy":"a.com,.b.com"}): all = all traffic via VPN; allowlist = only hosts matching the allowProxy list go through VPN (e.g. model API direct + web scraping via VPN). noProxy has the highest priority: a bypass hit stays direct even when it also matches allowProxy. GET /vpn returns mode/allowProxy to report verbatim.'
].join('');

// -------------------------------------------------------------- plugin ------
const name = 'vpn-toggle';
const inject = ['webServer', 'systemPrompt'];
const VPN_SETTINGS_NAMESPACE = settingsNamespace('vpn-toggle');

const Config = z.object({
	proxy: z.string().default('').description('VPN 本地代理地址（http(s):// 或 socks5://）；留空则自动探测系统代理'),
	noProxy: z.string().default(DEFAULT_NO_PROXY).description('绕过代理的地址列表（逗号分隔）；优先级最高，命中即直连'),
	mode: z.string().default('all').description('分流模式：all = 全部流量走 VPN；allowlist = 仅命中 allowProxy 列表的主机走 VPN'),
	allowProxy: z.string().default('').description('代理 allowlist（逗号分隔，支持 .example.com 后缀形式）；仅 allowlist 模式生效，留空则全部直连'),
	hotkey: z.string().default(DEFAULT_HOTKEY).description('全局切换热键（Electron accelerator，如 Control+Alt+V）；留空则不启用'),
	showPill: z.boolean().default(true).description('在 Web GUI 右下角显示悬浮开关'),
	announceToAgent: z.boolean().default(true).description('向 agent 注入使用指引')
});

/** Single-instance guard for the same package mounted from several sources. */
const MOUNTED = Symbol.for('dsh-vpn-toggle.mounted');
function mountOnce(packageName, fn) {
	return (...args) => {
		const registry = globalThis;
		const mounted = registry[MOUNTED] ??= new Set();
		if (mounted.has(packageName)) return;
		mounted.add(packageName);
		args[0]?.effect?.(() => () => {
			mounted.delete(packageName);
		});
		return fn(...args);
	};
}

const apply = mountOnce('dsh-vpn-toggle', (ctx, config) => {
	let current = () => config ?? {};
	let disposeHotkey;
	let disposePill;
	let disposeSection;
	let disposeStandalone;

	const requestToggle = async () => {
		const cur = readState();
		const next = !cur.enabled;
		let note = '';
		if (next) {
			const resolution = await resolveProxyForEnable();
			if (resolution.error) {
				log('hotkey: cannot enable, no proxy configured and auto-detect/port-scan found none');
				notifyState({ enabled: false });
				return;
			}
			note = resolution.note || resolution.warning || '';
		}
		const st = updateState((s) => {
			s.enabled = next;
			s.note = note;
		});
		notifyState(st, note);
		log(`hotkey toggle -> ${st.enabled ? `ON ${st.proxy}` : 'OFF'}${note ? ` (${note})` : ''}`);
	};

	const sync = () => {
		const value = current();
		currentHotkey = value.hotkey ?? DEFAULT_HOTKEY;
		currentShowPill = (value.showPill ?? true) !== false;
		const configured = typeof value.proxy === 'string' ? value.proxy.trim() : '';
		const configuredValid = configured !== '' && isValidProxyUrl(configured);
		// A filled address only counts as manual mode when it is a usable URL;
		// garbage input is ignored (state keeps its current value) with a log.
		currentProxyConfigured = configuredValid;
		if (configured !== '' && !configuredValid) logErr('settings proxy is not a valid http(s)/socks5 URL, ignoring:', configured);
		// settings -> state file（保留 enabled；代理留空 = 自动探测系统代理，
		// 探测不到时保留现状，不覆盖手动设置过的值）
		updateState((s) => {
			if (configuredValid) s.proxy = configured;
			else if (configured === '') {
				const detected = detectSystemProxy();
				if (detected !== '') s.proxy = detected;
			}
			if (typeof value.noProxy === 'string' && value.noProxy.length > 0) s.noProxy = value.noProxy;
			if (value.mode === 'all' || value.mode === 'allowlist') s.mode = value.mode;
			if (typeof value.allowProxy === 'string') s.allowProxy = value.allowProxy.trim();
		});
		// hotkey
		if (disposeHotkey !== undefined) {
			disposeHotkey();
			disposeHotkey = undefined;
		}
		disposeHotkey = ctx.effect(() => armHotkey(value.hotkey ?? DEFAULT_HOTKEY, requestToggle), 'vpn-toggle: hotkey');
		// pill —— always inject; the script's visibility is controlled live
		// by statusSummary.pill. Conditional injection would leave pages that
		// were opened while showPill=off with no poller at all, so turning it
		// back on could never take effect without a reload.
		if (disposePill !== undefined) {
			disposePill();
			disposePill = undefined;
		}
		try {
			disposePill = ctx.effect(() => ctx.webServer.tapIndex(injectPill), 'vpn-toggle: pill');
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
				name: 'plugin:dsh-vpn-toggle',
				order: 210,
				text: GUIDANCE
			});
		}
	};

	// dispatcher（一次安装，fiber 退出时还原符号）
	ctx.effect(() => {
		installDispatcher();
		return () => {
			try {
				const S2 = Symbol.for('undici.globalDispatcher.2');
				const S1 = Symbol.for('undici.globalDispatcher.1');
				// 还原交给进程退出处理；这里仅尽力清引用（不置 undefined，避免内置 fetch assert 崩溃）
				log('dispatcher disposer: leaving symbols as-is (safe)');
			} catch {}
		};
	}, 'vpn-toggle: dispatcher');

	// routes（webServer 同源；失败则回退独立回环端口）
	ctx.effect(() => {
		try {
			const disposers = makeRoutes().map((route) => ctx.webServer.register(route));
			log('control routes registered on webServer (/vpn*)');
			return () => {
				for (const dispose of disposers) dispose();
			};
		} catch (cause) {
			logErr('webServer routes failed, falling back to standalone endpoint', cause);
			disposeStandalone = startStandaloneEndpoint();
			return () => {
				if (disposeStandalone !== undefined) disposeStandalone();
			};
		}
	}, 'vpn-toggle: routes');

	// startup self-check + liveness watchdog. `enabled` persists in the state
	// file, so after a reboot the VPN client may be down or on another port:
	// the same resolution as a manual enable runs once shortly after mount,
	// with one late retry (the client may still be booting). While enabled, a
	// slow probe notifies on lost/regained connectivity — it NEVER falls back
	// to direct on its own, that would silently change where traffic goes.
	ctx.effect(() => {
		let lastAlive = null;
		const check = async (attempt) => {
			try {
				const st = readState();
				if (!st.enabled || !st.proxy) return;
				if (await probeProxyAlive(st.proxy)) {
					if (st.note) updateState((s) => {
						s.note = '';
					});
					return;
				}
				const resolution = await resolveProxyForEnable();
				const note = resolution.note || resolution.warning || '';
				if (note) {
					updateState((s) => {
						s.note = note;
					});
					notifyState(readState(), note);
					log(`self-check: ${note}`);
				}
				if (attempt === 0 && resolution.warning && !currentProxyConfigured) {
					setTimeout(() => check(1), 20000);
				}
			} catch (cause) {
				logErr('self-check failed', cause);
			}
		};
		const boot = setTimeout(() => check(0), 3000);
		const timer = setInterval(async () => {
			try {
				const st = readState();
				if (!st.enabled || !st.proxy) {
					lastAlive = null;
					return;
				}
				const alive = await probeProxyAlive(st.proxy);
				if (lastAlive === true && !alive) {
					updateState((s) => {
						s.note = HOST.lost;
					});
					notifyState(readState(), HOST.lost);
				} else if (lastAlive === false && alive) {
					updateState((s) => {
						s.note = HOST.recovered;
					});
					notifyState(readState(), HOST.recovered);
				}
				lastAlive = alive;
			} catch {}
		}, 30000);
		return () => {
			clearTimeout(boot);
			clearInterval(timer);
		};
	}, 'vpn-toggle: self-check');

	// state file
	try {
		if (!existsSync(STATE_PATH)) {
			mkdirSync(dirname(STATE_PATH), { recursive: true });
			writeFileSync(STATE_PATH, JSON.stringify(defaultState(), null, 2) + '\n', 'utf8');
		}
	} catch (cause) {
		logErr('state file init failed', cause);
	}

	try {
		installSettingsSection(ctx, VPN_SETTINGS_NAMESPACE, Config, config ?? {}, {
			setSource: (source) => {
				current = source;
				sync();
			},
			onChange: sync
		});
	} catch (cause) {
		logErr('settings section failed', cause);
	}

	sync();
});

export { apply, Config, inject, name };
