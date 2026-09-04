import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scrypt as scryptCallback,
	timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';
import {
	envelopeSchema,
	isAcceptableKdf,
	KEY_BYTES,
	NONCE_BYTES,
	SALT_BYTES,
	SCRYPT_DEFAULTS,
	VAULT_FORMAT_VERSION,
	type Envelope,
	type Kdf
} from '../../shared/vault-format';

/**
 * Vault encryption (§11 S7).
 *
 * Node built-ins only — scrypt and AES-256-GCM. No home-rolled primitives, no
 * native modules, no ECB/CBC, no static nonces, and no key reused across
 * purposes.
 *
 * `scrypt` is used asynchronously throughout. The synchronous form blocks the
 * event loop for roughly a second at these parameters, which in the main process
 * means the whole UI freezes on every unlock — and the natural "fix" for a frozen
 * UI is to lower the work factor, which is exactly the wrong outcome.
 */

const scrypt = promisify(scryptCallback) as (
	password: string | Buffer,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

export class VaultCryptoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VaultCryptoError';
	}
}

/**
 * Derive the vault key from a passphrase.
 *
 * The returned Buffer is live key material. Call `wipe` on it once the caller is
 * finished; see the honesty note there about what that does and does not achieve.
 */
export async function deriveKey(passphrase: string, salt: Buffer, kdf: Kdf): Promise<Buffer> {
	if (!isAcceptableKdf(kdf)) {
		// "Outside the acceptable range", not "weaker": the bounds now cut both
		// ways, and the dangerous direction is a *crafted* file demanding enough
		// scrypt memory to freeze the process before the passphrase is checked.
		throw new VaultCryptoError(
			`refusing KDF parameters outside the acceptable range (N=${kdf.N}, r=${kdf.r}, p=${kdf.p})`
		);
	}
	// maxmem is not stored in the file: it is a local execution limit, not a
	// property of the ciphertext. Derived from the file's own parameters so a
	// vault sealed with a higher N still opens.
	const maxmem = Math.max(SCRYPT_DEFAULTS.maxmem, 256 * kdf.N * kdf.r);
	return scrypt(passphrase, salt, KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem });
}

/**
 * Best-effort erasure of key material.
 *
 * Honest about its limits: this zeroes the bytes of *this* Buffer. It cannot
 * reach copies the runtime may have made, and it cannot touch the passphrase
 * itself — JavaScript strings are immutable and live until GC. Anything that
 * needs stronger guarantees than this is outside our threat model (§4: an
 * attacker reading our memory while unlocked is not defended against).
 */
export function wipe(secret: Buffer): void {
	secret.fill(0);
}

/**
 * The header fields bound to the ciphertext as additional authenticated data.
 *
 * Binding matters: without it, the KDF parameters and the format version are
 * unauthenticated, so a ciphertext could be transplanted between envelopes
 * describing different parameters. With it, any edit to the header invalidates
 * the tag and the file is rejected before a single byte of plaintext is exposed.
 *
 * The AAD is derived from the envelope, never stored, so this does not change
 * the file layout.
 */
