import {
	mkdirSync,
	mkdtempSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toMaFile } from '../src/main/import/export';
import { CHANNELS } from '../src/shared/channels';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

/*
 * Exporting an account that vanished while the save dialog was open.
 *
 * The account was copied out of the vault *before* the dialog, and a save
 * dialog sits open for as long as the user browses. Re-checking only the lock
 * left the stale copy: an account removed during the dialog was still written
 * out — plaintext secrets, for an account the user had just chosen to be rid
 * of. The handler re-reads the vault after the dialog and refuses.
 */

const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();

/**
 * When set, `writeFile` to exactly this path empties the real file and throws —
 * the observable shape of a write that failed after truncation. The fix stages
 * elsewhere and claims an unused destination without truncating it.
 */
let sabotageWriteTo: string | undefined;

/**
 * Fired after a successful `writeFile`, so a test can lock the vault at the one
 * moment the plaintext exists and the destination does not.
 */
let lockDuringWrite: (() => void) | undefined;

/** Fired after a successful no-clobber publication. */
let afterPublish: (() => void) | undefined;

/** A competing writer claims an absent destination at the publication boundary. */
let foreignBeforePublish: (() => void) | undefined;

/**
 * Refuse to delete the staged plaintext, which is the file the *user* ends up
 * holding when an export gives up.
 *
 * This is the temp file the export wrote its secrets into: if it cannot be taken
 * back, the refusal message has to name it.
 */
let refuseStagedRemoval = false;
/**
 * Fail the staged write itself, leaving a part-written plaintext file behind.
 *
 * By suffix rather than by exact path: the staged name carries a random UUID,
 * so a test cannot predict it — which is also why nothing reached this branch
 * before.
 */
let sabotageStagedWrite = false;

let forceLinkUnsupported = false;
let failStageSync = false;
let failDirectorySync = false;
let fallbackWriteFailure: 'partial' | 'foreign' | undefined;

/**
 * When set, `rm` of exactly this path fails.
 *
 * Aimed at the destination, which is what the rollback deletes after the export
 * has already been published there. A scanner holding the file, a network share
 * dropping, a removable drive pulled: the delete fails and the freshly written
 * maFile stays exactly where it is.
 */
let refuseRemovalOf: string | undefined;

/**
 * When set, `rm` of the staged `.tmp` fails. That file holds the same plaintext
 * the destination would, and taking it away is the whole of the cleanup done by
 * every refusal that happens before the publish.
 */
let refuseTempRemoval = false;

/**
 * When set, reading exactly this path fails with something other than ENOENT.
 *
 * The ownership check folded "could not look" in with "nothing is there", so an
 * unreadable destination read as an empty path and the rollback wrote over it.
 */
let refuseReadOf: string | undefined;

/** Paths the rollback actually read, to prove what it does not read. */
let destinationsRead: string[] = [];

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const [path, flags] = args;
			const handle = await actual.open(...args);
			return new Proxy(handle, {
				get(target, property, receiver) {
					if (property === 'sync') {
						return async () => {
							if (
								(failStageSync && typeof path === 'string' && path.endsWith('.tmp')) ||
								(failDirectorySync && path === dir)
							) {
								throw Object.assign(new Error('EIO: injected sync failure'), { code: 'EIO' });
							}
							return target.sync();
						};
					}
					if (
						property === 'writeFile' &&
						flags === 'wx' &&
						typeof path === 'string' &&
						path.endsWith('.maFile') &&
						fallbackWriteFailure !== undefined
					) {
						return async (data: string) => {
							if (fallbackWriteFailure === 'partial') {
								await target.writeFile(data.slice(0, 24), 'utf8');
							} else {
								await target.close();
								rmSync(path, { force: true });
								writeFileSync(path, 'foreign replacement');
							}
							throw Object.assign(new Error('EIO: injected fallback write failure'), {
								code: 'EIO'
							});
						};
					}
					const value: unknown = Reflect.get(target, property, receiver);
					if (typeof value === 'function') {
						return (...callArgs: unknown[]) => Reflect.apply(value, target, callArgs) as unknown;
					}
					return value;
				}
			});
		},
		link: async (
			from: Parameters<typeof actual.link>[0],
			to: Parameters<typeof actual.link>[1]
		) => {
			if (forceLinkUnsupported) {
				throw Object.assign(new Error('ENOTSUP: hard links unavailable'), { code: 'ENOTSUP' });
			}
			foreignBeforePublish?.();
			const linked = await actual.link(from, to);
			afterPublish?.();
			return linked;
		},
		writeFile: async (
			path: Parameters<typeof actual.writeFile>[0],
			data: Parameters<typeof actual.writeFile>[1],
			options?: Parameters<typeof actual.writeFile>[2]
		) => {
			if (sabotageStagedWrite && typeof path === 'string' && path.endsWith('.tmp')) {
				const { writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
				// Part-written, exactly as a full disk leaves it: the file exists and
				// the write failed, which is the case whose cleanup is under test.
				writeFileSync(path, '');
				throw new Error('ENOSPC: disk full');
			}
			if (sabotageWriteTo !== undefined && typeof path === 'string' && path === sabotageWriteTo) {
				const { writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
				writeFileSync(sabotageWriteTo, '');
				throw new Error('ENOSPC: disk full');
			}
			const written = await actual.writeFile(path, data, options);
			lockDuringWrite?.();
			return written;
		},
		readFile: async (
			path: Parameters<typeof actual.readFile>[0],
			options?: Parameters<typeof actual.readFile>[1]
		) => {
			if (typeof path === 'string' && path.endsWith('.maFile')) {
				destinationsRead.push(path);
			}
			if (refuseReadOf !== undefined && typeof path === 'string' && path === refuseReadOf) {
				throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
			}
			return actual.readFile(path, options);
		},
		rm: async (
			path: Parameters<typeof actual.rm>[0],
			options?: Parameters<typeof actual.rm>[1]
		) => {
			if (refuseStagedRemoval && typeof path === 'string' && path.endsWith('.tmp')) {
				throw new Error('EBUSY: resource busy or locked');
			}
			if (refuseRemovalOf !== undefined && typeof path === 'string' && path === refuseRemovalOf) {
				throw new Error('EBUSY: resource busy or locked');
			}
			if (refuseTempRemoval && typeof path === 'string' && path.endsWith('.tmp')) {
				throw new Error('EBUSY: resource busy or locked');
			}
			return actual.rm(path, options);
		}
	};
});

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string) => handlers.delete(channel)
	},
	dialog: {},
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { VaultService } from '../src/main/vault/service';

