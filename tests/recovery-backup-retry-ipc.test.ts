import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHANNELS } from '../src/shared/channels';
import { accountSummary, IPC_CONTRACT, type RendererApi } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerVaultHandlers, toSummary } from '../src/main/vault/ipc';
import type { VaultService } from '../src/main/vault/service';

const { handlers, exposed, invocations } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
	exposed: new Map<string, unknown>(),
	invocations: [] as Array<{ channel: string; request: unknown }>
}));

vi.mock('electron', () => ({
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] },
	dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
	contextBridge: { exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value) },
	ipcMain: {
		handle: (
			channel: string,
			handler: (event: unknown, request: unknown) => Promise<unknown>
		): Map<string, (event: unknown, request: unknown) => Promise<unknown>> =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	},
	ipcRenderer: {
		invoke: (channel: string, request: unknown): Promise<{ ok: true }> => {
			invocations.push({ channel, request });
			return Promise.resolve({ ok: true });
		},
		on: () => undefined,
		removeListener: () => undefined
	}
}));

import '../src/preload/index';

const STEAM_ID = '76561198000000001';

function fakeVault(): { vault: VaultService; touches: { count: number } } {
	const touches = { count: 0 };
	return {
		vault: {
			read: () => ({ accounts: [] }),
			touch: () => {
				touches.count += 1;
			},
			isUnlocked: () => true,
			exists: () => true,
			msUntilAutoLock: () => 600_000,
			backupAvailable: () => undefined,
			settings: () => ({
				requireProxies: false,
				autoLockMinutes: 10,
				clipboardClearSeconds: 30,
				updateCheck: true
			})
		} as unknown as VaultService,
		touches
	};
}

function register(vault: VaultService, finish: (steamId64: string) => Promise<void>): void {
	// The callback is intentionally last so every existing positional caller keeps
	// its meaning. Undefined entries exercise the production defaults before it.
	Reflect.apply(registerVaultHandlers, undefined, [
		vault,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		finish
	]);
}

