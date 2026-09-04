import { describe, expect, it } from 'vitest';
import {
	deriveKey,
	open,
	openBytesWithKey,
	seal,
	VaultCryptoError,
	wipe
} from '../src/main/vault/crypto';
import {
	isAcceptableKdf,
	MINIMUM_SCRYPT,
	NONCE_BYTES,
	SALT_BYTES,
	SCRYPT_DEFAULTS,
	VAULT_FORMAT_VERSION,
	type Envelope
} from '../src/shared/vault-format';

/**
 * The vault's crypto is the one part of this project where a bug is
 * unrecoverable: the data it protects cannot be rotated without removing the
 * user's authenticator entirely.
 *
 * Most tests run at a reduced work factor so the suite stays fast enough to
 * actually be run. The shipping parameters are asserted separately, and one
 * end-to-end test uses them for real.
 */
/**
 * The lowest work factor the implementation will accept — deliberately not
 * lower. An earlier version of this file used N=1024 and every test failed,
 * because `deriveKey` refuses anything below `MINIMUM_SCRYPT`. That guard is the
 * point, so the tests run at the floor rather than weakening it to suit them.
 */
const FAST = { N: MINIMUM_SCRYPT.N, r: MINIMUM_SCRYPT.r, p: MINIMUM_SCRYPT.p };
const PASS = 'correct horse battery staple';

const clone = (e: Envelope): Envelope => JSON.parse(JSON.stringify(e)) as Envelope;

describe('round trip', () => {
	it('returns exactly what was sealed', async () => {
		const sealed = await seal('{"hello":"world"}', PASS, FAST);
		expect(await open(sealed, PASS)).toBe('{"hello":"world"}');
	});

	it('survives unicode and emoji without corruption', async () => {
		const text = '{"note":"pässwörd — 日本語 🔐 \\u0000 embedded"}';
		const sealed = await seal(text, PASS, FAST);
		expect(await open(sealed, PASS)).toBe(text);
	});

	it('handles an empty document', async () => {
		const sealed = await seal('', PASS, FAST);
		expect(await open(sealed, PASS)).toBe('');
	});

	it('handles a passphrase with unicode and whitespace', async () => {
		const pass = '  çafé — 日本語 passphrase  ';
		const sealed = await seal('x', pass, FAST);
		expect(await open(sealed, pass)).toBe('x');
		await expect(open(sealed, pass.trim())).rejects.toThrow(VaultCryptoError);
	});
});

