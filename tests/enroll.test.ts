import { describe, expect, it } from 'vitest';
import {
	EnrollmentError,
	EnrollmentSecretsError,
	finalizeEnrollment,
	removeAuthenticator,
	startEnrollment
} from '../src/main/steam/enroll';
import { toMaFile, maFileName } from '../src/main/import/export';
import { parseMaFile } from '../src/main/import/mafile';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';
import { EgressError } from '../src/main/net/egress';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

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

	it('preserves the optional secret_1 field for maFile fidelity', async () => {
		const secret1 = Buffer.alloc(20, 9).toString('base64');
		const { transport } = transportReturning([
			{ response: { ...okAdd.response, secret_1: secret1 } }
		]);
		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).resolves.toMatchObject({ secret1 });
	});

	it('preserves a complete one-time bundle even when status contradicts it', async () => {
		const contradictory = { response: { ...okAdd.response, status: 29 } };
		const { transport } = transportReturning([contradictory]);
		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).resolves.toMatchObject({
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			revocationCode: 'R12345'
		});
	});

	it.each([
		['malformed login secret', 'not base64!', IDENTITY],
		['short login secret', 'YQ==', IDENTITY],
		['malformed confirmation secret', SHARED, 'not base64!'],
		['short confirmation secret', SHARED, 'YQ==']
	])('retains but refuses a complete-looking bundle with a %s', async (_case, shared, identity) => {
		const reply = {
			response: {
				...okAdd.response,
				shared_secret: shared,
				identity_secret: identity
			}
		};
		const { transport } = transportReturning([reply]);

		const thrown = await startEnrollment(transport, {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: NOW_SECONDS
		}).then(
			() => undefined,
			(err: unknown) => err
		);

		expect(thrown).toBeInstanceOf(EnrollmentSecretsError);
		expect(thrown).toMatchObject({
			committed: true,
			started: {
				sharedSecret: shared,
				identitySecret: identity,
				revocationCode: 'R12345'
			}
		});
	});

	it.each([
		['missing', undefined],
		['a string', '1'],
		['null', null]
	])('keeps a complete usable bundle when status is %s', async (_case, status) => {
		const response: Record<string, unknown> = { ...okAdd.response, status };
		if (status === undefined) delete response.status;
		const { transport } = transportReturning([{ response }]);

		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).resolves.toMatchObject({
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			revocationCode: 'R12345'
		});
	});

	it('ignores malformed optional metadata without discarding usable secrets', async () => {
		const { transport } = transportReturning([
			{
				response: {
					...okAdd.response,
					serial_number: 123,
					account_name: null,
					token_gid: {},
					uri: false,
					phone_number_hint: []
				}
			}
		]);

		const started = await startEnrollment(transport, {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: NOW_SECONDS
		});

		expect(started).toMatchObject({
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			revocationCode: 'R12345'
		});
		expect(started).not.toHaveProperty('serialNumber');
		expect(started).not.toHaveProperty('accountName');
		expect(started).not.toHaveProperty('tokenGid');
		expect(started).not.toHaveProperty('uri');
		expect(started).not.toHaveProperty('phoneNumberHint');
	});

	it('omits an oversized phone hint before the one-time bundle is sealed', async () => {
		const { transport } = transportReturning([
			{ response: { ...okAdd.response, phone_number_hint: '1'.repeat(65) } }
		]);

		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).resolves.not.toHaveProperty('phoneNumberHint');
	});

	it('keeps usable authenticator keys when Steam omits the optional revocation code', async () => {
		const response = { ...okAdd.response } as Record<string, unknown>;
		delete response.revocation_code;
		const { transport } = transportReturning([{ response }]);

		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).resolves.toMatchObject({ sharedSecret: SHARED, identitySecret: IDENTITY });
	});

	it('drops oversized optional metadata before it can exceed the recovery journal', async () => {
		const { transport } = transportReturning([
			{
				response: {
					...okAdd.response,
					account_name: 'a'.repeat(65),
					serial_number: '1'.repeat(129),
					token_gid: 'g'.repeat(129),
					uri: 'u'.repeat(8 * 1024 + 1)
				}
			}
		]);

		const started = await startEnrollment(transport, {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: NOW_SECONDS
		});
		expect(started).not.toHaveProperty('accountName');
		expect(started).not.toHaveProperty('serialNumber');
		expect(started).not.toHaveProperty('tokenGid');
		expect(started).not.toHaveProperty('uri');
	});

	it('treats partial secret material with a refusal as indeterminate', async () => {
		const { transport } = transportReturning([{ response: { status: 29, shared_secret: SHARED } }]);
		await expect(
			startEnrollment(transport, {
				steamId64: STEAM_ID,
				accessToken: ACCESS,
				unixSeconds: NOW_SECONDS
			})
		).rejects.toMatchObject({ committed: true, certain: false });
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
		for (const missing of ['shared_secret', 'identity_secret']) {
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
		//
		// Asserted as `committed` rather than on a phrase: this used to match
		// "may or may not", which pinned one sentence and said nothing about
		// whether the caller was allowed to retry on top of it.
		const { transport } = transportReturning(['not json']);

		await expect(finalizeEnrollment(transport, options)).rejects.toMatchObject({
			committed: true,
			permanent: true
		});
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
		autoConfirm: newAutoConfirm()
	};

	it('does not demote a freshly activated account to "never activated"', () => {
		// `pendingRevocationBackup` is the ordinary state of an account that has just
		// been activated — it means "activated, and the code has not been confirmed
		// written down", which is a fact about this application and none of Steam's
		// business. Exporting it as `fully_enrolled: false` told every reader,
		// including our own importer, that the authenticator had never been
		// activated.
		const justActivated: Account = { ...account, status: 'pendingRevocationBackup' };

		const parsed = JSON.parse(toMaFile(justActivated)) as Record<string, unknown>;

		expect(parsed.fully_enrolled).toBe(true);
	});

	it('round-trips a freshly activated account without offering to activate it again', () => {
		// The consequence, end to end: importing the file back must not produce an
		// account the app will try to finalize on Steam a second time.
		const justActivated: Account = { ...account, status: 'pendingRevocationBackup' };

		const reparsed = parseMaFile(toMaFile(justActivated), 'x.maFile', Date.now());

		expect(reparsed.fullyEnrolled).toBe(true);
	});

	it('still marks an account that genuinely never finished', () => {
		const unfinished: Account = { ...account, status: 'pendingActivation' };

		const parsed = JSON.parse(toMaFile(unfinished)) as Record<string, unknown>;

		expect(parsed.fully_enrolled).toBe(false);
	});

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

/**
 * **Every call in this file changes the account before anything can go wrong
 * with the answer.**
 *
 * `AddAuthenticator`, `FinalizeAddAuthenticator` and `RemoveAuthenticator` all
 * send their request and then read a reply. A timeout, a torn connection, a
 * refused proxy, an HTTP error page or an unparseable body all arrive *after*
 * the bytes have gone, and every one of them means the same thing: Steam may
 * have done it.
 *
 * Two ways that was wrong. `startEnrollment` reported an unreadable reply with
 * the words "Nothing was changed", which is a claim about Steam's state that
 * nothing here can make — the account may now carry an authenticator whose
 * secrets were in the reply that never arrived. And a **timeout reached none of
 * these messages at all**: `await transport(...)` rejected with a network error
 * straight past them, so the case where the outcome is least knowable produced
 * the least guidance and an offer to try again.
 *
 * `permanent: true` on all of them is the point rather than a side effect.
 * Retrying is exactly what must not happen until somebody has looked at the
 * account.
 */
describe('a request that was sent and never answered', () => {
	/** A transport that fails the way a timeout does: after the request has gone. */
	function transportFailing(sent: SteamRequest[] = []) {
		return {
			sent,
			transport: (request: SteamRequest): Promise<SteamResponse> => {
				sent.push(request);
				return Promise.reject(new Error('ETIMEDOUT: the connection timed out'));
			}
		};
	}

	const START = { steamId64: STEAM_ID, accessToken: ACCESS, unixSeconds: NOW_SECONDS };
	const FINALIZE = {
		steamId64: STEAM_ID,
		accessToken: ACCESS,
		sharedSecret: SHARED,
		activationCode: '55555',
		unixSeconds: NOW_SECONDS
	};
	const REMOVE = { steamId64: STEAM_ID, accessToken: ACCESS, revocationCode: 'R12345' };

	it.each([
		[
			'adding an authenticator',
			(t: (request: SteamRequest) => Promise<SteamResponse>) => startEnrollment(t, START),
			/add an authenticator and did not answer/
		],
		[
			'activating one',
			(t: (request: SteamRequest) => Promise<SteamResponse>) => finalizeEnrollment(t, FINALIZE),
			/activate the authenticator and did not answer/
		],
		[
			'removing one',
			(t: (request: SteamRequest) => Promise<SteamResponse>) => removeAuthenticator(t, REMOVE),
			/remove the authenticator and did not answer/
		]
	])('reports %s as uncertain rather than failed', async (_what, call, expected) => {
		const { transport, sent } = transportFailing();

		const thrown = await call(transport).then(
			() => undefined,
			(err: unknown) => err
		);

		expect(sent, 'the request never went, so there is nothing uncertain about it').toHaveLength(1);
		expect(thrown).toMatchObject({ committed: true, permanent: true });
		expect(
			(thrown as Error).message,
			'the timeout surfaced as a raw network error, with nothing telling the user the account ' +
				'may already have changed'
		).toMatch(expected);
	});

	it.each([
		[
			'adding an authenticator',
			(t: (r: SteamRequest) => Promise<SteamResponse>) => startEnrollment(t, START)
		],
		[
			'activating one',
			(t: (r: SteamRequest) => Promise<SteamResponse>) => finalizeEnrollment(t, FINALIZE)
		],
		[
			'removing one',
			(t: (r: SteamRequest) => Promise<SteamResponse>) => removeAuthenticator(t, REMOVE)
		]
	])('never claims nothing happened after %s', async (_what, call) => {
		/*
		 * The last two are valid JSON of the wrong shape, which is a different
		 * branch: the first three fail at `JSON.parse` and never reach the schema
		 * check. Without them this test passed while that branch still said
		 * "Nothing was changed".
		 */
		for (const body of ['not json', '<html>502 Bad Gateway</html>', '', '{}', '{"response":{}}']) {
			const { transport } = transportReturning([body]);
			const thrown = (await call(transport).then(
				() => undefined,
				(err: unknown) => err
			)) as Error & { committed?: boolean };

			expect(
				thrown.message,
				`"${body}" was reported as though the account were untouched, and the request had ` +
					'already been sent'
			).not.toMatch(/nothing was changed/i);
			expect(thrown.committed, 'the caller was left free to retry on top of it').toBe(true);
		}
	});
});

/**
 * **A refusal in which nothing was sent must not be reported as one that may
 * have happened.**
 *
 * The uncertainty wrapper was applied to every rejection, on the reasoning that
 * a transport rejects after the bytes have gone. Most of this transport's
 * refusals are the opposite: the routing check that finds Chromium would connect
 * directly, an account closed while a transport was held, a scheme that cannot
 * be carried. Nothing leaves the machine.
 *
 * Those were being reported as "Steam was asked to add an authenticator and did
 * not answer ... if an authenticator was attached, its secrets were in the reply
 * that never arrived ... removing it there, or contacting Steam Support, is the
 * way out". For a proxy the user could fix in ten seconds. And the real cause
 * was appended, then truncated before the sentence naming it.
 *
 * `EgressError` now says whether the request went. Anything that cannot say is
 * treated as sent, because that is the assumption which cannot lose an
 * authenticator.
 */
describe('a refusal that happened before the request was sent', () => {
	const START = { steamId64: STEAM_ID, accessToken: ACCESS, unixSeconds: NOW_SECONDS };

	function transportRefusing(error: Error) {
		let reached = 0;
		return {
			reached: () => reached,
			transport: (): Promise<SteamResponse> => {
				reached += 1;
				return Promise.reject(error);
			}
		};
	}

	it.each([
		[
			'the routing check refuses a direct connection',
			new EgressError(
				'this account is set to route through http://***:***@proxy.example:8080, but this ' +
					'connection would be made directly instead. Refusing to connect.',
				false
			)
		],
		[
			'the account was closed while the transport was held',
			new EgressError('this account was closed before the request was sent', false)
		]
	])('is passed through unchanged when %s', async (_what, error) => {
		const { transport } = transportRefusing(error);

		const thrown = (await startEnrollment(transport, START).then(
			() => undefined,
			(err: unknown) => err
		)) as Error & { committed?: boolean };

		expect(
			thrown.message,
			'a refusal in which no byte left the machine was reported as one where Steam may have ' +
				'attached an authenticator'
		).toBe(error.message);
		expect(thrown, 'and it was marked as committed').not.toHaveProperty('committed', true);
	});

	/*
	 * And the property the wrapper exists for survives: an error that cannot say
	 * whether the request went is still treated as though it did.
	 */
	it('still reports an ordinary network failure as uncertain', async () => {
		const { transport } = transportRefusing(new Error('ETIMEDOUT: the connection timed out'));

		await expect(startEnrollment(transport, START)).rejects.toMatchObject({
			committed: true,
			permanent: true
		});
	});

	it('reports a failure that says the request went as uncertain', async () => {
		const { transport } = transportRefusing(
			new EgressError('the connection to Steam failed (ERR_CONNECTION_RESET)', true)
		);

		await expect(startEnrollment(transport, START)).rejects.toMatchObject({ committed: true });
	});
});
