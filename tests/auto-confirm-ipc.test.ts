import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS, TRADES_ACK } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

/**
 * The gate on automatic trade confirmation (§12 F6).
 *
 * Two things are being protected, and they pull in opposite directions:
 *
 *  - **Switching trades on must require the typed phrase**, enforced here rather
 *    than by the screen. A renderer-only gate is a convention, not a control.
 *  - **Everything else must stay editable.** The first version of this check ran
 *    on `trades === true` regardless of the previous value, so once trades were
 *    on the poll interval could never be changed again: the screen correctly
 *    stops asking for an acknowledgement it does not need, and the request was
 *    then refused. That was found in live testing, not by a test, which is why
 *    this file exists.
 */

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	}
}));

const STEAM_ID = '76561198744715021';

function account(trades: boolean): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'daneytneetuwej',
		sharedSecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
		identitySecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
		status: 'active',
		addedAt: '2026-08-01T00:00:00.000Z',
		autoConfirm: { marketListings: false, trades, pollIntervalSeconds: 15 }
	};
}

/** A vault whose stored account the test controls, and whose writes it can read back. */
function fakeVault(stored: Account): { vault: VaultService; accounts: Account[] } {
	const accounts = [stored];
	const vault = {
		read: () => ({ accounts }),
		settings: () => ({ autoLockMinutes: 10, clipboardClearSeconds: 30, updateCheck: true }),
		mutate: async (apply: (draft: { accounts: Account[] }) => void) => {
			apply({ accounts });
			return Promise.resolve();
		},
		touch: () => undefined,
		isUnlocked: () => true,
		exists: () => true,
		msUntilAutoLock: () => 600_000,
		backupAvailable: () => undefined
	} as unknown as VaultService;
	return { vault, accounts };
}

async function setAutoConfirm(request: Record<string, unknown>): Promise<unknown> {
	const handler = handlers.get(CHANNELS.accountSetAutoConfirm);
	if (!handler) {
		throw new Error('account:setAutoConfirm was never registered');
	}
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);
});

describe('switching trades on', () => {
	it('is refused without the acknowledgement', async () => {
		const { vault, accounts } = fakeVault(account(false));
		registerVaultHandlers(vault);

		await expect(
			setAutoConfirm({
				steamId64: STEAM_ID,
				marketListings: false,
				trades: true,
				pollIntervalSeconds: 15
			})
		).rejects.toThrow();

		// And nothing was written. A refused gate that still saves is not a gate.
		expect(accounts[0]?.autoConfirm.trades).toBe(false);
	});

	it('is refused when the phrase is wrong', async () => {
		const { vault, accounts } = fakeVault(account(false));
		registerVaultHandlers(vault);

		await expect(
			setAutoConfirm({
				steamId64: STEAM_ID,
				marketListings: false,
				trades: true,
				pollIntervalSeconds: 15,
				tradesAcknowledgement: 'yes please'
			})
		).rejects.toThrow();
		expect(accounts[0]?.autoConfirm.trades).toBe(false);
	});

	it('succeeds with the phrase', async () => {
		const { vault, accounts } = fakeVault(account(false));
		registerVaultHandlers(vault);

		await setAutoConfirm({
			steamId64: STEAM_ID,
			marketListings: false,
			trades: true,
			pollIntervalSeconds: 15,
			tradesAcknowledgement: TRADES_ACK
		});

		expect(accounts[0]?.autoConfirm.trades).toBe(true);
	});

	it('accepts the phrase with odd spacing or casing', async () => {
		const { vault, accounts } = fakeVault(account(false));
		registerVaultHandlers(vault);

		await setAutoConfirm({
			steamId64: STEAM_ID,
			marketListings: false,
			trades: true,
			pollIntervalSeconds: 15,
			tradesAcknowledgement: '  approve   trades '
		});

		expect(accounts[0]?.autoConfirm.trades).toBe(true);
	});
});

describe('once trades are already on', () => {
	it('lets the poll interval change without asking again', async () => {
		// The live-testing failure. The screen stops asking for a phrase it does
		// not need, so nothing is sent — and the save was refused, which made the
		// setting permanently uneditable.
		const { vault, accounts } = fakeVault(account(true));
		registerVaultHandlers(vault);

		await setAutoConfirm({
			steamId64: STEAM_ID,
			marketListings: false,
			trades: true,
			pollIntervalSeconds: 20
		});

		expect(accounts[0]?.autoConfirm.pollIntervalSeconds).toBe(20);
		expect(accounts[0]?.autoConfirm.trades).toBe(true);
	});

	it('lets market listings be toggled without asking again', async () => {
		const { vault, accounts } = fakeVault(account(true));
		registerVaultHandlers(vault);

		await setAutoConfirm({
			steamId64: STEAM_ID,
			marketListings: true,
			trades: true,
			pollIntervalSeconds: 15
		});

		expect(accounts[0]?.autoConfirm.marketListings).toBe(true);
	});

	it('never asks for a phrase to switch trades OFF', async () => {
		// Turning a dangerous thing off is never something to make harder.
		const { vault, accounts } = fakeVault(account(true));
		registerVaultHandlers(vault);

		await setAutoConfirm({
			steamId64: STEAM_ID,
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15
		});

		expect(accounts[0]?.autoConfirm.trades).toBe(false);
	});

	it('asks again if trades are switched off and back on', async () => {
		// The gate is on the transition, so it applies every time that transition
		// happens — not once per account, forever.
		const { vault, accounts } = fakeVault(account(true));
		registerVaultHandlers(vault);

		await setAutoConfirm({
			steamId64: STEAM_ID,
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15
		});

		await expect(
			setAutoConfirm({
				steamId64: STEAM_ID,
				marketListings: false,
				trades: true,
				pollIntervalSeconds: 15
			})
		).rejects.toThrow();
		expect(accounts[0]?.autoConfirm.trades).toBe(false);
	});
});

describe('market listings alone', () => {
	it('need no acknowledgement', async () => {
		const { vault, accounts } = fakeVault(account(false));
		registerVaultHandlers(vault);

		await setAutoConfirm({
			steamId64: STEAM_ID,
			marketListings: true,
			trades: false,
			pollIntervalSeconds: 15
		});

		expect(accounts[0]?.autoConfirm.marketListings).toBe(true);
	});
});
