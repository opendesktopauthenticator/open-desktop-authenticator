import { describe, expect, it } from 'vitest';
import {
	EnrollmentError,
	finalizeEnrollment,
	removeAuthenticator,
	startEnrollment
} from '../src/main/steam/enroll';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';

/**
 * **What the reply proves, and what the message claims.**
 *
 * Every one of these took a status Steam returned and turned it into a specific
 * cause with a specific instruction. That is the right instinct — a user told
 * "enrollment failed" has nowhere to go — and it was applied to statuses that do
 * not carry the cause it named:
 *
 *   - EResult 29 became "an authenticator in the Steam mobile app", when the
 *     reply says only that one is attached. It could be SDA, or this
 *     application on another machine.
 *   - EResult 9 became "Steam needs a confirmed phone number", stated as fact.
 *     It is `NoMatch`, which Steam reuses widely.
 *   - Any unrecognised status became "Steam refused", which is a reading of a
 *     number nothing here understands.
 *   - Every non-ok status on the activation call became "check the activation
 *     code" — including rate limiting, where Steam never looked at the code, and
 *     a malformed request, which is this application's fault.
 *   - A bare `success: false` on the removal became "Steam did not accept that
 *     revocation code. Check it character by character."
 *
 * The cost is not politeness. Each one sends the user to do something that
 * cannot help — re-verify a phone that was fine, retype a code Steam never read
 * — and the real cause goes unmentioned while they do it.
 *
 * These assert on the message the caller actually receives, which is the thing
 * the user reads.
 */

const STEAM_ID = '76561198000000001';
const ACCESS = 'access-token-value';

function transportReturning(body: unknown): (request: SteamRequest) => Promise<SteamResponse> {
	return () => Promise.resolve({ status: 200, text: JSON.stringify(body) });
}

/** The message from a call that is expected to fail. */
async function messageFrom(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (err) {
		expect(err).toBeInstanceOf(EnrollmentError);
		return (err as EnrollmentError).message;
	}
	throw new Error('the call succeeded, so there is no message to check');
}

const add = (status: number) =>
	messageFrom(() =>
		startEnrollment(transportReturning({ response: { status } }), {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			unixSeconds: 1_800_000_000
		})
	);

describe('an account that already has an authenticator', () => {
	it('does not say which application it is in', async () => {
		const message = await add(29);

		expect(
			message.includes('authenticator in the Steam mobile app'),
			'Steam says one is attached and nothing more. Naming the mobile app sends someone who ' +
				'has never installed it looking for a screen they cannot reach'
		).toBe(false);
		expect(message, 'and the possibility it is somewhere else is not mentioned').toMatch(
			/or in|another application|elsewhere/i
		);
	});

	/* The advice is the same either way, and it is the point of the message. */
	it('still points at Move rather than remove', async () => {
		expect(await add(29)).toMatch(/Move an authenticator/i);
	});
});

describe('EResult 9 on the add', () => {
	it('offers the phone number as the likely cause rather than the cause', async () => {
		const message = await add(9);

		expect(
			message,
			'EResult 9 is NoMatch, which Steam reuses widely. Stated as a fact, it sends a user ' +
				'whose phone is already confirmed to re-verify a number that was never the problem'
		).toMatch(/usual cause|likeliest|usually|often/i);
		expect(message, 'and the likeliest cause is still worth naming').toMatch(/phone number/i);
	});
});

describe('a status this application does not recognise', () => {
	it('is not reported as a refusal', async () => {
		const message = await add(84_211);

		expect(
			message,
			'nothing here knows what this status means, so calling it a refusal is a reading of a ' +
				'number rather than a report of one'
		).not.toMatch(/refused/i);
		expect(message, 'and the status itself is not passed on').toContain('84211');
	});

	/* What *is* known is the outcome, and it is the part the user needs. */
	it('still says no authenticator was added', async () => {
		expect(await add(84_211)).toMatch(/no authenticator was added/i);
	});
});

const activate = (status: number) =>
	messageFrom(() =>
		finalizeEnrollment(transportReturning({ response: { status, success: false } }), {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			sharedSecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
			activationCode: '12345',
			unixSeconds: 1_800_000_000
		})
	);

/**
 * Whether the message tells the reader to go and check the activation code.
 *
 * The instruction, not the words: "Steam did not check the code at all" is the
 * opposite claim and contains the same phrase.
 */
function tellsThemToCheckTheCode(message: string): boolean {
	const lower = message.toLowerCase();
	return ['check the code', 'check it character', 'check that code'].some((instruction) =>
		lower.includes(instruction)
	);
}

describe('an activation Steam declined for a reason other than the code', () => {
	it('does not blame the code when Steam was rate-limiting', async () => {
		const message = await activate(84);

		expect(
			tellsThemToCheckTheCode(message),
			'Steam never looked at the code, and the user was told to check it — so they retype a ' +
				'correct code until Steam stops answering at all'
		).toBe(false);
		expect(message).toMatch(/rate-limit/i);
	});

	it('does not blame the code when the request was malformed', async () => {
		const message = await activate(8);

		expect(
			tellsThemToCheckTheCode(message),
			'this is a bug in this application, not a mistyped code'
		).toBe(false);
		expect(message).toMatch(/bug in this app/i);
	});

	/* And an unrecognised status still gives the user the one thing they can try. */
	it('names the code as a possibility for a status it does not recognise', async () => {
		const message = await activate(84_211);

		expect(message).toContain('84211');
		expect(message).toMatch(/mistyped/i);
	});
});

const remove = (body: Record<string, unknown>) =>
	messageFrom(() =>
		removeAuthenticator(transportReturning({ response: body }), {
			steamId64: STEAM_ID,
			accessToken: ACCESS,
			revocationCode: 'R12345'
		})
	);

describe('a removal Steam refused without counting an attempt', () => {
	it('does not state that the revocation code was rejected', async () => {
		const message = await remove({ success: false });

		expect(
			message,
			'Steam refuses this call for reasons that have nothing to do with the code — rate ' +
				'limiting, an account restriction, a recent password change — and a user told to check ' +
				'it character by character does that instead of finding the real cause'
		).not.toMatch(/did not accept that revocation code/);
		expect(message, 'and the likeliest cause is still named').toMatch(/likeliest cause/i);
	});

	/**
	 * And where it *was* measured it is still stated plainly:
	 * `revocation_attempts_remaining` is Steam counting down against a code it
	 * checked and rejected.
	 */
	it('does state it when Steam counted the attempt', async () => {
		const message = await remove({ success: false, revocation_attempts_remaining: 4 });

		expect(message).toMatch(/did not accept that revocation code/);
		expect(message).toContain('4');
	});
});
