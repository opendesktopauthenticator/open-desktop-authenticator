import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { z } from 'zod';
import { wipe } from '../vault/crypto';

/**
 * Reading SDA's encrypted maFiles (§12 F2).
 *
 * Steam Desktop Authenticator can encrypt its maFiles with a passphrase. Users
 * migrating from it who turned that on cannot import anything without this, and
 * telling them to decrypt in SDA first means telling them to write their secrets
 * to disk in plaintext — the exact thing this application exists to avoid.
 *
 * ## Where these parameters came from
 *
 * Not from memory, and not from a blog post. They were read out of the SDA
 * binary itself (`Steam Desktop Authenticator.dll`, v1.0.15):
 *
 *  - `FileEncryptor`, `GetEncryptionKey`, `Rfc2898DeriveBytes`,
 *    `RijndaelManaged`, `CipherMode`, `PaddingMode` all present in metadata.
 *  - `50000` appears exactly once as an `ldc.i4` constant — `PBKDF2_ITERATIONS`.
 *  - `ldc.i4.s` operands `32` and `16` sit beside it: key size and IV length.
 *  - `runtimeconfig.json` targets **net8.0**, where the
 *    `Rfc2898DeriveBytes(string, byte[], int)` constructor still defaults to
 *    **HMAC-SHA1**. That default is the single most likely thing to be wrong if
 *    this ever fails to decrypt a real file, so it is called out here.
 *
 * ## What is still unverified
 *
 * The parameters are read from the binary; **the implementation has not been run
 * against a file SDA actually encrypted.** The tests below prove it is
 * self-consistent and that it fails cleanly, which is not the same thing. Until
 * a real encrypted maFile has been imported, treat this as unproven.
 *
 * ## The IV and salt are not in the maFile
 *
 * They live in `manifest.json`, per entry, keyed by filename. So importing an
 * encrypted maFile requires **both** files — which is why the import screen asks
 * for the folder rather than a single file.
 */

/** Read out of the SDA binary. See the note above before changing any of these. */
const PBKDF2_ITERATIONS = 50_000;
const KEY_BYTES = 32;
const IV_BYTES = 16;
/** `Rfc2898DeriveBytes`' default on .NET, including net8.0. */
const PBKDF2_DIGEST = 'sha1';

/** One entry in SDA's `manifest.json`. Only the fields decryption needs. */
export const sdaManifestEntrySchema = z.object({
	filename: z.string().min(1),
	encryption_iv: z.string().optional(),
	encryption_salt: z.string().optional()
});

/**
 * `entries` is **required**, and that is what makes a manifest identifiable.
 *
 * With it optional, every field had a default and so every JSON object on earth
 * parsed as a valid manifest — including a maFile. Identification then rested
 * entirely on the file being named `manifest.json`, which is a much weaker thing
 * to depend on than the structure itself.
 */
export const sdaManifestSchema = z.object({
	encrypted: z.boolean().optional(),
	entries: z.array(sdaManifestEntrySchema)
});

export type SdaManifest = z.infer<typeof sdaManifestSchema>;
export type SdaManifestEntry = z.infer<typeof sdaManifestEntrySchema>;

export class SdaDecryptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SdaDecryptError';
	}
}

/** Parse a `manifest.json`, or undefined if this is not one. */
export function parseSdaManifest(text: string): SdaManifest | undefined {
	try {
		const parsed = sdaManifestSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a file looks like SDA ciphertext rather than a maFile.
 *
 * A plaintext maFile is JSON and starts with `{`. An encrypted one is base64.
 * Checked by shape rather than by trusting the manifest's `encrypted` flag,
 * because a manifest can say `encrypted: true` while individual files are not,
 * and the file in front of us is the better authority on what it is.
 *
 * ## Why the length arithmetic
 *
 * "Is it base64?" on its own is far too generous — the word `nonsense` passes it.
 * A corrupt or truncated maFile would then be sorted into the encrypted pile and
 * the user asked for a passphrase that cannot exist, instead of being told their
 * file is damaged. The specific misdiagnosis a test caught.
 *
 * So the ciphertext's own structure decides: AES-CBC output is a whole number of
 * 16-byte blocks, and PKCS7 means there is always at least one. That rules out
 * essentially every scrap of prose while accepting every real encrypted maFile.
 */
export function looksEncrypted(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === '' || trimmed.startsWith('{')) {
		return false;
	}

	// SDA wraps its base64 across lines.
	const compact = trimmed.replace(/[\r\n]/g, '');
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
		return false;
	}

	const bytes = Buffer.from(compact, 'base64').length;
	return bytes >= 16 && bytes % 16 === 0;
}

/**
 * Decrypt one SDA maFile.
 *
 * Returns the plaintext JSON, which the ordinary maFile parser then reads — the
 * decryption is a layer in front of it, not a second parser.
 */
export function decryptSdaMaFile(options: {
	ciphertextBase64: string;
	passphrase: string;
	/** Base64, from the manifest entry. */
	ivBase64: string;
	/** Base64, from the manifest entry. */
	saltBase64: string;
}): string {
	const iv = Buffer.from(options.ivBase64, 'base64');
	const salt = Buffer.from(options.saltBase64, 'base64');

	if (iv.length !== IV_BYTES) {
		throw new SdaDecryptError(
			`the manifest gives a ${iv.length}-byte IV; SDA files use ${IV_BYTES}. This manifest may ` +
				'not match these files.'
		);
	}
	if (salt.length === 0) {
		throw new SdaDecryptError('the manifest has no encryption salt for this file');
	}

	const key = pbkdf2Sync(options.passphrase, salt, PBKDF2_ITERATIONS, KEY_BYTES, PBKDF2_DIGEST);

	let plaintext: string;
	let update: Buffer | undefined;
	let final: Buffer | undefined;
	let plaintextBytes: Buffer | undefined;
	try {
		const decipher = createDecipheriv('aes-256-cbc', key, iv);
		// PKCS7 is Node's default padding for CBC, and is what SDA writes.
		// `update` can return most of the plaintext before `final` rejects bad
		// padding. Retain each Buffer so both success and failure can wipe it.
		update = decipher.update(Buffer.from(options.ciphertextBase64.trim(), 'base64'));
		final = decipher.final();
		plaintextBytes = Buffer.allocUnsafe(update.length + final.length);
		update.copy(plaintextBytes, 0);
		final.copy(plaintextBytes, update.length);
		plaintext = plaintextBytes.toString('utf8');
	} catch {
		// **CBC is not authenticated**, so this is the *only* signal a wrong
		// passphrase gives — and it is not a reliable one. Roughly 1 in 256 wrong
		// passphrases produces valid-looking padding and decrypts to garbage
		// instead of throwing. The JSON check below is what actually catches those,
		// and it is why the recovery file this app writes uses GCM instead.
		throw new SdaDecryptError(
			'that passphrase did not decrypt this file. Check it, and check the manifest belongs to ' +
				'these maFiles.'
		);
	} finally {
		wipe(key);
		if (update !== undefined) wipe(update);
		if (final !== undefined) wipe(final);
		if (plaintextBytes !== undefined) wipe(plaintextBytes);
	}

	// The real integrity check, standing in for the authentication tag the format
	// does not have. Garbage from a wrong passphrase is overwhelmingly not JSON.
	if (!plaintext.trimStart().startsWith('{')) {
		throw new SdaDecryptError(
			'that passphrase decrypted the file into something that is not a maFile — it is almost ' +
				'certainly the wrong passphrase.'
		);
	}

	return plaintext;
}
