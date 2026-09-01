import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The recovery file is the copy that survives everything else going wrong.**
 *
 * It is written the moment Steam issues the secrets, before the vault, precisely
 * so that a crash between the two does not lose an authenticator. Which makes it
 * the last file in the application that should be written straight to its final
 * name — and it was: one `writeFileSync`, no temp, no rename, no flush.
 *
 * A disk that fills partway through leaves a truncated JSON document at exactly
 * the path the restore reads. That is not a recovery file; it is a file that
 * looks like one until somebody needs it, and the moment somebody needs it is
 * after they have already lost the vault.
 *
 * The vault itself has been written temp-then-rename since it was written. This
 * asserts the recovery file is too: a failed write leaves the destination as it
 * found it, and leaves no staged copy of the secrets lying beside it either.
 */

const state = vi.hoisted(() => ({
	shortWrite: false,
	hideDestination: false,
	silentShortWrite: false,
	noProgress: false,
	noHardLinks: false,
	failRename: false
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		writeSync: (fd: number, data: unknown, ...rest: unknown[]) => {
			if (state.silentShortWrite || state.noProgress) {
				/*
				 * **A short write that does not throw.** `writeSync` may write fewer
				 * bytes than it was given and return the count — a full disk, a pipe,
				 * a network filesystem under pressure. Ignoring the count means the
				 * caller fsyncs and publishes a truncated file, reporting success.
				 *
				 * The offset and length are honoured, so a caller that loops really
				 * does finish; a caller that does not really does truncate.
				 */
				const [offset, length] = rest as [number, number];
				const chunk = state.noProgress ? 0 : Math.min(16, length);
				if (chunk === 0) {
					return 0;
				}
				return (actual.writeSync as (...args: unknown[]) => number)(fd, data, offset, chunk);
			}
			if (state.shortWrite) {
				// What a full disk does: some of it lands, then the write fails.
				(actual.writeSync as (...args: unknown[]) => number)(
					fd,
					typeof data === 'string' ? data.slice(0, 20) : data,
					0,
					'utf8'
				);
				throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
			}
			return (actual.writeSync as (...args: unknown[]) => number)(fd, data, ...rest);
		},
		linkSync: (from: unknown, to: unknown) => {
			/*
			 * A filesystem with no hard links: FAT32, some network shares, some
			 * container mounts. EPERM rather than EEXIST, because EEXIST means the
			 * destination is taken and is rethrown rather than falling back.
			 */
			if (state.noHardLinks) {
				throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
			}
			return (actual.linkSync as (...args: unknown[]) => void)(from, to);
		},
		renameSync: (from: unknown, to: unknown) => {
			if (state.failRename && typeof to === 'string' && to.endsWith('.json')) {
				throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
			}
			return (actual.renameSync as (...args: unknown[]) => void)(from, to);
		},
		existsSync: (path: unknown) => {
			/*
			 * The destination is there and the check does not see it: the shape a
			 * race leaves, where the file appears between the check and the publish.
			 * Only the final path is hidden — the temp still has to be seen.
			 */
			if (
				state.hideDestination &&
				typeof path === 'string' &&
				path.endsWith('76561199000000001.json')
			) {
				return false;
			}
			return (actual.existsSync as (p: unknown) => boolean)(path);
		},
		writeFileSync: (path: unknown, data: unknown, ...rest: unknown[]) => {
			if (state.shortWrite) {
				(actual.writeFileSync as (...args: unknown[]) => void)(
					path,
					typeof data === 'string' ? data.slice(0, 20) : data,
					{ encoding: 'utf8', mode: 0o600 }
				);
				throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
			}
			return (actual.writeFileSync as (...args: unknown[]) => void)(path, data, ...rest);
		}
	};
});

import { writeRecoveryFile } from '../src/main/vault/recovery';

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'oda-recovery-durable-'));
	path = join(dir, 'recovery', '76561199000000001.json');
	state.shortWrite = false;
	state.hideDestination = false;
	state.silentShortWrite = false;
	state.noProgress = false;
	state.noHardLinks = false;
	state.failRename = false;
});

afterEach(() => {
	state.shortWrite = false;
	state.hideDestination = false;
	rmSync(dir, { recursive: true, force: true });
});

