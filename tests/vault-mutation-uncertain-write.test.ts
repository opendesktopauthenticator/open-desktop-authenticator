import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultLockedError, VaultService, VaultServiceError } from '../src/main/vault/service';

const state = vi.hoisted<{ failure: 'none' | 'unchanged' | 'uncertain' }>(() => ({
	failure: 'none'
}));

vi.mock('../src/main/vault/storage', async () => {
	const actual = await vi.importActual<typeof import('../src/main/vault/storage')>(
		'../src/main/vault/storage'
	);
	return {
		...actual,
		writeEnvelope: (file: string, envelope: Parameters<typeof actual.writeEnvelope>[1]) => {
			if (state.failure === 'unchanged') {
				throw new actual.VaultStorageError('injected refusal before publication', undefined, true);
			}
			actual.writeEnvelope(file, envelope);
			if (state.failure === 'uncertain') {
				throw new actual.VaultStorageError('injected failure after publication', undefined, false);
			}
		}
	};
});

vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const directories: string[] = [];
afterEach(() => {
	state.failure = 'none';
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture(onLock: (reason: string) => void = () => undefined): {
	file: string;
	passphrase: string;
	vault: VaultService;
} {
	const directory = mkdtempSync(join(tmpdir(), 'oda-vault-mutate-'));
	directories.push(directory);
	const file = join(directory, 'vault.json');
	return {
		file,
		passphrase: 'a sufficiently long passphrase',
		vault: new VaultService({ file, onLock })
	};
}

describe('generic vault writes with a known publication outcome', () => {
	it('locks and discards stale memory when rollback cannot prove the file stayed unchanged', async () => {
		const locked: string[] = [];
		const { file, passphrase, vault } = fixture((reason) => locked.push(reason));
		await vault.create(passphrase);

		state.failure = 'uncertain';
		await expect(
			vault.mutate((draft) => {
				draft.settings.updateCheck = false;
			})
		).rejects.toThrow(VaultServiceError);

		expect(vault.isUnlocked()).toBe(false);
		expect(locked).toEqual(['manual']);
		await expect(vault.mutate(() => undefined)).rejects.toThrow(VaultLockedError);

		state.failure = 'none';
		await vault.unlock(passphrase);
		expect(vault.settings().updateCheck).toBe(false);
		await vault.mutate((draft) => {
			draft.settings.clipboardClearSeconds = 31;
		});

		vault.lock();
		const reopened = new VaultService({ file });
		await reopened.unlock(passphrase);
		expect(reopened.settings()).toMatchObject({ updateCheck: false, clipboardClearSeconds: 31 });
	});

	it('keeps the prior unlocked snapshot usable when storage proves nothing was published', async () => {
		const { file, passphrase, vault } = fixture();
		await vault.create(passphrase);

		state.failure = 'unchanged';
		await expect(
			vault.mutate((draft) => {
				draft.settings.updateCheck = false;
			})
		).rejects.toMatchObject({ unchanged: true });
		expect(vault.isUnlocked()).toBe(true);
		expect(vault.settings().updateCheck).toBe(true);

		state.failure = 'none';
		await vault.mutate((draft) => {
			draft.settings.clipboardClearSeconds = 32;
		});
		vault.lock();
		const reopened = new VaultService({ file });
		await reopened.unlock(passphrase);
		expect(reopened.settings()).toMatchObject({ updateCheck: true, clipboardClearSeconds: 32 });
	});
});
