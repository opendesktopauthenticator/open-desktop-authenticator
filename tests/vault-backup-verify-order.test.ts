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
	state.failRestore = false;
});

afterEach(() => {
	state.corruptStaged = false;
	state.corruptMain = false;
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
