import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	linkSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { open } from './crypto';
import { accountSchema, type Account } from '../../shared/vault-schema';
import { envelopeSchema } from '../../shared/vault-format';
import { authenticatorFingerprint } from '../steam/authenticator-secrets';

/**
 * A per-account recovery file, written the moment an authenticator is created.
 *
 * ## The accident this exists for
 *
 * Remove an account from the vault, then discover you never wrote the revocation
 * code down. The authenticator is still attached on Steam, the secrets that
 * drove it are gone, and the only route left is Steam Support. Nothing else in
 * the application recovers from that — the vault backup is a rolling copy of the
 * *whole* vault and is overwritten by the next save, so two saves after a
 * removal it is gone too.
 *
 * It is first written at enrollment, before activation can complete, and its
 * status is corrected after Steam confirms activation. Removal does not delete
 * it. That is deliberate: a safety net that the accident also destroys is not
 * a safety net.
 *
 * ## Why not SDA's encrypted format
 *
 * It would be readable by SDA, which is worth something. Two reasons against, and
 * the second is decisive:
 *
 *  - SDA encrypts with PBKDF2 and AES-**CBC**, which is unauthenticated. A wrong
 *    passphrase produces garbage rather than an error. For a recovery file — used
 *    exactly when somebody is stressed and unsure which passphrase they used —
 *    "wrong passphrase" versus "silently wrong bytes" is the difference between a
 *    recoverable situation and a confusing one.
 *  - Writing a format we cannot verify against ground truth would mean a recovery
 *    file that might not be readable when it is finally needed, which is worse
 *    than not having one, because it was relied on.
 *
 * This uses the vault's own envelope: scrypt + AES-256-GCM, authenticated, and
 * self-contained — the salt and KDF parameters travel with the file, so the
 * passphrase alone opens it on any machine.
 */

/** Everything needed to put one account back. */
const recoveryFileSchema = z.object({
	kind: z.literal('oda-account-recovery'),
	version: z.literal(1),
	/** Informational, so a user can tell files apart without decrypting them. */
	steamId64: z.string(),
	accountName: z.string(),
	createdAt: z.string(),
	account: accountSchema
});

export type RecoveryFile = z.infer<typeof recoveryFileSchema>;

/** The extension, chosen so it is obviously not a maFile and not openable by accident. */
export const RECOVERY_EXTENSION = '.oda-recovery';

/** Where recovery files live, given the app's data directory. */
export function recoveryDirectory(userDataPath: string): string {
	return join(userDataPath, 'recovery');
}

export function recoveryPathFor(userDataPath: string, steamId64: string): string {
	return join(recoveryDirectory(userDataPath), `${steamId64}${RECOVERY_EXTENSION}`);
}

/**
 * The plaintext that goes inside the envelope.
 *
 * The **refresh token is stripped**. A recovery file is for restoring an
 * authenticator, not for resuming a session — and a file that also logs somebody
 * in is a materially worse thing to leave on a disk for months. The secrets it
 * does carry are enough to generate codes and sign confirmations, which is what
 * recovery means.
 */
export function recoveryContents(account: Account, nowIso: string): string {
	const copy: Account = { ...account };
	delete copy.refreshToken;
	// This names a file in this installation's private data directory. Carrying
	// it inside the portable recovery document would make a restored account
	// claim ownership of a pathname that may not exist on this machine — or may
	// belong to a different installation entirely.
	delete copy.recoveryBackup;

	const file: RecoveryFile = {
		kind: 'oda-account-recovery',
		version: 1,
		steamId64: account.steamId64,
		accountName: account.accountName,
		createdAt: nowIso,
		account: copy
	};
	return JSON.stringify(file);
}

/**
 * Write a file so that what is on disk is either all of it or none of it.
 *
 * **The recovery file was written straight to its final name**, with no temp, no
 * rename and no sync. An injected ENOSPC left a truncated file at exactly the
 * path the restore path reads — the single file in this application whose entire
 * purpose is to still be there, and to be readable, after everything else has
 * gone wrong. A short JSON document is not a recovery file; it is a file that
 * looks like one until somebody needs it.
 *
 * The vault itself has been written this way since it was written. This is the
 * same sequence: a temp file in the same directory, flushed, renamed over the
 * destination, and the directory entry itself flushed so the rename survives a
 * power cut rather than only a crash.
 */
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

