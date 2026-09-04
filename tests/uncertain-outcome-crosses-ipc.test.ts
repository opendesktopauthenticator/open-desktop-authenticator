import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/channels';
import { EnrollmentError } from '../src/main/steam/enroll';
import { EnrollmentCleanupError, type EnrollmentService } from '../src/main/steam/enrollment';

/**
 * **"Do not try again", and a button that tries again.**
 *
 * `EnrollmentError` carries `committed` — the request reached Steam and the
 * reply did not — and it never left the main process. An error crosses IPC as a
 * message and nothing else, so the screens received the sentence "check the
 * account before trying again", cleared `busy`, and re-enabled the very control
 * that sends the request a second time. For an activation that is a second
 * authenticator attached; for a removal, a second detach.
 *
 * The text forbade the retry the application was offering, which is worse than
 * either saying nothing or offering the retry plainly.
 *
 * It travels as an *outcome* now rather than as an error, and the difference is
 * exactly what the screen must offer: a thrown error is something a form
 * recovers from by letting the user submit again, and this is the one result
 * where submitting again is the harm.
 *
 * These drive the real handlers. The screens' half — a form replaced by the
 * guidance — is a render branch that needs effects to reach, which this project
 * has no runner for; what is asserted here is that the state arrives at all,
 * which is what was missing.
 */

const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string) => handlers.delete(channel)
	},
	dialog: {},
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { memoryOperationJournal } from '../src/main/steam/operation-journal';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import type { VaultService } from '../src/main/vault/service';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const STEAM_ID = '76561198000000001';
const GUIDANCE =
	'Steam was asked to remove the authenticator and did not answer, so this application cannot ' +
	'tell whether it did.';
const VAULT_ACCOUNT = {
	steamId64: STEAM_ID,
	accountName: 'trader',
	sharedSecret: Buffer.alloc(20, 1).toString('base64')
};

const vault = {
	isUnlocked: () => true,
	touch: () => undefined,
	read: () => ({ accounts: [VAULT_ACCOUNT] }),
	// `enrollBegin` reads this before it does anything: an enrolment with no
	// proxy is refused outright when the vault demands one.
	settings: () => ({ requireProxies: false })
} as unknown as VaultService;

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

/** Register with an enrollment service that fails in a chosen way. */
function withEnrollment(overrides: Partial<EnrollmentService>): void {
	registerEnrollmentHandlers(
		overrides as EnrollmentService,
		vault,
		{ show: () => Promise.resolve(undefined) },
		undefined,
		undefined,
		undefined,
		memoryOperationJournal()
	);
}

