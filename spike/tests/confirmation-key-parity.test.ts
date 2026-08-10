import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as SteamTotp from 'steam-totp';
import {
	CONFIRMATION_TAGS,
	deviceIdFor,
	generateConfirmationKey
} from '../../src/main/confirmations/key';

/**
 * Differential test: our confirmation keys against `steam-totp`.
 *
 * The companion to `totp-parity`. A confirmation key authorises an operation
 * that can move somebody's inventory, so "it matches the implementation the
 * whole ecosystem uses" needs to be asserted rather than assumed — and the
 * library lives here, not in the application (D13).
 *
 * If this ever fails, confirmations are broken in a way live testing would show
 * only as Steam refusing every request with no useful error.
 */

function randomSecret(): string {
	return randomBytes(20).toString('base64');
}

describe('parity with steam-totp', () => {
	it('agrees for every tag across a decade of times', () => {
		const secret = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
		let checked = 0;

		for (const tag of Object.values(CONFIRMATION_TAGS)) {
			// A prime step so the sample does not land on a repeating pattern.
			for (let t = 1_577_836_800; t < 1_893_456_000; t += 104_729) {
				expect(generateConfirmationKey(secret, t, tag), `tag=${tag} t=${t}`).toBe(
					SteamTotp.getConfirmationKey(secret, t, tag)
				);
				checked++;
			}
		}

		// Guards against a loop that silently did nothing.
		expect(checked).toBeGreaterThan(10_000);
	});

	it('agrees across many random identity secrets', () => {
		for (let i = 0; i < 200; i++) {
			const secret = randomSecret();
			const time = 1_600_000_000 + Math.floor(Math.random() * 500_000_000);
			expect(generateConfirmationKey(secret, time, 'accept')).toBe(
				SteamTotp.getConfirmationKey(secret, time, 'accept')
			);
		}
	});

	it('agrees on a hex identity secret', () => {
		const hex = randomBytes(20).toString('hex');
		expect(generateConfirmationKey(hex, 1_700_000_000, 'list')).toBe(
			SteamTotp.getConfirmationKey(hex, 1_700_000_000, 'list')
		);
	});

	it('produces a different key for every tag at the same instant', () => {
		// The property that stops a captured list request being replayed as an
		// approval. Worth asserting directly rather than inferring from parity.
		const secret = randomSecret();
		const keys = Object.values(CONFIRMATION_TAGS).map((tag) =>
			generateConfirmationKey(secret, 1_700_000_000, tag)
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('produces a different key for every second', () => {
		const secret = randomSecret();
		const a = generateConfirmationKey(secret, 1_700_000_000, 'accept');
		const b = generateConfirmationKey(secret, 1_700_000_001, 'accept');
		expect(a).not.toBe(b);
	});

	it('agrees on the derived device id', () => {
		// `steam-totp` mixes in `STEAM_TOTP_SALT` if it is set. We deliberately do
		// not — a device id that depends on an environment variable is one that
		// changes when a shell changes. Asserted so that a machine with the variable
		// set fails here with an explanation rather than an unexplained mismatch.
		expect(
			process.env.STEAM_TOTP_SALT ?? '',
			'unset STEAM_TOTP_SALT to run this test; steam-totp salts device ids with it and we do not'
		).toBe('');

		// Synthetic throughout — these sit outside the range Steam actually
		// allocates, so none of them can be somebody's account.
		for (const steamId of ['76561198000000001', '76561199999999999', '76561197000000001']) {
			expect(deviceIdFor(steamId)).toBe(SteamTotp.getDeviceID(steamId));
		}
	});
});