const LINK_UNSUPPORTED = new Set(['EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);

/**
 * Whether a pathname still names the file represented by an open descriptor.
 *
 * Reading the pathname back is not ownership proof: another writer can replace
 * it with the same bytes. `dev` + `ino` is the identity the kernel gives the
 * open file and its current directory entry. Keeping the descriptor open until
 * immediately after this check makes a replacement visible on filesystems that
 * expose that identity (including the filesystems supported by Node on our
 * release platforms).
 */
function pathStillNames(fd: number, path: string): boolean {
	try {
		const held = fstatSync(fd, { bigint: true });
		const named = statSync(path, { bigint: true });
		return held.dev === named.dev && held.ino === named.ino;
	} catch {
		return false;
	}
}

function unlinkStillOwned(path: string, fd: number): void {
	if (!pathStillNames(fd, path)) {
		throw new Error(`refusing to remove a recovery staging pathname no longer owned: ${path}`);
	}
	unlinkSync(path);
}

function closeWithoutMasking(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		closeSync(fd);
	} catch {
		// A publication error carries the useful diagnosis; closing is best effort.
	}
}

function durably(path: string, body: string): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	let staged: number | undefined;
	let stageIsComplete = false;
	try {
		staged = openSync(temp, 'wx+', 0o600);
		writeAll(staged, body);
		fsyncSync(staged);
		stageIsComplete = true;

		/*
		 * The stage is the durable witness that creation of the recovery directory
		 * still needs its parent flushed. Do this on every attempt rather than
		 * inferring durability from `existsSync(directory)`: if this sync fails, the
		 * complete stage remains and reconciliation repeats the barrier next time.
		 */
		syncDirectory(dirname(dirname(path)));
		/*
		 * **`link`, not `rename`, and that distinction is the whole point.**
		 *
		 * This file used to be written with `writeFileSync(..., { flag: 'wx' })` —
		 * one syscall that creates the file or fails, and cannot overwrite. Making
		 * the write durable replaced it with a temp file and a rename, and a rename
		 * *does* overwrite: `renameSync` onto an existing path replaces it silently
		 * on every platform this ships to. Measured, not assumed.
		 *
		 * That traded the guarantee the caller depends on for the one it was
		 * asking for. A recovery file is keyed on the SteamID, so enrolling the
		 * same account twice aims at the same path, and what would be replaced is
		 * the backup of a *previous* authenticator — the single file in this
		 * application whose entire purpose is to still be there later. The
		 * `existsSync` above narrows the window and cannot close it: another
		 * process, or another enrolment in this one, can create the file between
		 * the check and the rename.
		 *
		 * `link` fails with EEXIST if the destination is there, atomically, which
		 * is `wx` by another name. The temp is unlinked afterwards, leaving one
		 * file with the contents already flushed to disk.
		 */
		try {
			linkSync(temp, path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
				unlinkStillOwned(temp, staged);
				stageIsComplete = false;
				throw err;
			}
			if (!LINK_UNSUPPORTED.has((err as NodeJS.ErrnoException | undefined)?.code ?? '')) {
				throw err;
			}
			/*
			 * **Hard links are not universal**, and the fallback still may not
			 * overwrite.
			 *
			 * FAT32, some network shares and some container mounts have no `link`.
			 * What stood here was a check and then a rename, and the comment admitted
			 * the gap in as many words: the check narrows the window and cannot close
			 * it, because a rename overwrites and another enrolment can create the
			 * file in between. What it would overwrite is a previous authenticator’s
			 * recovery file - the one file here whose whole purpose is to still be
			 * there later.
			 *
			 * So the name is claimed with `wx` and the document is written through that
			 * still-open descriptor. Closing an empty placeholder and renaming over its
			 * pathname was not ownership: another writer could unlink it and put a
			 * recovery file there before the rename, and the rename then destroyed that
			 * file. Keeping the descriptor open, and verifying the pathname afterwards,
			 * makes that replacement observable without ever overwriting it.
			 */
			let claimed: number | undefined;
			let destinationFlushed = false;
			try {
				claimed = openSync(path, 'wx+', 0o600);
				writeAll(claimed, body);
				fsyncSync(claimed);
				destinationFlushed = true;
				if (!pathStillNames(claimed, path) || readFileSync(path, 'utf8') !== body) {
					throw new Error('the published recovery file was replaced while it was being written', {
						cause: err
					});
				}
				/* Keep the staged witness until the new destination entry is durable. */
				syncDirectory(dirname(path));
				unlinkStillOwned(temp, staged);
				stageIsComplete = false;
			} catch (writeFailed) {
				if (!destinationFlushed && claimed !== undefined && pathStillNames(claimed, path)) {
					try {
						unlinkSync(path);
					} catch {
						// The complete stage remains the recoverable copy.
					}
				}
				throw writeFailed;
			} finally {
				closeWithoutMasking(claimed);
			}
			return;
		}

		/*
		 * The link succeeded, so both names must still identify the descriptor we
		 * wrote. Flush the target entry before dropping the only independently named
		 * staged witness. A failed sync therefore leaves both names for restart.
		 */
		if (!pathStillNames(staged, path)) {
			throw new Error('the published recovery file no longer names the staged document');
		}
		syncDirectory(dirname(path));
		if (!pathStillNames(staged, path)) {
			throw new Error('the published recovery file changed after its directory sync');
		}
		unlinkStillOwned(temp, staged);
		stageIsComplete = false;
	} catch (err) {
		/*
		 * A complete stage is deliberately retained: it is the retry evidence for
		 * parent/target directory sync failures and for an interrupted fallback.
		 * An incomplete stage has no recovery value and may be removed, but only
		 * while its still-open descriptor proves the pathname is ours.
		 */
		if (!stageIsComplete && staged !== undefined) {
			try {
				if (pathStillNames(staged, temp)) unlinkSync(temp);
			} catch {
				/* preserve the original failure */
			}
		}
		throw err;
	} finally {
		closeWithoutMasking(staged);
	}
}

