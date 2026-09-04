// dsh-vpn-toggle 单元测试 — `node tests/unit.mjs`，退出码即结果。
// 只测纯函数（lib/pure.js），零依赖，可在任何裸 node 22+ 环境运行。
import assert from 'node:assert/strict';
import { hostMatchesList, normalizeProxyServer, shouldProxy } from '../lib/pure.js';

let passed = 0;
function test(name, fn) {
	fn();
	passed += 1;
	console.log(`  ok ${name}`);
}

console.log('# hostMatchesList');

test('exact hostname match', () => {
	assert.equal(hostMatchesList({ origin: 'https://example.com/x' }, 'example.com'), true);
});

test('subdomain matches bare entry (suffix rule)', () => {
	assert.equal(hostMatchesList({ origin: 'https://a.example.com/x' }, 'example.com'), true);
});

test('unrelated host does not match (no partial suffix)', () => {
	assert.equal(hostMatchesList({ origin: 'https://notexample.com/x' }, 'example.com'), false);
});

test('leading-dot entry matches apex and subdomains', () => {
	assert.equal(hostMatchesList({ origin: 'https://example.com/x' }, '.example.com'), true);
	assert.equal(hostMatchesList({ origin: 'https://a.example.com/x' }, '.example.com'), true);
});

test("'*' matches everything", () => {
	assert.equal(hostMatchesList({ origin: 'https://anything.example/x' }, '*'), true);
});

test('bracketed IPv6 entry matches IPv6 origin', () => {
	assert.equal(hostMatchesList({ origin: 'http://[::1]:8080/x' }, '[::1]'), true);
	assert.equal(hostMatchesList({ origin: 'http://[::1]:8080/x' }, 'localhost,::1'), true);
});

test('single host:port entry is stripped to host part', () => {
	assert.equal(hostMatchesList({ origin: 'http://127.0.0.1/x' }, '127.0.0.1:7897'), true);
});

test('matching is case-insensitive on both sides', () => {
	assert.equal(hostMatchesList({ origin: 'https://EXAMPLE.com/x' }, 'example.com'), true);
	assert.equal(hostMatchesList({ origin: 'https://example.com/x' }, 'EXAMPLE.COM'), true);
});

test('missing origin matches nothing', () => {
	assert.equal(hostMatchesList({}, 'example.com'), false);
	assert.equal(hostMatchesList(undefined, 'example.com'), false);
});

test('empty list matches nothing', () => {
	assert.equal(hostMatchesList({ origin: 'https://example.com/x' }, ''), false);
});

test('list entries tolerate whitespace', () => {
	assert.equal(hostMatchesList({ origin: 'http://localhost/x' }, ' localhost , 127.0.0.1 '), true);
});

test('IPv6 entry without brackets matches bare IPv6 host', () => {
	assert.equal(hostMatchesList({ origin: 'http://[::1]/x' }, '::1'), true);
});

test('origin with explicit port still matches hostname only', () => {
	assert.equal(hostMatchesList({ origin: 'https://api.deepseek.com:443/v1' }, 'api.deepseek.com'), true);
});

console.log('# normalizeProxyServer');

test('bare host:port becomes http URL', () => {
	assert.equal(normalizeProxyServer('127.0.0.1:7897'), 'http://127.0.0.1:7897');
});

test('per-scheme form prefers https entry', () => {
	assert.equal(normalizeProxyServer('http=1.2.3.4:80;https=5.6.7.8:443'), 'http://5.6.7.8:443');
});

test('socks-only form becomes socks5 URL', () => {
	assert.equal(normalizeProxyServer('socks=127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
});

test('full URL passes through unchanged', () => {
	assert.equal(normalizeProxyServer('http://127.0.0.1:7897'), 'http://127.0.0.1:7897');
	assert.equal(normalizeProxyServer('socks5://127.0.0.1:7897'), 'socks5://127.0.0.1:7897');
});

test('empty input yields empty output', () => {
	assert.equal(normalizeProxyServer(''), '');
	assert.equal(normalizeProxyServer('   '), '');
	assert.equal(normalizeProxyServer(undefined), '');
});

console.log('# shouldProxy');

const ENABLED = { enabled: true, proxy: 'http://127.0.0.1:7897', noProxy: 'localhost,127.0.0.1,::1' };
const target = (host) => ({ origin: `https://${host}/x` });

test('all mode: everything not in noProxy is proxied', () => {
	assert.equal(shouldProxy({ ...ENABLED, mode: 'all', allowProxy: '' }, target('api.ipify.org')), true);
	assert.equal(shouldProxy({ ...ENABLED, mode: 'all', allowProxy: '' }, target('api.deepseek.com')), true);
});

test('all mode: noProxy hit stays direct', () => {
	assert.equal(shouldProxy({ ...ENABLED, mode: 'all', allowProxy: '' }, target('localhost')), false);
});

test('allowlist: matching host is proxied', () => {
	assert.equal(shouldProxy({ ...ENABLED, mode: 'allowlist', allowProxy: 'api.ipify.org' }, target('api.ipify.org')), true);
});

test('allowlist: non-matching host stays direct', () => {
	assert.equal(shouldProxy({ ...ENABLED, mode: 'allowlist', allowProxy: 'api.ipify.org' }, target('api.deepseek.com')), false);
});

test('allowlist: suffix rule applies to allowProxy entries', () => {
	assert.equal(shouldProxy({ ...ENABLED, mode: 'allowlist', allowProxy: 'github.com' }, target('api.github.com')), true);
	assert.equal(shouldProxy({ ...ENABLED, mode: 'allowlist', allowProxy: 'github.com' }, target('notgithub.com')), false);
});

test('allowlist: empty allowProxy means nothing is proxied', () => {
	assert.equal(shouldProxy({ ...ENABLED, mode: 'allowlist', allowProxy: '' }, target('api.ipify.org')), false);
});

test('noProxy wins over allowProxy (both match -> direct)', () => {
	const st = {
		enabled: true,
		proxy: 'http://127.0.0.1:7897',
		noProxy: 'localhost,127.0.0.1,::1,api.ipify.org',
		mode: 'allowlist',
		allowProxy: 'api.ipify.org,example.com'
	};
	assert.equal(shouldProxy(st, target('api.ipify.org')), false);
	assert.equal(shouldProxy(st, target('example.com')), true);
});

test('disabled or missing proxy never proxies', () => {
	assert.equal(shouldProxy({ ...ENABLED, enabled: false, mode: 'all' }, target('api.ipify.org')), false);
	assert.equal(shouldProxy({ ...ENABLED, proxy: '', mode: 'all' }, target('api.ipify.org')), false);
	assert.equal(shouldProxy(null, target('api.ipify.org')), false);
});

console.log(`\n${passed} tests passed`);
