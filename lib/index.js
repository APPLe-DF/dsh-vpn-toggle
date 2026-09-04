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
//        POST /vpn/proxy      body {"proxy":"http://127.0.0.1:7897"}
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
import z from 'schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';

const require = createRequire(import.meta.url);

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_PATH = join(HOME, 'vpn-proxy.json');
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
const DEFAULT_HOTKEY = ''; // 留空 = 默认不启用全局热键
const TAG = '[vpn-toggle]';

const log = (...a) => { try { console.log(TAG, ...a); } catch {} };
const logErr = (...a) => { try { console.error(TAG, ...a); } catch {} };

// ---------------------------------------------------------------- state ----
function defaultState() {
	return { enabled: false, proxy: '', noProxy: DEFAULT_NO_PROXY };
}

function readState() {
	try {
		const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
		if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') {
			return {
				enabled: !!raw.enabled,
				proxy: typeof raw.proxy === 'string' ? raw.proxy : '',
				noProxy: typeof raw.noProxy === 'string' && raw.noProxy.length > 0 ? raw.noProxy : DEFAULT_NO_PROXY
			};
		}
	} catch {}
	return defaultState();
}

let cached = null;
let cachedAt = 0;
const TTL_MS = 1200;
let currentHotkey = DEFAULT_HOTKEY;
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
/**
 * Wrapper-level noProxy decision: the proxied agent is scheme-agnostic
 * (raw ProxyAgent), so bypass matching lives here — hostname exact match or
 * leading-dot suffix match against the comma list; '*' bypasses everything.
 */
