import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

const execFileAsync = promisify(execFile);
export const AUTH_FILE_NAME = 'vpn-proxy.token';
export const SESSION_FILE_NAME = 'vpn-proxy.sessions.json';
export const SESSION_COOKIE_NAME = 'dsh_vpn_session';
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = SESSION_IDLE_TTL_MS;
const SESSION_SCHEMA_VERSION = 2;
const LEGACY_SESSION_SCHEMA_VERSION = 1;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SESSIONS = 64;
const MAX_PAIR_FAILURES = 10;
const PAIR_WINDOW_MS = 60 * 1000;

function equalSecret(left, right) {
	if (typeof left !== 'string' || typeof right !== 'string') return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function tokenFilePath(home) {
	return join(home, AUTH_FILE_NAME);
}

function sessionFilePath(home) {
	return join(home, SESSION_FILE_NAME);
}

function assertRegularFile(path, label) {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}

function hardenPosix(home, path) {
	chmodSync(home, 0o700);
	chmodSync(path, 0o600);
	const homeMode = statSync(home).mode & 0o777;
	const fileMode = statSync(path).mode & 0o777;
	if ((homeMode & 0o077) !== 0 || (fileMode & 0o077) !== 0) throw new Error('control credential permissions are too broad');
}

async function hardenWindows(path) {
	const username = String(process.env.USERNAME || '').trim();
	if (username === '') throw new Error('USERNAME is unavailable for control credential ACL');
	const domain = String(process.env.USERDOMAIN || '').trim();
	const account = domain === '' ? username : `${domain}\\${username}`;
	await execFileAsync('icacls', [path, '/inheritance:r', '/grant:r', `${account}:F`], {
		encoding: 'utf8',
		timeout: 5000,
		maxBuffer: 32768
	});
}

async function hardenCredentialFile(home, path) {
	if (process.platform === 'win32') await hardenWindows(path);
	else hardenPosix(home, path);
}

async function loadOrCreateToken(home) {
	if (typeof home !== 'string' || home.trim() === '') throw new Error('control token home is empty');
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const path = tokenFilePath(home);
	let token;
	if (existsSync(path)) {
		assertRegularFile(path, 'control token');
		token = readFileSync(path, 'utf8').trim();
		if (!TOKEN_PATTERN.test(token)) throw new Error('control token file has an invalid format');
	} else {
		token = randomBytes(TOKEN_BYTES).toString('base64url');
		writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		assertRegularFile(path, 'control token');
	}
	await hardenCredentialFile(home, path);
	return { path, token };
}

function sessionHash(value) {
	if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) return '';
	return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function authorityIsSafe(value) {
	if (typeof value !== 'string' || value.length > 256 || value.trim() !== value) return false;
	return ![...value].some((char) => char <= ' ' || '/@?#\\'.includes(char));
}

async function loadSessions(home) {
	const path = sessionFilePath(home);
	if (!existsSync(path)) return new Map();
	assertRegularFile(path, 'control session store');
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	const legacy = raw?.version === LEGACY_SESSION_SCHEMA_VERSION;
	if (!raw || (!legacy && raw.version !== SESSION_SCHEMA_VERSION) || !Array.isArray(raw.sessions)) throw new Error('control session store has an invalid format');
	if (raw.sessions.length > MAX_SESSIONS) throw new Error('control session store has too many sessions');
	const now = Date.now();
	const sessions = new Map();
	for (const record of raw.sessions) {
		const issuedAt = record?.issuedAt;
		const lastUsedAt = legacy ? issuedAt : record?.lastUsedAt;
		const absoluteExpiresAt = legacy ? issuedAt + SESSION_ABSOLUTE_TTL_MS : record?.absoluteExpiresAt;
		const authority = legacy ? '' : record?.authority;
		const invalidAuthority = !authorityIsSafe(authority);
		if (!record || !SESSION_HASH_PATTERN.test(record.hash) || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(lastUsedAt) || !Number.isSafeInteger(record.expiresAt) || !Number.isSafeInteger(absoluteExpiresAt) || invalidAuthority) {
			throw new Error('control session store has an invalid session record');
		}
		if (sessions.has(record.hash) || lastUsedAt < issuedAt || record.expiresAt <= lastUsedAt || record.expiresAt - lastUsedAt > SESSION_IDLE_TTL_MS || absoluteExpiresAt <= issuedAt || absoluteExpiresAt - issuedAt > SESSION_ABSOLUTE_TTL_MS || record.expiresAt > absoluteExpiresAt) {
			throw new Error('control session store has an invalid session lifetime');
		}
		if (record.expiresAt > now && absoluteExpiresAt > now) sessions.set(record.hash, { issuedAt, lastUsedAt, expiresAt: record.expiresAt, absoluteExpiresAt, authority });
		if (sessions.size > MAX_SESSIONS) throw new Error('control session store has too many sessions');
	}
	await hardenCredentialFile(home, path);
	return sessions;
}

function sessionCookie(value, secure) {
	return `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function expiredSessionCookie(secure) {
	return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

async function persistSessionsNow(auth) {
	const now = Date.now();
	prune(auth, now);
	const sessions = [...auth.sessions.entries()].map(([hash, record]) => ({ hash, issuedAt: record.issuedAt, lastUsedAt: record.lastUsedAt, expiresAt: record.expiresAt, absoluteExpiresAt: record.absoluteExpiresAt, authority: record.authority }));
	await writeFileAtomic(auth.sessionPath, JSON.stringify({ version: SESSION_SCHEMA_VERSION, sessions }, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 });
	await hardenCredentialFile(auth.home, auth.sessionPath);
}

function persistSessions(auth) {
	const run = auth.persistTail.then(() => persistSessionsNow(auth));
	auth.persistTail = run.catch((cause) => {
		auth.onError('control session store update failed', cause);
	});
	return run;
}

function cookieValue(req) {
	const raw = String(req.headers?.cookie || '');
	for (const part of raw.split(';')) {
		const at = part.indexOf('=');
		if (at === -1) continue;
		if (part.slice(0, at).trim() === SESSION_COOKIE_NAME) return part.slice(at + 1).trim();
	}
	return '';
}

function bearerValue(req) {
	const raw = String(req.headers?.authorization || '');
	const match = raw.match(/^Bearer\s+([A-Za-z0-9_-]{43})$/i);
	return match ? match[1] : '';
}

function remoteKey(req) {
	return String((req.socket && req.socket.remoteAddress) || 'unknown');
}

function requestAuthority(req) {
	const header = String(req.headers?.host || '');
	const raw = header.trim();
	if (raw === '' || header !== raw || !authorityIsSafe(raw)) return '';
	try {
		return new URL(`http://${raw}`).host.toLowerCase();
	} catch {
		return '';
	}
}

