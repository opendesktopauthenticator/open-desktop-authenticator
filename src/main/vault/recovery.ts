import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { open } from './crypto';
import { accountSchema, type Account } from '../../shared/vault-schema';

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
 * So this is written **once, at enrollment**, and never touched again. Removal
 * does not delete it. That is deliberate: a safety net that the accident also
 * destroys is not a safety net.
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

function durably(path: string, body: string): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temp, 'wx', 0o600);
		try {
			writeAll(fd, body);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
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
				throw err;
			}
			/*
			 * Hard links are not universal — FAT32, some network shares, some
			 * container mounts. Falling back to the rename keeps the durability and
			 * loses only the atomicity of the exclusion, which the check above
			 * still covers for everything but a genuine race. Refusing to write a
			 * recovery file at all would be much worse than that.
			 */
			if (existsSync(path)) {
				throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
			}
			renameSync(temp, path);
			// The rename consumed it; there is nothing left to unlink.
			syncDirectory(dirname(path));
			return;
		}

		/*
		 * The link succeeded, so the same bytes are now reachable under two names.
		 * Dropping the temp leaves one file — and it has to happen here rather than
		 * in the catch, which only runs when something went wrong.
		 */
		unlinkSync(temp);
		syncDirectory(dirname(path));
	} catch (err) {
		try {
			if (existsSync(temp)) {
				unlinkSync(temp);
			}
		} catch {
			/* best effort: a stray temp is not what the caller is told about */
		}
		throw err;
	}
}

/**
 * Flush the directory entry, so a rename survives a power cut.
 *
 * Best effort: Windows has no equivalent and rejects the open, and a recovery
 * file that is written but not durably indexed is still better than none.
 */
function syncDirectory(dir: string): void {
	try {
		const fd = openSync(dir, 'r');
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* not supported here */
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
	mkdirSync(dirname(path), { recursive: true });
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
 * authenticator's secrets. This one overwrites on purpose, and callers must only
 * ever hand it a path returned by `writeRecoveryFile` during this same run.
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
	try {
		writeFileSync(
			temp,
			`${JSON.stringify(envelope, null, 2)}
`,
			{
				encoding: 'utf8',
				mode: 0o600,
				flag: 'wx'
			}
		);
		renameSync(temp, path);
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
	writeRecovery: (account: Account) => void;
	updateRecovery: (account: Account) => void;
}

export function createRecoveryHooks(options: {
	/** The app's data directory, read lazily — Electron cannot answer before ready. */
	userDataPath: () => string;
	/** Seals with the vault's in-memory key. Throws when the vault is locked. */
	seal: (plaintext: string) => unknown;
	now?: () => number;
}): RecoveryHooks {
	const now = options.now ?? ((): number => Date.now());

	/**
	 * Where this run wrote each account's file.
	 *
	 * Not always the path asked for: a pre-existing backup for the same SteamID
	 * sends the write to a sibling, and correcting the primary in that case would
	 * overwrite an older enrollment's only copy.
	 */
	const written = new Map<string, string>();

	const sealed = (account: Account): unknown =>
		options.seal(recoveryContents(account, new Date(now()).toISOString()));

	return {
		writeRecovery: (account) => {
			written.set(
				account.steamId64,
				writeRecoveryFile(
					recoveryPathFor(options.userDataPath(), account.steamId64),
					sealed(account)
				)
			);
		},

		updateRecovery: (account) => {
			// The map is empty after a restart, which is the common case rather than
			// the exotic one. Falling back to the filesystem is safe only when the
			// answer is unambiguous: exactly one file for this SteamID means one
			// enrollment, and it is this one. Two means an earlier enrollment left a
			// file behind and nothing here can say which belongs to this account, so
			// neither is touched.
			const found = recoveryFilesFor(options.userDataPath(), account.steamId64);
			const path = written.get(account.steamId64) ?? (found.length === 1 ? found[0] : undefined);
			if (path === undefined) {
				return;
			}
			updateRecoveryFile(path, sealed(account));
		}
	};
}

/**
 * Every recovery file on disk for one account, primary and siblings alike.
 *
 * Used to correct a file written by an **earlier run**. Activation records the
 * path it wrote so it can rewrite the same one, but that record is process-local
 * — and the case the recovery file exists for is precisely a crash between
 * enrolling and activating, which means the correction usually happens in a
 * later run with nothing remembered.
 *
 * The caller may only act when this returns exactly one path. Two means a
 * previous enrollment for the same SteamID left a file behind, and nothing here
 * can tell which of them the current account owns.
 */
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