describe('nonce and salt uniqueness', () => {
	it('never reuses a nonce or salt across seals', async () => {
		// Nonce reuse under one key breaks GCM catastrophically: it leaks the XOR
		// of both plaintexts AND the authentication key.
		const rounds = 12;
		const nonces = new Set<string>();
		const salts = new Set<string>();
		for (let i = 0; i < rounds; i++) {
			const e = await seal('same plaintext', PASS, FAST);
			nonces.add(e.cipher.nonce);
			salts.add(e.kdf.salt);
		}
		expect(nonces.size).toBe(rounds);
		expect(salts.size).toBe(rounds);
	});

	it('produces different ciphertext for identical input', async () => {
		const a = await seal('same', PASS, FAST);
		const b = await seal('same', PASS, FAST);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it('uses the specified sizes', async () => {
		const e = await seal('x', PASS, FAST);
		expect(Buffer.from(e.kdf.salt, 'base64')).toHaveLength(SALT_BYTES);
		expect(Buffer.from(e.cipher.nonce, 'base64')).toHaveLength(NONCE_BYTES);
		expect(Buffer.from(e.cipher.tag, 'base64')).toHaveLength(16);
	});
});

describe('rejects the wrong passphrase', () => {
	it('fails on a wrong passphrase', async () => {
		const sealed = await seal('secret', PASS, FAST);
		await expect(open(sealed, 'wrong passphrase entirely')).rejects.toThrow(VaultCryptoError);
	});

	it('fails on a one-character difference', async () => {
		const sealed = await seal('secret', PASS, FAST);
		await expect(open(sealed, `${PASS}!`)).rejects.toThrow(VaultCryptoError);
	});

	it('gives the same message for a wrong passphrase and for tampering', async () => {
		// Distinguishing them would tell an attacker holding the file which of the
		// two they achieved.
		const sealed = await seal('secret', PASS, FAST);
		const wrongPass = await open(sealed, 'nope nope nope').catch((e: Error) => e.message);

		const tampered = clone(sealed);
		const bytes = Buffer.from(tampered.ciphertext, 'base64');
		bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
		tampered.ciphertext = bytes.toString('base64');
		const damaged = await open(tampered, PASS).catch((e: Error) => e.message);

		expect(wrongPass).toBe(damaged);
	});
});

describe('detects tampering — every field is authenticated', () => {
	it('rejects a bad tag when opening a wrapped byte key', async () => {
		const sealed = await seal('workflow-content-key', PASS, FAST);
		const key = await deriveKey(PASS, Buffer.from(sealed.kdf.salt, 'base64'), sealed.kdf);
		try {
			const tampered = clone(sealed);
			const tag = Buffer.from(tampered.cipher.tag, 'base64');
			tag[0] = tag[0]! ^ 0x01;
			tampered.cipher.tag = tag.toString('base64');
			expect(() => openBytesWithKey(tampered, key, sealed.kdf)).toThrow(VaultCryptoError);
		} finally {
			wipe(key);
		}
	});

	it('rejects a flipped ciphertext bit', async () => {
		const sealed = await seal('secret data', PASS, FAST);
		const t = clone(sealed);
		const bytes = Buffer.from(t.ciphertext, 'base64');
		bytes[0] = bytes[0]! ^ 0x01;
		t.ciphertext = bytes.toString('base64');
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
	});

	it('rejects a flipped tag bit', async () => {
		const sealed = await seal('secret data', PASS, FAST);
		const t = clone(sealed);
		const tag = Buffer.from(t.cipher.tag, 'base64');
		tag[0] = tag[0]! ^ 0x01;
		t.cipher.tag = tag.toString('base64');
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
	});

	it('rejects a swapped nonce', async () => {
		const a = await seal('one', PASS, FAST);
		const b = await seal('two', PASS, FAST);
		const t = clone(a);
		t.cipher.nonce = b.cipher.nonce;
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
	});

	it('rejects an altered salt', async () => {
		const sealed = await seal('secret', PASS, FAST);
		const t = clone(sealed);
		const salt = Buffer.from(t.kdf.salt, 'base64');
		salt[0] = salt[0]! ^ 0x01;
		t.kdf.salt = salt.toString('base64');
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
	});

	it('rejects altered KDF parameters — the header is bound to the ciphertext', async () => {
		// Without AAD binding the header is unauthenticated, so a ciphertext could
		// be transplanted between envelopes describing different parameters.
		const sealed = await seal('secret', PASS, FAST);
		const t = clone(sealed);
		t.kdf.N = FAST.N * 2;
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
	});

	it('rejects an altered format version', async () => {
		const sealed = await seal('secret', PASS, FAST);
		const t = clone(sealed);
		// Same version number range, but no longer what was sealed.
		t.version = VAULT_FORMAT_VERSION;
		t.kdf.r = FAST.r + 1;
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
	});

	it('rejects a ciphertext transplanted from another vault', async () => {
		const mine = await seal('mine', PASS, FAST);
		const theirs = await seal('theirs', 'a different passphrase here', FAST);
		const t = clone(mine);
		t.ciphertext = theirs.ciphertext;
		t.cipher.tag = theirs.cipher.tag;
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
	});
});

describe('refuses malformed or hostile envelopes', () => {
	it('rejects a downgraded work factor before doing any work', async () => {
		const sealed = await seal('secret', PASS, FAST);
		const t = clone(sealed);
		t.kdf.N = 2; // trivially brute-forceable
		await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
		expect(MINIMUM_SCRYPT.N).toBeGreaterThan(2);
	});

	it('rejects a short salt, nonce or tag', async () => {
		const sealed = await seal('secret', PASS, FAST);
		for (const mutate of [
			(t: Envelope) => (t.kdf.salt = Buffer.alloc(8).toString('base64')),
			(t: Envelope) => (t.cipher.nonce = Buffer.alloc(4).toString('base64')),
			(t: Envelope) => (t.cipher.tag = Buffer.alloc(8).toString('base64'))
		]) {
			const t = clone(sealed);
			mutate(t);
			await expect(open(t, PASS)).rejects.toThrow(VaultCryptoError);
		}
	});

	it('refuses a vault written by a newer format version', async () => {
		// Opening it with an older layout risks writing it back and losing fields.
		const sealed = await seal('secret', PASS, FAST);
		const t = clone(sealed);
		t.version = VAULT_FORMAT_VERSION + 1;
		await expect(open(t, PASS)).rejects.toThrow(/newer version/);
	});

	it('rejects garbage that is not an envelope at all', async () => {
		for (const junk of [null, 'string', 42, [], {}, { version: 1 }]) {
			await expect(open(junk, PASS)).rejects.toThrow(VaultCryptoError);
		}
	});
});

describe('shipping parameters', () => {
	it('defaults to the §10.3 work factor', () => {
		expect(SCRYPT_DEFAULTS.N).toBe(131072);
		expect(SCRYPT_DEFAULTS.r).toBe(8);
		expect(SCRYPT_DEFAULTS.p).toBe(1);
		// 128 * N * r = 128 MiB, so maxmem must exceed it or scrypt refuses to run.
		expect(SCRYPT_DEFAULTS.maxmem).toBeGreaterThan(128 * SCRYPT_DEFAULTS.N * SCRYPT_DEFAULTS.r);
	});

	it('round-trips at the real work factor', { timeout: 60_000 }, async () => {
		// Slow on purpose: the shipping parameters must actually work on this
		// machine, not just the reduced ones the rest of the suite uses.
		const sealed = await seal('{"real":"parameters"}', PASS);
		expect(sealed.kdf.N).toBe(SCRYPT_DEFAULTS.N);
		expect(await open(sealed, PASS)).toBe('{"real":"parameters"}');
	});
});

describe('key material handling', () => {
	it('wipe zeroes the buffer it is given', () => {
		const key = Buffer.from('sensitive key material here!!!!!', 'utf8');
		wipe(key);
		expect(key.every((b) => b === 0)).toBe(true);
	});
});

/*
 * The KDF parameters come out of the file, and the file may be hostile.
 *
 * scrypt's working memory is roughly 128 * N * r bytes. A crafted envelope
 * naming a huge N turned "open this vault" into a multi-gigabyte allocation
 * before the passphrase was ever checked — the minimums guarded the weak
 * direction and nothing guarded the expensive one.
 */
describe('KDF parameters from a hostile file', () => {
	const kdf = (over: Partial<{ N: number; r: number; p: number }>) => ({
		type: 'scrypt' as const,
		N: 131072,
		r: 8,
		p: 1,
		salt: Buffer.alloc(32).toString('base64'),
		...over
	});

	it('accepts the shipping defaults and a reasonable raise', () => {
		expect(isAcceptableKdf(kdf({}))).toBe(true);
		expect(isAcceptableKdf(kdf({ N: 2 ** 20 }))).toBe(true);
	});

	it('refuses an N built to exhaust memory', () => {
		expect(isAcceptableKdf(kdf({ N: 2 ** 25 }))).toBe(false);
	});

	it('refuses an N that is not a power of two', () => {
		// Node throws on these anyway; refusing here names the file as the
		// problem instead of surfacing an internal crypto error.
		expect(isAcceptableKdf(kdf({ N: 131073 }))).toBe(false);
	});

	it('refuses a memory demand smuggled through r', () => {
		// N at its own cap, r at its own cap: each individually allowed, the
		// product past the memory ceiling.
		expect(isAcceptableKdf(kdf({ N: 2 ** 21, r: 32 }))).toBe(false);
	});

	it('still refuses the weak direction', () => {
		expect(isAcceptableKdf(kdf({ N: 1024 }))).toBe(false);
	});

	it('carries the refusal through deriveKey', async () => {
		await expect(deriveKey('a passphrase', Buffer.alloc(32), kdf({ N: 2 ** 25 }))).rejects.toThrow(
			/outside the acceptable range/
		);
	});
});
