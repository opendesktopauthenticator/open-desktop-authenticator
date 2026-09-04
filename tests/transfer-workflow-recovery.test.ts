import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EgressError } from '../src/main/net/egress';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { TransferService, type TransferServiceOptions } from '../src/main/steam/transfer';
import { TransferApiError } from '../src/main/steam/transfer-api';
import { authenticatorFingerprint, EnrollmentService } from '../src/main/steam/enrollment';
import type { LoginSessionLike } from '../src/main/steam/login';
import {
	fileWorkflowJournal,
	memoryWorkflowJournal,
	workflowJournalDirectory,
	type WorkflowJournal
} from '../src/main/steam/workflow-journal';
import { memoryOperationJournal } from '../src/main/steam/operation-journal';
import { accountMutationBlockedByDurableState } from '../src/main/steam/account-mutation-guard';
import { openBytesWithKey, sealBytesWithKey } from '../src/main/vault/crypto';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import { VaultKeyOperationCoordinator } from '../src/main/vault/key-operation-coordinator';
import { markRecoveryBackupNeeded } from '../src/main/vault/recovery-state';
import type { VaultService } from '../src/main/vault/service';
import type { SteamTransportFactory } from '../src/main/net/transport';
import { CHANNELS } from '../src/shared/channels';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';
import type { Kdf } from '../src/shared/vault-format';
import { successfulRecoveryPath } from './recovery-fixture';

const observedDecryptions = vi.hoisted(() => ({ buffers: [] as Buffer[] }));

vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	const createDecipheriv = ((...args: unknown[]) => {
		const decipher = Reflect.apply(actual.createDecipheriv, actual, args) as ReturnType<
			typeof actual.createDecipheriv
		>;
		const originalUpdate = decipher.update.bind(decipher) as (...updateArgs: unknown[]) => Buffer;
		(
			decipher as unknown as {
				update: (...updateArgs: unknown[]) => Buffer;
			}
		).update = (...updateArgs: unknown[]): Buffer => {
			const result = originalUpdate(...updateArgs);
			observedDecryptions.buffers.push(result);
			return result;
		};
		return decipher;
	}) as typeof actual.createDecipheriv;
	return { ...actual, createDecipheriv };
});

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

const STEAM_ID = '76561198000000001';
const NOW = Date.parse('2026-09-02T00:00:00Z');
const TOKEN = 'eyJhbGciOiJub25lIn0.eyJhdWQiOlsibW9iaWxlIl0sImV4cCI6MjAwMDAwMDAwMH0.';
const VALID_SHARED = Buffer.alloc(20, 1).toString('base64');
const VALID_IDENTITY = Buffer.alloc(20, 2).toString('base64');
const NEWER_SHARED = Buffer.alloc(20, 3).toString('base64');
const NEWER_IDENTITY = Buffer.alloc(20, 4).toString('base64');
const KEY = Buffer.alloc(32, 7);
const KDF: Kdf = {
	type: 'scrypt',
	N: 16384,
	r: 8,
	p: 1,
	salt: Buffer.alloc(32, 8).toString('base64')
};
const REPLACEMENT = {
	sharedSecret: VALID_SHARED,
	identitySecret: VALID_IDENTITY,
	revocationCode: 'R-ONCE',
	serverTime: String(Math.floor(NOW / 1000) + 12),
	steamId64: STEAM_ID
};

function jsonStringLeaves(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(jsonStringLeaves);
	if (value !== null && typeof value === 'object') {
		return Object.values(value).flatMap(jsonStringLeaves);
	}
	return [];
}

function fakeVault(key: Buffer = KEY): {
	vault: VaultService;
	accounts: Account[];
	lock: () => void;
	unlock: () => void;
} {
	const accounts: Account[] = [];
	let locked = false;
	const vault = {
		isUnlocked: () => !locked,
		read: () => {
			if (locked) throw new Error('the vault is locked');
			return { accounts };
		},
		mutate: (change: (draft: { accounts: Account[] }) => void) => {
			if (locked) return Promise.reject(new Error('the vault is locked'));
			change({ accounts });
			return Promise.resolve();
		},
		sealScopedKey: (plaintext: Buffer) => {
			if (locked) throw new Error('the vault is locked');
			return sealBytesWithKey(plaintext, key, KDF);
		},
		openScopedEnvelope: (envelope: unknown) => {
			if (locked) throw new Error('the vault is locked');
			return openBytesWithKey(envelope, key, KDF);
		}
	} as unknown as VaultService;
	return { vault, accounts, lock: () => (locked = true), unlock: () => (locked = false) };
}

function transfer(
	vault: VaultService,
	journal: WorkflowJournal,
	continueChallenge: (...args: never[]) => Promise<unknown>,
	options: {
		keyCoordinator?: VaultKeyOperationCoordinator;
		mintAccessToken?: () => Promise<string>;
		signIn?: () => Promise<{ refreshToken: string; steamId64: string }>;
		startChallenge?: TransferServiceOptions['startChallenge'];
		writeRecovery?: (account: Account) => string;
		updateRecovery?: TransferServiceOptions['updateRecovery'];
		enrollmentCleanupBlocked?: () => boolean;
	} = {}
): TransferService {
	return new TransferService(
		vault,
		{ forAccount: () => Promise.resolve(vi.fn()) } as unknown as SteamTransportFactory,
		() => 0,
		{
			now: () => NOW,
			workflowJournal: journal,
			signIn:
				options.signIn ?? (() => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID })),
			startChallenge: options.startChallenge,
			mintAccessToken: options.mintAccessToken ?? (() => Promise.resolve('access')),
			continueChallenge: continueChallenge as never,
			writeRecovery: options.writeRecovery ?? successfulRecoveryPath,
			updateRecovery: options.updateRecovery,
			keyCoordinator: options.keyCoordinator,
			enrollmentCleanupBlocked: options.enrollmentCleanupBlocked
		}
	);
}

function enrollmentSession(): LoginSessionLike {
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

function enrollment(
	vault: VaultService,
	journal: WorkflowJournal,
	coordinator: VaultKeyOperationCoordinator,
	login: () => LoginSessionLike,
	start: () => Promise<{
		sharedSecret: string;
		identitySecret: string;
		revocationCode: string;
		deviceId: string;
	}>
): EnrollmentService {
	return new EnrollmentService(
		vault,
		{ forAccount: () => Promise.resolve(vi.fn()) } as unknown as SteamTransportFactory,
		{
			now: () => NOW,
			workflowJournal: journal,
			keyCoordinator: coordinator,
			loginSession: login,
			startEnrollment: start,
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		}
	);
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`${channel} was not registered`);
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

function registerVaultWithRecoveryGate(
	vault: VaultService,
	canReplaceVaultKey: () => boolean,
	keyCoordinator: VaultKeyOperationCoordinator = new VaultKeyOperationCoordinator(),
	isCompatibleRecoveryVault: Parameters<typeof registerVaultHandlers>[10] = () => true,
	accountMutationBlocked: Parameters<typeof registerVaultHandlers>[11] = () => false
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
		keyCoordinator,
		isCompatibleRecoveryVault,
		accountMutationBlocked
	);
}

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