function additionalData(version: number, kdf: Kdf, nonceB64: string): Buffer {
	return Buffer.from(
		JSON.stringify({
			version,
			kdf: { type: kdf.type, N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
			nonce: nonceB64
		}),
		'utf8'
	);
}

/** Work factor for a new seal. Omit for the shipping defaults. */
export interface SealParams {
	N: number;
	r: number;
	p: number;
}

/**
 * Encrypt a plaintext document into a fresh envelope.
 *
 * `params` exists for two real reasons, not as a test hook: re-sealing an
 * existing vault at a raised work factor when the defaults change, and
 * benchmarking (Q6). Tests use it to avoid spending a second of scrypt per
 * assertion — a suite that takes a minute is a suite people stop running, and
 * the parameters themselves are asserted separately.
 */
export async function seal(
	plaintext: string,
	passphrase: string,
	params: SealParams = SCRYPT_DEFAULTS
): Promise<Envelope> {
	const salt = randomBytes(SALT_BYTES);
	const kdf: Kdf = {
		type: 'scrypt',
		N: params.N,
		r: params.r,
		p: params.p,
		salt: salt.toString('base64')
	};

	const key = await deriveKey(passphrase, salt, kdf);
	try {
		return sealWithKey(plaintext, key, kdf);
	} finally {
		wipe(key);
	}
}

/**
 * Seal using an already-derived key and the vault's existing KDF parameters.
 *
 * This is what makes saving cheap. The salt belongs to the vault, not to an
 * individual write, so it stays fixed and the key can be derived once at unlock —
 * §10.3 requires a fresh **nonce** per write, not a fresh salt.
 *
 * The security consequence is a good one: the running app holds the derived key
 * rather than the passphrase, so the passphrase exists in memory only for the
 * moments around an unlock.
 *
 * A new salt IS generated on passphrase change, where re-deriving is the point.
 */
export function sealWithKey(plaintext: string, key: Buffer, kdf: Kdf): Envelope {
	const bytes = Buffer.from(plaintext, 'utf8');
	try {
		return sealBytesWithKey(bytes, key, kdf);
	} finally {
		wipe(bytes);
	}
}

/** Encrypt bytes without first copying them through an immutable JavaScript string. */
export function sealBytesWithKey(plaintext: Buffer, key: Buffer, kdf: Kdf): Envelope {
	if (key.length !== KEY_BYTES) {
		throw new VaultCryptoError('the vault key is the wrong length');
	}

	// A fresh nonce on every single write. Reusing one under the same key breaks
	// GCM catastrophically — it leaks the XOR of both plaintexts AND the
	// authentication key, which is why the salt may be stable but this never is.
	const nonce = randomBytes(NONCE_BYTES);
	const nonceB64 = nonce.toString('base64');

	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	cipher.setAAD(additionalData(VAULT_FORMAT_VERSION, kdf, nonceB64));

	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

	return {
		version: VAULT_FORMAT_VERSION,
		kdf,
		cipher: {
			type: 'aes-256-gcm',
			nonce: nonceB64,
			tag: cipher.getAuthTag().toString('base64')
		},
		ciphertext: ciphertext.toString('base64'),
		modifiedAt: new Date().toISOString()
	};
}

/** Decrypt bytes so short-lived key material can be explicitly wiped by its owner. */
export function openBytesWithKey(envelope: unknown, key: Buffer, expectedKdf: Kdf): Buffer {
	const parsed = envelopeSchema.safeParse(envelope);
	if (!parsed.success) {
		throw new VaultCryptoError('the encrypted recovery record is not a valid envelope');
	}
	const env = parsed.data;
	if (env.version > VAULT_FORMAT_VERSION) {
		throw new VaultCryptoError('the encrypted recovery record needs a newer version');
	}
	if (key.length !== KEY_BYTES) {
		throw new VaultCryptoError('the vault key is the wrong length');
	}
	// The key and KDF salt are one pair. Accepting an envelope naming another KDF
	// would at best fail its tag and at worst turn a format mistake into a silent
	// dependency on unauthenticated caller state.
	if (JSON.stringify(env.kdf) !== JSON.stringify(expectedKdf)) {
		throw new VaultCryptoError('the encrypted recovery record belongs to another vault key');
	}

	const nonce = Buffer.from(env.cipher.nonce, 'base64');
	const tag = Buffer.from(env.cipher.tag, 'base64');
	if (nonce.length !== NONCE_BYTES || tag.length !== 16) {
		throw new VaultCryptoError('the encrypted recovery record has malformed cipher parameters');
	}
	let update: Buffer | undefined;
	let final: Buffer | undefined;
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, nonce);
		decipher.setAAD(additionalData(env.version, env.kdf, env.cipher.nonce));
		decipher.setAuthTag(tag);
		/*
		 * `update` may return unauthenticated plaintext before `final` verifies the
		 * GCM tag. Keep both intermediates reachable so a bad tag does not leave a
		 * workflow content key in an abandoned Buffer until garbage collection.
		 */
		update = decipher.update(Buffer.from(env.ciphertext, 'base64'));
		final = decipher.final();
		const plaintext = Buffer.allocUnsafe(update.length + final.length);
		update.copy(plaintext, 0);
		final.copy(plaintext, update.length);
		return plaintext;
	} catch {
		throw new VaultCryptoError(
			'could not decrypt the recovery record: wrong vault or damaged file'
		);
	} finally {
		if (update !== undefined) wipe(update);
		if (final !== undefined) wipe(final);
	}
}

