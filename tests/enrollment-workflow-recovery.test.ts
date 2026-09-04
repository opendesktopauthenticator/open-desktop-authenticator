import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EnrollmentError, startEnrollment, type StartedEnrollment } from '../src/main/steam/enroll';
import { EnrollmentService } from '../src/main/steam/enrollment';
import type { LoginSessionLike } from '../src/main/steam/login';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';
import { openBytesWithKey, sealBytesWithKey } from '../src/main/vault/crypto';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';
import type { Kdf } from '../src/shared/vault-format';
import { VaultKeyOperationCoordinator } from '../src/main/vault/key-operation-coordinator';
import {
	fileWorkflowJournal,
	memoryWorkflowJournal,
	type WorkflowJournal,
	workflowJournalDirectory
} from '../src/main/steam/workflow-journal';

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

const STEAM_ID = '76561198000000001';
const OTHER_ID = '76561198000000002';
const NOW = Date.parse('2026-09-02T00:00:00Z');
const OLD_SHARED = Buffer.alloc(20, 1).toString('base64');
const OLD_IDENTITY = Buffer.alloc(20, 2).toString('base64');
const STARTED_SHARED = Buffer.alloc(20, 3).toString('base64');
const STARTED_IDENTITY = Buffer.alloc(20, 4).toString('base64');
const ONCE_SHARED = Buffer.alloc(20, 5).toString('base64');
const ONCE_IDENTITY = Buffer.alloc(20, 6).toString('base64');
const NEWER_SHARED = Buffer.alloc(20, 7).toString('base64');
const NEWER_IDENTITY = Buffer.alloc(20, 8).toString('base64');
const KEY = Buffer.alloc(32, 11);
const KDF: Kdf = {
	type: 'scrypt',
	N: 16384,
	r: 8,
	p: 1,
	salt: Buffer.alloc(32, 12).toString('base64')
};
const wrapped = () => sealBytesWithKey(Buffer.alloc(32, 9), KEY, KDF);
const MOBILE = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
	JSON.stringify({ aud: ['mobile'], exp: Math.floor(NOW / 1000) + 3600 })
).toString('base64url')}.sig`;

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: OLD_SHARED,
		identitySecret: OLD_IDENTITY,
		revocationCode: 'R-OLD',
		deviceId: 'android:old',
		status: 'active',
		autoConfirm: newAutoConfirm(),
		addedAt: new Date(NOW - 1000).toISOString(),
		...overrides
	};
}

function session(steamId64 = STEAM_ID): LoginSessionLike {
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
		accessToken: MOBILE,
		refreshToken: MOBILE
	};
}

function service(
	journal: WorkflowJournal,
	options: {
		accounts?: Account[];
		vault?: VaultService;
		login?: () => LoginSessionLike;
		start?: () => Promise<never> | Promise<StartedEnrollment>;
		writeRecovery?: (account: Account) => string;
		forAccount?: SteamTransportFactory['forAccount'];
		keyCoordinator?: VaultKeyOperationCoordinator;
	} = {}
): EnrollmentService {
	const accounts = options.accounts ?? [];
	const vault =
		options.vault ??
		({
			isUnlocked: () => true,
			read: () => ({ accounts }),
			mutate: (change: (draft: { accounts: unknown[] }) => void) => {
				change({ accounts });
				return Promise.resolve();
			},
			sealScopedKey: (plaintext: Buffer) => sealBytesWithKey(plaintext, KEY, KDF),
			openScopedEnvelope: (envelope: Parameters<typeof openBytesWithKey>[0]) =>
				openBytesWithKey(envelope, KEY, KDF)
		} as unknown as VaultService);
	return new EnrollmentService(
		vault,
		{
			forAccount:
				options.forAccount ??
				(() => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' })))
		} as unknown as SteamTransportFactory,
		{
			now: () => NOW,
			workflowJournal: journal,
			loginSession: options.login ?? (() => session()),
			startEnrollment:
				options.start ??
				(() =>
					Promise.resolve({
						sharedSecret: STARTED_SHARED,
						identitySecret: STARTED_IDENTITY,
						revocationCode: 'R12345',
						deviceId: 'android:test'
					})),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const }),
			writeRecovery: options.writeRecovery,
			keyCoordinator: options.keyCoordinator
		}
	);
}

describe('enrollment beside account mutation', () => {
	it('does not send AddAuthenticator when an import lands during transport setup', async () => {
		const journal = memoryWorkflowJournal();
		const accounts: Account[] = [];
		const coordinator = new VaultKeyOperationCoordinator();
		let enteredTransport: (() => void) | undefined;
		let releaseTransport: (() => void) | undefined;
		const atTransport = new Promise<void>((resolve) => (enteredTransport = resolve));
		const transportGate = new Promise<void>((resolve) => (releaseTransport = resolve));
		const start = vi.fn(() =>
			Promise.resolve({
				sharedSecret: STARTED_SHARED,
				identitySecret: STARTED_IDENTITY,
				revocationCode: 'R-NEW',
				deviceId: 'android:new'
			})
		);
		const app = service(journal, {
			accounts,
			keyCoordinator: coordinator,
			start,
			forAccount: async () => {
				enteredTransport?.();
				await transportGate;
				return () => Promise.resolve({ status: 200, text: '{}' });
			}
		});

		const enrolling = app.begin('trader', 'password');
		await atTransport;
		const releaseImport = coordinator.beginAccountMutation();
		const imported = account();
		accounts.push(imported);
		releaseImport();
		releaseTransport?.();

		await expect(enrolling).rejects.toThrow(/entered the vault.*nothing was changed/i);
		expect(start, 'AddAuthenticator was sent after the import committed').not.toHaveBeenCalled();
		expect(journal.enrollments()).toEqual([]);
		expect(accounts).toEqual([imported]);
		const releaseAfterward = coordinator.beginAccountMutation();
		releaseAfterward();
	});
});

function lockableVault(key = KEY): {
	vault: VaultService;
	accounts: Account[];
	lock: () => void;
	unlock: () => void;
} {
	const accounts: Account[] = [];
	let locked = false;
	const requireOpen = (): void => {
		if (locked) throw new Error('the vault is locked');
	};
	return {
		accounts,
		lock: () => (locked = true),
		unlock: () => (locked = false),
		vault: {
			isUnlocked: () => !locked,
			read: () => {
				requireOpen();
				return { accounts };
			},
			mutate: (change: (draft: { accounts: Account[] }) => void) => {
				requireOpen();
				change({ accounts });
				return Promise.resolve();
			},
			sealScopedKey: (plaintext: Buffer) => {
				requireOpen();
				return sealBytesWithKey(plaintext, key, KDF);
			},
			openScopedEnvelope: (envelope: Parameters<typeof openBytesWithKey>[0]) => {
				requireOpen();
				return openBytesWithKey(envelope, key, KDF);
			}
		} as unknown as VaultService
	};
}

describe('pre-account enrollment recovery', () => {
	it('makes a partial one-time reply durable without storing it as an account', async () => {
		const backing = memoryWorkflowJournal();
		let failUnreadable = true;
		const journal: WorkflowJournal = {
			...backing,
			updateEnrollment: (record, update) => {
				if (typeof update !== 'string' && update.state === 'unreadable' && failUnreadable) {
					failUnreadable = false;
					throw new Error('disk busy');
				}
				return backing.updateEnrollment(record, update);
			}
		};
		const accounts: Account[] = [];
		const app = service(journal, {
			accounts,
			start: () =>
				startEnrollment(
					() =>
						Promise.resolve({
							status: 200,
							text: JSON.stringify({
								response: {
									status: 1,
									shared_secret: STARTED_SHARED,
									revocation_code: 'R-PARTIAL'
								}
							})
						}),
					{ steamId64: STEAM_ID, accessToken: MOBILE, unixSeconds: Math.floor(NOW / 1000) }
				)
		});

		await expect(app.begin('trader', 'password')).rejects.toThrow(/held only by this running app/i);
		const sending = backing.enrollments()[0]!;
		expect(app.recoveryState(sending)).toBe('memory');
		expect(app.enrollmentRecoveryUsable(sending)).toBe(false);
		expect(accounts).toEqual([]);

		await expect(app.retryEnrollmentPersist(sending.attemptId, STEAM_ID)).rejects.toThrow(
			/encrypted record has been kept/i
		);
		expect(backing.enrollments()[0]).toMatchObject({
			state: 'unreadable',
			recovery: expect.any(Object)
		});
		expect(service(backing, { accounts }).enrollmentRecoveryUsable(backing.enrollments()[0]!)).toBe(
			false
		);
		expect(accounts).toEqual([]);
	});

	it.each([
		['invalid login key', 'not base64!', STARTED_IDENTITY],
		['short login key', 'YQ==', STARTED_IDENTITY],
		['invalid confirmation key', STARTED_SHARED, 'not base64!'],
		['short confirmation key', STARTED_SHARED, 'YQ==']
	])(
		'retains a complete-looking reply with an %s across restart without storing it',
		async (_case, sharedSecret, identitySecret) => {
			const root = mkdtempSync(join(tmpdir(), 'oda-enroll-invalid-secret-'));
			const held = lockableVault();
			const journal = fileWorkflowJournal(root);
			const first = service(journal, {
				vault: held.vault,
				start: () =>
					Promise.resolve({
						sharedSecret,
						identitySecret,
						revocationCode: 'R-INVALID',
						deviceId: 'android:issued'
					})
			});

			await expect(first.begin('trader', 'password')).rejects.toThrow(/cannot be used safely/i);
			expect(held.accounts).toEqual([]);
			const recorded = journal.enrollments()[0];
			expect(recorded).toMatchObject({ state: 'unreadable' });
			expect(recorded?.recovery).toBeDefined();
			expect(recorded?.wrappedKey).toBeDefined();
			expect(first.enrollmentRecoveryUsable(recorded!)).toBe(false);

			const restarted = service(fileWorkflowJournal(root), {
				vault: held.vault,
				login: () => {
					throw new Error('must not sign in');
				},
				start: () => Promise.reject(new Error('must not contact Steam'))
			});
			const afterRestart = restarted.unresolvedEnrollment();
			expect(afterRestart).toMatchObject({
				attemptId: recorded?.attemptId,
				state: 'unreadable'
			});
			expect(restarted.enrollmentRecoveryUsable(afterRestart!)).toBe(false);
			await expect(
				restarted.retryEnrollmentPersist(afterRestart!.attemptId, STEAM_ID)
			).rejects.toThrow(/cannot be saved as a working account/i);
			expect(held.accounts).toEqual([]);
			expect(fileWorkflowJournal(root).enrollments()).toHaveLength(1);
			expect(() =>
				restarted.resolveEnrollment(afterRestart!.attemptId, STEAM_ID, 'notAttached')
			).toThrow(/known to have attached/i);
			restarted.resolveEnrollment(afterRestart!.attemptId, STEAM_ID, 'resolvedOutsideApp');
			expect(fileWorkflowJournal(root).enrollments()).toEqual([]);
		}
	);

	it('encrypts a reply that lands after lock and persists it after restart without Steam', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-enroll-reply-lock-'));
		const journal = fileWorkflowJournal(root);
		const held = lockableVault();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atRequest = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const start = vi.fn(async () => {
			reached?.();
			await gate;
			return {
				sharedSecret: ONCE_SHARED,
				identitySecret: ONCE_IDENTITY,
				revocationCode: 'R-ONCE',
				deviceId: 'android:issued'
			};
		});
		const first = service(journal, { vault: held.vault, start });
		const adding = first.begin('trader', 'password');
		await atRequest;
		held.lock();
		release?.();
		await expect(adding).rejects.toThrow(/encrypted recovery record is intact/i);
		expect(start).toHaveBeenCalledOnce();
		expect(journal.enrollments()[0]).toMatchObject({ state: 'recoverable' });

		const file = readdirSync(workflowJournalDirectory(root))[0] as string;
		const disk = readFileSync(join(workflowJournalDirectory(root), file), 'utf8');
		expect(disk).not.toContain(ONCE_SHARED);
		expect(disk).not.toContain(ONCE_IDENTITY);
		expect(disk).not.toContain('R-ONCE');
		expect(disk).not.toContain(MOBILE);

		held.unlock();
		const loginAfterRestart = vi.fn(() => session());
		const steamAfterRestart = vi.fn(() => Promise.reject(new Error('must not contact Steam')));
		const restarted = service(fileWorkflowJournal(root), {
			vault: held.vault,
			login: loginAfterRestart,
			start: steamAfterRestart
		});
		const pending = restarted.unresolvedEnrollment();
		await expect(
			restarted.retryEnrollmentPersist(pending!.attemptId, pending!.steamId64)
		).resolves.toMatchObject({ state: 'enrolled', steamId64: STEAM_ID });
		expect(loginAfterRestart).not.toHaveBeenCalled();
		expect(steamAfterRestart).not.toHaveBeenCalled();
		expect(held.accounts[0]).toMatchObject({
			sharedSecret: ONCE_SHARED,
			identitySecret: ONCE_IDENTITY,
			revocationCode: 'R-ONCE',
			status: 'pendingActivation'
		});
		expect(fileWorkflowJournal(root).enrollments()).toEqual([]);
	});

	it('persists an uncertain AddAuthenticator outcome and blocks a restarted service', async () => {
		const journal = memoryWorkflowJournal();
		const sentAdd = vi.fn(() =>
			Promise.reject(new EnrollmentError('Steam did not answer', false, true, false))
		);
		const first = service(journal, { start: sentAdd });
		await expect(first.begin('trader', 'password')).rejects.toThrow(/did not answer/i);
		expect(sentAdd).toHaveBeenCalledOnce();
		const recorded = journal.enrollments()[0];
		expect(recorded).toMatchObject({
			steamId64: STEAM_ID,
			accountName: 'trader',
			state: 'unanswered'
		});

		const loginAfterRestart = vi.fn(() => session());
		const addAfterRestart = vi.fn(() => Promise.reject(new Error('must not be sent')));
		const restarted = service(journal, { login: loginAfterRestart, start: addAfterRestart });
		expect(restarted.unresolvedEnrollment()).toMatchObject({
			attemptId: recorded?.attemptId,
			state: 'unanswered'
		});
		await expect(restarted.begin('somebody-else', 'another-password')).rejects.toThrow(
			/earlier attempt.*unresolved/i
		);
		expect(
			loginAfterRestart,
			'the second password reached the sign-in boundary'
		).not.toHaveBeenCalled();
		expect(
			addAfterRestart,
			'a second AddAuthenticator request was attempted'
		).not.toHaveBeenCalled();

		restarted.resolveEnrollment(recorded!.attemptId, STEAM_ID, 'notAttached');
		expect(journal.enrollments()).toEqual([]);
	});

	it('refuses to clear the exact record while AddAuthenticator is still in flight', async () => {
		const journal = memoryWorkflowJournal();
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const atRequest = new Promise<void>((resolve) => (reached = resolve));
		const gate = new Promise<void>((resolve) => (release = resolve));
		const app = service(journal, {
			start: async () => {
				reached?.();
				await gate;
				throw new EnrollmentError('Steam did not answer', false, true, false);
			}
		});
		const enrolling = app.begin('trader', 'password');
		await atRequest;
		const sending = journal.enrollments()[0];
		expect(sending?.state).toBe('sending');
		expect(() => app.resolveEnrollment(sending!.attemptId, STEAM_ID, 'notAttached')).toThrow(
			/still in progress/i
		);
		expect(journal.enrollments()).toEqual([sending]);

		release?.();
		await expect(enrolling).rejects.toThrow(/did not answer/i);
		expect(journal.enrollments()[0]?.state).toBe('unanswered');
	});

	it('blocks every account before sign-in while one durable attempt is unresolved', async () => {
		const journal = memoryWorkflowJournal();
		journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'first-account',
			at: new Date(NOW).toISOString(),
			wrappedKey: wrapped()
		});
		const login = vi.fn(() => session(OTHER_ID));

		await expect(service(journal, { login }).begin('second-account', 'password')).rejects.toThrow(
			/first-account.*unresolved/i
		);
		expect(login).not.toHaveBeenCalled();
		// A new service is the process-restart boundary; the same record still wins.
		await expect(service(journal, { login }).begin('second-account', 'password')).rejects.toThrow();
		expect(login).not.toHaveBeenCalled();
	});

	it('fails closed on a malformed/newer final record before sending a password', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-enroll-corrupt-'));
		mkdirSync(workflowJournalDirectory(root), { recursive: true });
		writeFileSync(join(workflowJournalDirectory(root), 'future-v2.record'), '{}');
		const login = vi.fn(() => session());

		await expect(
			service(fileWorkflowJournal(root), { login }).begin('trader', 'password')
		).rejects.toThrow(/no password was sent/i);
		expect(login).not.toHaveBeenCalled();
	});

	it('does not call AddAuthenticator when the workflow directory cannot be flushed', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-enroll-fsync-'));
		const journal = fileWorkflowJournal(root, {
			syncDirectory: () => {
				throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' });
			}
		});
		const add = vi.fn(() =>
			Promise.resolve({
				sharedSecret: STARTED_SHARED,
				identitySecret: STARTED_IDENTITY,
				revocationCode: 'R-ADD',
				deviceId: 'android:add'
			})
		);

		await expect(service(journal, { start: add }).begin('trader', 'password')).rejects.toThrow(
			/Nothing was sent/i
		);
		expect(add).not.toHaveBeenCalled();
	});

	it('labels an unpublishable successful reply as process-only and can publish it later', async () => {
		const backing = memoryWorkflowJournal();
		let failUpdate = true;
		const journal: WorkflowJournal = {
			...backing,
			updateEnrollment: (record, update) => {
				if (failUpdate && typeof update !== 'string' && update.state === 'recoverable') {
					throw new Error('disk busy');
				}
				return backing.updateEnrollment(record, update);
			}
		};
		const accounts: Account[] = [];
		const app = service(journal, { accounts });
		await expect(app.begin('trader', 'password')).rejects.toThrow(/held only by this running app/i);
		const sending = backing.enrollments()[0];
		expect(sending?.state).toBe('sending');
		expect(app.recoveryState(sending!)).toBe('memory');

		failUpdate = false;
		await expect(app.retryEnrollmentPersist(sending!.attemptId, STEAM_ID)).resolves.toMatchObject({
			state: 'enrolled'
		});
		expect(accounts).toHaveLength(1);
		expect(backing.enrollments()).toEqual([]);
	});

	it('keeps a conservative record when a proven pre-send failure cannot be cleared', async () => {
		const backing = memoryWorkflowJournal();
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: () => {
				throw new Error('disk busy');
			}
		};
		const app = service(journal, {
			start: () => Promise.reject(new EnrollmentError('nothing sent', false))
		});
		await expect(app.begin('trader', 'password')).rejects.toThrow(/local safety record/i);
		expect(app.unresolvedEnrollment()?.state).toBe('not-attached');
	});

	it('distinguishes safe retry, stored cleanup, and external resolution', () => {
		const unknownJournal = memoryWorkflowJournal();
		const unknown = unknownJournal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: wrapped()
		});
		const unknownService = service(unknownJournal);
		unknownService.resolveEnrollment(unknown.attemptId, STEAM_ID, 'notAttached');
		expect(unknownJournal.enrollments()).toEqual([]);

		const attachedJournal = memoryWorkflowJournal();
		let attached = attachedJournal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: wrapped()
		});
		attached = attachedJournal.updateEnrollment(attached, 'attached');
		const missingLocally = service(attachedJournal);
		expect(() =>
			missingLocally.resolveEnrollment(attached.attemptId, STEAM_ID, 'notAttached')
		).toThrow(/known to have attached/i);
		expect(() =>
			missingLocally.resolveEnrollment(attached.attemptId, STEAM_ID, 'storedHere')
		).toThrow(/does not hold/i);
		missingLocally.resolveEnrollment(attached.attemptId, STEAM_ID, 'resolvedOutsideApp');

		const legacyJournal = memoryWorkflowJournal();
		let legacy = legacyJournal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: new Date(NOW).toISOString(),
			wrappedKey: wrapped()
		});
		legacy = legacyJournal.updateEnrollment(legacy, 'attached');
		const sameIdOldAuthenticator = service(legacyJournal, { accounts: [account()] });
		expect(() =>
			sameIdOldAuthenticator.resolveEnrollment(legacy.attemptId, STEAM_ID, 'storedHere')
		).toThrow(/does not hold/i);
		sameIdOldAuthenticator.resolveEnrollment(legacy.attemptId, STEAM_ID, 'resolvedOutsideApp');
		expect(legacyJournal.enrollments()).toEqual([]);
	});

	it('reports same-session cleanup debt when storage succeeded but journal cleanup failed', async () => {
		const backing = memoryWorkflowJournal();
		let failClear = true;
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: (record) => {
				if (failClear) throw new Error('disk busy');
				backing.clearEnrollment(record);
			}
		};
		const accounts: Account[] = [];
		const current = service(journal, { accounts });
		await expect(current.begin('trader', 'password')).rejects.toThrow(
			/safely stored.*safety record could not be cleared/i
		);
		const sameSession = current.unresolvedEnrollment();
		expect(sameSession?.state).toBe('recoverable');
		expect(current.enrollmentStoredFaithfully(sameSession!)).toBe(true);
		const restarted = service(journal, { accounts });
		const pending = restarted.unresolvedEnrollment();
		expect(pending?.state).toBe('recoverable');
		failClear = false;
		restarted.resolveEnrollment(pending!.attemptId, STEAM_ID, 'storedHere');
		expect(backing.enrollments()).toEqual([]);
	});

	it('retains exact cleanup debt when unlink succeeds but its directory flush fails', async () => {
		const backing = memoryWorkflowJournal();
		let failAfterDelete = true;
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: (record) => {
				backing.clearEnrollment(record);
				if (failAfterDelete) {
					failAfterDelete = false;
					throw new Error('directory flush failed');
				}
			}
		};
		const accounts: Account[] = [];
		const app = service(journal, { accounts });

		await expect(app.begin('trader', 'password')).rejects.toThrow(
			/safety record could not be cleared/i
		);
		expect(backing.enrollments()).toEqual([]);
		const debt = app.unresolvedEnrollment();
		expect(debt).toMatchObject({ steamId64: STEAM_ID, state: 'recoverable' });
		expect(app.enrollmentStoredFaithfully(debt!)).toBe(true);
		expect(app.hasDurableWorkflow()).toBe(true);
		expect(app.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(true);
		expect(app.hasEnrollmentCleanupDebt(OTHER_ID)).toBe(false);

		app.resolveEnrollment(debt!.attemptId, STEAM_ID, 'storedHere');
		expect(app.unresolvedEnrollment()).toBeUndefined();
		expect(app.hasDurableWorkflow()).toBe(false);
		expect(app.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(false);
	});

	it('retains post-unlink cleanup debt when Save it now performs the storage', async () => {
		const backing = memoryWorkflowJournal();
		let failAfterDelete = true;
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: (record) => {
				backing.clearEnrollment(record);
				if (failAfterDelete) {
					failAfterDelete = false;
					throw new Error('directory flush failed');
				}
			}
		};
		const held = lockableVault();
		const mutate = held.vault.mutate.bind(held.vault);
		let refuseVaultWrite = true;
		const vault = {
			...held.vault,
			mutate: (change: Parameters<VaultService['mutate']>[0]) =>
				refuseVaultWrite ? Promise.reject(new Error('vault busy')) : mutate(change)
		} as VaultService;
		const app = service(journal, { vault });

		await expect(app.begin('trader', 'password')).rejects.toThrow(/recovery record is intact/i);
		const recoverable = backing.enrollments()[0]!;
		refuseVaultWrite = false;
		await expect(app.retryEnrollmentPersist(recoverable.attemptId, STEAM_ID)).rejects.toThrow(
			/safety record could not be cleared/i
		);
		expect(backing.enrollments()).toEqual([]);
		const debt = app.unresolvedEnrollment();
		expect(debt?.attemptId).toBe(recoverable.attemptId);
		expect(app.enrollmentStoredFaithfully(debt!)).toBe(true);
		expect(app.hasDurableWorkflow()).toBe(true);
		expect(app.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(true);

		app.resolveEnrollment(debt!.attemptId, STEAM_ID, 'storedHere');
		expect(app.unresolvedEnrollment()).toBeUndefined();
		expect(app.hasDurableWorkflow()).toBe(false);
		expect(app.hasEnrollmentCleanupDebt(STEAM_ID)).toBe(false);
	});

	it('does not overwrite a newer same-account authenticator during restart recovery', async () => {
		const backing = memoryWorkflowJournal();
		let failClear = true;
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: (record) => {
				if (failClear) throw new Error('disk busy');
				backing.clearEnrollment(record);
			}
		};
		const accounts: Account[] = [];
		await expect(service(journal, { accounts }).begin('trader', 'password')).rejects.toThrow(
			/safely stored/i
		);
		const debt = backing.enrollments()[0];
		expect(debt?.state).toBe('recoverable');
		const newer = account({
			sharedSecret: NEWER_SHARED,
			identitySecret: NEWER_IDENTITY,
			revocationCode: 'R-NEWER',
			proxyUrl: 'socks5://newer.example:1080'
		});
		accounts[0] = newer;
		const recoveryWrite = vi.fn();
		failClear = false;
		const restarted = service(journal, { accounts, writeRecovery: recoveryWrite });

		await expect(restarted.retryEnrollmentPersist(debt!.attemptId, STEAM_ID)).rejects.toThrow(
			/different authenticator/i
		);
		expect(accounts).toEqual([newer]);
		expect(
			recoveryWrite,
			'the newer authenticator recovery file was overwritten'
		).not.toHaveBeenCalled();
		expect(backing.enrollments()).toEqual([debt]);
	});

	it.each([
		['serialNumber', 'serial-once'],
		['tokenGid', 'gid-once'],
		['uri', 'otpauth://totp/Steam:trader?secret=ONCE']
	] as const)(
		'does not clear recovery when enrollment read-back drops issued %s',
		async (field, value) => {
			const held = lockableVault();
			const read = held.vault.read.bind(held.vault);
			const lossyVault = {
				...held.vault,
				read: () => {
					const current = read();
					return {
						...current,
						accounts: current.accounts.map((entry) => {
							const copy = { ...entry };
							delete copy[field];
							return copy;
						})
					};
				}
			} as VaultService;
			const journal = memoryWorkflowJournal();
			const app = service(journal, {
				vault: lossyVault,
				start: () =>
					Promise.resolve({
						sharedSecret: STARTED_SHARED,
						identitySecret: STARTED_IDENTITY,
						revocationCode: 'R12345',
						deviceId: 'android:test',
						[field]: value
					})
			});

			await expect(app.begin('trader', 'password')).rejects.toThrow(/different authenticator/i);
			expect(journal.enrollments()).toHaveLength(1);
			expect(journal.enrollments()[0]?.state).toBe('recoverable');
			expect(app.hasDurableWorkflow()).toBe(true);
		}
	);

	it('clears cleanup debt without regressing an exact stored row', async () => {
		const backing = memoryWorkflowJournal();
		let failClear = true;
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: (record) => {
				if (failClear) throw new Error('disk busy');
				backing.clearEnrollment(record);
			}
		};
		const accounts: Account[] = [];
		await expect(service(journal, { accounts }).begin('trader', 'password')).rejects.toThrow(
			/safely stored/i
		);
		const debt = backing.enrollments()[0];
		const configured = {
			...accounts[0]!,
			status: 'active' as const,
			proxyUrl: 'socks5://proxy.example:1080',
			autoConfirm: {
				...accounts[0]!.autoConfirm,
				trades: true,
				notify: { enabled: true, detail: 'count' as const }
			},
			futureField: { keep: 'me' }
		} as Account;
		accounts[0] = configured;
		const recoveryWrite = vi.fn();
		failClear = false;
		const restarted = service(journal, { accounts, writeRecovery: recoveryWrite });

		await expect(
			restarted.retryEnrollmentPersist(debt!.attemptId, STEAM_ID)
		).resolves.toMatchObject({ state: 'enrolled' });
		expect(accounts[0]).toEqual(configured);
		expect(recoveryWrite).not.toHaveBeenCalled();
		expect(backing.enrollments()).toEqual([]);
	});

	it('stores a complete enrollment bundle despite a contradictory refusal status', async () => {
		const journal = memoryWorkflowJournal();
		const accounts: Account[] = [];
		const app = service(journal, {
			accounts,
			start: () =>
				startEnrollment(
					() =>
						Promise.resolve({
							status: 200,
							text: JSON.stringify({
								response: {
									status: 29,
									shared_secret: STARTED_SHARED,
									identity_secret: STARTED_IDENTITY,
									revocation_code: 'R12345'
								}
							})
						}),
					{ steamId64: STEAM_ID, accessToken: MOBILE, unixSeconds: Math.floor(NOW / 1000) }
				)
		});

		await expect(app.begin('trader', 'password')).resolves.toMatchObject({ state: 'enrolled' });
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({
			steamId64: STEAM_ID,
			sharedSecret: STARTED_SHARED,
			identitySecret: STARTED_IDENTITY,
			revocationCode: 'R12345'
		});
		expect(journal.enrollments()).toEqual([]);
	});

	it('rejects a tampered enrollment reply ciphertext', async () => {
		const backing = memoryWorkflowJournal();
		const journal: WorkflowJournal = {
			...backing,
			clearEnrollment: () => {
				throw new Error('keep the recovery record');
			}
		};
		const accounts: Account[] = [];
		await expect(service(journal, { accounts }).begin('trader', 'password')).rejects.toThrow(
			/safely stored/i
		);
		const debt = backing.enrollments()[0];
		expect(debt?.state).toBe('recoverable');
		const tag = Buffer.from(debt!.recovery!.tag, 'base64');
		tag[0] = tag[0]! ^ 0x01;
		debt!.recovery!.tag = tag.toString('base64');

		observedDecryptions.buffers.length = 0;
		await expect(
			service(backing, { accounts }).retryEnrollmentPersist(debt!.attemptId, STEAM_ID)
		).rejects.toThrow(/could not be decrypted or validated/i);
		expect(observedDecryptions.buffers.length).toBeGreaterThanOrEqual(2);
		for (const partialPlaintext of observedDecryptions.buffers) {
			expect(partialPlaintext.every((byte) => byte === 0)).toBe(true);
		}
	});

	it('does not accept not-attached after Steam certainly attached but that state update failed', async () => {
		const backing = memoryWorkflowJournal();
		const journal: WorkflowJournal = {
			...backing,
			updateEnrollment: (record, update) => {
				if (update === 'attached') throw new Error('cannot publish attached state');
				return backing.updateEnrollment(record, update);
			}
		};
		const app = service(journal, {
			start: () =>
				Promise.reject(new EnrollmentError('Steam certainly attached it', true, true, true))
		});

		await expect(app.begin('trader', 'password')).rejects.toThrow(/certainly attached/i);
		const pending = backing.enrollments()[0]!;
		expect(pending.state).toBe('sending');
		expect(app.enrollmentKnownAttached(pending)).toBe(true);
		expect(() => app.resolveEnrollment(pending.attemptId, STEAM_ID, 'notAttached')).toThrow(
			/known to have attached/i
		);
		expect(backing.enrollments()).toEqual([pending]);

		// The stronger fact could not be persisted. A new process therefore retains
		// the conservative prompt and requires the user to verify Steam.
		const restarted = service(backing);
		expect(restarted.enrollmentKnownAttached(pending)).toBe(false);
		restarted.resolveEnrollment(pending.attemptId, STEAM_ID, 'notAttached');
		expect(backing.enrollments()).toEqual([]);
	});

	it('recognises a recoverable record published before its update reported failure', async () => {
		const backing = memoryWorkflowJournal();
		let failAfterPublish = true;
		const journal: WorkflowJournal = {
			...backing,
			updateEnrollment: (record, update) => {
				const published = backing.updateEnrollment(record, update);
				if (failAfterPublish && typeof update !== 'string' && update.state === 'recoverable') {
					failAfterPublish = false;
					throw new Error('final directory flush failed');
				}
				return published;
			}
		};
		const held = lockableVault();
		const mutate = held.vault.mutate.bind(held.vault);
		let failSave = true;
		const vault = {
			...held.vault,
			mutate: (change: Parameters<VaultService['mutate']>[0]) =>
				failSave ? Promise.reject(new Error('vault busy')) : mutate(change)
		} as VaultService;
		const app = service(journal, { vault });

		await expect(app.begin('trader', 'password')).rejects.toThrow(/recovery record is intact/i);
		const published = backing.enrollments()[0]!;
		expect(published.state).toBe('recoverable');
		expect(app.recoveryState(published)).toBe('durable');
		expect(app.enrollmentRecoveryUsable(published)).toBe(true);
		failSave = false;
		await expect(app.retryEnrollmentPersist(published.attemptId, STEAM_ID)).resolves.toMatchObject({
			state: 'enrolled'
		});
		expect(backing.enrollments()).toEqual([]);
		expect(app.hasDurableWorkflow()).toBe(false);
	});

	it('recognises an unreadable record published before its update reported failure', async () => {
		const backing = memoryWorkflowJournal();
		let failAfterPublish = true;
		const journal: WorkflowJournal = {
			...backing,
			updateEnrollment: (record, update) => {
				const published = backing.updateEnrollment(record, update);
				if (failAfterPublish && typeof update !== 'string' && update.state === 'unreadable') {
					failAfterPublish = false;
					throw new Error('final directory flush failed');
				}
				return published;
			}
		};
		const app = service(journal, {
			start: () =>
				startEnrollment(
					() =>
						Promise.resolve({
							status: 200,
							text: JSON.stringify({
								response: {
									status: 1,
									shared_secret: STARTED_SHARED,
									revocation_code: 'R-PARTIAL'
								}
							})
						}),
					{ steamId64: STEAM_ID, accessToken: MOBILE, unixSeconds: Math.floor(NOW / 1000) }
				)
		});

		await expect(app.begin('trader', 'password')).rejects.toThrow(/survive a restart/i);
		const published = backing.enrollments()[0]!;
		expect(published.state).toBe('unreadable');
		expect(app.recoveryState(published)).toBe('durable');
		expect(app.enrollmentRecoveryUsable(published)).toBe(false);
		await expect(app.retryEnrollmentPersist(published.attemptId, STEAM_ID)).rejects.toThrow(
			/cannot be saved as a working account/i
		);
		expect(app.recoveryState(published)).toBe('durable');
	});
});