/**
 * Flush the directory entry, so a rename survives a power cut.
 *
 * Windows has no equivalent and rejects the open. Only those platform-specific
 * unsupported errors are ignored; an I/O or full-disk error on a platform that
 * supports directory sync means publication is not known durable.
 */
function syncDirectory(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, 'r');
		fsyncSync(fd);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (
			process.platform === 'win32' &&
			(code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'EBADF')
		) {
			return;
		}
		throw err;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Write one, creating the directory if needed.
 *
 * `mode: 0o600` — owner-only. It is encrypted, so this is defence in depth rather
 * than the protection, but there is no reason for another user on the machine to
 * be able to copy it and attack the passphrase offline at their leisure.
 */
export function writeRecoveryFile(path: string, envelope: unknown): string {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });

	/*
	 * A previous call may have failed only at a directory durability barrier. Its
	 * complete staged witness belongs to this exact deterministic destination, so
	 * finish that attempt before creating another encrypted copy. Ambiguity is a
	 * refusal, not permission to let enumeration order choose a winner.
	 */
	const resumed = reconcileRecoveryDirectory(directory, path);
	if (resumed.ambiguous.includes(path)) {
		throw new Error(`more than one recovery publication is staged for ${path}`);
	}
	if (resumed.finished.includes(path)) {
		return path;
	}
	const body = `${JSON.stringify(envelope, null, 2)}\n`;

	// `wx` — fail if it is already there.
	//
	// A recovery file is keyed on the SteamID, so enrolling the same account twice
	// aims at the same path. Overwriting would silently replace a backup of the
	// *previous* authenticator with one for the new one — and this is the single
	// file in the application whose entire purpose is to still be there later.
	// Keeping both and leaving the user one file too many is much cheaper than
	// destroying the one they turn out to need.
	try {
		// `wx` on the destination is what makes the refusal above real, so the
		// existence check and the durable write are kept together: staging first
		// and renaming would replace an existing file, which is the one thing this
		// must never do.
		if (existsSync(path)) {
			const err: NodeJS.ErrnoException = new Error('EEXIST: file already exists');
			err.code = 'EEXIST';
			throw err;
		}
		durably(path, body);
		return path;
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
			throw err;
		}
		const beside = supersededPath(path);
		durably(beside, body);
		// **The path actually used**, which is not always the one asked for. A
		// caller that wants to correct this file later needs to know where it went;
		// updating the primary path when the write landed beside it would overwrite
		// a different enrollment's backup — the exact loss `wx` exists to prevent.
		return beside;
	}
}

