import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultService } from '../src/main/vault/service';
import type { VaultContents } from '../src/shared/vault-schema';

/**
 * Every derived key gets zeroed.
 *
 * `wipe` exists so key material does not sit in memory after it stops being
 * needed. That is only true if every path that drops a key calls it, and one did
 * not: `unlock` assigned `this.state` straight over an existing session, so
 * unlocking an already-unlocked vault — a double-submitted form, two IPC calls
 * racing — left the previous key un-zeroed until collection.
 *
 * Counting `wipe` calls is a blunt instrument, but the alternative is reaching
 * into private state, and the invariant is worth a test that fails the build.
 */

vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const wipeSpy = vi.fn<(key: Buffer) => void>();

vi.mock('../src/main/vault/crypto', async () => {
	const actual = await vi.importActual<typeof import('../src/main/vault/crypto')>(
		'../src/main/vault/crypto'
	);
	return {
		...actual,
		wipe: (key: Buffer) => {
			wipeSpy(Buffer.from(key));
			actual.wipe(key);
		}
	};
});

const PASS = 'a sufficiently long passphrase';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'vault-keys-'));
	wipeSpy.mockClear();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function service(): VaultService {
	return new VaultService({ file: join(dir, 'vault.json') });
}

describe('key hygiene', () => {
	it('zeroes the previous key when unlocking an already-unlocked vault', async () => {
		const vault = service();
		await vault.create(PASS);

		wipeSpy.mockClear();
		await vault.unlock(PASS);

		// The session that was replaced had a key. It must not simply be dropped.
		expect(wipeSpy).toHaveBeenCalledTimes(1);
		expect(vault.isUnlocked()).toBe(true);
	});

	it('leaves the vault usable after a repeated unlock', async () => {
		const vault = service();
		await vault.create(PASS);
		await vault.unlock(PASS);
		await vault.unlock(PASS);

		// Wiping the outgoing key must not have touched the incoming one.
		await vault.mutate((draft: VaultContents) => {
			draft.settings.autoLockMinutes = 5;
		});
		expect(vault.read().settings.autoLockMinutes).toBe(5);
	});

	it('zeroes the key on lock', async () => {
		const vault = service();
		await vault.create(PASS);

		wipeSpy.mockClear();
		vault.lock();

		expect(wipeSpy).toHaveBeenCalledTimes(1);
		expect(vault.isUnlocked()).toBe(false);
	});

	it('does not wipe anything when locking an already-locked vault', () => {
		service().lock();
		expect(wipeSpy).not.toHaveBeenCalled();
	});

	it('zeroes the verification key after proving a passphrase', async () => {
		const vault = service();
		await vault.create(PASS);

		wipeSpy.mockClear();
		await vault.verifyPassphrase(PASS);

		// Only the proof was wanted; the key it derived is not kept.
		expect(wipeSpy).toHaveBeenCalledTimes(1);
		expect(vault.isUnlocked()).toBe(true);
	});
});
