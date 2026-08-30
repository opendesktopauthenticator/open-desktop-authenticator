import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/channels';

const handlers = new Map<
	string,
	(event: { senderFrame: { url: string } }, request: unknown) => unknown
>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (
			channel: string,
			handler: (event: { senderFrame: { url: string } }, request: unknown) => unknown
		) => handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	},
	dialog: { showSaveDialog: () => Promise.resolve({ canceled: true }) },
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { VaultService } from '../src/main/vault/service';

/**
 * **Enrolling a new authenticator sends a password to Steam, and had no guard.**
 *
 * `Require proxies` is enforced at `SteamTransportFactory.forAccount`, which
 * every Steam request crosses — except the ones that never build a transport.
 * `steam-session` speaks over Node's own HTTP stack, so this call went out from
 * the machine's own address on a vault whose owner had said that must not
 * happen, and answered `{ state: 'needsEmailCode' }` as though it had worked.
 *
 * There is no stored account to read a proxy from: this is the call that
 * creates one. The field on the form is the only route there is, and empty
 * means refused — an account enrolled from the user's own address has already
 * told Steam the thing the proxy existed to hide.
 */

function harness(requireProxies: boolean) {
	const begin = vi.fn().mockResolvedValue({ state: 'needsEmailCode' });
	const vault = {
		isUnlocked: () => true,
		touch: () => undefined,
		settings: () => ({ requireProxies }),
		read: () => ({ accounts: [] })
	} as unknown as VaultService;

	registerEnrollmentHandlers({ begin } as unknown as EnrollmentService, vault, {
		show: () => Promise.resolve(undefined)
	});
	return { begin };
}

function enrol(request: Record<string, unknown>): Promise<unknown> {
	const handler = handlers.get(CHANNELS.enrollBegin);
	if (!handler) {
		throw new Error('enroll:begin was never registered');
	}
	return Promise.resolve(
		handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request)
	);
}

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);
});

describe('enrolling under Require proxies', () => {
	it('refuses when no proxy was given', async () => {
		const { begin } = harness(true);

		await expect(enrol({ accountName: 'alice', password: 'secret' })).rejects.toThrow(
			/require proxies/i
		);

		expect(begin, 'the password went to Steam anyway').not.toHaveBeenCalled();
	});

	/*
	 * How a cleared field arrives from the form, and not the same value as
	 * "absent" to a check written the obvious way.
	 */
	it('refuses an empty proxy field', async () => {
		const { begin } = harness(true);
		await expect(enrol({ accountName: 'alice', password: 'secret', proxyUrl: '' })).rejects.toThrow(
			/require proxies/i
		);
		expect(begin).not.toHaveBeenCalled();
	});

	it('allows one that names a proxy', async () => {
		const { begin } = harness(true);
		await enrol({ accountName: 'alice', password: 'secret', proxyUrl: 'http://10.0.0.9:8080' });
		expect(begin).toHaveBeenCalledWith('alice', 'secret', 'http://10.0.0.9:8080');
	});

	it('changes nothing when the setting is off', async () => {
		const { begin } = harness(false);
		await enrol({ accountName: 'alice', password: 'secret' });
		expect(begin).toHaveBeenCalledWith('alice', 'secret', undefined);
	});

	it('says what to do about it', async () => {
		const { begin } = harness(true);
		await expect(enrol({ accountName: 'alice', password: 'secret' })).rejects.toThrow(/Settings/);
		expect(begin).not.toHaveBeenCalled();
	});
});
