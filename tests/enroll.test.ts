import { describe, expect, it } from 'vitest';
import { EnrollmentError, finalizeEnrollment, startEnrollment } from '../src/main/steam/enroll';
import { toMaFile, maFileName } from '../src/main/import/export';
import { parseMaFile } from '../src/main/import/mafile';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';
import type { Account } from '../src/shared/vault-schema';

/**
 * Attaching a new authenticator (§12 F3).
 *
 * The tests that matter here are about the half-finished state. `AddAuthenticator`
 * changes the account before anything is stored, so the interesting question is
 * never "does the happy path work" — it is what the caller is told when Steam
 * accepts the request and the reply is incomplete, because that is the case where
 * an account ends up protected by a secret nobody holds.
 */

const STEAM_ID = '76561198000000001';
const ACCESS = 'access-token-value';
const NOW_SECONDS = 1_800_000_000;

/** Twenty bytes, base64 — the shape Steam actually issues. */
const SHARED = 'ASNFZ4mrze8BI0VniavN7wEjRWc=';
const IDENTITY = '/ty6mHZUMhD+3LqYdlQyEP7cupg=';

function transportReturning(
	bodies: unknown[],
	sent: SteamRequest[] = []
): { transport: (request: SteamRequest) => Promise<SteamResponse>; sent: SteamRequest[] } {
	let call = 0;
	return {
		sent,
		transport: (request: SteamRequest) => {
			sent.push(request);
			const body = bodies[Math.min(call, bodies.length - 1)];
			call += 1;
			return Promise.resolve({
				status: 200,
				text: typeof body === 'string' ? body : JSON.stringify(body)
			});
		}
	};
}

const okAdd = {
	response: {
		status: 1,
		shared_secret: SHARED,
		identity_secret: IDENTITY,
		revocation_code: 'R12345',
		serial_number: '123456789',
		account_name: 'trader',
		token_gid: 'abc123',
		uri: 'otpauth://totp/Steam:trader?secret=X&issuer=Steam',
		phone_number_hint: '1234'
	}
};

describe('starting enrollment', () => {
	it('returns every secret Steam issued', async () => {
		const { transport } = transportReturning([okAdd]);

		const started = await startEnrollment(transport, {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: NOW_SECONDS
		});

		expect(started.sharedSecret).toBe(SHARED);
		expect(started.identitySecret).toBe(IDENTITY);
		expect(started.revocationCode).toBe('R12345');
		expect(started.phoneNumberHint).toBe('1234');
		// Derived, not taken from the reply — Steam does not validate it (F-02).
		expect(started.deviceId).toMatch(/^android:/);
	});

	it('asks Steam to use the phone already on the account', async () => {
		// This app never manages phone numbers, and no library in the ecosystem
		// does either (F-10). `sms_phone_id: 1` is how you say "the one you have".
		const { transport, sent } = transportReturning([okAdd]);

		await startEnrollment(transport, {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: NOW_SECONDS
		});

		expect(sent[0]?.body?.get('sms_phone_id')).toBe('1');
		expect(sent[0]?.body?.get('authenticator_type')).toBe('1');
		expect(sent[0]?.url).toContain('AddAuthenticator');
	});

	it('sends the access token, and never as a cookie', async () => {
		const { transport, sent } = transportReturning([okAdd]);

		await startEnrollment(transport, {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: NOW_SECONDS
		});

		expect(sent[0]?.url).toContain(`access_token=${ACCESS}`);
		expect(sent[0]?.cookie).toBe('');
	});

	/**
	 * The case this module exists to handle carefully.
	 *
	 * Steam has accepted the request, so the account now HAS an authenticator —
	 * and the reply did not carry the secret for it. Reporting a generic failure
	 * would leave the user retrying against an account that is already locked.
	 */
	it('says plainly when Steam accepted but withheld the secrets', async () => {
		for (const missing of ['shared_secret', 'identity_secret', 'revocation_code']) {
			const partial = { response: { ...okAdd.response } };
			delete (partial.response as Record<string, unknown>)[missing];

			const { transport } = transportReturning([partial]);

			await expect(
				startEnrollment(transport, {
					steamId64: STEAM_ID,
					accessToken: ACCESS,
					unixSeconds: NOW_SECONDS
				}),
				missing
			).rejects.toThrow(/Steam Support/);
		}
	});

	it('explains an account that already has an authenticator', async () => {
		const { transport } = transportReturning([{ response: { status: 29 } }]);

		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).rejects.toThrow(/already has an authenticator/);
	});

	it('explains a missing phone number, which is the common refusal', async () => {
		const { transport } = transportReturning([{ response: { status: 9 } }]);

		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).rejects.toThrow(/phone number/);
	});

	it('marks rate limiting as worth retrying and everything else as not', async () => {
		const limited = transportReturning([{ response: { status: 84 } }]);
		const duplicate = transportReturning([{ response: { status: 29 } }]);
		const options = { steamId64: STEAM_ID, accessToken: ACCESS, unixSeconds: NOW_SECONDS };

		await expect(startEnrollment(limited.transport, options)).rejects.toMatchObject({
			permanent: false
		});
		await expect(startEnrollment(duplicate.transport, options)).rejects.toMatchObject({
			permanent: true
		});
	});

	it('reports an unfamiliar EResult with its number rather than inventing a cause', async () => {
		const { transport } = transportReturning([{ response: { status: 4242 } }]);

		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).rejects.toThrow(/4242/);
	});

	it('does not treat an HTML error page as a reply', async () => {
		const { transport } = transportReturning(['<html>gateway timeout</html>']);

		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).rejects.toThrow(EnrollmentError);
	});
});

