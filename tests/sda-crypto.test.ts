import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	decryptSdaMaFile,
	looksEncrypted,
	parseSdaManifest,
	SdaDecryptError
} from '../src/main/import/sda-crypto';

/**
 * Reading SDA's encrypted maFiles (§12 F2).
 *
 * ## What these tests can and cannot prove
 *
 * The fixtures below are encrypted **by this test file**, with the parameters
 * read out of the SDA binary. So a passing round-trip proves the decryptor is
 * self-consistent with those parameters — it does **not** prove the parameters
 * match what SDA actually writes. Nothing available here can prove that; only
 * importing a file a real SDA install encrypted can, and until that has happened
 * this feature is unverified.
 *
 * Saying so plainly matters, because a green suite here would otherwise read as
 * "SDA import works" when what it means is "the arithmetic is consistent".
 *
 * One test does better than self-consistency: the RFC 6070 vector pins the KDF
 * to genuine PBKDF2-HMAC-SHA1 against a value published by somebody else. If a
 * real SDA file ever fails to decrypt, that test rules the primitive out and
 * leaves the iteration count, the salt handling, or the cipher mode as the
 * suspects — which is most of the value a debugging session would otherwise have
 * to establish from scratch.
 */

/** The parameters read from the binary, restated so a drift in either shows up. */
const ITERATIONS = 50_000;
const KEY_BYTES = 32;

/**
 * Written as raw text, not built with `JSON.stringify`.
 *
 * The SteamID has to survive as an unquoted number with all seventeen digits
 * intact, which is what SDA writes and what F-01 is about — and a JS number
 * literal cannot hold it. Lint said so, which is the same rule catching the same
 * mistake it caught in the maFile exporter.
 */
const PLAINTEXT = [
	'{"shared_secret":"ASNFZ4mrze8BI0VniavN7wEjRWc=",',
	'"identity_secret":"/ty6mHZUMhD+3LqYdlQyEP7cupg=",',
	'"account_name":"trader","revocation_code":"R12345",',
	'"Session":{"SteamID":76561198000000001}}'
].join('');

/** Encrypt the way SDA is understood to. The other half of the round trip. */
function sdaEncrypt(plaintext: string, passphrase: string, salt: Buffer, iv: Buffer): string {
	const key = pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_BYTES, 'sha1');
	const cipher = createCipheriv('aes-256-cbc', key, iv);
	return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

function fixture(passphrase = 'correct horse battery staple'): {
	ciphertextBase64: string;
	ivBase64: string;
	saltBase64: string;
	passphrase: string;
} {
	const salt = randomBytes(8);
	const iv = randomBytes(16);
	return {
		ciphertextBase64: sdaEncrypt(PLAINTEXT, passphrase, salt, iv),
		ivBase64: iv.toString('base64'),
		saltBase64: salt.toString('base64'),
		passphrase
	};
}

describe('the key derivation', () => {
	it('is genuinely PBKDF2-HMAC-SHA1, per RFC 6070', () => {
		// Not our own arithmetic checked against itself. This is the published
		// vector from RFC 6070 §2, and it fails if the digest is ever changed to
		// SHA-256 — the single likeliest way this whole feature could be wrong,
		// since .NET's `Rfc2898DeriveBytes` picks SHA1 only by default.
		const derived = pbkdf2Sync('password', Buffer.from('salt'), 4096, 20, 'sha1');

		expect(derived.toString('hex')).toBe('4b007901b765489abead49d926f721d065a429c1');
	});
});

