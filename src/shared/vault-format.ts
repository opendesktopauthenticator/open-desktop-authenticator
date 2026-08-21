import { z } from 'zod';

/**
 * The on-disk vault envelope (§10.3).
 *
 * This is a **file format**, which means every field here is a compatibility
 * commitment: anything that ships must still be readable years later, by a user
 * who has not updated in between and whose only copy of an authenticator lives
 * inside it. §24.3 requires founder sign-off to change any of it.
 *
 * The envelope is deliberately self-describing. Storing the KDF parameters
 * alongside the ciphertext means a future build can raise the work factor
 * without orphaning existing vaults — it reads the old parameters, derives the
 * old key, and re-seals with new ones.
 */

/** Bumped only for a breaking layout change, never for a parameter change. */
export const VAULT_FORMAT_VERSION = 1;

/**
 * scrypt parameters (§10.3).
 *
 * N=131072, r=8, p=1 costs 128 * N * r = 128 MiB per derivation, which is the
 * point: it makes offline guessing expensive for an attacker holding the file.
 * `maxmem` must exceed that or Node refuses to run.
 *
 * Q6 asks for a benchmark on low-end hardware before these are final. They are
 * read back from the file rather than assumed, so raising them later is a
 * migration rather than a break.
 */
export const SCRYPT_DEFAULTS = Object.freeze({
	N: 131072,
	r: 8,
	p: 1,
	/** 256 MiB. Must be greater than 128 * N * r. */
	maxmem: 256 * 1024 * 1024
});

/** 32 bytes. Anything shorter weakens the KDF for no saving. */
export const SALT_BYTES = 32;
/** 96 bits — the size AES-GCM is specified for. Never reuse one. */
export const NONCE_BYTES = 12;
/** 256-bit key. */
export const KEY_BYTES = 32;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be base64');

export const kdfSchema = z.object({
	type: z.literal('scrypt'),
	N: z.number().int().positive(),
	r: z.number().int().positive(),
	p: z.number().int().positive(),
	salt: base64
});

export const cipherSchema = z.object({
	type: z.literal('aes-256-gcm'),
	nonce: base64,
	tag: base64
});

export const envelopeSchema = z.object({
	version: z.number().int().positive(),
	kdf: kdfSchema,
	cipher: cipherSchema,
	ciphertext: base64,
	modifiedAt: z.string()
});

export type Kdf = z.infer<typeof kdfSchema>;
export type Cipher = z.infer<typeof cipherSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Refuse parameters weaker than we have ever shipped.
 *
 * Without this, an attacker who can write the vault file could rewrite `N` to 1,
 * and a later unlock would derive a trivially brute-forceable key. The GCM tag
 * would fail for the *current* passphrase — but the point of the check is to
 * refuse before spending any work on an obviously hostile file, and to make the
 * downgrade impossible rather than merely detectable.
 */
export const MINIMUM_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });

/**
 * Upper bounds, because the parameters come out of the *file*.
 *
 * A vault is opened before anything proves who wrote it, and scrypt's memory
 * cost is roughly `128 * N * r` bytes: a crafted envelope naming a huge `N`
 * turns "open this vault" into an allocation that freezes or kills the process
 * before the passphrase is ever checked. The minimums keep a weak file from
 * being quietly acceptable; these keep a hostile one from being expensive.
 * The ceiling clears the shipping defaults (`128 * 131072 * 8` = 128 MiB) by
 * 8x, so re-sealing at a raised work factor stays possible.
 */
const MAXIMUM_SCRYPT = Object.freeze({
	/** 2^21. With r at its own cap this stays within `maxmem` reach. */
	N: 2 ** 21,
	r: 32,
	p: 8,
	/** Bytes of scrypt working memory a file may demand: 1 GiB. */
	memory: 1024 * 1024 * 1024
});

export function isAcceptableKdf(kdf: Kdf): boolean {
	return (
		kdf.N >= MINIMUM_SCRYPT.N &&
		kdf.r >= MINIMUM_SCRYPT.r &&
		kdf.p >= MINIMUM_SCRYPT.p &&
		kdf.N <= MAXIMUM_SCRYPT.N &&
		kdf.r <= MAXIMUM_SCRYPT.r &&
		kdf.p <= MAXIMUM_SCRYPT.p &&
		// scrypt requires a power of two; Node throws on anything else, but a
		// refusal here names the file as the problem instead of surfacing an
		// internal crypto error for a vault that was never valid.
		Number.isInteger(Math.log2(kdf.N)) &&
		128 * kdf.N * kdf.r <= MAXIMUM_SCRYPT.memory
	);
}
