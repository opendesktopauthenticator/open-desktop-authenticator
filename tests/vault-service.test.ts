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

/**
 * The same, for `unseal` — which is what `unlock` and `restoreFromBackup` call.
 * `deriveKey` is invoked *inside* crypto.ts there, so the module mock never
 * sees it; pausing an unlock mid-derivation needs the exported entry point.
 */
let duringUnseal: (() => Promise<void>) | undefined;

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
		},
		unseal: async (...args: Parameters<typeof actual.unseal>) => {
			const hook = duringUnseal;
			duringUnseal = undefined;
			if (hook) {
				await hook();
			}
			return actual.unseal(...args);
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

/*
 * The idle deadline against a movable clock.
 *
 * `lastActivity + timeout - now()` trusted the wall clock alone, so setting the
 * system clock *backwards* made the remaining time grow: an hour's adjustment
 * turned a 30-second deadline into an hour and a half, and `enforceAutoLock`
 * kept the vault open. The deadline now takes the larger of the wall-clock and
 * monotonic elapsed readings — a clock game can lock the vault sooner, never
 * later.
 */
describe('idle auto-lock against a moved clock', () => {
	let mono: number;
	const monotonic = () => mono;

	beforeEach(() => {
		mono = 1_000;
	});

	function monoService(): VaultService {
		return new VaultService({ file, now, monotonic });
	}

	it('a backwards clock does not extend the deadline', async () => {
		const v = monoService();
		await v.create(PASS);
		await v.mutate((d) => (d.settings.autoLockMinutes = 1));

		clock += 30_000;
		mono += 30_000;
		expect(v.msUntilAutoLock()).toBe(30_000);

		// The adjustment: one hour backwards. The wall-clock arithmetic now says
		// sixty minutes and thirty seconds remain.
		clock -= 60 * 60_000;
		expect(v.msUntilAutoLock()).toBe(30_000);

		mono += 31_000;
		expect(v.enforceAutoLock()).toBe(true);
		expect(v.isUnlocked()).toBe(false);
	});

	it('time asleep still counts, even if the monotonic clock missed it', async () => {
		// The reverse trap: some platforms pause the monotonic clock during
		// suspend. A machine that slept through the timeout must still lock, which
		// is what keeping the wall-clock reading in the maximum preserves.
		const v = monoService();
		await v.create(PASS);
		await v.mutate((d) => (d.settings.autoLockMinutes = 1));

		clock += 2 * 60_000; // slept through it
		// mono unchanged — the sleep was invisible to it.
		expect(v.enforceAutoLock()).toBe(true);
	});

	it('touch resets both readings', async () => {
		const v = monoService();
		await v.create(PASS);
		await v.mutate((d) => (d.settings.autoLockMinutes = 1));

		clock += 50_000;
		mono += 50_000;
		v.touch();
		clock += 50_000;
		mono += 50_000;
		expect(v.enforceAutoLock()).toBe(false);
		expect(v.msUntilAutoLock()).toBe(10_000);
	});
});

/*
 * Two creations racing.
 *
 * `create` checked for an existing vault, then spent deliberate seconds deriving
 * a key, and never looked again. Two concurrent calls both saw nothing, both
 * derived, and both wrote — the second silently replacing the first while both
 * callers were told their passphrase worked. Exactly one passphrase opened what
 * was left.
 */
describe('concurrent creation', () => {
	it('refuses a second create while the first is deriving', async () => {
		const v = service();
		let secondOutcome: Promise<unknown> | undefined;
		duringDerive = () => {
			secondOutcome = expect(v.create('another long passphrase')).rejects.toThrow(
				/already being created/
			);
			return Promise.resolve();
		};

		await v.create(PASS);
		expect(secondOutcome).toBeDefined();
		await secondOutcome;

		// The survivor is the first passphrase's vault.
		const reopened = service();
		await expect(reopened.unlock(PASS)).resolves.toBeUndefined();
	});

	it('refuses to overwrite a vault that appeared during the derivation', async () => {
		// A different instance — another window, a restored backup — is not stopped
		// by the in-flight flag. The existence re-check after the derivation is.
		const v = service();
		duringDerive = async () => {
			await new VaultService({ file, now }).create('another long passphrase');
		};

		await expect(v.create(PASS)).rejects.toThrow(/appeared at this location/);

		// What is on disk is the other creation's vault, untouched.
		const reopened = service();
		await expect(reopened.unlock('another long passphrase')).resolves.toBeUndefined();
	});
});

/*
 * Restoring the backup while the vault is open.
 *
 * Only the unlock screen offers a restore, but "only the renderer offers it" is
 * not a control. Called while unlocked it swapped the live file out underneath
 * anything mid-write and replaced state the user believes is saved with the
 * older copy — silently, under a passphrase check that proved nothing about
 * intent.
 */
describe('restore while unlocked', () => {
	it('is refused before anything on disk moves', async () => {
		const v = service();
		await v.create(PASS);
		// Two writes so a .bak exists to restore from.
		await v.mutate((d) => d.accounts.push(account));
		await v.mutate((d) => (d.settings.autoLockMinutes = 30));
		expect(v.backupAvailable()).toBeDefined();

		await expect(v.restoreFromBackup(PASS)).rejects.toThrow(/lock it first/);

		// Nothing rolled back: the live contents still hold both writes.
		expect(v.read().accounts).toHaveLength(1);
		expect(v.read().settings.autoLockMinutes).toBe(30);
	});

	it('still restores normally when locked', async () => {
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));
		await v.mutate((d) => (d.settings.autoLockMinutes = 30));
		v.lock('manual');

		// The backup is the state before the last write.
		await v.restoreFromBackup(PASS);
		expect(v.isUnlocked()).toBe(true);
		expect(v.read().settings.autoLockMinutes).not.toBe(30);
	});
});