describe('decrypting an SDA maFile', () => {
	it('recovers the exact plaintext', () => {
		const file = fixture();

		expect(decryptSdaMaFile(file)).toBe(PLAINTEXT);
	});

	it('recovers a file whose base64 is wrapped across lines', () => {
		// SDA writes wrapped base64. An implementation that only handled one long
		// line would fail on every real file while passing every synthetic one.
		const file = fixture();
		const wrapped = (file.ciphertextBase64.match(/.{1,64}/g) ?? []).join('\r\n');

		expect(decryptSdaMaFile({ ...file, ciphertextBase64: wrapped })).toBe(PLAINTEXT);
	});

	it('refuses a wrong passphrase instead of returning garbage', () => {
		const file = fixture();

		expect(() => decryptSdaMaFile({ ...file, passphrase: 'wrong' })).toThrow(SdaDecryptError);
	});

	it('refuses a wrong passphrase even when the padding happens to be valid', () => {
		// CBC is unauthenticated, so roughly 1 in 256 wrong passphrases decrypts
		// without a padding error and yields garbage. The JSON check is what catches
		// those, and it is the only thing standing between a user and an "imported"
		// account made of noise. Searched for rather than asserted abstractly,
		// because the case is real and rare enough to be missed by chance.
		const file = fixture();
		let found = false;

		for (let attempt = 0; attempt < 3000 && !found; attempt += 1) {
			try {
				decryptSdaMaFile({ ...file, passphrase: `wrong-${attempt}` });
				throw new Error('a wrong passphrase produced an accepted result');
			} catch (err) {
				if (!(err instanceof SdaDecryptError)) {
					throw err;
				}
				// The message differs between "padding failed" and "decrypted to
				// something that is not a maFile". The second one is the case being
				// hunted: padding passed, and only the JSON check refused it.
				if (/not a maFile/.test(err.message)) {
					found = true;
				}
			}
		}

		expect(found).toBe(true);
	});

	it('explains a mismatched manifest rather than failing obscurely', () => {
		const file = fixture();

		expect(() =>
			decryptSdaMaFile({ ...file, ivBase64: Buffer.alloc(8).toString('base64') })
		).toThrow(/16/);
	});

	it('refuses when the manifest carries no salt for the file', () => {
		const file = fixture();

		expect(() => decryptSdaMaFile({ ...file, saltBase64: '' })).toThrow(/salt/);
	});

	it('never puts the passphrase into the error it throws', () => {
		// These messages reach the renderer and the activity log.
		const file = fixture();
		const secret = 'hunter2-the-actual-password';

		const message = (() => {
			try {
				decryptSdaMaFile({ ...file, passphrase: secret });
				return '';
			} catch (err) {
				return (err as Error).message;
			}
		})();

		expect(message).not.toBe('');
		expect(message).not.toContain(secret);
	});
});

describe('telling an encrypted file from a broken one', () => {
	it('recognises real ciphertext', () => {
		expect(looksEncrypted(fixture().ciphertextBase64)).toBe(true);
	});

	it('recognises wrapped ciphertext', () => {
		const base64 = fixture().ciphertextBase64;
		expect(looksEncrypted((base64.match(/.{1,64}/g) ?? []).join('\n'))).toBe(true);
	});

	it('does not mistake a plaintext maFile for ciphertext', () => {
		expect(looksEncrypted(PLAINTEXT)).toBe(false);
		// The BOM SDA sometimes writes, named rather than typed — the literal
		// character is invisible in every editor, which is how it becomes a mystery
		// later. `parseMaFile` strips it; `looksEncrypted` must see past it too, or a
		// perfectly good maFile gets sorted into the encrypted pile.
		expect(looksEncrypted(String.fromCharCode(0xfeff) + PLAINTEXT)).toBe(false);
	});

	it('does not mistake a damaged file for ciphertext', () => {
		// The regression this rule exists for. A base64-shaped test alone passes the
		// word "nonsense", and the user is then asked for a passphrase that cannot
		// exist instead of being told their file is damaged.
		expect(looksEncrypted('nonsense')).toBe(false);
		expect(looksEncrypted('not a maFile at all')).toBe(false);
		expect(looksEncrypted('')).toBe(false);
		expect(looksEncrypted('   ')).toBe(false);
	});

	it('rejects base64 that is not a whole number of AES blocks', () => {
		// AES-CBC output is always a multiple of 16 bytes, so this cannot be one.
		expect(looksEncrypted(Buffer.alloc(20).toString('base64'))).toBe(false);
		expect(looksEncrypted(Buffer.alloc(0).toString('base64'))).toBe(false);
		expect(looksEncrypted(Buffer.alloc(16).toString('base64'))).toBe(true);
	});
});

describe('reading the manifest', () => {
	it('reads the IV and salt for each entry', () => {
		const manifest = parseSdaManifest(
			JSON.stringify({
				encrypted: true,
				entries: [
					{
						filename: '76561198000000001.maFile',
						encryption_iv: 'aXY=',
						encryption_salt: 'c2FsdA=='
					}
				]
			})
		);

		expect(manifest?.entries[0]?.filename).toBe('76561198000000001.maFile');
		expect(manifest?.entries[0]?.encryption_iv).toBe('aXY=');
	});

	it('does not treat a maFile as a manifest', () => {
		// `entries` is required for exactly this reason. With every field optional,
		// any JSON object parsed as a valid manifest — including the maFiles the
		// manifest is supposed to describe.
		expect(parseSdaManifest(PLAINTEXT)).toBeUndefined();
	});

	it('reads a manifest from an unencrypted install without inventing parameters', () => {
		const manifest = parseSdaManifest(
			JSON.stringify({ encrypted: false, entries: [{ filename: 'a.maFile' }] })
		);

		expect(manifest?.entries[0]?.encryption_iv).toBeUndefined();
	});

	it('returns undefined for anything that is not JSON', () => {
		expect(parseSdaManifest('nonsense')).toBeUndefined();
		expect(parseSdaManifest('')).toBeUndefined();
	});
});
