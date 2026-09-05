// dsh-proxy-toggle — 纯函数层（零依赖，tests/unit.mjs 直接加载）
//
// 从 lib/index.js 抽出的决策函数：主机列表匹配与 Windows 代理值归一化。
// 约束：本文件不得 import 任何模块，保证测试环境（脱离 DSH 的裸 node）可用。

/** Extract and normalize the hostname carried by an undici origin. */
function hostnameFromOptions(opts) {
	try {
		const origin = opts && opts.origin;
		if (origin === undefined || origin === null) return '';
		const url = new URL(typeof origin === 'string' ? origin : origin.href || String(origin));
		return String(url.hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	} catch {
		return '';
	}
}

/** Parse an IPv6 hostname into 16 bytes without importing Node-only modules. */
function ipv6Bytes(rawHost) {
	let host = String(rawHost || '').toLowerCase();
	const zone = host.indexOf('%');
	if (zone !== -1) host = host.slice(0, zone);
	if (host === '' || !host.includes(':')) return null;
	if (host.includes('.')) {
		const at = host.lastIndexOf(':');
		if (at === -1) return null;
		const octets = host.slice(at + 1).split('.');
		if (octets.length !== 4 || !octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return null;
		const high = ((Number(octets[0]) << 8) | Number(octets[1])).toString(16);
		const low = ((Number(octets[2]) << 8) | Number(octets[3])).toString(16);
		host = host.slice(0, at + 1) + high + ':' + low;
	}
	const halves = host.split('::');
	if (halves.length > 2) return null;
	const left = halves[0] === '' ? [] : halves[0].split(':');
	const right = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
	const parse = (part) => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1;
	const groups = [...left, ...right].map(parse);
	if (groups.some((group) => group < 0)) return null;
	if (halves.length === 1 && groups.length !== 8) return null;
	if (halves.length === 2 && groups.length >= 8) return null;
	const full = halves.length === 2 ? [...left.map(parse), ...Array(8 - groups.length).fill(0), ...right.map(parse)] : groups;
	if (full.length !== 8 || full.some((group) => group < 0)) return null;
	const bytes = [];
	for (const group of full) bytes.push(group >> 8, group & 0xff);
	return bytes;
}

/** Whether an IPv6 address is ::1 or an IPv4-mapped 127/8 address. */
function isLoopbackIpv6(host) {
	const bytes = ipv6Bytes(host);
	if (bytes === null) return false;
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
	return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255 && bytes[12] === 127;
}

/** Whether a hostname is in the loopback range, independent of noProxy. */
export function isLoopbackHost(rawHost) {
	const host = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host.includes(':')) return isLoopbackIpv6(host);
	const octets = host.split('.');
	return octets.length === 4 && octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) && Number(octets[0]) === 127;
}

/** Whether an undici dispatch target is a loopback address. */
export function isLoopbackOrigin(opts) {
	const host = hostnameFromOptions(opts);
	return host !== '' && isLoopbackHost(host);
}

/** Extract the effective origin port for port-qualified noProxy entries. */
function originPort(opts) {
	try {
		const origin = opts && opts.origin;
		const url = new URL(typeof origin === 'string' ? origin : origin.href || String(origin));
		if (url.port !== '') return Number(url.port);
		return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0;
	} catch {
		return 0;
	}
}

/** Canonicalize a hostname entry with the platform URL/IDNA parser. */
function canonicalListHost(rawHost) {
	const value = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (value === '' || value.includes(':')) return value;
	try {
		return new URL(`http://${value}`).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	} catch {
		return value;
	}
}


/**
 * Matching rules (per entry): hostname exact match or leading-dot suffix
 * match; '*' matches everything; a bracketed IPv6 entry is unwrapped; a
 * host:port entry additionally requires the origin port. Matching is
 * case-insensitive. `opts` is an undici dispatch options object (uses
 * `opts.origin`); anything without a parsable origin matches nothing.
 */
