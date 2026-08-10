import { resolveAccount } from '../accounts';
import { activeProxyConfig, initNetworking, openCommunity } from '../steam/session';
import { describeType, fetchConfirmations } from '../steam/confirmations';
import { reportEgress } from '../egress';
import { log } from '../redact';

/**
 * `confirmations` — list outstanding mobile confirmations (§12 F5).
 */
export async function confirmationsCommand(args: string[]): Promise<number> {
	const target = args.find((a) => !a.startsWith('-'));
	if (!target) {
		log.error('usage: spike confirmations <account|steamID64|path-to-maFile>');
		return 2;
	}

	const account = resolveAccount(target);
	log.info(`Opening a session for ${account.accountName}...`);

	initNetworking(account.accountName, account.proxy);
	const { community, steamId64, via } = await openCommunity(account);
	log.info(`  session established via ${via} (${steamId64})`);

	log.info('Fetching confirmations...\n');
	const confirmations = await fetchConfirmations(community, account.identitySecret);

	if (confirmations.length === 0) {
		log.info('No outstanding confirmations.');
		reportEgress(Boolean(activeProxyConfig()));
		return 0;
	}

	for (const conf of confirmations) {
		log.info(`-- id ${conf.id}   [${describeType(conf.type)}]`);
		log.info(`   ${conf.title}`);
		if (conf.sending) {
			log.info(`   sending  : ${conf.sending}`);
		}
		if (conf.receiving) {
			log.info(`   receiving: ${conf.receiving}`);
		}
		log.info(`   created  : ${conf.timestamp.toISOString()}`);
		log.info(
			`   creator  : ${conf.creator}${conf.offerID ? ` (trade offer ${conf.offerID})` : ''}`
		);
		log.blank();
	}

	log.info(`${confirmations.length} confirmation(s).`);
	log.info(`Accept one with:  spike accept ${target} <id>`);

	reportEgress(Boolean(activeProxyConfig()));

	return 0;
}