const EVENT = { senderFrame: { url: 'app://renderer' } };

const account: Account = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	sharedSecret: 'c2hhcmVk',
	identitySecret: 'aWRlbnRpdHk=',
	status: 'active',
	addedAt: '2026-08-08T00:00:00.000Z',
	autoConfirm: newAutoConfirm()
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'export-stale-'));
	handlers.clear();
	sabotageWriteTo = undefined;
	lockDuringWrite = undefined;
	afterPublish = undefined;
	foreignBeforePublish = undefined;
	refuseStagedRemoval = false;
	sabotageStagedWrite = false;
	forceLinkUnsupported = false;
	failStageSync = false;
	failDirectorySync = false;
	fallbackWriteFailure = undefined;
	refuseRemovalOf = undefined;
	refuseTempRemoval = false;
	refuseReadOf = undefined;
	destinationsRead = [];
	__resetRouterForTests();
	setTrustedSender(() => true);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('accountExport after the dialog', () => {
	it('never overwrites a foreign file that claims an initially absent destination at publish', async () => {
		const destination = join(dir, 'out.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		foreignBeforePublish = () => {
			writeFileSync(destination, 'foreign bytes');
			foreignBeforePublish = undefined;
		};

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow();
		expect(readFileSync(destination, 'utf8')).toBe('foreign bytes');
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.tmp')),
			'the refused export left its plaintext stage behind'
		).toEqual([]);
	});

	it('publishes through an exclusive-create fallback when hard links are unavailable', async () => {
		const destination = join(dir, 'out.maFile');
		forceLinkUnsupported = true;
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).resolves.toMatchObject({
			state: 'saved'
		});
		expect(readFileSync(destination, 'utf8')).toBe(toMaFile(account));
		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('does not publish when the durable stage cannot be flushed', async () => {
		const destination = join(dir, 'out.maFile');
		failStageSync = true;
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/could not be written/i
		);
		expect(existsSync(destination)).toBe(false);
		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('takes back its exact file when the directory entry cannot be flushed', async () => {
		const destination = join(dir, 'out.maFile');
		failDirectorySync = true;
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/could not be written/i
		);
		expect(existsSync(destination)).toBe(false);
		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('leaves and names a partial fallback file instead of deleting unverifiable bytes', async () => {
		const destination = join(dir, 'out.maFile');
		forceLinkUnsupported = true;
		fallbackWriteFailure = 'partial';
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const error = await handler(EVENT, { steamId64: account.steamId64 }).then(
			() => undefined,
			(reason: unknown) => reason as Error
		);
		expect(error).toBeDefined();
		expect(readFileSync(destination, 'utf8')).toBe(toMaFile(account).slice(0, 24));
		expect(error?.message).toMatch(/out\.maFile/);
		expect(error?.message).toMatch(/may contain part or all/i);
		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('preserves a foreign replacement during a failed fallback write', async () => {
		const destination = join(dir, 'out.maFile');
		forceLinkUnsupported = true;
		fallbackWriteFailure = 'foreign';
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const error = await handler(EVENT, { steamId64: account.steamId64 }).then(
			() => undefined,
			(reason: unknown) => reason as Error
		);
		expect(error).toBeDefined();
		expect(readFileSync(destination, 'utf8')).toBe('foreign replacement');
		expect(error?.message).toMatch(/out\.maFile/);
		expect(error?.message).toMatch(/another program may have replaced it/i);
		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('refuses an occupied destination without changing its bytes', async () => {
		const destination = join(dir, 'out.maFile');
		const previous = 'the previous export';
		writeFileSync(destination, previous);
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/already in use|unused file name/i
		);
		expect(readFileSync(destination, 'utf8')).toBe(previous);
		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('refuses when the account was removed while the dialog was open', async () => {
		const accounts: Account[] = [account];
		const destination = join(dir, 'out.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			// The removal lands while the dialog is open — modelled by emptying the
			// vault inside the dialog itself.
			show: () => {
				accounts.length = 0;
				return Promise.resolve(destination);
			}
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/no longer in this vault/
		);
		expect(existsSync(destination)).toBe(false);
	});

	/*
	 * **A lock during the write, which is a wait too.**
	 *
	 * The re-check after the dialog covers the long wait — somebody browsing for
	 * a folder. It does not cover the write, and the drives people export to are
	 * exactly the slow ones: a USB stick, a network share, an SD card. Lock the
	 * vault during it and publication still finished, putting a plaintext maFile
	 * on disk — the same secrets as the vault with none of its encryption —
	 * after the application had been told nobody is present.
	 */
	it('writes nothing when the vault locks while the file is being written', async () => {
		const destination = join(dir, 'out.maFile');
		let unlocked = true;
		const vault = {
			// The lock lands during the write, the way an idle timeout does.
			isUnlocked: () => unlocked,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		sabotageWriteTo = undefined;
		lockDuringWrite = () => {
			unlocked = false;
		};

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(/locked/i);

		expect(existsSync(destination), 'a plaintext maFile survived the lock').toBe(false);
		// And the temp it was staged in, which holds the same plaintext.
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.tmp')),
			'the staged plaintext was left behind'
		).toEqual([]);
	});

	/*
	 * **Publication is a commit, and the check before it cannot cover it.**
	 *
	 * A lock landing inside publication still exposed the plaintext maFile and
	 * answered `saved`. Nothing was there before, so removing it restores the
	 * directory exactly as it was — and the lock says nobody is present to have
	 * wanted it.
	 */
	it('removes a file it created when the vault locks during publication', async () => {
		const destination = join(dir, 'out.maFile');
		let unlocked = true;
		const vault = {
			isUnlocked: () => unlocked,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		afterPublish = () => {
			unlocked = false;
		};

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(/locked/i);
		expect(existsSync(destination), 'a plaintext maFile survived the lock').toBe(false);
		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('refuses a selected existing file and leaves it byte for byte', async () => {
		const destination = join(dir, 'out.maFile');
		const original = '{"an":"earlier export"}';
		writeFileSync(destination, original);
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/already in use|unused file name/i
		);
		expect(existsSync(destination), 'an existing backup was deleted').toBe(true);
		expect(
			readFileSync(destination, 'utf8'),
			'the lock left the new export in place and called it a failure'
		).toBe(original);

		expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('never creates a rescue copy for an occupied destination', async () => {
		const destination = join(dir, 'out.maFile');
		const original = '{"an":"earlier export"}';
		writeFileSync(destination, original);
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/already in use|unused file name/i
		);
		expect(readFileSync(destination, 'utf8')).toBe(original);
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.prev')),
			'an obsolete rescue-copy path was created'
		).toEqual([]);
	});

	it('still exports normally when the account is present', async () => {
		const destination = join(dir, 'out.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).resolves.toMatchObject({
			state: 'saved'
		});
		expect(existsSync(destination)).toBe(true);
	});
});

/* An occupied destination is refused without opening or changing it. */
describe('a failing export over an existing file', () => {
	it('leaves the previous export intact', async () => {
		const destination = join(dir, 'out.maFile');
		const previous = '{"the previous, perfectly good backup": true}';
		writeFileSync(destination, previous);
		sabotageWriteTo = destination;

		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		// The occupied-path refusal happens without opening the destination for
		// writing, so the truncation sabotage never fires.
		await handler(EVENT, { steamId64: account.steamId64 }).catch(() => undefined);
		const after = readFileSync(destination, 'utf8');
		expect(after).not.toBe('');
	});
});

/*
 * The export's temp file must never be someone else's file.
 *
 * A fixed `${destination}.tmp` name truncated whatever already sat there. The
 * stage name is unique per export now and opened with `wx`.
 */
describe('a sibling .tmp file at the destination', () => {
	it('is left untouched by an export', async () => {
		const destination = join(dir, 'backup.maFile');
		const sibling = `${destination}.tmp`;
		const theirs = 'somebody else’s file, not ours to empty';
		writeFileSync(sibling, theirs);

		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).resolves.toMatchObject({
			state: 'saved'
		});
		// The export landed, and the stranger's file is exactly as it was.
		expect(readFileSync(sibling, 'utf8')).toBe(theirs);
		expect(readFileSync(destination, 'utf8')).toContain('shared_secret');
	});
});

/*
 * The vault locking during the recovery file's own decrypt.
 *
 * `readRecoveryFile` is a deliberate second of scrypt, and the idle lock does
 * not pause for it. The unlock check before the decrypt passed; nothing
 * rechecked after — so secrets decrypted with nobody present flowed on into a
 * vault read that failed incidentally. The recheck makes the refusal name the
 * real reason and stops anything further happening with the plaintext.
 */
describe('accountRecover after a mid-decrypt lock', () => {
	it('refuses with the lock as the reason', async () => {
		let unlocked = true;
		const vault = {
			isUnlocked: () => unlocked,
			touch: () => undefined,
			read: () => ({ accounts: [] })
		} as unknown as VaultService;

		vi.doMock('../src/main/vault/recovery', async () => {
			const actual = await vi.importActual<typeof import('../src/main/vault/recovery')>(
				'../src/main/vault/recovery'
			);
			return {
				...actual,
				readRecoveryFile: async () => {
					// The lock lands while scrypt is grinding.
					await Promise.resolve();
					unlocked = false;
					return {
						steamId64: account.steamId64,
						accountName: account.accountName,
						account
					};
				}
			};
		});
		vi.resetModules();
		const { registerEnrollmentHandlers: register } =
			await import('../src/main/steam/enrollment-ipc.js');
		const { setTrustedSender: trust, __resetRouterForTests: reset } =
			await import('../src/main/ipc/router.js');
		reset();
		trust(() => true);
		handlers.clear();

		register(
			{} as EnrollmentService,
			vault,
			{ show: () => Promise.resolve(undefined) },
			() => undefined,
			{ pick: () => Promise.resolve('{"some":"recovery file"}') }
		);

		const handler = handlers.get(CHANNELS.accountRecover);
		if (!handler) throw new Error('accountRecover was not registered');

		await expect(handler(EVENT, { passphrase: 'a sufficiently long passphrase' })).rejects.toThrow(
			/locked/i
		);
		vi.doUnmock('../src/main/vault/recovery');
		vi.resetModules();
	});
});

describe('accountRecover beside an authenticator workflow', () => {
	it('does not restore an older account over a newer durable enrollment reply', async () => {
		vi.doMock('../src/main/vault/recovery', async () => {
			const actual = await vi.importActual<typeof import('../src/main/vault/recovery')>(
				'../src/main/vault/recovery'
			);
			return {
				...actual,
				readRecoveryFile: () =>
					Promise.resolve({
						steamId64: account.steamId64,
						accountName: account.accountName,
						account
					})
			};
		});
		vi.resetModules();
		const { registerEnrollmentHandlers: register } =
			await import('../src/main/steam/enrollment-ipc.js');
		const { setTrustedSender: trust, __resetRouterForTests: reset } =
			await import('../src/main/ipc/router.js');
		const { VaultKeyOperationCoordinator } =
			await import('../src/main/vault/key-operation-coordinator.js');
		reset();
		trust(() => true);
		handlers.clear();

		const accounts: Account[] = [];
		let failWrite = false;
		const mutate = vi.fn((change: (draft: { accounts: Account[] }) => void) => {
			if (failWrite) {
				failWrite = false;
				return Promise.reject(new Error('disk write failed'));
			}
			change({ accounts });
			return Promise.resolve();
		});
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts }),
			mutate
		} as unknown as VaultService;
		const coordinator = new VaultKeyOperationCoordinator();
		let journalBlocked = true;
		const blocked = vi.fn((steamId64: string) => journalBlocked && steamId64 === account.steamId64);
		register(
			{} as EnrollmentService,
			vault,
			{ show: () => Promise.resolve(undefined) },
			undefined,
			{ pick: () => Promise.resolve('{"encrypted":"recovery"}') },
			undefined,
			undefined,
			coordinator,
			blocked
		);
		const handler = handlers.get(CHANNELS.accountRecover);
		if (!handler) throw new Error('accountRecover was not registered');

		const releaseLiveSteam = coordinator.beginEnrollmentSubmission('76561198000000001');
		await expect(handler(EVENT, { passphrase: 'a sufficiently long passphrase' })).rejects.toThrow(
			/enrollment submission.*in progress/i
		);
		expect(
			blocked,
			'the durable check ran even though the process-local operation already owned the account'
		).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
		releaseLiveSteam();

		await expect(handler(EVENT, { passphrase: 'a sufficiently long passphrase' })).rejects.toThrow(
			/finish or resolve.*before restoring/i
		);
		expect(blocked).toHaveBeenCalledWith(account.steamId64);
		expect(
			mutate,
			'the older recovery file displaced the recoverable authenticator'
		).not.toHaveBeenCalled();
		expect(accounts).toEqual([]);

		journalBlocked = false;
		failWrite = true;
		await expect(handler(EVENT, { passphrase: 'a sufficiently long passphrase' })).rejects.toThrow(
			/disk write failed/i
		);
		expect(accounts).toEqual([]);

		await expect(handler(EVENT, { passphrase: 'a sufficiently long passphrase' })).resolves.toEqual(
			{
				state: 'restored',
				accountName: account.accountName,
				steamId64: account.steamId64
			}
		);
		expect(mutate).toHaveBeenCalledTimes(2);
		expect(accounts).toEqual([account]);

		vi.doUnmock('../src/main/vault/recovery');
		vi.resetModules();
	});

	it('restores the row that makes an orphan activation note reachable again', async () => {
		vi.doMock('../src/main/vault/recovery', async () => {
			const actual = await vi.importActual<typeof import('../src/main/vault/recovery')>(
				'../src/main/vault/recovery'
			);
			return {
				...actual,
				readRecoveryFile: () =>
					Promise.resolve({
						steamId64: account.steamId64,
						accountName: account.accountName,
						account
					})
			};
		});
		vi.resetModules();
		const { registerEnrollmentHandlers: register } =
			await import('../src/main/steam/enrollment-ipc.js');
		const { setTrustedSender: trust, __resetRouterForTests: reset } =
			await import('../src/main/ipc/router.js');
		const { VaultKeyOperationCoordinator } =
			await import('../src/main/vault/key-operation-coordinator.js');
		const { memoryWorkflowJournal } = await import('../src/main/steam/workflow-journal.js');
		const { memoryOperationJournal } = await import('../src/main/steam/operation-journal.js');
		const { accountMutationBlockedByDurableState } =
			await import('../src/main/steam/account-mutation-guard.js');
		const { authenticatorFingerprint } = await import('../src/main/steam/authenticator-secrets.js');
		reset();
		trust(() => true);
		handlers.clear();

		const accounts: Account[] = [];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts }),
			mutate: (change: (draft: { accounts: Account[] }) => void) => {
				change({ accounts });
				return Promise.resolve();
			}
		} as unknown as VaultService;
		const workflows = memoryWorkflowJournal();
		const operations = memoryOperationJournal();
		operations.record({
			steamId64: account.steamId64,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(account),
			at: '2026-09-03T00:00:00.000Z'
		});
		register(
			{} as EnrollmentService,
			vault,
			{ show: () => Promise.resolve(undefined) },
			undefined,
			{ pick: () => Promise.resolve('{"encrypted":"recovery"}') },
			undefined,
			operations,
			new VaultKeyOperationCoordinator(),
			(id) => accountMutationBlockedByDurableState(vault, workflows, operations, id)
		);
		const handler = handlers.get(CHANNELS.accountRecover);
		if (!handler) throw new Error('accountRecover was not registered');

		await expect(handler(EVENT, { passphrase: 'a sufficiently long passphrase' })).resolves.toEqual(
			{
				state: 'restored',
				accountName: account.accountName,
				steamId64: account.steamId64
			}
		);
		expect(accounts).toEqual([account]);
		expect(operations.readKind(account.steamId64, 'activate')).toBeDefined();
		expect(
			accountMutationBlockedByDurableState(vault, workflows, operations, account.steamId64)
		).toBe(true);

		vi.doUnmock('../src/main/vault/recovery');
		vi.resetModules();
	});
});

/**
 * **The lock was re-checked before publishing and the account's identity was
 * not**, so only half the race was closed.
 *
 * The write is a wait — slow on the drives people export to — and an account
 * can be removed, or have its authenticator replaced, while it runs. Publication
 * can otherwise expose a plaintext maFile holding secrets the vault no longer has,
 * and reported it as saved.
 *
 * Removed is the worse half: it puts the secrets somebody just chose to be rid
 * of into a fresh unencrypted file. Replaced is quieter and lasts longer — a
 * backup silently holding the previous authenticator, which Steam has already
 * stopped accepting, discovered at the one moment it is ever used.
 */
describe('accountExport while the write is in flight', () => {
	function run(mutate: (accounts: Account[]) => void): {
		call: () => Promise<unknown>;
		destination: string;
	} {
		const accounts: Account[] = [{ ...account }];
		const destination = join(dir, 'out.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		// The change lands after the plaintext exists and before it is published.
		lockDuringWrite = () => mutate(accounts);

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');
		return { call: () => handler(EVENT, { steamId64: account.steamId64 }), destination };
	}

	it('publishes nothing when the account is removed mid-write', async () => {
		const { call, destination } = run((accounts) => {
			accounts.length = 0;
		});

		await expect(call()).rejects.toThrow(/removed while it was being exported/);
		expect(
			existsSync(destination),
			'secrets the user had just deleted were written to a plaintext file'
		).toBe(false);
	});

	it('publishes nothing when the authenticator is replaced mid-write', async () => {
		const { call, destination } = run((accounts) => {
			const entry = accounts[0];
			if (entry) {
				entry.sharedSecret = 'ICEiIyQlJicoKSorLC0uLzAxMjM=';
				entry.identitySecret = 'c2Vjb25kLWlkZW50aXR5LXNlY3I=';
				entry.revocationCode = 'R54321';
			}
		});

		await expect(call()).rejects.toThrow(/replaced while it was being exported/);
		expect(
			existsSync(destination),
			'the backup would have held an authenticator Steam no longer accepts'
		).toBe(false);
	});

	/*
	 * Changing the revocation code alone still invalidates the copy: it is the
	 * one secret whose loss cannot be undone, and a backup holding the previous
	 * one is worse than no backup, because somebody will believe it.
	 */
	it('publishes nothing when only the revocation code changed', async () => {
		const { call, destination } = run((accounts) => {
			const entry = accounts[0];
			if (entry) {
				entry.revocationCode = 'R00000';
			}
		});

		await expect(call()).rejects.toThrow(/replaced while it was being exported/);
		expect(existsSync(destination)).toBe(false);
	});

	it('publishes normally when nothing changed', async () => {
		const { call, destination } = run(() => undefined);
		await expect(call()).resolves.toBeDefined();
		expect(existsSync(destination)).toBe(true);
	});
});

/**
 * **A maFile carries no routing, and the export button says so.**
 *
 * Our own importer reads `Session.proxy`, so writing it would round-trip — and
 * round-trip the credentials with it, since a routed URL is routinely
 * `user:pass@host` and this file is plaintext by construction. The same
 * reasoning that keeps the refresh token out applies verbatim.
 *
 * The defect was the silence, not the omission: an account exported and
 * re-imported came back unrouted with nothing said, so a vault without
 * `Require proxies` would poll it over the machine's own address.
 */
describe('what a maFile does not carry', () => {
	it('omits the proxy, credentials and all', () => {
		const routed = { ...account, proxyUrl: 'socks5://user:secret@10.0.0.1:1080' };
		const written = toMaFile(routed);

		expect(written).not.toContain('secret@');
		expect(written).not.toContain('10.0.0.1');
		expect(JSON.parse(written).Session.proxy).toBeUndefined();
	});

	it('omits the refresh token', () => {
		const withToken = { ...account, refreshToken: 'a-live-credential' };
		expect(toMaFile(withToken)).not.toContain('a-live-credential');
	});
});

/**
 * **The account can go during publication, not only during the write.**
 *
 * The fingerprint is taken before the write and checked before the publish, so
 * everything up to publication is covered. Publication itself is a filesystem
 * round trip — slow on the removable and network drives people export to — and
 * the check after it asked one question: is the vault still open. Removing the
 * account inside that window therefore answered `{ state: 'saved' }` with the
 * plaintext maFile sitting at the destination: secrets published for an
 * authenticator the vault no longer holds.
 *
 * The account and vault-lock cases run through the same publication hook.
 */
describe('accountExport while the publish is in flight', () => {
	function run(mutate: (accounts: Account[]) => void): {
		call: () => Promise<unknown>;
		destination: string;
	} {
		const accounts: Account[] = [{ ...account }];
		const destination = join(dir, 'out.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		// After the plaintext has been published, before the answer is given.
		afterPublish = () => mutate(accounts);

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');
		return { call: () => handler(EVENT, { steamId64: account.steamId64 }), destination };
	}

	it('takes the file back when the account is removed during publication', async () => {
		const { call, destination } = run((accounts) => {
			accounts.length = 0;
		});

		await expect(call()).rejects.toThrow(/removed while it was being exported/);
		expect(
			existsSync(destination),
			'a plaintext maFile was published for an account the vault no longer holds, and the ' +
				'export reported success'
		).toBe(false);
	});

	it('takes it back when the authenticator is replaced during publication', async () => {
		const { call, destination } = run((accounts) => {
			const current = accounts[0];
			if (current) {
				accounts[0] = { ...current, sharedSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
			}
		});

		await expect(call()).rejects.toThrow(/replaced while it was being exported/);
		expect(existsSync(destination), 'a maFile holding superseded secrets was left published').toBe(
			false
		);
	});
});

/*
 * **A rollback that could not take back what it had already written.**
 *
 * Every post-publication refusal ends with the new maFile removed. That removal
 * used to be fired and forgotten, so the refusal said "nothing was written"
 * regardless of whether it worked. Hold the destination open
 * the way a scanner or a dropped network share does, and the user was told
 * nothing had happened while `shared_secret` and `identity_secret` sat
 * unencrypted in the folder they had just chosen. The message is what stops
 * them looking, which makes the silence worse than the file.
 *
 * These assert the property rather than the sentence: whatever the rollback
 * left in the folder must be named in what the user is told. It is read off the
 * directory, so a reworded message still passes and a file nobody thought to
 * name still fails.
 */
describe('an export rollback that cannot finish', () => {
	/** The message of a call that had to refuse, or a failure if it did not. */
	async function refusal(call: Promise<unknown>): Promise<string> {
		return call.then(
			() => {
				throw new Error('the export resolved when it had to refuse');
			},
			(err: unknown) => (err instanceof Error ? err.message : String(err))
		);
	}

	/**
	 * The property itself, returned so a test can say more about what survived.
	 *
	 * Emptiness is the caller's problem: a rollback that quietly succeeded leaves
	 * nothing to name and would satisfy every `toContain` here by default, which
	 * is exactly the vacuous pass these cases exist to avoid.
	 */
	function namesWhatItLeft(message: string, folder: string): string[] {
		const leftBehind = readdirSync(folder);
		for (const name of leftBehind) {
			// A name that appears only inside a longer staged name has not itself
			// been named. Mask longer siblings before checking the message.
			const masked = leftBehind
				.filter((other) => other !== name && other.includes(name))
				.reduce((text, other) => text.split(other).join(''), message);
			expect(
				masked,
				`"${name}" is still in the folder and the refusal never mentions it`
			).toContain(name);
		}
		return leftBehind;
	}

	/*
	 * The case the audit reproduced: the account goes during the publish, and the
	 * destination will not be deleted afterwards.
	 */
	it('names the published maFile it could not delete', async () => {
		const destination = join(dir, 'out.maFile');
		const accounts: Account[] = [{ ...account }];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		afterPublish = () => {
			accounts.length = 0;
		};
		refuseRemovalOf = destination;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const message = await refusal(handler(EVENT, { steamId64: account.steamId64 }));

		// The exposure is real: this is a maFile for the account, in the clear.
		expect(existsSync(destination), 'the rollback worked, so this case proves nothing').toBe(true);
		expect(readFileSync(destination, 'utf8')).toContain('shared_secret');

		expect(namesWhatItLeft(message, dir)).toEqual(['out.maFile']);
		expect(message, 'the reason for the refusal was lost').toMatch(
			/removed while it was being exported/
		);
		expect(
			message,
			'told the user nothing was written while their secrets sat in that folder in the clear'
		).not.toMatch(/nothing was written/i);
	});

	it('keeps the selected old export in place instead of entering the publish path', async () => {
		const destination = join(dir, 'out.maFile');
		const original = '{"an":"earlier export"}';
		writeFileSync(destination, original);
		const accounts: Account[] = [{ ...account }];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const message = await refusal(handler(EVENT, { steamId64: account.steamId64 }));

		expect(readFileSync(destination, 'utf8')).toBe(original);
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.prev'))
		).toEqual([]);
		expect(message).toMatch(/already in use|unused file name/i);
	});

	/*
	 * A lock is the other way into the same rollback, and it throws its own error
	 * type - so the sentence has to be carried there too, not only on the
	 * account-changed path.
	 */
	it('names it when the vault locked rather than the account changing', async () => {
		const destination = join(dir, 'out.maFile');
		let unlocked = true;
		const vault = {
			isUnlocked: () => unlocked,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		afterPublish = () => {
			unlocked = false;
		};
		refuseRemovalOf = destination;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const message = await refusal(handler(EVENT, { steamId64: account.steamId64 }));

		expect(message, 'the lock is still the reason, and must still be said').toMatch(/locked/i);
		expect(namesWhatItLeft(message, dir)).toEqual(['out.maFile']);
	});

	/*
	 * The same defect one step earlier. Nothing is published here - the refusal
	 * lands between the write and publication - but the staged file holds the same
	 * plaintext, and "nothing was written" was just as untrue of it.
	 */
	it('names the staged copy it could not remove before publishing', async () => {
		const destination = join(dir, 'out.maFile');
		const accounts: Account[] = [{ ...account }];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		lockDuringWrite = () => {
			accounts.length = 0;
		};
		refuseTempRemoval = true;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const message = await refusal(handler(EVENT, { steamId64: account.steamId64 }));

		// Nothing reached the destination, and that part of the story still holds.
		expect(existsSync(destination)).toBe(false);

		const [staged, ...rest] = namesWhatItLeft(message, dir);
		if (staged === undefined) {
			throw new Error('the staged copy was removed, so this case proves nothing');
		}
		expect(rest).toEqual([]);
		expect(staged).toMatch(/\.tmp$/);
		expect(readFileSync(join(dir, staged), 'utf8')).toContain('shared_secret');
		expect(message, 'the staged plaintext was left behind in silence').not.toMatch(
			/nothing was written/i
		);
	});

	it('does not touch an occupied destination before publication', async () => {
		const destination = join(dir, 'out.maFile');
		const original = '{"an":"earlier export"}';
		writeFileSync(destination, original);
		const accounts: Account[] = [{ ...account }];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const message = await refusal(handler(EVENT, { steamId64: account.steamId64 }));

		expect(readFileSync(destination, 'utf8')).toBe(original);
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.prev'))
		).toEqual([]);
		expect(message).toMatch(/already in use|unused file name/i);
	});

	it('leaves the selected old export in place without attempting publication', async () => {
		const destination = join(dir, 'out.maFile');
		const original = '{"an":"earlier export"}';
		writeFileSync(destination, original);
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const message = await refusal(handler(EVENT, { steamId64: account.steamId64 }));

		expect(readFileSync(destination, 'utf8')).toBe(original);
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.prev'))
		).toEqual([]);
		expect(message).toMatch(/already in use|unused file name/i);
	});
});

/**
 * **The staged plaintext, when it cannot be taken back.**
 *
 * An export writes its secrets to a temp file beside the destination before
 * no-clobber publication. Every path that gives up removes that file — and each
 * of those removals used to be attempted rather than verified, so a scanner
 * holding it, a network share dropping, or a removable drive pulled left a
 * maFile in the user's folder under a message saying nothing had been written.
 * That is the worst pair available: a real exposure and a sentence that stops
 * them looking for it.
 *
 * Two branches, and a verifier showed both were unguarded — deleting the
 * leftover-naming from either left the whole suite green.
 */
describe('an export that gives up but cannot delete what it staged', () => {
	function run(options: { lock?: boolean } = {}): {
		call: () => Promise<unknown>;
		destination: string;
	} {
		const accounts: Account[] = [{ ...account }];
		const destination = join(dir, 'out.maFile');
		let unlocked = true;
		const vault = {
			isUnlocked: () => unlocked,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		refuseStagedRemoval = true;
		if (options.lock === true) {
			// The vault closes after the plaintext exists and before it is published.
			lockDuringWrite = () => {
				unlocked = false;
			};
		} else {
			// The staged write fails, so `giveUp` runs with a part-written plaintext
			// file it then cannot delete.
			sabotageStagedWrite = true;
		}

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');
		return { call: () => handler(EVENT, { steamId64: account.steamId64 }), destination };
	}

	it('names the file it could not take back when the write fails', async () => {
		const { call } = run();
		await expect(
			call(),
			'the user is told nothing was written while a plaintext maFile sits in their folder'
		).rejects.toThrow(/\.tmp/);
	});

	it('names it when the vault locks before publication', async () => {
		const { call } = run({ lock: true });
		const error = await call().then(
			() => undefined,
			(err: unknown) => err
		);
		expect(error, 'the export resolved instead of refusing').toBeDefined();
		expect(
			String((error as Error).message),
			'the lock is reported and the plaintext it left behind is not, so the user fixes the ' +
				'wrong thing and never learns a maFile is on disk'
		).toMatch(/\.tmp/);
	});
});

/**
 * **Two accounts exported to the same file.**
 *
 * Every step of a publish is a read-modify-write on one path — set the old file
 * aside, rename the new one in, re-check the account, undo if it went — spread
 * across four awaits, and nothing serialised them. Two exports aimed at the same
 * destination interleaved freely, and what came out was not a lost update but a
 * deleted one: B renamed its file in and answered `saved`, then A found its own
 * account gone, ran its rollback, and removed the destination. B's file was the
 * one that went. A reported a refusal it had earned; B reported a success it no
 * longer had; the user had neither file.
 *
 * The exports are now serialised per destination, so A finishes — and fails —
 * before B is allowed to touch the path at all.
 */
describe('two exports aimed at the same file', () => {
	const other: Account = {
		...account,
		steamId64: '76561198000000002',
		accountName: 'second'
	};

	it('does not let the first one delete the second one on its way out', async () => {
		const destination = join(dir, 'shared.maFile');
		const accounts: Account[] = [account, other];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		/*
		 * The first export loses its account the moment its rename commits, which
		 * is what sends it into the rollback. Only the first: the mock fires this
		 * on every successful rename, and the restore is one too.
		 */
		let renames = 0;
		afterPublish = () => {
			renames += 1;
			if (renames === 1) {
				const index = accounts.findIndex((entry) => entry.steamId64 === account.steamId64);
				if (index !== -1) {
					accounts.splice(index, 1);
				}
			}
		};

		/*
		 * Both started before either is awaited, which is the whole point — they
		 * run the same sequence of awaits one step apart. Starting the second one
		 * from inside the first one's rename hook, as this test first did, made the
		 * runtime serialise them by accident and the test passed with the mutex
		 * deleted.
		 */
		const first = handler(EVENT, { steamId64: account.steamId64 });
		const second = handler(EVENT, { steamId64: other.steamId64 });

		await expect(first).rejects.toThrow();
		const result = (await second) as { state: string };

		expect(result.state, 'the second export did not finish').toBe('saved');
		expect(
			existsSync(destination),
			'the second export reported success and its file is not there — the first export deleted ' +
				'it while rolling back its own'
		).toBe(true);
		expect(
			JSON.parse(readFileSync(destination, 'utf8')).account_name,
			'the file at the destination is not the one the successful export wrote'
		).toBe(other.accountName);
	});

	it('does not enter rollback machinery for an occupied destination', async () => {
		const destination = join(dir, 'out.maFile');
		const original = 'the export this one is replacing';
		writeFileSync(destination, original);
		const accounts: Account[] = [account];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/already in use|unused file name/i
		);

		expect(
			readFileSync(destination, 'utf8'),
			'an occupied destination changed despite the no-overwrite contract'
		).toBe(original);
	});

	/**
	 * And the half the mutex cannot reach: something that is not an export
	 * replacing the file. The rollback deletes the destination outright, so
	 * without an ownership check it removes a file this export never created,
	 * under a message saying nothing was written.
	 */
	it('leaves a file it did not write alone when it rolls back', async () => {
		const destination = join(dir, 'out.maFile');
		const accounts: Account[] = [account];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		afterPublish = () => {
			// Somebody else's file lands on the path, and the account goes, so the
			// export rolls back onto something that is no longer its own.
			accounts.length = 0;
			writeFileSync(destination, 'a file this export did not write');
		};

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow();

		expect(
			existsSync(destination) && readFileSync(destination, 'utf8'),
			'the rollback deleted a file the export had not written'
		).toBe('a file this export did not write');
	});
});

/**
 * **What makes a file at the destination this export's own.**
 *
 * It was size plus modification time, and neither carries any identity worth the
 * name: every maFile this application writes is within a few bytes of every
 * other, and two files created in the same millisecond share an mtime. And a
 * read that failed for any reason was folded in with "nothing is there", so an
 * unreadable destination looked empty and the rollback wrote straight over it.
 */
describe('deciding whether the destination is still ours', () => {
	function vaultThatLoses(accounts: Account[]) {
		return {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;
	}

	it('does not delete a foreign file that happens to be the same size', async () => {
		const destination = join(dir, 'out.maFile');
		const accounts: Account[] = [account];
		registerEnrollmentHandlers({} as EnrollmentService, vaultThatLoses(accounts), {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		let decoy = '';
		afterPublish = () => {
			accounts.length = 0;
			// Exactly as many bytes as the maFile that was just published, written
			// in the same tick — which is what the old check called "ours".
			decoy = 'x'.repeat(readFileSync(destination, 'utf8').length);
			writeFileSync(destination, decoy);
		};

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow();

		expect(
			existsSync(destination) && readFileSync(destination, 'utf8'),
			'a file of the same size, written in the same millisecond, was taken for this export and ' +
				'deleted'
		).toBe(decoy);
	});

	it('does not read or overwrite an occupied destination', async () => {
		const destination = join(dir, 'out.maFile');
		const original = 'an earlier export';
		writeFileSync(destination, original);
		const accounts: Account[] = [account];
		refuseReadOf = destination;
		registerEnrollmentHandlers({} as EnrollmentService, vaultThatLoses(accounts), {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/already in use|unused file name/i
		);

		expect(
			readFileSync(destination, 'utf8'),
			'an occupied destination was read or overwritten'
		).toBe(original);
		expect(destinationsRead).not.toContain(destination);
	});
});

/**
 * **Two spellings of one path took two different locks.**
 *
 * On Windows `out.maFile` and `OUT.MAFILE` are one NTFS entry, as are a trailing
 * separator and a `.` segment. Keying the mutex on the raw dialog string let two
 * exports of one file run concurrently, both answer `saved`, and one silently
 * replace the other — which is the whole of what the lock exists to prevent.
 */
describe('two exports whose destinations are spelled differently', () => {
	const other: Account = { ...account, steamId64: '76561198000000002', accountName: 'second' };

	it('serialises them anyway', async () => {
		const accounts: Account[] = [account, other];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		/*
		 * The same file, written two ways. `join` normalises a bare `.` segment away
		 * before the handler ever sees it, so the first version of this test handed
		 * over one identical string twice and passed with the lock key mutated back
		 * to the raw value. Built by concatenation instead, so what the dialog
		 * returns really is two different strings that `resolve` collapses to one.
		 */
		const spellings = [
			join(dir, 'shared.maFile'),
			`${join(dir, 'elsewhere')}${sep}..${sep}shared.maFile`
		];
		let next = 0;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(spellings[next++] ?? spellings[0] ?? '')
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		let renames = 0;
		afterPublish = () => {
			renames += 1;
			if (renames === 1) {
				const index = accounts.findIndex((entry) => entry.steamId64 === account.steamId64);
				if (index !== -1) accounts.splice(index, 1);
			}
		};

		const first = handler(EVENT, { steamId64: account.steamId64 });
		const second = handler(EVENT, { steamId64: other.steamId64 });

		await expect(first).rejects.toThrow();
		expect(((await second) as { state: string }).state).toBe('saved');

		expect(
			existsSync(join(dir, 'shared.maFile')),
			'the two spellings took two locks, ran together, and the failing export deleted the ' +
				'successful one on its way out'
		).toBe(true);
	});

	/**
	 * **And the spellings `resolve` cannot settle.**
	 *
	 * `resolve` is textual: it collapses `.`, `..` and separators and knows
	 * nothing about the filesystem underneath. A junction - or a symlink, which
	 * is the same idea everywhere else - is a second name for a directory, so a
	 * destination reached through one and the same file reached directly were two
	 * keys for one file. The lock does not exist for the spellings that are easy
	 * to normalise.
	 *
	 * The file itself does not exist yet, which is why `realpath` cannot simply be
	 * applied to the destination. The directory does.
	 *
	 * **What is asserted is the serialisation itself**, not a file that survived.
	 * The first version of this watched for the destructive outcome the test above
	 * uses, and it passed with the canonicalisation removed: whether an unlocked
	 * pair actually destroys anything depends on which await each lands on, and
	 * the run happened to order them harmlessly. An interleaved write is the
	 * property; the deletion is one thing it sometimes causes.
	 */
	it('serialises two exports through a directory link', async (context) => {
		const real = join(dir, 'real');
		const link = join(dir, 'link');
		mkdirSync(real);
		try {
			if (process.platform === 'win32') {
				execFileSync('cmd', ['/c', 'mklink', '/J', link, real], { stdio: 'pipe' });
			} else {
				symlinkSync(real, link, 'dir');
			}
		} catch {
			// Some machines refuse to make one. Saying so is the honest outcome; the
			// alternative is a green result that measured nothing at all.
			context.skip();
			return;
		}

		const accounts: Account[] = [account, other];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		const spellings = [join(real, 'shared.maFile'), join(link, 'shared.maFile')];
		let next = 0;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(spellings[next++] ?? spellings[0] ?? '')
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		// The first stages and publishes. Only after that may the second stage and
		// refuse the now-occupied name. Interleaving would begin `write write`.
		const trace: string[] = [];
		lockDuringWrite = () => trace.push('write');
		afterPublish = () => trace.push('publish');

		await Promise.allSettled([
			handler(EVENT, { steamId64: account.steamId64 }),
			handler(EVENT, { steamId64: other.steamId64 })
		]);

		expect(
			trace.join(' '),
			'a junction and its target took two locks for one file, so both exports were inside the ' +
				'critical section at once'
		).toBe('write publish write');
	});
});

/**
 * The name reported back is the one on disk, not the one this application
 * proposed: the dialog lets somebody type whatever they like, and reporting the
 * suggestion sent a user who had renamed it to look for a file that is not there.
 */
describe('the name an export reports', () => {
	it('is the one the user chose', async () => {
		const destination = join(dir, 'my own name.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const result = (await handler(EVENT, { steamId64: account.steamId64 })) as {
			fileName: string;
		};
		expect(result.fileName).toBe('my own name.maFile');
	});
});

/**
 * **The ownership check reads the destination, and the destination is whatever
 * path a save dialog returned.**
 *
 * The comparison is against a maFile a few hundred bytes long. Reading the
 * destination whole to find out it is not ours meant an arbitrarily large file —
 * or a device that never ends — loaded into the Electron main process, which is
 * the one that must not stop.
 *
 * A file of a different length cannot be this export's own, so the size answers
 * it for nothing.
 */
describe('what the rollback reads before deleting', () => {
	it('does not read a destination whose size already rules it out', async () => {
		const destination = join(dir, 'out.maFile');
		const accounts: Account[] = [account];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		let renames = 0;
		afterPublish = () => {
			renames += 1;
			if (renames !== 1) {
				return;
			}
			accounts.length = 0;
			// Far larger than any maFile: the shape a mistyped path into a video or
			// a disk image produces.
			writeFileSync(destination, 'x'.repeat(2_000_000));
		};

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow();

		expect(
			destinationsRead,
			'the rollback read a two-megabyte file into the main process to discover it was not the ' +
				'few hundred bytes it had just written'
		).toEqual([]);
	});

	/* And it still reads one whose size makes it a candidate. */
	it('does read a destination of exactly the right size', async () => {
		const destination = join(dir, 'out.maFile');
		const accounts: Account[] = [account];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		let renames = 0;
		afterPublish = () => {
			renames += 1;
			if (renames !== 1) {
				return;
			}
			accounts.length = 0;
		};

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow();

		expect(
			destinationsRead.length,
			'the file this export had just written was never compared, so ownership was decided on ' +
				'the size alone'
		).toBeGreaterThan(0);
	});
});
