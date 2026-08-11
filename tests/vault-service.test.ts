import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/**
 * Runs inside `deriveKey`, so a test can land a write in the exact window a
 * passphrase change is derivating.
 *
 * A timing test cannot be written with `setTimeout` here: `mutate` contains no
 * awaits, so it completes synchronously the moment it is called, and the obvious
 * "start the change, then mutate" ordering lands the write *before* the
 * derivation begins — which is the one arrangement the bug survives. Hooking the
 * derivation puts the write where it actually has to be.
 */
let duringDerive: (() => Promise<void>) | undefined;

vi.mock('../src/main/vault/crypto', async () => {
	const actual = await vi.importActual<typeof import('../src/main/vault/crypto')>(
		'../src/main/vault/crypto'
	);
	return {
		...actual,
		deriveKey: async (...args: Parameters<typeof actual.deriveKey>) => {
			const hook = duringDerive;
			duringDerive = undefined;
			if (hook) {
				await hook();
			}
			return actual.deriveKey(...args);
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

describe('changing the passphrase while other things are happening', () => {
	it('does not discard a write that landed during the key derivation', async () => {
		// `deriveKey` is scrypt — the better part of a second at the shipping work
		// factor — and `mutate` is synchronous once it has the state. So a write
		// during that second completes in full: an account enrolled, a token stored,
		// an import committed. Snapshotting the contents *before* the await and
		// sealing them afterwards silently replaced all of it with the older copy,
		// under the same `seq`, so nothing downstream could tell.
		const v = service();
		await v.create(PASS);

		// Lands inside the derivation, which is the only window that matters.
		duringDerive = () => v.mutate((d) => d.accounts.push(account));
		await v.changePassphrase(PASS, 'a different long passphrase');

		expect(v.read().accounts).toHaveLength(1);

		// And it is really on disk under the new passphrase, not just in memory.
		const reopened = service();
		await reopened.unlock('a different long passphrase');
		expect(reopened.read().accounts).toHaveLength(1);
	});

	it('refuses to rewrite the file if the vault locked during the derivation', async () => {
		// The idle timer does not pause for a key derivation. A lock partway through
		// left this holding a detached state object, and it went on to rewrite the
		// file and install a key into an object nobody could reach.
		const v = service();
		await v.create(PASS);

		const changing = v.changePassphrase(PASS, 'a different long passphrase');
		v.lock();

		await expect(changing).rejects.toThrow();
		// The old passphrase still opens it, because nothing was rewritten.
		const reopened = service();
		await expect(reopened.unlock(PASS)).resolves.toBeUndefined();
	});
});

describe('adopting a vault file from elsewhere', () => {
	it('takes on a vault this machine does not have', async () => {
		// With no `vault.json` and no `vault.json.bak`, the app offered to create a
		// vault and nothing else — even to somebody holding a good copy of theirs.
		// The only route was knowing the data directory and the filename.
		const source = join(dir, 'elsewhere', 'vault.json');
		const origin = new VaultService({ file: source, now });
		await origin.create(PASS);
		await origin.mutate((d) => d.accounts.push(account));

		const here = service();
		expect(here.exists()).toBe(false);

		here.adoptFrom(source);

		expect(here.exists()).toBe(true);
		await here.unlock(PASS);
		expect(here.read().accounts).toHaveLength(1);
	});

	it('refuses to replace a vault that already exists', async () => {
		// "Replace my vault with this file" is a different and far more dangerous
		// request than "I have no vault, here is one". Only the second is offered.
		const source = join(dir, 'elsewhere', 'vault.json');
		const origin = new VaultService({ file: source, now });
		await origin.create(PASS);

		const here = service();
		await here.create('a different long passphrase');
		const before = readFileSync(file, 'utf8');

		expect(() => here.adoptFrom(source)).toThrow(/already a vault/);
		expect(readFileSync(file, 'utf8')).toBe(before);
	});

	it('refuses a file that is not a vault, without creating one', () => {
		const notAVault = join(dir, 'notes.json');
		writeFileSync(notAVault, '{"hello":"world"}', 'utf8');

		const here = service();
		expect(() => here.adoptFrom(notAVault)).toThrow(/not a vault/);
		expect(here.exists()).toBe(false);
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

	it('opens the backup when the vault file will not parse', async () => {
		// The situation the whole mechanism exists for, and the one that was
		// unreachable: `unlock` reads the main file unconditionally, so a corrupted
		// vault locked the user out of every account they had while a good copy sat
		// beside it — and the unlock screen told them it was there.
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));
		writeFileSync(file, 'this is not a vault', 'utf8');

		const reopened = service();
		await expect(reopened.unlock(PASS)).rejects.toThrow();

		await reopened.restoreFromBackup(PASS);

		expect(reopened.isUnlocked()).toBe(true);
		// The backup predates the account being added, which is exactly what a
		// rollback means and why it is never automatic.
		expect(reopened.read().accounts).toHaveLength(0);
	});

	it('keeps the file it replaced rather than deleting it', async () => {
		// It may be corrupt, or it may be a perfectly good vault the user is rolling
		// back by mistake. Nothing here can tell those apart, and a file holding
		// revocation codes is not thrown away on an assumption.
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));

		await service().restoreFromBackup(PASS);

		const superseded = readdirSync(dir).filter((name) => name.includes('superseded'));
		expect(superseded).toHaveLength(1);
	});

	it('puts the vault back when the restore write fails', async () => {
		// `setAside` renames the main file away, which makes `writeEnvelope` believe
		// there was never one — so its own rollback, which restores from `.bak` only
		// when a main file existed, does nothing. Left like that a failed restore
		// leaves no `vault.json` at all: the app reads that as a fresh install and
		// offers to create one, and the second save of that new vault copies it over
		// the `.bak` that still held everything.
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));
		const before = readFileSync(file, 'utf8');

		// The write lands in a directory that has been made unwritable by replacing
		// it with something that is not a directory — the simplest reliable failure.
		const restoring = service();
		const original = writeFileSync;
		void original;

		// Force `writeEnvelope` to fail by holding the temp path open as a directory.
		mkdirSync(`${file}.tmp`, { recursive: true });
		try {
			await expect(restoring.restoreFromBackup(PASS)).rejects.toThrow();
		} finally {
			rmSync(`${file}.tmp`, { recursive: true, force: true });
		}

		// The vault is exactly as it was, and still opens.
		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(readdirSync(dir).filter((name) => name.includes('superseded'))).toHaveLength(0);
		const reopened = service();
		await reopened.unlock(PASS);
		expect(reopened.read().accounts).toHaveLength(1);
	});

	it('refuses a wrong passphrase without touching anything', async () => {
		// Decryption comes first precisely so a typo cannot cost the current vault.
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));
		const before = readFileSync(file, 'utf8');

		await expect(service().restoreFromBackup('not the passphrase')).rejects.toThrow();

		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(readdirSync(dir).filter((name) => name.includes('superseded'))).toHaveLength(0);
	});

	it('says so plainly when there is no backup at all', async () => {
		const v = service();
		await v.create(PASS);

		await expect(v.restoreFromBackup(PASS)).rejects.toThrow(/no backup/);
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
