import { describe, expect, it } from 'vitest';
import {
	CONTINUE_VERSION,
	decodeContinueResponse,
	encodeContinueRequest
} from '../src/main/steam/transfer-proto';

/*
 * The wire format of the call that rotates an authenticator.
 *
 * This is the one request in the application whose bytes cannot be checked
 * against reality without spending somebody's authenticator, so they are
 * checked against a known vector instead. Everything else here follows from
 * getting those eleven bytes right.
 */

/** sms_code "12345", generate_new_token true, version 2. */
const VECTOR = Buffer.from([0x0a, 0x05, 0x31, 0x32, 0x33, 0x34, 0x35, 0x10, 0x01, 0x18, 0x02]);

describe('the request that replaces an authenticator', () => {
	it('encodes to the known vector', () => {
		expect(encodeContinueRequest('12345').equals(VECTOR)).toBe(true);
	});

	it('encodes to the known base64', () => {
		expect(encodeContinueRequest('12345').toString('base64')).toBe('CgUxMjM0NRABGAI=');
	});

	/*
	 * The schema's default for `version` is 1 and Valve's client sends 2. A field
	 * left to its default is not serialised at all, so relying on it would send
	 * neither — this asserts the byte is physically present.
	 */
	it('writes the version explicitly rather than leaning on the default', () => {
		const encoded = encodeContinueRequest('12345');
		expect(CONTINUE_VERSION).toBe(2);
		expect([...encoded]).toContain(0x18);
		expect(encoded[encoded.length - 1]).toBe(CONTINUE_VERSION);
	});

	/*
	 * Without generate_new_token, Steam removes the authenticator and issues
	 * nothing back. That is the fifteen-day path and an account left with no
	 * second factor, so the flag is hardcoded and there is no way to unset it.
	 */
	it('always asks for a replacement token', () => {
		for (const code of ['12345', '00000', 'ABCDE']) {
			const bytes = [...encodeContinueRequest(code)];
			const flag = bytes.indexOf(0x10);
			expect(flag).toBeGreaterThan(-1);
			expect(bytes[flag + 1]).toBe(1);
		}
	});

	it('carries the code it was given', () => {
		expect(encodeContinueRequest('99887').toString('latin1')).toContain('99887');
	});
});

describe('decoding what Steam sends back', () => {
	/**
	 * A response built by hand, so the test does not depend on the encoder it is
	 * checking. Field 2 is the replacement token; the inner fields are the ones
	 * the account model needs.
	 */
	function response(): Buffer {
		const token = Buffer.concat([
			// shared_secret (bytes, field 1)
			Buffer.from([0x0a, 0x04, 0xde, 0xad, 0xbe, 0xef]),
			// serial_number (fixed64, field 2) — larger than Number.MAX_SAFE_INTEGER
			Buffer.from([0x11, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00]),
			// revocation_code (string, field 3)
			Buffer.from([0x1a, 0x06]),
			Buffer.from('R12345', 'utf8'),
			// identity_secret (bytes, field 8)
			Buffer.from([0x42, 0x03, 0x01, 0x02, 0x03]),
			// steamid (fixed64, field 12) = 76561198000000001
			(() => {
				const b = Buffer.alloc(9);
				b[0] = 0x61;
				b.writeBigUInt64LE(76561198000000001n, 1);
				return b;
			})()
		]);
		return Buffer.concat([
			Buffer.from([0x08, 0x01]), // success = true
			Buffer.from([0x12, token.length]),
			token
		]);
	}

	it('reads success and the replacement token', () => {
		const result = decodeContinueResponse(response());
		expect(result.success).toBe(true);
		expect(result.replacementToken).toBeDefined();
	});

	it('turns byte secrets into base64', () => {
		const token = decodeContinueResponse(response()).replacementToken;
		expect(token?.sharedSecret).toBe(Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'));
		expect(token?.identitySecret).toBe(Buffer.from([0x01, 0x02, 0x03]).toString('base64'));
	});

	/*
	 * A SteamID is larger than a JavaScript number can hold exactly. Read as one
	 * it comes back rounded, and a SteamID wrong in its last digits looks
	 * entirely plausible — it just belongs to nobody.
	 */
	it('keeps 64-bit values exact', () => {
		const token = decodeContinueResponse(response()).replacementToken;
		expect(token?.steamId64).toBe('76561198000000001');
		expect(token?.serialNumber).toBe('9007199254740991');
	});

	it('reads the revocation code', () => {
		expect(decodeContinueResponse(response()).replacementToken?.revocationCode).toBe('R12345');
	});

	it('omits fields Steam did not send rather than inventing them', () => {
		const token = decodeContinueResponse(response()).replacementToken;
		expect(token?.uri).toBeUndefined();
		expect(token?.tokenGid).toBeUndefined();
	});

	it('reports a refusal that carries no token', () => {
		const result = decodeContinueResponse(Buffer.from([0x08, 0x00]));
		expect(result.success).toBe(false);
		expect(result.replacementToken).toBeUndefined();
	});

	/*
	 * "I could not read the reply" must never be mistaken for "it did not
	 * happen": by this point Steam may already have rotated the authenticator.
	 */
	it('throws on a body that is not this message', () => {
		expect(() => decodeContinueResponse(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toThrow();
	});
});
