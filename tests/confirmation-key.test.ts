import { describe, expect, it } from 'vitest';
import {
	CONFIRMATION_TAGS,
	ConfirmationKeyError,
	deviceIdFor,
	generateConfirmationKey
} from '../src/main/confirmations/key';

/**
 * Confirmation keys (§12 F5).
 *
 * Vectors produced by `steam-totp` and pinned here so this suite stands alone;
 * the broad comparison across thousands of times and every tag lives in
 * `spike/tests/confirmation-key-parity.test.ts`, where that library is installed.
 *
 * A confirmation key authorises an operation that can move somebody's inventory.
 * The tag binding is the part that matters most: a key minted to *read* the
 * pending list must not be usable to *approve* anything on it.
 */

/** Twenty bytes, base64. Not a real account's identity secret. */
const IDENTITY = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
const TIME = 1_700_000_000;

describe('known answers', () => {
	it.each([
		['list', 'L/ffkbuB9f4s6uhxZ9AxRf3CSS4='],
		['detail', 'j4kGGgPMOnrO/Xd2rvXwK4C1rog='],
		['accept', 'bjIMabnfzbAatLClUSDOxFNe1/I='],
		['reject', 'vAsL5czW7psOCHcPBgd8ZROgnTY=']
	])('tag %s produces a stable key', (tag, expected) => {
		expect(generateConfirmationKey(IDENTITY, TIME, tag as never)).toBe(expected);
	});
});

describe('the tag binds the key to one operation', () => {
	it('produces a different key for each tag at the same instant', () => {
		// This is what stops a captured list request being replayed as an approval.
		const keys = Object.values(CONFIRMATION_TAGS).map((tag) =>
			generateConfirmationKey(IDENTITY, TIME, tag)
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('refuses to sign without one', () => {
		expect(() => generateConfirmationKey(IDENTITY, TIME, '' as never)).toThrow(
			ConfirmationKeyError
		);
	});
});

describe('the time binds the key to one moment', () => {
	it('changes every second', () => {
		expect(generateConfirmationKey(IDENTITY, TIME, 'accept')).not.toBe(
			generateConfirmationKey(IDENTITY, TIME + 1, 'accept')
		);
	});

	it('refuses a nonsensical time rather than signing something meaningless', () => {
		for (const time of [Number.NaN, Number.POSITIVE_INFINITY, -1, -1_700_000_000]) {
			expect(() => generateConfirmationKey(IDENTITY, time, 'accept')).toThrow(ConfirmationKeyError);
		}
	});

	it('handles a time beyond 32 bits', () => {
		// Written as two halves like the TOTP counter; a single writeUInt32BE would
		// silently truncate.
		const far = 2 ** 32 + 12_345;
		expect(() => generateConfirmationKey(IDENTITY, far, 'accept')).not.toThrow();
		expect(generateConfirmationKey(IDENTITY, far, 'accept')).not.toBe(
			generateConfirmationKey(IDENTITY, 12_345, 'accept')
		);
	});
});

describe('the identity secret', () => {
	it('is validated exactly as the shared secret is', () => {
		// One rule, not two — a laxer second copy is how a damaged secret gets
		// through on one path and not the other.
		for (const bad of ['', '   ', 'not base64 !!', Buffer.alloc(16).toString('base64')]) {
			expect(() => generateConfirmationKey(bad, TIME, 'accept')).toThrow(ConfirmationKeyError);
		}
	});

	it('names the identity secret in the error, not the shared secret', () => {
		try {
			generateConfirmationKey('not-valid', TIME, 'accept');
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfirmationKeyError);
			expect((err as Error).message).toMatch(/identity secret/i);
			expect((err as Error).message).not.toMatch(/shared secret/i);
		}
	});

	it('accepts the hex form, as the shared secret does', () => {
		const hex = Buffer.from(IDENTITY, 'base64').toString('hex');
		expect(generateConfirmationKey(hex, TIME, 'accept')).toBe(
			generateConfirmationKey(IDENTITY, TIME, 'accept')
		);
	});

	it('never appears in the key it produces', () => {
		const key = generateConfirmationKey(IDENTITY, TIME, 'accept');
		expect(key).not.toContain(IDENTITY.slice(0, 8));
	});
});

describe('device id', () => {
	it('is derived from the SteamID, not stored', () => {
		// F-02: Steam does not validate this, and the value in an imported maFile is
		// kept only for export fidelity. Deriving it means an account imported from a
		// file that never had one behaves identically to one that did.
		expect(deviceIdFor('76561198000000001')).toMatch(
			/^android:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
	});

	it('is stable for one account and different across accounts', () => {
		expect(deviceIdFor('76561198000000001')).toBe(deviceIdFor('76561198000000001'));
		expect(deviceIdFor('76561198000000001')).not.toBe(deviceIdFor('76561198000000002'));
	});

	it('refuses anything that is not a SteamID', () => {
		for (const bad of ['', 'not-an-id', '76561198000000001; DROP', '1e10']) {
			expect(() => deviceIdFor(bad)).toThrow(ConfirmationKeyError);
		}
	});
});