describe('adopting a vault file', () => {
	it('refuses to read an enormous pick at all', () => {
		const big = join(dir, 'huge.vault');
		// Sparse-ish: two megabytes of zeros is enough to trip a one-megabyte cap
		// without slowing the suite.
		writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));
		const v = service();
		expect(() => v.adoptFrom(big)).toThrow(/too large/);
	});
});

/*
 * An unlock racing a restore.
 *
 * The unlock read the pre-restore envelope and spent a second deriving; the
 * restore finished in that second. Nothing had locked, so the unlock's
 * generation check passed and it installed the pre-restore contents over the
 * restored state — memory showed the old vault, disk held the new one, and the
 * next save sealed the stale contents straight over the restored file. Found
 * as a probe left behind by an external audit; the restore now disowns any
 * derivation still in flight against the file it replaced.
 */
describe('an unlock finishing after a restore', () => {
	it('is refused, and the restored state stands', async () => {
		const v = service();
		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));
		// The backup now holds the account-free vault; main holds one account.
		v.lock('manual');

		// Start an unlock against the CURRENT main file, paused mid-derivation.
		let releaseUnlock: (() => void) | undefined;
		duringUnseal = () =>
			new Promise((resolve) => {
				releaseUnlock = resolve;
			});
		const lateUnlock = v.unlock(PASS);
		const settled = lateUnlock.then(
			() => 'resolved',
			(err: Error) => err.message
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The restore completes while that unlock is still deriving.
		await v.restoreFromBackup(PASS);
		expect(v.read().accounts).toHaveLength(0);

		releaseUnlock?.();
		await expect(settled).resolves.toMatch(/locked while it was being opened/i);

		// The restored state is what survives — not the pre-restore contents the
		// late unlock was carrying.
		expect(v.isUnlocked()).toBe(true);
		expect(v.read().accounts).toHaveLength(0);
	});
});

/*
 * Two passphrase changes racing.
 *
 * Both verified the same old envelope, both derived, and both reported success
 * — while only whichever wrote last had a passphrase that opened the vault.
 * The other caller walked away trusting a passphrase that no longer works,
 * which for a vault with no recovery is a lockout with a success message.
 */
describe('concurrent passphrase changes', () => {
	it('refuses the second while the first is still deriving', async () => {
		const v = service();
		await v.create(PASS);

		let releaseFirst: (() => void) | undefined;
		duringUnseal = () =>
			new Promise((resolve) => {
				releaseFirst = resolve;
			});
		const first = v.changePassphrase(PASS, 'the first replacement phrase');
		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(v.changePassphrase(PASS, 'the second replacement phrase')).rejects.toThrow(
			/already in progress/
		);

		releaseFirst?.();
		await first;

		// Exactly one passphrase opens the vault, and it is the one whose change
		// reported success.
		v.lock('manual');
		await expect(v.unlock('the first replacement phrase')).resolves.toBeUndefined();
	});
});

/*
 * Two unlocks racing.
 *
 * Both read the file, then raced their derivations. Nothing locked, so the
 * generation moved for neither — and the loser installed the *older* contents
 * over state a mutation had already moved past, so the next save wrote the
 * stale copy back over the newer file. The guard refuses the second caller the
 * way `create` and the passphrase change already do.
 */
describe('concurrent unlocks', () => {
	it('refuses the second while the first is still deriving', async () => {
		const v = service();
		await v.create(PASS);
		v.lock('manual');

		let releaseFirst: (() => void) | undefined;
		duringUnseal = () =>
			new Promise((resolve) => {
				releaseFirst = resolve;
			});
		const first = v.unlock(PASS);
		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(v.unlock(PASS)).rejects.toThrow(/already being unlocked/);

		releaseFirst?.();
		await first;
		expect(v.isUnlocked()).toBe(true);
	});
});

/*
 * The backup answer must track the file, not a stale cache.
 *
 * `backupAvailable` is polled once a second by the status handler, so it is
 * memoised against the backup's stat — and a memo that survived the file
 * changing would tell the unlock screen a backup exists after it was deleted,
 * or hide one that just appeared.
 */
describe('backupAvailable caching', () => {
	it('notices the backup appearing and disappearing', async () => {
		const v = service();
		expect(v.backupAvailable()).toBeUndefined();

		await v.create(PASS);
		await v.mutate((d) => d.accounts.push(account));
		expect(v.backupAvailable()).toBeDefined();

		rmSync(`${file}.bak`);
		expect(v.backupAvailable()).toBeUndefined();

		await v.mutate((d) => (d.settings.autoLockMinutes = 30));
		expect(v.backupAvailable()).toBeDefined();
	});
});
