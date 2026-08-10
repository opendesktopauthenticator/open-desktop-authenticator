import type SteamCommunity from 'steamcommunity';
import type { CConfirmation } from 'steamcommunity';
import * as SteamTotp from 'steam-totp';
import { getTimeOffset } from './session';

/**
 * Mobile confirmations (§12 F5).
 *
 * Every mobileconf request needs a fresh HMAC over (identity_secret, unix time,
 * tag). The tag must match the operation: 'list' to read, 'accept'/'reject' to
 * act. steamcommunity supports older tags ('conf'/'allow'/'cancel') for
 * backwards compatibility; we use the ones the current official app sends.
 */

export const CONFIRMATION_TYPE: Record<number, string> = {
	2: 'Trade',
	3: 'Market listing'
};

export function describeType(type: number): string {
	return CONFIRMATION_TYPE[type] ?? `Unknown (type ${type})`;
}

async function keyFor(identitySecret: string, tag: string): Promise<{ time: number; key: string }> {
	const offset = await getTimeOffset();
	const time = SteamTotp.time(offset);
	return { time, key: SteamTotp.getConfirmationKey(identitySecret, time, tag) };
}

export async function fetchConfirmations(
	community: SteamCommunity,
	identitySecret: string
): Promise<CConfirmation[]> {
	const { time, key } = await keyFor(identitySecret, 'list');
	return new Promise((resolve, reject) => {
		community.getConfirmations(time, { tag: 'list', key }, (err, confirmations) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(confirmations ?? []);
		});
	});
}

export async function respondToConfirmation(
	community: SteamCommunity,
	identitySecret: string,
	confirmation: CConfirmation,
	accept: boolean
): Promise<void> {
	const tag = accept ? 'accept' : 'reject';
	const { time, key } = await keyFor(identitySecret, tag);
	return new Promise((resolve, reject) => {
		community.respondToConfirmation(
			confirmation.id,
			confirmation.key,
			time,
			{ tag, key },
			accept,
			(err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			}
		);
	});
}