describe('durable authenticator transfer recovery', () => {
	it('drops oversized optional replacement metadata before durable recovery', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-bounded-'));
		const held = fakeVault();
		const journal = fileWorkflowJournal(root);
		const app = transfer(held.vault, journal, () =>
			Promise.resolve({
				success: true,
				replacementToken: { ...REPLACEMENT, uri: 'u'.repeat(200_000) }
			})
		);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(held.accounts[0]?.uri).toBeUndefined();
		expect(fileWorkflowJournal(root).transfers()).toEqual([]);
	});

	it('bounds an unreadable partial token before encrypting it for restart', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-bounded-partial-'));
		const held = fakeVault();
		const journal = fileWorkflowJournal(root);
		const app = transfer(held.vault, journal, () =>
			Promise.resolve({
				success: true,
				replacementToken: {
					steamId64: STEAM_ID,
					sharedSecret: VALID_SHARED,
					uri: 'u'.repeat(200_000)
				}
			})
		);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).rejects.toThrow(/could not read/i);
		const files = readdirSync(workflowJournalDirectory(root));
		expect(files).toHaveLength(1);
		expect(
			readFileSync(join(workflowJournalDirectory(root), files[0]!), 'utf8').length
		).toBeLessThan(16_000);
		expect(
			transfer(held.vault, fileWorkflowJournal(root), () =>
				Promise.reject(new Error('must not contact Steam'))
			).awaiting()
		).toBe('unreadable');
	});

	it.each([
		['invalid login key', 'not base64!', VALID_IDENTITY],
		['short login key', 'YQ==', VALID_IDENTITY],
		['invalid confirmation key', VALID_SHARED, 'not base64!'],
		['short confirmation key', VALID_SHARED, 'YQ==']
	])(
		'retains a replacement with an %s across restart without storing it',
		async (_case, sharedSecret, identitySecret) => {
			const root = mkdtempSync(join(tmpdir(), 'oda-transfer-invalid-secret-'));
			const journal = fileWorkflowJournal(root);
			const held = fakeVault();
			const invalid = { ...REPLACEMENT, sharedSecret, identitySecret };
			const first = transfer(held.vault, journal, () =>
				Promise.resolve({ success: true, replacementToken: invalid })
			);
			await first.authenticate('trader', 'password', 'QK4TX');

			await expect(first.completeTransfer('12345')).rejects.toThrow(/cannot be used/i);
			expect(held.accounts).toEqual([]);
			const recorded = journal.transfers()[0];
			expect(recorded).toMatchObject({ state: 'unreadable' });
			expect(recorded?.wrappedKey).toBeDefined();
			expect(recorded?.replacement).toBeDefined();
			const disk = readFileSync(
				join(workflowJournalDirectory(root), readdirSync(workflowJournalDirectory(root))[0]!),
				'utf8'
			);
			const storedStrings = jsonStringLeaves(JSON.parse(disk));
			expect(storedStrings).not.toContain(sharedSecret);
			expect(storedStrings).not.toContain(identitySecret);

			const restarted = transfer(held.vault, fileWorkflowJournal(root), () =>
				Promise.reject(new Error('must not contact Steam'))
			);
			expect(restarted.awaiting()).toBe('unreadable');
			await expect(restarted.retryPersist()).rejects.toThrow(/no unsaved authenticator/i);
			expect(held.accounts).toEqual([]);
			expect(fileWorkflowJournal(root).transfers()).toHaveLength(1);
			await restarted.resolve(recorded!.attemptId, 'resolvedOutsideApp');
			expect(fileWorkflowJournal(root).transfers()).toEqual([]);
		}
	);

	it.each([
		['missing recovery code', { ...REPLACEMENT, revocationCode: undefined }, true],
		['missing server time', { ...REPLACEMENT, serverTime: undefined }, true],
		['unsupported Guard scheme', { ...REPLACEMENT, steamGuardScheme: 999 }, true],
		['invalid login key', { ...REPLACEMENT, sharedSecret: 'YQ==' }, true],
		['only a login key', { steamId64: STEAM_ID, sharedSecret: VALID_SHARED }, true],
		['only a confirmation key', { steamId64: STEAM_ID, identitySecret: VALID_IDENTITY }, true],
		['only a recovery code', { steamId64: STEAM_ID, revocationCode: 'R-PARTIAL' }, true],
		[
			'missing recovery code and a false success bit',
			{ ...REPLACEMENT, revocationCode: undefined },
			false
		],
		[
			'missing server time and no success bit',
			{ ...REPLACEMENT, serverTime: undefined },
			undefined
		],
		['unsupported scheme and a false success bit', { ...REPLACEMENT, steamGuardScheme: 999 }, false]
	])(
		'never stores a replacement with %s when the first unreadable-record write fails',
		async (_case, invalid, success) => {
			const backing = memoryWorkflowJournal();
			let failUnreadableWrite = true;
			const journal: WorkflowJournal = {
				...backing,
				updateTransfer: (record, update) => {
					if (update.state === 'unreadable' && failUnreadableWrite) {
						failUnreadableWrite = false;
						throw new Error('disk busy');
					}
					return backing.updateTransfer(record, update);
				}
			};
			const held = fakeVault();
			const mutate = vi.spyOn(held.vault, 'mutate');
			const app = transfer(held.vault, journal, () =>
				Promise.resolve({ success, replacementToken: invalid })
			);
			await app.authenticate('trader', 'password', 'QK4TX');

			await expect(app.completeTransfer('12345')).rejects.toThrow(/held only by this running app/i);
			expect(app.awaiting()).toBe('unreadablePersist');
			expect(app.hasUnsaved()).toBe(true);
			const heldRetry = (app as unknown as { unreadableHeld?: unknown }).unreadableHeld;
			const heldText = JSON.stringify(heldRetry);
			expect(heldText).not.toContain(VALID_SHARED);
			expect(heldText).not.toContain(VALID_IDENTITY);
			expect(heldText).toContain('ciphertext');
			expect(backing.transfers()[0]).toMatchObject({ state: 'sending' });
			expect(held.accounts).toEqual([]);
			expect(
				mutate,
				'an unusable authenticator reached ordinary vault persistence'
			).not.toHaveBeenCalled();

			await expect(app.retryPersist()).rejects.toThrow(/encrypted reply was retained/i);
			expect(app.awaiting()).toBe('unreadable');
			expect(app.hasUnsaved()).toBe(false);
			expect(backing.transfers()[0]).toMatchObject({
				state: 'unreadable',
				wrappedKey: expect.any(Object),
				replacement: expect.any(Object)
			});
			expect(held.accounts).toEqual([]);
			expect(
				mutate,
				'the safety-record retry wrote the unusable authenticator to the vault'
			).not.toHaveBeenCalled();

			await expect(app.retryPersist()).rejects.toThrow(/no unsaved authenticator/i);
			const restarted = transfer(held.vault, journal, () =>
				Promise.reject(new Error('must not contact Steam'))
			);
			expect(restarted.awaiting()).toBe('unreadable');
			const record = backing.transfers()[0];
			await restarted.resolve(record!.attemptId, 'resolvedOutsideApp');
			expect(backing.transfers()).toEqual([]);
		}
	);

	it.each([
		['login key', { steamId64: STEAM_ID, sharedSecret: VALID_SHARED }, VALID_SHARED],
		['confirmation key', { steamId64: STEAM_ID, identitySecret: VALID_IDENTITY }, VALID_IDENTITY],
		['recovery code', { steamId64: STEAM_ID, revocationCode: 'R-PARTIAL' }, 'R-PARTIAL']
	])('encrypts an exact-account partial %s across restart', async (_case, partial, plaintext) => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-partial-'));
		const held = fakeVault();
		const journal = fileWorkflowJournal(root);
		const app = transfer(held.vault, journal, () =>
			Promise.resolve({ success: true, replacementToken: partial })
		);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).rejects.toThrow(/could not read/i);
		expect(held.accounts).toEqual([]);
		const record = journal.transfers()[0];
		expect(record).toMatchObject({ state: 'unreadable', replacement: expect.any(Object) });
		const disk = readFileSync(
			join(workflowJournalDirectory(root), readdirSync(workflowJournalDirectory(root))[0]!),
			'utf8'
		);
		expect(disk).not.toContain(plaintext);

		const restarted = transfer(held.vault, fileWorkflowJournal(root), () =>
			Promise.reject(new Error('must not contact Steam'))
		);
		expect(restarted.awaiting()).toBe('unreadable');
		expect(restarted.recovery()).toMatchObject({ retained: true });
	});

	it.each([
		['a missing SteamID', { sharedSecret: VALID_SHARED }, undefined],
		['a different SteamID', { steamId64: '76561198000000099', sharedSecret: VALID_SHARED }, false]
	])('does not associate %s with the signed-in account', async (_case, token, success) => {
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		const app = transfer(held.vault, journal, () =>
			Promise.resolve({ success, replacementToken: token })
		);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).rejects.toThrow(/cannot tell|incomplete/i);
		expect(journal.transfers()[0]).toMatchObject({ state: 'unanswered' });
		expect(journal.transfers()[0]?.replacement).toBeUndefined();
		expect(held.accounts).toEqual([]);
	});

	it('survives a lock after send, process restart, and a later vault save', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-restart-'));
		const journal = fileWorkflowJournal(root);
		const held = fakeVault();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atRequest = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const first = transfer(held.vault, journal, async () => {
			reached?.();
			await gate;
			return { success: true, replacementToken: REPLACEMENT };
		});
		await first.authenticate('trader', 'password', 'QK4TX');
		const completing = first.completeTransfer('12345');
		await atRequest;
		held.lock();
		expect(first.forgetIfIdle()).toBe(false);
		release?.();
		await expect(completing).rejects.toThrow(/saved.*encrypted recovery.*vault is locked/i);

		const files = readdirSync(workflowJournalDirectory(root));
		expect(files).toHaveLength(1);
		const disk = readFileSync(join(workflowJournalDirectory(root), files[0] as string), 'utf8');
		expect(disk).not.toContain(REPLACEMENT.sharedSecret);
		expect(disk).not.toContain(REPLACEMENT.identitySecret);
		expect(journal.transfers()[0]?.state).toBe('replacement');

		// New instance = process restart. The primary vault is unavailable, but its
		// matching backup can still be restored even though the durable record exists.
		const restarted = transfer(held.vault, fileWorkflowJournal(root), () =>
			Promise.reject(new Error('Steam must not be contacted during recovery'))
		);
		const restoreFromBackup = vi.fn(() => {
			held.unlock();
			return Promise.resolve();
		});
		registerVaultWithRecoveryGate(
			Object.assign(held.vault, { restoreFromBackup }),
			() => !restarted.hasDurableWorkflow()
		);
		await expect(
			invoke(CHANNELS.vaultRestoreBackup, { passphrase: 'a long passphrase' })
		).resolves.toEqual({ ok: true });
		expect(restoreFromBackup).toHaveBeenCalledOnce();
		await expect(restarted.retryPersist()).resolves.toMatchObject({
			steamId64: STEAM_ID,
			revocationCode: 'R-ONCE',
			timeOffsetSeconds: 12
		});
		expect(held.accounts[0]?.sharedSecret).toBe(REPLACEMENT.sharedSecret);
		expect(fileWorkflowJournal(root).transfers()).toEqual([]);
	});

	it('updates an exact stale recovery file before clearing a retained transfer', async () => {
		const backing = memoryWorkflowJournal();
		let refuseRecoveryMark = true;
		const recoveryMarks: boolean[] = [];
		const journal: WorkflowJournal = {
			...backing,
			markTransferRecovery: (record, published) => {
				if (refuseRecoveryMark) throw new Error('journal write failed');
				recoveryMarks.push(published);
				return backing.markTransferRecovery(record, published);
			}
		};
		const held = fakeVault();
		const first = transfer(held.vault, journal, () =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		await first.authenticate('trader', 'password', 'QK4TX');
		await expect(first.completeTransfer('12345')).resolves.toMatchObject({
			recoveryWarning: expect.stringMatching(/Finish recovery/i)
		});
		expect(backing.transfers()[0]).toMatchObject({ state: 'replacement' });
		expect(backing.transfers()[0]).not.toHaveProperty('recoveryPublished');
		const stored = held.accounts[0]!;
		const priorMarker = stored.recoveryBackup;
		expect(priorMarker?.state).toBe('current');
		markRecoveryBackupNeeded(stored, priorMarker, new Date(NOW + 1_000).toISOString());
		const staleMarker = stored.recoveryBackup;
		expect(staleMarker?.state).toBe('stale');

		refuseRecoveryMark = false;
		const writeRecovery = vi.fn(successfulRecoveryPath);
		const updateRecovery = vi.fn(() => 'updated' as const);
		const restarted = transfer(
			held.vault,
			journal,
			() => Promise.reject(new Error('Steam must not be contacted during recovery')),
			{ writeRecovery, updateRecovery }
		);

		await expect(restarted.retryPersist()).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(updateRecovery).toHaveBeenCalledOnce();
		expect(writeRecovery).not.toHaveBeenCalled();
		expect(held.accounts[0]?.recoveryBackup).toMatchObject({
			id: staleMarker?.id,
			state: 'current',
			fileName: priorMarker?.fileName
		});
		expect(recoveryMarks).toEqual([true]);
		expect(backing.transfers()).toEqual([]);
		expect(restarted.hasDurableWorkflow()).toBe(false);
		expect(
			accountMutationBlockedByDurableState(held.vault, backing, memoryOperationJournal(), STEAM_ID)
		).toBe(false);
	});

	it('keeps a replacement record intact when the restored vault has the wrong key', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-wrong-vault-'));
		const journal = fileWorkflowJournal(root);
		const original = fakeVault();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atRequest = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const first = transfer(original.vault, journal, async () => {
			reached?.();
			await gate;
			return { success: true, replacementToken: REPLACEMENT };
		});
		await first.authenticate('trader', 'password', 'QK4TX');
		const completing = first.completeTransfer('12345');
		await atRequest;
		original.lock();
		release?.();
		await expect(completing).rejects.toThrow(/saved.*encrypted recovery.*vault is locked/i);

		const wrong = fakeVault(Buffer.alloc(32, 99));
		const restarted = transfer(wrong.vault, fileWorkflowJournal(root), () =>
			Promise.reject(new Error('Steam must not be contacted during recovery'))
		);
		await expect(restarted.retryPersist()).rejects.toThrow(/could not decrypt/i);
		expect(fileWorkflowJournal(root).transfers()).toHaveLength(1);
		expect(wrong.accounts).toEqual([]);
	});

	it('treats a crash with only sending intent as unknown, not definitely sent', async () => {
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		const wrapped = held.vault.sealScopedKey(Buffer.alloc(32, 2));
		const record = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: wrapped
		});
		const restarted = transfer(held.vault, journal, () => Promise.resolve({ success: false }));
		expect(restarted.awaiting()).toBe('unanswered');
		expect(restarted.recovery()).toMatchObject({ attemptId: record.attemptId, state: 'sending' });
		await restarted.resolve(record.attemptId, 'notReplaced');
		expect(journal.transfers()).toEqual([]);
	});

	it('clears a proven pre-send egress refusal and permits a fresh sign-in', async () => {
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		const app = transfer(held.vault, journal, () =>
			Promise.reject(new EgressError('the proxy refused before send', false))
		);
		await app.authenticate('trader', 'password', 'QK4TX');
		await expect(app.completeTransfer('12345')).rejects.toThrow(/safe to retry/i);
		expect(journal.transfers()).toEqual([]);
		app.cancel();
		await expect(app.authenticate('trader', 'password', 'QK4TX')).resolves.toBeDefined();
	});

	it.each([401, 429, 500, 502, 504])(
		'keeps a bare HTTP %i outcome durable and blocks a second irreversible request',
		async (status) => {
			const held = fakeVault();
			const journal = memoryWorkflowJournal();
			let calls = 0;
			const first = transfer(held.vault, journal, () => {
				calls += 1;
				return Promise.reject(
					new TransferApiError(`Steam returned HTTP ${status} without a result.`, status)
				);
			});
			await first.authenticate('trader', 'password', 'QK4TX');
			await expect(first.completeTransfer('12345')).rejects.toThrow(/cannot tell/i);
			expect(first.awaiting()).toBe('unanswered');
			expect(journal.transfers()).toHaveLength(1);

			const restarted = transfer(held.vault, journal, () => {
				calls += 1;
				return Promise.resolve({ success: true, replacementToken: REPLACEMENT });
			});
			expect(restarted.awaiting()).toBe('unanswered');
			await expect(restarted.authenticate('trader', 'password', 'QK4TX')).rejects.toThrow(
				/unresolved safety record/i
			);
			expect(calls).toBe(1);
		}
	);

	it('keeps an empty HTTP 200 reply durable instead of inventing a refusal', async () => {
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		const app = transfer(held.vault, journal, () => Promise.resolve({}));
		await app.authenticate('trader', 'password', 'QK4TX');
		await expect(app.completeTransfer('12345')).rejects.toThrow(/without saying whether/i);
		expect(app.awaiting()).toBe('unanswered');
		expect(journal.transfers()).toHaveLength(1);
	});

	it('does not call CompleteTransfer when the workflow directory cannot be flushed', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-fsync-'));
		const journal = fileWorkflowJournal(root, {
			syncDirectory: () => {
				throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' });
			}
		});
		const held = fakeVault();
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const app = transfer(held.vault, journal, continueCall);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).rejects.toThrow(/Nothing was sent/i);
		expect(continueCall).not.toHaveBeenCalled();
	});

	it('rolls back a post-publication flush failure before a same-session retry', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-post-publish-fsync-'));
		let flushes = 0;
		const journal = fileWorkflowJournal(root, {
			syncDirectory: () => {
				flushes += 1;
				if (flushes === 2) {
					throw Object.assign(new Error('post-publication directory I/O failure'), {
						code: 'EIO'
					});
				}
			}
		});
		const held = fakeVault();
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const app = transfer(held.vault, journal, continueCall);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).rejects.toThrow(/Nothing was sent/i);
		expect(continueCall).not.toHaveBeenCalled();
		expect(journal.transfers()).toEqual([]);
		expect(fileWorkflowJournal(root).transfers()).toEqual([]);

		await expect(app.completeTransfer('12345')).resolves.toMatchObject({
			steamId64: STEAM_ID
		});
		expect(continueCall).toHaveBeenCalledOnce();
		expect(held.accounts).toHaveLength(1);
	});

	it('turns a failed known-no-change cleanup into explicit debt and never resends', async () => {
		const backing = memoryWorkflowJournal();
		let refuseClear = true;
		let begins = 0;
		const journal: WorkflowJournal = {
			...backing,
			beginTransfer: (input) => {
				begins += 1;
				return backing.beginTransfer(input);
			},
			clearTransfer: (record) => {
				if (refuseClear) throw new Error('disk busy');
				backing.clearTransfer(record);
			}
		};
		let calls = 0;
		const held = fakeVault();
		const app = transfer(held.vault, journal, () => {
			calls += 1;
			return Promise.reject(new EgressError('the proxy refused before send', false));
		});
		await app.authenticate('trader', 'password', 'QK4TX');
		await expect(app.completeTransfer('12345')).rejects.toThrow(
			/safety record could not be cleared/i
		);
		const debt = journal.transfers()[0];
		expect(debt?.state).toBe('not-replaced');
		expect(app.awaiting()).toBe('cleanup');

		await expect(app.completeTransfer('12345')).rejects.toThrow(/safety record still needs/i);
		expect(calls, 'the irreversible transport was called again').toBe(1);
		expect(begins, 'a second workflow record was created').toBe(1);
		expect(journal.transfers()).toEqual([debt]);

		refuseClear = false;
		await app.resolve(debt!.attemptId, 'notReplaced');
		expect(journal.transfers()).toEqual([]);
		expect(app.current()).toBeUndefined();
		await expect(app.startChallenge()).rejects.toThrow(/expired/i);
	});

	it('refuses to resolve the sending record while the irreversible request is in flight', async () => {
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atRequest = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const app = transfer(held.vault, journal, async () => {
			reached?.();
			await gate;
			return { success: true, replacementToken: REPLACEMENT };
		});
		await app.authenticate('trader', 'password', 'QK4TX');
		const completing = app.completeTransfer('12345');
		await atRequest;
		const sending = journal.transfers()[0];
		expect(sending?.state).toBe('sending');
		await expect(app.resolve(sending!.attemptId, 'notReplaced')).rejects.toThrow(
			/still holds or is saving/i
		);
		expect(journal.transfers()).toEqual([sending]);

		release?.();
		await expect(completing).resolves.toMatchObject({ steamId64: STEAM_ID });
	});

	it('does not let a no-passphrase acknowledgement discard recoverable secrets', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-transfer-discard-'));
		const journal = fileWorkflowJournal(root);
		const held = fakeVault();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atRequest = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const app = transfer(held.vault, journal, async () => {
			reached?.();
			await gate;
			return { success: true, replacementToken: REPLACEMENT };
		});
		await app.authenticate('trader', 'password', 'QK4TX');
		const completing = app.completeTransfer('12345');
		await atRequest;
		held.lock();
		release?.();
		await expect(completing).rejects.toThrow();
		const record = journal.transfers()[0];
		expect(record?.state).toBe('replacement');
		await expect(app.resolve(record!.attemptId, 'resolvedOutsideApp')).rejects.toThrow(
			/Finish recovery/i
		);
		expect(journal.transfers()).toHaveLength(1);
	});

	it('does not overwrite a newer same-account authenticator during restart recovery', async () => {
		const backing = memoryWorkflowJournal();
		let failClear = true;
		const journal: WorkflowJournal = {
			...backing,
			clearTransfer: (record) => {
				if (failClear) throw new Error('disk busy');
				backing.clearTransfer(record);
			}
		};
		const held = fakeVault();
		const first = transfer(held.vault, journal, () =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		await first.authenticate('trader', 'password', 'QK4TX');
		await expect(first.completeTransfer('12345')).rejects.toThrow(
			/safely stored.*safety record could not be cleared/i
		);
		const debt = backing.transfers()[0];
		expect(debt?.state).toBe('replacement');
		const newer = {
			...held.accounts[0]!,
			sharedSecret: NEWER_SHARED,
			identitySecret: NEWER_IDENTITY,
			revocationCode: 'R-NEWER',
			proxyUrl: 'socks5://newer.example:1080'
		};
		held.accounts[0] = newer;
		const recoveryWrite = vi.fn();
		failClear = false;
		const restarted = transfer(
			held.vault,
			journal,
			() => Promise.reject(new Error('Steam must not be contacted during recovery')),
			{ writeRecovery: recoveryWrite }
		);

		await expect(restarted.retryPersist()).rejects.toThrow(/different authenticator/i);
		expect(held.accounts).toEqual([newer]);
		expect(
			recoveryWrite,
			'the newer authenticator recovery file was overwritten'
		).not.toHaveBeenCalled();
		expect(backing.transfers()).toEqual([debt]);
	});

	it('clears cleanup debt without regressing an exact stored row', async () => {
		const backing = memoryWorkflowJournal();
		let failClear = true;
		const journal: WorkflowJournal = {
			...backing,
			clearTransfer: (record) => {
				if (failClear) throw new Error('disk busy');
				backing.clearTransfer(record);
			}
		};
		const held = fakeVault();
		const first = transfer(held.vault, journal, () =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		await first.authenticate('trader', 'password', 'QK4TX');
		await expect(first.completeTransfer('12345')).rejects.toThrow(
			/safely stored.*safety record could not be cleared/i
		);
		const debt = backing.transfers()[0];
		expect(debt?.state).toBe('replacement');
		const configured = {
			...held.accounts[0]!,
			status: 'active' as const,
			proxyUrl: 'socks5://proxy.example:1080',
			autoConfirm: {
				...held.accounts[0]!.autoConfirm,
				trades: true,
				notify: { enabled: true, detail: 'count' as const }
			},
			futureField: { keep: 'me' }
		} as Account;
		held.accounts[0] = configured;
		const recoveryWrite = vi.fn();
		failClear = false;
		const restarted = transfer(
			held.vault,
			journal,
			() => Promise.reject(new Error('Steam must not be contacted during recovery')),
			{ writeRecovery: recoveryWrite }
		);

		await expect(restarted.retryPersist()).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(held.accounts[0]).toEqual(configured);
		expect(recoveryWrite).not.toHaveBeenCalled();
		expect(backing.transfers()).toEqual([]);
	});

	it('finishes replacement cleanup in the same process without contacting Steam again', async () => {
		const backing = memoryWorkflowJournal();
		let failClear = true;
		const journal: WorkflowJournal = {
			...backing,
			clearTransfer: (record) => {
				if (failClear) throw new Error('disk busy');
				backing.clearTransfer(record);
			}
		};
		const held = fakeVault();
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const app = transfer(held.vault, journal, continueCall);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).rejects.toThrow(
			/safely stored.*safety record could not be cleared/i
		);
		const debt = backing.transfers()[0];
		expect(debt?.state).toBe('replacement');
		expect(held.accounts).toHaveLength(1);
		const configured = {
			...held.accounts[0]!,
			status: 'active' as const,
			proxyUrl: 'http://name:p%40ss@proxy.example:8080',
			autoConfirm: {
				...held.accounts[0]!.autoConfirm,
				trades: true,
				notify: { enabled: true, detail: 'count' as const }
			},
			futureField: { preserve: true }
		} as Account;
		held.accounts[0] = configured;

		failClear = false;
		await expect(app.retryPersist()).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(continueCall).toHaveBeenCalledOnce();
		expect(held.accounts).toEqual([configured]);
		expect(backing.transfers()).toEqual([]);
		expect(app.current()).toBeUndefined();
	});

	it('retains exact in-process cleanup debt when deletion succeeds but its flush fails', async () => {
		const backing = memoryWorkflowJournal();
		let failAfterDelete = true;
		const journal: WorkflowJournal = {
			...backing,
			clearTransfer: (record) => {
				backing.clearTransfer(record);
				if (failAfterDelete) throw new Error('directory flush failed after deletion');
			}
		};
		const held = fakeVault();
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const app = transfer(held.vault, journal, continueCall);
		await app.authenticate('trader', 'password', 'QK4TX');

		await expect(app.completeTransfer('12345')).rejects.toThrow(
			/safely stored.*safety record could not be cleared/i
		);
		expect(backing.transfers(), 'the file was deleted before its directory flush failed').toEqual(
			[]
		);
		expect(app.recovery()).toMatchObject({ state: 'replacement', retained: false });
		expect(app.awaiting()).toBe('persist');

		failAfterDelete = false;
		await expect(app.retryPersist()).resolves.toMatchObject({ steamId64: STEAM_ID });
		expect(continueCall).toHaveBeenCalledOnce();
		expect(held.accounts).toHaveLength(1);
		expect(backing.transfers()).toEqual([]);
		expect(app.current()).toBeUndefined();
	});

	it('rejects a tampered transfer replacement ciphertext', async () => {
		const backing = memoryWorkflowJournal();
		const journal: WorkflowJournal = {
			...backing,
			clearTransfer: () => {
				throw new Error('keep the recovery record');
			}
		};
		const held = fakeVault();
		const first = transfer(held.vault, journal, () =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		await first.authenticate('trader', 'password', 'QK4TX');
		await expect(first.completeTransfer('12345')).rejects.toThrow(
			/safely stored.*safety record could not be cleared/i
		);
		const debt = backing.transfers()[0];
		expect(debt?.state).toBe('replacement');
		const tag = Buffer.from(debt!.replacement!.tag, 'base64');
		tag[0] = tag[0]! ^ 0x01;
		debt!.replacement!.tag = tag.toString('base64');

		observedDecryptions.buffers.length = 0;
		await expect(
			transfer(held.vault, backing, () => Promise.reject(new Error('no Steam'))).retryPersist()
		).rejects.toThrow(/could not be decrypted or validated/i);
		expect(observedDecryptions.buffers.length).toBeGreaterThanOrEqual(2);
		for (const partialPlaintext of observedDecryptions.buffers) {
			expect(partialPlaintext.every((byte) => byte === 0)).toBe(true);
		}
	});
});

