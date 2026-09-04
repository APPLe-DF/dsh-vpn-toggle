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
