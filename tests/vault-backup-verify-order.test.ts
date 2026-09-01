import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seal } from '../src/main/vault/crypto';
import {
	readBackupEnvelope,
	vaultPaths,
	writeBackupEnvelope,
	writeEnvelope,
	VaultStorageError
} from '../src/main/vault/storage';
import { MINIMUM_SCRYPT } from '../src/shared/vault-format';

/**
 * **A backup that could not be replaced must still be the one that was there.**
 *
 * `writeBackupEnvelope` renamed its temp file over the backup and verified
 * afterwards. So a write that landed wrong — a short write, a full disk, a
 * filesystem that reported success and stored something else — was detected only
 * once the working copy had already been destroyed, and the error thrown says
 * "the vault backup could not be rewritten", which reads as "the old one is
 * still there".
 *
 * A vault file is routinely the only copy of an account's revocation code. It is
 * not the thing to leave with no recoverable backup on the strength of a write
 * nobody checked.
 *
 * The staged file is verified first now, so a bad write costs nothing: the
 * temp is thrown away and the previous backup is untouched.
 */

const state = vi.hoisted(() => ({
	corruptStaged: false,
	corruptMain: false,
	corruptDestination: false,
	corruptDestinationOnce: 0,
	failRestore: false
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		copyFileSync: (from: unknown, to: unknown, ...rest: unknown[]) => {
			// The restore half: putting the previous vault back over a failed write.
			if (state.failRestore && typeof from === 'string' && from.endsWith('.bak')) {
				throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
			}
			return (actual.copyFileSync as (...args: unknown[]) => void)(from, to, ...rest);
		},
		readFileSync: (path: unknown, ...rest: unknown[]) => {
			if (state.corruptMain && typeof path === 'string' && path.endsWith('vault.json')) {
				return '{"not":"what was written"}';
			}
			if (state.corruptDestinationOnce > 0 && typeof path === 'string' && path.endsWith('.bak')) {
				/*
				 * Corrupt for the write's own verification and honest afterwards, so
				 * the restore that follows can be checked. The other flag stays wrong
				 * for every read, which is the case where nothing can vouch for the
				 * restore at all.
				 */
				state.corruptDestinationOnce -= 1;
				return '{"not":"what the rename was supposed to publish"}';
			}
			if (state.corruptDestination && typeof path === 'string' && path.endsWith('.bak')) {
				/*
				 * The destination read-back, after the rename: a filesystem that
				 * reported a rename it did not perform, or a device that went away
				 * between the two calls.
				 */
				return '{"not":"what the rename was supposed to publish"}';
			}
			if (state.corruptStaged && typeof path === 'string' && path.endsWith('.bak.tmp')) {
				// What a short write leaves: the file exists and holds less than was
				// handed to it.
				return '{"trunc';
			}
			return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
		}
	};
});

const FAST = { N: MINIMUM_SCRYPT.N, r: MINIMUM_SCRYPT.r, p: MINIMUM_SCRYPT.p };

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'vault-backup-order-'));
	file = join(dir, 'vault.json');
	state.corruptStaged = false;
	state.corruptMain = false;
	state.corruptDestination = false;
	state.corruptDestinationOnce = 0;
	state.failRestore = false;
});

afterEach(() => {
	state.corruptStaged = false;
	state.corruptMain = false;
	state.corruptDestination = false;
	state.corruptDestinationOnce = 0;
	state.failRestore = false;
	rmSync(dir, { recursive: true, force: true });
});

const envelope = (text: string) => seal(text, 'a passphrase long enough', FAST);

describe('replacing the backup when the new one does not verify', () => {
	it('leaves the previous backup readable', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		// An ordinary save, so `.bak` now holds the first vault.
		writeEnvelope(file, await envelope('{"seq":2}'));

		const paths = vaultPaths(file);
		const before = readFileSync(paths.backup, 'utf8');
		const replacement = await envelope('{"seq":3}');

		state.corruptStaged = true;
		expect(() => writeBackupEnvelope(file, replacement)).toThrow(VaultStorageError);
		state.corruptStaged = false;

		expect(existsSync(paths.backup), 'the backup file is gone entirely').toBe(true);
		expect(
			readFileSync(paths.backup, 'utf8'),
			'the working backup was replaced by a write that then failed to verify, and the error ' +
				'says it could not be rewritten'
		).toBe(before);
		expect(readBackupEnvelope(file), 'and it no longer opens').toBeDefined();
	});

	it('leaves no staged file behind', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		writeEnvelope(file, await envelope('{"seq":2}'));
		const paths = vaultPaths(file);
		const replacement = await envelope('{"seq":3}');

		state.corruptStaged = true;
		expect(() => writeBackupEnvelope(file, replacement)).toThrow(VaultStorageError);
		state.corruptStaged = false;

		expect(
			existsSync(`${paths.backup}.tmp`),
			'a staged copy of the vault was left on disk, in plaintext-adjacent form, after a write ' +
				'that failed'
		).toBe(false);
	});
});

/**
 * **And a restore that did not happen must not be announced as one.**
 *
 * `writeEnvelope` puts the previous vault back when its own write fails, and the
 * copy was wrapped in a bare `catch {}` on the reasoning that the backup is
 * still on disk for manual recovery. True, and not what the message says: the
 * caller throws "the vault write failed and the previous file was restored",
 * which is a claim about `vault.json`, and a failed copy leaves whatever the bad
 * write left in that file under exactly those words. Nobody reading them has a
 * reason to go looking at `.bak`.
 */