describe('enrollment and transfer share one irreversible boundary', () => {
	it('blocks AddAuthenticator while a transfer sending record is live', async () => {
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		const coordinator = new VaultKeyOperationCoordinator();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atTransfer = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const moving = transfer(
			held.vault,
			journal,
			async () => {
				reached?.();
				await gate;
				return { success: true, replacementToken: REPLACEMENT };
			},
			{ keyCoordinator: coordinator }
		);
		await moving.authenticate('trader', 'password', 'QK4TX');
		const completing = moving.completeTransfer('12345');
		await atTransfer;
		expect(journal.transfers()[0]?.state).toBe('sending');

		const login = vi.fn(() => enrollmentSession());
		const add = vi.fn(() =>
			Promise.resolve({
				sharedSecret: VALID_SHARED,
				identitySecret: VALID_IDENTITY,
				revocationCode: 'R-ADD',
				deviceId: 'android:add'
			})
		);
		await expect(
			enrollment(held.vault, journal, coordinator, login, add).begin('other', 'password')
		).rejects.toThrow(/transfer.*unresolved/i);
		expect(
			login,
			'a password was sent while another irreversible workflow was live'
		).not.toHaveBeenCalled();
		expect(add).not.toHaveBeenCalled();

		release?.();
		await expect(completing).resolves.toMatchObject({ steamId64: STEAM_ID });
	});

	it('blocks transfer sign-in while an AddAuthenticator sending record is live', async () => {
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		const coordinator = new VaultKeyOperationCoordinator();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atEnrollment = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const adding = enrollment(
			held.vault,
			journal,
			coordinator,
			() => enrollmentSession(),
			async () => {
				reached?.();
				await gate;
				return {
					sharedSecret: VALID_SHARED,
					identitySecret: VALID_IDENTITY,
					revocationCode: 'R-ADD',
					deviceId: 'android:add'
				};
			}
		).begin('trader', 'password');
		await atEnrollment;
		expect(journal.enrollments()[0]?.state).toBe('sending');

		const signIn = vi.fn(() => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }));
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const moving = transfer(held.vault, journal, continueCall, {
			keyCoordinator: coordinator,
			signIn
		});
		await expect(moving.authenticate('trader', 'password', 'QK4TX')).rejects.toThrow(
			/authenticator enrollment.*unresolved/i
		);
		expect(signIn, 'transfer credentials were sent beside AddAuthenticator').not.toHaveBeenCalled();
		expect(continueCall).not.toHaveBeenCalled();

		release?.();
		await expect(adding).resolves.toMatchObject({ state: 'enrolled' });
	});

	it('blocks transfer across post-unlink enrollment cleanup debt until exact resolution', async () => {
		const backing = memoryWorkflowJournal();
		let failAfterDelete = true;
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: (record) => {
				backing.clearEnrollment(record);
				if (failAfterDelete) {
					failAfterDelete = false;
					throw new Error('directory flush failed after deletion');
				}
			}
		};
		const held = fakeVault();
		const coordinator = new VaultKeyOperationCoordinator();
		const adding = enrollment(
			held.vault,
			journal,
			coordinator,
			() => enrollmentSession(),
			() =>
				Promise.resolve({
					sharedSecret: VALID_SHARED,
					identitySecret: VALID_IDENTITY,
					revocationCode: 'R-ADD',
					deviceId: 'android:add'
				})
		);

		await expect(adding.begin('trader', 'password')).rejects.toThrow(
			/safety record could not be cleared/i
		);
		expect(backing.enrollments(), 'the unlink happened before its directory flush failed').toEqual(
			[]
		);
		expect(adding.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(true);

		const signIn = vi.fn(() => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }));
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const moving = transfer(held.vault, journal, continueCall, {
			keyCoordinator: coordinator,
			signIn,
			enrollmentCleanupBlocked: () => adding.hasEnrollmentCleanupDebt()
		});

		await expect(moving.authenticate('trader', 'password', 'QK4TX')).rejects.toThrow(
			/exact local cleanup/i
		);
		expect(
			signIn,
			'transfer credentials crossed the boundary while cleanup debt was live'
		).not.toHaveBeenCalled();
		expect(continueCall).not.toHaveBeenCalled();

		const debt = adding.unresolvedEnrollment();
		adding.resolveEnrollment(debt!.attemptId, STEAM_ID, 'storedHere');
		expect(adding.hasEnrollmentCleanupDebt()).toBe(false);

		// The cleanup gate is gone. The later local-account check still refuses this
		// particular transfer, correctly, but only after sign-in identifies the row.
		await expect(moving.authenticate('trader', 'password', 'QK4TX')).rejects.toThrow(
			/already holds an authenticator for that account/i
		);
		expect(signIn).toHaveBeenCalledOnce();
		expect(continueCall).not.toHaveBeenCalled();
	});

	it('rechecks process-only enrollment debt after transfer sign-in and before submission', async () => {
		const held = fakeVault();
		let blocked = false;
		const signIn = vi.fn(() => {
			blocked = true;
			return Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID });
		});
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const moving = transfer(held.vault, memoryWorkflowJournal(), continueCall, {
			signIn,
			enrollmentCleanupBlocked: () => blocked
		});

		await expect(moving.authenticate('trader', 'password', 'QK4TX')).rejects.toThrow(
			/exact local cleanup/i
		);
		expect(signIn).toHaveBeenCalledOnce();
		expect(moving.current()).toBeUndefined();
		expect(continueCall).not.toHaveBeenCalled();
	});

	it('rechecks process-only enrollment debt before asking Steam to text a code', async () => {
		let blocked = false;
		const startChallenge = vi.fn(() => Promise.resolve({ sent: true, shape: 'json' as const }));
		const moving = transfer(fakeVault().vault, memoryWorkflowJournal(), vi.fn(), {
			startChallenge,
			enrollmentCleanupBlocked: () => blocked
		});
		await moving.authenticate('trader', 'password', 'QK4TX');

		blocked = true;
		await expect(moving.startChallenge()).rejects.toThrow(/exact local cleanup/i);
		expect(
			startChallenge,
			'Steam was asked to spend a text while cleanup debt was live'
		).not.toHaveBeenCalled();
	});

	it('rechecks process-only enrollment debt before the irreversible transfer request', async () => {
		let blocked = false;
		const continueCall = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const moving = transfer(fakeVault().vault, memoryWorkflowJournal(), continueCall, {
			enrollmentCleanupBlocked: () => blocked
		});
		await moving.authenticate('trader', 'password', 'QK4TX');

		blocked = true;
		await expect(moving.completeTransfer('12345')).rejects.toThrow(/exact local cleanup/i);
		expect(
			continueCall,
			'Steam was asked to rotate while cleanup debt was live'
		).not.toHaveBeenCalled();
	});

	it('fails the process-only enrollment gate closed', async () => {
		const signIn = vi.fn(() => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }));
		const moving = transfer(fakeVault().vault, memoryWorkflowJournal(), vi.fn(), {
			signIn,
			enrollmentCleanupBlocked: () => {
				throw new Error('cleanup state unavailable');
			}
		});

		await expect(moving.authenticate('trader', 'password', 'QK4TX')).rejects.toThrow(
			/could not be checked.*no authenticator change was requested/i
		);
		expect(signIn).not.toHaveBeenCalled();
	});
});