describe('finalising enrollment', () => {
	const options = {
		steamId64: STEAM_ID,
		accessToken: ACCESS,
		sharedSecret: SHARED,
		activationCode: '55555',
		unixSeconds: NOW_SECONDS
	};

	it('proves the stored secret works by generating a code from it', async () => {
		// The real purpose of this step: if the secret we stored were wrong, this
		// is where it is caught — before the account depends on it.
		const { transport, sent } = transportReturning([{ response: { success: true } }]);

		await finalizeEnrollment(transport, options);

		const code = sent[0]?.body?.get('authenticator_code');
		expect(code).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
		expect(sent[0]?.body?.get('activation_code')).toBe('55555');
		expect(sent[0]?.body?.get('validate_sms_code')).toBe('1');
	});

	it('reports activation', async () => {
		const { transport } = transportReturning([{ response: { success: true } }]);

		expect(await finalizeEnrollment(transport, options)).toEqual({ state: 'activated' });
	});

	it('treats want_more as progress, not failure', async () => {
		// Steam asking for a second code from a later window means the first was
		// accepted. Reporting it as a failure would send the user round the SMS
		// loop again for nothing.
		const { transport } = transportReturning([{ response: { success: false, want_more: true } }]);

		expect(await finalizeEnrollment(transport, options)).toEqual({ state: 'wantMore' });
	});

	it('reports a rejected activation code as retryable', async () => {
		const { transport } = transportReturning([{ response: { success: false, status: 2 } }]);

		await expect(finalizeEnrollment(transport, options)).rejects.toMatchObject({
			permanent: false
		});
	});

	it('warns that state is uncertain when the reply is unreadable', async () => {
		// The authenticator may or may not be active. Saying either would be a
		// guess about an account the user cannot afford guesses on.
		const { transport } = transportReturning(['not json']);

		await expect(finalizeEnrollment(transport, options)).rejects.toThrow(/may or may not/);
	});
});