export function hostMatchesList(opts, list) {
	const host = hostnameFromOptions(opts);
	if (host === '') return false;
	const port = originPort(opts);
	for (const rawEntry of String(list || '').split(',')) {
		let entry = rawEntry.trim().toLowerCase();
		if (entry === '') continue;
		if (entry === '*') return true;
		let entryPort = null;
		if (entry.startsWith('[')) {
			const close = entry.indexOf(']');
			if (close === -1) continue;
			const suffix = entry.slice(close + 1);
			entry = entry.slice(1, close);
			if (suffix !== '') {
				if (!/^:\d+$/.test(suffix)) continue;
				entryPort = Number(suffix.slice(1));
			}
		} else if ((entry.match(/:/g) || []).length === 1) {
			const at = entry.indexOf(':');
			const suffix = entry.slice(at + 1);
			if (!/^\d+$/.test(suffix)) continue;
			entryPort = Number(suffix);
			entry = entry.slice(0, at);
		}
		if (entryPort !== null && (entryPort < 1 || entryPort > 65535 || entryPort !== port)) continue;
		if (entry.startsWith('.')) entry = entry.slice(1);
		entry = canonicalListHost(entry);
		if (entry === '') continue;
		if (host === entry || host.endsWith('.' + entry)) return true;
	}
	return false;
}

/** Normalize a bare host:port while preserving IPv6 bracket requirements. */
function normalizeBareProxy(value, fallback) {
	const candidate = String(value || '').trim();
	if (candidate === '') return '';
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return candidate;
	if (/^\[[^\]]+\]:\d{1,5}$/.test(candidate)) return fallback + candidate;
	const ipv6Port = candidate.match(/^(.+):(\d{1,5})$/);
	if (ipv6Port && ipv6Bytes(ipv6Port[1]) !== null) return fallback + '[' + ipv6Port[1] + ']:' + ipv6Port[2];
	const hostPort = candidate.match(/^([^\s/:]+):(\d{1,5})$/);
	if (hostPort) return fallback + candidate;
	return candidate;
}

/** Normalize a Windows ProxyServer value to a full proxy URL. */
export function normalizeProxyServer(raw) {
	const s = String(raw || '').trim();
	if (s === '') return '';
	const withScheme = (value, fallback) => normalizeBareProxy(value, fallback);
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
		return withScheme(pick, scheme);
	}
	return withScheme(s, 'http://');
}

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:']);

/**
 * Accept bare host:port (including IPv6) and canonicalize it to a proxy URL.
 * Empty string stays '' (auto mode); other garbage is returned for validation.
 */
export function normalizeUserProxy(raw) {
	const s = String(raw ?? '').trim();
	if (s === '') return '';
	return normalizeBareProxy(s, 'http://');
}

/**
 * Storable proxy address check (normalizes first): only http(s):// and
 * socks5:// URLs with a hostname; empty = auto mode.
 */
