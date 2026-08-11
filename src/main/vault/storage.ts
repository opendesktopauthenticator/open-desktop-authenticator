import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { dirname } from 'node:path';
import { envelopeSchema, type Envelope } from '../../shared/vault-format';

/**
 * Reading and writing the vault file (§10.3).
 *
 * The file being written is routinely the only copy of an account's revocation
 * code. A failed write is therefore not "lost a setting", it is "lost the
 * ability to recover the account", and the care here is proportionate to that
 * rather than to the size of the file.
 *
 * Three guarantees:
 *
 * 1. **Atomic.** Write a temp file, fsync it, rename over the target. A crash
 *    mid-write leaves the previous file intact — never a truncated one. The
 *    directory is fsynced too, or the rename itself can be lost on power failure
 *    even though the data was durable.
 * 2. **Backed up.** The previous good version is kept as `vault.json.bak`.
 * 3. **Verified.** The bytes are read back and re-parsed before the write is
 *    reported successful.
 */

export class VaultStorageError extends Error {
	constructor(
		message: string,
		override readonly cause?: unknown
	) {
		super(message);
		this.name = 'VaultStorageError';
	}
}

export interface VaultPaths {
	file: string;
	backup: string;
	temp: string;
}

export function vaultPaths(file: string): VaultPaths {
	return { file, backup: `${file}.bak`, temp: `${file}.tmp` };
}

export function vaultExists(file: string): boolean {
	return existsSync(file);
}

/** Read and validate an envelope. Does not decrypt. */
export function readEnvelope(file: string): Envelope {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (err) {
		throw new VaultStorageError(`could not read the vault file at ${file}`, err);
	}

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		throw new VaultStorageError('the vault file is not valid JSON', err);
	}

	const parsed = envelopeSchema.safeParse(json);
	if (!parsed.success) {
		throw new VaultStorageError('the vault file is not a valid vault envelope');
	}
	return parsed.data;
}

/**
 * Write an envelope atomically, keeping the previous version as a backup.
 *
 * On any failure the previous file is left in place and the temp file is removed.
 */
export function writeEnvelope(file: string, envelope: Envelope): void {
	const paths = vaultPaths(file);
	const serialised = `${JSON.stringify(envelope, null, 2)}\n`;

	try {
		mkdirSync(dirname(file), { recursive: true });
	} catch (err) {
		throw new VaultStorageError('could not create the vault directory', err);
	}

	// Back up the current good version first. If this throws we have not touched
	// anything yet.
	const hadExisting = existsSync(file);
	if (hadExisting) {
		try {
			copyFileSync(file, paths.backup);
		} catch (err) {
			throw new VaultStorageError('could not back up the existing vault before writing', err);
		}
	}

	try {
		const fd = openSync(paths.temp, 'w');
		try {
			writeSync(fd, serialised, 0, 'utf8');
			// Durable before the rename, or "atomic" is a claim rather than a fact.
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}

		renameSync(paths.temp, file);
		syncDirectory(dirname(file));

		// Verify what actually landed rather than trusting the write.
		const readBack = readFileSync(file, 'utf8');
		if (readBack !== serialised) {
			throw new Error('the file on disk does not match what was written');
		}
		envelopeSchema.parse(JSON.parse(readBack));
	} catch (err) {
		restore(paths, hadExisting);
		throw new VaultStorageError('the vault write failed and the previous file was restored', err);
	}
}

/**
 * fsync the directory so the rename itself is durable.
 *
 * Without it, a power failure can lose the directory entry even though the file
 * contents were flushed — the classic "the data is there but the rename is not"
 * failure. Best effort: some platforms refuse to open a directory, and failing
 * the whole write over that would be worse than the risk.
 */
function syncDirectory(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, 'r');
		fsyncSync(fd);
	} catch {
		// Not supported here; the file write itself was already fsynced.
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* nothing useful to do */
			}
		}
	}
}

function restore(paths: VaultPaths, hadExisting: boolean): void {
	try {
		if (existsSync(paths.temp)) {
			unlinkSync(paths.temp);
		}
	} catch {
		/* best effort */
	}
	try {
		if (hadExisting && existsSync(paths.backup)) {
			copyFileSync(paths.backup, paths.file);
		}
	} catch {
		/* best effort — the backup is still on disk for manual recovery */
	}
}

/**
 * Move the current vault out of the way, keeping it.
 *
 * Used before restoring a backup over it. Deliberately a rename rather than a
 * delete: the file being displaced may be corrupt, or it may be a perfectly good
 * vault that the user is rolling back by mistake, and nothing here is in a
 * position to tell those apart. A file holding revocation codes does not get
 * thrown away on an assumption.
 */
export function setAside(file: string): void {
	if (!existsSync(file)) {
		return;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	try {
		renameSync(file, `${file}.superseded-${stamp}`);
	} catch (err) {
		throw new VaultStorageError('could not set the current vault file aside', err);
	}
}

/**
 * Recover from the backup after a corrupted vault (§12 F1).
 *
 * Deliberately explicit rather than automatic: silently loading an older vault
 * would quietly resurrect accounts the user had removed, and could roll back a
 * newly-added one they believe is saved. The user is told what happened and
 * chooses.
 */
export function readBackupEnvelope(file: string): Envelope | undefined {
	const paths = vaultPaths(file);
	if (!existsSync(paths.backup)) {
		return undefined;
	}
	try {
		return readEnvelope(paths.backup);
	} catch {
		return undefined;
	}
}
