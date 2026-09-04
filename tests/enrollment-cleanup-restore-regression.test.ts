import { mkdtempSync, rmSync } from 'node:fs';
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
import { EnrollmentService } from '../src/main/steam/enrollment';
import type { LoginSessionLike } from '../src/main/steam/login';
import {
	fileWorkflowJournal,
	type EnrollmentWorkflowRecord,
	type WorkflowJournal
} from '../src/main/steam/workflow-journal';
import { VaultKeyOperationCoordinator } from '../src/main/vault/key-operation-coordinator';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import { VaultService } from '../src/main/vault/service';
import { successfulRecoveryPath } from './recovery-fixture';
import { CHANNELS } from '../src/shared/channels';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

const PASS = 'a sufficiently long passphrase';
const STEAM_ID = '76561198000000001';
const NOW = Date.parse('2026-09-03T00:00:00Z');
const TOKEN = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
	JSON.stringify({ aud: ['mobile'], exp: Math.floor(NOW / 1000) + 3600 })
).toString('base64url')}.sig`;

const issued = {
	sharedSecret: Buffer.alloc(20, 3).toString('base64'),
	identitySecret: Buffer.alloc(20, 4).toString('base64'),
	revocationCode: 'R-ONCE',
	deviceId: 'android:issued'
};

function account(): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: issued.sharedSecret,
		identitySecret: issued.identitySecret,
		revocationCode: issued.revocationCode,
		deviceId: issued.deviceId,
		status: 'pendingActivation',
		autoConfirm: newAutoConfirm(),
		addedAt: new Date(NOW).toISOString()
	};
}

function session(): LoginSessionLike {
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
		steamID: { getSteamID64: () => STEAM_ID },
		accessToken: TOKEN,
		refreshToken: TOKEN
	};
}

interface CleanupDebtFixture {
	root: string;
	vault: VaultService;
	journal: WorkflowJournal;
	enrollment: EnrollmentService;
	debt: EnrollmentWorkflowRecord;
}

interface RestartedDurableFixture {
	vault: VaultService;
	journal: WorkflowJournal;
	enrollment: EnrollmentService;
	record: EnrollmentWorkflowRecord;
	setClearMode: (mode: 'before-unlink' | 'after-unlink' | 'normal') => void;
}

const roots: string[] = [];

async function cleanupDebtFixture(): Promise<CleanupDebtFixture> {
	const root = mkdtempSync(join(tmpdir(), 'oda-enrollment-restore-debt-'));
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
		markEnrollmentRecovery: (record, published) => {
			const updated = backing.markEnrollmentRecovery(record, published);
			// Publication is durable before cleanup starts. Fail only the directory
			// flush after clearEnrollment unlinks that now-published workflow.
			if (published) failNextDirectoryFlush = true;
			return updated;
		}
	};
	const enrollment = new EnrollmentService(
		vault,
		{
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory,
		{
			now: () => NOW,
			workflowJournal: journal,
			keyCoordinator: new VaultKeyOperationCoordinator(),
			loginSession: () => session(),
			startEnrollment: () => Promise.resolve(issued),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const }),
			writeRecovery: (account) => successfulRecoveryPath(account)
		}
	);

	await expect(enrollment.begin('trader', 'password')).rejects.toThrow(
		/safely stored.*safety record could not be cleared/i
	);
	const debt = enrollment.unresolvedEnrollment();
	if (debt === undefined)
		throw new Error('the cleanup-debt reproduction did not retain its record');
	expect(vault.read().accounts).toHaveLength(1);
	expect(journal.enrollments()).toEqual([]);
	expect(enrollment.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(true);
	return { root, vault, journal, enrollment, debt };
}

/**
 * Produce the state a real restart sees after the authenticator was stored but
 * the first cleanup failed before unlink: one exact durable recovery record and
 * no process-only fields carried over from the service that created it.
 */
async function restartedDurableFixture(): Promise<RestartedDurableFixture> {
	const root = mkdtempSync(join(tmpdir(), 'oda-enrollment-resolve-debt-'));
	roots.push(root);
	const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
	await vault.create(PASS);

	let clearMode: 'before-unlink' | 'after-unlink' | 'normal' = 'before-unlink';
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
		clearEnrollment: (record) => {
			if (clearMode === 'before-unlink') {
				throw Object.assign(new Error('record could not be unlinked'), { code: 'EBUSY' });
			}
			if (clearMode === 'after-unlink') failNextDirectoryFlush = true;
			backing.clearEnrollment(record);
		}
	};
	const makeEnrollment = (): EnrollmentService =>
		new EnrollmentService(
			vault,
			{
				forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
			} as unknown as SteamTransportFactory,
			{
				now: () => NOW,
				workflowJournal: journal,
				keyCoordinator: new VaultKeyOperationCoordinator(),
				loginSession: () => session(),
				startEnrollment: () => Promise.resolve(issued),
				finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const }),
				// Publish the independent recovery copy first. The fixture is specifically
				// about a later workflow-cleanup failure, not publication debt.
				writeRecovery: (account) => successfulRecoveryPath(account)
			}
		);

	const firstProcess = makeEnrollment();
	await expect(firstProcess.begin('trader', 'password')).rejects.toThrow(
		/safely stored.*safety record could not be cleared/i
	);
	const record = backing.enrollments()[0];
	if (record === undefined) throw new Error('setup did not leave a durable enrollment record');
	expect(record.state).toBe('recoverable');
	expect(vault.read().accounts).toHaveLength(1);

	// A fresh instance deliberately carries none of the first process's fields.
	const enrollment = makeEnrollment();
	return {
		vault,
		journal,
		enrollment,
		record,
		setClearMode: (next) => {
			clearMode = next;
		}
	};
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`${channel} was not registered`);
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

/** Register the restore boundary with its process-only workflow-debt predicate. */
function registerWithCleanupDebtGate(
	vault: VaultService,
	journal: WorkflowJournal,
	canReplaceVaultKey: () => boolean,
	processOnlyCleanupDebt: () => boolean
): void {
	Reflect.apply(registerVaultHandlers, undefined, [
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
		(candidate: Parameters<WorkflowJournal['vaultKeyCompatible']>[0], key: Buffer) =>
			journal.vaultKeyCompatible(candidate, key),
		() => false,
		processOnlyCleanupDebt
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

describe('backup restore beside process-only enrollment cleanup debt', () => {
	it('refuses the pre-enrollment backup before it can erase the stored authenticator', async () => {
		const { vault, journal, enrollment } = await cleanupDebtFixture();
		vault.lock('manual');
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => !enrollment.hasDurableWorkflow(),
			() => enrollment.hasEnrollmentCleanupDebt()
		);

		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).rejects.toThrow(
			/enrollment|safety record|cleanup/i
		);

		await vault.unlock(PASS);
		expect(
			vault.read().accounts,
			'the pre-enrollment backup replaced the only vault copy of the issued secrets'
		).toMatchObject([{ steamId64: STEAM_ID, sharedSecret: issued.sharedSecret }]);
		expect(enrollment.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(true);
	});

	it('fails closed when the process-only-debt check itself cannot answer', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-enrollment-restore-gate-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		await vault.mutate((draft) => draft.accounts.push(account()));
		vault.lock('manual');
		const journal = fileWorkflowJournal(root);
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => true,
			() => {
				throw new Error('cleanup state unreadable');
			}
		);

		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).rejects.toThrow();
		await vault.unlock(PASS);
		expect(vault.read().accounts).toHaveLength(1);
	});

	it('does not let the general durable-workflow gate block a compatible disaster restore', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-enrollment-compatible-restore-'));
		roots.push(root);
		const vault = new VaultService({ file: join(root, 'vault.json'), now: () => NOW });
		await vault.create(PASS);
		await vault.mutate((draft) => draft.accounts.push(account()));
		const journal = fileWorkflowJournal(root);
		journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: vault.sealScopedKey(Buffer.alloc(32, 9))
		});
		vault.lock('manual');
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => false,
			() => false
		);

		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).resolves.toEqual({
			ok: true
		});
		expect(vault.read().accounts).toEqual([]);
		expect(journal.enrollments()).toHaveLength(1);
	});

	it('allows restore only after exact storedHere reconciliation clears the debt', async () => {
		const { vault, journal, enrollment, debt } = await cleanupDebtFixture();
		enrollment.resolveEnrollment(debt.attemptId, STEAM_ID, 'storedHere');
		expect(enrollment.hasEnrollmentCleanupDebt()).toBe(false);
		expect(vault.read().accounts[0]?.recoveryBackup?.state).toBe('current');
		vault.lock('manual');
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => !enrollment.hasDurableWorkflow(),
			() => enrollment.hasEnrollmentCleanupDebt()
		);

		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).resolves.toEqual({
			ok: true
		});
		expect(vault.read().accounts).toMatchObject([
			{
				steamId64: STEAM_ID,
				sharedSecret: issued.sharedSecret,
				recoveryBackup: { state: 'pending' }
			}
		]);
	});

	it('refuses external resolution for exact stored cleanup debt, then accepts storedHere', async () => {
		const { vault, enrollment, debt } = await cleanupDebtFixture();

		expect(() =>
			enrollment.resolveEnrollment(debt.attemptId, STEAM_ID, 'resolvedOutsideApp')
		).toThrow(/stored|vault|account/i);
		expect(enrollment.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(true);
		expect(vault.read().accounts).toMatchObject([
			{ steamId64: STEAM_ID, sharedSecret: issued.sharedSecret }
		]);

		expect(() =>
			enrollment.resolveEnrollment(debt.attemptId, STEAM_ID, 'storedHere')
		).not.toThrow();
		expect(enrollment.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(false);
		expect(vault.read().accounts).toMatchObject([
			{ steamId64: STEAM_ID, sharedSecret: issued.sharedSecret }
		]);
	});

	it('rechecks cleanup debt created while a restore is deriving before replacing the vault', async () => {
		const { vault, journal, enrollment, record, setClearMode } = await restartedDurableFixture();
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => false,
			() => enrollment.hasEnrollmentCleanupDebt()
		);

		// The handler checks the cleanup predicate synchronously, then yields while
		// deriving the backup key. Reconciliation can turn a durable record into
		// process-only cleanup debt in that interval. Locking is deliberately allowed
		// to land during a restore; it must not turn the stale precondition into
		// permission to install the older, pre-enrollment backup.
		const restoring = invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS });
		setClearMode('after-unlink');
		expect(() => enrollment.resolveEnrollment(record.attemptId, STEAM_ID, 'storedHere')).toThrow(
			/directory flush failed after unlink/i
		);
		expect(enrollment.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(true);
		expect(journal.enrollments()).toEqual([]);
		vault.lock('manual');

		const restoreFailure = await restoring.then(
			() => undefined,
			(err: unknown) => err
		);
		if (!vault.isUnlocked()) await vault.unlock(PASS);
		expect(
			{
				refusedForCleanup:
					restoreFailure instanceof Error &&
					/workflow|safety record|cleanup/i.test(restoreFailure.message),
				accounts: vault.read().accounts.map(({ steamId64, sharedSecret }) => ({
					steamId64,
					sharedSecret
				})),
				cleanupDebt: enrollment.hasEnrollmentCleanupDebt(STEAM_ID)
			},
			'the stale precondition let the older backup erase the stored authenticator'
		).toEqual({
			refusedForCleanup: true,
			accounts: [{ steamId64: STEAM_ID, sharedSecret: issued.sharedSecret }],
			cleanupDebt: true
		});
	});

	it('retains restart-time storedHere cleanup debt and refuses an older backup', async () => {
		const { vault, journal, enrollment, record, setClearMode } = await restartedDurableFixture();
		setClearMode('after-unlink');
		expect(() => enrollment.resolveEnrollment(record.attemptId, STEAM_ID, 'storedHere')).toThrow(
			/directory flush failed after unlink/i
		);
		expect(journal.enrollments()).toEqual([]);

		const debtRetained = enrollment.hasEnrollmentCleanupDebt(STEAM_ID);
		vault.lock('manual');
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => true,
			() => enrollment.hasEnrollmentCleanupDebt()
		);
		let restoreRejected = false;
		try {
			await invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS });
		} catch {
			restoreRejected = true;
		}
		if (!vault.isUnlocked()) await vault.unlock(PASS);

		expect({
			debtRetained,
			restoreRejected,
			accounts: vault.read().accounts.map((account) => account.steamId64)
		}).toEqual({ debtRetained: true, restoreRejected: true, accounts: [STEAM_ID] });
	});

	it('clears restart-time cleanup debt only after the exact clear is flushed', async () => {
		const { vault, journal, enrollment, record, setClearMode } = await restartedDurableFixture();
		setClearMode('after-unlink');
		expect(() => enrollment.resolveEnrollment(record.attemptId, STEAM_ID, 'storedHere')).toThrow();
		expect(journal.enrollments()).toEqual([]);

		setClearMode('normal');
		expect(() =>
			enrollment.resolveEnrollment(record.attemptId, STEAM_ID, 'storedHere')
		).not.toThrow();
		expect(enrollment.hasEnrollmentCleanupDebt()).toBe(false);
		expect(vault.read().accounts[0]?.recoveryBackup?.state).toBe('current');

		vault.lock('manual');
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => true,
			() => enrollment.hasEnrollmentCleanupDebt()
		);
		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).resolves.toEqual({
			ok: true
		});
		expect(vault.read().accounts).toMatchObject([
			{
				steamId64: STEAM_ID,
				sharedSecret: issued.sharedSecret,
				recoveryBackup: { state: 'pending' }
			}
		]);
	});

	it('does not misclassify a pre-unlink failure as process-only debt', async () => {
		const { vault, journal, enrollment, record, setClearMode } = await restartedDurableFixture();
		setClearMode('before-unlink');
		expect(() => enrollment.resolveEnrollment(record.attemptId, STEAM_ID, 'storedHere')).toThrow(
			/record could not be unlinked/i
		);
		expect(enrollment.hasEnrollmentCleanupDebt()).toBe(false);
		expect(journal.enrollments()).toMatchObject([{ attemptId: record.attemptId }]);
		expect(vault.read().accounts[0]?.recoveryBackup?.state).toBe('current');

		vault.lock('manual');
		registerWithCleanupDebtGate(
			vault,
			journal,
			() => false,
			() => false
		);
		await expect(invoke(CHANNELS.vaultRestoreBackup, { passphrase: PASS })).resolves.toEqual({
			ok: true
		});
		expect(vault.read().accounts).toMatchObject([
			{
				steamId64: STEAM_ID,
				sharedSecret: issued.sharedSecret,
				recoveryBackup: { state: 'pending' }
			}
		]);
		expect(journal.enrollments()).toMatchObject([{ attemptId: record.attemptId }]);
	});
});
