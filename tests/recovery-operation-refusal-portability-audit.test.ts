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
import { EnrollmentError } from '../src/main/steam/enroll';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import {
	authenticatorFingerprint,
	operationRecordToken
} from '../src/main/steam/authenticator-secrets';
import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { memoryOperationJournal } from '../src/main/steam/operation-journal';
import { createRecoveryHooks } from '../src/main/vault/recovery';
import { finishRecoveryBackup } from '../src/main/vault/recovery-state';
import type { VaultService } from '../src/main/vault/service';
import { CHANNELS } from '../src/shared/channels';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

const EVENT = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };
const STEAM_ID = '76561198000000001';
const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const roots: string[] = [];

function account(status: Account['status']): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
		identitySecret: '/ty6mHZUMhD+3LqYdlQyEP7cupg=',
		revocationCode: 'R12345',
		status,
		autoConfirm: newAutoConfirm(),
		addedAt: '2026-09-01T00:00:00.000Z'
	};
}

function vaultHolding(accounts: Account[]): VaultService {
	return {
		isUnlocked: () => true,
		touch: () => undefined,
		read: () => ({ accounts }),
		mutate: (apply: (draft: { accounts: Account[] }) => void) => {
			apply({ accounts });
			return Promise.resolve();
		},
		settings: () => ({ requireProxies: false }),
		verifyPassphrase: () => Promise.resolve()
	} as unknown as VaultService;
}

function recoveredAccount(path: string): Account {
	const envelope = JSON.parse(readFileSync(path, 'utf8')) as { plaintext: string };
	return (JSON.parse(envelope.plaintext) as { account: Account }).account;
}

function install(
	accounts: Account[],
	overrides: Partial<EnrollmentService>,
	options: {
		journal?: ReturnType<typeof memoryOperationJournal>;
		finishRecovery?: (steamId64: string) => Promise<void>;
	} = {}
): ReturnType<typeof memoryOperationJournal> {
	const journal = options.journal ?? memoryOperationJournal();
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
	registerEnrollmentHandlers(
		overrides as EnrollmentService,
		vaultHolding(accounts),
		{ show: () => Promise.resolve(undefined) },
		undefined,
		undefined,
		undefined,
		journal,
		undefined,
		undefined,
		options.finishRecovery
	);
	return journal;
}

