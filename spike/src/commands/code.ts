import { resolveAccount } from '../accounts';
import {
	activeProxyConfig,
	generateCode,
	initNetworking,
	secondsRemaining
} from '../steam/session';
import { reportEgress } from '../egress';
import { log } from '../redact';

/**
 * `code` — generate a Steam Guard login code (§12 F4).
 *
 * No login required: the code is a pure function of shared_secret and
 * Steam-corrected time. This is the cheapest possible proof that the time
 * offset handling is right — the founder compares it against his phone.
 */
export async function codeCommand(args: string[]): Promise<number> {
	const target = args.find((a) => !a.startsWith('-'));
	if (!target) {
		log.error('usage: spike code <account|steamID64|path-to-maFile> [--watch]');
		return 2;
	}

	const watch = args.includes('--watch');
	const account = resolveAccount(target);

	log.info(`Account: ${account.accountName}${account.steamId64 ? ` (${account.steamId64})` : ''}`);

	// Even a code lookup hits the network for time sync, so it routes too.
	initNetworking(account.accountName, account.proxy);

	if (!watch) {
		const code = await generateCode(account.sharedSecret);
		const remaining = await secondsRemaining();
		log.info(`\n  ${code}   valid for ${remaining}s`);
		log.info('\nCompare this against the Steam mobile app for the same account.');
		reportEgress(Boolean(activeProxyConfig()));
		return 0;
	}

	log.info('\nWatching. Ctrl+C to stop.\n');
	let lastCode = '';
	for (;;) {
		const code = await generateCode(account.sharedSecret);
		const remaining = await secondsRemaining();
		if (code !== lastCode) {
			log.info(`  ${code}   (new window, ${remaining}s left)`);
			lastCode = code;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
}