describe('an activation Steam may already have completed', () => {
	it('comes back as an outcome rather than a thrown error', async () => {
		withEnrollment({
			activate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		const result = (await handler(EVENT, { steamId64: STEAM_ID, code: '12345' })) as {
			state: string;
			guidance?: string;
		};

		expect(
			result.state,
			'the outcome was thrown, so the screen cleared busy and re-enabled the button that sends ' +
				'the activation a second time'
		).toBe('uncertain');
		expect(result.guidance, 'nothing told the user what to do instead').toBe(GUIDANCE);
	});

	/* An ordinary failure is still an ordinary failure. */
	it('still throws when the outcome is known', async () => {
		withEnrollment({
			activate: () => Promise.reject(new EnrollmentError('that code is wrong', false, false))
		});
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		await expect(handler(EVENT, { steamId64: STEAM_ID, code: '12345' })).rejects.toThrow(
			/that code is wrong/
		);
	});

	it('still reports an ordinary success', async () => {
		withEnrollment({ activate: () => Promise.resolve('activated' as const) });
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		expect(await handler(EVENT, { steamId64: STEAM_ID, code: '12345' })).toEqual({
			state: 'activated'
		});
	});
});

describe('a removal Steam may already have performed', () => {
	const request = {
		steamId64: STEAM_ID,
		passphrase: 'a passphrase long enough',
		acknowledgement: 'REMOVE STEAM GUARD'
	};

	it('comes back as an outcome rather than a thrown error', async () => {
		withEnrollment({
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, request)) as { state?: string; guidance?: string };

		expect(
			result.state,
			'the outcome was thrown, so the screen re-enabled the control that detaches the ' +
				'authenticator a second time'
		).toBe('uncertain');
		expect(result.guidance).toBe(GUIDANCE);
	});

	it('still throws when the outcome is known', async () => {
		withEnrollment({
			deactivate: () => Promise.reject(new EnrollmentError('that revocation code is wrong', false))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		await expect(handler(EVENT, request)).rejects.toThrow(/revocation code/);
	});
});

/**
 * **And the add itself, which was the one left out.**
 *
 * `enrollActivate` and `accountDeactivate` were wired to return their committed
 * failures as outcomes. `enrollBegin` and `enrollEmailCode` were not — they
 * returned the service call bare — so the irreversible operation at the front of
 * the flow kept the behaviour the other two had fixed: a timeout on
 * `AddAuthenticator`, which is sent before anything can go wrong with the
 * answer, crossed IPC as an ordinary error and the screen put the form back with
 * the submit live under a message saying not to try again.
 *
 * The response schema could not have carried it either: `enrollBeginResponse`
 * was a two-member union and the router validates what a handler returns, so
 * returning an outcome would have been refused as a contract violation.
 */
describe('an AddAuthenticator that may already have attached one', () => {
	const CREDENTIALS = { accountName: 'trader', password: 'a password' };

	it('comes back from enrollBegin as an outcome rather than a thrown error', async () => {
		withEnrollment({
			begin: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.enrollBegin);
		if (!handler) throw new Error('enrollBegin was not registered');

		const result = (await handler(EVENT, CREDENTIALS)) as { state: string; guidance?: string };

		expect(
			result.state,
			'the outcome was thrown, so the screen cleared busy and re-enabled the control that sends ' +
				'AddAuthenticator a second time'
		).toBe('uncertain');
		expect(result.guidance).toBe(GUIDANCE);
	});

	it('comes back from enrollEmailCode too', async () => {
		withEnrollment({
			submitEmailCode: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.enrollEmailCode);
		if (!handler) throw new Error('enrollEmailCode was not registered');

		const result = (await handler(EVENT, { code: '12345' })) as { state: string };

		expect(result.state, 'the email-code path reaches the same irreversible call').toBe(
			'uncertain'
		);
	});

	/**
	 * **And "Steam definitely did this" is not the same sentence as "nobody can
	 * tell".**
	 *
	 * Two branches know exactly what happened: Steam answered `ok` without the
	 * secrets, and Steam returned them and the vault write failed. The screen's
	 * panel said "Nothing here can tell whether Steam acted" for every case, which
	 * would be false for both — and the second is carrying the only copy of a
	 * revocation code that exists.
	 */
	it('says so when Steam is known to have acted', async () => {
		withEnrollment({
			begin: () =>
				Promise.reject(
					new EnrollmentError(
						'Steam attached the authenticator, but it could not be saved',
						true,
						true,
						true
					)
				)
		});
		const handler = handlers.get(CHANNELS.enrollBegin);
		if (!handler) throw new Error('enrollBegin was not registered');

		const result = (await handler(EVENT, CREDENTIALS)) as { state: string; certain?: boolean };

		expect(result.state).toBe('uncertain');
		expect(
			result.certain,
			'a certainty was flattened into a maybe, so the screen tells someone whose authenticator ' +
				'Steam definitely attached that nothing can tell whether it did'
		).toBe(true);
	});

	it('does not claim certainty for a lost reply', async () => {
		withEnrollment({
			begin: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.enrollBegin);
		if (!handler) throw new Error('enrollBegin was not registered');

		const result = (await handler(EVENT, CREDENTIALS)) as { certain?: boolean };

		expect(result.certain, 'a lost reply was reported as a known outcome').not.toBe(true);
	});

	/* An ordinary refusal is still an ordinary refusal. */
	it('still throws when the request never went', async () => {
		withEnrollment({
			begin: () => Promise.reject(new EnrollmentError('that password is wrong', false, false))
		});
		const handler = handlers.get(CHANNELS.enrollBegin);
		if (!handler) throw new Error('enrollBegin was not registered');

		await expect(handler(EVENT, CREDENTIALS)).rejects.toThrow(/password is wrong/);
	});

	it('returns same-session cleanup debt instead of leaving the form at a dead end', async () => {
		withEnrollment({
			begin: () => Promise.reject(new EnrollmentCleanupError('clear the local safety record')),
			unresolvedEnrollment: () =>
				({
					attemptId: '11111111-1111-4111-8111-111111111111',
					steamId64: STEAM_ID,
					accountName: 'trader',
					kind: 'enrollment-add',
					state: 'not-attached',
					at: '2026-09-02T00:00:00.000Z'
				}) as never,
			recoveryState: () => undefined,
			enrollmentStoredFaithfully: () => false
		});
		const handler = handlers.get(CHANNELS.enrollBegin);
		if (!handler) throw new Error('enrollBegin was not registered');

		await expect(handler(EVENT, CREDENTIALS)).resolves.toMatchObject({
			state: 'uncertain',
			guidance: 'clear the local safety record',
			persisted: true,
			stored: false,
			enrollmentState: 'not-attached',
			attemptId: '11111111-1111-4111-8111-111111111111'
		});
	});

	it('returns stored cleanup debt from Save it now instead of claiming enrollment finished', async () => {
		withEnrollment({
			retryEnrollmentPersist: () =>
				Promise.reject(new EnrollmentCleanupError('stored, but cleanup is still owed', true)),
			unresolvedEnrollment: () =>
				({
					attemptId: '11111111-1111-4111-8111-111111111111',
					steamId64: STEAM_ID,
					accountName: 'trader',
					kind: 'enrollment-add',
					state: 'recoverable',
					at: '2026-09-02T00:00:00.000Z'
				}) as never,
			recoveryState: () => 'durable',
			enrollmentRecoveryUsable: () => true,
			enrollmentStoredFaithfully: () => true
		});
		const handler = handlers.get(CHANNELS.enrollRetryPersist);
		if (!handler) throw new Error('enrollRetryPersist was not registered');

		await expect(
			handler(EVENT, {
				attemptId: '11111111-1111-4111-8111-111111111111',
				steamId64: STEAM_ID
			})
		).resolves.toMatchObject({
			state: 'uncertain',
			guidance: 'stored, but cleanup is still owed',
			certain: true,
			persisted: true,
			stored: true,
			recovery: 'durable',
			enrollmentState: 'recoverable'
		});
	});

	it('returns stored cleanup debt from the initial save too', async () => {
		withEnrollment({
			begin: () =>
				Promise.reject(new EnrollmentCleanupError('initial save left cleanup debt', true)),
			unresolvedEnrollment: () =>
				({
					attemptId: '22222222-2222-4222-8222-222222222222',
					steamId64: STEAM_ID,
					accountName: 'trader',
					kind: 'enrollment-add',
					state: 'recoverable',
					at: '2026-09-02T00:00:00.000Z'
				}) as never,
			recoveryState: () => 'durable',
			enrollmentRecoveryUsable: () => true,
			enrollmentStoredFaithfully: () => true
		});
		const handler = handlers.get(CHANNELS.enrollBegin);
		if (!handler) throw new Error('enrollBegin was not registered');

		await expect(handler(EVENT, CREDENTIALS)).resolves.toMatchObject({
			state: 'uncertain',
			certain: true,
			stored: true,
			enrollmentState: 'recoverable'
		});
	});

	it('restores same-process certainty through enrollment status after the screen is reopened', async () => {
		withEnrollment({
			unresolvedEnrollment: () =>
				({
					attemptId: '33333333-3333-4333-8333-333333333333',
					steamId64: STEAM_ID,
					accountName: 'trader',
					kind: 'enrollment-add',
					state: 'sending',
					at: '2026-09-02T00:00:00.000Z'
				}) as never,
			recoveryState: () => undefined,
			enrollmentStoredFaithfully: () => false,
			enrollmentKnownAttached: () => true
		});
		const handler = handlers.get(CHANNELS.enrollStatus);
		if (!handler) throw new Error('enrollStatus was not registered');

		await expect(handler(EVENT, {})).resolves.toMatchObject({
			pending: { state: 'sending', stored: false, certain: true }
		});
	});

	it('still reports an ordinary success', async () => {
		withEnrollment({
			begin: () => Promise.resolve({ state: 'needsEmailCode' as const })
		});
		const handler = handlers.get(CHANNELS.enrollBegin);
		if (!handler) throw new Error('enrollBegin was not registered');

		expect(await handler(EVENT, CREDENTIALS)).toEqual({ state: 'needsEmailCode' });
	});
});
