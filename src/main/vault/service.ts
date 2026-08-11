import { randomBytes } from 'node:crypto';
import { deriveKey, sealWithKey, unseal, VaultCryptoError, wipe } from './crypto';
import {
	putBack,
	readBackupEnvelope,
	readEnvelope,
	setAside,
	vaultExists,
	writeEnvelope
} from './storage';
import { SALT_BYTES, SCRYPT_DEFAULTS, type Envelope, type Kdf } from '../../shared/vault-format';
import {
	emptyVault,
	passphraseProblem,
	vaultContentsSchema,
	type VaultContents,
	type VaultSettings
} from '../../shared/vault-schema';

/**
 * The vault session: unlock, mutate, save, lock (§12 F1).
 *
 * Deliberately free of any `electron` import. The lifecycle rules here are worth
 * testing directly, and a module that can only run inside a live Electron app is
 * a module whose auto-lock behaviour gets verified by clicking around.
 *
 * Time is injected rather than read from `Date.now()` so idle expiry can be
 * tested without waiting ten real minutes — the alternative is a test that fakes
 * timers, which tends to prove the mock works rather than the code.
 */

export class VaultLockedError extends Error {
	constructor(message = 'the vault is locked') {
		super(message);
		this.name = 'VaultLockedError';
	}
}

export class VaultServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VaultServiceError';
	}
}

export type LockReason = 'manual' | 'idle' | 'suspend' | 'shutdown';

export interface VaultServiceOptions {
	file: string;
	/** Injected for testability. Defaults to the wall clock. */
	now?: () => number;
	/** Called whenever the vault locks, so the UI and pollers can react. */
	onLock?: (reason: LockReason) => void;
}

interface UnlockedState {
	contents: VaultContents;
	key: Buffer;
	kdf: Kdf;
	lastActivity: number;
}

export class VaultService {
	private readonly file: string;
	private readonly now: () => number;
	private readonly onLock: (reason: LockReason) => void;
	private state: UnlockedState | undefined;

	constructor(options: VaultServiceOptions) {
		this.file = options.file;
		this.now = options.now ?? (() => Date.now());
		this.onLock = options.onLock ?? (() => undefined);
	}

	exists(): boolean {
		return vaultExists(this.file);
	}

	isUnlocked(): boolean {
		return this.state !== undefined;
	}

	/**
	 * Create a brand-new vault.
	 *
	 * Refuses if one already exists. Overwriting would destroy every secret in it,
	 * and "create" is not a word anyone expects to be destructive.
	 */
	async create(passphrase: string): Promise<void> {
		if (this.exists()) {
			throw new VaultServiceError(
				'a vault already exists at this location; refusing to overwrite it'
			);
		}
		const problem = passphraseProblem(passphrase);
		if (problem) {
			throw new VaultServiceError(problem);
		}

		const salt = randomBytes(SALT_BYTES);
		const kdf: Kdf = {
			type: 'scrypt',
			N: SCRYPT_DEFAULTS.N,
			r: SCRYPT_DEFAULTS.r,
			p: SCRYPT_DEFAULTS.p,
			salt: salt.toString('base64')
		};

		const contents = emptyVault(new Date(this.now()));
		const key = await deriveKey(passphrase, salt, kdf);
		try {
			writeEnvelope(this.file, sealWithKey(JSON.stringify(contents), key, kdf));
		} catch (err) {
			wipe(key);
			throw err;
		}

		// Leave it unlocked: the user just proved they know the passphrase, and
		// making them immediately retype it teaches nothing.
		this.state = { contents, key, kdf, lastActivity: this.now() };
	}