export function isValidProxyUrl(raw) {
	const s = normalizeUserProxy(raw);
	if (s === '') return true;
	try {
		const url = new URL(s);
		if (!PROXY_SCHEMES.has(url.protocol) || url.hostname === '') return false;
		const pathOk = url.protocol === 'socks5:' ? (url.pathname === '' || url.pathname === '/') : url.pathname === '/';
		if (url.username !== '' || url.password !== '' || !pathOk || url.search !== '' || url.hash !== '') return false;
		if (url.port !== '') {
			const port = Number(url.port);
			if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Should this request be tunneled through the proxy? The single decision
 * point used by the dispatcher wrapper (and mirrored by /vpn/test to predict
 * the routing of a probe request).
 *
 * Priority: noProxy always wins — in allowlist mode a target that matches
 * both allowProxy and noProxy stays direct (loopback sanity).
 * Empty `allowProxy` in allowlist mode means nothing is proxied.
 */
export function shouldProxy(st, opts) {
	if (!st || !st.enabled) return false;
	// Loopback is a transport invariant, not merely a convenient default list:
	// local DSH services must stay reachable even when the user edits noProxy.
	if (isLoopbackOrigin(opts)) return false;
	if (hostMatchesList(opts, st.noProxy)) return false;
	if (st.mode === 'allowlist' && !hostMatchesList(opts, st.allowProxy)) return false;
	// An enabled state without a resolved proxy is still a proxied route. The
	// dispatcher will reject it instead of silently leaking the request direct.
	return true;
}

// -------------------------------------------------------------- hotkey record ----
// Keyboard-event → Electron accelerator mapping. Lives in pure.js so it is
// unit-testable; the browser half (client.js) keeps a verbatim copy because
// it is served as a single self-contained script and cannot import modules —
// keep the two in sync.

/** Map a KeyboardEvent.code (physical key) to the Electron key name. */
export function codeToAccelerator(code) {
	if (typeof code !== 'string' || code === '') return '';
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
	const named = {
		ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
		Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Escape: 'Esc',
		Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Tab: 'Tab',
		CapsLock: 'Capslock', NumLock: 'Numlock', ScrollLock: 'Scrolllock',
		Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Pause: 'Pause',
		Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
		Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
		Numpad0: 'num0', Numpad1: 'num1', Numpad2: 'num2', Numpad3: 'num3', Numpad4: 'num4',
		Numpad5: 'num5', Numpad6: 'num6', Numpad7: 'num7', Numpad8: 'num8', Numpad9: 'num9',
		NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
		NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
	};
	return named[code] || '';
}

/** KeyboardEvent.code values that are modifiers themselves, not base keys. */
const MODIFIER_CODES = new Set([
	'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
	'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'Fn', 'FnLock'
]);

/**
 * Build an Electron accelerator from a keyboard event snapshot (the fields
 * of a DOM KeyboardEvent). Returns a decision object instead of throwing:
 *  - modifier-only press           → { ok: false, reason: 'modifier-only' } (keep recording)
 *  - key without accelerator name  → { ok: false, reason: 'unsupported' }
 *  - no real modifier (Ctrl/Alt/Super), Shift alone not enough
 *                                  → { ok: false, reason: 'need-modifier' }
 *                                    (a bare key as a GLOBAL hotkey would be
 *                                    swallowed system-wide)
 *  - otherwise                     → { ok: true, accelerator: 'Control+Alt+V' }
 */
export function acceleratorFromEvent(ev) {
	const parts = [];
	if (ev.ctrlKey) parts.push('Control');
	if (ev.altKey) parts.push('Alt');
	if (ev.shiftKey) parts.push('Shift');
	if (ev.metaKey) parts.push('Super');
	const code = ev.code || '';
	if (MODIFIER_CODES.has(code)) return { ok: false, reason: 'modifier-only' };
	const base = codeToAccelerator(code);
	if (base === '') {
		return parts.length ? { ok: false, reason: 'unsupported' } : { ok: false, reason: 'modifier-only' };
	}
	const realMods = (ev.ctrlKey ? 1 : 0) + (ev.altKey ? 1 : 0) + (ev.metaKey ? 1 : 0);
	if (realMods === 0) return { ok: false, reason: 'need-modifier' };
	parts.push(base);
	return { ok: true, accelerator: parts.join('+') };
}

/**
 * Parse `scutil --proxy` output (macOS) into a full proxy URL. Preference:
 * HTTPS (when enabled), then HTTP, then SOCKS; each entry must be enabled
 * with a non-empty host and a non-zero port. Returns '' when nothing is on.
 */
export function proxyFromScutilOutput(out) {
	const text = String(out || '');
	const num = (key) => {
		const m = text.match(new RegExp(key + '\\s*:\\s*(\\d+)'));
		return m ? Number(m[1]) : 0;
	};
	const str = (key) => {
		const m = text.match(new RegExp(key + '\\s*:\\s*(\\S+)'));
		return m ? m[1] : '';
	};
	const make = (hostKey, portKey, scheme, enabledKey) => {
		const host = str(hostKey);
		const port = num(portKey);
		if (num(enabledKey) !== 1 || host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return '';
		const bare = normalizeUserProxy(`${host}:${port}`);
		if (bare === '' || !isValidProxyUrl(bare)) return '';
		return scheme === 'http://' ? bare : scheme + bare.slice('http://'.length);
	};
	return make('HTTPSProxy', 'HTTPSPort', 'http://', 'HTTPSEnable') || make('HTTPProxy', 'HTTPPort', 'http://', 'HTTPEnable') || make('SOCKSProxy', 'SOCKSPort', 'socks5://', 'SOCKSEnable');
}
