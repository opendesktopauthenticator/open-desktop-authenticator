import { existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { deriveKey, sealWithKey, unseal, VaultCryptoError, wipe } from './crypto';
import {
	clearRotationJournal,
	putBack,
	readBackupEnvelope,
	readRotationJournal,
	readEnvelope,
	restoreEnvelopeInPlace,
	setAside,
	vaultExists,
	VaultStorageError,
	writeBackupEnvelope,
	writeEnvelope,
	writeRotationJournal
} from './storage';
import { SALT_BYTES, SCRYPT_DEFAULTS, type Envelope, type Kdf } from '../../shared/vault-format';
import {
	emptyVault,
	passphraseProblem,
	vaultContentsSchema,
	type NotifyDetail,
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

/**
 * What a caller is told when a lock overtook the work it asked for.
 *
 * Phrased for somebody reading it on screen after waking a machine: the thing
 * they asked for did not finish, nothing is broken, and the passphrase still
 * works. It is not an error in the sense of something having gone wrong.
 */
export const LOCKED_DURING_OPEN =
	'the vault locked while it was being opened, so it was left locked. Enter your passphrase again.';

export interface VaultServiceOptions {
	file: string;
	/** Injected for testability. Defaults to the wall clock. */
	now?: () => number;
	/**
	 * Injected for testability. Defaults to `performance.now()`.
	 *
	 * The idle deadline cannot be trusted to the wall clock alone: setting the
	 * system clock backwards made `lastActivity + timeout - now()` *grow*, so a
	 * one-hour adjustment turned a 30-second deadline into an hour and a half —
	 * and `enforceAutoLock` kept a vault open that everyone believed would lock
	 * itself. A monotonic reading cannot be adjusted.
	 */
	monotonic?: () => number;
	/** Called whenever the vault locks, so the UI and pollers can react. */
	onLock?: (reason: LockReason) => void;
	/**
	 * Called whenever the vault becomes unlocked, for the same reason.
	 *
	 * The asymmetry was the bug. A lock was announced and an unlock was not, so
	 * anything that mirrors the state had to find out by asking - and the tray
	 * menu Linux keeps assigned asks on a 250 ms beat, which left `Lock now`
	 * greyed for a quarter second after the vault opened. A control that is dead
	 * for a moment is worst in exactly the emergency it exists for.
	 */
	onUnlock?: () => void;
}

interface UnlockedState {
	contents: VaultContents;
	key: Buffer;
	kdf: Kdf;
	lastActivity: number;
	/** The same instant on the monotonic clock. See `msUntilAutoLock`. */
	lastActivityMono: number;
}

/** A vault is tens of KB. See `adoptFrom`. */
const MAX_ADOPTABLE_BYTES = 1024 * 1024;

export class VaultService {
	private readonly file: string;
	private readonly now: () => number;
	private readonly monotonic: () => number;
	private readonly onLock: (reason: LockReason) => void;
	private readonly onUnlock: () => void;
	private state: UnlockedState | undefined;

	/**
	 * Bumped by every lock, including one that finds the vault already locked.
	 *
	 * **This is what makes a lock cancel work that is already in flight.** Opening
	 * a vault is deliberately slow — the whole point of the KDF — and for those
	 * seconds there is no state installed. `lock()` returned early in exactly that
	 * window, so a machine suspending mid-unlock cancelled nothing: the derivation
	 * finished afterwards and installed an unlocked vault behind the lock screen.
	 *
	 * An operation captures this before it awaits and checks it after. A changed
	 * value means "something locked while I was working", and the only correct
	 * response is to wipe the key it derived and install nothing.
	 */
	private generation = 0;

	/**
	 * Bumped whenever the vault **file** on disk is replaced. Every time.
	 *
	 * **It used to mean "replaced by something other than an ordinary save",
	 * and that was the defect.** A restore derives a key from the backup's
	 * passphrase, which is slow on purpose, and re-checks this counter before it
	 * swaps the files. An ordinary save landing inside that window — a vault
	 * created, an account added, a passphrase rotated — left the counter
	 * untouched, so the check agreed and the restore moved the *newer* vault
	 * aside and installed the older backup over it. The restore could then fail
	 * for an unrelated reason and tell the user nothing had happened, with the
	 * live vault already rolled back.
	 *
	 * A save is exactly as much a replacement of the file as an adoption is, so
	 * every successful `writeEnvelope` to `this.file` advances this. After the
	 * write, never before: a write that threw replaced nothing.
	 *
	 * **Separate from `generation`, which means "locked".** Restoring is
	 * deliberately allowed to survive a lock that lands during its derivation:
	 * the backup is on disk by then and undoing the swap would be the more
	 * destructive reading. So restore cannot use that counter to detect a file
	 * appearing underneath it, and without a second one it detected nothing at
	 * all — `adoptFrom` writes a vault without opening it, so the `this.state`
	 * check sails past, and the restore then set the just-adopted vault aside and
	 * installed the backup over it. Both operations reported success and the
	 * application opened the older one.
	 */
	private fileGeneration = 0;

	/** Guards `create` against a concurrent second creation. */
	private creating = false;

	/** Guards `changePassphrase` the same way. */
	private changingPassphrase = false;

	/** Guards `unlock` against a concurrent second unlock. */
	private opening = false;

	/**
	 * Whether finishing an interrupted rotation has already been tried and failed.
	 *
	 * `reconcile` runs from `backupAvailable`, which the status poll asks every
	 * second. Without this, a backup write that cannot succeed retried and logged
	 * once a second for the whole session. Cleared by a rotation, which is the one
	 * thing that can make the attempt worth repeating in the same process.
	 */
	private reconcileFailed = false;

	constructor(options: VaultServiceOptions) {
		this.file = options.file;
		this.now = options.now ?? (() => Date.now());
		this.monotonic = options.monotonic ?? (() => performance.now());
		this.onLock = options.onLock ?? (() => undefined);
		this.onUnlock = options.onUnlock ?? (() => undefined);
	}

	/**
	 * Refuse to install state derived before a lock, wiping the key if so.
	 *
	 * Returns true when the caller may proceed. Called immediately before the
	 * assignment to `this.state`, with nothing awaited in between — a check with
	 * an await after it is not a check.
	 */
	private stillCurrent(generation: number, key: Buffer): boolean {
		if (generation === this.generation) {
			return true;
		}
		wipe(key);
		return false;
	}

	/**
	 * Finish a rotation that was interrupted between its two writes.
	 *
	 * **The window this closes.** A rotation writes the vault under the new key
	 * and then re-seals the backup under the same key. Lose power in between and
	 * the vault opens with the new passphrase while `.bak` still opens with the
	 * retired one — which is the hole re-sealing the backup exists to close,
	 * reappearing at the crash boundary rather than at the write. The Settings
	 * screen promises the opposite in as many words.
	 *
	 * The journal holds the finished backup envelope, already sealed under the new
	 * key, so this needs nothing the process no longer has: not the passphrase,
	 * not the old key, not the plaintext. It is safe to run at any time and safe
	 * to run twice — writing the same backup again is the same backup.
	 *
	 * Called at startup, and again before anything that reads or replaces the
	 * backup, so no path can act on one the last rotation was still owed.
	 *
	 * @returns whether an interrupted rotation was finished.
	 */
	reconcile(): boolean {
		/*
		 * **Tried once, not once a second.**
		 *
		 * This is called from `backupAvailable`, which the status poll asks every
		 * second. With a journal on disk and a backup write that keeps failing — a
		 * read-only directory, a share that has gone — that meant a parse, a failed
		 * write and a log line every second for the life of the session. The
		 * journal stays on disk either way, so the next start still tries; what
		 * this drops is retrying that was never going to help.
		 */
		if (this.reconcileFailed) {
			return false;
		}
		const journal = readRotationJournal(this.file);
		if (journal.state === 'none') {
			this.backupSuspect = false;
			return false;
		}
		if (journal.state === 'unreadable') {
			/*
			 * A rotation was interrupted and what it left cannot be read, so the
			 * backup on disk may still open with the retired passphrase and nothing
			 * here can put that right. It is not offered — see `backupSuspect`.
			 */
			this.backupSuspect = true;
			return false;
		}

		/**
		 * **Which side of the gap the crash happened on.**
		 *
		 * The journal is written before either write, so its presence means only
		 * "a rotation started". A crash *before* the vault write leaves the file
		 * under the OLD key — and installing the journal's backup then would put a
		 * new-key copy beside an old-key vault, which is a backup the user's
		 * passphrase cannot open.
		 *
		 * The envelope says which. Both were sealed under the same fresh salt in
		 * the same rotation, so the vault carrying that salt is exactly the
		 * statement "the main write landed". Nothing else has to be recorded.
		 */
		let vaultEnvelope;
		try {
			vaultEnvelope = readEnvelope(this.file);
		} catch {
			this.backupSuspect = true;
			return false;
		}
		const vaultKdf = vaultEnvelope.kdf;
		if (vaultKdf.salt !== journal.backup.kdf.salt) {
			// The rotation never reached the vault. Nothing is owed, and the backup
			// beside it is the one that belongs to the key still in use.
			clearRotationJournal(this.file);
			this.backupSuspect = false;
			return false;
		}

		/*
		 * **A journal that outlived the rotation it recorded.**
		 *
		 * `clearRotationJournal` unlinks and swallows the failure, which is right -
		 * a stale journal was supposed to be re-applied harmlessly. It is not
		 * harmless. The salt check above cannot see the difference, because a
		 * *finished* rotation leaves the vault carrying exactly the salt the journal
		 * names; so after one failed unlink the debt looked owed forever, and the
		 * next start wrote the rotation-era backup over a `.bak` that later saves
		 * had moved on. Measured: two saves after the rotation, and the restorable
		 * backup went from both accounts back to one.
		 *
		 * The backup on disk settles it, and no new bookkeeping is needed to ask.
		 * An unfinished rotation leaves `.bak` holding the copy `writeEnvelope` made
		 * on its way past - the pre-rotation vault, under the RETIRED key, whose
		 * salt is not this one. A finished rotation leaves it under the new key, and
		 * so does every ordinary save after it. So a backup already carrying the
		 * vault's own salt is the statement "this debt was paid", whatever the
		 * journal is still saying.
		 */
		/*
		 * **A nonce settles it outright**, where the salt could not.
		 *
		 * Every seal gets a fresh nonce, so a vault still carrying the one this
		 * rotation wrote is the statement "nothing has been written since". A
		 * different one means a save has landed and the rotation is long finished:
		 * the journal outlived it, and replaying would put a rotation-era backup
		 * over one those saves had moved on.
		 */
		if (journal.vaultNonce !== undefined && vaultEnvelope.cipher.nonce !== journal.vaultNonce) {
			clearRotationJournal(this.file);
			this.backupSuspect = false;
			return false;
		}

		const backupOnDisk = readBackupEnvelope(this.file);
		if (backupOnDisk !== undefined && backupOnDisk.kdf.salt === vaultKdf.salt) {
			clearRotationJournal(this.file);
			this.backupSuspect = false;
			return false;
		}

		/*
		 * **A journal from before the nonce existed, with no backup left to compare
		 * against.**
		 *
		 * The check above needs a readable `.bak`. Without one, and without a
		 * nonce, nothing on disk separates a stale journal from a real debt — so
		 * this does not fabricate an answer. An absent backup already tells the
		 * user there is nothing to restore; standing a possibly-obsolete one in its
		 * place would be a worse kind of nothing.
		 */
		if (backupOnDisk === undefined && journal.vaultNonce === undefined) {
			this.backupSuspect = existsSync(`${this.file}.bak`);
			return false;
		}

		try {
			writeBackupEnvelope(this.file, journal.backup);
		} catch (err) {
			this.backupSuspect = true;
			this.reconcileFailed = true;
			// Left on disk deliberately: the backup is still readable with the
			// retired passphrase and the next start must try again rather than
			// forget. Nothing here is in a position to tell the user, and the vault
			// itself is fine.
			console.error('an interrupted passphrase rotation could not be finished', err);
			return false;
		}
		clearRotationJournal(this.file);
		this.backupCache = undefined;
		this.backupSuspect = false;
		return true;
	}

	/**
	 * Whether the backup on disk may still open with a passphrase that was
	 * retired.
	 *
	 * Set when an interrupted rotation cannot be finished — the journal is
	 * unreadable, or the write to replace the backup failed. The backup file is
	 * still *there* and still parses, so every check that asks "is there a
	 * backup" said yes and the unlock screen went on offering it. Restoring it
	 * would install a vault the retired passphrase opens, which is the state the
	 * whole rotation exists to leave behind.
	 *
	 * Not persisted: the journal on disk is the durable record, and this is only
	 * what this process has already learned from it.
	 */
	private backupSuspect = false;

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
		// One creation at a time. The existence check below runs before a key
		// derivation that takes deliberate seconds, so two concurrent calls both
		// observed "no vault", both derived, and both wrote — the second silently
		// replacing the first, with both callers told their passphrase worked.
		if (this.creating) {
			throw new VaultServiceError('a vault is already being created');
		}
		// **Refused while a session is open.** Reachable when the vault *file* has
		// vanished under an unlocked session: `exists()` says no, the create screen
		// appears, and creating then replaced the live state with an empty vault —
		// without wiping the previous key, losing the in-memory accounts, and
		// setting up the next save to rotate the empty vault over the .bak that
		// still held everything. An open session with a missing file heals itself
		// instead: any save rewrites the file from memory.
		if (this.state) {
			throw new VaultServiceError(
				'the vault is open. Lock it first — creating a new vault would replace the accounts ' +
					'this session is holding.'
			);
		}
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
		const generation = this.generation;
		this.creating = true;
		let key: Buffer;
		try {
			key = await deriveKey(passphrase, salt, kdf);
		} finally {
			this.creating = false;
		}
		// Checked again with the derivation behind us. The guard above stops two
		// calls racing inside this process; a vault that appeared on disk some
		// other way — restored from a backup, another instance — must still not
		// be overwritten by a create that started before it existed.
		if (this.exists()) {
			wipe(key);
			throw new VaultServiceError(
				'a vault appeared at this location while this one was being created; refusing to ' +
					'overwrite it'
			);
		}
		try {
			writeEnvelope(this.file, sealWithKey(JSON.stringify(contents), key, kdf));
			// The file now exists where it did not. A restore deriving against a
			// backup must not conclude the ground has not moved.
			this.fileGeneration += 1;
		} catch (err) {
			wipe(key);
			throw err;
		}

		// The vault file is written either way — it exists on disk and the
		// passphrase opens it. What a lock during the derivation cancels is
		// leaving it *open*, which is the part that matters.
		if (!this.stillCurrent(generation, key)) {
			throw new VaultServiceError(LOCKED_DURING_OPEN);
		}

		// Leave it unlocked: the user just proved they know the passphrase, and
		// making them immediately retype it teaches nothing.
		this.state = {
			contents,
			key,
			kdf,
			lastActivity: this.now(),
			lastActivityMono: this.monotonic()
		};
		this.onUnlock();
	}

	/** Unlock an existing vault. */
	async unlock(passphrase: string): Promise<void> {
		// One at a time, like `create` and the passphrase change. Two concurrent
		// unlocks both read the file, then raced their derivations — and the loser
		// installed the *older* contents over state a mutation had already moved
		// on, so the next save wrote the stale copy back over the newer file. The
		// generation check cannot see this: nothing locked, so nothing bumped it.
		if (this.opening) {
			throw new VaultServiceError('the vault is already being unlocked');
		}
		this.opening = true;
		try {
			await this.unlockOnce(passphrase);
		} finally {
			this.opening = false;
		}
	}

	private async unlockOnce(passphrase: string): Promise<void> {
		if (!this.exists()) {
			throw new VaultServiceError('there is no vault at this location yet');
		}

		const envelope = readEnvelope(this.file);
		const generation = this.generation;
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

		// A lock arrived while the key was being derived — the machine suspended,
		// the idle timer fired, or the user pressed Lock. Install nothing.
		if (!this.stillCurrent(generation, key)) {
			throw new VaultServiceError(LOCKED_DURING_OPEN);
		}

		// Unlocking while already unlocked would otherwise drop the previous key on
		// the floor: `wipe` never runs on it, so a derived key stays in memory
		// un-zeroed until collection. Reachable from a double-submitted unlock, and
		// zeroing key material is the whole reason `wipe` exists.
		if (this.state) {
			wipe(this.state.key);
		}

		this.state = {
			contents,
			key,
			kdf,
			lastActivity: this.now(),
			lastActivityMono: this.monotonic()
		};
		this.onUnlock();
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
		// **Before the early return, always.** A lock that arrives while the vault
		// is still being opened finds no state and used to do nothing at all — so
		// the derivation it was meant to cancel completed a second later and left
		// the vault open behind an OS lock screen. Bumping the generation here is
		// what cancels that work; the early return below only skips the parts that
		// need state to exist.
		this.generation += 1;

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

	/**
	 * Just what the auto-confirm scheduler needs. Throws when locked.
	 *
	 * **Read once a second, for the whole life of an unlocked session.** The
	 * scheduler beats every second and keeps a cached `earliestDueAt` so most
	 * beats can answer "not yet" without asking here — but that cache is only
	 * populated by accounts it has actually scheduled, and the common case is a
	 * vault where nobody has switched auto-confirm on at all. Nothing is
	 * scheduled, so nothing is cached, so the early-out never fires, so every
	 * single beat called `read()` and deep-cloned every shared secret, identity
	 * secret and revocation code in the vault to rediscover that there was
	 * nothing to do.
	 *
	 * The same reasoning as `settings()`, one step further: §11 already admits
	 * that strings survive until collection, and a per-second copy of every
	 * secret the user owns makes an acknowledged limit measurably worse for no
	 * benefit at all.
	 *
	 * What comes back holds no secrets — an account id, a display name, three
	 * switches, an interval and a boolean — so the clone is cheap and there is
	 * nothing here worth protecting. `hasProxy` is deliberately a boolean rather
	 * than the URL: a proxy address carries credentials, and this object is
	 * rebuilt on every beat.
	 *
	 * `notify` is a **fresh object**, not the stored one. Handing out a live
	 * reference into the vault's contents would let a caller write to it, and
	 * everything else here is a primitive that cannot be.
	 */
	autoConfirmSchedule(): {
		steamId64: string;
		/**
		 * For the notification title. Not a secret — it is the name shown on the
		 * accounts list — and the alternative is reaching for `read()`, which is
		 * the whole cost this method exists to avoid.
		 */
		accountName: string;
		marketListings: boolean;
		trades: boolean;
		pollIntervalSeconds: number;
		notify: { enabled: boolean; detail: NotifyDetail };
		/**
		 * Whether a proxy is stored — **not the URL**. The engine only needs to
		 * know whether `Require proxies` would refuse this account, and putting
		 * the address here would put a credentialed URL into an object that is
		 * built on every beat.
		 */
		hasProxy: boolean;
	}[] {
		return this.require().contents.accounts.map((account) => ({
			steamId64: account.steamId64,
			accountName: account.accountName,
			marketListings: account.autoConfirm.marketListings,
			trades: account.autoConfirm.trades,
			pollIntervalSeconds: account.autoConfirm.pollIntervalSeconds,
			notify: {
				enabled: account.autoConfirm.notify.enabled,
				detail: account.autoConfirm.notify.detail
			},
			hasProxy: account.proxyUrl !== undefined && account.proxyUrl !== ''
		}));
	}

	/** Record user activity, deferring the idle auto-lock. */
	touch(): void {
		if (this.state) {
			this.state.lastActivity = this.now();
			this.state.lastActivityMono = this.monotonic();
		}
	}

	/** Milliseconds until idle auto-lock, or undefined when locked. */
	msUntilAutoLock(): number | undefined {
		if (!this.state) {
			return undefined;
		}
		const timeout = this.state.contents.settings.autoLockMinutes * 60_000;
		// **The larger of two elapsed readings.** The wall clock counts time the
		// machine spent suspended, which the monotonic clock may not; the monotonic
		// clock cannot be set backwards, which the wall clock can. Trusting either
		// alone leaves a way to hold the vault open — a backwards adjustment made
		// the wall-clock version report *more* time remaining than the whole
		// timeout. Taking the maximum means a clock game can only ever lock the
		// vault sooner, never later.
		const elapsed = Math.max(
			this.now() - this.state.lastActivity,
			this.monotonic() - this.state.lastActivityMono
		);
		return Math.max(0, timeout - elapsed);
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
		// **Bumped by every write, not only by locks.** `unlockOnce` snapshots the
		// generation before its scrypt and installs `this.state` afterwards if the
		// value still matches. Only `lock` and `restoreFromBackup` moved it, so an
		// unlock racing a *save* passed that check and assigned state read from the
		// envelope before this write — reverting the save in memory and then
		// writing the stale copy back over the file. A save is exactly as much a
		// reason to disown an older open as a lock is.
		this.generation += 1;
		writeEnvelope(this.file, sealWithKey(JSON.stringify(validated), state.key, state.kdf));
		// See `fileGeneration`: a save replaces the file, and a restore in flight
		// has to notice that as surely as it notices an adoption.
		this.fileGeneration += 1;

		state.contents = validated;
		state.lastActivity = this.now();
		state.lastActivityMono = this.monotonic();
	}

	/**
	 * Change the passphrase: re-derive with a **fresh salt** and re-seal.
	 *
	 * A new salt matters. Keeping the old one would mean an attacker who captured
	 * the file before the change could tell whether the passphrase changed at all,
	 * and it would reuse a salt across two different secrets.
	 */
	async changePassphrase(current: string, next: string): Promise<void> {
		// One at a time. Two concurrent changes both verified the same old
		// envelope, both derived, and both reported success — while only whichever
		// wrote the file last had a passphrase that opened it. The other caller
		// walked away believing a passphrase that no longer works.
		if (this.changingPassphrase) {
			throw new VaultServiceError('a passphrase change is already in progress');
		}
		this.changingPassphrase = true;
		try {
			await this.changePassphraseOnce(current, next);
		} finally {
			this.changingPassphrase = false;
		}
	}

	private async changePassphraseOnce(current: string, next: string): Promise<void> {
		const state = this.require();

		const problem = passphraseProblem(next);
		if (problem) {
			throw new VaultServiceError(problem);
		}

		// Verify the current passphrase against the file rather than trusting that
		// the session is unlocked — an unattended unlocked machine must not be
		// enough to lock the real owner out.
		const verification = await unseal(readEnvelope(this.file), current).catch(() => undefined);
		if (!verification) {
			throw new VaultServiceError('the current passphrase is not correct');
		}
		/*
		 * Verification only. Neither the envelope nor the plaintext read here is
		 * carried past this point, and that is the fix rather than an oversight —
		 * see the snapshot below.
		 */
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

		/*
		 * **The snapshot the transaction rolls back to, taken here and not before.**
		 *
		 * The two things this rotation must be able to undo — the file as it stands
		 * and the plaintext to put in the backup — were both read before
		 * `deriveKey`. Everything the comment above says about `contents` applies to
		 * them just as hard, and it was missed: scrypt takes the better part of a
		 * second, a save can complete inside it, and both values then describe a
		 * vault that no longer exists.
		 *
		 * The backup was the mild half — it held a state one save older than the
		 * one it claimed to be preserving. The rollback was not. Restoring the
		 * pre-derivation envelope wrote that older vault back over the file and
		 * destroyed the save that had completed in between, under a message
		 * promising "Nothing was altered".
		 *
		 * From here to the last `writeBackupEnvelope` there is no `await`, so
		 * nothing can interleave: the read, the sealing and both writes are one
		 * synchronous run. `JSON.stringify(state.contents)` is exactly the plaintext
		 * on disk rather than an approximation of it — `mutate` seals that same
		 * string and only then assigns it to `state.contents`.
		 */
		/*
		 * Wrapped, because `newKey` exists by now. `readEnvelope` reads and
		 * validates the file, and it throws — a vault removed under a running
		 * session, a share that dropped, a schema this build cannot parse. Every
		 * other exit past the derivation wipes the key it made; this one was added
		 * later and did not, so the rotation key survived in memory for the life of
		 * the process.
		 */
		let priorEnvelope;
		try {
			priorEnvelope = readEnvelope(this.file);
		} catch (err) {
			wipe(newKey);
			throw err;
		}
		const priorPlaintext = JSON.stringify(state.contents);

		const contents = { ...state.contents, seq: state.contents.seq + 1 };
		contents.updatedAt = new Date(this.now()).toISOString();

		/*
		 * **Both sealed before either is written**, so a sealing failure costs
		 * nothing and the only failures left to handle are on the disk.
		 */
		const rotatedVault = sealWithKey(JSON.stringify(contents), newKey, kdf);
		const rotatedBackup = sealWithKey(priorPlaintext, newKey, kdf);

		/*
		 * **Said before it is done.** The two writes below are not atomic together,
		 * and a crash between them left the vault opening with the new passphrase
		 * while `.bak` still opened with the retired one — the hole re-sealing the
		 * backup exists to close, reappearing at the crash boundary.
		 *
		 * The journal holds the finished backup envelope, already sealed under the
		 * new key, so `reconcile` can complete the rotation on the next start
		 * without the passphrase, the old key or the plaintext.
		 */
		// A new rotation is a new debt, so a previous failure to pay one is not a
		// reason to skip this.
		this.reconcileFailed = false;
		try {
			// The nonce of the vault this rotation is about to write. Fresh for every
			// seal, so a later start can tell "nothing has been written since" from
			// "this debt was paid and the journal outlived it".
			writeRotationJournal(this.file, rotatedBackup, rotatedVault.cipher.nonce);
		} catch (err) {
			wipe(newKey);
			throw err;
		}

		try {
			writeEnvelope(this.file, rotatedVault);
			// A rotation rewrites the file under a new key, which is the case a
			// restore most needs to notice: the backup it holds cannot open it.
			this.fileGeneration += 1;
		} catch (err) {
			/*
			 * **"The write failed" does not always mean the file is unchanged.**
			 *
			 * `writeEnvelope` publishes by rename and verifies afterwards, so a
			 * failure can land with the new-key file already in place; it only tries
			 * to put the old one back, and that can fail too. This branch assumed the
			 * happy version of that in a one-line comment - "Nothing was replaced" -
			 * cleared the journal, wiped the new key, and left the live session
			 * holding the retired one.
			 *
			 * What followed was measured: the file opened only with the NEW
			 * passphrase; one ordinary save from that session re-sealed it with the
			 * OLD key and wrote it back; the new passphrase then stopped working, and
			 * `writeEnvelope` copied the new-key file into `.bak` on its way past. It
			 * is the same defect the backup branch below already carries a long
			 * comment about, in the one place the reasoning was never repeated.
			 *
			 * The session locks rather than adopting anything. Adopting would be a
			 * claim about a file whose write just failed verification, and this is
			 * the one moment in the class where nothing in memory can be trusted
			 * against what is on disk. Locking drops every key, so nothing can write
			 * over it with the wrong one, and the next unlock reads the file and
			 * settles which passphrase it is - which is the question the user
			 * actually has.
			 *
			 * The journal stays. The rotation may be half done, and that is exactly
			 * the debt it exists to record.
			 */
			if (err instanceof VaultStorageError && !err.unchanged) {
				wipe(newKey);
				this.lock('manual');
				throw new VaultServiceError(
					'the passphrase change failed part way through and the previous vault could not be ' +
						'put back, so the vault has been locked. Unlock it with the NEW passphrase; if ' +
						'that is refused, use the old one. Do not delete vault.json.bak.'
				);
			}
			// Nothing was replaced, so there is nothing to finish.
			clearRotationJournal(this.file);
			wipe(newKey);
			throw err;
		}

		/*
		 * **And the backup, in the same breath — or none of it happened.**
		 *
		 * `writeEnvelope` above copied the pre-rotation file into `.bak` on its way
		 * past, which is right for a save and a hole for a rotation: that copy is
		 * sealed under the key the user has just retired. Measured before this:
		 * create a vault, add an account, change the passphrase — the new
		 * passphrase could not restore `vault.json.bak` and **the old one could**,
		 * handing back every account in it. Settings promises the opposite in as
		 * many words.
		 *
		 * The contents are the previous state, re-sealed, so the backup keeps
		 * being what a backup is for while losing the old key entirely.
		 *
		 * If it cannot be written, the rotation is undone rather than left half
		 * done. A vault whose passphrase changed and whose backup did not is the
		 * shape this whole method exists to avoid, and "we changed it but could not
		 * finish" is not something a user can act on.
		 */
		try {
			writeBackupEnvelope(this.file, rotatedBackup);
		} catch (err) {
			try {
				restoreEnvelopeInPlace(this.file, priorEnvelope);
			} catch {
				/*
				 * **Both halves failed, so the rotation stands — and the session has to
				 * be told, not just the user.**
				 *
				 * The file on disk is sealed under the new key and cannot be put back.
				 * This used to wipe `newKey` and throw, leaving the still-unlocked
				 * session holding the *retired* key and the pre-rotation contents. The
				 * next ordinary save — a settings toggle, a refresh token stored by the
				 * confirmation poller, anything at all — then sealed with the old key
				 * and wrote it over the file, and `writeEnvelope` copied the new-key
				 * file into `.bak` on its way past. Both halves of the message below
				 * inverted: the vault opened with the OLD passphrase again and the
				 * backup was the only thing the new one opened. A user who did exactly
				 * what they were told — start using the new passphrase, delete the
				 * backup — was left with neither.
				 *
				 * Two states also shipped as the same `seq`, which
				 * `shared/vault-schema.ts` documents as detecting exactly a rolled-back
				 * write.
				 *
				 * So the session adopts what is on disk. The main vault write
				 * succeeded; only the backup did not, and only the backup is what the
				 * error is about.
				 */
				this.generation += 1;
				wipe(state.key);
				state.key = newKey;
				state.kdf = kdf;
				state.contents = contents;
				state.lastActivity = this.now();
				state.lastActivityMono = this.monotonic();

				throw new VaultServiceError(
					'the passphrase was changed but the backup could not be rewritten, and the backup ' +
						'could not be put back either. Your vault now opens with the NEW passphrase; the ' +
						'backup file still opens with the old one and should be deleted.'
				);
			}
			this.fileGeneration += 1;
			// The rotation was undone, so there is no backup owed.
			clearRotationJournal(this.file);
			wipe(newKey);
			// Logged rather than folded into the message: the user needs the plain
			// sentence, and an EPERM from a backup file is for whoever reads the log.
			console.error('the vault backup could not be rewritten during a rotation', err);
			throw new VaultServiceError(
				'the passphrase was not changed: the backup could not be rewritten, and leaving it ' +
					'readable with the old passphrase would have defeated the change. Nothing was ' +
					'altered — try again.'
			);
		}

		// Both writes landed, so nothing is owed. Deliberately *after* the backup
		// write rather than beside it: a journal cleared early is a rotation this
		// process can no longer finish.
		clearRotationJournal(this.file);

		// Same reasoning as `mutate`: an unlock that began before this rotation
		// must not install the pre-rotation key and contents over it. Without
		// this, `changePassphrase` reported success while the file it left behind
		// still opened only with the old passphrase — the worst shape this class
		// can produce, because the user is invited to discard the one that works.
		this.generation += 1;

		// Swap in the new key only once the write has succeeded.
		wipe(state.key);
		state.key = newKey;
		state.kdf = kdf;
		state.contents = contents;
		state.lastActivity = this.now();
		state.lastActivityMono = this.monotonic();
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
		const state = this.state;
		if (!state) {
			throw new VaultLockedError();
		}
		// Captured before the derivation. `unseal` is a deliberate second of
		// scrypt, and a passphrase change completing inside it retires the very
		// phrase being proved — so a proof that started against the old envelope
		// resolved successfully afterwards, and the caller went on to reveal a
		// revocation code, delete an account, or detach an authenticator on the
		// strength of a password that no longer opens this vault.
		const generation = this.generation;
		const envelope = readEnvelope(this.file);
		const result = await unseal(envelope, passphrase);
		// Only the proof was wanted; the key is discarded immediately.
		wipe(result.key);

		// Every write bumps the generation, and a rotation is a write. A lock
		// bumps it too, which is equally disqualifying: the session this proof was
		// for is gone either way.
		if (this.generation !== generation || this.state !== state) {
			throw new VaultServiceError(
				'the vault changed while this passphrase was being checked, so the check no longer ' +
					'proves anything. Try again.'
			);
		}
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
		// Same reasoning as `create`: with the file gone but the session open, an
		// adopted vault was silently destroyed by the very next save, which sealed
		// the in-memory contents with the in-memory key straight over it.
		if (this.state) {
			throw new VaultServiceError(
				'the vault is open. Lock it first — adopting a file now would be overwritten by ' +
					'the open session’s next save.'
			);
		}
		if (this.exists()) {
			throw new VaultServiceError(
				'there is already a vault on this machine, so this will not replace it'
			);
		}

		// Bounded before it is read. `readEnvelope` pulls the whole file into
		// memory, and the picker will hand this method anything — a vault is tens
		// of kilobytes, so a megabyte separates every real vault from a mis-click
		// on something enormous.
		try {
			if (statSync(path).size > MAX_ADOPTABLE_BYTES) {
				throw new VaultServiceError('that file is far too large to be a vault');
			}
		} catch (err) {
			throw err instanceof VaultServiceError
				? err
				: new VaultServiceError('that file is not a vault this app can read');
		}

		let envelope: Envelope;
		try {
			envelope = readEnvelope(path);
		} catch {
			throw new VaultServiceError('that file is not a vault this app can read');
		}

		writeEnvelope(this.file, envelope);

		// A vault now exists where one did not. Anything that checked for its
		// absence before an await has to find out. See `fileGeneration`.
		this.fileGeneration += 1;
	}

	/**
	 * Cached against the backup file's identity, because the status poll asks
	 * once a second. Uncached, every tick synchronously read and parsed the whole
	 * backup — kilobytes of base64 through JSON.parse and zod, on the main
	 * thread, to answer a boolean that changes a handful of times a session. The
	 * `stat` is the cheap part and is what notices a change.
	 */
	private backupCache: { key: string; envelope: Envelope | undefined } | undefined;

	backupAvailable(): Envelope | undefined {
		// Before answering, so nobody is offered a backup an interrupted rotation
		// had already replaced — that one opens with the retired passphrase.
		this.reconcile();
		if (this.backupSuspect) {
			/*
			 * The rotation could not be finished, so the file on disk is one the
			 * retired passphrase may still open. It parses and it is there, which is
			 * why this used to answer yes; being there is not the question.
			 */
			return undefined;
		}
		let key: string;
		try {
			const stat = statSync(`${this.file}.bak`);
			// `ctimeMs` as well: a file replaced by a rename can land with the mtime
			// it was written with, and the metadata change time moves regardless.
			key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
		} catch {
			this.backupCache = undefined;
			return undefined;
		}

		if (this.backupCache?.key === key) {
			return this.backupCache.envelope;
		}

		const envelope = readBackupEnvelope(this.file);
		/*
		 * **A negative answer is never cached.**
		 *
		 * The key is the file's size and timestamps, which is enough to notice an
		 * ordinary change and not enough to notice every one: a backup that could
		 * not be read, replaced by a good one of the same size in the same
		 * millisecond, kept the same key — and the cached "unavailable" then stood
		 * for the rest of the session, with the unlock screen telling somebody
		 * whose vault would not open that they had no backup.
		 *
		 * Caching only the answer that says a backup *is* there costs one re-read
		 * per poll in the one state that is already broken, and removes the class.
		 */
		this.backupCache = envelope === undefined ? undefined : { key, envelope };
		return envelope;
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
		// The same reason as `backupAvailable`: restoring the backup an interrupted
		// rotation had already replaced would install one the retired passphrase
		// opens, which is the state the rotation existed to leave behind.
		this.reconcile();
		if (this.backupSuspect) {
			throw new VaultServiceError(
				'the backup cannot be restored: a passphrase change was interrupted and could not be ' +
					'finished, so the copy on disk may still open with the passphrase you replaced. ' +
					'Restoring it would undo that change. Your vault itself is unaffected.'
			);
		}
		const envelope = readBackupEnvelope(this.file);
		if (!envelope) {
			throw new VaultServiceError('there is no backup vault to restore from');
		}

		// Proves the passphrase and the file before a byte is written.
		const generation = this.generation;
		// And which vault file this restore was authorised against. See
		// `fileGeneration`.
		const fileGeneration = this.fileGeneration;
		const { plaintext, key, kdf } = await unseal(envelope, passphrase);

		// **Refused while the vault is open** — checked after the derivation, so an
		// unlock that landed during it is caught too, and before `setAside`, so
		// nothing on disk has moved yet. Only the unlock screen offers this, but
		// "only the renderer offers it" is not a control: called while unlocked it
		// would swap the live file out underneath anything mid-write and replace
		// state the user believes is saved with the older copy.
		if (this.state) {
			wipe(key);
			throw new VaultServiceError(
				'the vault is open. Restoring the backup replaces the live vault, so lock it first.'
			);
		}

		/*
		 * **And nothing else replaced the vault file while the key was deriving.**
		 *
		 * The check above catches an unlock, because an unlock installs state.
		 * `adoptFrom` does not: it writes a vault file and leaves it closed. So
		 * adopting a vault during this derivation passed every guard here, and the
		 * restore went on to set the newly adopted vault aside and install the
		 * backup over it — two operations, both reporting success, and the
		 * application then open on the older one. The adopted file survives at its
		 * source, so nothing is destroyed; the user is simply told the wrong thing
		 * about which accounts they are looking at.
		 */
		if (fileGeneration !== this.fileGeneration) {
			wipe(key);
			throw new VaultServiceError(
				'another vault was put in place while the backup was being unlocked, so nothing was ' +
					'replaced. Check which vault you want and try again.'
			);
		}

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

		// **Anything still deriving against the file this replaced is disowned.**
		// An unlock started before the swap holds the pre-restore envelope; letting
		// it finish installed those contents over the restored state — memory then
		// showed the old vault while disk held the new one, and the next save
		// sealed the stale contents straight over the restored file. Bumping the
		// generation here makes that unlock's own `stillCurrent` check refuse, the
		// same way a lock does.
		this.generation += 1;
		// The file is not the one anything earlier was authorised against either.
		this.fileGeneration += 1;

		// The restore itself stands: the backup is on disk and is the vault now.
		// A lock that arrived mid-derivation cancels leaving it open, not the
		// replacement — undoing the file swap here would be the more destructive
		// reading of "lock".
		//
		// `- 1` because the bump above is this restore's own; anything beyond it
		// is a lock that arrived during the derivation.
		if (generation !== this.generation - 1) {
			wipe(key);
			throw new VaultServiceError(LOCKED_DURING_OPEN);
		}

		// No unlocked state can exist here: it was refused above, before the file
		// swap, and `stillCurrent` has just ruled out everything a lock could have
		// interleaved. Installing directly keeps that reasoning checkable in one
		// place.
		this.state = {
			contents,
			key,
			kdf,
			lastActivity: this.now(),
			lastActivityMono: this.monotonic()
		};
		this.onUnlock();
	}

	private require(): UnlockedState {
		if (!this.state) {
			throw new VaultLockedError();
		}
		return this.state;
	}
}

export { VaultCryptoError };
