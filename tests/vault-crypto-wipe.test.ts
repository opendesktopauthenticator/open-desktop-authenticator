import { describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ decrypted: [] as Buffer[] }));

vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	const createDecipheriv = ((...args: unknown[]) => {
		const decipher = Reflect.apply(actual.createDecipheriv, actual, args) as ReturnType<
			typeof actual.createDecipheriv
		>;
		const originalUpdate = decipher.update.bind(decipher) as (...updateArgs: unknown[]) => Buffer;
		(
			decipher as unknown as {
				update: (...updateArgs: unknown[]) => Buffer;
			}
		).update = (...updateArgs: unknown[]): Buffer => {
			const result = originalUpdate(...updateArgs);
			observed.decrypted.push(result);
			return result;
		};
		return decipher;
	}) as typeof actual.createDecipheriv;
	return { ...actual, createDecipheriv };
});

import {
	deriveKey,
	open,
	openBytesWithKey,
	seal,
	VaultCryptoError,
	wipe
} from '../src/main/vault/crypto';
import { MINIMUM_SCRYPT, type Envelope } from '../src/shared/vault-format';

const FAST = { N: MINIMUM_SCRYPT.N, r: MINIMUM_SCRYPT.r, p: MINIMUM_SCRYPT.p };

describe('vault GCM failure hygiene', () => {
	it('wipes plaintext returned before a bad authentication tag is rejected', async () => {
		const sealed = await seal(
			'{"shared_secret":"never leave this buffer"}',
			'right passphrase',
			FAST
		);
		const tampered = JSON.parse(JSON.stringify(sealed)) as Envelope;
		const tag = Buffer.from(tampered.cipher.tag, 'base64');
		tag[0] = tag[0]! ^ 1;
		tampered.cipher.tag = tag.toString('base64');

		observed.decrypted.length = 0;
		await expect(open(tampered, 'right passphrase')).rejects.toThrow(VaultCryptoError);

		expect(observed.decrypted.length).toBeGreaterThan(0);
		for (const partialPlaintext of observed.decrypted) {
			expect(partialPlaintext.every((byte) => byte === 0)).toBe(true);
		}
	});

	it('wipes a wrapped workflow key exposed before a bad tag is rejected', async () => {
		const sealed = await seal('short-lived-workflow-content-key', 'right passphrase', FAST);
		const key = await deriveKey(
			'right passphrase',
			Buffer.from(sealed.kdf.salt, 'base64'),
			sealed.kdf
		);
		const tampered = JSON.parse(JSON.stringify(sealed)) as Envelope;
		const tag = Buffer.from(tampered.cipher.tag, 'base64');
		tag[0] = tag[0]! ^ 1;
		tampered.cipher.tag = tag.toString('base64');

		observed.decrypted.length = 0;
		try {
			expect(() => openBytesWithKey(tampered, key, sealed.kdf)).toThrow(VaultCryptoError);
		} finally {
			wipe(key);
		}

		expect(observed.decrypted.length).toBeGreaterThan(0);
		for (const partialPlaintext of observed.decrypted) {
			expect(partialPlaintext.every((byte) => byte === 0)).toBe(true);
		}
	});
});