const envelope = { v: 1, kdf: { type: 'scrypt' }, ciphertext: 'a'.repeat(400) };

describe('a recovery file whose write runs out of disk', () => {
	it('leaves nothing at the destination', () => {
		state.shortWrite = true;
		expect(() => writeRecoveryFile(path, envelope)).toThrow(/ENOSPC/);
		state.shortWrite = false;

		expect(
			existsSync(path),
			'a truncated recovery file is sitting at the path the restore reads, and it is the only ' +
				'copy of an authenticator that exists at that moment'
		).toBe(false);
	});

	it('leaves no staged copy of the secrets beside it', () => {
		state.shortWrite = true;
		expect(() => writeRecoveryFile(path, envelope)).toThrow(/ENOSPC/);
		state.shortWrite = false;

		expect(
			readdirSync(join(dir, 'recovery')),
			'a partial copy of the encrypted secrets was left behind under a temporary name'
		).toEqual([]);
	});

	/* And the ordinary write still works, and still refuses to overwrite. */
	it('writes the file when the disk is fine', () => {
		expect(writeRecoveryFile(path, envelope)).toBe(path);
		expect(existsSync(path)).toBe(true);
	});

	it('still puts a second enrollment beside the first rather than over it', () => {
		writeRecoveryFile(path, envelope);
		const second = writeRecoveryFile(path, { ...envelope, ciphertext: 'b'.repeat(400) });

		expect(second, 'the second write replaced the first').not.toBe(path);
		expect(existsSync(path)).toBe(true);
		expect(existsSync(second)).toBe(true);
	});
});

/**
 * **Durability must not be bought with the exclusion.**
 *
 * This file used to be written with one `writeFileSync(..., { flag: 'wx' })`:
 * a single syscall that creates the file or fails, and cannot overwrite. Making
 * the write durable replaced it with a temp file and a rename — and a rename
 * *does* overwrite, on every platform this ships to. Measured, not assumed.
 *
 * That traded the guarantee the caller depends on for the one it was asking for.
 * A recovery file is keyed on the SteamID, so enrolling the same account twice
 * aims at the same path, and what would be replaced is the backup of a
 * *previous* authenticator: the single file in this application whose entire
 * purpose is to still be there later.
 *
 * The `existsSync` before the write narrows that window and cannot close it.
 * These assert on the outcome rather than the mechanism, so a future rewrite has
 * to keep the property rather than the implementation.
 */
describe('a recovery file that already exists', () => {
	it('is never replaced', () => {
		writeRecoveryFile(path, envelope);
		const first = readFileSync(path, 'utf8');

		const second = writeRecoveryFile(path, { ...envelope, ciphertext: 'b'.repeat(400) });

		expect(second, 'the second enrollment was written over the first').not.toBe(path);
		expect(
			readFileSync(path, 'utf8'),
			'the backup of a previous authenticator was replaced by one for a new one'
		).toBe(first);
	});

	/**
	 * And the exclusion is atomic rather than a check followed by a write. A
	 * file appearing between the two — another enrolment, another process — must
	 * still not be overwritten.
	 */
	it('is not replaced by a write that started before it appeared', () => {
		writeRecoveryFile(path, envelope);
		const first = readFileSync(path, 'utf8');

		// The existence check does not see it — the shape a race leaves, where the
		// file appears between the check and the publish. The publish itself has to
		// refuse, or the check is the only thing standing between two enrolments
		// and one of them is gone.
		state.hideDestination = true;
		const second = writeRecoveryFile(path, { ...envelope, ciphertext: 'c'.repeat(400) });
		state.hideDestination = false;

		expect(
			readFileSync(path, 'utf8'),
			'the publish overwrote a file that appeared after the existence check, and what it ' +
				'replaced was a previous authenticator backup'
		).toBe(first);
		expect(second, 'the second write went to the destination anyway').not.toBe(path);
	});
});

/**
 * **A write that stops early without saying so.**
 *
 * `writeSync` may write fewer bytes than it was given and return the count.
 * Every call in the vault and recovery writers ignored it, so a short write was
 * followed by an `fsync` and a publish that reported success — and for the
 * recovery file, which nothing reads back afterwards, the result is a truncated
 * document sitting at exactly the path the restore reads.
 */