describe('exporting a maFile', () => {
	const account: Account = {
		steamId64: '76561199999999999',
		accountName: 'trader',
		sharedSecret: SHARED,
		identitySecret: IDENTITY,
		revocationCode: 'R12345',
		deviceId: 'android:1234',
		serialNumber: '123456789',
		tokenGid: 'abc123',
		uri: 'otpauth://totp/Steam:trader',
		refreshToken: 'a-live-credential',
		status: 'active',
		addedAt: '2026-08-01T00:00:00.000Z',
		autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
	};

	it('writes the shape the rest of the ecosystem reads', () => {
		const parsed = JSON.parse(toMaFile(account)) as Record<string, unknown>;

		expect(parsed.shared_secret).toBe(SHARED);
		expect(parsed.identity_secret).toBe(IDENTITY);
		expect(parsed.revocation_code).toBe('R12345');
		expect(parsed.account_name).toBe('trader');
		expect(parsed.fully_enrolled).toBe(true);
		// Deliberately NOT asserted through `JSON.parse`. A number literal for this
		// value loses precision in the test itself, so comparing parsed-to-literal
		// passes while both sides are equally wrong. The text is the only honest
		// check, and it is the next test.
		expect(parsed.Session).toBeTypeOf('object');
	});

	it('never exports the refresh token', () => {
		// A maFile is a backup. One that also logs somebody in is a different and
		// worse object — the secrets alone are enough to restore an authenticator,
		// which is what an export is for.
		const text = toMaFile(account);

		expect(text).not.toContain('a-live-credential');
		expect(text).not.toContain('refresh');
	});

	it('keeps the SteamID exact despite the format storing it as a number', () => {
		// F-01 in reverse, and safe only because it is written from a string we
		// already hold rather than one that has been through JSON.parse.
		const text = toMaFile(account);

		expect(text).toContain('76561199999999999');
		expect(text).not.toContain('76561200000000000');
	});

	it('emits every key even when the value is absent', () => {
		// Tools index on these keys; a missing one reads as a corrupt file rather
		// than an absent value.
		const sparse: Account = { ...account };
		delete sparse.serialNumber;
		delete sparse.uri;
		delete sparse.revocationCode;

		const parsed = JSON.parse(toMaFile(sparse)) as Record<string, unknown>;

		expect(parsed).toHaveProperty('serial_number', '');
		expect(parsed).toHaveProperty('uri', '');
		expect(parsed).toHaveProperty('revocation_code', '');
	});

	it('names the file the way the ecosystem expects', () => {
		expect(maFileName(account)).toBe('76561199999999999.maFile');
	});

	it('round-trips through the importer', () => {
		// The strongest thing that can be said about an export: our own parser,
		// which was written against real SDA files, reads it back unchanged —
		// including the SteamID, which is the value most easily corrupted in both
		// directions (F-01).
		const parsed = parseMaFile(toMaFile(account), maFileName(account), Date.now());

		expect(parsed.steamId64).toBe('76561199999999999');
		expect(parsed.sharedSecret).toBe(SHARED);
		expect(parsed.identitySecret).toBe(IDENTITY);
		expect(parsed.revocationCode).toBe('R12345');
	});
});

/**
 * Regression: activation assumed a phone number existed.
 *
 * F-10 recorded phone-free enrollment as plausible but **UNVERIFIED — needs live
 * run**, and flagged that McKay's own example only mentions SMS
 * `if (response.phone_number_hint)`. A live run against a phoneless account
 * settled it: Steam attaches the authenticator happily and delivers the
 * activation code by email instead.
 *
 * The code sent `validate_sms_code: 1` unconditionally, which asks Steam to
 * check something it never texted, and the screen told the user to look at a
 * phone they do not have.
 */
describe('an account with no phone number', () => {
	const base = {
		steamId64: STEAM_ID,
		accessToken: ACCESS,
		sharedSecret: SHARED,
		activationCode: '55555',
		unixSeconds: NOW_SECONDS
	};

	it('enrols without one, and reports no phone hint', async () => {
		const withoutPhone = { response: { ...okAdd.response } };
		delete (withoutPhone.response as Record<string, unknown>).phone_number_hint;

		const { transport } = transportReturning([withoutPhone]);
		const started = await startEnrollment(transport, {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: NOW_SECONDS
		});

		expect(started.revocationCode).toBe('R12345');
		expect(started.phoneNumberHint).toBeUndefined();
	});

	it('does not claim an SMS code when none was sent', async () => {
		const { transport, sent } = transportReturning([{ response: { success: true } }]);

		await finalizeEnrollment(transport, { ...base, validateSmsCode: false });

		expect(sent[0]?.body?.get('validate_sms_code')).toBeNull();
		// Everything else is unchanged: the code still has to be proven.
		expect(sent[0]?.body?.get('activation_code')).toBe('55555');
		expect(sent[0]?.body?.get('authenticator_code')).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
	});

	it('still claims it when there was a phone to text', async () => {
		const { transport, sent } = transportReturning([{ response: { success: true } }]);

		await finalizeEnrollment(transport, { ...base, validateSmsCode: true });

		expect(sent[0]?.body?.get('validate_sms_code')).toBe('1');
	});

	it('mentions email in the refusal, since that is where the code came from', async () => {
		const { transport } = transportReturning([{ response: { success: false, status: 2 } }]);

		await expect(
			finalizeEnrollment(transport, { ...base, validateSmsCode: false })
		).rejects.toThrow(/email/);
	});
});
