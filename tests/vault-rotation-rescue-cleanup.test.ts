import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { open, sealWithKey, unseal, wipe } from '../src/main/vault/crypto';
import { VaultService, VaultServiceError } from '../src/main/vault/service';
import { readEnvelope } from '../src/main/vault/storage';

const state = vi.hoisted(() => ({
	refuseRescueRemoval: false,
	failPublishedBackupReadback: false,
	failPreviousBackupRestore: false,
	refuseJournalClear: false
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		readFileSync: (path: unknown, ...args: unknown[]) => {
			if (state.failPublishedBackupReadback && typeof path === 'string' && path.endsWith('.bak')) {
				state.failPublishedBackupReadback = false;
				throw Object.assign(new Error('EIO: backup destination read-back failed'), { code: 'EIO' });
			}
			return (actual.readFileSync as (...values: unknown[]) => unknown)(path, ...args);
		},
		copyFileSync: (source: unknown, destination: unknown, ...args: unknown[]) => {
			if (
				state.failPreviousBackupRestore &&
				typeof source === 'string' &&
				source.includes('.bak.previous-') &&
				typeof destination === 'string' &&
				destination.endsWith('.bak')
			) {
				throw Object.assign(new Error('EBUSY: backup restore failed'), { code: 'EBUSY' });
			}
			return (actual.copyFileSync as (...values: unknown[]) => unknown)(
				source,
				destination,
				...args
			);
		},
		unlinkSync: (path: unknown) => {
			if (state.refuseJournalClear && typeof path === 'string' && path.endsWith('.rotating')) {
				throw Object.assign(new Error('EBUSY: rotation journal is still open'), { code: 'EBUSY' });
			}
			if (
				state.refuseRescueRemoval &&
				typeof path === 'string' &&
				path.includes('.bak.previous-')
			) {
				throw Object.assign(new Error('EBUSY: retained by another process'), { code: 'EBUSY' });
			}
			return actual.unlinkSync(path as never);
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

const OLD = 'the old passphrase is long enough';
const NEXT = 'the new passphrase is also long enough';
const NEWEST = 'the newest passphrase is long enough too';
const directories: string[] = [];

afterEach(() => {
	state.refuseRescueRemoval = false;
	state.failPublishedBackupReadback = false;
	state.failPreviousBackupRestore = false;
	state.refuseJournalClear = false;
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function fixture(): Promise<{ directory: string; file: string; vault: VaultService }> {
	const directory = mkdtempSync(join(tmpdir(), 'oda-rotation-rescue-'));
	directories.push(directory);
	const file = join(directory, 'vault.json');
	const vault = new VaultService({ file });
	await vault.create(OLD);
	await vault.mutate((draft) => {
		draft.accounts.push({
			steamId64: '76561198000000001',
			accountName: 'secret-account',
			sharedSecret: 'c2hhcmVkLXNlY3JldA==',
			identitySecret: 'aWRlbnRpdHktc2VjcmV0',
			status: 'active',
			autoConfirm: {
				marketListings: false,
				trades: false,
				pollIntervalSeconds: 15,
				notify: { enabled: false, detail: 'full' }
			},
			addedAt: '2026-09-03T00:00:00.000Z'
		});
	});
	return { directory, file, vault };
}

const rescueNames = (directory: string): string[] =>
	readdirSync(directory).filter((name) => /\.bak\.previous-[0-9a-f-]{36}$/i.test(name));

describe('retired-key backup rescue cleanup', () => {
	it('keeps the backup suspect across restart when backup publication and restoration both fail', async () => {
		const { directory, file, vault } = await fixture();
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		state.failPublishedBackupReadback = true;
		state.failPreviousBackupRestore = true;

		let message = '';
		try {
			await vault.changePassphrase(OLD, NEXT);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(logged).toHaveBeenCalled();
		const [rescue] = rescueNames(directory);
		expect(rescue).toBeDefined();
		expect(message).toMatch(/rolled back for the main vault.*backup changed/i);
		expect(message).toContain(`"${rescue}"`);
		expect(message).not.toContain(directory);
		expect(vault.backupAvailable()).toBeUndefined();
		await expect(vault.verifyPassphrase(OLD)).resolves.toBeUndefined();
		await expect(vault.verifyPassphrase(NEXT)).rejects.toThrow();

		vault.lock();
		expect(
			new VaultService({ file }).backupAvailable(),
			'a restart forgot that the visible backup failed verification and its prior copy is only a rescue'
		).toBeUndefined();

		state.failPreviousBackupRestore = false;
		const retry = new VaultService({ file });
		await retry.unlock(OLD);
		await expect(retry.changePassphrase(OLD, NEXT)).resolves.toBeUndefined();
		expect(rescueNames(directory)).toEqual([]);
		expect(retry.backupAvailable()).toBeDefined();
	});

	it('lets rescue evidence dominate a salt-mismatch journal even when journal cleanup fails', async () => {
		const { file } = await fixture();
		const rescue = `${file}.bak.previous-11111111-1111-4111-8111-111111111111`;
		copyFileSync(`${file}.bak`, rescue);
		writeFileSync(
			`${file}.rotating`,
			readFileSync(`${file}.bak`, 'utf8').replace(/"salt": "[^"]*"/, '"salt": "b3RoZXItc2FsdA=="')
		);

		state.refuseJournalClear = true;
		const restarted = new VaultService({ file });
		expect(restarted.reconcile()).toBe(false);
		expect(existsSync(`${file}.rotating`)).toBe(true);
		expect(existsSync(rescue)).toBe(true);
		expect(
			restarted.backupAvailable(),
			'a salt-mismatch early return made a suspect backup available while its rescue remained'
		).toBeUndefined();

		state.refuseJournalClear = false;
		expect(restarted.reconcile()).toBe(false);
		expect(existsSync(`${file}.rotating`)).toBe(false);
		expect(existsSync(rescue)).toBe(true);
		expect(restarted.backupAvailable()).toBeUndefined();
	});

	it('does not let a stale journal delete the only rescue made by a later rotation', async () => {
		const { directory, file, vault } = await fixture();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		// Rotation one commits, but its already-paid journal survives the unlink.
		state.refuseJournalClear = true;
		await vault.changePassphrase(OLD, NEXT);
		const staleJournal = readFileSync(`${file}.rotating`);
		state.refuseJournalClear = false;

		// A later save gives the main vault a nonce different from that stale record.
		await vault.mutate((draft) => {
			draft.settings.clipboardClearSeconds = 42;
		});
		const beforeLaterRotation = readFileSync(file);

		// Rotation two publishes a suspect backup, cannot restore it, then rolls the
		// main vault back and restores rotation one's stale journal byte for byte.
		state.failPublishedBackupReadback = true;
		state.failPreviousBackupRestore = true;
		let message = '';
		try {
			await vault.changePassphrase(NEXT, NEWEST);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(readFileSync(file)).toEqual(beforeLaterRotation);
		expect(readFileSync(`${file}.rotating`)).toEqual(staleJournal);
		const [rescue] = rescueNames(directory);
		expect(rescue).toBeDefined();
		expect(message).toContain(`"${rescue}"`);
		expect(message).not.toContain(directory);
		const rescueBytes = readFileSync(join(directory, rescue as string));
		await expect(open(JSON.parse(rescueBytes.toString('utf8')), NEXT)).resolves.toContain(
			'secret-account'
		);

		vault.lock();
		const restarted = new VaultService({ file });
		expect(restarted.reconcile()).toBe(false);
		expect(existsSync(`${file}.rotating`)).toBe(false);
		expect(readFileSync(join(directory, rescue as string))).toEqual(rescueBytes);
		expect(
			restarted.backupAvailable(),
			'the stale nonce branch discarded later rescue evidence and trusted the suspect backup'
		).toBeUndefined();
	});

	it('keeps durable debt, adopts the new key, and removes the old-key rescue on restart', async () => {
		const { directory, file, vault } = await fixture();
		const unrelated = `${file}.bak.previous-not-an-app-uuid`;
		writeFileSync(unrelated, 'do not remove');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		state.refuseRescueRemoval = true;
		await expect(vault.changePassphrase(OLD, NEXT)).rejects.toThrow(
			/the passphrase was changed.*older encrypted rescue/i
		);

		expect(vault.isUnlocked()).toBe(true);
		await expect(vault.verifyPassphrase(NEXT)).resolves.toBeUndefined();
		await expect(vault.verifyPassphrase(OLD)).rejects.toThrow();
		expect(existsSync(`${file}.rotating`)).toBe(true);
		const [rescue] = rescueNames(directory);
		expect(rescue).toBeDefined();
		expect(logged).toHaveBeenCalledWith(
			'the passphrase changed but an encrypted backup rescue could not be removed',
			expect.arrayContaining([join(directory, rescue as string)])
		);

		await expect(open(JSON.parse(readFileSync(file, 'utf8')), OLD)).rejects.toThrow();
		await expect(open(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), OLD)).rejects.toThrow();
		expect(
			await open(JSON.parse(readFileSync(join(directory, rescue as string), 'utf8')), OLD)
		).toContain('secret-account');

		vault.lock();
		state.refuseRescueRemoval = false;
		const restarted = new VaultService({ file });
		expect(restarted.reconcile()).toBe(true);
		expect(rescueNames(directory)).toEqual([]);
		expect(existsSync(`${file}.rotating`)).toBe(false);
		expect(readFileSync(unrelated, 'utf8')).toBe('do not remove');
		await expect(open(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), NEXT)).resolves.toContain(
			'secret-account'
		);
	});

	it('retains unbound cleanup debt after a later new-key save until a verified replacement', async () => {
		const { directory, file, vault } = await fixture();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		state.refuseRescueRemoval = true;
		await expect(vault.changePassphrase(OLD, NEXT)).rejects.toThrow(VaultServiceError);
		await vault.mutate((draft) => {
			draft.settings.clipboardClearSeconds = 41;
		});
		expect(rescueNames(directory)).toHaveLength(1);
		expect(existsSync(`${file}.rotating`)).toBe(true);

		vault.lock();
		state.refuseRescueRemoval = false;
		const restarted = new VaultService({ file });
		expect(restarted.reconcile()).toBe(false);
		expect(rescueNames(directory)).toHaveLength(1);
		expect(existsSync(`${file}.rotating`)).toBe(false);
		expect(restarted.backupAvailable()).toBeUndefined();

		await restarted.unlock(NEXT);
		await restarted.changePassphrase(NEXT, NEWEST);
		expect(rescueNames(directory)).toEqual([]);
		expect(restarted.backupAvailable()).toBeDefined();
	});

	it('verifies the exact owed backup before deleting the only old-key rescue', async () => {
		const { directory, file, vault } = await fixture();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		state.refuseRescueRemoval = true;
		await expect(vault.changePassphrase(OLD, NEXT)).rejects.toThrow(VaultServiceError);
		const [rescue] = rescueNames(directory);
		expect(rescue).toBeDefined();

		/*
		 * Same KDF metadata is not publication proof. Model a post-rename read-back
		 * anomaly that leaves some other valid new-key envelope at the backup name;
		 * reconciliation must rewrite the journal's exact backup before cleanup.
		 */
		const opened = await unseal(readEnvelope(file), NEXT);
		try {
			writeFileSync(
				`${file}.bak`,
				`${JSON.stringify(sealWithKey('foreign backup body', opened.key, opened.kdf), null, 2)}\n`
			);
		} finally {
			wipe(opened.key);
		}

		vault.lock();
		state.refuseRescueRemoval = false;
		const restarted = new VaultService({ file });
		expect(restarted.reconcile()).toBe(true);
		expect(rescueNames(directory)).toEqual([]);
		expect(existsSync(`${file}.rotating`)).toBe(false);
		expect(await open(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), NEXT)).toContain(
			'secret-account'
		);
	});

	it('reports an ordinary successful rotation only after no owned rescue remains', async () => {
		const { directory, file, vault } = await fixture();
		await expect(vault.changePassphrase(OLD, NEXT)).resolves.toBeUndefined();
		expect(rescueNames(directory)).toEqual([]);
		expect(existsSync(`${file}.rotating`)).toBe(false);
		await expect(vault.verifyPassphrase(NEXT)).resolves.toBeUndefined();
	});

	it('removes an exact app rescue left by a crash before the current rotation began', async () => {
		const { directory, file, vault } = await fixture();
		const crashEra = `${file}.bak.previous-11111111-1111-4111-8111-111111111111`;
		copyFileSync(file, crashEra);
		expect(rescueNames(directory)).toEqual([crashEra.slice(directory.length + 1)]);

		await expect(vault.changePassphrase(OLD, NEXT)).resolves.toBeUndefined();
		expect(existsSync(crashEra)).toBe(false);
		expect(rescueNames(directory)).toEqual([]);
	});
});
