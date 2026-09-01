import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/channels';
import { EnrollmentError } from '../src/main/steam/enroll';

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
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { VaultService } from '../src/main/vault/service';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const STEAM_ID = '76561198000000001';
const GUIDANCE =
	'Steam was asked to remove the authenticator and did not answer, so this application cannot ' +
	'tell whether it did.';

const vault = {
	isUnlocked: () => true,
	touch: () => undefined,
	read: () => ({ accounts: [] })
} as unknown as VaultService;

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

/** Register with an enrollment service that fails in a chosen way. */
function withEnrollment(overrides: Partial<EnrollmentService>): void {
	registerEnrollmentHandlers(overrides as EnrollmentService, vault, {
		show: () => Promise.resolve(undefined)
	});
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