describe('vault-key replacement boundary', () => {
	it.each([
		[
			'transfer submission',
			(value: VaultKeyOperationCoordinator) => value.beginTransferSubmission(STEAM_ID)
		],
		[
			'enrollment submission',
			(value: VaultKeyOperationCoordinator) => value.beginEnrollmentSubmission(STEAM_ID)
		],
		[
			'transfer recovery',
			(value: VaultKeyOperationCoordinator) => value.beginTransferRecovery(STEAM_ID)
		],
		[
			'enrollment recovery',
			(value: VaultKeyOperationCoordinator) => value.beginEnrollmentRecovery(STEAM_ID)
		],
		[
			'authenticator activation',
			(value: VaultKeyOperationCoordinator) => value.beginActivation(STEAM_ID)
		],
		[
			'authenticator removal',
			(value: VaultKeyOperationCoordinator) => value.beginDeactivation(STEAM_ID)
		]
	] as const)('keeps account mutation out of a live %s', (_kind, begin) => {
		const coordinator = new VaultKeyOperationCoordinator();
		const release = begin(coordinator);
		expect(() => coordinator.beginAccountMutation()).toThrow(/protected authenticator operation/i);
		release();
		const releaseMutation = coordinator.beginAccountMutation();
		releaseMutation();
	});

	it('keeps every protected operation out of an account mutation', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const releaseMutation = coordinator.beginAccountMutation();
		for (const begin of [
			() => coordinator.beginTransferSubmission(STEAM_ID),
			() => coordinator.beginEnrollmentSubmission(STEAM_ID),
			() => coordinator.beginTransferRecovery(STEAM_ID),
			() => coordinator.beginEnrollmentRecovery(STEAM_ID),
			() => coordinator.beginActivation(STEAM_ID),
			() => coordinator.beginDeactivation(STEAM_ID)
		]) {
			expect(begin).toThrow(/account.*being imported, replaced, or removed/i);
		}
		expect(() => coordinator.beginAccountMutation()).toThrow(/another account.*in progress/i);
		await expect(coordinator.duringVaultReplacement(() => undefined)).rejects.toThrow(
			/account import.*in progress/i
		);
		releaseMutation();
		releaseMutation();

		const releaseEnrollment = coordinator.beginEnrollmentSubmission(STEAM_ID);
		releaseEnrollment();
		releaseEnrollment();
		await expect(coordinator.duringVaultReplacement(() => undefined)).resolves.toBeUndefined();
	});

	it('releases the vault-replacement reservation when the operation rejects', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		await expect(
			coordinator.duringVaultReplacement(() => Promise.reject(new Error('replacement failed')))
		).rejects.toThrow(/replacement failed/i);
		const releaseMutation = coordinator.beginAccountMutation();
		releaseMutation();
	});

	it('refuses local account removal while its durable Steam workflow is unresolved', async () => {
		const verifyPassphrase = vi.fn(() => Promise.resolve());
		let failWrite = false;
		const mutate = vi.fn(() => {
			if (failWrite) {
				failWrite = false;
				return Promise.reject(new Error('disk write failed'));
			}
			return Promise.resolve();
		});
		const onProxyChanged = vi.fn();
		const coordinator = new VaultKeyOperationCoordinator();
		let blocked = true;
		registerVaultHandlers(
			{ verifyPassphrase, mutate, touch: () => undefined } as unknown as VaultService,
			onProxyChanged,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => true,
			coordinator,
			() => true,
			(id) => blocked && id === STEAM_ID
		);

		await expect(
			invoke(CHANNELS.accountRemove, { steamId64: STEAM_ID, passphrase: 'correct passphrase' })
		).rejects.toThrow(/finish or resolve.*before removing/i);
		expect(verifyPassphrase).toHaveBeenCalledOnce();
		expect(mutate, 'the account was removed underneath its recovery record').not.toHaveBeenCalled();
		expect(onProxyChanged).not.toHaveBeenCalled();

		blocked = false;
		failWrite = true;
		await expect(
			invoke(CHANNELS.accountRemove, { steamId64: STEAM_ID, passphrase: 'correct passphrase' })
		).rejects.toThrow(/disk write failed/i);
		expect(onProxyChanged).not.toHaveBeenCalled();

		await expect(
			invoke(CHANNELS.accountRemove, { steamId64: STEAM_ID, passphrase: 'correct passphrase' })
		).resolves.toEqual({ ok: true });
		expect(mutate).toHaveBeenCalledTimes(2);
		expect(onProxyChanged).toHaveBeenCalledWith(STEAM_ID, true);
	});

	it('does not remove the only secrets while an activation note owns the account', async () => {
		const held = fakeVault();
		const row: Account = {
			steamId64: STEAM_ID,
			accountName: 'trader',
			sharedSecret: VALID_SHARED,
			identitySecret: VALID_IDENTITY,
			revocationCode: 'R-ONLY',
			status: 'pendingActivation',
			autoConfirm: newAutoConfirm(),
			addedAt: new Date(NOW).toISOString()
		};
		held.accounts.push(row);
		const workflows = memoryWorkflowJournal();
		const operations = memoryOperationJournal();
		operations.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: new Date(NOW).toISOString()
		});
		const onProxyChanged = vi.fn();
		registerVaultHandlers(
			Object.assign(held.vault, {
				verifyPassphrase: () => Promise.resolve(),
				touch: () => undefined
			}),
			onProxyChanged,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => true,
			new VaultKeyOperationCoordinator(),
			() => true,
			(id) => accountMutationBlockedByDurableState(held.vault, workflows, operations, id)
		);

		await expect(
			invoke(CHANNELS.accountRemove, { steamId64: STEAM_ID, passphrase: 'correct passphrase' })
		).rejects.toThrow(/finish or resolve.*before removing/i);
		expect(held.accounts).toEqual([row]);
		expect(operations.readAll(STEAM_ID)).toHaveLength(1);
		expect(onProxyChanged).not.toHaveBeenCalled();
	});

	it('refuses local removal before an in-flight Steam operation has a journal record', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const releaseSteam = coordinator.beginTransferSubmission(STEAM_ID);
		const mutate = vi.fn(() => Promise.resolve());
		registerVaultHandlers(
			{
				verifyPassphrase: () => Promise.resolve(),
				mutate,
				touch: () => undefined
			} as unknown as VaultService,
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
			() => false
		);

		await expect(
			invoke(CHANNELS.accountRemove, { steamId64: STEAM_ID, passphrase: 'correct passphrase' })
		).rejects.toThrow(/transfer submission.*in progress/i);
		expect(mutate).not.toHaveBeenCalled();

		releaseSteam();
		await expect(
			invoke(CHANNELS.accountRemove, { steamId64: STEAM_ID, passphrase: 'correct passphrase' })
		).resolves.toEqual({ ok: true });
		expect(mutate).toHaveBeenCalledOnce();
	});

	it('does not blame a transfer when a second vault operation is the conflict', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const atOperation = new Promise<void>((resolve) => (entered = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const first = coordinator.duringVaultReplacement(async () => {
			entered?.();
			await gate;
		});
		await atOperation;
		await expect(coordinator.duringVaultReplacement(() => undefined)).rejects.toThrow(
			/Another vault.*already in progress/i
		);
		release?.();
		await first;
	});

	it('refuses re-key and restore from the start of a live irreversible submission', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		let releaseMint: (() => void) | undefined;
		let reachedMint: (() => void) | undefined;
		const atMint = new Promise<void>((resolve) => (reachedMint = resolve));
		const mintGate = new Promise<void>((resolve) => (releaseMint = resolve));
		const app = transfer(
			held.vault,
			journal,
			() => Promise.resolve({ success: true, replacementToken: REPLACEMENT }),
			{
				keyCoordinator: coordinator,
				mintAccessToken: async () => {
					reachedMint?.();
					await mintGate;
					return 'access';
				}
			}
		);
		await app.authenticate('trader', 'password', 'QK4TX');
		const completing = app.completeTransfer('12345');
		await atMint;
		expect(journal.transfers(), 'the race must be tested before a workflow file exists').toEqual(
			[]
		);

		const changePassphrase = vi.fn(() => Promise.resolve());
		const restoreFromBackup = vi.fn(() => Promise.resolve());
		registerVaultWithRecoveryGate(
			Object.assign(held.vault, { changePassphrase, restoreFromBackup }),
			() => true,
			coordinator
		);
		await expect(
			invoke(CHANNELS.vaultChangePassphrase, {
				current: 'a long passphrase',
				next: 'another long passphrase'
			})
		).rejects.toThrow(/transfer submission.*in progress/i);
		await expect(
			invoke(CHANNELS.vaultRestoreBackup, { passphrase: 'a long passphrase' })
		).rejects.toThrow(/transfer submission.*in progress/i);
		expect(changePassphrase).not.toHaveBeenCalled();
		expect(restoreFromBackup).not.toHaveBeenCalled();

		releaseMint?.();
		await expect(completing).resolves.toMatchObject({ steamId64: STEAM_ID });
	});

	it('refuses to enter key wrapping while a vault re-key is already in progress', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		let releaseChange: (() => void) | undefined;
		let reachedChange: (() => void) | undefined;
		const atChange = new Promise<void>((resolve) => (reachedChange = resolve));
		const changeGate = new Promise<void>((resolve) => (releaseChange = resolve));
		const held = fakeVault();
		const changePassphrase = vi.fn(async () => {
			reachedChange?.();
			await changeGate;
		});
		registerVaultWithRecoveryGate(
			Object.assign(held.vault, { changePassphrase }),
			() => true,
			coordinator
		);
		const changing = invoke(CHANNELS.vaultChangePassphrase, {
			current: 'a long passphrase',
			next: 'another long passphrase'
		});
		await atChange;

		const continued = vi.fn(() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })
		);
		const journal = memoryWorkflowJournal();
		const app = transfer(held.vault, journal, continued, { keyCoordinator: coordinator });
		await app.authenticate('trader', 'password', 'QK4TX');
		await expect(app.completeTransfer('12345')).rejects.toThrow(/vault is currently being/i);
		expect(continued).not.toHaveBeenCalled();
		expect(journal.transfers()).toEqual([]);

		releaseChange?.();
		await expect(changing).resolves.toEqual({ ok: true });
	});

	it('refuses re-key and restore while AddAuthenticator is in flight', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const held = fakeVault();
		const journal = memoryWorkflowJournal();
		let releaseAdd: (() => void) | undefined;
		let reachedAdd: (() => void) | undefined;
		const atAdd = new Promise<void>((resolve) => (reachedAdd = resolve));
		const addGate = new Promise<void>((resolve) => (releaseAdd = resolve));
		const adding = enrollment(
			held.vault,
			journal,
			coordinator,
			() => enrollmentSession(),
			async () => {
				reachedAdd?.();
				await addGate;
				return {
					sharedSecret: VALID_SHARED,
					identitySecret: VALID_IDENTITY,
					revocationCode: 'R-ADD',
					deviceId: 'android:add'
				};
			}
		).begin('trader', 'password');
		await atAdd;
		expect(journal.enrollments()[0]?.state).toBe('sending');

		const changePassphrase = vi.fn(() => Promise.resolve());
		const restoreFromBackup = vi.fn(() => Promise.resolve());
		registerVaultWithRecoveryGate(
			Object.assign(held.vault, { changePassphrase, restoreFromBackup }),
			() => true,
			coordinator
		);
		await expect(
			invoke(CHANNELS.vaultChangePassphrase, {
				current: 'a long passphrase',
				next: 'another long passphrase'
			})
		).rejects.toThrow(/enrollment submission.*in progress/i);
		await expect(
			invoke(CHANNELS.vaultRestoreBackup, { passphrase: 'a long passphrase' })
		).rejects.toThrow(/enrollment submission.*in progress/i);
		expect(changePassphrase).not.toHaveBeenCalled();
		expect(restoreFromBackup).not.toHaveBeenCalled();

		releaseAdd?.();
		await expect(adding).resolves.toMatchObject({ state: 'enrolled' });
	});

	it('refuses AddAuthenticator key wrapping while a vault re-key is in progress', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		let releaseChange: (() => void) | undefined;
		let reachedChange: (() => void) | undefined;
		const atChange = new Promise<void>((resolve) => (reachedChange = resolve));
		const changeGate = new Promise<void>((resolve) => (releaseChange = resolve));
		const held = fakeVault();
		const changePassphrase = vi.fn(async () => {
			reachedChange?.();
			await changeGate;
		});
		registerVaultWithRecoveryGate(
			Object.assign(held.vault, { changePassphrase }),
			() => true,
			coordinator
		);
		const changing = invoke(CHANNELS.vaultChangePassphrase, {
			current: 'a long passphrase',
			next: 'another long passphrase'
		});
		await atChange;

		const add = vi.fn(() =>
			Promise.resolve({
				sharedSecret: VALID_SHARED,
				identitySecret: VALID_IDENTITY,
				revocationCode: 'R-ADD',
				deviceId: 'android:add'
			})
		);
		await expect(
			enrollment(
				held.vault,
				memoryWorkflowJournal(),
				coordinator,
				() => enrollmentSession(),
				add
			).begin('trader', 'password')
		).rejects.toThrow(/vault is currently being/i);
		expect(add).not.toHaveBeenCalled();

		releaseChange?.();
		await expect(changing).resolves.toEqual({ ok: true });
	});

	it('blocks create and passphrase rotation while a transfer key is wrapped', async () => {
		const create = vi.fn(() => Promise.resolve());
		const changePassphrase = vi.fn(() => Promise.resolve());
		registerVaultWithRecoveryGate(
			{
				create,
				changePassphrase,
				exists: () => true,
				isUnlocked: () => true,
				msUntilAutoLock: () => 1,
				settings: () => ({ requireProxies: false, updateCheck: false }),
				backupAvailable: () => undefined
			} as unknown as VaultService,
			() => false
		);
		await expect(invoke(CHANNELS.vaultCreate, { passphrase: 'a long passphrase' })).rejects.toThrow(
			/Finish or resolve/
		);
		await expect(
			invoke(CHANNELS.vaultChangePassphrase, {
				current: 'a long passphrase',
				next: 'another long passphrase'
			})
		).rejects.toThrow(/Finish or resolve/);
		expect(create).not.toHaveBeenCalled();
		expect(changePassphrase).not.toHaveBeenCalled();
	});

	it('keeps matching backup restore available when the primary vault is damaged', async () => {
		const restoreFromBackup = vi.fn(() => Promise.resolve());
		registerVaultWithRecoveryGate(
			{
				restoreFromBackup,
				exists: () => true,
				isUnlocked: () => false,
				msUntilAutoLock: () => undefined,
				settings: () => ({ requireProxies: false, updateCheck: false }),
				backupAvailable: () => ({})
			} as unknown as VaultService,
			() => false
		);
		await expect(
			invoke(CHANNELS.vaultRestoreBackup, { passphrase: 'a long passphrase' })
		).resolves.toEqual({ ok: true });
		expect(restoreFromBackup).toHaveBeenCalledOnce();
	});
});

