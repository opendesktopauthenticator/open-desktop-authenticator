import { createHmac } from 'node:crypto';

/**
 * Steam Guard code generation (§12 F4).
 *
 * This is Steam's variant of TOTP (RFC 6238): the same HMAC-SHA1 counter and
 * dynamic truncation, but the truncated value is rendered in base 26 over a
 * custom alphabet instead of as decimal digits.
 *
 * ## Why this is written out rather than imported
 *
 * `steam-totp` does exactly this and is trusted throughout the ecosystem. It is
 * still not imported here, for two reasons:
 *
 *  - This is the most security-critical computation in the product, and it is
 *    twenty lines. "Don't trust us, verify us" is easier to honour when the
 *    thing to verify is on one screen.
 *  - The library also reaches Steam's clock endpoint. Code generation is
 *    offline, and a module that can generate a code has no business being able
 *    to open a socket.
 *
 * Correctness is not asserted on those grounds alone: `spike/tests/totp-parity`
 * generates codes with both implementations across thousands of windows and
 * fails if they ever disagree.
 *
 * The alphabet, the window, and the truncation are Steam's; none of them are
 * ours to choose, and changing any of them produces codes Steam rejects.
 */

/** Steam's code alphabet. Digits and letters that cannot be misread aloud. */
const ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';

/** Steam Guard codes are five characters. */
const CODE_LENGTH = 5;

/** A code is valid for one thirty-second window. */
export const WINDOW_SECONDS = 30;

/** HMAC-SHA1 keys for Steam shared secrets are twenty bytes. */
const SECRET_BYTES = 20;

export class GuardCodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GuardCodeError';
	}
}

/**
 * A secret written as forty hex characters rather than base64.
 *
 * `steam-totp` accepts this form, so files in the wild use it and an importer
 * that did not would take such a file happily and then never produce a working
 * code. Anchored, unlike the reference implementation's unanchored test, so a
 * string that merely *contains* forty hex characters is not mistaken for one.
 */
const HEX_SECRET = /^[0-9a-f]{40}$/i;

/**
 * Decode a shared secret into HMAC key bytes.
 *
 * Base64 is validated by **re-encoding** rather than trusted, because
 * `Buffer.from(x, 'base64')` silently discards anything that is not base64. A
 * corrupted secret would otherwise decode to a shorter buffer and generate
 * confidently wrong codes forever — which the user experiences as Steam being
 * broken, with nothing pointing at the real cause.
 */
export function decodeSharedSecret(sharedSecret: string): Buffer {
	const trimmed = sharedSecret.trim();
	if (trimmed === '') {
		throw new GuardCodeError('this account has no shared secret stored');
	}

	if (HEX_SECRET.test(trimmed)) {
		return Buffer.from(trimmed, 'hex');
	}

	const decoded = Buffer.from(trimmed, 'base64');
	if (decoded.toString('base64') !== withPadding(trimmed)) {
		throw new GuardCodeError('the stored shared secret is not valid base64');
	}
	if (decoded.length !== SECRET_BYTES) {
		throw new GuardCodeError(
			`the stored shared secret is ${decoded.length} bytes; Steam's are ${SECRET_BYTES}`
		);
	}
	return decoded;
}

/** Whether a secret will produce codes at all. Used to refuse a useless import. */
export function isUsableSharedSecret(sharedSecret: string): boolean {
	try {
		decodeSharedSecret(sharedSecret);
		return true;
	} catch {
		return false;
	}
}

/** Normalise a base64 string to the padded form `Buffer.toString` emits. */
function withPadding(value: string): string {
	const remainder = value.length % 4;
	return remainder === 0 ? value : value + '='.repeat(4 - remainder);
}

/**
 * The code for a given moment.
 *
 * @param sharedSecret base64, as Steam issues it and as maFiles store it
 * @param unixSeconds  Steam-corrected time — see `CodeService` for the offset
 */
export function generateGuardCode(sharedSecret: string, unixSeconds: number): string {
	const key = decodeSharedSecret(sharedSecret);
	const counter = Math.floor(unixSeconds / WINDOW_SECONDS);

	// Eight-byte big-endian counter. Written as two 32-bit halves because the
	// counter is a JavaScript number, and `writeBigUInt64BE` would mean carrying
	// a BigInt through for a value that cannot reach 2^53 until the year 8.6
	// billion.
	const buffer = Buffer.alloc(8);
	buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
	buffer.writeUInt32BE(counter >>> 0, 4);

	const digest = createHmac('sha1', key).update(buffer).digest();

	// RFC 4226 dynamic truncation: the low nibble of the last byte picks the
	// four-byte window, and the top bit is masked off so the value is positive
	// regardless of how the platform reads a signed integer.
	const offset = (digest[digest.length - 1] as number) & 0x0f;
	let value = digest.readUInt32BE(offset) & 0x7fffffff;

	let code = '';
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += ALPHABET[value % ALPHABET.length];
		value = Math.floor(value / ALPHABET.length);
	}
	return code;
}

/**
 * Seconds left in the current window. Always between 1 and 30.
 *
 * JavaScript's `%` keeps the sign of its left operand, so a negative time
 * produced 31–35 and `NaN` produced `NaN` — both of which reach the UI as a
 * countdown that cannot be true. A time before 1970 is nonsense rather than a
 * case to support, so it is clamped rather than propagated.
 */
export function secondsRemaining(unixSeconds: number): number {
	if (!Number.isFinite(unixSeconds)) {
		return WINDOW_SECONDS;
	}
	const seconds = Math.max(0, Math.floor(unixSeconds));
	return WINDOW_SECONDS - (seconds % WINDOW_SECONDS);
}
