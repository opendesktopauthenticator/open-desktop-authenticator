import { resolveAccount } from '../accounts';
import { activeProxyConfig, initNetworking, openCommunity } from '../steam/session';
import { reportEgress } from '../egress';
import { log } from '../redact';

/**
 * `login` — prove the session handshake (§19 Phase 0).
 *
 * Opens a session by the cheapest route available: a live stored refresh token,
 * a usable stored web session, or credentials + TOTP.
 *
 * On success the refreshed tokens are written back into the source maFile, so
 * the password is only ever needed once the refresh token expires. Disable with
 * SPIKE_NO_WRITEBACK=1.
 */
export async function loginCommand(args: string[]): Promise<number> {
	const target = args.find((a) => !a.startsWith('-'));
	if (!target) {
		log.error('usage: spike login <account|steamID64|path-to-maFile>');
		return 2;
	}

	const account = resolveAccount(target);
	log.info(`Logging in as ${account.accountName} (platform: MobileApp)...`);

	initNetworking(account.accountName, account.proxy);
	// openCommunity, not login, so the freshly minted tokens are written back.
	const { steamId64, accountName, via } = await openCommunity(account);
	log.info(`  session established via ${via}`);

	log.info('\n  authenticated  : yes');
	log.info(`  account name   : ${accountName}`);
	log.info(`  steamID64      : ${steamId64}`);

	reportEgress(Boolean(activeProxyConfig()));

	return 0;
}