function prune(auth, now) {
	for (const [hash, record] of auth.sessions) if (record.expiresAt <= now) auth.sessions.delete(hash);
	for (const [key, record] of auth.pairFailures) if (record.at + PAIR_WINDOW_MS <= now) auth.pairFailures.delete(key);
}

export function createControlAuth(home, onError = () => {}) {
	const auth = {
		home,
		path: tokenFilePath(home),
		sessionPath: sessionFilePath(home),
		token: null,
		sessions: new Map(),
		pairFailures: new Map(),
		persistTail: Promise.resolve(),
		onError,
		ready: null
	};
	auth.ready = loadOrCreateToken(home).then(async ({ path, token }) => {
		auth.path = path;
		auth.token = token;
		auth.sessions = await loadSessions(home);
		return true;
	}).catch((cause) => {
		onError('control authentication initialization failed', cause);
		return false;
	});

	auth.authorize = async (req) => {
		if (!await auth.ready || auth.token === null) return { ok: false, unavailable: true };
		const now = Date.now();
		prune(auth, now);
		if (equalSecret(bearerValue(req), auth.token)) return { ok: true, kind: 'token' };
		const session = cookieValue(req);
		const hash = sessionHash(session);
		const authority = requestAuthority(req);
		const record = hash === '' ? undefined : auth.sessions.get(hash);
		if (record && authority !== '' && record.expiresAt > now && record.absoluteExpiresAt > now && (record.authority === '' || record.authority === authority)) {
			if (record.authority === '') {
				record.authority = authority;
				try {
					await persistSessions(auth);
				} catch {}
			}
			return { ok: true, kind: 'session' };
		}
		return { ok: false, unavailable: false };
	};

	auth.pair = async (req, supplied, res) => {
		if (!await auth.ready || auth.token === null) return { ok: false, status: 503, error: 'control authentication unavailable' };
		const now = Date.now();
		prune(auth, now);
		const authority = requestAuthority(req);
		if (authority === '') return { ok: false, status: 400, error: 'host header is required' };
		const key = remoteKey(req);
		const record = auth.pairFailures.get(key);
		if (record && record.count >= MAX_PAIR_FAILURES && record.at + PAIR_WINDOW_MS > now) return { ok: false, status: 429, error: 'too many pairing attempts' };
		if (!equalSecret(supplied, auth.token)) {
			const next = record && record.at + PAIR_WINDOW_MS > now ? { at: record.at, count: record.count + 1 } : { at: now, count: 1 };
			auth.pairFailures.set(key, next);
			return { ok: false, status: 401, error: 'invalid pairing token' };
		}
		auth.pairFailures.delete(key);
		while (auth.sessions.size >= MAX_SESSIONS) {
			const first = auth.sessions.keys().next().value;
			if (first === undefined) break;
			auth.sessions.delete(first);
		}
		const session = randomBytes(TOKEN_BYTES).toString('base64url');
		const hash = sessionHash(session);
		auth.sessions.set(hash, { issuedAt: now, lastUsedAt: now, expiresAt: Math.min(now + SESSION_IDLE_TTL_MS, now + SESSION_ABSOLUTE_TTL_MS), absoluteExpiresAt: now + SESSION_ABSOLUTE_TTL_MS, authority });
		try {
			await persistSessions(auth);
		} catch {
			auth.sessions.delete(hash);
			return { ok: false, status: 503, error: 'control session could not be saved' };
		}
		res.setHeader('set-cookie', sessionCookie(session, !!req.socket?.encrypted));
		return { ok: true };
	};

	auth.renew = async (req, res) => {
		if (!await auth.ready || auth.token === null) return { ok: false, status: 503, error: 'control authentication unavailable' };
		const now = Date.now();
		prune(auth, now);
		const authority = requestAuthority(req);
		const oldSession = cookieValue(req);
		const oldHash = sessionHash(oldSession);
		const current = oldHash === '' ? undefined : auth.sessions.get(oldHash);
		if (authority === '' || !current || current.absoluteExpiresAt <= now || current.expiresAt <= now || (current.authority !== '' && current.authority !== authority)) {
			if (current && current.absoluteExpiresAt <= now) {
				auth.sessions.delete(oldHash);
				try {
					await persistSessions(auth);
				} catch {}
			}
			res.setHeader('set-cookie', expiredSessionCookie(!!req.socket?.encrypted));
			return { ok: false, status: 401, error: 'authentication required' };
		}
		const session = randomBytes(TOKEN_BYTES).toString('base64url');
		const hash = sessionHash(session);
		const next = {
			issuedAt: current.issuedAt,
			lastUsedAt: now,
			expiresAt: Math.min(now + SESSION_IDLE_TTL_MS, current.absoluteExpiresAt),
			absoluteExpiresAt: current.absoluteExpiresAt,
			authority: current.authority || authority
		};
		if (next.expiresAt <= now) return { ok: false, status: 401, error: 'authentication required' };
		auth.sessions.delete(oldHash);
		auth.sessions.set(hash, next);
		try {
			await persistSessions(auth);
		} catch {
			auth.sessions.delete(hash);
			auth.sessions.set(oldHash, current);
			return { ok: false, status: 503, error: 'control session could not be saved' };
		}
		res.setHeader('set-cookie', sessionCookie(session, !!req.socket?.encrypted));
		return { ok: true, kind: 'session', expiresAt: next.expiresAt };
	};

	auth.logout = async (req, res) => {
		const session = cookieValue(req);
		const hash = sessionHash(session);
		if (hash !== '' && auth.sessions.delete(hash)) {
			try {
				await persistSessions(auth);
			} catch {}
		}
		res.setHeader('set-cookie', expiredSessionCookie(!!req.socket?.encrypted));
	};

	return auth;
}

export function readStoredControlToken(home) {
	const path = tokenFilePath(home);
	assertRegularFile(path, 'control token');
	const token = readFileSync(path, 'utf8').trim();
	if (!TOKEN_PATTERN.test(token)) throw new Error('control token file has an invalid format');
	return token;
}