describe('production coordinator wiring', () => {
	it('passes one shared coordinator to enrollment, transfer, and vault handlers', () => {
		const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
			''
		);
		const declaration = main.match(/const\s+(\w+)\s*=\s*new\s+VaultKeyOperationCoordinator\(\)/);
		expect(declaration, 'index.ts must construct the coordinator').not.toBeNull();
		const name = declaration![1] as string;
		const transferStart = main.indexOf('new TransferService(');
		const transferEnd = main.indexOf('const activity', transferStart);
		const enrollmentStart = main.indexOf('new EnrollmentService(');
		const enrollmentEnd = main.indexOf('const accountMutationBlocked', enrollmentStart);
		const vaultStart = main.indexOf('registerVaultHandlers(');
		const vaultEnd = main.indexOf('registerImportHandlers(', vaultStart);
		expect(transferStart).toBeGreaterThan(-1);
		expect(transferEnd).toBeGreaterThan(transferStart);
		expect(enrollmentStart).toBeGreaterThan(-1);
		expect(enrollmentEnd).toBeGreaterThan(enrollmentStart);
		expect(vaultStart).toBeGreaterThan(-1);
		expect(vaultEnd).toBeGreaterThan(vaultStart);
		expect(main.slice(transferStart, transferEnd)).toMatch(new RegExp(`\\b${name}\\b`));
		expect(main.slice(enrollmentStart, enrollmentEnd)).toMatch(new RegExp(`\\b${name}\\b`));
		expect(main.slice(vaultStart, vaultEnd)).toMatch(new RegExp(`\\b${name}\\b`));
	});

	it('passes the workflow journal compatibility check into vault recovery handlers', () => {
		const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
			''
		);
		const vaultStart = main.indexOf('registerVaultHandlers(');
		const vaultEnd = main.indexOf('registerImportHandlers(', vaultStart);
		expect(main.slice(vaultStart, vaultEnd)).toMatch(
			/\(candidate,\s*key\)\s*=>\s*workflowJournal\.vaultKeyCompatible\s*\(candidate,\s*key\)/
		);
	});

	it('includes both encrypted workflow services in the vault replacement gate', () => {
		const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
			''
		);
		const vaultStart = main.indexOf('registerVaultHandlers(');
		const vaultEnd = main.indexOf('registerImportHandlers(', vaultStart);
		const registration = main.slice(vaultStart, vaultEnd);
		expect(registration).toMatch(/!transfer\.hasDurableWorkflow\(\)/);
		expect(registration).toMatch(/!enrollment\.hasDurableWorkflow\(\)/);
	});

	it('gives account removal and import one fail-closed journal gate and one coordinator', () => {
		const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
			''
		);
		const blocker = main.match(/const\s+(\w+)\s*=\s*\(steamId64:\s*string\).*?=>/s)?.[1];
		expect(blocker).toBe('accountMutationBlocked');
		const importStart = main.indexOf('new ImportService(');
		const importEnd = main.indexOf('const activity =', importStart);
		const vaultStart = main.indexOf('registerVaultHandlers(');
		const vaultEnd = main.indexOf('registerImportHandlers(', vaultStart);
		const enrollmentStart = main.indexOf('registerEnrollmentHandlers(');
		const enrollmentEnd = main.indexOf('registerCodeHandlers(', enrollmentStart);
		expect(importStart).toBeGreaterThan(-1);
		expect(importEnd).toBeGreaterThan(importStart);
		for (const region of [
			main.slice(importStart, importEnd),
			main.slice(vaultStart, vaultEnd),
			main.slice(enrollmentStart, enrollmentEnd)
		]) {
			expect(region).toMatch(/\baccountMutationBlocked\b/);
			expect(region).toMatch(/\bkeyCoordinator\b/);
		}
		expect(main).toMatch(
			/accountMutationBlockedByDurableState\s*\(\s*vault\s*,\s*workflowJournal\s*,\s*operationJournal\s*,\s*steamId64\s*,\s*\(candidate\)\s*=>\s*enrollment\.hasEnrollmentCleanupDebt\(candidate\)\s*\|\|\s*transfer\.hasTransferCleanupDebt\(candidate\)\s*\)/
		);
		const transferConstruction = main.slice(
			main.indexOf('new TransferService('),
			main.indexOf('const activity', main.indexOf('new TransferService('))
		);
		expect(transferConstruction).toMatch(
			/enrollmentCleanupBlocked:\s*\(\)\s*=>\s*enrollment\.hasEnrollmentCleanupDebt\(\)/
		);
		expect(transferConstruction).toMatch(/updateRecovery:\s*recovery\.updateRecovery/);
		expect(main).toMatch(
			/registerEnrollmentHandlers\([\s\S]*?operationJournal\s*,\s*keyCoordinator\s*,\s*accountMutationBlocked\s*,\s*finishRecoveryBackupUnderReservation\s*\)/
		);
	});
});