/**
 * Rewrite a recovery file this process created, in place.
 *
 * Separate from `writeRecoveryFile`, and deliberately so: that one must never
 * overwrite, because what it would replace may be the only copy of a different
 * authenticator's secrets. This one overwrites on purpose, and callers must hand
 * it only an exact path whose application ownership survived in the encrypted
 * vault marker (or the deterministic exact-fingerprint legacy path).
 *
 * ## Why an update is needed at all
 *
 * The file is written the moment Steam issues the secrets — necessarily before
 * activation, because the window before the vault write is what it exists to
 * survive. So it records `status: 'pendingActivation'`, and nothing ever
 * corrected that. Restoring after an ordinary activate-then-remove therefore
 * produced an account the application believed had never been activated: it
 * offered to finish activating, and could not, because the file carries no
 * refresh token by design.
 *
 * Deciding the status at restore time instead would be a guess. The file cannot
 * distinguish "activated, then removed" from "crashed before activating", and
 * both are real situations this feature is for. Correcting the file at the
 * moment the fact becomes known needs no guess.
 *
 * Temp-then-rename, so a failure leaves the existing file exactly as it was: a
 * half-written recovery file is worse than a stale one.
 */
export function updateRecoveryFile(path: string, envelope: unknown): void {
	// A unique name and `wx`, like the maFile export. A fixed `${path}.tmp`
	// truncated whatever already sat there — a leftover from a crashed update, or
	// any sibling — and then renamed it into place as the recovery file.
	const temp = `${path}.${randomUUID()}.tmp`;
	const body = `${JSON.stringify(envelope, null, 2)}\n`;
	try {
		const fd = openSync(temp, 'wx', 0o600);
		try {
			writeAll(fd, body);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (readFileSync(temp, 'utf8') !== body) {
			throw new Error('the staged recovery update did not read back exactly');
		}
		renameSync(temp, path);
		syncDirectory(dirname(path));
		if (readFileSync(path, 'utf8') !== body) {
			throw new Error('the published recovery update did not read back exactly');
		}
	} catch (err) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// Nothing useful to do; the throw below is the news.
		}
		throw err;
	}
	// **`mode` alone is not enough.** POSIX applies it only when the file is
	// created, and `rename` keeps the inode — so an update over a file that was
	// already world-readable left it world-readable, holding a shared secret and
	// a revocation code. The vault's own writer narrows after its rename for
	// exactly this reason; best effort, since Windows has no POSIX mode.
	try {
		chmodSync(path, 0o600);
	} catch {
		/* not supported here; the directory's own permissions still apply */
	}
}

/**
 * The pair of callbacks the enrollment service uses to keep a recovery file
 * honest, with the bookkeeping that connects them.
 *
 * A factory rather than two loose functions in `index.ts`, because the thing
 * worth testing is the **relationship** between them across a restart, and that
 * relationship lived in application wiring no test could reach. An audit found
 * the restart case broken precisely there: the correction worked in the run that
 * wrote the file and silently did nothing afterwards, which is the wrong way
 * round — a crash between enrolling and activating is what the file is for.
 *
 * Constructing a new instance is exactly what a restart does, so a test can
 * reproduce one by doing the same.
 */
export interface RecoveryHooks {
	writeRecovery: (account: Account) => string;
	updateRecovery: (account: Account) => RecoveryUpdateResult;
}