describe('a failed write whose rollback also fails', () => {
	it('does not claim the previous vault was restored', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		writeEnvelope(file, await envelope('{"seq":2}'));

		state.corruptMain = true;
		state.failRestore = true;

		let message = '';
		try {
			writeEnvelope(file, await envelope('{"seq":3}'));
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		state.corruptMain = false;
		state.failRestore = false;

		expect(message, 'the write did not fail at all').not.toBe('');
		expect(
			message,
			'the rollback could not put the previous vault back, and the user was told it had'
		).not.toMatch(/previous file was restored/);
		expect(message, 'and nothing pointed them at the copy that still opens').toMatch(/\.bak/);
	});

	it('still says it was restored when it was', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		writeEnvelope(file, await envelope('{"seq":2}'));

		state.corruptMain = true;
		let message = '';
		try {
			writeEnvelope(file, await envelope('{"seq":3}'));
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		state.corruptMain = false;

		expect(message).toMatch(/previous file was restored/);
	});
});

/**
 * **The half the staged check could not reach.**
 *
 * Verifying the staged file before the rename moved most of the risk off the old
 * backup and left this: the rename replaces the working backup, and the
 * read-back that follows it can still fail - a filesystem that reported a rename
 * it did not perform, a device that went away between the two. At that point the
 * previous backup is gone, what stands in its place is the thing that just
 * failed verification, and the error says the backup "could not be rewritten",
 * which a reader takes to mean the old one survived.
 *
 * It is a narrow window and the file behind it is a vault holding revocation
 * codes, which is the whole argument for closing it.
 */
describe('replacing the backup when the published file does not verify', () => {
	it('puts the previous backup back', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		writeEnvelope(file, await envelope('{"seq":2}'));

		const paths = vaultPaths(file);
		const before = readFileSync(paths.backup, 'utf8');
		const replacement = await envelope('{"seq":3}');

		state.corruptDestination = true;
		expect(() => writeBackupEnvelope(file, replacement)).toThrow(VaultStorageError);
		state.corruptDestination = false;

		expect(existsSync(paths.backup), 'the backup file is gone entirely').toBe(true);
		expect(
			readFileSync(paths.backup, 'utf8'),
			'the rename had already destroyed the working backup by the time the verification ran, ' +
				'and nothing put it back - so what is on disk is the file that failed the check, under ' +
				'an error saying the backup could not be rewritten'
		).toBe(before);
		expect(readBackupEnvelope(file), 'and it no longer opens').toBeDefined();
	});

	it('drops the set-aside copy once the restore is confirmed', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		writeEnvelope(file, await envelope('{"seq":2}'));
		const paths = vaultPaths(file);
		const before = readFileSync(paths.backup, 'utf8');

		const replacement = await envelope('{"seq":3}');

		// Wrong for the write's own verification and honest afterwards, so the
		// restore that follows can be checked and confirmed.
		state.corruptDestinationOnce = 1;
		expect(() => writeBackupEnvelope(file, replacement)).toThrow(VaultStorageError);
		state.corruptDestinationOnce = 0;

		expect(readFileSync(paths.backup, 'utf8')).toBe(before);
		expect(
			existsSync(`${paths.backup}.previous`),
			'a second copy of the vault was left on disk after a restore that worked'
		).toBe(false);
	});

	/**
	 * **And it is kept when nothing can vouch for the restore.**
	 *
	 * The set-aside copy was restored and then dropped in a `finally`, which runs
	 * whether or not the restore worked - and the restore is a copy that can fail
	 * for every reason the write just failed for. A destination that would not
	 * verify, a restore that could not be confirmed, and then the deletion of the
	 * only remaining good copy: the exact loss the set-aside exists to prevent,
	 * moved one level down.
	 */
	it('keeps the set-aside copy when the restore cannot be confirmed', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		writeEnvelope(file, await envelope('{"seq":2}'));
		const paths = vaultPaths(file);
		const previous = `${paths.backup}.previous`;
		const good = readFileSync(paths.backup, 'utf8');

		const replacement = await envelope('{"seq":3}');

		state.corruptDestination = true;
		let thrown;
		try {
			writeBackupEnvelope(file, replacement);
		} catch (err) {
			thrown = err;
		}
		state.corruptDestination = false;

		expect(
			existsSync(previous),
			'the only remaining good copy of the vault was deleted by the cleanup that runs after a ' +
				'restore nobody checked'
		).toBe(true);
		expect(readFileSync(previous, 'utf8'), 'and what survived is not the good copy').toBe(good);
		expect(
			(thrown as Error | undefined)?.message,
			'the file that has to be kept is not named anywhere the user will see it'
		).toContain(previous);
	});

	/* And the ordinary path leaves nothing behind either. */
	it('leaves no copy behind when the write succeeds', async () => {
		writeEnvelope(file, await envelope('{"seq":1}'));
		writeEnvelope(file, await envelope('{"seq":2}'));
		const paths = vaultPaths(file);

		writeBackupEnvelope(file, await envelope('{"seq":3}'));

		expect(existsSync(`${paths.backup}.previous`)).toBe(false);
		expect(readBackupEnvelope(file)).toBeDefined();
	});
});
