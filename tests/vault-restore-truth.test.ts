import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultService } from '../src/main/vault/service';
import { newAutoConfirm } from '../src/shared/vault-schema';

const state = vi.hoisted(() => ({ failAfterPublish: false }));

vi.mock('../src/main/vault/storage', async () => {
	const actual = await vi.importActual<typeof import('../src/main/vault/storage')>(
		'../src/main/vault/storage'
	);
	return {
		...actual,
		writeEnvelope: (file: string, envelope: Parameters<typeof actual.writeEnvelope>[1]) => {
			actual.writeEnvelope(file, envelope);
			if (state.failAfterPublish) {
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

const PASS = 'a sufficiently long passphrase';
let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'vault-restore-truth-'));
	file = join(dir, 'vault.json');
	state.failAfterPublish = false;
});

afterEach(() => {
	state.failAfterPublish = false;
	rmSync(dir, { recursive: true, force: true });
});

describe('a restore whose replacement was published but cannot be rolled back', () => {
	it('names the retained original instead of claiming the vault is unchanged', async () => {
		const vault = new VaultService({ file, now: () => Date.UTC(2026, 8, 3) });
		await vault.create(PASS);
		await vault.mutate((draft) => {
			draft.accounts.push({
				steamId64: '76561198000000001',
				accountName: 'kept-account',
				sharedSecret: 'c2hhcmVk',
				identitySecret: 'aWRlbnRpdHk=',
				status: 'active',
				addedAt: '2026-09-03T00:00:00.000Z',
				autoConfirm: newAutoConfirm()
			});
		});
		const original = readFileSync(file, 'utf8');

		state.failAfterPublish = true;
		let message = '';
		try {
			await new VaultService({ file, now: () => Date.UTC(2026, 8, 3) }).restoreFromBackup(PASS);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}

		expect(message).not.toMatch(/nothing was changed|as it was/i);
		const rescues = readdirSync(dir).filter((name) => name.includes('.superseded-'));
		expect(rescues).toHaveLength(1);
		expect(message).toContain(basename(rescues[0] as string));
		expect(readFileSync(join(dir, rescues[0] as string), 'utf8')).toBe(original);
	});
});
