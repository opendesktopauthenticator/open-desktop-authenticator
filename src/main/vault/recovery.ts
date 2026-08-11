import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
		writeFileSync(path, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		return path;
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
			throw err;
		}
		const beside = supersededPath(path);
		writeFileSync(beside, body, { encoding: 'utf8', mode: 0o600 });
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
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(envelope, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600
	});
	renameSync(temp, path);
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
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return `${path.slice(0, -RECOVERY_EXTENSION.length)}.${stamp}${RECOVERY_EXTENSION}`;
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
		throw new RecoveryError(
			'that passphrase did not open this file. Note it is the passphrase the vault had **when ' +
				'the account was created**, which is not necessarily your current one.'
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