export type RecoveryUpdateResult = 'updated' | 'missing' | 'ambiguous';

/** Stable path identity for one authenticator, not merely one Steam account. */
export function recoveryPathForAuthenticator(userDataPath: string, account: Account): string {
	return join(
		recoveryDirectory(userDataPath),
		`${account.steamId64}.${authenticatorFingerprint(account)}${RECOVERY_EXTENSION}`
	);
}

/**
 * Whether a persisted basename could only have been allocated by this module
 * for this exact authenticator.
 *
 * The deterministic name is used for the first copy. If that name is occupied,
 * `supersededPath` adds an ISO timestamp and an eight-hex UUID fragment. Both
 * forms are basenames only: separators are refused explicitly so a marker
 * written on Windows cannot become a path on POSIX (or the other way round).
 */
export function isRecoveryFileNameForAuthenticator(account: Account, fileName: string): boolean {
	if (
		fileName.length === 0 ||
		fileName.length > 255 ||
		fileName.includes('/') ||
		fileName.includes('\\')
	) {
		return false;
	}
	const identity = `${account.steamId64}.${authenticatorFingerprint(account)}`;
	if (fileName === `${identity}${RECOVERY_EXTENSION}`) return true;
	if (!fileName.startsWith(`${identity}.`) || !fileName.endsWith(RECOVERY_EXTENSION)) {
		return false;
	}
	const allocation = fileName.slice(identity.length + 1, -RECOVERY_EXTENSION.length);
	return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.[0-9a-f]{8}$/i.test(allocation);
}

export function createRecoveryHooks(options: {
	/** The app's data directory, read lazily — Electron cannot answer before ready. */
	userDataPath: () => string;
	/** Seals with the vault's in-memory key. Throws when the vault is locked. */
	seal: (plaintext: string) => unknown;
	now?: () => number;
}): RecoveryHooks {
	const now = options.now ?? ((): number => Date.now());

	const sealed = (account: Account): unknown =>
		options.seal(recoveryContents(account, new Date(now()).toISOString()));

	return {
		writeRecovery: (account) => {
			return writeRecoveryFile(
				recoveryPathForAuthenticator(options.userDataPath(), account),
				sealed(account)
			);
		},

		updateRecovery: (account) => {
			/*
			 * The vault marker is the durable ownership proof. A process-local map made
			 * the exact sibling discoverable only until restart, after which the old
			 * implementation guessed from the number of files for a SteamID. One file
			 * is not identity proof: it may be an older authenticator's only backup.
			 *
			 * Accounts written before the marker existed get one narrow compatibility
			 * path: the deterministic filename for their exact authenticator
			 * fingerprint. No enumeration and no singleton inference are involved.
			 */
			const marker = account.recoveryBackup;
			if (
				marker !== undefined &&
				marker.authenticatorFingerprint !== authenticatorFingerprint(account)
			) {
				return 'missing';
			}
			const ownedName = marker?.fileName;
			const path =
				ownedName === undefined
					? recoveryPathForAuthenticator(options.userDataPath(), account)
					: isRecoveryFileNameForAuthenticator(account, ownedName)
						? join(recoveryDirectory(options.userDataPath()), ownedName)
						: undefined;
			if (path === undefined || !existsSync(path)) return 'missing';
			updateRecoveryFile(path, sealed(account));
			return 'updated';
		}
	};
}

/** A staging name contains the exact destination plus an application UUID. */
const STAGING_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

interface OpenRecoveryStage {
	path: string;
	target: string;
	fd: number;
	body: string;
}

interface RecoveryReconciliation {
	finished: string[];
	ambiguous: string[];
}

function targetForStageName(directory: string, name: string): string | undefined {
	const marker = `${RECOVERY_EXTENSION}.`;
	const at = name.lastIndexOf(marker);
	if (at < 0 || !STAGING_ID.test(name.slice(at + marker.length))) return undefined;
	return join(directory, name.slice(0, at + RECOVERY_EXTENSION.length));
}

