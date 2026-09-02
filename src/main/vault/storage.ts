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
	statSync,
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
	/**
	 * **Whether the file on disk is still what it was before the call.**
	 *
	 * `writeEnvelope` publishes by rename and verifies afterwards, so a failure
	 * that happens after the rename has already replaced the file - and when the
	 * rollback cannot put the old one back, the caller is holding a failure whose
	 * message says "write failed" over a file that was, in fact, written.
	 *
	 * That distinction only existed in the wording of two error messages. A
	 * rotation read the exception, concluded nothing had been replaced, and kept
	 * the live session on the retired key while the file was under the new one -
	 * so the next ordinary save re-sealed it backwards and the new passphrase
	 * stopped working. The information was there; it was just not in a form
	 * anything could act on.
	 *
	 * True for every refusal that happens before a byte moves, which is the
	 * default because most of them are.
	 */
	readonly unchanged: boolean;

	constructor(
		message: string,
		override readonly cause?: unknown,
		unchanged = true
	) {
		super(message);
		this.name = 'VaultStorageError';
		this.unchanged = unchanged;
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
			writeAll(fd, serialised);
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
			err,
			putBack
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
export function writeRotationJournal(file: string, envelope: Envelope, vaultNonce?: string): void {
	/*
	 * Wrapped rather than bare, so the nonce of the vault this rotation is about
	 * to write travels with the backup it owes. `readRotationJournal` still
	 * accepts the bare envelope a previous build wrote.
	 */
	const serialised = `${JSON.stringify(
		vaultNonce === undefined ? envelope : { backup: envelope, vaultNonce },
		null,
		2
	)}
`;
	const temp = `${journalPath(file)}.tmp`;
	try {
		const fd = openSync(temp, 'w', 0o600);
		try {
			writeAll(fd, serialised);
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
export function readRotationJournal(file: string): RotationJournal {
	/*
	 * **"Not there" and "could not look" are different answers.**
	 *
	 * This asked `existsSync`, which returns false for both: a path it is not
	 * allowed to stat reads exactly like a path with nothing at it. Everything
	 * downstream then treats that as "no rotation was interrupted" and clears the
	 * suspicion on the backup - so the one remaining way to reach a backup that
	 * may still open with a retired passphrase was for the check to fail rather
	 * than to answer.
	 *
	 * Every other error in this function already lands on `unreadable`, which
	 * refuses to offer the backup. This is the branch that did not.
	 */
	try {
		if (statSync(journalPath(file), { throwIfNoEntry: false }) === undefined) {
			return { state: 'none' };
		}
	} catch {
		return { state: 'unreadable' };
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(journalPath(file), 'utf8'));
		/*
		 * Two shapes, and they cannot be confused: an envelope requires `version`,
		 * `kdf`, `cipher`, `ciphertext` and `modifiedAt`, none of which the wrapper
		 * has. The bare form is what builds before the nonce existed wrote.
		 */
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			'backup' in parsed &&
			typeof (parsed as { vaultNonce?: unknown }).vaultNonce === 'string'
		) {
			return {
				state: 'owed',
				backup: envelopeSchema.parse(parsed.backup),
				vaultNonce: (parsed as unknown as { vaultNonce: string }).vaultNonce
			};
		}
		return { state: 'owed', backup: envelopeSchema.parse(parsed) };
	} catch {
		/*
		 * **Unreadable is not absent.**
		 *
		 * It used to return `undefined` for both, so a truncated journal — the exact
		 * thing a crash mid-rotation produces, alongside the crash the journal is
		 * for — read as "no rotation was interrupted". The backup then went on being
		 * offered and restored while it still opened with the retired passphrase,
		 * which is the whole of what the journal exists to prevent.
		 *
		 * Nothing here can finish that rotation. What it can do is stop the rest of
		 * the application acting on a backup it knows to be untrustworthy.
		 */
		return { state: 'unreadable' };
	}
}

/**
 * What the journal says about the last rotation.
 *
 *   - `none`: no rotation was interrupted.
 *   - `owed`: one was, and this is the backup it still has to write.
 *   - `unreadable`: one was, and what it left cannot be read. The backup on disk
 *     may still open with a retired passphrase and nothing can put that right.
 */
export type RotationJournal =
	| { state: 'none' }
	| {
			state: 'owed';
			backup: Envelope;
			/**
			 * The nonce of the vault this rotation wrote, when the journal records
			 * one.
			 *
			 * **The salt cannot tell a paid debt from an owed one.** A finished
			 * rotation leaves the vault carrying exactly the salt the journal names,
			 * and so does every ordinary save after it — so one failed `unlink` made
			 * the debt look owed for ever, and a later start wrote the rotation-era
			 * backup over a `.bak` the saves had moved on. Comparing the backup on
			 * disk covers that until the backup goes missing, and then there is
			 * nothing left to compare.
			 *
			 * The nonce is fresh for every seal, so a vault still carrying the
			 * rotation's own nonce is the statement "nothing has been written since"
			 * — which makes installing this backup correct whether the rotation was
			 * interrupted or merely failed to tidy up. Undefined for journals written
			 * before this field existed.
			 */
			vaultNonce?: string;
	  }
	| { state: 'unreadable' };

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
			writeAll(fd, serialised);
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

		/*
		 * **The one that was still open: the destination check has no way back.**
		 *
		 * Verifying the staged copy moved most of the risk off the old backup, and
		 * left this. The rename replaces the working backup, and the read-back that
		 * follows it can fail - a filesystem that reported a rename it did not do,
		 * a device that went away between the two. At that point the previous
		 * backup is gone and what stands in its place is the thing that just failed
		 * verification, while the error says the backup "could not be rewritten",
		 * which a reader takes to mean the old one survived.
		 *
		 * So the old one is copied aside first, and put back if anything after the
		 * rename goes wrong. A copy rather than a rename, deliberately: renaming it
		 * out of the way would leave a moment with no backup at all, and a crash
		 * inside that moment is the failure this whole file exists to avoid.
		 */
		let previous: string | undefined;
		if (existsSync(paths.backup)) {
			previous = `${paths.backup}.previous`;
			copyFileSync(paths.backup, previous);
		}

		try {
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
			/*
			 * **The set-aside copy is only disposable once it is no longer the only
			 * one.**
			 *
			 * This restored and then dropped `.previous` in a `finally`, which ran
			 * whether or not the restore worked - and the restore is a `copyFileSync`
			 * that can fail for every reason the write above just failed for. A
			 * destination that would not verify, a restore that could not run, and
			 * then the deletion of the only remaining good copy: the exact loss the
			 * set-aside exists to prevent, moved one level down.
			 *
			 * So it is kept unless the backup it guards is known to be good, and
			 * where it is kept is in the message. A path in an error is worth more
			 * than a file nobody knows about.
			 */
			let restored = false;
			if (previous !== undefined && existsSync(previous)) {
				try {
					copyFileSync(previous, paths.backup);
					tighten(paths.backup);
					syncDirectory(dirname(file));
					// Verified, not assumed: this is the copy everything else now
					// depends on, and it is being made under whatever conditions broke
					// the write above.
					restored = readFileSync(paths.backup, 'utf8') === readFileSync(previous, 'utf8');
				} catch {
					restored = false;
				}
			}

			if (previous !== undefined && restored) {
				try {
					unlinkSync(previous);
				} catch {
					/* best effort: a stray copy is overwritten by the next write */
				}
			}

			if (previous !== undefined && !restored) {
				throw new VaultStorageError(
					'the vault backup could not be rewritten, and the previous backup could not be put ' +
						`back. The last good copy is still on disk at ${previous} - do not delete it.`,
					err
				);
			}
			throw err;
		}

		/*
		 * The new backup is in place and verified, so the set-aside copy has stopped
		 * being the only good one and can go. On the success path rather than in a
		 * `finally`, because a `finally` is exactly what deleted it after a failed
		 * restore.
		 */
		if (previous !== undefined) {
			try {
				if (existsSync(previous)) {
					unlinkSync(previous);
				}
			} catch {
				/* best effort: a stray copy is overwritten by the next write */
			}
		}
	} catch (err) {
		try {
			if (existsSync(temp)) {
				unlinkSync(temp);
			}
		} catch {
			/* best effort */
		}
		/*
		 * A storage error from inside already says the specific thing that went
		 * wrong - including, on the failed-restore path, where the last good copy
		 * is. Re-wrapping it replaced that with the generic sentence and threw the
		 * path away, which is the one detail the user needs from that branch.
		 */
		if (err instanceof VaultStorageError) {
			throw err;
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
			writeAll(fd, serialised);
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

/**
 * Write the whole string, or throw.
 *
 * `writeSync` may write fewer bytes than it was given and return normally — a
 * full disk, a pipe, a network filesystem under pressure. Every call here
 * ignored the count, so a short write was followed by an `fsync` and a rename
 * that published the truncated result as though it were complete. For the
 * recovery file, which nothing reads back, that is a file that looks like a
 * backup until somebody needs it.
 *
 * The loop is over a Buffer rather than the string, because a partial write
 * lands on a byte boundary and slicing UTF-8 by character would resume in the
 * wrong place.
 */
function writeAll(fd: number, text: string): void {
	const bytes = Buffer.from(text, 'utf8');
	let written = 0;
	while (written < bytes.length) {
		const wrote = writeSync(fd, bytes, written, bytes.length - written);
		if (wrote <= 0) {
			throw new Error('the write stopped making progress before the file was complete');
		}
		written += wrote;
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
