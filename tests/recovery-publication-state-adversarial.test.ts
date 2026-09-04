import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ImportService, type StagedFile } from '../src/main/import/service';
import { accountMutationBlockedByDurableState } from '../src/main/steam/account-mutation-guard';
import { authenticatorFingerprint } from '../src/main/steam/authenticator-secrets';
import { memoryOperationJournal } from '../src/main/steam/operation-journal';
import { memoryWorkflowJournal, type WorkflowJournal } from '../src/main/steam/workflow-journal';
import { markRevocationBackedUp } from '../src/main/vault/ipc';
import {
	createRecoveryHooks,
	readRecoveryFile,
	recoveryContents
} from '../src/main/vault/recovery';
import { finishRecoveryBackup, markRecoveryBackupNeeded } from '../src/main/vault/recovery-state';
import { VaultService } from '../src/main/vault/service';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const STEAM_ID = '76561198000000001';
const SHARED = 'ASNFZ4mrze8BI0VniavN7wEjRWc=';
const SECOND_SHARED = 'ICEiIyQlJicoKSorLC0uLzAxMjM=';
const IDENTITY = '/ty6mHZUMhD+3LqYdlQyEP7cupg=';
const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const PASS = 'a sufficiently long passphrase';

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: SHARED,
		identitySecret: IDENTITY,
		revocationCode: 'R12345',
		status: 'active',
		autoConfirm: newAutoConfirm(),
		addedAt: '2026-09-01T00:00:00.000Z',
		...overrides
	};
}

function memoryVault(initial: Account[]): {
	vault: VaultService;
	accounts: () => Account[];
	replace: (next: Account[]) => void;
} {
	let stored = structuredClone(initial);
	return {
		vault: {
			isUnlocked: () => true,
			read: () => ({
				version: 1,
				settings: {
					requireProxies: false,
					autoLockMinutes: 15,
					clipboardClearSeconds: 30,
					updateCheck: true
				},
				accounts: structuredClone(stored)
			}),
			mutate: async (change: (draft: { accounts: Account[] }) => void | Promise<void>) => {
				const draft = { accounts: structuredClone(stored) };
				await change(draft);
				stored = draft.accounts;
			}
		} as unknown as VaultService,
		accounts: () => structuredClone(stored),
		replace: (next) => {
			stored = structuredClone(next);
		}
	};
}

function maFile(overrides: Record<string, unknown> = {}): StagedFile {
	return {
		name: 'trader.maFile',
		text: JSON.stringify({
			shared_secret: SHARED,
			identity_secret: IDENTITY,
			account_name: 'trader',
			revocation_code: 'R12345',
			steamid: STEAM_ID,
			...overrides
		})
	};
}

function recoveryName(value: Account): string {
	return `${value.steamId64}.${authenticatorFingerprint(value)}.oda-recovery`;
}

function onlyCandidate(service: ImportService, file: StagedFile): string {
	const id = service.stage([file]).candidates[0]?.stagingId;
	if (id === undefined) throw new Error('the fixture did not stage');
	return id;
}