/** Open and validate through one descriptor, so parsing cannot race a replacement. */
function openRecoveryStage(path: string, target: string): OpenRecoveryStage | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		const body = readFileSync(fd, 'utf8');
		if (!pathStillNames(fd, path)) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return undefined;
		}
		if (!envelopeSchema.safeParse(parsed).success) return undefined;
		const opened = { path, target, fd, body };
		fd = undefined;
		return opened;
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
		throw err;
	} finally {
		closeWithoutMasking(fd);
	}
}

/** Publish one complete stage while keeping it as evidence until the entry syncs. */
function publishRecoveryStage(stage: OpenRecoveryStage, directory: string): boolean {
	if (!pathStillNames(stage.fd, stage.path)) return false;
	try {
		linkSync(stage.path, stage.target);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === 'EEXIST') return false;
		if (!LINK_UNSUPPORTED.has(code ?? '')) throw err;

		let targetFd: number | undefined;
		let targetFlushed = false;
		try {
			targetFd = openSync(stage.target, 'wx+', 0o600);
			writeAll(targetFd, stage.body);
			fsyncSync(targetFd);
			targetFlushed = true;
			if (
				!pathStillNames(targetFd, stage.target) ||
				readFileSync(stage.target, 'utf8') !== stage.body ||
				!pathStillNames(targetFd, stage.target)
			) {
				throw new Error('the reconciled recovery file was replaced during publication', {
					cause: err
				});
			}
			syncDirectory(directory);
			if (!pathStillNames(targetFd, stage.target)) {
				throw new Error('the reconciled recovery destination changed after its directory sync', {
					cause: err
				});
			}
			unlinkStillOwned(stage.path, stage.fd);
			return true;
		} catch (writeFailed) {
			if (!targetFlushed && targetFd !== undefined && pathStillNames(targetFd, stage.target)) {
				try {
					unlinkSync(stage.target);
				} catch {
					// The complete stage remains available to retry on the next start.
				}
			}
			throw writeFailed;
		} finally {
			closeWithoutMasking(targetFd);
		}
	}

	if (!pathStillNames(stage.fd, stage.target)) {
		throw new Error('the reconciled recovery destination is not the staged document');
	}
	syncDirectory(directory);
	if (!pathStillNames(stage.fd, stage.target)) {
		throw new Error('the reconciled recovery destination changed after its directory sync');
	}
	unlinkStillOwned(stage.path, stage.fd);
	return true;
}

/**
 * If a crash happened after publication but before stage cleanup, exact bytes
 * under both names prove that the target is already the staged document. The
 * directory is flushed first; different bytes always preserve both files.
 */
function cleanPublishedStages(
	target: string,
	stages: OpenRecoveryStage[],
	directory: string
): 'missing' | 'unchanged' | 'finished' {
	let targetFd: number | undefined;
	try {
		targetFd = openSync(target, 'r');
		const targetBody = readFileSync(targetFd, 'utf8');
		if (!pathStillNames(targetFd, target)) return 'unchanged';
		const matching = stages.filter((stage) => stage.body === targetBody);
		if (matching.length === 0) return 'unchanged';

		syncDirectory(directory);
		for (const stage of matching) {
			if (!pathStillNames(targetFd, target)) {
				throw new Error('the recovery destination changed before staged cleanup');
			}
			unlinkStillOwned(stage.path, stage.fd);
		}
		return 'finished';
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'missing';
		throw err;
	} finally {
		closeWithoutMasking(targetFd);
	}
}

