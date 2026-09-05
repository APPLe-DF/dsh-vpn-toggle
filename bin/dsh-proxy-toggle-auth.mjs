#!/usr/bin/env node
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { readStoredControlToken } from '../lib/auth.js';

try {
	const home = resolveDshHome();
	process.stdout.write(readStoredControlToken(home) + '\n');
} catch (cause) {
	console.error('dsh-proxy-toggle-auth: unable to read the local control token. Start DSH once and check the token file permissions.');
	if (process.env.DEBUG) console.error(cause);
	process.exitCode = 1;
}
