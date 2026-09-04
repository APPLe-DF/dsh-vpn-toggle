// dsh-vpn-toggle 单元测试 — `node tests/unit.mjs`，退出码即结果。
// 只测纯函数（lib/pure.js），零依赖，可在任何裸 node 22+ 环境运行。
import assert from 'node:assert/strict';
import { hostMatchesList, normalizeProxyServer, shouldProxy, codeToAccelerator, acceleratorFromEvent, isValidProxyUrl, normalizeUserProxy, proxyFromScutilOutput } from '../lib/pure.js';

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

console.log('# codeToAccelerator');

test('letters and digits come from the physical code', () => {
	assert.equal(codeToAccelerator('KeyV'), 'V');
	assert.equal(codeToAccelerator('Digit5'), '5');
});

test('function keys pass through F1-F24', () => {
	assert.equal(codeToAccelerator('F12'), 'F12');
	assert.equal(codeToAccelerator('F24'), 'F24');
	assert.equal(codeToAccelerator('F25'), '');
});

test('named keys map to Electron spellings', () => {
	assert.equal(codeToAccelerator('ArrowUp'), 'Up');
	assert.equal(codeToAccelerator('Space'), 'Space');
	assert.equal(codeToAccelerator('Escape'), 'Esc');
	assert.equal(codeToAccelerator('Enter'), 'Return');
	assert.equal(codeToAccelerator('CapsLock'), 'Capslock');
	assert.equal(codeToAccelerator('Minus'), '-');
	assert.equal(codeToAccelerator('NumpadAdd'), 'numadd');
});

test('unknown codes map to nothing', () => {
	assert.equal(codeToAccelerator('MediaPlayPause'), '');
	assert.equal(codeToAccelerator(''), '');
	assert.equal(codeToAccelerator(undefined), '');
});

console.log('# acceleratorFromEvent');

const ev = (over) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: '', ...over });

test('control+alt+V builds the canonical accelerator', () => {
	assert.deepEqual(acceleratorFromEvent(ev({ ctrlKey: true, altKey: true, code: 'KeyV' })), { ok: true, accelerator: 'Control+Alt+V' });
});

test('modifier order is normalized regardless of physical order', () => {
	const r = acceleratorFromEvent(ev({ metaKey: true, shiftKey: true, ctrlKey: true, code: 'KeyP' }));
	assert.equal(r.ok, true);
	assert.equal(r.accelerator, 'Control+Shift+Super+P');
});

test('meta maps to Super', () => {
	assert.deepEqual(acceleratorFromEvent(ev({ metaKey: true, code: 'KeyQ' })), { ok: true, accelerator: 'Super+Q' });
});

test('plain key or Shift-only key is rejected (need-modifier)', () => {
	assert.deepEqual(acceleratorFromEvent(ev({ code: 'KeyV' })), { ok: false, reason: 'need-modifier' });
	assert.deepEqual(acceleratorFromEvent(ev({ shiftKey: true, code: 'KeyV' })), { ok: false, reason: 'need-modifier' });
});

test('modifier-only press asks to keep recording', () => {
	assert.deepEqual(acceleratorFromEvent(ev({ ctrlKey: true, code: 'ControlLeft' })), { ok: false, reason: 'modifier-only' });
});

test('unmappable key with modifiers is unsupported', () => {
	assert.deepEqual(acceleratorFromEvent(ev({ ctrlKey: true, altKey: true, code: 'MediaPlay' })), { ok: false, reason: 'unsupported' });
});

console.log('# isValidProxyUrl');

test('http/https/socks5 URLs are accepted', () => {
	assert.equal(isValidProxyUrl('http://127.0.0.1:7897'), true);
	assert.equal(isValidProxyUrl('https://proxy.example.com:8443'), true);
	assert.equal(isValidProxyUrl('socks5://127.0.0.1:1080'), true);
	assert.equal(isValidProxyUrl('http://[::1]:7897'), true);
});

test('empty string is valid (auto mode)', () => {
	assert.equal(isValidProxyUrl(''), true);
	assert.equal(isValidProxyUrl('   '), true);
	assert.equal(isValidProxyUrl(undefined), true);
});

test('unsupported schemes and garbage are rejected', () => {
	assert.equal(isValidProxyUrl('javascript:alert(1)'), false);
	assert.equal(isValidProxyUrl('ftp://127.0.0.1:21'), false);
	assert.equal(isValidProxyUrl('7897'), false);
	assert.equal(isValidProxyUrl('host:nonsense'), false);
	assert.equal(isValidProxyUrl('http://'), false);
});

console.log('# normalizeUserProxy / bare host:port');

test('bare host:port is accepted and means http://', () => {
	assert.equal(isValidProxyUrl('127.0.0.1:5999'), true);
	assert.equal(isValidProxyUrl('localhost:7890'), true);
	assert.equal(isValidProxyUrl('[::1]:7890'), true);
	assert.equal(normalizeUserProxy('127.0.0.1:5999'), 'http://127.0.0.1:5999');
	assert.equal(normalizeUserProxy(' localhost:7890 '), 'http://localhost:7890');
});

test('schemed URLs pass through normalization unchanged', () => {
	assert.equal(normalizeUserProxy('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
	assert.equal(normalizeUserProxy('http://user:pass@host:8443'), 'http://user:pass@host:8443');
	assert.equal(normalizeUserProxy(''), '');
});

test('bare host without port or with non-numeric port is rejected', () => {
	assert.equal(isValidProxyUrl('127.0.0.1'), false);
	assert.equal(isValidProxyUrl('host:abc'), false);
});

console.log('# proxyFromScutilOutput');

const SCUTIL_ON = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
  SOCKSPort : 0
  SOCKSProxy : 0
  ProxyAutoConfigEnable : 0
}`;

test('prefers HTTPS, then HTTP, then SOCKS', () => {
	assert.equal(proxyFromScutilOutput(SCUTIL_ON), 'http://127.0.0.1:7890');
	assert.equal(
		proxyFromScutilOutput(SCUTIL_ON.replace(/HTTPSEnable : 1/, 'HTTPSEnable : 0')),
		'http://127.0.0.1:7890'
	);
	assert.equal(
		proxyFromScutilOutput(SCUTIL_ON
			.replace(/HTTPSEnable : 1/, 'HTTPSEnable : 0')
			.replace(/HTTPEnable : 1/, 'HTTPEnable : 0')
			.replace(/SOCKSEnable : 0/, 'SOCKSEnable : 1')
			.replace(/SOCKSPort : 0/, 'SOCKSPort : 7890')
			.replace(/SOCKSProxy : 0/, 'SOCKSProxy : 127.0.0.1')),
		'socks5://127.0.0.1:7890'
	);
});

test('disabled or portless entries yield empty', () => {
	assert.equal(proxyFromScutilOutput('<dictionary> {\n  HTTPEnable : 0\n}'), '');
	assert.equal(proxyFromScutilOutput(SCUTIL_ON.replace(/HTTPSPort : 7890/, 'HTTPSPort : 0').replace(/HTTPEnable : 1/, 'HTTPEnable : 0')), '');
	assert.equal(proxyFromScutilOutput(''), '');
});

console.log(`\n${passed} tests passed`);