function reconcileRecoveryDirectory(
	directory: string,
	onlyTarget?: string
): RecoveryReconciliation {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
			return { finished: [], ambiguous: [] };
		}
		throw err;
	}

	const grouped = new Map<string, string[]>();
	for (const name of names) {
		const target = targetForStageName(directory, name);
		if (target === undefined || (onlyTarget !== undefined && target !== onlyTarget)) continue;
		const group = grouped.get(target) ?? [];
		group.push(join(directory, name));
		grouped.set(target, group);
	}
	if (grouped.size === 0) return { finished: [], ambiguous: [] };

	/* A staged witness means creation of this directory may still need durability. */
	syncDirectory(dirname(directory));

	const finished: string[] = [];
	const ambiguous: string[] = [];
	for (const [target, paths] of grouped) {
		const stages: OpenRecoveryStage[] = [];
		try {
			for (const path of paths) {
				const stage = openRecoveryStage(path, target);
				if (stage !== undefined) stages.push(stage);
			}
			if (stages.length === 0) continue;

			const occupied = cleanPublishedStages(target, stages, directory);
			if (occupied === 'finished') {
				finished.push(target);
				continue;
			}
			if (occupied === 'unchanged') continue;

			if (stages.length > 1) {
				ambiguous.push(target);
				continue;
			}
			const only = stages[0];
			if (only !== undefined && publishRecoveryStage(only, directory)) finished.push(target);
		} finally {
			for (const stage of stages) closeWithoutMasking(stage.fd);
		}
	}
	return { finished, ambiguous };
}

/**
 * Finish only unambiguous, verified recovery publications left by this module.
 * Ambiguity is made visible in the log and every candidate is preserved.
 */
export function reconcileRecoveryFiles(userDataPath: string): string[] {
	const result = reconcileRecoveryDirectory(recoveryDirectory(userDataPath));
	for (const target of result.ambiguous) {
		console.warn(`recovery publication is ambiguous; preserved every staged file for ${target}`);
	}
	return result.finished;
}

export function recoveryFilesFor(userDataPath: string, steamId64: string): string[] {
	const directory = recoveryDirectory(userDataPath);
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith(`${steamId64}.`) && name.endsWith(RECOVERY_EXTENSION))
		.map((name) => join(directory, name));
}

/** A sibling path that cannot collide, for a second file about the same account. */
function supersededPath(path: string): string {
	// The stamp alone is not unique: two writers in the same millisecond — an
	// import and an enrollment finishing together — produced the same sibling
	// path, and the second silently replaced the first encrypted backup. A short
	// random suffix makes the name unique regardless of clock resolution.
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const unique = randomUUID().slice(0, 8);
	return `${path.slice(0, -RECOVERY_EXTENSION.length)}.${stamp}.${unique}${RECOVERY_EXTENSION}`;
}

export class RecoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RecoveryError';
	}
}

/**
 * Open a recovery file with the passphrase it was written under.
 *
 * That is the vault passphrase **as it was at the time**, which is not
 * necessarily the current one — changing the vault passphrase does not rewrite
 * files already on disk. The screen says so, because "my passphrase is right and
 * it says it is wrong" is otherwise a very confusing few minutes.
 */
export async function readRecoveryFile(text: string, passphrase: string): Promise<RecoveryFile> {
	let envelope: unknown;
	try {
		envelope = JSON.parse(text);
	} catch {
		throw new RecoveryError('that file is not a recovery file this app wrote');
	}

	let plaintext: string;
	try {
		plaintext = await open(envelope, passphrase);
	} catch {
		// Deliberately one message for both "wrong passphrase" and "damaged file",
		// exactly as the vault does. Distinguishing them tells someone probing the
		// file which of the two they are up against.
		// **Not "when the account was created".** That was the old wording, and it
		// was wrong in the one case where somebody is reading it: activation
		// rewrites the file through `updateRecovery`, resealing it with whatever
		// key the vault holds *then*. So an account enrolled under one passphrase
		// and activated after a change opens with the newer one — and a user
		// following the old sentence would try the old passphrase, watch it fail,
		// and reasonably conclude their only backup was dead.
		throw new RecoveryError(
			'that passphrase did not open this file. A recovery file is sealed with the vault ' +
				'passphrase that was in use when the file was last written — usually your current ' +
				'one, but an older one if you have changed it since this account was set up. Try ' +
				'both.'
		);
	}

	const parsed = recoveryFileSchema.safeParse(JSON.parse(plaintext));
	if (!parsed.success) {
		throw new RecoveryError('that file decrypted, but it is not an account recovery file');
	}
	return parsed.data;
}

/** Read a file from disk as text, or undefined if it is not there. */
export function readIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}