describe('durable recovery-publication state', () => {
	it('does not embed local publication bookkeeping in a portable recovery file', () => {
		const source = account();
		markRecoveryBackupNeeded(source, undefined, '2026-09-03T12:00:00.000Z');

		const plaintext = JSON.parse(recoveryContents(source, '2026-09-03T12:00:01.000Z')) as {
			account: Record<string, unknown>;
		};

		// A restored file can live on another machine or outside app data. Carrying
		// the old basename/state there creates a debt the new installation cannot own.
		expect(plaintext.account).not.toHaveProperty('recoveryBackup');
	});

	it('keeps a failed publication pending on disk and can finish it after a process restart', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'recovery-debt-restart-'));
		try {
			const file = join(directory, 'vault.json');
			const first = new VaultService({ file, now: () => NOW });
			await first.create(PASS);
			const source = account();
			const marker = markRecoveryBackupNeeded(source, undefined, '2026-09-03T12:00:00.000Z');
			await first.mutate((draft) => {
				draft.accounts.push(source);
			});

			await expect(
				finishRecoveryBackup(first, {
					steamId64: STEAM_ID,
					expectedId: marker.id,
					writeRecovery: () => {
						throw new Error('disk full');
					}
				})
			).rejects.toThrow('disk full');
			expect(first.read().accounts[0]?.recoveryBackup).toMatchObject({
				id: marker.id,
				state: 'pending'
			});
			first.lock();

			const restarted = new VaultService({ file, now: () => NOW + 1_000 });
			await restarted.unlock(PASS);
			const hooks = createRecoveryHooks({
				userDataPath: () => directory,
				seal: (plaintext) => restarted.sealForBackup(plaintext),
				now: () => NOW + 1_000
			});
			await expect(
				finishRecoveryBackup(restarted, {
					steamId64: STEAM_ID,
					writeRecovery: hooks.writeRecovery,
					now: () => NOW + 1_000
				})
			).resolves.toBe('current');
			expect(restarted.read().accounts[0]?.recoveryBackup).toMatchObject({
				id: marker.id,
				state: 'current',
				fileName: recoveryName(source)
			});
			restarted.lock();

			const verified = new VaultService({ file, now: () => NOW + 2_000 });
			await verified.unlock(PASS);
			expect(verified.read().accounts[0]?.recoveryBackup).toMatchObject({
				id: marker.id,
				state: 'current',
				fileName: recoveryName(source)
			});
			verified.lock();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not let an older completion clear a newer generation for the same authenticator', async () => {
		const source = account();
		const old = markRecoveryBackupNeeded(source, undefined, '2026-09-03T12:00:00.000Z');
		const memory = memoryVault([source]);
		let newerId = '';

		const result = await finishRecoveryBackup(memory.vault, {
			steamId64: STEAM_ID,
			expectedId: old.id,
			writeRecovery: () => {
				const changed = memory.accounts()[0]!;
				newerId = markRecoveryBackupNeeded(changed, undefined, '2026-09-03T12:00:02.000Z').id;
				memory.replace([changed]);
				return `recovery/${recoveryName(source)}`;
			}
		});

		expect(result).toBe('moved');
		expect(newerId).not.toBe(old.id);
		expect(memory.accounts()[0]?.recoveryBackup).toMatchObject({ id: newerId, state: 'pending' });
	});

	it('does not let an older completion clear a replacement authenticator debt', async () => {
		const source = account();
		const old = markRecoveryBackupNeeded(source, undefined, '2026-09-03T12:00:00.000Z');
		const memory = memoryVault([source]);

		const result = await finishRecoveryBackup(memory.vault, {
			steamId64: STEAM_ID,
			expectedId: old.id,
			writeRecovery: () => {
				const replacement = account({ sharedSecret: SECOND_SHARED });
				markRecoveryBackupNeeded(replacement, undefined, '2026-09-03T12:00:02.000Z');
				memory.replace([replacement]);
				return `recovery/${recoveryName(source)}`;
			}
		});

		expect(result).toBe('moved');
		expect(memory.accounts()[0]?.sharedSecret).toBe(SECOND_SHARED);
		expect(memory.accounts()[0]?.recoveryBackup).toMatchObject({
			authenticatorFingerprint: authenticatorFingerprint(account({ sharedSecret: SECOND_SHARED })),
			state: 'pending'
		});
	});

	it('refuses to persist a callback pathname that was not allocated for this authenticator', async () => {
		const source = account();
		const marker = markRecoveryBackupNeeded(source, undefined, '2026-09-03T12:00:00.000Z');
		const memory = memoryVault([source]);

		await expect(
			finishRecoveryBackup(memory.vault, {
				steamId64: STEAM_ID,
				expectedId: marker.id,
				writeRecovery: () => 'recovery/another-account.oda-recovery'
			})
		).resolves.toBe('missing');
		expect(memory.accounts()[0]?.recoveryBackup).toMatchObject({
			id: marker.id,
			state: 'pending'
		});
	});

	it('updates the exact persisted sibling after recovery hooks are reconstructed', () => {
		const directory = mkdtempSync(join(tmpdir(), 'recovery-owner-'));
		try {
			const source = account();
			const firstHooks = createRecoveryHooks({
				userDataPath: () => directory,
				seal: (plaintext) => ({ plaintext }),
				now: () => NOW
			});
			const primary = firstHooks.writeRecovery(source);
			const sibling = firstHooks.writeRecovery(source);
			expect(sibling).not.toBe(primary);

			source.recoveryBackup = {
				version: 1,
				id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				authenticatorFingerprint: authenticatorFingerprint(source),
				state: 'stale',
				fileName: basename(sibling),
				changedAt: '2026-09-03T12:00:00.000Z'
			};
			const primaryBefore = readFileSync(primary, 'utf8');
			const siblingBefore = readFileSync(sibling, 'utf8');

			// A new hooks object is the process-restart boundary: it has no map or
			// other memory from the write that selected the timestamped sibling.
			const restarted = createRecoveryHooks({
				userDataPath: () => directory,
				seal: (plaintext) => ({ plaintext }),
				now: () => NOW + 1_000
			});
			expect(restarted.updateRecovery(source)).toBe('updated');

			expect(readFileSync(primary, 'utf8')).toBe(primaryBefore);
			expect(readFileSync(sibling, 'utf8')).not.toBe(siblingBefore);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('refuses a persisted basename that escapes or does not identify this authenticator', () => {
		const directory = mkdtempSync(join(tmpdir(), 'recovery-owner-invalid-'));
		try {
			const outside = join(directory, 'outside.oda-recovery');
			writeFileSync(outside, 'do not replace');
			const source = account({
				recoveryBackup: {
					version: 1,
					id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					authenticatorFingerprint: authenticatorFingerprint(account()),
					state: 'stale',
					fileName: '../outside.oda-recovery',
					changedAt: '2026-09-03T12:00:00.000Z'
				}
			});
			const hooks = createRecoveryHooks({
				userDataPath: () => join(directory, 'app-data'),
				seal: (plaintext) => ({ plaintext })
			});

			expect(hooks.updateRecovery(source)).toBe('missing');
			expect(readFileSync(outside, 'utf8')).toBe('do not replace');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('republishes a deleted owned stale file once and releases the account guard across restart', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'recovery-missing-owned-file-'));
		try {
			const file = join(directory, 'vault.json');
			const first = new VaultService({ file, now: () => NOW });
			await first.create(PASS);
			const source = account();
			const firstHooks = createRecoveryHooks({
				userDataPath: () => directory,
				seal: (plaintext) => first.sealForBackup(plaintext),
				now: () => NOW
			});
			const originalPath = firstHooks.writeRecovery(source);
			source.recoveryBackup = {
				version: 1,
				id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				authenticatorFingerprint: authenticatorFingerprint(source),
				state: 'current',
				fileName: basename(originalPath),
				changedAt: '2026-09-03T12:00:00.000Z'
			};
			const previous = source.recoveryBackup;
			source.status = 'pendingRevocationBackup';
			const marker = markRecoveryBackupNeeded(source, previous, '2026-09-03T12:00:01.000Z');
			await first.mutate((draft) => {
				draft.accounts.push(source);
			});
			rmSync(originalPath);
			first.lock();

			const restarted = new VaultService({ file, now: () => NOW + 2_000 });
			await restarted.unlock(PASS);
			const hooks = createRecoveryHooks({
				userDataPath: () => directory,
				seal: (plaintext) => restarted.sealForBackup(plaintext),
				now: () => NOW + 2_000
			});
			const updateRecovery = vi.fn(hooks.updateRecovery);
			const writeRecovery = vi.fn(hooks.writeRecovery);

			await expect(
				finishRecoveryBackup(restarted, {
					steamId64: STEAM_ID,
					expectedId: marker.id,
					updateRecovery,
					writeRecovery,
					now: () => NOW + 2_000
				})
			).resolves.toBe('current');
			expect(updateRecovery).toHaveBeenCalledOnce();
			expect(writeRecovery).toHaveBeenCalledOnce();
			const repaired = restarted.read().accounts[0]!;
			expect(repaired.recoveryBackup).toMatchObject({
				id: marker.id,
				state: 'current',
				fileName: basename(originalPath)
			});
			expect(readdirSync(join(directory, 'recovery'))).toEqual([basename(originalPath)]);
			await expect(
				readRecoveryFile(readFileSync(originalPath, 'utf8'), PASS)
			).resolves.toMatchObject({
				account: {
					steamId64: STEAM_ID,
					status: 'pendingRevocationBackup',
					sharedSecret: SHARED
				}
			});
			expect(
				accountMutationBlockedByDurableState(
					restarted,
					memoryWorkflowJournal(),
					memoryOperationJournal(),
					STEAM_ID
				)
			).toBe(false);

			await expect(
				finishRecoveryBackup(restarted, {
					steamId64: STEAM_ID,
					expectedId: marker.id,
					updateRecovery,
					writeRecovery
				})
			).resolves.toBe('current');
			expect(updateRecovery).toHaveBeenCalledOnce();
			expect(writeRecovery).toHaveBeenCalledOnce();
			restarted.lock();

			const verified = new VaultService({ file, now: () => NOW + 3_000 });
			await verified.unlock(PASS);
			expect(verified.read().accounts[0]?.recoveryBackup).toMatchObject({
				id: marker.id,
				state: 'current',
				fileName: basename(originalPath)
			});
			expect(
				accountMutationBlockedByDurableState(
					verified,
					memoryWorkflowJournal(),
					memoryOperationJournal(),
					STEAM_ID
				)
			).toBe(false);
			verified.lock();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('never republishes when updating the owned stale file is ambiguous', async () => {
		const source = account({
			recoveryBackup: {
				version: 1,
				id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				authenticatorFingerprint: authenticatorFingerprint(account()),
				state: 'stale',
				fileName: recoveryName(account()),
				changedAt: '2026-09-03T12:00:00.000Z'
			}
		});
		const memory = memoryVault([source]);
		const writeRecovery = vi.fn(() => `recovery/${recoveryName(source)}`);

		await expect(
			finishRecoveryBackup(memory.vault, {
				steamId64: STEAM_ID,
				updateRecovery: () => 'ambiguous',
				writeRecovery
			})
		).resolves.toBe('ambiguous');
		expect(writeRecovery).not.toHaveBeenCalled();
		expect(memory.accounts()[0]?.recoveryBackup).toEqual(source.recoveryBackup);
	});

	it('persists an import publication failure with the account and repairs it locally later', async () => {
		const memory = memoryVault([]);
		const imports = new ImportService(memory.vault, {
			now: () => NOW,
			monotonicNow: () => 1,
			onAccountStored: () => {
				throw new Error('disk full');
			}
		});
		const stagingId = onlyCandidate(imports, maFile());

		await expect(
			imports.commit([{ stagingId, replaceExisting: false, adoptProxy: false }])
		).resolves.toMatchObject([
			{
				result: 'imported',
				warning: expect.stringMatching(/recovery backup is not current/i)
			}
		]);
		expect(memory.accounts()[0]?.recoveryBackup?.state).toBe('pending');

		await expect(
			finishRecoveryBackup(memory.vault, {
				steamId64: STEAM_ID,
				writeRecovery: () => `recovery/${recoveryName(memory.accounts()[0]!)}`
			})
		).resolves.toBe('current');
	});

	it('refreshes a status-only import through the exact owned file without creating a sibling', async () => {
		const existing = account({
			recoveryBackup: {
				version: 1,
				id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				authenticatorFingerprint: authenticatorFingerprint(account()),
				state: 'current',
				fileName: `${STEAM_ID}.${authenticatorFingerprint(account())}.oda-recovery`,
				changedAt: '2026-09-03T11:00:00.000Z'
			}
		});
		const memory = memoryVault([existing]);
		const writeRecovery = vi.fn(() => 'should-not-be-used');
		const updateRecovery = vi.fn(() => 'updated' as const);
		const imports = new ImportService(memory.vault, {
			now: () => NOW,
			monotonicNow: () => 1,
			onAccountStored: writeRecovery,
			updateRecovery
		});
		const stagingId = onlyCandidate(imports, maFile({ fully_enrolled: false }));

		await expect(
			imports.commit([{ stagingId, replaceExisting: true, adoptProxy: false }])
		).resolves.toMatchObject([{ result: 'replaced' }]);
		expect(writeRecovery).not.toHaveBeenCalled();
		expect(updateRecovery).toHaveBeenCalledOnce();
		expect(memory.accounts()[0]).toMatchObject({
			status: 'pendingActivation',
			recoveryBackup: {
				state: 'current',
				fileName: existing.recoveryBackup?.fileName
			}
		});
	});

	it('blocks a pending recovery account even when every Steam workflow store is empty', () => {
		const source = account();
		markRecoveryBackupNeeded(source, undefined, '2026-09-03T12:00:00.000Z');
		const memory = memoryVault([source]);

		expect(
			accountMutationBlockedByDurableState(
				memory.vault,
				memoryWorkflowJournal(),
				memoryOperationJournal(),
				STEAM_ID
			)
		).toBe(true);
	});

	it('finishes only file debt and leaves an independent Steam workflow unresolved', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'recovery-file-beside-workflow-'));
		try {
			const source = account({
				autoConfirm: { ...newAutoConfirm(), trades: true }
			});
			const hooks = createRecoveryHooks({
				userDataPath: () => directory,
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
				changedAt: '2026-09-03T12:00:00.000Z'
			};
			const previous = source.recoveryBackup;
			source.autoConfirm.trades = false;
			const marker = markRecoveryBackupNeeded(source, previous, '2026-09-03T12:00:01.000Z');
			const memory = memoryVault([source]);
			const retainedWorkflow = {
				enrollments: (steamId64?: string) =>
					steamId64 === undefined || steamId64 === STEAM_ID ? [{}] : [],
				transfers: () => []
			} as unknown as Pick<WorkflowJournal, 'enrollments' | 'transfers'>;

			await expect(
				finishRecoveryBackup(memory.vault, {
					steamId64: STEAM_ID,
					expectedId: marker.id,
					updateRecovery: hooks.updateRecovery,
					now: () => NOW + 2_000
				})
			).resolves.toBe('current');
			const recovered = JSON.parse(
				(JSON.parse(readFileSync(path, 'utf8')) as { plaintext: string }).plaintext
			) as { account: Account };
			expect(recovered.account.autoConfirm.trades).toBe(false);
			expect(memory.accounts()[0]?.recoveryBackup?.state).toBe('current');
			expect(
				accountMutationBlockedByDurableState(
					memory.vault,
					retainedWorkflow,
					memoryOperationJournal(),
					STEAM_ID
				)
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not leave a recovery file marked current after the revocation ceremony changes it', () => {
		const directory = mkdtempSync(join(tmpdir(), 'recovery-revocation-status-'));
		try {
			const source = account({ status: 'pendingRevocationBackup' });
			const hooks = createRecoveryHooks({
				userDataPath: () => directory,
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
				changedAt: '2026-09-03T12:00:00.000Z'
			};
			const before = readFileSync(path, 'utf8');

			markRevocationBackedUp([source], STEAM_ID, new Date(NOW + 1_000));

			const fileWasUpdated = readFileSync(path, 'utf8') !== before;
			const debtWasRecorded = source.recoveryBackup.state !== 'current';
			expect(
				fileWasUpdated || debtWasRecorded,
				'the vault changed recovery-visible status while both the old file and its marker stayed current'
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
