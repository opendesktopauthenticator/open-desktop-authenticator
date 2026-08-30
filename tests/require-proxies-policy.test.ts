import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import type { VaultService } from '../src/main/vault/service';
import type { VaultSettings } from '../src/shared/vault-schema';

/**
 * **Turning `Require proxies` on has to reach what is already running.**
 *
 * Saving the setting wrote a vault field and stopped there. A Direct or
 * Steam-only browser window opened a minute earlier stayed on screen and stayed
 * signed in to Steam; cached transports went on answering for accounts with no
 * proxy, because the refusal is at construction and they were already built. So
 * the switch reported success and the vault went on doing the thing it now
 * forbade.
 *
 * The handler is exercised for real here rather than read as source, because
 * what matters is that saving *calls* the callback — and a source-text check
 * would pass on a call sitting in a branch that never runs.
 */

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
	}
}));

/** A vault whose settings the test controls and whose writes it can read back. */
function fakeVault(initial: Partial<VaultSettings> = {}): {
	vault: VaultService;
	settings: VaultSettings;
} {
	const settings = {
		requireProxies: false,
		autoLockMinutes: 10,
		clipboardClearSeconds: 30,
		convenienceUnlock: false,
		launchAtStartup: false,
		startMinimised: false,
		updateCheck: true,
		...initial
	};
	const vault = {
		read: () => ({ accounts: [] }),
		settings: () => settings,
		mutate: async (apply: (draft: { settings: VaultSettings }) => void) => {
			apply({ settings });
			return Promise.resolve();
		},
		touch: () => undefined,
		isUnlocked: () => true,
		exists: () => true,
		msUntilAutoLock: () => 600_000,
		backupAvailable: () => undefined
	} as unknown as VaultService;
	return { vault, settings };
}

function save(request: Record<string, unknown>): Promise<unknown> {
	const handler = handlers.get(CHANNELS.settingsUpdate);
	if (!handler) {
		throw new Error('settings:update was never registered');
	}
	return Promise.resolve(
		handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request)
	);
}

/** Registers the handlers with a policy callback the test can watch. */
function harness(initial: Partial<VaultSettings> = {}) {
	const { vault, settings } = fakeVault(initial);
	const fired = vi.fn();
	registerVaultHandlers(
		vault,
		() => undefined,
		undefined,
		() => undefined,
		() => undefined,
		() => undefined,
		fired
	);
	return { settings, fired };
}

const REQUEST = {
	requireProxies: true,
	autoLockMinutes: 10,
	clipboardClearSeconds: 30,
	updateCheck: true
};

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);
});

describe('saving Require proxies', () => {
	it('writes the field', async () => {
		const { settings } = harness();
		await save(REQUEST);
		expect(settings.requireProxies).toBe(true);
	});

	it('tells the main process to act on it', async () => {
		const { fired } = harness();
		await save(REQUEST);
		expect(fired, 'nothing was asked to close the windows the rule forbids').toHaveBeenCalled();
	});

	/*
	 * After the write. Anything the callback tears down is judged against the
	 * new rule, so a sweep that reads the setting sees the one just saved rather
	 * than the one being replaced.
	 */
	it('fires only once the new value is readable', async () => {
		const { settings, fired } = harness();
		fired.mockImplementation(() => {
			expect(settings.requireProxies, 'the callback ran before the write').toBe(true);
		});
		await save(REQUEST);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('does not fire when the setting is being turned off', async () => {
		const { fired } = harness({ requireProxies: true });
		await save({ ...REQUEST, requireProxies: false });
		expect(fired).not.toHaveBeenCalled();
	});

	/**
	 * **Only on the transition, and this test used to require the opposite.**
	 *
	 * Firing on every save that left the value true looked idempotent: with the
	 * rule already in force there is nothing non-compliant left to close. It is
	 * not, because the callback also drops every cached transport, which
	 * advances their generations and cancels requests in flight.
	 *
	 * So with strict mode already on, saving an unrelated setting — the
	 * clipboard timeout, the auto-lock minutes — killed a correctly proxied
	 * confirmation that happened to be running. Enforcement interrupting exactly
	 * the traffic it exists to protect, on a save that changed nothing about it.
	 */
	it('does not fire again on a save that leaves it on', async () => {
		const { fired } = harness({ requireProxies: true });
		await save(REQUEST);
		expect(
			fired,
			'an unrelated setting change cancelled compliant proxied work'
		).not.toHaveBeenCalled();
	});

	it('fires when an unrelated field changes at the same moment as the switch', async () => {
		// The transition is what matters, not whether it arrived alone.
		const { fired } = harness({ requireProxies: false });
		await save({ ...REQUEST, clipboardClearSeconds: 60 });
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('fires again if it is turned off and back on', async () => {
		const { fired, settings } = harness({ requireProxies: true });
		await save({ ...REQUEST, requireProxies: false });
		expect(fired).not.toHaveBeenCalled();
		expect(settings.requireProxies).toBe(false);

		await save(REQUEST);
		expect(fired).toHaveBeenCalledTimes(1);
	});
});