function localRecoveryFinish(
	vault: VaultService,
	hooks: ReturnType<typeof createRecoveryHooks>
): (steamId64: string) => Promise<void> {
	return async (steamId64) => {
		const result = await finishRecoveryBackup(vault, {
			steamId64,
			writeRecovery: hooks.writeRecovery,
			updateRecovery: hooks.updateRecovery,
			now: () => NOW + 1_000
		});
		if (result !== 'current') throw new Error(`recovery refresh was ${result}`);
	};
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`${channel} was not registered`);
	return handler(EVENT, request);
}

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('an unresolved Steam operation in a portable recovery backup', () => {
	it.each([
		{
			kind: 'activate' as const,
			status: 'pendingActivation' as const,
			channel: CHANNELS.enrollActivate,
			request: { steamId64: STEAM_ID, code: '12345' }
		},
		{
			kind: 'deactivate' as const,
			status: 'active' as const,
			channel: CHANNELS.accountDeactivate,
			request: {
				steamId64: STEAM_ID,
				passphrase: 'a sufficiently long passphrase',
				acknowledgement: 'REMOVE STEAM GUARD'
			}
		}
	])(
		'does not lose the $kind refusal when the current vault is replaced by its recovery file',
		async ({ kind, status, channel, request }) => {
			const root = mkdtempSync(join(tmpdir(), `recovery-${kind}-refusal-`));
			roots.push(root);
			const live = account(status);
			const hooks = createRecoveryHooks({
				userDataPath: () => root,
				seal: (plaintext) => ({ plaintext }),
				now: () => NOW
			});
			const path = hooks.writeRecovery(live);
			live.recoveryBackup = {
				version: 1,
				id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				authenticatorFingerprint: authenticatorFingerprint(live),
				state: 'current',
				fileName: basename(path),
				changedAt: new Date(NOW).toISOString()
			};
			const guidance = `Steam did not answer the ${kind} request.`;
			const uncertain = vi.fn(() => Promise.reject(new EnrollmentError(guidance, true, true)));
			const liveAccounts = [live];
			const liveVault = vaultHolding(liveAccounts);
			const originalJournal = install(
				liveAccounts,
				kind === 'activate' ? { activate: uncertain } : { deactivate: uncertain },
				{ finishRecovery: localRecoveryFinish(liveVault, hooks) }
			);

			await expect(invoke(channel, request)).resolves.toMatchObject({
				state: 'uncertain',
				kind,
				persisted: true
			});
			expect(live.unresolvedOperation).toMatchObject({ kind, guidance });
			expect(originalJournal.readKind(STEAM_ID, kind)).toBeDefined();

			// A portable restore has the encrypted recovery file, not this
			// installation's private operation journal.
			const restored = recoveredAccount(path);
			expect(restored.unresolvedOperation).toMatchObject({ kind, guidance });
			expect(live.recoveryBackup?.state).toBe('current');
			const repeatedActivation = vi.fn(() => Promise.resolve('wantMore' as const));
			const repeatedDeactivation = vi.fn(() => Promise.resolve());
			install(
				[restored],
				kind === 'activate'
					? { activate: repeatedActivation }
					: { deactivate: repeatedDeactivation }
			);

			await expect(invoke(channel, request)).resolves.toMatchObject({ state: 'uncertain', kind });
			const repeated = kind === 'activate' ? repeatedActivation : repeatedDeactivation;
			expect(
				repeated,
				`the restored account sent the unresolved ${kind} request to Steam a second time`
			).not.toHaveBeenCalled();
		}
	);

	it('does not resurrect a refusal the user resolved as Steam doing nothing', async () => {
		const root = mkdtempSync(join(tmpdir(), 'recovery-resolved-refusal-'));
		roots.push(root);
		const live = account('pendingActivation');
		live.unresolvedOperation = {
			kind: 'activate',
			guidance: 'Steam did not answer the activation request.',
			fingerprint: authenticatorFingerprint(live),
			operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			at: new Date(NOW).toISOString()
		};
		const operationToken = operationRecordToken('vault', {
			steamId64: STEAM_ID,
			...live.unresolvedOperation
		});
		const hooks = createRecoveryHooks({
			userDataPath: () => root,
			seal: (plaintext) => ({ plaintext }),
			now: () => NOW
		});
		const path = hooks.writeRecovery(live);
		live.recoveryBackup = {
			version: 1,
			id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			authenticatorFingerprint: authenticatorFingerprint(live),
			state: 'current',
			fileName: basename(path),
			changedAt: new Date(NOW).toISOString()
		};
		const liveAccounts = [live];
		install(
			liveAccounts,
			{},
			{ finishRecovery: localRecoveryFinish(vaultHolding(liveAccounts), hooks) }
		);

		await expect(
			invoke(CHANNELS.accountResolveOperation, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken,
				steamActed: false
			})
		).resolves.toEqual({ ok: true });
		expect(live.unresolvedOperation).toBeUndefined();

		const restored = recoveredAccount(path);
		expect(restored.unresolvedOperation).toBeUndefined();
		expect(live.recoveryBackup.state).toBe('current');
	});

	it('does not nest an account reservation in production unresolved-operation refreshes', () => {
		const source = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
		const wrapperStart = source.indexOf('const finishRecoveryBackupLocally = async');
		const wrapperEnd = source.indexOf('\n\t};', wrapperStart);
		expect(wrapperStart, 'the reserved standalone recovery wrapper is missing').toBeGreaterThan(-1);
		expect(
			wrapperEnd,
			'the reserved standalone recovery wrapper could not be isolated'
		).toBeGreaterThan(wrapperStart);
		expect(source.slice(wrapperStart, wrapperEnd)).toContain(
			'await finishRecoveryBackupUnderReservation(steamId64)'
		);

		const vaultStart = source.indexOf('registerVaultHandlers(');
		const vaultEnd = source.indexOf('registerImportHandlers(', vaultStart);
		const vaultRegistration = source.slice(vaultStart, vaultEnd);
		expect(vaultRegistration).toContain('finishRecoveryBackupLocally,');
		expect(vaultRegistration.match(/finishRecoveryBackupLocally/g) ?? []).toHaveLength(1);

		const enrollmentStart = source.indexOf('registerEnrollmentHandlers(');
		const enrollmentEnd = source.indexOf('registerCodeHandlers(', enrollmentStart);
		expect(source.slice(enrollmentStart, enrollmentEnd)).toMatch(
			/accountMutationBlocked,\s*\n\s*finishRecoveryBackupUnderReservation\s*\n\s*\);/
		);
	});
});
