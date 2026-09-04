import { createHash, createHmac } from 'node:crypto';
import { decodeSharedSecret, GuardCodeError } from '../codes/totp';

/**
 * Mobile confirmation keys and device identifiers (§12 F5).
 *
 * Every mobileconf request carries a fresh HMAC over the identity secret, the
 * current Steam-corrected time, and a **tag** naming the operation. The tag is
 * load-bearing: a key minted for listing confirmations will not authorise
 * accepting one, which is the property that stops a captured list request from
 * being replayed as an approval.
 *
 * Written out for the same reasons as `codes/totp.ts` (D13): it is twenty lines
 * of HMAC, it is the authorisation on an operation that can move somebody's
 * inventory, and a reader should be able to check it without auditing a package.
 * `spike/tests/confirmation-key-parity.test.ts` compares it against `steam-totp`
 * across thousands of times and tags.
 *
 * Main-process only. A confirmation key is a bearer credential for one
 * operation; it has no business in the renderer.
 */

/**
 * Operation tags, exactly as the current official mobile app sends them.
 *
 * `steam-totp` and `steamcommunity` also accept the older `conf` / `allow` /
 * `cancel` spellings for backwards compatibility. We send only the modern ones —
 * looking like the current app is the point, and an app that identifies itself
 * as a 2016 client is a distinguishable one.
 */
export const CONFIRMATION_TAGS = {
	/** Fetch the pending list. */
	list: 'list',
	/** Fetch details for one confirmation. */
	details: 'detail',
	/** Approve. */
	accept: 'accept',
	/** Deny. */
	reject: 'reject'
} as const;

export type ConfirmationTag = (typeof CONFIRMATION_TAGS)[keyof typeof CONFIRMATION_TAGS];

/**
 * Steam truncates the tag at 32 bytes when building the buffer. Longer tags are
 * not an error, they are simply cut — so the limit is applied here rather than
 * discovered as a signature that silently stops matching.
 */
const MAX_TAG_BYTES = 32;

export class ConfirmationKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfirmationKeyError';
	}
}

/**
 * A base64 confirmation key, valid for one operation at one moment.
 *
 * @param identitySecret base64 or hex, as stored in the vault
 * @param unixSeconds    Steam-corrected time — the same clock the codes use
 * @param tag            what the key authorises
 */
export function generateConfirmationKey(
	identitySecret: string,
	unixSeconds: number,
	tag: ConfirmationTag
): string {
	// Same shape and rules as the shared secret — but the error must name the
	// *identity* secret. Bubbling GuardCodeError verbatim told the user their
	// shared secret was broken when confirmations failed, which sends them
	// repairing the wrong field.
	const key = decodeIdentitySecret(identitySecret);
	let tagBytes: Buffer | undefined;
	let buffer: Buffer | undefined;
	let digest: Buffer | undefined;
	try {
		if (!Number.isFinite(unixSeconds) || unixSeconds < 0) {
			throw new ConfirmationKeyError('cannot sign a confirmation for a nonsensical time');
		}

		tagBytes = Buffer.from(tag, 'utf8');
		if (tagBytes.length === 0) {
			throw new ConfirmationKeyError('a confirmation key must name the operation it authorises');
		}

		const used = Math.min(tagBytes.length, MAX_TAG_BYTES);
		buffer = Buffer.alloc(8 + used);
		// Big-endian 64-bit time. Written as two halves for the same reason as the
		// TOTP counter: the value is a JavaScript number and cannot reach 2^53.
		buffer.writeUInt32BE(Math.floor(unixSeconds / 2 ** 32), 0);
		buffer.writeUInt32BE(Math.floor(unixSeconds) >>> 0, 4);
		tagBytes.copy(buffer, 8, 0, used);

		digest = createHmac('sha1', key).update(buffer).digest();
		return digest.toString('base64');
	} finally {
		key.fill(0);
		tagBytes?.fill(0);
		buffer?.fill(0);
		digest?.fill(0);
	}
}

/** Decode an identity secret, naming it correctly in any refusal. */
function decodeIdentitySecret(identitySecret: string): Buffer {
	try {
		return decodeSharedSecret(identitySecret);
	} catch (err) {
		if (err instanceof GuardCodeError) {
			throw new ConfirmationKeyError(
				err.message
					.replaceAll('shared secret', 'identity secret')
					.replaceAll('Shared secret', 'Identity secret')
			);
		}
		throw err;
	}
}

/**
 * The `device_id` Steam expects alongside a confirmation request.
 *
 * Derived from the SteamID, not stored — F-02 established that Steam does not
 * validate it and that the value inside an imported maFile is kept only for
 * export fidelity. Deriving it means an account imported from a file that never
 * had one behaves identically to one that did.
 *
 * The format is `android:` plus a SHA-1 of the SteamID rendered as a UUID.
 */
export function deviceIdFor(steamId64: string): string {
	if (!/^\d{5,25}$/.test(steamId64)) {
		throw new ConfirmationKeyError('a device id needs a SteamID made of digits');
	}

	const digest = createHash('sha1').update(steamId64).digest('hex');
	const uuid = [
		digest.slice(0, 8),
		digest.slice(8, 12),
		digest.slice(12, 16),
		digest.slice(16, 20),
		digest.slice(20, 32)
	].join('-');

	return `android:${uuid}`;
}
