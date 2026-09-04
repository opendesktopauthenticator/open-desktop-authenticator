import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	},
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] },
	dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) }
}));

import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { ProxyConsent } from '../src/main/net/proxy-consent';
import { authenticatorFingerprint } from '../src/main/steam/authenticator-secrets';
import { createRecoveryHooks } from '../src/main/vault/recovery';
import { finishRecoveryBackup } from '../src/main/vault/recovery-state';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import type { VaultService } from '../src/main/vault/service';
import { CHANNELS } from '../src/shared/channels';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

const STEAM_ID = '76561198000000001';
const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const roots: string[] = [];

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
		identitySecret: '/ty6mHZUMhD+3LqYdlQyEP7cupg=',
		revocationCode: 'R12345',
		status: 'active',
		autoConfirm: newAutoConfirm(),
		addedAt: '2026-09-01T00:00:00.000Z',
		...overrides
	};
}

function fakeVault(stored: Account): { vault: VaultService; accounts: Account[] } {
	const accounts = [stored];
	return {
		accounts,
		vault: {
			read: () => ({ accounts }),
			settings: () => ({
				requireProxies: false,
				autoLockMinutes: 10,
				clipboardClearSeconds: 30,
				updateCheck: true
			}),
			mutate: (apply: (draft: { accounts: Account[] }) => void) => {
				apply({ accounts });
				return Promise.resolve();
			},
			touch: () => undefined,
			isUnlocked: () => true,
			exists: () => true,
			msUntilAutoLock: () => 600_000,
			backupAvailable: () => undefined
		} as unknown as VaultService
	};
}

function currentRecovery(source: Account): {
	path: string;
	hooks: ReturnType<typeof createRecoveryHooks>;
} {
	const root = mkdtempSync(join(tmpdir(), 'recovery-setting-audit-'));
	roots.push(root);
	const hooks = createRecoveryHooks({
		userDataPath: () => root,
		seal: (plaintext) => ({ plaintext }),
		now: () => NOW
	});
	const path = hooks.writeRecovery(source);
	source.recoveryBackup = {
		version: 1,
		id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		authenticatorFingerprint: authenticatorFingerprint(source),
		state: 'current',
		fileName: basename(path),
		changedAt: new Date(NOW).toISOString()
	};
	return { path, hooks };
}

function recoveredAccount(path: string): Account {
	const envelope = JSON.parse(readFileSync(path, 'utf8')) as { plaintext: string };
	return (JSON.parse(envelope.plaintext) as { account: Account }).account;
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`${channel} was not registered`);
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

function registerWithRecoveryRefresh(
	vault: VaultService,
	finish: (steamId64: string) => Promise<void>,
	options: { consent?: ProxyConsent; onProxyChanged?: (steamId64: string) => void } = {}
): void {
	Reflect.apply(registerVaultHandlers, undefined, [
		vault,
		options.onProxyChanged,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		options.consent,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		finish
	]);
}

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a current recovery backup after account-setting changes', () => {
	it('does not silently restore automatic trade approval after the user switched it off', async () => {
		const source = account({
			autoConfirm: { ...newAutoConfirm(), trades: true, notify: { enabled: true, detail: 'full' } }
		});
		const { path } = currentRecovery(source);
		const { vault, accounts } = fakeVault(source);
		registerVaultHandlers(vault);

		await invoke(CHANNELS.accountSetAutoConfirm, {
			steamId64: STEAM_ID,
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: { enabled: false, detail: 'full' }
		});

		expect(accounts[0]?.autoConfirm.trades).toBe(false);
		const restored = recoveredAccount(path);
		const fileMatchesChoice = restored.autoConfirm.trades === false;
		const repairDebtIsVisible = accounts[0]?.recoveryBackup?.state !== 'current';
		expect(
			fileMatchesChoice || repairDebtIsVisible,
			'a restore would silently turn automatic trade approval back on while the file still claims current'
		).toBe(true);
	});

	it('does not silently restore direct routing after the user configured a proxy', async () => {
		const newProxy = 'http://new-user:new-pass@127.0.0.1:8081';
		const source = account();
		const { path } = currentRecovery(source);
		const { vault, accounts } = fakeVault(source);
		const consent = new ProxyConsent({ ask: () => Promise.resolve(true) });
		registerVaultHandlers(
			vault,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			consent
		);

		await invoke(CHANNELS.accountSetProxy, { steamId64: STEAM_ID, proxyUrl: newProxy });

		expect(accounts[0]?.proxyUrl).toBe(newProxy);
		const restored = recoveredAccount(path);
		const fileMatchesChoice = restored.proxyUrl === newProxy;
		const repairDebtIsVisible = accounts[0]?.recoveryBackup?.state !== 'current';
		expect(
			fileMatchesChoice || repairDebtIsVisible,
			'a restore would silently remove the configured proxy and permit direct routing while the file still claims current'
		).toBe(true);
	});

	it('refreshes the exact owned file locally after a serialized setting changes', async () => {
		const source = account({
			autoConfirm: { ...newAutoConfirm(), trades: true }
		});
		const { path, hooks } = currentRecovery(source);
		const { vault, accounts } = fakeVault(source);
		const finish = vi.fn(async (steamId64: string) => {
			const result = await finishRecoveryBackup(vault, {
				steamId64,
				writeRecovery: hooks.writeRecovery,
				updateRecovery: hooks.updateRecovery,
				now: () => NOW + 1_000
			});
			if (result !== 'current') throw new Error(`recovery refresh was ${result}`);
		});
		registerWithRecoveryRefresh(vault, finish);

		await invoke(CHANNELS.accountSetAutoConfirm, {
			steamId64: STEAM_ID,
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: { enabled: false, detail: 'full' }
		});

		expect(finish).toHaveBeenCalledOnce();
		expect(accounts[0]?.recoveryBackup?.state).toBe('current');
		expect(recoveredAccount(path).autoConfirm.trades).toBe(false);
	});

	it('tears down changed routing before attempting its local backup refresh', async () => {
		const source = account();
		currentRecovery(source);
		const { vault } = fakeVault(source);
		const order: string[] = [];
		registerWithRecoveryRefresh(
			vault,
			() => {
				order.push('recovery');
				return Promise.reject(new Error('disk is read-only'));
			},
			{
				consent: new ProxyConsent({ ask: () => Promise.resolve(true) }),
				onProxyChanged: () => order.push('route')
			}
		);

		await expect(
			invoke(CHANNELS.accountSetProxy, {
				steamId64: STEAM_ID,
				proxyUrl: 'http://new-user:new-pass@127.0.0.1:8081'
			})
		).resolves.toEqual({ ok: true });
		expect(order).toEqual(['route', 'recovery']);
		expect(source.recoveryBackup?.state).toBe('stale');
	});

	it('does no recovery work for an unchanged save', async () => {
		const source = account();
		const { path } = currentRecovery(source);
		const originalMarker = source.recoveryBackup;
		const originalBytes = readFileSync(path, 'utf8');
		const { vault } = fakeVault(source);
		const finish = vi.fn<(steamId64: string) => Promise<void>>(() => Promise.resolve());
		registerWithRecoveryRefresh(vault, finish);

		await invoke(CHANNELS.accountSetAutoConfirm, {
			steamId64: STEAM_ID,
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: { enabled: false, detail: 'full' }
		});

		expect(finish).not.toHaveBeenCalled();
		expect(source.recoveryBackup).toEqual(originalMarker);
		expect(readFileSync(path, 'utf8')).toBe(originalBytes);
	});
});
