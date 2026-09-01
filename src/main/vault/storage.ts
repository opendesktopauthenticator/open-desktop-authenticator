import {
	chmodSync,
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
		// **No path in the message.** `ENOENT`/`EACCES` text reaches the renderer
		// through unlock, passphrase change and passphrase verification, none of
		// which sanitise it — and the path names the user's OS account and their
		// AppData layout to a sandboxed process that has no use for either. The
		// original error is still attached as `cause` for anything running locally.
		throw new VaultStorageError('the vault file could not be read', err);
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
			// **Cleared first, on Windows.** `copyFileSync` carries the source's
			// read-only attribute onto the destination, so one save attempted
			// against a read-only `vault.json` stamped that attribute onto `.bak` —
			// and every later save then died here, on the backup copy, even after
			// the user had fixed the original file. Best effort: on POSIX this is a
			// no-op against a file we are about to overwrite anyway, and a backup
			// that cannot be un-marked is a reason to try the copy, not to skip it.
			if (existsSync(paths.backup)) {
				try {
					chmodSync(paths.backup, 0o600);
				} catch {
					/* not supported here, or already writable */
				}
			}
			copyFileSync(file, paths.backup);
		} catch (err) {
			throw new VaultStorageError('could not back up the existing vault before writing', err);
		}
	}

	try {
		// **`0o600`, owner-only.** Without an explicit mode `openSync` creates the
		// file `0o666`, which an ordinary `022` umask turns into `0o644` — so on a
		// shared Linux machine every other local user could read the vault and
		// attack the passphrase offline, at their leisure, against a file whose
		// whole purpose is to be the thing they cannot get. `recovery.ts` has always
		// written `0o600`; this is the same policy on the larger file.
		//
		// `renameSync` carries the mode across, so the vault inherits it.
		const fd = openSync(paths.temp, 'w', 0o600);
		try {
			writeSync(fd, serialised, 0, 'utf8');
			// Durable before the rename, or "atomic" is a claim rather than a fact.
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}

		renameSync(paths.temp, file);
		// Vaults written by an earlier build are already on disk at `0o644`, and the
		// mode above only fixes files created from here on. Narrowing both on every
		// write is what actually repairs an existing install.
		tighten(file);
		if (hadExisting) {
			tighten(paths.backup);
		}
		syncDirectory(dirname(file));

		// Verify what actually landed rather than trusting the write.
		const readBack = readFileSync(file, 'utf8');
		if (readBack !== serialised) {
			throw new Error('the file on disk does not match what was written');
		}
		envelopeSchema.parse(JSON.parse(readBack));
	} catch (err) {
		const putBack = restore(paths, hadExisting);
		throw new VaultStorageError(
			putBack
				? 'the vault write failed and the previous file was restored'
				: 'the vault write failed and the previous file could NOT be put back. The file on ' +
						'disk may be incomplete. The last good copy is beside it, named vault.json.bak — ' +
						'do not delete it, and use Restore from backup in Settings.',
			err
		);
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

/**
 * Narrow a file to owner-only, best effort.
 *
 * Best effort because Windows has no POSIX mode — `chmodSync` there touches only
 * the read-only flag, and the real protection is the per-user ACL on
 * `%APPDATA%`. Failing a vault write over a permission bit we cannot set on the
 * platform most users are on would trade a real guarantee for a theoretical one.
 */
/**
 * Replace the backup, and nothing else.
 *
 * **Because a passphrase rotation left the backup readable with the retired
 * passphrase.** `writeEnvelope` copies the file it is about to overwrite into
 * `.bak` first, which is exactly right for an ordinary save — the backup is the
 * previous good state. During a rotation it is a hole: the file being copied is
 * still sealed under the *old* key, so the passphrase the user had just retired
 * went on opening `vault.json.bak` and every account in it. The Settings screen
 * promises the opposite in as many words.
 *
 * Written through a temp file and a rename like the main vault, and verified by
 * reading it back, because a half-written backup is worse than a stale one: the
 * stale one at least opens.
 */
/**
 * Where a rotation records the backup it still owes.
 *
 * **A rotation is two writes and there is a gap between them.** The main vault
 * goes first, sealed under the new key; the backup is re-sealed under the same
 * key a moment later. Lose power in between and the file opens with the new
 * passphrase while `.bak` still opens with the retired one — which is exactly
 * the hole re-sealing the backup exists to close, reappearing at the crash
 * boundary instead of at the write.
 *
 * So the rotation says what it is about to do before it does any of it. If the
 * journal is on disk when the application next starts, the rotation was
 * interrupted and `reconcile` finishes it. The journal holds the backup envelope
 * itself, already sealed under the new key, so finishing needs nothing the
 * process no longer has — not the passphrase, not the old key, not the plaintext.
 */
const journalPath = (file: string): string => `${file}.rotating`;

/** Record the backup a rotation is about to write. */
export function writeRotationJournal(file: string, envelope: Envelope): void {
	const serialised = `${JSON.stringify(envelope, null, 2)}
`;
	const temp = `${journalPath(file)}.tmp`;
	try {
		const fd = openSync(temp, 'w', 0o600);
		try {
			writeSync(fd, serialised, 0, 'utf8');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, journalPath(file));
		tighten(journalPath(file));
		syncDirectory(dirname(file));
	} catch (err) {
		try {
			if (existsSync(temp)) {
				unlinkSync(temp);
			}
		} catch {
			/* best effort */
		}
		throw new VaultStorageError('the rotation could not be recorded before it began', err);
	}
}

/**
 * The backup an interrupted rotation still owes, if there is one.
 *
 * A journal this cannot parse is treated as absent rather than thrown: it names
 * work that cannot be completed, and refusing to open the vault over it would
 * turn a lost backup into a lost vault.
 */
export function readRotationJournal(file: string): Envelope | undefined {
	if (!existsSync(journalPath(file))) {
		return undefined;
	}
	try {
		return envelopeSchema.parse(JSON.parse(readFileSync(journalPath(file), 'utf8')));
	} catch {
		return undefined;
	}
}

/** The rotation is finished, one way or another. */
export function clearRotationJournal(file: string): void {
	try {
		if (existsSync(journalPath(file))) {
			unlinkSync(journalPath(file));
		}
	} catch {
		/* best effort: a stale journal is re-read and re-applied, which is a no-op */
	}
}

export function writeBackupEnvelope(file: string, envelope: Envelope): void {
	const paths = vaultPaths(file);
	const serialised = `${JSON.stringify(envelope, null, 2)}\n`;
	const temp = `${paths.backup}.tmp`;

	try {
		// The read-only attribute travels on Windows, exactly as it does for the
		// copy in `writeEnvelope`.
		if (existsSync(paths.backup)) {
			try {
				chmodSync(paths.backup, 0o600);
			} catch {
				/* not supported here, or already writable */
			}
		}
		const fd = openSync(temp, 'w', 0o600);
		try {
			writeSync(fd, serialised, 0, 'utf8');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		/*
		 * **Verified before the old backup is replaced, not after.**
		 *
		 * The rename came first and the read-back followed it, so a verification
		 * failure had already destroyed the working backup — and the error thrown
		 * says the backup could not be rewritten, which reads as "the old one is
		 * still there". A vault holding revocation codes is exactly the thing not
		 * to leave with no recoverable copy on the strength of a write that was
		 * never checked.
		 *
		 * The temp file is on the same filesystem as the backup, so what is read
		 * back here is what the rename will publish.
		 */
		const staged = readFileSync(temp, 'utf8');
		if (staged !== serialised) {
			throw new Error('the staged backup on disk does not match what was written');
		}
		envelopeSchema.parse(JSON.parse(staged));

		renameSync(temp, paths.backup);
		tighten(paths.backup);
		syncDirectory(dirname(file));

		// And again at the destination, which is cheap and catches a rename that
		// reported success onto a filesystem that did something else.
		const readBack = readFileSync(paths.backup, 'utf8');
		if (readBack !== serialised) {
			throw new Error('the backup on disk does not match what was written');
		}
	} catch (err) {
		try {
			if (existsSync(temp)) {
				unlinkSync(temp);
			}
		} catch {
			/* best effort */
		}
		throw new VaultStorageError('the vault backup could not be rewritten', err);
	}
}

/**
 * Put an envelope back as the main vault without disturbing the backup.
 *
 * The undo half of a rotation. `writeEnvelope` would copy the *rotated* file
 * into `.bak` on its way past, which is the one thing a rollback must not do —
 * it would leave the backup holding the very contents the rollback exists to
 * discard, under a key the user does not have.
 */
export function restoreEnvelopeInPlace(file: string, envelope: Envelope): void {
	const paths = vaultPaths(file);
	const serialised = `${JSON.stringify(envelope, null, 2)}\n`;
	try {
		const fd = openSync(paths.temp, 'w', 0o600);
		try {
			writeSync(fd, serialised, 0, 'utf8');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(paths.temp, file);
		tighten(file);
		syncDirectory(dirname(file));
	} catch (err) {
		try {
			if (existsSync(paths.temp)) {
				unlinkSync(paths.temp);
			}
		} catch {
			/* best effort */
		}
		throw new VaultStorageError('the vault could not be put back after a failed rotation', err);
	}
}

function tighten(file: string): void {
	try {
		chmodSync(file, 0o600);
	} catch {
		/* not supported here; the directory's own permissions still apply */
	}
}

/**
 * Undo a failed write, and say whether it worked.
 *
 * **It used to say nothing, and the caller announced success regardless.** The
 * copy back was wrapped in a bare `catch {}` on the reasoning that the backup is
 * still on disk for manual recovery — true, and not what the message says. The
 * caller throws "the vault write failed and the previous file was restored",
 * which is a claim about `vault.json`, and a probe that made the copy fail left
 * new or truncated bytes in that file under exactly those words. Somebody
 * reading them has no reason to go looking at `.bak`.
 *
 * @returns whether the previous vault is back in place. `true` when there was
 * nothing to put back, because then nothing was displaced either.
 */
function restore(paths: VaultPaths, hadExisting: boolean): boolean {
	try {
		if (existsSync(paths.temp)) {
			unlinkSync(paths.temp);
		}
	} catch {
		/* best effort: a stray temp file is not what the caller is told about */
	}
	if (!hadExisting) {
		return true;
	}
	if (!existsSync(paths.backup)) {
		// Nothing to copy from. The file on disk is whatever the failed write left.
		return false;
	}
	try {
		copyFileSync(paths.backup, paths.file);
		return true;
	} catch {
		return false;
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
export function setAside(file: string): string | undefined {
	if (!existsSync(file)) {
		return undefined;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const moved = `${file}.superseded-${stamp}`;
	try {
		renameSync(file, moved);
	} catch (err) {
		throw new VaultStorageError('could not set the current vault file aside', err);
	}
	// **Returned so the move can be undone.** Whatever replaces this file may fail
	// to write, and `writeEnvelope`'s own rollback cannot help: it restores from
	// `.bak` only when a main file existed when it started, and this has just made
	// sure one does not. Without a way back, a failed restore leaves no vault at
	// all — which the app reads as a fresh install.
	return moved;
}

/** Undo a `setAside`. Best effort: the caller is already handling a failure. */
export function putBack(moved: string, file: string): void {
	try {
		if (existsSync(moved) && !existsSync(file)) {
			renameSync(moved, file);
		}
	} catch {
		// Nothing useful to do. The file is still on disk under its moved name, and
		// the caller's error says so.
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