function noProxyMatch(opts, noProxy) {
	try {
		const origin = opts && opts.origin;
		if (origin === undefined || origin === null) return false;
		const url = new URL(typeof origin === 'string' ? origin : origin.href || String(origin));
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
		for (const rawEntry of String(noProxy || '').split(',')) {
			let entry = rawEntry.trim().toLowerCase();
			if (entry === '') continue;
			if (entry === '*') return true;
			if (entry.startsWith('[')) entry = entry.slice(1, entry.includes(']') ? entry.indexOf(']') : undefined);
			else if ((entry.match(/:/g) || []).length === 1) entry = entry.slice(0, entry.indexOf(':'));
			if (entry.startsWith('.')) entry = entry.slice(1);
			if (entry === '') continue;
			if (host === entry || host.endsWith('.' + entry)) return true;
		}
	} catch {}
	return false;
}

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
			proxied = new ProxyAgent({ uri: st.proxy });
			proxiedKey = key;
			return proxied;
		};
		const wrapper = {
			dispatch(opts, handler, ...rest) {
				const st = state();
				if (st.enabled && st.proxy && !noProxyMatch(opts, st.noProxy)) {
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
 * CSRF fence for state-changing routes: non-browser clients (curl, the agent
 * shell) send no Origin and stay allowed; a browser always sends Origin on
 * cross-site POST, so a mismatched Origin — or an explicit cross-site
 * Sec-Fetch-Site — is rejected.
 */
function sameOriginOk(req) {
	const origin = req.headers.origin;
	if (origin !== undefined && origin !== '') {
		const host = req.headers.host;
		if (host === undefined) return false;
		if (origin !== 'http://' + host && origin !== 'https://' + host) return false;
	}
	if (req.headers['sec-fetch-site'] === 'cross-site') return false;
	return true;
}

// ---------------------------------------------------- system proxy detect ----
let proxyDetectCache = { at: 0, value: null };
/** Windows registry auto-detect; '' when unset or off-platform. Cached 30s. */
function detectSystemProxy() {
	const now = Date.now();
	if (proxyDetectCache.value !== null && now - proxyDetectCache.at < 30000) return proxyDetectCache.value;
	let value = '';
	try {
		if (process.platform === 'win32') {
			const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
			const query = (name) => String(execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
			if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(query('ProxyEnable'))) {
				const match = query('ProxyServer').match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
				if (match) value = normalizeProxyServer(match[1]);
			}
		}
	} catch {}
	proxyDetectCache = { at: now, value };
	return value;
}

/** Normalize a Windows ProxyServer value to a full proxy URL. */
function normalizeProxyServer(raw) {
	const s = String(raw || '').trim();
	if (s === '') return '';
	if (s.includes('=')) {
		const entries = {};
		for (const part of s.split(';')) {
			const at = part.indexOf('=');
			if (at === -1) continue;
			entries[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
		}
		const pick = entries.https || entries.http || entries.socks || '';
		if (pick === '') return '';
		const scheme = entries.socks !== undefined && entries.https === undefined && entries.http === undefined ? 'socks5://' : 'http://';
		return scheme + pick;
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
	return 'http://' + s;
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

// ---------------------------------------------------------------- routes ----
function writeJson(res, code, body) {
	res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function statusSummary() {
	const st = state();
	return {
		enabled: st.enabled,
		proxy: st.proxy,
		noProxy: st.noProxy,
		hotkey: currentHotkey,
		file: STATE_PATH
	};
}

function notifyState(st) {
	try {
		const electron = require('electron');
		const { Notification } = electron.default ?? electron;
		if (Notification.isSupported && !Notification.isSupported()) return;
		new Notification({
			title: 'DSH VPN 开关',
			body: st.enabled ? `已启用 → ${st.proxy}` : '已关闭（直连）',
			silent: true
		}).show();
	} catch {}
}

function handleToggleRequest(req, path, res) {
	if (!sameOriginOk(req)) {
		writeJson(res, 403, { error: 'cross-origin state change rejected' });
		return;
	}
	const want = path === '/vpn/on' ? true : path === '/vpn/off' ? false : null;
	const cur = readState();
	const nextEnabled = want === null ? !cur.enabled : want;
	if (nextEnabled && !cur.proxy) {
		if (!ensureProxyForEnable()) {
			writeJson(res, 400, { error: 'proxy address is empty and system auto-detect found none; POST /vpn/proxy first or set it in the settings card', state: statusSummary() });
			return;
		}
	}
	const st = updateState((s) => {
		s.enabled = nextEnabled;
	});
	notifyState(st);
	log(`toggle via ${path} -> ${st.enabled ? `ON ${st.proxy}` : 'OFF'}`);
	writeJson(res, 200, statusSummary());
}

function standalonePage() {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>DSH VPN 开关</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#111;color:#eee}
  .card{text-align:center;padding:40px 56px;border-radius:16px;background:#1b1b1f;box-shadow:0 8px 40px #0008}
  h1{font-size:18px;font-weight:500;margin:0 0 20px;color:#999}
  #sw{font-size:26px;padding:16px 46px;border-radius:12px;border:none;cursor:pointer;font-weight:600;color:#fff}
  .on{background:#2f9e44}.off{background:#5f6368}
  p{color:#888;font-size:13px;margin-top:18px;line-height:1.6}
</style></head><body><div class="card">
<h1>DeepSeek Harness · VPN 路由开关</h1>
<button id="sw" onclick="flip()">…</button>
<p id="info">加载中…</p><p>每次请求即时生效 · 热键可在设置卡片启用</p>
</div><script>
async function load(){const r=await fetch('/vpn');const s=await r.json();
 const b=document.getElementById('sw');b.className=s.enabled?'on':'off';
 b.textContent=s.enabled?'VPN 开':'VPN 关';
 document.getElementById('info').textContent=(s.enabled?'经 ':'直连 · ')+'proxy: '+(s.proxy||'(未设置)')+' | 状态文件: '+s.file;}
async function flip(){await fetch('/vpn/toggle',{method:'POST'});load();}
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
				res.end(standalonePage());
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
						updateState((s) => {
							if (typeof patch.proxy === 'string') s.proxy = patch.proxy.trim();
							if (typeof patch.noProxy === 'string' && patch.noProxy.length > 0) s.noProxy = patch.noProxy.trim();
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
var pill=document.createElement('button');
pill.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:8px 14px;border-radius:999px;border:none;cursor:pointer;font:600 13px/1.4 system-ui,sans-serif;color:#fff;background:#4b5563;box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:.88;transition:opacity .15s,background .15s';
pill.onmouseenter=function(){pill.style.opacity='1'};pill.onmouseleave=function(){pill.style.opacity='.88'};
function mount(){(document.body||document.documentElement).appendChild(pill)}
if(document.body)mount();else document.addEventListener('DOMContentLoaded',mount,{once:true});
function paint(text,bg,title){pill.textContent=text;pill.style.background=bg;pill.title=title}
function paintState(s){if(s&&s.enabled)paint('VPN \\u25CF','#2f9e44','DSH 正走 VPN: '+s.proxy+'\\n点击关闭');else if(s)paint('VPN \\u25CB','#4b5563','DSH 直连\\n点击开启 VPN ('+(s.proxy||'未设置')+')');else paint('VPN \\u00D7','#6b7280','vpn-toggle 端点不可达（插件未加载？）')}
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
	if (!hotkey || !hotkey.trim()) return () => {}; // 留空 = 不启用
	let disposed = false;
	try {
		const electron = require('electron');
		const { app, globalShortcut } = electron.default ?? electron;
		app.whenReady().then(() => {
			if (disposed) return;
			try {
				const ok = globalShortcut.register(hotkey, onToggle);
				log(`global hotkey ${hotkey} ${ok ? 'registered' : 'register FAILED (key taken?)'}`);
			} catch (cause) {
				logErr('hotkey register failed', cause);
			}
		});
	} catch (cause) {
		logErr('electron unavailable for hotkey', cause);
	}
	return () => {
		disposed = true;
		try {
			const electron = require('electron');
			const { globalShortcut } = electron.default ?? electron;
			globalShortcut.unregister(hotkey);
		} catch {}
	};
}

// --------------------------------------------------------------- guidance ----
const GUIDANCE = [
	'本机已安装 dsh-vpn-toggle 插件（DSH VPN 快捷开关）：DSH 主进程的模型 API / Files API / web 抓取等全局 fetch 流量可在「直连」与「本地 VPN 代理」之间按请求即时切换，无需重启。',
	'用户说「开VPN / 关VPN / 切换VPN」时：向本 Web GUI 同源端点 POST /vpn/on|/vpn/off|/vpn/toggle（例如 Invoke-RestMethod -Method Post http://127.0.0.1:<GUI端口>/vpn/toggle），GET /vpn 查看状态并原样汇报；状态持久化在 ~/.dsh/vpn-proxy.json（enabled/proxy/noProxy），也可直接改它，1.2 秒内被下一个请求读取。',
	'界面右下角有 VPN 悬浮按钮，用户侧有系统通知；全局热键默认关闭，用户可在设置卡片自定义（如 Control+Alt+V）。回环地址始终绕过代理，开启不影响本机访问。',
	'若开启后模型请求失败：先 POST /vpn/off 恢复直连，再检查 VPN 客户端与代理端口；换端口用 POST /vpn/proxy（body {"proxy":"http://127.0.0.1:端口"}，支持 http(s):// 与 socks5://）或设置卡片；代理留空时自动探测系统代理。'
].join('');

// -------------------------------------------------------------- plugin ------
const name = 'vpn-toggle';
const inject = ['webServer', 'systemPrompt'];
const VPN_SETTINGS_NAMESPACE = settingsNamespace('vpn-toggle');

const Config = z.object({
	proxy: z.string().default('').description('VPN 本地代理地址（http(s):// 或 socks5://）；留空则自动探测系统代理'),
	noProxy: z.string().default(DEFAULT_NO_PROXY).description('绕过代理的地址列表（逗号分隔）'),
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

	const requestToggle = () => {
		const cur = readState();
		const next = !cur.enabled;
		if (next && !cur.proxy) {
			if (!ensureProxyForEnable()) {
				log('hotkey: cannot enable, no proxy configured and system auto-detect found none');
				notifyState({ enabled: false });
				return;
			}
		}
		const st = updateState((s) => {
			s.enabled = next;
		});
		notifyState(st);
		log(`hotkey toggle -> ${st.enabled ? `ON ${st.proxy}` : 'OFF'}`);
	};

	const sync = () => {
		const value = current();
		currentHotkey = value.hotkey ?? DEFAULT_HOTKEY;
		// settings -> state file（保留 enabled；代理留空 = 自动探测系统代理，
		// 探测不到时保留现状，不覆盖手动设置过的值）
		updateState((s) => {
			const configured = typeof value.proxy === 'string' ? value.proxy.trim() : '';
			if (configured !== '') s.proxy = configured;
			else {
				const detected = detectSystemProxy();
				if (detected !== '') s.proxy = detected;
			}
			if (typeof value.noProxy === 'string' && value.noProxy.length > 0) s.noProxy = value.noProxy;
		});
		// hotkey
		if (disposeHotkey !== undefined) {
			disposeHotkey();
			disposeHotkey = undefined;
		}
		disposeHotkey = ctx.effect(() => armHotkey(value.hotkey ?? DEFAULT_HOTKEY, requestToggle), 'vpn-toggle: hotkey');
		// pill
		if (disposePill !== undefined) {
			disposePill();
			disposePill = undefined;
		}
		if ((value.showPill ?? true) !== false) {
			try {
				disposePill = ctx.effect(() => ctx.webServer.tapIndex(injectPill), 'vpn-toggle: pill');
			} catch (cause) {
				logErr('pill tap failed', cause);
			}
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

	// state file
	try {
		if (!existsSync(STATE_PATH)) {
			mkdirSync(dirname(STATE_PATH), { recursive: true });
			writeFileSync(STATE_PATH, JSON.stringify({ enabled: false, proxy: '', noProxy: DEFAULT_NO_PROXY }, null, 2) + '\n', 'utf8');
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
