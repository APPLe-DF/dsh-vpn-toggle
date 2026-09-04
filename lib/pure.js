// dsh-vpn-toggle — 纯函数层（零依赖，tests/unit.mjs 直接加载）
//
// 从 lib/index.js 抽出的决策函数：主机列表匹配与 Windows 代理值归一化。
// 约束：本文件不得 import 任何模块，保证测试环境（脱离 DSH 的裸 node）可用。

/**
 * Does the request target match a comma-separated host list?
 *
 * Matching rules (per entry): hostname exact match or leading-dot suffix
 * match; '*' matches everything; a bracketed IPv6 entry is unwrapped; a
 * single `host:port` entry is stripped to its host part. Matching is
 * case-insensitive. `opts` is an undici dispatch options object (uses
 * `opts.origin`); anything without a parsable origin matches nothing.
 */
export function hostMatchesList(opts, list) {
	try {
		const origin = opts && opts.origin;
		if (origin === undefined || origin === null) return false;
		const url = new URL(typeof origin === 'string' ? origin : origin.href || String(origin));
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
		for (const rawEntry of String(list || '').split(',')) {
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

/** Normalize a Windows ProxyServer value to a full proxy URL. */
export function normalizeProxyServer(raw) {
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

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:']);

/**
 * Accept bare `host:port` (the Windows ProxyServer / muscle-memory form)
 * and canonicalize it to http://host:port; anything with a scheme passes
 * through unchanged; other garbage is returned as-is for isValidProxyUrl
 * to reject. Empty string stays '' (auto mode).
 */
export function normalizeUserProxy(raw) {
	const s = String(raw ?? '').trim();
	if (s === '') return '';
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
	if (/^[^\s/]+:\d{1,5}$/.test(s)) return 'http://' + s;
	return s;
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
		return PROXY_SCHEMES.has(url.protocol) && url.hostname !== '';
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
	if (!st || !st.enabled || !st.proxy) return false;
	const noProxy = hostMatchesList(opts, st.noProxy);
	if (noProxy) return false;
	if (st.mode === 'allowlist') return hostMatchesList(opts, st.allowProxy);
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
	if (num('HTTPSEnable') === 1 && str('HTTPSProxy') && num('HTTPSPort') > 0) return 'http://' + str('HTTPSProxy') + ':' + num('HTTPSPort');
	if (num('HTTPEnable') === 1 && str('HTTPProxy') && num('HTTPPort') > 0) return 'http://' + str('HTTPProxy') + ':' + num('HTTPPort');
	if (num('SOCKSEnable') === 1 && str('SOCKSProxy') && num('SOCKSPort') > 0) return 'socks5://' + str('SOCKSProxy') + ':' + num('SOCKSPort');
	return '';
}
