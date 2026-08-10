import { createInterface } from 'node:readline';
import { resolveAccount } from '../accounts';
import { activeProxyConfig, initNetworking, openCommunity } from '../steam/session';
import { describeType, fetchConfirmations, respondToConfirmation } from '../steam/confirmations';
import { reportEgress } from '../egress';
import { log } from '../redact';

/**
 * `accept` — act on a single confirmation (§12 F5).
 *
 * This is the only command in the spike that changes state on a real Steam
 * account, and it is irreversible: accepting a trade confirmation completes the
 * trade. It therefore shows exactly what is about to happen and requires a typed
 * yes. `--yes` skips the prompt for scripted runs.
 */

function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(/^y(es)?$/i.test(answer.trim()));
		});
	});
}

export async function acceptCommand(args: string[]): Promise<number> {
	const positional = args.filter((a) => !a.startsWith('-'));
	const target = positional[0];
	const confId = positional[1];
	const skipPrompt = args.includes('--yes');
	const deny = args.includes('--deny');

	if (!target || !confId) {
		log.error(
			'usage: spike accept <account|steamID64|path-to-maFile> <confirmation-id> [--deny] [--yes]'
		);
		return 2;
	}

	const account = resolveAccount(target);
	log.info(`Opening a session for ${account.accountName}...`);

	initNetworking(account.accountName, account.proxy);
	const { community, accountName, via } = await openCommunity(account);
	log.info(`  session established via ${via}`);

	const confirmations = await fetchConfirmations(community, account.identitySecret);
	const confirmation = confirmations.find((c) => c.id === confId);

	if (!confirmation) {
		log.error(
			`no outstanding confirmation with id ${confId}. ` +
				`Currently outstanding: ${confirmations.map((c) => c.id).join(', ') || '(none)'}`
		);
		return 1;
	}

	const verb = deny ? 'DENY' : 'ACCEPT';
	log.blank();
	log.info(`About to ${verb} this confirmation on account ${accountName}:`);
	log.info(`  id       : ${confirmation.id}`);
	log.info(`  type     : ${describeType(confirmation.type)}`);
	log.info(`  title    : ${confirmation.title}`);
	if (confirmation.sending) {
		log.info(`  sending  : ${confirmation.sending}`);
	}
	if (confirmation.receiving) {
		log.info(`  receiving: ${confirmation.receiving}`);
	}
	log.blank();

	if (!skipPrompt) {
		const ok = await confirm(`Type "yes" to ${verb.toLowerCase()} this for real: `);
		if (!ok) {
			log.info('Aborted. Nothing was sent to Steam.');
			return 0;
		}
	}

	await respondToConfirmation(community, account.identitySecret, confirmation, !deny);
	log.info(`Done — confirmation ${confirmation.id} was ${deny ? 'denied' : 'accepted'}.`);

	reportEgress(Boolean(activeProxyConfig()));

	return 0;
}
