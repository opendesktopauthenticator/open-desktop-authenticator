import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * the observable shape of a write that failed after truncation. The fix writes
 * to a temp name and renames, so the destination itself is never opened for
 * writing and the sabotage never fires against it.
 */
let sabotageWriteTo: string | undefined;

/**
 * Fired after a successful `writeFile`, so a test can lock the vault at the one
 * moment the plaintext exists and the destination does not.
 */
let lockDuringWrite: (() => void) | undefined;

/**
 * Fired after a successful `rename`, which is the commit itself.
 *
 * The check before the rename cannot cover the rename, and on the removable and
 * network drives people export to it is not instant.
 */
let lockDuringRename: (() => void) | undefined;

/**
 * When set, `rm` of a path ending `.prev` fails.
 *
 * The set-aside copy holds the *previous* export's plaintext secrets, and its
 * removal is the last step of a successful export. A scanner holding the file,
 * a network share dropping, a removable drive pulled — all ordinary, and all
 * silent until this was reported.
 */
let refuseStaleRemoval = false;

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		writeFile: async (
			path: Parameters<typeof actual.writeFile>[0],
			data: Parameters<typeof actual.writeFile>[1],
			options?: Parameters<typeof actual.writeFile>[2]
		) => {
			if (sabotageWriteTo !== undefined && typeof path === 'string' && path === sabotageWriteTo) {
				const { writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
				writeFileSync(sabotageWriteTo, '');
				throw new Error('ENOSPC: disk full');
			}
			const written = await actual.writeFile(path, data, options);
			lockDuringWrite?.();
			return written;
		},
		rm: async (
			path: Parameters<typeof actual.rm>[0],
			options?: Parameters<typeof actual.rm>[1]
		) => {
			if (refuseStaleRemoval && typeof path === 'string' && path.endsWith('.prev')) {
				throw new Error('EBUSY: resource busy or locked');
			}
			return actual.rm(path, options);
		},
		rename: async (
			from: Parameters<typeof actual.rename>[0],
			to: Parameters<typeof actual.rename>[1]
		) => {
			const renamed = await actual.rename(from, to);
			lockDuringRename?.();
			return renamed;
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
	lockDuringRename = undefined;
	refuseStaleRemoval = false;
	__resetRouterForTests();
	setTrustedSender(() => true);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('accountExport after the dialog', () => {
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
	 * vault during it and the rename still finished, putting a plaintext maFile
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
	 * **The rename is the commit, and the check before it cannot cover it.**
	 *
	 * A lock landing inside the rename still published the plaintext maFile and
	 * answered `saved`. Nothing was there before, so removing it restores the
	 * directory exactly as it was — and the lock says nobody is present to have
	 * wanted it.
	 */
	it('removes a file it created when the vault locks during the rename', async () => {
		const destination = join(dir, 'out.maFile');
		let unlocked = true;
		const vault = {
			isUnlocked: () => unlocked,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		lockDuringRename = () => {
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

	/*
	 * **And does not take a backup the user already had.**
	 *
	 * When something was at that path, the rename has already replaced it, and
	 * deleting now would destroy a file that existed before anything was pressed
	 * — a worse outcome than a plaintext maFile for the same account which was
	 * already sitting there a second ago, and is no new exposure at all.
	 */
	it('puts back the file that was already there, byte for byte', async () => {
		const destination = join(dir, 'out.maFile');
		const original = '{"an":"earlier export"}';
		writeFileSync(destination, original);
		let unlocked = true;
		const vault = {
			isUnlocked: () => unlocked,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		lockDuringRename = () => {
			unlocked = false;
		};

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(/locked/i);

		/*
		 * **Which file survived, not merely that one did.**
		 *
		 * This asserted `existsSync` and nothing more, so it passed while the
		 * destination held the *newly exported secrets* — the old backup destroyed,
		 * fresh plaintext in its place, and the user told the export had failed
		 * because the vault locked. Three wrong things at once, blessed by a test
		 * that only counted files.
		 */
		expect(existsSync(destination), 'an existing backup was deleted').toBe(true);
		expect(
			readFileSync(destination, 'utf8'),
			'the lock left the new export in place and called it a failure'
		).toBe(original);

		// And nothing staged is left lying about, in either direction.
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.prev'))
		).toEqual([]);
	});

	/*
	 * The successful path must not leave the set-aside copy behind either: it
	 * holds the same secrets as the file that replaced it.
	 */
	it('removes the copy it set aside when the export succeeds', async () => {
		const destination = join(dir, 'out.maFile');
		writeFileSync(destination, '{"an":"earlier export"}');
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
		expect(readFileSync(destination, 'utf8')).toContain(account.steamId64);
		expect(
			readdirSync(dir).filter((name) => name.endsWith('.prev')),
			'a second plaintext copy was left beside the export'
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

/*
 * A failed re-export must leave the previous maFile as it was.
 *
 * Writing straight to the destination opens it for truncation before a byte
 * lands, so a write that then failed — disk full, drive unplugged — had
 * already emptied the file it was replacing. Re-exporting over an existing
 * backup is the ordinary case; the export goes to a temp name and is renamed
 * into place, like every other secret-bearing write in the application.
 */
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

		// With the fix, the write goes to `${destination}.tmp` — the sabotage
		// never fires, the rename replaces the file whole, and the export
		// SUCCEEDS. What matters either way: the destination is never an empty
		// husk. (Reverted to a direct write, the sabotage fires: the handler
		// rejects and the previous content is gone.)
		await handler(EVENT, { steamId64: account.steamId64 }).catch(() => undefined);
		const after = readFileSync(destination, 'utf8');
		expect(after).not.toBe('');
	});
});

/*
 * The export's temp file must never be someone else's file.
 *
 * A fixed `${destination}.tmp` name truncated whatever already sat there — a
 * sibling that was never ours — and then renamed it over the destination. The
 * temp name is unique per export now, and opened with `wx`, which cannot empty
 * an existing file.
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

/*
 * **A successful export that leaves a second plaintext file behind.**
 *
 * The rollback design sets the previous export aside so a lock can be undone,
 * and deletes that copy once the new one is in place. The delete's failure was
 * swallowed: the handler answered `saved` while a `.prev` file full of the
 * *previous* authenticator's secrets sat in the user's folder, at a path only
 * the OS dialog knows, with nothing anywhere mentioning it.
 *
 * The export did succeed, so this is not a failure to report — it is a fact the
 * user has to be given.
 */
describe('an export whose set-aside copy cannot be removed', () => {
	it('still reports success, and says the old copy is still there', async () => {
		const destination = join(dir, 'out.maFile');
		writeFileSync(destination, '{"an":"earlier export"}');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		refuseStaleRemoval = true;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		const result = await handler(EVENT, { steamId64: account.steamId64 });

		// The export itself worked, and saying otherwise would be its own lie.
		expect(result).toMatchObject({ state: 'saved' });
		expect(readFileSync(destination, 'utf8')).toContain(account.steamId64);

		// And the thing the user has to know.
		expect(result, 'a second plaintext file was left with nobody told').toMatchObject({
			staleCopy: true
		});
		expect(readdirSync(dir).filter((name) => name.endsWith('.prev'))).toHaveLength(1);
	});

	it('says nothing about it when the removal works', async () => {
		const destination = join(dir, 'out.maFile');
		writeFileSync(destination, '{"an":"earlier export"}');
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

		const result = await handler(EVENT, { steamId64: account.steamId64 });

		expect(result).toMatchObject({ state: 'saved' });
		expect(result).not.toMatchObject({ staleCopy: true });
		expect(readdirSync(dir).filter((name) => name.endsWith('.prev'))).toEqual([]);
	});
});

/**
 * **The lock was re-checked before publishing and the account's identity was
 * not**, so only half the race was closed.
 *
 * The write is a wait — slow on the drives people export to — and an account
 * can be removed, or have its authenticator replaced, while it runs. The rename
 * then published a plaintext maFile holding secrets the vault no longer has,
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
 * **The account can go during the rename, not only during the write.**
 *
 * The fingerprint is taken before the write and checked before the publish, so
 * everything up to the rename is covered. The rename itself is a filesystem
 * round trip — slow on the removable and network drives people export to — and
 * the check after it asked one question: is the vault still open. Removing the
 * account inside that window therefore answered `{ state: 'saved' }` with the
 * plaintext maFile sitting at the destination: secrets published for an
 * authenticator the vault no longer holds.
 *
 * `lockDuringRename` already existed for the vault-lock case; the account case
 * runs through the same door.
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
		lockDuringRename = () => mutate(accounts);

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');
		return { call: () => handler(EVENT, { steamId64: account.steamId64 }), destination };
	}

	it('takes the file back when the account is removed mid-rename', async () => {
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

	it('takes it back when the authenticator is replaced mid-rename', async () => {
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