	/** Unlock an existing vault. */
	async unlock(passphrase: string): Promise<void> {
		if (!this.exists()) {
			throw new VaultServiceError('there is no vault at this location yet');
		}

		const envelope = readEnvelope(this.file);
		const { plaintext, key, kdf } = await unseal(envelope, passphrase);

		let contents: VaultContents;
		try {
			contents = vaultContentsSchema.parse(JSON.parse(plaintext));
		} catch (err) {
			// Decryption succeeded, so the passphrase was right and the file is
			// authentic — the contents are simply not a shape we understand.
			wipe(key);
			throw new VaultServiceError(
				`the vault decrypted but its contents are not valid: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}

		// Unlocking while already unlocked would otherwise drop the previous key on
		// the floor: `wipe` never runs on it, so a derived key stays in memory
		// un-zeroed until collection. Reachable from a double-submitted unlock, and
		// zeroing key material is the whole reason `wipe` exists.
		if (this.state) {
			wipe(this.state.key);
		}

		this.state = { contents, key, kdf, lastActivity: this.now() };
	}

	/**
	 * Lock, dropping every decrypted secret.
	 *
	 * The derived key is zeroed. The decrypted contents are dropped by reference:
	 * JavaScript strings are immutable, so the secrets inside them survive until
	 * garbage collection. That is a real limit, stated rather than papered over —
	 * an attacker who can read our memory is explicitly outside the threat model.
	 */
	lock(reason: LockReason = 'manual'): void {
		if (!this.state) {
			return;
		}
		wipe(this.state.key);
		this.state = undefined;
		this.onLock(reason);
	}

	/**
	 * A snapshot of the vault. Throws when locked.
	 *
	 * A **copy**, not the live object. Returning the internal reference let any
	 * caller edit stored state without going through `mutate` — bypassing schema
	 * validation, the sequence bump, and the write itself, leaving memory and disk
	 * silently disagreeing. The vault holds tens of accounts, so the clone is not
	 * worth optimising away.
	 */
	read(): VaultContents {
		return structuredClone(this.require().contents);
	}

	/**
	 * Just the settings. Throws when locked.
	 *
	 * `read()` deep-clones the whole vault, which means every shared secret,
	 * identity secret and revocation code is copied into fresh strings. Doing that
	 * to look up one number leaves a pile of secret-bearing garbage on the heap for
	 * no reason — and §11 already admits that strings survive until collection, so
	 * multiplying the copies makes a limit we acknowledge measurably worse.
	 *
	 * Settings hold nothing sensitive, so this clone is cheap and harmless.
	 */
	settings(): VaultSettings {
		return structuredClone(this.require().contents.settings);
	}

	/** Record user activity, deferring the idle auto-lock. */
	touch(): void {
		if (this.state) {
			this.state.lastActivity = this.now();
		}
	}

	/** Milliseconds until idle auto-lock, or undefined when locked. */
	msUntilAutoLock(): number | undefined {
		if (!this.state) {
			return undefined;
		}
		const timeout = this.state.contents.settings.autoLockMinutes * 60_000;
		return Math.max(0, this.state.lastActivity + timeout - this.now());
	}

	/**
	 * Lock if the idle timeout has elapsed.
	 *
	 * Polled by the main process rather than driven by a `setTimeout`, so a
	 * settings change takes effect immediately and a suspended machine cannot
	 * carry a stale timer across the gap.
	 */
	enforceAutoLock(): boolean {
		if (this.state && this.msUntilAutoLock() === 0) {
			this.lock('idle');
			return true;
		}
		return false;
	}

	/**
	 * Apply a change and save it.
	 *
	 * The mutation runs against a deep copy, and the result is validated before
	 * anything reaches disk. If validation or the write fails, the in-memory vault
	 * is left exactly as it was — a half-applied change that only exists in memory
	 * is worse than a rejected one, because the next save would persist it.
	 *
	 * Async despite having nothing to await: sealing is synchronous now that the
	 * key is derived at unlock, but the whole vault API is promise-based and the
	 * file I/O here should become async. Making this the one synchronous method
	 * would churn every call site later for no gain today.
	 */
	// eslint-disable-next-line @typescript-eslint/require-await -- see above
	async mutate(change: (draft: VaultContents) => void): Promise<void> {
		const state = this.require();

		const draft = structuredClone(state.contents);
		change(draft);

		draft.seq = state.contents.seq + 1;
		draft.updatedAt = new Date(this.now()).toISOString();

		const validated = vaultContentsSchema.parse(draft);
		writeEnvelope(this.file, sealWithKey(JSON.stringify(validated), state.key, state.kdf));

		state.contents = validated;
		state.lastActivity = this.now();
	}

	/**
	 * Change the passphrase: re-derive with a **fresh salt** and re-seal.
	 *
	 * A new salt matters. Keeping the old one would mean an attacker who captured
	 * the file before the change could tell whether the passphrase changed at all,
	 * and it would reuse a salt across two different secrets.
	 */
	async changePassphrase(current: string, next: string): Promise<void> {
		const state = this.require();

		const problem = passphraseProblem(next);
		if (problem) {
			throw new VaultServiceError(problem);
		}

		// Verify the current passphrase against the file rather than trusting that
		// the session is unlocked — an unattended unlocked machine must not be
		// enough to lock the real owner out.
		const envelope = readEnvelope(this.file);
		const verification = await unseal(envelope, current).catch(() => undefined);
		if (!verification) {
			throw new VaultServiceError('the current passphrase is not correct');
		}
		wipe(verification.key);

		const salt = randomBytes(SALT_BYTES);
		const kdf: Kdf = {
			type: 'scrypt',
			N: SCRYPT_DEFAULTS.N,
			r: SCRYPT_DEFAULTS.r,
			p: SCRYPT_DEFAULTS.p,
			salt: salt.toString('base64')
		};

		const newKey = await deriveKey(next, salt, kdf);

		// **Everything below reads state only after the derivation, never before.**
		//
		// `deriveKey` is scrypt at the shipping work factor — the better part of a
		// second, deliberately. `mutate` is synchronous once it has the state, so
		// anything that wrote during that second completed in full: an account
		// enrolled, a refresh token stored, an import committed. Snapshotting
		// `contents` before the await and sealing it afterwards silently replaced
		// all of it with the older copy, under the same `seq`, so nothing downstream
		// could even tell a write had been lost.
		//
		// And the vault may not be open any more. The idle timer does not pause for
		// a key derivation, so a lock during it left this holding a detached state
		// object — and it went on to rewrite the file and install a key into an
		// object nobody could reach.
		if (this.state !== state) {
			wipe(newKey);
			throw new VaultLockedError();
		}

		const contents = { ...state.contents, seq: state.contents.seq + 1 };
		contents.updatedAt = new Date(this.now()).toISOString();

		try {
			writeEnvelope(this.file, sealWithKey(JSON.stringify(contents), newKey, kdf));
		} catch (err) {
			wipe(newKey);
			throw err;
		}

		// Swap in the new key only once the write has succeeded.
		wipe(state.key);
		state.key = newKey;
		state.kdf = kdf;
		state.contents = contents;
		state.lastActivity = this.now();
	}

	/**
	 * Prove knowledge of the passphrase against the **stored file**.
	 *
	 * Used to gate actions that being unlocked should not be enough for — revealing
	 * a revocation code, changing the passphrase. Checking the file rather than a
	 * cached key makes it a real proof of knowledge, and the scrypt cost it incurs
	 * is also what makes guessing here pointless.
	 *
	 * Throws the crypto layer's opaque error, so this cannot distinguish a wrong
	 * passphrase from a damaged file.
	 */
	async verifyPassphrase(passphrase: string): Promise<void> {
		if (!this.state) {
			throw new VaultLockedError();
		}
		const envelope = readEnvelope(this.file);
		const result = await unseal(envelope, passphrase);
		// Only the proof was wanted; the key is discarded immediately.
		wipe(result.key);
	}

	/**
	 * The backup envelope, for the corruption-recovery path (§12 F1).
	 *
	 * Deliberately not automatic: silently loading an older vault would resurrect
	 * accounts the user removed, or roll back one they believe is saved. The user
	 * is told what happened and chooses.
	 */
	/**
	 * Seal arbitrary content under the vault's current key.
	 *
	 * Used for the per-account recovery file written at enrollment. The envelope
	 * carries its own salt and KDF parameters, so it is **self-contained**:
	 * anybody with the passphrase can open it on any machine, without this vault.
	 * That is the whole point — the file has to survive the vault it came from
	 * being deleted, corrupted, or left on a dead disk.
	 *
	 * The key is reused rather than re-derived because the passphrase is not kept
	 * in memory; only the key and the salt that produced it are. Reuse is safe
	 * here because `sealWithKey` takes a fresh nonce every time, which is the part
	 * that must never repeat under one key.
	 */
	sealForBackup(plaintext: string): Envelope {
		const state = this.state;
		if (!state) {
			throw new VaultLockedError();
		}
		return sealWithKey(plaintext, state.key, state.kdf);
	}

	/**
	 * Adopt a vault file the user has somewhere else (§12 F1).
	 *
	 * The gap this closes: with no `vault.json` **and** no `vault.json.bak`, the
	 * app offers to create a vault and nothing else — even to somebody holding a
	 * perfectly good copy of theirs on a USB stick or from another machine. The
	 * only route was to know the data directory, know the filename, and put it
	 * there by hand.
	 *
	 * Refuses outright when a vault already exists. This writes to the one path the
	 * whole application is built around, and "replace my vault with this file" is a
	 * different and far more dangerous request than "I have no vault, here is one".
	 * Only the second is offered.
	 *
	 * The file is parsed before it is written, so a mistaken pick fails without
	 * touching anything. It is not decrypted: this says nothing about whether the
	 * passphrase is right, only that the file is a vault. Unlocking answers the
	 * rest, which is the screen the user lands on next.
	 */
	adoptFrom(path: string): void {
		if (this.exists()) {
			throw new VaultServiceError(
				'there is already a vault on this machine, so this will not replace it'
			);
		}

		let envelope: Envelope;
		try {
			envelope = readEnvelope(path);
		} catch {
			throw new VaultServiceError('that file is not a vault this app can read');
		}

		writeEnvelope(this.file, envelope);
	}

	backupAvailable(): Envelope | undefined {
		return readBackupEnvelope(this.file);
	}

	/**
	 * Open the backup vault and make it the live one (§12 F1).
	 *
	 * ## The dead end this closes
	 *
	 * `writeEnvelope` keeps the previous good vault as `.bak`, and the unlock
	 * screen has always announced it — "a backup of the previous vault is on disk;
	 * it is never loaded automatically". That sentence implies a deliberate load is
	 * possible. **It was not.** `backupAvailable` was read to produce a boolean and
	 * nothing else, there was no channel and no service method, and `unlock` reads
	 * the main file unconditionally.
	 *
	 * So a corrupted vault file was a total lockout — every account, every
	 * revocation code — while a perfectly good copy sat beside it and the screen
	 * said so.
	 *
	 * ## Order of operations
	 *
	 * The backup is decrypted **before** anything on disk is touched. That proves
	 * both the passphrase and the file in one step, so a wrong passphrase cannot
	 * cost the current vault, and a backup that is itself damaged fails harmlessly.
	 *
	 * The file being replaced is then kept, not deleted. It may be corrupt, or it
	 * may be a perfectly good vault the user has rolled back by mistake — and this
	 * class does not get to decide that a file holding revocation codes is
	 * disposable.
	 */
	async restoreFromBackup(passphrase: string): Promise<void> {
		const envelope = readBackupEnvelope(this.file);
		if (!envelope) {
			throw new VaultServiceError('there is no backup vault to restore from');
		}

		// Proves the passphrase and the file before a byte is written.
		const { plaintext, key, kdf } = await unseal(envelope, passphrase);

		let contents: VaultContents;
		try {
			contents = vaultContentsSchema.parse(JSON.parse(plaintext));
		} catch (err) {
			wipe(key);
			throw new VaultServiceError(
				`the backup decrypted but its contents are not valid: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}

		// The underlying error is not forwarded: Node embeds the absolute path in
		// every filesystem failure, and these messages reach the renderer.
		let moved: string | undefined;
		try {
			moved = setAside(this.file);
		} catch {
			wipe(key);
			throw new VaultServiceError(
				'the current vault file could not be set aside, so nothing was replaced.'
			);
		}

		try {
			writeEnvelope(this.file, envelope);
		} catch {
			// **Put the old file back.** `writeEnvelope` rolls back from `.bak` only
			// when a main file existed when it started, and `setAside` has just made
			// sure one does not — so its rollback does nothing here. Left as it was,
			// a failed restore leaves no `vault.json` at all: the app reads that as a
			// fresh install and offers to create one, and the second save of that new
			// vault would copy it over the `.bak` that still held everything.
			if (moved) {
				putBack(moved, this.file);
			}
			wipe(key);
			throw new VaultServiceError(
				'the backup could not be written into place, so nothing was changed. Your vault file ' +
					'is as it was.'
			);
		}

		if (this.state) {
			wipe(this.state.key);
		}
		this.state = { contents, key, kdf, lastActivity: this.now() };
	}

	private require(): UnlockedState {
		if (!this.state) {
			throw new VaultLockedError();
		}
		return this.state;
	}
}

export { VaultCryptoError };