/**
 * Decrypt an envelope.
 *
 * Throws `VaultCryptoError` for a wrong passphrase and for a tampered file
 * alike. That is deliberate: distinguishing them would tell an attacker holding
 * the file which of the two they achieved.
 */
export async function open(envelope: unknown, passphrase: string): Promise<string> {
	const result = await unseal(envelope, passphrase);
	try {
		return result.plaintext;
	} finally {
		wipe(result.key);
	}
}

/** A successful unseal, including the key so a session can keep saving cheaply. */
export interface Unsealed {
	plaintext: string;
	/**
	 * The derived key. **The caller owns wiping this.** It is returned rather
	 * than discarded so a running session can re-seal without the passphrase.
	 */
	key: Buffer;
	/** The vault's KDF parameters, needed to seal again with the same salt. */
	kdf: Kdf;
}

/**
 * Decrypt an envelope and hand back the key with it.
 *
 * Use `open` when you only want the plaintext; this exists for the vault
 * session, which needs to write again later without asking for the passphrase.
 */
export async function unseal(envelope: unknown, passphrase: string): Promise<Unsealed> {
	const parsed = envelopeSchema.safeParse(envelope);
	if (!parsed.success) {
		throw new VaultCryptoError('the vault file is not a valid envelope');
	}
	const env = parsed.data;

	if (env.version > VAULT_FORMAT_VERSION) {
		throw new VaultCryptoError(
			`this vault was written by a newer version (format ${env.version}); ` +
				'upgrade rather than risk writing it back in an older layout'
		);
	}
	// No runtime cipher check here: `envelopeSchema` types `cipher.type` as the
	// literal 'aes-256-gcm', so a mismatch is rejected during parsing above and a
	// second check is unreachable. Lint caught it as dead code. When a second
	// cipher is ever supported, the schema becomes a union and the branch comes
	// back with something to discriminate.

	const salt = Buffer.from(env.kdf.salt, 'base64');
	const nonce = Buffer.from(env.cipher.nonce, 'base64');
	const tag = Buffer.from(env.cipher.tag, 'base64');

	// Length checks before any expensive work. A short nonce or salt means the
	// file is malformed or crafted, and either way is not worth a second of scrypt.
	if (salt.length !== SALT_BYTES) {
		throw new VaultCryptoError('the vault file has a malformed salt');
	}
	if (nonce.length !== NONCE_BYTES) {
		throw new VaultCryptoError('the vault file has a malformed nonce');
	}
	if (tag.length !== 16) {
		throw new VaultCryptoError('the vault file has a malformed authentication tag');
	}

	const key = await deriveKey(passphrase, salt, env.kdf);
	let update: Buffer | undefined;
	let final: Buffer | undefined;
	let plaintext: Buffer | undefined;
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, nonce);
		decipher.setAAD(additionalData(env.version, env.kdf, env.cipher.nonce));
		decipher.setAuthTag(tag);

		/*
		 * GCM does not authenticate the bytes returned by `update`: only `final`
		 * verifies the tag. Keep that partial plaintext reachable so a damaged tag
		 * cannot leave the complete vault document in an abandoned Buffer.
		 */
		update = decipher.update(Buffer.from(env.ciphertext, 'base64'));
		// Throws if the tag does not verify — this is the integrity check.
		final = decipher.final();
		plaintext = Buffer.allocUnsafe(update.length + final.length);
		update.copy(plaintext, 0);
		final.copy(plaintext, update.length);
		return { plaintext: plaintext.toString('utf8'), key, kdf: env.kdf };
	} catch (err) {
		// The key is only wiped on failure. On success the caller owns it.
		wipe(key);
		if (err instanceof VaultCryptoError) {
			throw err;
		}
		// Same message for a wrong passphrase and for tampering, deliberately.
		throw new VaultCryptoError('could not decrypt the vault: wrong passphrase or damaged file');
	} finally {
		if (update !== undefined) wipe(update);
		if (final !== undefined) wipe(final);
		if (plaintext !== undefined) wipe(plaintext);
	}
}

/**
 * Constant-time comparison, for anywhere a secret is checked against a value an
 * attacker can influence.
 */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}