describe('a write that lands short without throwing', () => {
	/**
	 * `writeSync` may write fewer bytes than it was given and return the count.
	 * Every call in the vault and recovery writers ignored it, so a short write
	 * was followed by an `fsync` and a publish that reported success — and for
	 * the recovery file, which nothing reads back afterwards, the result is a
	 * truncated document at exactly the path the restore reads.
	 */
	it('is carried on until the file is whole', () => {
		state.silentShortWrite = true;
		const written = writeRecoveryFile(path, envelope);
		state.silentShortWrite = false;

		expect(written).toBe(path);
		expect(
			JSON.parse(readFileSync(path, 'utf8')),
			'the file was published after a write that stopped early, so what is on disk is a ' +
				'fragment of the only copy of an authenticator'
		).toEqual(envelope);
	});

	/* And a write that makes no progress at all is a failure, not a loop. */
	it('gives up rather than spinning when nothing can be written', () => {
		state.noProgress = true;
		let threw = false;
		try {
			writeRecoveryFile(path, envelope);
		} catch {
			threw = true;
		}
		state.noProgress = false;

		expect(threw, 'a write that never advances was treated as success').toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(join(dir, 'recovery')), 'a staged fragment was left behind').toEqual([]);
	});
});

/**
 * **The fallback for filesystems with no hard links, which had the race back.**
 *
 * `link` is what makes the exclusion atomic: it creates the name or fails
 * EEXIST, in one syscall. It is not universal, so there is a fallback — and the
 * fallback was `if (existsSync(path)) throw; renameSync(temp, path)`, with a
 * comment saying in as many words that the check narrows the window and cannot
 * close it. Everything above passes on a filesystem that has links, so the
 * property was proved on the path that was never in doubt and left unproved on
 * the one that was.
 *
 * A recovery file is the copy that exists because everything else was lost.
 * "Almost never overwritten" is not what that file is for.
 */
describe('the same file on a filesystem that cannot make hard links', () => {
	it('is still written when nothing is in the way', () => {
		state.noHardLinks = true;
		expect(writeRecoveryFile(path, envelope)).toBe(path);
		expect(readFileSync(path, 'utf8')).toContain(envelope.ciphertext);
	});

	it('is not replaced by a second enrollment', () => {
		state.noHardLinks = true;
		writeRecoveryFile(path, envelope);
		const first = readFileSync(path, 'utf8');

		const second = writeRecoveryFile(path, { ...envelope, ciphertext: 'b'.repeat(400) });

		expect(second, 'the second enrollment was written over the first').not.toBe(path);
		expect(readFileSync(path, 'utf8')).toBe(first);
	});

	/* The one that was open: the file appears after the check and before the
	 * rename, and a rename overwrites. */
	it('is not replaced by a write that started before it appeared', () => {
		state.noHardLinks = true;
		writeRecoveryFile(path, envelope);
		const first = readFileSync(path, 'utf8');

		state.hideDestination = true;
		const second = writeRecoveryFile(path, { ...envelope, ciphertext: 'c'.repeat(400) });
		state.hideDestination = false;

		expect(
			readFileSync(path, 'utf8'),
			'on a filesystem with no hard links, a recovery file that appeared after the existence ' +
				'check was overwritten by the enrollment that had already checked - and what it ' +
				'replaced was a previous authenticator backup'
		).toBe(first);
		expect(second, 'the second write went to the destination anyway').not.toBe(path);
	});

	/**
	 * And the cost of claiming the name first is a placeholder, which must not
	 * outlive a write that failed: leaving it would deny the name to every later
	 * attempt for an enrollment that was never recorded.
	 */
	it('leaves nothing behind when the write cannot be published', () => {
		state.noHardLinks = true;
		state.failRename = true;
		expect(() => writeRecoveryFile(path, envelope)).toThrow(/EIO/);
		state.failRename = false;
		state.noHardLinks = false;

		expect(
			existsSync(path),
			'an empty file was left at the destination by a write that failed, and every later ' +
				'enrollment for this account will now be pushed aside by it'
		).toBe(false);
		expect(readdirSync(join(dir, 'recovery')), 'a staged copy was left beside it').toEqual([]);
	});
});
