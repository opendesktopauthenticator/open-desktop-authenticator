import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
export function writeRecoveryFile(path: string, envelope: unknown): void {
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
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
			throw err;
		}
		writeFileSync(supersededPath(path), body, { encoding: 'utf8', mode: 0o600 });
	}
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
