#!/usr/bin/env node
// dsh-vpn-toggle one-shot regression against a running DSH webServer.
// Usage: node verify.mjs [origin]      (origin defaults to http://127.0.0.1:43120)
// Zero dependencies; needs Node 18+. Exit code 0 = all green, 1 = failure.
// Note: the toggle check flips enabled and restores it; two requests run
// back to back, so the VPN-on window is milliseconds.

const origin = process.argv[2] || 'http://127.0.0.1:43120';
let failures = 0;

const ok = (name) => console.log('  ok   ' + name);
const fail = (name, detail) => {
	failures += 1;
	console.log('  FAIL ' + name + (detail ? '  -  ' + detail : ''));
};
const assert = (cond, msg) => {
	if (!cond) throw new Error(msg);
};
async function check(name, fn) {
	try {
		await fn();
		ok(name);
	} catch (cause) {
		fail(name, (cause && cause.message) || String(cause));
	}
}

console.log('# dsh-vpn-toggle verify against ' + origin);

let initial = null;

await check('GET /vpn -> 200 with complete status (incl. mode/allowProxy)', async () => {
	const r = await fetch(origin + '/vpn');
	assert(r.status === 200, 'status ' + r.status);
	const j = await r.json();
	for (const key of ['enabled', 'mode', 'proxy', 'noProxy', 'allowProxy', 'hotkey', 'hotkeyRegistered', 'pill', 'file']) assert(key in j, 'missing field: ' + key);
	assert(j.mode === 'all' || j.mode === 'allowlist', 'unexpected mode: ' + j.mode);
	initial = j;
});

await check('POST /vpn/toggle with cross-origin Origin -> 403 (CSRF fence)', async () => {
	const r = await fetch(origin + '/vpn/toggle', { method: 'POST', headers: { origin: 'http://evil.com' } });
	assert(r.status === 403, 'status ' + r.status + ' (expected 403)');
});

await check('POST /vpn/toggle (no Origin) flips enabled; second call restores', async () => {
	assert(initial, 'previous /vpn check failed');
	const r1 = await fetch(origin + '/vpn/toggle', { method: 'POST' });
	assert(r1.status === 200, 'first toggle status ' + r1.status);
	const j1 = await r1.json();
	assert(j1.enabled === !initial.enabled, 'enabled did not flip');
	const r2 = await fetch(origin + '/vpn/toggle', { method: 'POST' });
	assert(r2.status === 200, 'second toggle status ' + r2.status);
	const j2 = await r2.json();
	assert(j2.enabled === initial.enabled, 'enabled not restored to ' + initial.enabled);
});

await check('POST /vpn/proxy with empty body -> 200 (harmless write-back)', async () => {
	const r = await fetch(origin + '/vpn/proxy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	assert(r.status === 200, 'status ' + r.status);
});

await check("GET / injects the floating pill (__dshVpnBtn)", async () => {
	const r = await fetch(origin + '/');
	assert(r.status === 200, 'status ' + r.status);
	const html = await r.text();
	assert(html.includes('__dshVpnBtn'), 'index.html lacks __dshVpnBtn');
});

await check('GET /plugins/dsh-vpn-toggle/client.js serves the client module', async () => {
	const r = await fetch(origin + '/plugins/dsh-vpn-toggle/client.js');
	assert(r.status === 200, 'status ' + r.status);
	const src = await r.text();
	assert(src.includes('__ModuleLoader__'), 'client.js lacks __ModuleLoader__');
});

// Informational only — network-dependent, never counts as a failure (an
// instance running older code simply has no /vpn/test route yet).
await check('POST /vpn/test prints result (network-dependent, not asserted)', async () => {
	let r;
	try {
		r = await fetch(origin + '/vpn/test', { method: 'POST', signal: AbortSignal.timeout(15000) });
	} catch (cause) {
		console.log('        unreachable: ' + ((cause && cause.message) || cause));
		return;
	}
	let j = null;
	try {
		j = await r.json();
	} catch {}
	if (j && j.ok) console.log('        exit ' + j.exitIp + ' | ' + j.latencyMs + 'ms | via ' + j.via + (j.proxy ? ' (' + j.proxy + ')' : ''));
	else if (j) console.log('        not ok: ' + (j.stage || '?') + (j.hint ? ' - ' + j.hint : ''));
	else console.log('        no JSON result (status ' + r.status + ') - /vpn/test missing on this instance?');
});

// Drain undici keep-alive sockets before exiting: an abrupt process.exit
// while an async handle is mid-close trips a libuv assertion on Windows
// and would clobber the exit code.
process.exitCode = failures === 0 ? 0 : 1;
try {
	const d = globalThis[Symbol.for('undici.globalDispatcher.1')] ?? globalThis[Symbol.for('undici.globalDispatcher.2')];
	if (d && typeof d.close === 'function') await d.close();
} catch {}
setTimeout(() => process.exit(process.exitCode), 10000).unref();
console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) FAILED');