async function invoke(request: unknown): Promise<unknown> {
	const handler = handlers.get(CHANNELS.accountFinishRecoveryBackup);
	expect(handler, 'the recovery retry handler was not registered').toBeDefined();
	return handler?.({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	invocations.length = 0;
	setTrustedSender(() => true);
});

describe('recovery-backup debt at the IPC boundary', () => {
	it('projects only actionable state, never durable ownership or a path', () => {
		const internal = {
			steamId64: STEAM_ID,
			accountName: 'someone',
			sharedSecret: 'SHARED-SECRET',
			identitySecret: 'IDENTITY-SECRET',
			status: 'active',
			recoveryBackup: {
				state: 'pending' as const,
				id: 'private-generation',
				authenticatorFingerprint: 'private-fingerprint',
				fileName: 'private.recovery.json',
				changedAt: '2026-09-03T00:00:00.000Z'
			},
			autoConfirm: {
				marketListings: false,
				trades: false,
				pollIntervalSeconds: 15,
				notify: { enabled: false, detail: 'full' as const }
			}
		};

		const projected = toSummary(internal);
		expect(projected.recoveryBackup).toBe('pending');
		expect(accountSummary.safeParse(projected).success).toBe(true);
		expect(JSON.stringify(projected)).not.toMatch(
			/private-generation|private-fingerprint|private\.recovery\.json|SECRET/
		);
	});

	it('does not show a completed marker and rejects paths supplied by the renderer', () => {
		const complete = toSummary({
			steamId64: STEAM_ID,
			accountName: 'someone',
			status: 'active',
			recoveryBackup: { state: 'current' },
			autoConfirm: {
				marketListings: false,
				trades: false,
				pollIntervalSeconds: 15,
				notify: { enabled: false, detail: 'full' }
			}
		});
		expect(complete.recoveryBackup).toBeUndefined();
		const request = IPC_CONTRACT[CHANNELS.accountFinishRecoveryBackup].request;
		expect(request.safeParse({ steamId64: STEAM_ID }).success).toBe(true);
		expect(
			request.safeParse({ steamId64: STEAM_ID, path: 'C:\\chosen-by-renderer.recovery' }).success
		).toBe(false);
	});

	it('validates then invokes the injected local completion exactly once', async () => {
		const { vault, touches } = fakeVault();
		const finish = vi.fn<(steamId64: string) => Promise<void>>(() => Promise.resolve());
		register(vault, finish);

		await expect(invoke({ steamId64: STEAM_ID })).resolves.toEqual({ ok: true });
		expect(finish).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledWith(STEAM_ID);
		expect(touches.count).toBe(1);

		await expect(invoke({ steamId64: STEAM_ID, path: 'not allowed' })).rejects.toThrow(
			/invalid request/
		);
		expect(finish).toHaveBeenCalledTimes(1);
	});

	it('does not report success when local completion rejects', async () => {
		const { vault, touches } = fakeVault();
		register(vault, () => Promise.reject(new Error('disk is read-only')));

		await expect(invoke({ steamId64: STEAM_ID })).rejects.toThrow('disk is read-only');
		expect(touches.count).toBe(0);
	});

	it('preload sends only the account identity on the dedicated channel', async () => {
		const api = exposed.get('api') as RendererApi | undefined;
		expect(api, 'the preload did not expose its API').toBeDefined();
		await api?.finishRecoveryBackup(STEAM_ID);
		expect(invocations).toEqual([
			{ channel: CHANNELS.accountFinishRecoveryBackup, request: { steamId64: STEAM_ID } }
		]);
	});

	it('keeps the row action in App and refreshes immediately after the local write succeeds', () => {
		const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
		const start = source.indexOf('const startRecoveryBackup = useCallback(');
		expect(start, 'App never wires the row action').toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf('const beginBrowserOpenAfterSignIn', start));
		expect(body.indexOf('api.finishRecoveryBackup(account.steamId64)')).toBeGreaterThan(-1);
		expect(body.indexOf('refresh({ includeCodes: false })')).toBeGreaterThan(
			body.indexOf('api.finishRecoveryBackup(account.steamId64)')
		);
		expect(body).toContain('setRecoveryBackupErrors(');
		expect(source).toContain('onFinishRecoveryBackup={startRecoveryBackup}');
		expect(source).toContain('recoveryErrors={recoveryBackupErrors}');
	});

	it('keeps the local recovery core unreserved and reserves standalone retries', () => {
		const source = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
		const coreStart = source.indexOf('const finishRecoveryBackupUnderReservation = async');
		expect(
			coreStart,
			'the production wiring has no recovery core for callers that already hold the account'
		).toBeGreaterThan(-1);
		const coreEnd = source.indexOf('\n\t};', coreStart);
		expect(coreEnd, 'the already-reserved recovery core could not be isolated').toBeGreaterThan(
			coreStart
		);
		const core = source.slice(coreStart, coreEnd);
		expect(core).toContain('const result = await completeRecoveryBackup(vault, {');
		expect(core).toContain('writeRecovery: recovery.writeRecovery');
		expect(core).toContain('updateRecovery: recovery.updateRecovery');
		expect(core).not.toContain('beginAccountMutation');
		expect(core).not.toContain('releaseAccountMutation');
		// A retry repairs a local encrypted file. Reaching any Steam/network service
		// from this callback would break the promise shown on the account row.
		expect(core).not.toMatch(/\b(?:transports|confirmations|enrollment|transfer|browsers)\s*\./);

		const wrapperStart = source.indexOf('const finishRecoveryBackupLocally = async');
		expect(wrapperStart, 'the standalone reserved recovery wrapper is missing').toBeGreaterThan(-1);
		const wrapperEnd = source.indexOf('\n\t};', wrapperStart);
		expect(wrapperEnd, 'the standalone recovery wrapper could not be isolated').toBeGreaterThan(
			wrapperStart
		);
		const wrapper = source.slice(wrapperStart, wrapperEnd);
		expect(wrapper).toContain('keyCoordinator.beginAccountMutation(steamId64)');
		expect(wrapper).toContain('await finishRecoveryBackupUnderReservation(steamId64)');
		expect(wrapper).toContain('releaseAccountMutation()');
	});
});
