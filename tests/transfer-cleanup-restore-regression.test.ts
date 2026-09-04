import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import type { SteamTransportFactory } from '../src/main/net/transport';
import { accountMutationBlockedByDurableState } from '../src/main/steam/account-mutation-guard';
import { authenticatorFingerprint } from '../src/main/steam/authenticator-secrets';
import { EnrollmentService } from '../src/main/steam/enrollment';
import type { LoginSessionLike } from '../src/main/steam/login';
import { fileOperationJournal } from '../src/main/steam/operation-journal';
import { TransferService } from '../src/main/steam/transfer';
import {
	fileWorkflowJournal,
	type TransferWorkflowRecord,
	type WorkflowJournal
} from '../src/main/steam/workflow-journal';
import { VaultKeyOperationCoordinator } from '../src/main/vault/key-operation-coordinator';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import { VaultService } from '../src/main/vault/service';
import { CHANNELS } from '../src/shared/channels';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';
import { successfulRecoveryPath } from './recovery-fixture';

const PASS = 'a sufficiently long passphrase';
const STEAM_ID = '76561198000000001';
const OTHER_STEAM_ID = '76561198000000002';
const NOW = Date.parse('2026-09-03T00:00:00Z');
const TOKEN = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
	JSON.stringify({ aud: ['mobile'], exp: Math.floor(NOW / 1000) + 3600 })
).toString('base64url')}.sig`;
const REPLACEMENT = {
	sharedSecret: Buffer.alloc(20, 3).toString('base64'),
	identitySecret: Buffer.alloc(20, 4).toString('base64'),
	revocationCode: 'R-TRANSFER',
	serverTime: String(Math.floor(NOW / 1000) + 12),
	steamId64: STEAM_ID
};

const roots: string[] = [];

interface CleanupDebtFixture {
	root: string;
	vault: VaultService;
	journal: WorkflowJournal;
	transfer: TransferService;
}

type CleanupAwareTransfer = TransferService & {
	hasTransferCleanupDebt?: (steamId64?: string) => boolean;
};

function processOnlyTransferCleanupDebt(transfer: TransferService, steamId64?: string): boolean {
	return (transfer as CleanupAwareTransfer).hasTransferCleanupDebt?.(steamId64) ?? false;
}

function storedAccount(): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: REPLACEMENT.sharedSecret,
		identitySecret: REPLACEMENT.identitySecret,
		revocationCode: REPLACEMENT.revocationCode,
		deviceId: 'android:transfer',
		status: 'pendingActivation',
		autoConfirm: newAutoConfirm(),
		addedAt: new Date(NOW).toISOString()
	};
}

function enrollmentSession(steamId64 = OTHER_STEAM_ID): LoginSessionLike {
	const listeners: Record<string, Array<() => void>> = {};
	return {
		startWithCredentials: () => {
			queueMicrotask(() => listeners.authenticated?.forEach((listener) => listener()));
			return Promise.resolve({ actionRequired: false });
		},
		submitSteamGuardCode: () => Promise.resolve(),
		on: ((event: string, listener: () => void) => {
			(listeners[event] ??= []).push(listener);
		}) as LoginSessionLike['on'],
		cancelLoginAttempt: () => undefined,
		steamID: { getSteamID64: () => steamId64 },
		accessToken: TOKEN,
		refreshToken: TOKEN
	};
}

function emailEnrollmentSession(steamId64 = OTHER_STEAM_ID): LoginSessionLike {
	const listeners: Record<string, Array<() => void>> = {};
	return {
		startWithCredentials: () =>
			Promise.resolve({
				actionRequired: true,
				validActions: [{ type: 2, detail: 'example.com' }]
			}),
		submitSteamGuardCode: () => {
			queueMicrotask(() => listeners.authenticated?.forEach((listener) => listener()));
			return Promise.resolve();
		},
		on: ((event: string, listener: () => void) => {
			(listeners[event] ??= []).push(listener);
		}) as LoginSessionLike['on'],
		cancelLoginAttempt: () => undefined,
		steamID: { getSteamID64: () => steamId64 },
		accessToken: TOKEN,
		refreshToken: TOKEN
	};
}

function makeTransfer(
	vault: VaultService,
	journal: WorkflowJournal,
	writeRecovery: (account: Account) => string = successfulRecoveryPath,
	keyCoordinator: VaultKeyOperationCoordinator = new VaultKeyOperationCoordinator(),
	onAccountRemoved: (steamId64: string, removed: true) => void = () => undefined,
	onAccountReplaced: (steamId64: string) => void = () => undefined
): TransferService {
	return new TransferService(
		vault,
		{
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory,
		() => 0,
		{
			now: () => NOW,
			workflowJournal: journal,
			keyCoordinator,
			signIn: () => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }),
			mintAccessToken: () => Promise.resolve('access'),
			continueChallenge: () => Promise.resolve({ success: true, replacementToken: REPLACEMENT }),
			writeRecovery,
			onAccountRemoved,
			onAccountReplaced
		}
	);
}

interface RestoredStaleTransferFixture {
	root: string;
	vault: VaultService;
	journal: WorkflowJournal;
	record: TransferWorkflowRecord;
	transfer: TransferService;
	coordinator: VaultKeyOperationCoordinator;
	other: Account;
	teardown: ReturnType<typeof vi.fn>;
	setVaultMutationFailure: (fail: boolean) => void;
}

async function restoredStaleTransferFixture(
	wrapJournal: (journal: WorkflowJournal) => WorkflowJournal = (journal) => journal,
	state: 'sending' | 'unanswered' = 'unanswered'
): Promise<RestoredStaleTransferFixture> {
	const root = mkdtempSync(join(tmpdir(), 'oda-transfer-stale-restore-'));
	roots.push(root);
	const coordinator = new VaultKeyOperationCoordinator();
	let failVaultMutation = false;
	const vault = new VaultService({
		file: join(root, 'vault.json'),
		now: () => NOW,
		beforeMutationCommit: (current, next) => {
			coordinator.assertAccountSnapshotsUnchanged(current.accounts, next.accounts);
			if (failVaultMutation) throw new Error('injected vault commit failure');
		}
	});
	await vault.create(PASS);
	const previous = {
		...storedAccount(),
		sharedSecret: Buffer.alloc(20, 41).toString('base64'),
		identitySecret: Buffer.alloc(20, 42).toString('base64'),
		revocationCode: 'R-PREVIOUS',
		status: 'active' as const
	};
	const other: Account = {
		...storedAccount(),
		steamId64: OTHER_STEAM_ID,
		accountName: 'other',
		sharedSecret: Buffer.alloc(20, 11).toString('base64'),
		identitySecret: Buffer.alloc(20, 12).toString('base64'),
		revocationCode: 'R-OTHER',
		deviceId: 'android:other',
		status: 'active'
	};
	await vault.mutate((draft) => draft.accounts.push(previous, other));
	// The backup produced by this write contains the old authenticator. The live
	// vault does not, which is the precondition TransferService enforces before it
	// publishes an irreversible transfer record.
	await vault.mutate((draft) => {
		draft.accounts = draft.accounts.filter((account) => account.steamId64 !== STEAM_ID);
	});

	const journal = fileWorkflowJournal(root);
	const sending = journal.beginTransfer({
		steamId64: STEAM_ID,
		accountName: 'trader',
		at: new Date(NOW).toISOString(),
		wrappedKey: vault.sealScopedKey(Buffer.alloc(32, 9)),
		priorAuthenticatorFingerprint: authenticatorFingerprint(previous)
	});
	const record =
		state === 'unanswered' ? journal.updateTransfer(sending, { state: 'unanswered' }) : sending;
	vault.lock('manual');
	await vault.restoreFromBackup(PASS, (candidate, key) => {
		if (!journal.vaultKeyCompatible(candidate, key)) throw new Error('incompatible workflow key');
	});

	const serviceJournal = wrapJournal(journal);
	const teardown = vi.fn((steamId64: string) => {
		expect(
			vault.read().accounts.some((account) => account.steamId64 === steamId64),
			'account teardown ran before the vault deletion committed'
		).toBe(false);
	});
	return {
		root,
		vault,
		journal,
		record,
		transfer: makeTransfer(vault, serviceJournal, successfulRecoveryPath, coordinator, teardown),
		coordinator,
		other,
		teardown,
		setVaultMutationFailure: (fail) => {
			failVaultMutation = fail;
		}
	};
}

async function cleanupDebtFixture(): Promise<CleanupDebtFixture> {
	const root = mkdtempSync(join(tmpdir(), 'oda-transfer-restore-debt-'));
	roots.push(root);
	const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
	await vault.create(PASS);

	let failNextDirectoryFlush = false;
	const backing = fileWorkflowJournal(root, {
		syncDirectory: () => {
			if (!failNextDirectoryFlush) return;
			failNextDirectoryFlush = false;
			throw Object.assign(new Error('directory flush failed after unlink'), { code: 'EIO' });
		}
	});
	const journal: WorkflowJournal = {
		...backing,
		markTransferRecovery: (record, published) => {
			const updated = backing.markTransferRecovery(record, published);
			// Publication is durable before cleanup starts. Fail only the directory
			// flush after clearTransfer unlinks that now-published workflow.
			if (published) failNextDirectoryFlush = true;
			return updated;
		}
	};
	const transfer = makeTransfer(vault, journal, successfulRecoveryPath);

	await transfer.authenticate('trader', 'password', 'QK4TX');
	await expect(transfer.completeTransfer('12345')).rejects.toThrow(
		/safely stored.*safety record could not be cleared/i
	);
	expect(vault.read().accounts).toMatchObject([
		{ steamId64: STEAM_ID, sharedSecret: REPLACEMENT.sharedSecret }
	]);
	expect(journal.transfers()).toEqual([]);
	expect(transfer.recovery()).toMatchObject({ state: 'replacement', retained: false });
	return { root, vault, journal, transfer };
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`${channel} was not registered`);
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

function registerWithCombinedCleanupDebtGate(
	vault: VaultService,
	journal: WorkflowJournal,
	transfer: TransferService,
	enrollmentCleanupDebt: () => boolean = () => false,
	canReplaceVaultKey: () => boolean = () => true
): void {
	registerVaultHandlers(
		vault,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		canReplaceVaultKey,
		new VaultKeyOperationCoordinator(),
		(candidate, key) => journal.vaultKeyCompatible(candidate, key),
		() => false,
		() => enrollmentCleanupDebt() || processOnlyTransferCleanupDebt(transfer)
	);
}

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backup restore beside process-only transfer cleanup debt', () => {
	it('refuses the pre-transfer backup before it can erase the stored replacement', async () => {
		const { vault, journal, transfer } = await cleanupDebtFixture();
		vault.lock('manual');
		registerWithCombinedCleanupDebtGate(vault, journal, transfer);

		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).rejects.toThrow(
			/transfer|safety record|cleanup/i
		);

		await vault.unlock(PASS);
		expect(
			vault.read().accounts,
			"the pre-transfer backup replaced the only vault copy of Steam's replacement secrets"
		).toMatchObject([{ steamId64: STEAM_ID, sharedSecret: REPLACEMENT.sharedSecret }]);
		expect(processOnlyTransferCleanupDebt(transfer)).toBe(true);
	});

	it('refuses vault adoption through the same process-only cleanup gate', async () => {
		const { vault, journal, transfer } = await cleanupDebtFixture();
		vault.lock('manual');
		registerWithCombinedCleanupDebtGate(vault, journal, transfer);

		await expect(invoke(CHANNELS.vaultAdopt, { passphrase: PASS })).rejects.toThrow(
			/transfer|workflow|safety record|cleanup/i
		);
		expect(processOnlyTransferCleanupDebt(transfer, STEAM_ID)).toBe(true);
	});

	it('allows restore after an exact cleanup retry clears the process-only debt', async () => {
		const { vault, journal, transfer } = await cleanupDebtFixture();
		await expect(transfer.retryPersist()).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(transfer.recovery()).toBeUndefined();
		expect(processOnlyTransferCleanupDebt(transfer)).toBe(false);
		expect(vault.read().accounts[0]?.recoveryBackup?.state).toBe('current');

		vault.lock('manual');
		registerWithCombinedCleanupDebtGate(vault, journal, transfer);
		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).resolves.toEqual({
			ok: true
		});
		expect(vault.read().accounts).toMatchObject([
			{
				steamId64: STEAM_ID,
				sharedSecret: REPLACEMENT.sharedSecret,
				recoveryBackup: { state: 'pending' }
			}
		]);
	});

	it('allows a compatible durable transfer to restore its matching backup', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-compatible-restore-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		await vault.mutate((draft) => draft.accounts.push(storedAccount()));
		const journal = fileWorkflowJournal(root);
		const record: TransferWorkflowRecord = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: vault.sealScopedKey(Buffer.alloc(32, 9))
		});
		const transfer = makeTransfer(vault, journal);
		expect(transfer.recovery()).toMatchObject({ attemptId: record.attemptId, state: 'sending' });
		expect(processOnlyTransferCleanupDebt(transfer)).toBe(false);

		vault.lock('manual');
		registerWithCombinedCleanupDebtGate(
			vault,
			journal,
			transfer,
			() => false,
			() => false
		);
		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).resolves.toEqual({
			ok: true
		});
		expect(vault.read().accounts).toEqual([]);
		expect(journal.transfers()).toHaveLength(1);
	});

	it('refuses backup restore at commit while an account export snapshot is live', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-restore-export-snapshot-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		await vault.mutate((draft) => draft.accounts.push(storedAccount()));

		const coordinator = new VaultKeyOperationCoordinator();
		const releaseSnapshot = coordinator.beginAccountSnapshot(STEAM_ID);
		vault.lock('manual');
		registerVaultHandlers(
			vault,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => true,
			coordinator,
			() => true,
			() => false,
			() => false
		);

		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).rejects.toThrow(
			/export is still finishing/i
		);

		await vault.unlock(PASS);
		expect(vault.read().accounts).toHaveLength(1);
		vault.lock('manual');

		releaseSnapshot();
		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).resolves.toEqual({
			ok: true
		});
		expect(vault.read().accounts).toHaveLength(0);
	});

	it('wires both process-only cleanup predicates into the production restore boundary', () => {
		const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
			''
		);
		const start = main.indexOf('registerVaultHandlers(');
		const end = main.indexOf('registerImportHandlers(', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const registration = main.slice(start, end);
		expect(registration).toMatch(
			/enrollment\.hasEnrollmentCleanupDebt\(\)\s*\|\|\s*transfer\.hasTransferCleanupDebt\(\)/
		);
	});
});

describe('account mutation beside process-only transfer cleanup debt', () => {
	it('wires both committed transfer reconciliation outcomes to the shared routing teardown', () => {
		const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
			''
		);
		const start = main.indexOf('const transfer = new TransferService(');
		const end = main.indexOf('transferForEnrollment = transfer;', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const construction = main.slice(start, end);
		expect(construction).toMatch(/onAccountRemoved:\s*dropAccountRouting/);
		expect(construction).toMatch(
			/onAccountReplaced:\s*\(steamId64\)\s*=>\s*dropAccountRouting\(steamId64\)/
		);
	});

	it('blocks the affected account without freezing an unrelated account', async () => {
		const { root, vault, journal, transfer } = await cleanupDebtFixture();
		const operations = fileOperationJournal(root);
		const blocked = (steamId64: string): boolean =>
			accountMutationBlockedByDurableState(vault, journal, operations, steamId64, (candidate) =>
				processOnlyTransferCleanupDebt(transfer, candidate)
			);

		expect(blocked(STEAM_ID)).toBe(true);
		expect(
			blocked(OTHER_STEAM_ID),
			'an exact cleanup debt for one transfer froze every unrelated account mutation'
		).toBe(false);
	});
});

describe('enrollment beside process-only transfer cleanup debt', () => {
	it('wires the live transfer cleanup check fail-closed before enrollment reaches IPC', () => {
		const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
			''
		);
		const start = main.indexOf('let transferForEnrollment:');
		const end = main.indexOf('const accountMutationBlocked', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const wiring = main.slice(start, end);
		const enrollmentConstruction = wiring.indexOf('new EnrollmentService(');
		const transferConstruction = wiring.indexOf('new TransferService(');
		const liveAssignment = wiring.indexOf('transferForEnrollment = transfer;');
		const handlerRegistration = main.indexOf('registerEnrollmentHandlers(');

		expect(enrollmentConstruction).toBeGreaterThan(-1);
		expect(transferConstruction).toBeGreaterThan(enrollmentConstruction);
		expect(liveAssignment).toBeGreaterThan(transferConstruction);
		expect(handlerRegistration).toBeGreaterThan(start + liveAssignment);
		expect(wiring.match(/transferForEnrollment\s*=\s*transfer\s*;/g)).toHaveLength(1);
		expect(wiring).toMatch(
			/transferCleanupBlocked:\s*\(\)\s*=>\s*\{\s*if\s*\(transferForEnrollment\s*===\s*undefined\)\s*\{\s*throw\s+new\s+Error\([\s\S]*?\)\s*;?\s*\}\s*return\s+transferForEnrollment\.hasTransferCleanupDebt\(\)\s*;?\s*\}/
		);
	});

	function enrollmentWithTransferCleanupGate(
		vault: VaultService,
		journal: WorkflowJournal,
		transferCleanupBlocked: () => boolean,
		startEnrollment: () => Promise<never>
	): EnrollmentService {
		return new EnrollmentService(
			vault,
			{
				forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
			} as unknown as SteamTransportFactory,
			{
				now: () => NOW,
				workflowJournal: journal,
				loginSession: () => enrollmentSession(),
				startEnrollment,
				// Added to the fixture before the implementation so the regression proves
				// the old constructor ignored the live process-only source.
				transferCleanupBlocked
			}
		);
	}

	it('blocks before Steam when a transfer cleanup record survives only in this process', async () => {
		const { vault, journal, transfer } = await cleanupDebtFixture();
		const reachedSteam = vi.fn(() => Promise.reject(new Error('probe reached Steam enrollment')));
		const enrollment = enrollmentWithTransferCleanupGate(
			vault,
			journal,
			() => transfer.hasTransferCleanupDebt(),
			reachedSteam
		);

		const failure = await enrollment.begin('second', 'password').then(
			() => undefined,
			(err: unknown) => err
		);
		expect({
			blockedForCleanup:
				failure instanceof Error && /transfer|cleanup|unresolved/i.test(failure.message),
			steamCalls: reachedSteam.mock.calls.length,
			transferDebt: transfer.hasTransferCleanupDebt()
		}).toEqual({ blockedForCleanup: true, steamCalls: 0, transferDebt: true });
	});

	it('fails closed before Steam when the process-only transfer state cannot answer', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-cleanup-check-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		const journal = fileWorkflowJournal(root);
		const reachedSteam = vi.fn(() => Promise.reject(new Error('probe reached Steam enrollment')));
		const enrollment = enrollmentWithTransferCleanupGate(
			vault,
			journal,
			() => {
				throw new Error('cleanup state unavailable');
			},
			reachedSteam
		);

		const failure = await enrollment.begin('second', 'password').then(
			() => undefined,
			(err: unknown) => err
		);
		expect({
			failedClosed:
				failure instanceof Error && /transfer|cleanup|cannot be checked/i.test(failure.message),
			steamCalls: reachedSteam.mock.calls.length
		}).toEqual({ failedClosed: true, steamCalls: 0 });
	});

	it('rechecks before AddAuthenticator when cleanup debt appears during the email pause', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-debt-email-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		let failNextDirectoryFlush = false;
		const backing = fileWorkflowJournal(root, {
			syncDirectory: () => {
				if (!failNextDirectoryFlush) return;
				failNextDirectoryFlush = false;
				throw Object.assign(new Error('directory flush failed after unlink'), { code: 'EIO' });
			}
		});
		const journal: WorkflowJournal = {
			...backing,
			markTransferRecovery: (record, published) => {
				const updated = backing.markTransferRecovery(record, published);
				if (published) failNextDirectoryFlush = true;
				return updated;
			}
		};
		const transfer = makeTransfer(vault, journal, successfulRecoveryPath);
		const reachedSteam = vi.fn(() => Promise.reject(new Error('probe reached Steam enrollment')));
		const enrollment = new EnrollmentService(
			vault,
			{
				forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
			} as unknown as SteamTransportFactory,
			{
				now: () => NOW,
				workflowJournal: journal,
				loginSession: () => emailEnrollmentSession(),
				startEnrollment: reachedSteam,
				transferCleanupBlocked: () => transfer.hasTransferCleanupDebt()
			}
		);

		await expect(enrollment.begin('second', 'password')).resolves.toMatchObject({
			state: 'needsEmailCode'
		});
		await transfer.authenticate('trader', 'password', 'QK4TX');
		await expect(transfer.completeTransfer('12345')).rejects.toThrow(/safely stored/i);
		expect(transfer.hasTransferCleanupDebt()).toBe(true);
		expect(journal.transfers()).toEqual([]);

		const failure = await enrollment.submitEmailCode('54321').then(
			() => undefined,
			(err: unknown) => err
		);
		expect({
			blockedForCleanup:
				failure instanceof Error && /transfer|cleanup|unresolved/i.test(failure.message),
			steamCalls: reachedSteam.mock.calls.length,
			transferDebt: transfer.hasTransferCleanupDebt()
		}).toEqual({ blockedForCleanup: true, steamCalls: 0, transferDebt: true });
	});
});

describe('resolving a transfer after a compatible backup restored its old account', () => {
	it('removes the proven pre-transfer account before clearing an outside resolution', async () => {
		const { vault, journal, record, transfer, other, teardown } =
			await restoredStaleTransferFixture();
		expect(vault.read().accounts.map((account) => account.steamId64)).toEqual([
			STEAM_ID,
			OTHER_STEAM_ID
		]);

		await transfer.resolve(record.attemptId, 'resolvedOutsideApp', PASS);

		expect(vault.read().accounts).toEqual([other]);
		expect(journal.transfers()).toEqual([]);
		expect(transfer.recovery()).toBeUndefined();
		expect(teardown).toHaveBeenCalledOnce();
		expect(teardown).toHaveBeenCalledWith(STEAM_ID, true);
	});

	it('removes the proven pre-transfer account but retains the replaced marker', async () => {
		const { vault, journal, record, transfer, other, teardown } =
			await restoredStaleTransferFixture();

		await transfer.resolve(record.attemptId, 'replaced', PASS);

		expect(vault.read().accounts).toEqual([other]);
		expect(journal.transfers()).toMatchObject([
			{ attemptId: record.attemptId, steamId64: STEAM_ID, state: 'unreadable' }
		]);
		expect(transfer.recovery()).toMatchObject({
			attemptId: record.attemptId,
			state: 'unreadable'
		});
		expect(teardown).toHaveBeenCalledOnce();
		expect(teardown).toHaveBeenCalledWith(STEAM_ID, true);
	});

	it('requires a fresh passphrase before deleting a proven old row', async () => {
		const missing = await restoredStaleTransferFixture();
		await expect(
			missing.transfer.resolve(missing.record.attemptId, 'resolvedOutsideApp')
		).rejects.toThrow(/passphrase/i);
		expect(missing.vault.read().accounts).toHaveLength(2);
		expect(missing.journal.transfers()).toHaveLength(1);
		expect(missing.teardown).not.toHaveBeenCalled();

		const wrong = await restoredStaleTransferFixture();
		await expect(
			wrong.transfer.resolve(wrong.record.attemptId, 'resolvedOutsideApp', 'wrong passphrase')
		).rejects.toThrow();
		expect(wrong.vault.read().accounts).toHaveLength(2);
		expect(wrong.journal.transfers()).toHaveLength(1);
		expect(wrong.teardown).not.toHaveBeenCalled();
	});

	it('refuses an ambiguous sending record beside a same-ID row', async () => {
		const fixture = await restoredStaleTransferFixture((journal) => journal, 'sending');
		const before = structuredClone(fixture.vault.read().accounts);

		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'replaced', PASS)
		).rejects.toThrow(/cannot prove|ambiguous|which secrets/i);

		expect(fixture.vault.read().accounts).toEqual(before);
		expect(fixture.journal.transfers()).toMatchObject([
			{ attemptId: fixture.record.attemptId, state: 'sending' }
		]);
		expect(fixture.teardown).not.toHaveBeenCalled();
	});

	it('binds a no-change record to only its matching resolution', async () => {
		const fixture = await restoredStaleTransferFixture();
		const noChange = fixture.journal.updateTransfer(fixture.record, { state: 'not-replaced' });
		const before = structuredClone(fixture.vault.read().accounts);

		await expect(fixture.transfer.resolve(noChange.attemptId, 'replaced', PASS)).rejects.toThrow(
			/did not replace|does not match/i
		);
		expect(fixture.vault.read().accounts).toEqual(before);
		expect(fixture.journal.transfers()).toMatchObject([{ state: 'not-replaced' }]);

		await expect(
			fixture.transfer.resolve(noChange.attemptId, 'notReplaced')
		).resolves.toBeUndefined();
		expect(fixture.vault.read().accounts).toEqual(before);
		expect(fixture.journal.transfers()).toEqual([]);
		expect(fixture.teardown).not.toHaveBeenCalled();
	});

	it('recovers an unanswered-to-not-replaced marker whose final rename was interrupted', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-no-change-staged-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		const initial = fileWorkflowJournal(root);
		const sending = initial.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: vault.sealScopedKey(Buffer.alloc(32, 17))
		});
		const unanswered = initial.updateTransfer(sending, { state: 'unanswered' });
		const interruptedBacking = fileWorkflowJournal(root, {
			rename: () => {
				throw Object.assign(new Error('replacement is busy'), { code: 'EBUSY' });
			}
		});
		const interrupted: WorkflowJournal = {
			...interruptedBacking,
			clearTransfer: () => {
				throw Object.assign(new Error('record is busy'), { code: 'EBUSY' });
			}
		};
		const transfer = makeTransfer(vault, interrupted);

		await expect(transfer.resolve(unanswered.attemptId, 'notReplaced')).rejects.toThrow(
			/safety record could not be cleared/i
		);

		const reconciled = fileWorkflowJournal(root);
		expect(reconciled.transfers()).toMatchObject([{ state: 'not-replaced' }]);
		const restarted = makeTransfer(vault, reconciled);
		expect(restarted.awaiting()).toBe('cleanup');
		await expect(restarted.resolve(unanswered.attemptId, 'notReplaced')).resolves.toBeUndefined();
		expect(reconciled.transfers()).toEqual([]);
	});

	it.each([['recoverable', 'replacement'] as const, ['identity-ambiguous', 'unreadable'] as const])(
		'never deletes a %s replacement row on acknowledgement alone',
		async (_label, state) => {
			const fixture = await restoredStaleTransferFixture((journal) => journal, 'sending');
			const replacement = {
				nonce: Buffer.alloc(12, 1).toString('base64'),
				tag: Buffer.alloc(16, 2).toString('base64'),
				ciphertext: Buffer.from('retained replacement').toString('base64')
			};
			fixture.journal.updateTransfer(
				fixture.record,
				state === 'replacement'
					? {
							state,
							wrappedKey: fixture.record.wrappedKey!,
							replacement
						}
					: {
							state,
							wrappedKey: fixture.record.wrappedKey,
							replacement
						}
			);
			const before = structuredClone(fixture.vault.read().accounts);

			await expect(
				fixture.transfer.resolve(fixture.record.attemptId, 'resolvedOutsideApp')
			).rejects.toThrow(/replacement|cannot prove|finish recovery/i);

			expect(fixture.vault.read().accounts).toEqual(before);
			expect(fixture.journal.transfers()).toHaveLength(1);
		}
	);

	it('keeps the old row and exact workflow when the vault reconciliation fails, then retries', async () => {
		const fixture = await restoredStaleTransferFixture();
		const before = structuredClone(fixture.vault.read().accounts);
		fixture.setVaultMutationFailure(true);

		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'resolvedOutsideApp', PASS)
		).rejects.toThrow(/could not be removed|safety record was kept/i);
		expect(fixture.vault.read().accounts).toEqual(before);
		expect(fixture.journal.transfers()).toMatchObject([
			{ attemptId: fixture.record.attemptId, state: 'unanswered' }
		]);

		fixture.setVaultMutationFailure(false);
		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'resolvedOutsideApp', PASS)
		).resolves.toBeUndefined();
		expect(fixture.vault.read().accounts).toEqual([fixture.other]);
		expect(fixture.journal.transfers()).toEqual([]);
	});

	it('retains exact retry evidence when journal clear fails after vault reconciliation', async () => {
		let failClear = true;
		const fixture = await restoredStaleTransferFixture((journal) => ({
			...journal,
			clearTransfer: (record) => {
				if (failClear) throw new Error('injected journal clear failure');
				journal.clearTransfer(record);
			}
		}));

		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'resolvedOutsideApp', PASS)
		).rejects.toThrow(/safety record could not be cleared/i);
		expect(fixture.vault.read().accounts).toEqual([fixture.other]);
		expect(fixture.journal.transfers()).toMatchObject([
			{ attemptId: fixture.record.attemptId, state: 'unanswered' }
		]);
		expect(fixture.transfer.recovery()).toMatchObject({ attemptId: fixture.record.attemptId });
		expect(fixture.teardown).toHaveBeenCalledOnce();
		expect(fixture.teardown).toHaveBeenCalledWith(STEAM_ID, true);

		failClear = false;
		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'resolvedOutsideApp', PASS)
		).resolves.toBeUndefined();
		expect(fixture.journal.transfers()).toEqual([]);
		expect(fixture.teardown).toHaveBeenCalledTimes(1);
	});

	it('retains the exact workflow when the replaced marker cannot be updated, then retries', async () => {
		let failUpdate = true;
		const fixture = await restoredStaleTransferFixture((journal) => ({
			...journal,
			updateTransfer: (record, update) => {
				if (failUpdate) throw new Error('injected journal update failure');
				return journal.updateTransfer(record, update);
			}
		}));

		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'replaced', PASS)
		).rejects.toThrow(/safety record could not be updated/i);
		expect(fixture.vault.read().accounts).toEqual([fixture.other]);
		expect(fixture.journal.transfers()).toMatchObject([
			{ attemptId: fixture.record.attemptId, state: 'unanswered' }
		]);
		expect(fixture.teardown).toHaveBeenCalledOnce();
		expect(fixture.teardown).toHaveBeenCalledWith(STEAM_ID, true);

		failUpdate = false;
		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'replaced', PASS)
		).resolves.toBeUndefined();
		expect(fixture.journal.transfers()).toMatchObject([
			{ attemptId: fixture.record.attemptId, state: 'unreadable' }
		]);
		expect(fixture.teardown).toHaveBeenCalledTimes(1);
	});

	it('finishes an exact retry when the replaced marker committed before reporting failure', async () => {
		let failAfterUpdate = true;
		const fixture = await restoredStaleTransferFixture((journal) => ({
			...journal,
			updateTransfer: (record, update) => {
				const updated = journal.updateTransfer(record, update);
				if (update.state === 'unreadable' && failAfterUpdate) {
					failAfterUpdate = false;
					throw new Error('injected directory flush failure after marker commit');
				}
				return updated;
			}
		}));

		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'replaced', PASS)
		).rejects.toThrow(/safety record could not be updated/i);
		expect(fixture.vault.read().accounts).toEqual([fixture.other]);
		expect(fixture.journal.transfers()).toMatchObject([{ state: 'unreadable' }]);
		expect(fixture.transfer.recovery()).toMatchObject({ state: 'unreadable' });
		expect(fixture.transfer.recovery()?.requiresPassphrase).not.toBe(true);
		expect(fixture.transfer.awaiting()).toBe('unreadable');
		expect(fixture.teardown).toHaveBeenCalledOnce();

		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'replaced')
		).resolves.toBeUndefined();
		expect(fixture.journal.transfers()).toMatchObject([{ state: 'unreadable' }]);
		expect(fixture.teardown).toHaveBeenCalledTimes(1);
	});

	it('shares the account-mutation reservation and releases it for an exact retry', async () => {
		const fixture = await restoredStaleTransferFixture();
		const releaseSnapshot = fixture.coordinator.beginAccountSnapshot(STEAM_ID);

		await expect(
			fixture.transfer.resolve(fixture.record.attemptId, 'resolvedOutsideApp', PASS)
		).rejects.toThrow(/export/i);
		expect(fixture.vault.read().accounts.some((account) => account.steamId64 === STEAM_ID)).toBe(
			true
		);
		expect(fixture.journal.transfers()).toHaveLength(1);

		releaseSnapshot();
		await fixture.transfer.resolve(fixture.record.attemptId, 'resolvedOutsideApp', PASS);
		expect(fixture.vault.read().accounts).toEqual([fixture.other]);
	});

	it('leaves the no-row control path unchanged', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-resolve-no-row-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		const journal = fileWorkflowJournal(root);
		const record = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: vault.sealScopedKey(Buffer.alloc(32, 9))
		});
		const transfer = makeTransfer(vault, journal);

		await expect(transfer.resolve(record.attemptId, 'replaced')).resolves.toBeUndefined();
		expect(vault.read().accounts).toEqual([]);
		expect(journal.transfers()).toMatchObject([{ state: 'unreadable' }]);
	});

	it('promotes the replacement durably before the vault write and survives the next clear failure', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-two-write-failures-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		const backing = fileWorkflowJournal(root);
		let failPromotion = true;
		let failClear = true;
		const journal: WorkflowJournal = {
			...backing,
			updateTransfer: (record, update) => {
				if (update.state === 'replacement' && failPromotion) {
					failPromotion = false;
					throw new Error('injected replacement-record promotion failure');
				}
				return backing.updateTransfer(record, update);
			},
			clearTransfer: (record) => {
				if (failClear) throw new Error('injected pre-unlink clear failure');
				backing.clearTransfer(record);
			}
		};
		const first = makeTransfer(vault, journal);
		await first.authenticate('trader', 'password', 'QK4TX');

		await expect(first.completeTransfer('12345')).rejects.toThrow(
			/encrypted recovery record could not be saved/i
		);
		expect(
			vault.read().accounts,
			'the vault was written even though the replacement record was still only sending'
		).toEqual([]);
		expect(backing.transfers()).toMatchObject([{ state: 'sending' }]);
		expect(backing.transfers()[0]?.replacement).toBeUndefined();

		await expect(first.retryPersist()).rejects.toThrow(
			/safely stored.*safety record could not be cleared/i
		);
		expect(vault.read().accounts).toMatchObject([
			{ steamId64: STEAM_ID, sharedSecret: REPLACEMENT.sharedSecret }
		]);
		expect(backing.transfers()).toMatchObject([
			{ state: 'replacement', replacement: expect.any(Object) }
		]);

		const restarted = makeTransfer(vault, backing);
		expect(restarted.awaiting()).toBe('persist');
		expect(restarted.recovery()?.requiresPassphrase).not.toBe(true);
		for (const resolution of ['notReplaced', 'replaced', 'resolvedOutsideApp'] as const) {
			await expect(
				restarted.resolve(backing.transfers()[0]!.attemptId, resolution, PASS)
			).rejects.toThrow(/replacement|finish recovery/i);
		}

		failClear = false;
		await expect(restarted.retryPersist()).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(backing.transfers()).toEqual([]);
		expect(vault.read().accounts).toHaveLength(1);
	});

	it('reuses an exact replacement promotion that committed before reporting failure', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-promotion-flush-fail-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		const backing = fileWorkflowJournal(root);
		let failAfterPromotion = true;
		const journal: WorkflowJournal = {
			...backing,
			updateTransfer: (record, update) => {
				const updated = backing.updateTransfer(record, update);
				if (update.state === 'replacement' && failAfterPromotion) {
					failAfterPromotion = false;
					throw new Error('injected directory flush failure after replacement promotion');
				}
				return updated;
			}
		};
		const transfer = makeTransfer(vault, journal);
		await transfer.authenticate('trader', 'password', 'QK4TX');

		await expect(transfer.completeTransfer('12345')).rejects.toThrow(
			/encrypted recovery record could not be saved/i
		);
		expect(vault.read().accounts).toEqual([]);
		expect(backing.transfers()).toMatchObject([
			{ state: 'replacement', replacement: expect.any(Object) }
		]);

		await expect(transfer.retryPersist()).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(vault.read().accounts).toMatchObject([
			{ steamId64: STEAM_ID, sharedSecret: REPLACEMENT.sharedSecret }
		]);
		expect(backing.transfers()).toEqual([]);
	});

	it('finishes a durable replacement after its old backup was transiently unreadable at submission', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-replacement-after-restore-'));
		roots.push(root);
		const coordinator = new VaultKeyOperationCoordinator();
		let failReplacementVaultWrite = false;
		const vault = new VaultService({
			file: join(root, 'vault.json'),
			now: () => NOW,
			beforeMutationCommit: (current, next) => {
				coordinator.assertAccountSnapshotsUnchanged(current.accounts, next.accounts);
				if (
					failReplacementVaultWrite &&
					current.accounts.find((account) => account.steamId64 === STEAM_ID)?.sharedSecret !==
						REPLACEMENT.sharedSecret &&
					next.accounts.find((account) => account.steamId64 === STEAM_ID)?.sharedSecret ===
						REPLACEMENT.sharedSecret
				) {
					failReplacementVaultWrite = false;
					throw new Error('injected replacement vault write failure');
				}
			}
		});
		await vault.create(PASS);
		const old = {
			...storedAccount(),
			sharedSecret: Buffer.alloc(20, 31).toString('base64'),
			identitySecret: Buffer.alloc(20, 32).toString('base64'),
			revocationCode: 'R-OLD',
			status: 'active' as const
		};
		const other: Account = {
			...storedAccount(),
			steamId64: OTHER_STEAM_ID,
			accountName: 'other',
			sharedSecret: Buffer.alloc(20, 21).toString('base64'),
			identitySecret: Buffer.alloc(20, 22).toString('base64'),
			revocationCode: 'R-OTHER',
			deviceId: 'android:other',
			status: 'active'
		};
		await vault.mutate((draft) => draft.accounts.push(old, other));
		await vault.mutate((draft) => {
			draft.accounts = draft.accounts.filter((account) => account.steamId64 !== STEAM_ID);
		});
		const journal = fileWorkflowJournal(root);
		const first = makeTransfer(vault, journal, successfulRecoveryPath, coordinator);
		await first.authenticate('trader', 'password', 'QK4TX');
		const backupPath = join(root, 'vault.json.bak');
		const validBackup = readFileSync(backupPath, 'utf8');
		writeFileSync(backupPath, '{ temporarily unreadable backup', 'utf8');
		failReplacementVaultWrite = true;

		await expect(first.completeTransfer('12345')).rejects.toThrow(/could not be saved/i);
		expect(journal.transfers()).toMatchObject([
			{ state: 'replacement', replacement: expect.any(Object) }
		]);
		expect(journal.transfers()[0]?.priorAuthenticatorFingerprint).toBeUndefined();
		expect(vault.read().accounts).toEqual([other]);

		writeFileSync(backupPath, validBackup, 'utf8');
		vault.lock('manual');
		await vault.restoreFromBackup(PASS, (candidate, key) => {
			if (!journal.vaultKeyCompatible(candidate, key)) throw new Error('incompatible workflow key');
		});
		expect(vault.read().accounts).toEqual([old, other]);
		const encryptedReplacement = structuredClone(journal.transfers());

		const replaced = vi.fn((steamId64: string) => {
			const current = vault.read().accounts.find((account) => account.steamId64 === steamId64);
			expect(current?.sharedSecret).toBe(REPLACEMENT.sharedSecret);
		});
		const restarted = makeTransfer(
			vault,
			fileWorkflowJournal(root),
			successfulRecoveryPath,
			coordinator,
			() => undefined,
			replaced
		);
		expect(restarted.recovery()).toMatchObject({
			state: 'replacement',
			requiresPassphrase: true
		});

		await expect(restarted.retryPersist()).rejects.toThrow(/passphrase/i);
		expect(vault.read().accounts).toEqual([old, other]);
		expect(journal.transfers()).toEqual(encryptedReplacement);
		expect(replaced).not.toHaveBeenCalled();

		await expect(restarted.retryPersist('wrong passphrase')).rejects.toThrow();
		expect(vault.read().accounts).toEqual([old, other]);
		expect(journal.transfers()).toEqual(encryptedReplacement);
		expect(replaced).not.toHaveBeenCalled();

		failReplacementVaultWrite = true;
		await expect(restarted.retryPersist(PASS)).rejects.toThrow(/could not be saved/i);
		expect(vault.read().accounts).toEqual([old, other]);
		expect(journal.transfers()).toEqual(encryptedReplacement);
		expect(replaced).not.toHaveBeenCalled();

		await expect(restarted.retryPersist(PASS)).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(vault.read().accounts).toEqual([
			expect.objectContaining({
				steamId64: STEAM_ID,
				sharedSecret: REPLACEMENT.sharedSecret,
				identitySecret: REPLACEMENT.identitySecret
			}),
			other
		]);
		expect(journal.transfers()).toEqual([]);
		expect(replaced).toHaveBeenCalledOnce();
		expect(replaced).toHaveBeenCalledWith(STEAM_ID);
	});
});
