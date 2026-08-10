import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	VaultLockedError,
	VaultService,
	VaultServiceError,
	VaultCryptoError,
	type LockReason
} from '../src/main/vault/service';
import { readEnvelope } from '../src/main/vault/storage';
import type { Account } from '../src/shared/vault-schema';

/**
 * Lifecycle rules for the vault session.
 *
 * The real work factor would make this suite take minutes, so `SCRYPT_DEFAULTS`
 * is stubbed down to the accepted floor. The shipping parameters are asserted in
 * `vault-crypto.test.ts`, which also round-trips at them for real.
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

const PASS = 'a sufficiently long passphrase';

let dir: string;
let file: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'vault-service-'));
	file = join(dir, 'vault.json');
	clock = Date.UTC(2026, 7, 8, 12, 0, 0);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function service(onLock?: (reason: LockReason) => void): VaultService {
	return new VaultService(onLock ? { file, now, onLock } : { file, now });
}

const account: Account = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	sharedSecret: 'c2hhcmVk',
	identitySecret: 'aWRlbnRpdHk=',
	status: 'active',
	addedAt: '2026-08-08T00:00:00.000Z',
	autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
};

describe('creation', () => {
	it('creates a vault and leaves it unlocked', async () => {
		const v = service();
		expect(v.exists()).toBe(false);
		await v.create(PASS);
		expect(v.exists()).toBe(true);
		expect(v.isUnlocked()).toBe(true);
		expect(v.read().accounts).toEqual([]);
	});

	it('refuses to overwrite an existing vault', async () => {
		await service().create(PASS);
		// "Create" is not a word anyone expects to be destructive, and the thing it
		// would destroy is every secret in the file.
		await expect(service().create('another long passphrase')).rejects.toThrow(/already exists/);
	});

	it('enforces the passphrase policy', async () => {
		await expect(service().create('short')).rejects.toThrow(VaultServiceError);
		expect(service().exists()).toBe(false);
	});
});

describe('unlock and lock', () => {
	it('unlocks with the right passphrase', async () => {
		await service().create(PASS);
		const v = service();
		await v.unlock(PASS);
		expect(v.isUnlocked()).toBe(true);
	});

	it('refuses the wrong passphrase', async () => {
		await service().create(PASS);
		const v = service();
		await expect(v.unlock('not the passphrase at all')).rejects.toThrow(VaultCryptoError);
		expect(v.isUnlocked()).toBe(false);
	});

	it('refuses to unlock a vault that does not exist', async () => {
		await expect(service().unlock(PASS)).rejects.toThrow(/no vault at this location/);
	});

	it('denies reads while locked', async () => {
		const v = service();
		await v.create(PASS);
		v.lock();
		expect(v.isUnlocked()).toBe(false);
		expect(() => v.read()).toThrow(VaultLockedError);
		await expect(v.mutate(() => undefined)).rejects.toThrow(VaultLockedError);
	});

	it('reports why it locked', async () => {
		const reasons: string[] = [];
		const v = service((r) => reasons.push(r));
		await v.create(PASS);
		v.lock('suspend');
		expect(reasons).toEqual(['suspend']);
	});

	it('locking twice is harmless and does not re-notify', async () => {
		const reasons: string[] = [];
		const v = service((r) => reasons.push(r));
		await v.create(PASS);
		v.lock();
		v.lock();
		expect(reasons).toEqual(['manual']);
	});

	it('rejects a vault whose contents decrypt but are not valid', async () => {
		// Distinct from a wrong passphrase: the file is authentic, the shape is not.
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => {
			(d as unknown as { seq: unknown }).seq = 0;
		});
		writeFileSync(file, JSON.stringify(readEnvelope(file)));
		const reopened = service();
		await expect(reopened.unlock(PASS)).resolves.toBeUndefined();
	});
});

describe('saving changes', () => {
	it('persists a mutation and bumps the sequence number', async () => {
		const v = service();
		await v.create(PASS);
		expect(v.read().seq).toBe(0);

		await v.mutate((draft) => draft.accounts.push(account));
		expect(v.read().seq).toBe(1);
		expect(v.read().accounts).toHaveLength(1);

		const reopened = service();
		await reopened.unlock(PASS);
		expect(reopened.read().accounts[0]?.steamId64).toBe('76561198000000001');
		expect(reopened.read().seq).toBe(1);
	});

	it('keeps the SteamID exact across a save and reload', async () => {
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push({ ...account, steamId64: '76561199999999999' }));

		const reopened = service();
		await reopened.unlock(PASS);
		expect(reopened.read().accounts[0]?.steamId64).toBe('76561199999999999');
	});

	it('leaves the in-memory vault untouched when a change is invalid', async () => {
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));

		await expect(
			v.mutate((draft) => {
				draft.accounts.push({ ...account, steamId64: 'not-a-steamid' });
			})
		).rejects.toThrow();

		// A half-applied change that exists only in memory is worse than a rejected
		// one — the next save would persist it.
		expect(v.read().accounts).toHaveLength(1);
		expect(v.read().seq).toBe(1);
	});

	it('does not let the caller mutate the live vault directly', async () => {
		const v = service();
		await v.create(PASS);
		const snapshot = v.read();
		snapshot.accounts.push(account);
		// The draft handed to mutate() is a copy; a stale read must not be a
		// back door into stored state.
		expect(v.read().accounts).toHaveLength(0);
	});

	it('serves settings without copying the secrets alongside them', async () => {
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));

		const settings = v.settings();

		expect(settings.clipboardClearSeconds).toBe(30);
		// The reason this method exists at all: reading one number must not deep-copy
		// every secret in the vault into fresh strings that immediately become
		// garbage. §11 already concedes that strings outlive a lock until collection,
		// so multiplying the copies makes an admitted limit measurably worse.
		expect(JSON.stringify(settings)).not.toContain(account.sharedSecret);
		expect(Object.keys(settings)).not.toContain('accounts');
	});

	it('refuses to serve settings while locked', () => {
		expect(() => service().settings()).toThrow(VaultLockedError);
	});

	it('uses a fresh nonce for every save but keeps the salt', async () => {
		const v = service();
		await v.create(PASS);
		const first = readEnvelope(file);

		await v.mutate((d) => d.accounts.push(account));
		const second = readEnvelope(file);

		// Nonce reuse under one key would be catastrophic; salt reuse is fine and
		// is what lets a save avoid re-deriving the key.
		expect(second.cipher.nonce).not.toBe(first.cipher.nonce);
		expect(second.kdf.salt).toBe(first.kdf.salt);
	});
});

describe('idle auto-lock', () => {
	it('does not lock before the timeout', async () => {
		const v = service();
		await v.create(PASS);
		clock += 9 * 60_000;
		expect(v.enforceAutoLock()).toBe(false);
		expect(v.isUnlocked()).toBe(true);
	});

	it('locks once the timeout elapses', async () => {
		const reasons: string[] = [];
		const v = service((r) => reasons.push(r));
		await v.create(PASS);
		clock += 10 * 60_000;
		expect(v.enforceAutoLock()).toBe(true);
		expect(v.isUnlocked()).toBe(false);
		expect(reasons).toEqual(['idle']);
	});

	it('activity defers the lock', async () => {
		const v = service();
		await v.create(PASS);
		clock += 9 * 60_000;
		v.touch();
		clock += 9 * 60_000;
		expect(v.enforceAutoLock()).toBe(false);
		expect(v.isUnlocked()).toBe(true);
	});

	it('a save counts as activity', async () => {
		const v = service();
		await v.create(PASS);
		clock += 9 * 60_000;
		await v.mutate((d) => d.accounts.push(account));
		clock += 9 * 60_000;
		expect(v.enforceAutoLock()).toBe(false);
	});

	it('honours a changed timeout immediately', async () => {
		// Polled rather than driven by a setTimeout, so a settings change takes
		// effect at once instead of after the old timer fires.
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => (d.settings.autoLockMinutes = 1));
		clock += 61_000;
		expect(v.enforceAutoLock()).toBe(true);
	});

	it('reports nothing when locked', () => {
		const v = service();
		expect(v.msUntilAutoLock()).toBeUndefined();
		expect(v.enforceAutoLock()).toBe(false);
	});
});

describe('changing the passphrase', () => {
	it('re-seals so only the new passphrase opens it', async () => {
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));

		await v.changePassphrase(PASS, 'a brand new long passphrase');

		const reopened = service();
		await expect(reopened.unlock(PASS)).rejects.toThrow(VaultCryptoError);
		await reopened.unlock('a brand new long passphrase');
		expect(reopened.read().accounts).toHaveLength(1);
	});

	it('rotates the salt', async () => {
		const v = service();
		await v.create(PASS);
		const before = readEnvelope(file).kdf.salt;

		await v.changePassphrase(PASS, 'a brand new long passphrase');
		expect(readEnvelope(file).kdf.salt).not.toBe(before);
	});

	it('requires the current passphrase even while unlocked', async () => {
		// An unattended unlocked machine must not be enough to lock the owner out.
		const v = service();
		await v.create(PASS);
		await expect(v.changePassphrase('wrong current one', 'a new long passphrase')).rejects.toThrow(
			/current passphrase is not correct/
		);

		const reopened = service();
		await expect(reopened.unlock(PASS)).resolves.toBeUndefined();
	});

	it('enforces the policy on the new passphrase', async () => {
		const v = service();
		await v.create(PASS);
		await expect(v.changePassphrase(PASS, 'short')).rejects.toThrow(VaultServiceError);
		// And the old one still works.
		const reopened = service();
		await expect(reopened.unlock(PASS)).resolves.toBeUndefined();
	});

	it('keeps the session usable afterwards', async () => {
		const v = service();
		await v.create(PASS);
		await v.changePassphrase(PASS, 'a brand new long passphrase');
		await expect(v.mutate((d) => d.accounts.push(account))).resolves.toBeUndefined();
		expect(v.read().accounts).toHaveLength(1);
	});
});

describe('backup recovery', () => {
	it('offers the previous version after a second write', async () => {
		const v = service();
		await v.create(PASS);
		expect(v.backupAvailable()).toBeUndefined();

		await v.mutate((d) => d.accounts.push(account));
		expect(v.backupAvailable()).toBeDefined();
	});

	it('does not load the backup on its own', async () => {
		// Silently loading an older vault would resurrect removed accounts or roll
		// back one the user believes is saved.
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));

		const reopened = service();
		await reopened.unlock(PASS);
		expect(reopened.read().accounts).toHaveLength(1);
		expect(readFileSync(file, 'utf8')).not.toBe(readFileSync(`${file}.bak`, 'utf8'));
	});
});
