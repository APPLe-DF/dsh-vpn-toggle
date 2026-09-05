#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

// dsh-proxy-toggle read-only smoke check against a running DSH webServer.
// Usage: node verify.mjs [origin] (default: http://127.0.0.1:3080; an opt-in
// fallback port may be discovered from vpn-proxy.port).
// Set DSH_PROXY_TOKEN only when a detailed authenticated status check is desired.
// This script never toggles proxy routing, changes proxy settings, or performs an
// external connectivity probe. Runtime DSH/Electron integration is optional.

const requestedOrigin = process.argv[2];
const defaultOrigin = 'http://127.0.0.1:3080';
function discoverFallbackOrigin() {
	try {
		const port = Number(readFileSync(join(resolveDshHome(), 'vpn-proxy.port'), 'utf8').trim());
		return Number.isInteger(port) && port >= 43199 && port <= 43206 ? 'http://127.0.0.1:' + port : '';
	} catch {
		return '';
	}
}
let origin = requestedOrigin || defaultOrigin;
if (!requestedOrigin) {
	const fallback = discoverFallbackOrigin();
	if (fallback !== '') {
		try {
			const response = await fetch(defaultOrigin + '/vpn/ui', { signal: AbortSignal.timeout(1500) });
			if (!response.ok) origin = fallback;
		} catch {
			origin = fallback;
		}
	}
}
const token = String(process.env.DSH_PROXY_TOKEN || '').trim();
const authHeaders = token === '' ? {} : { authorization: 'Bearer ' + token };
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

console.log('# dsh-proxy-toggle read-only verify against ' + origin);

await check(token === '' ? 'GET /vpn -> unauthenticated access is rejected' : 'GET /vpn -> authenticated complete status', async () => {
	const r = await fetch(origin + '/vpn', { headers: authHeaders });
	if (token === '') {
		assert(r.status === 401, 'status ' + r.status + ' (expected 401)');
		const j = await r.json();
		assert(typeof j.fallbackEnabled === 'boolean', 'unauthenticated response lacks fallbackEnabled');
		return;
	}
	assert(r.status === 200, 'status ' + r.status);
	const j = await r.json();
	for (const key of ['enabled', 'mode', 'proxy', 'proxySource', 'noProxy', 'allowProxy', 'hotkey', 'hotkeyRegistered', 'pill', 'file', 'revision', 'authMethod', 'fallbackEnabled']) assert(key in j, 'missing field: ' + key);
  assert(typeof j.fallbackEnabled === 'boolean', 'unexpected fallbackEnabled');
	assert(['host', 'token', 'session', 'unknown'].includes(j.authMethod), 'unexpected authMethod: ' + j.authMethod);
	assert(j.mode === 'all' || j.mode === 'allowlist', 'unexpected mode: ' + j.mode);
	assert(['auto', 'manual', 'api'].includes(j.proxySource), 'unexpected proxySource: ' + j.proxySource);
	assert(Number.isSafeInteger(j.revision) && j.revision >= 0, 'unexpected revision');
});

await check('GET /vpn/ui serves the standalone page', async () => {
	const r = await fetch(origin + '/vpn/ui');
	assert(r.status === 200, 'status ' + r.status);
	const html = await r.text();
	assert(html.includes('Proxy') || html.includes('代理'), 'standalone page lacks proxy text');
	assert(html.includes('dsh-proxy-toggle-auth') || html.includes('DSH host session') || html.includes('DSH 宿主会话'), 'standalone page lacks host or fallback authorization guidance');
	assert(html.includes('/vpn/renew'), 'standalone page lacks session renewal action');
});

await check('GET / injects the floating pill', async () => {
	const r = await fetch(origin + '/');
	assert(r.status === 200, 'status ' + r.status);
	const html = await r.text();
	assert(html.includes('__dshProxyBtn'), 'index.html lacks __dshProxyBtn');
});

await check('client module is served', async () => {
	const r = await fetch(origin + '/plugins/dsh-proxy-toggle/client.js');
	assert(r.status === 200, 'status ' + r.status);
	const src = await r.text();
	assert(src.includes('__ModuleLoader__'), 'client.js lacks __ModuleLoader__');
});

process.exitCode = failures === 0 ? 0 : 1;
console.log(failures === 0 ? '\nall read-only checks passed' : '\n' + failures + ' check(s) FAILED');
