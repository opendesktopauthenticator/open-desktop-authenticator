import { randomUUID } from 'node:crypto';
import { MaFileParseError, parseMaFile, type ParsedMaFile } from './mafile';
import {
	decryptSdaMaFile,
	looksEncrypted,
	parseSdaManifest,
	SdaDecryptError,
	type SdaManifestEntry
} from './sda-crypto';
import { isUsableSharedSecret } from '../codes/totp';
import { VaultLockedError, type VaultService } from '../vault/service';
import type { Account } from '../../shared/vault-schema';
import { AUTO_CONFIRM_DEFAULTS } from '../../shared/vault-schema';
import type {
	ImportCandidate,
	ImportOutcome,
	ImportReport,
	ImportSelection
} from '../../shared/ipc';

/**
 * Import staging (§12 F2).
 *
 * Import is two steps on purpose. Parsing a maFile and writing it into the vault
 * are separated by a decision the user has to make — which files, and whether to
 * overwrite an account already stored. Between those two steps the secrets have
 * to live somewhere, and that somewhere is here: **main-process memory, never
 * the renderer, never a temp file.**
 *
 * The staging area is therefore treated as a liability rather than a cache:
 *
 *  - a new scan replaces the previous one outright, so secrets never accumulate;
 *  - it expires, so an abandoned import does not sit in memory until quit;
 *  - it is cleared when the vault locks, because the moment the vault locks the
 *    user is no longer present and staged plaintext should not outlive them;
 *  - it is cleared after a commit, successful or not.
 *
 * Deliberately free of any `electron` import. The file picker and file reading
 * live in the IPC layer, so every rule below is testable without an app.
 */

/** A file the user chose, already read. Reading belongs to the caller. */
export interface StagedFile {
	/** Base name only. The path is never carried past the picker. */
	name: string;
	text: string;
}

interface StagedEntry {
	id: string;
	sourceName: string;
	parsed: ParsedMaFile;
	summary: ImportCandidate;
}

/** A parsed file on its way to becoming a candidate. */
interface ParsedEntry {
	id: string;
	name: string;
	parsed: ParsedMaFile;
	usable: boolean;
}

/**
 * An encrypted maFile waiting for a passphrase.
 *
 * Held rather than rejected so the user gets a passphrase prompt instead of an
 * error, and held as **ciphertext** — the plaintext never exists until they
 * supply the key, so this costs nothing in exposure while the prompt is on
 * screen. It lives under the same TTL and the same clear-on-lock rule as the
 * staged plaintext regardless, because a half-finished import should not
 * outlive the user's attention either way.
 */
interface LockedFile {
	name: string;
	ciphertextBase64: string;
	/** From the manifest entry. Absent when no manifest covered this file. */
	ivBase64?: string;
	saltBase64?: string;
	/**
	 * Why the last attempt failed, shown on the row itself.
	 *
	 * Lives here rather than in the report's `rejected` list because a failed
	 * decryption is retryable, and "Not imported" is where files go when there is
	 * nothing left to do about them.
	 */
	lastError?: string;
}

export interface ImportServiceOptions {
	/** Injected for testability. Defaults to the wall clock. */
	now?: () => number;
	/** How long staged secrets may sit unimported. */
	ttlMs?: number;
	/**
	 * Told when a commit changes an account's stored proxy URL.
	 *
	 * Same seam the settings path uses: the cached Electron session still holds
	 * the old route (and its cookies), and must be dropped before the next Steam
	 * call. Import must not be a back door around that.
	 */
	onRoutingChanged?: (steamId64: string) => void;
}

/** Ten minutes. Long enough to read every warning; short enough to not be a store. */
const DEFAULT_TTL_MS = 10 * 60_000;

export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImportError';
	}
}

export class ImportService {
	private readonly vault: VaultService;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly onRoutingChanged: (steamId64: string) => void;
	private staged: StagedEntry[] = [];
	private stagedAt = 0;
	/** Encrypted files from this scan, awaiting a passphrase. */
	private locked: LockedFile[] = [];
	/** Files rejected during the scan, carried so `unlock` can re-report them. */
	private rejected: ImportReport['rejected'] = [];

	constructor(vault: VaultService, options: ImportServiceOptions = {}) {
		this.vault = vault;
		this.now = options.now ?? (() => Date.now());
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.onRoutingChanged = options.onRoutingChanged ?? (() => undefined);
	}

	/**
	 * Parse chosen files and stage them, replacing anything staged before.
	 *
	 * Reads the vault to spot duplicates, which is also what makes an unlocked
	 * vault a precondition: `read()` throws when locked.
	 */
	stage(files: StagedFile[], unreadable: ImportReport['rejected'] = []): ImportReport {
		// **Before anything is parsed.** This used to happen implicitly, because the
		// vault read that finds duplicates was the first statement in this method.
		// Moving that read into `buildReport` — which runs after parsing — quietly
		// meant every chosen file was decoded into memory *first* and the locked
		// vault discovered afterwards, which is the ordering this class exists to
		// avoid. The check is explicit now so it cannot drift again.
		this.assertUnlocked();

		// Drop the previous staging before parsing, not after: if parsing throws,
		// the old secrets are already gone rather than left behind.
		this.discard();

		const rejected: ImportReport['rejected'] = [...unreadable];
		const parsedFiles: ParsedEntry[] = [];
		const encrypted: StagedFile[] = [];

		// A manifest chosen alongside the maFiles is not an account — it is where SDA
		// keeps the per-file IV and salt. Picked out before anything else, because
		// whether a maFile can be decrypted depends on it. Recognised by its
		// structure rather than by its name, so a copy saved as `manifest (1).json`
		// still works.
		/** Names of the chosen files that turned out to be manifests, not accounts. */
		const manifests = new Set<string>();
		/**
		 * Every manifest's entries, merged and keyed by base name.
		 *
		 * Merged rather than "the first manifest wins" because someone consolidating
		 * two SDA installs will pick both folders' files at once, and the maFiles
		 * covered by the second manifest would otherwise look undecryptable for no
		 * visible reason.
		 */
		const manifestEntries = new Map<string, SdaManifestEntry>();
		for (const file of files) {
			const candidate = parseSdaManifest(file.text);
			if (!candidate) {
				continue;
			}
			manifests.add(file.name);
			for (const entry of candidate.entries) {
				manifestEntries.set(basenameOf(entry.filename).toLowerCase(), entry);
			}
		}

		// Pass one: parse everything. Which file "wins" a repeated account cannot be
		// decided while still reading them, because the answer depends on files not
		// yet seen.
		for (const file of files) {
			if (manifests.has(file.name)) {
				continue;
			}

			// Set aside rather than parsed. `parseMaFile` would reject these as "not
			// JSON", which is true and useless — they are the files of the users who
			// did the responsible thing and turned SDA's encryption on.
			if (looksEncrypted(file.text)) {
				encrypted.push(file);
				continue;
			}

			let parsed: ParsedMaFile;
			try {
				parsed = parseMaFile(file.text, file.name, this.now());
			} catch (err) {
				rejected.push({
					sourceName: file.name,
					reason:
						err instanceof MaFileParseError
							? err.message
							: 'could not be read as a maFile: ' +
								(err instanceof Error ? err.message : String(err))
				});
				continue;
			}

			parsedFiles.push(this.toEntry(file.name, parsed));
		}

		this.locked = encrypted.map((file) => {
			// Keyed by base name because that is all the picker gives us. Two files
			// with the *same* base name chosen from two different SDA folders will
			// therefore share whichever manifest entry was read last, and one of them
			// will fail to decrypt under its own correct passphrase. Rare enough to
			// document rather than solve — solving it would mean carrying paths past
			// the picker, which this module deliberately never does — and the failure
			// is a retryable "did not decrypt", not a wrong import.
			const entry = manifestEntries.get(file.name.toLowerCase());
			const locked: LockedFile = { name: file.name, ciphertextBase64: file.text };
			if (entry?.encryption_iv) locked.ivBase64 = entry.encryption_iv;
			if (entry?.encryption_salt) locked.saltBase64 = entry.encryption_salt;
			return locked;
		});

		this.rejected = rejected;
		return this.finish(parsedFiles);
	}

	/**
	 * Decrypt the encrypted files from this scan and add them to the staging.
	 *
	 * Separate from `stage` because the passphrase cannot be asked for until the
	 * files have been read and found to need one — and re-running the scan to
	 * collect it would mean reopening the file picker and making the user choose
	 * everything a second time.
	 *
	 * Files that decrypt join the candidates; files that do not stay locked, so a
	 * mistyped passphrase can simply be retried. Both can happen in one call: an
	 * SDA folder can hold maFiles encrypted under different passphrases, and
	 * failing the whole batch because one of them belongs to a different key would
	 * be wrong.
	 */
	unlock(passphrase: string): ImportReport {
		// Same reasoning as `stage`, and it was missed here when that one was fixed:
		// without this the files are decrypted first and the locked vault discovered
		// afterwards, in `buildReport`. That turns ciphertext into plaintext for a
		// user who is no longer present — which is the whole thing the check exists
		// to prevent, arrived at by a different door.
		this.assertUnlocked();

		if (this.expired()) {
			this.discard();
			throw new ImportError(
				'this import took too long and the files were dropped for safety. Choose them again.'
			);
		}
		if (this.locked.length === 0) {
			throw new ImportError('none of the chosen files are encrypted.');
		}

		const parsedFiles: ParsedEntry[] = this.staged.map((entry) => ({
			id: entry.id,
			name: entry.sourceName,
			parsed: entry.parsed,
			usable: isUsableSharedSecret(entry.parsed.sharedSecret)
		}));

		const stillLocked: LockedFile[] = [];
		const failures: ImportReport['rejected'] = [];

		for (const file of this.locked) {
			if (!file.ivBase64 || !file.saltBase64) {
				stillLocked.push(file);
				continue;
			}

			let plaintext: string;
			try {
				plaintext = decryptSdaMaFile({
					ciphertextBase64: file.ciphertextBase64,
					passphrase,
					ivBase64: file.ivBase64,
					saltBase64: file.saltBase64
				});
			} catch (err) {
				// **Retryable.** Stays locked with the reason attached to it, rather
				// than also appearing as a rejection: listing one file under both
				// "Encrypted" and "Not imported" told the user, in the same breath,
				// that they could try again and that this file was finished.
				stillLocked.push({
					...file,
					lastError:
						err instanceof SdaDecryptError ? err.message : 'this file could not be decrypted.'
				});
				continue;
			}

			try {
				const parsed = parseMaFile(plaintext, file.name, this.now());
				parsed.warnings.push('This file was encrypted by SDA and was decrypted on import.');
				parsedFiles.push(this.toEntry(file.name, parsed));
			} catch (err) {
				// **Not retryable, and a separate case entirely.** Getting here means
				// the passphrase was *right* — the file decrypted — and what came out
				// is not a usable maFile. Keeping it locked would ask the user to
				// retype a correct passphrase for as long as they were willing to.
				failures.push({
					sourceName: file.name,
					reason:
						err instanceof MaFileParseError
							? `it decrypted, but ${err.message}`
							: 'it decrypted, but could not be read as a maFile.'
				});
			}
		}

		this.locked = stillLocked;
		return this.finish(parsedFiles, failures);
	}

	/**
	 * Build the report, and drop everything if that fails.
	 *
	 * `buildReport` reads the vault, so it throws when the vault locked while the
	 * user was choosing files or typing a passphrase. Without this, that throw left
	 * the parsed secrets and the ciphertext sitting in the fields with nobody
	 * present — the precise condition the staging discipline exists to prevent, and
	 * one that `lockedCount()` hid, because an unset `stagedAt` made it report the
	 * material as already expired.
	 */
	private finish(
		parsedFiles: ParsedEntry[],
		extraRejected: ImportReport['rejected'] = []
	): ImportReport {
		try {
			return this.buildReport(parsedFiles, extraRejected);
		} catch (err) {
			this.discard();
			throw err;
		}
	}

	/**
	 * Turn parsed files into candidates and stage them, replacing the previous
	 * staging.
	 *
	 * Reads the vault to spot duplicates, which is also what makes an unlocked
	 * vault a precondition: `read()` throws when locked.
	 *
	 * Ids are carried in rather than minted here so that unlocking does not
	 * renumber the candidates already on screen — a selection the user made before
	 * typing the passphrase stays valid.
	 */
	private buildReport(
		parsedFiles: ParsedEntry[],
		extraRejected: ImportReport['rejected'] = []
	): ImportReport {
		const existing = new Set(this.vault.read().accounts.map((account) => account.steamId64));

		// Pass two: for an account described by more than one chosen file, the most
		// complete one is the candidate — not whichever the OS happened to list
		// first. See `completeness`.
		const bestForAccount = new Map<string, string>();
		for (const entry of parsedFiles) {
			const steamId64 = entry.parsed.steamId64;
			if (!steamId64 || !entry.usable) {
				continue;
			}
			const incumbentId = bestForAccount.get(steamId64);
			const incumbent = parsedFiles.find((candidate) => candidate.id === incumbentId);
			if (!incumbent || completeness(entry.parsed) > completeness(incumbent.parsed)) {
				bestForAccount.set(steamId64, entry.id);
			}
		}

		const candidates: ImportCandidate[] = [];
		this.staged = [];

		// Pass three: report them in the order they were chosen.
		for (const { id, name, parsed, usable } of parsedFiles) {
			const steamId64 = parsed.steamId64;

			const summary: ImportCandidate = {
				stagingId: id,
				sourceName: name,
				accountName: parsed.accountName,
				hasRevocationCode: parsed.revocationCode !== undefined,
				// Whether routing is configured — never the URL, which carries credentials.
				hasProxy: parsed.proxyUrl !== undefined,
				hasSession: parsed.refreshToken !== undefined,
				// An account with no SteamID has no identity to store under: the vault
				// keys on it, and inventing one would be worse than refusing.
				importable: steamId64 !== undefined && usable,
				warnings: parsed.warnings
			};
			if (steamId64 !== undefined) summary.steamId64 = steamId64;
			if (parsed.steamIdSource !== undefined) summary.steamIdSource = parsed.steamIdSource;

			if (steamId64 !== undefined) {
				if (existing.has(steamId64)) {
					summary.duplicate = 'vault';
				} else if (bestForAccount.get(steamId64) !== id) {
					summary.duplicate = 'selection';
				}
			}

			candidates.push(summary);
			this.staged.push({ id, sourceName: name, parsed, summary });
		}

		this.stagedAt = this.now();
		return {
			cancelled: false,
			candidates,
			rejected: [...this.rejected, ...extraRejected],
			locked: this.locked.map((file) => {
				const entry: ImportReport['locked'][number] = {
					sourceName: file.name,
					// Without an IV and salt there is nothing a passphrase could be applied
					// to. The screen turns this into "also choose manifest.json", which is
					// the actual fix and is not guessable from a decryption failure.
					decryptable: file.ivBase64 !== undefined && file.saltBase64 !== undefined
				};
				if (file.lastError !== undefined) entry.lastError = file.lastError;
				return entry;
			})
		};
	}

	/**
	 * Wrap a parsed file with the one check that decides whether it is worth
	 * importing at all.
	 *
	 * Checked here rather than at first use. A secret that cannot produce a code
	 * makes the account useless, and discovering that on the account list — days
	 * later, as a row that never shows a number — is far worse than being told
	 * during the import that the file is damaged.
	 */
	private toEntry(name: string, parsed: ParsedMaFile): ParsedEntry {
		const usable = isUsableSharedSecret(parsed.sharedSecret);
		if (!usable) {
			parsed.warnings.push(
				'The shared secret in this file is not usable, so no Steam Guard codes could ever ' +
					'be generated from it. The file is damaged.'
			);
		}
		return { id: randomUUID(), name, parsed, usable };
	}

	/**
	 * Write the chosen candidates into the vault.
	 *
	 * Every selection is applied in a **single** vault mutation, so a vault that
	 * rejects one account does not end up holding a partial import that the user
	 * believes succeeded. Staging is cleared afterwards either way.
	 */
	async commit(selections: ImportSelection[]): Promise<ImportOutcome[]> {
		if (this.expired()) {
			this.discard();
			throw new ImportError(
				'this import took too long and the files were dropped for safety. Choose them again.'
			);
		}

		// An unknown id means the renderer is working from a stale report — the
		// vault locked and re-unlocked, or another scan replaced this one. Applying
		// the selections we do recognise would import a subset the user never
		// reviewed, so the whole commit is refused.
		const byId = new Map(this.staged.map((entry) => [entry.id, entry]));
		for (const selection of selections) {
			if (!byId.has(selection.stagingId)) {
				throw new ImportError(
					'this import is no longer valid — the files it refers to are gone. Choose them again.'
				);
			}
		}

		// Nothing selected means nothing to write. Falling through would still call
		// `mutate`, which bumps the sequence, re-seals the whole vault and rotates
		// the backup — a pointless rewrite of the one file that must never be lost.
		if (selections.length === 0) {
			this.discard();
			return [];
		}

		const outcomes: ImportOutcome[] = [];
		const iso = new Date(this.now()).toISOString();
		// Snapshot before the write so we can tell which accounts' routing actually
		// changed — calling `onRoutingChanged` for every import would drop live
		// sessions that are still on the right proxy.
		const proxyBefore = new Map(
			this.vault.read().accounts.map((account) => [account.steamId64, account.proxyUrl] as const)
		);
		const touched = new Set<string>();

		try {
			await this.vault.mutate((draft) => {
				// Rebuilt inside the mutation so the decisions are made against the
				// draft being written, not a snapshot taken before it.
				const committed = new Set<string>();

				for (const selection of selections) {
					const entry = byId.get(selection.stagingId);
					if (!entry) {
						continue;
					}
					const { parsed } = entry;
					const steamId64 = parsed.steamId64;

					if (!steamId64) {
						outcomes.push({
							stagingId: entry.id,
							accountName: parsed.accountName,
							result: 'skipped',
							reason:
								'no SteamID could be determined for this file, so there is nothing to store it under.'
						});
						continue;
					}

					// Re-checked rather than trusted from the report. `importable` was
					// computed here, but the selection comes back from the renderer, and
					// a decision that keeps unusable secrets out of the vault should not
					// depend on the caller having respected a flag.
					if (!isUsableSharedSecret(parsed.sharedSecret)) {
						outcomes.push({
							stagingId: entry.id,
							accountName: parsed.accountName,
							result: 'skipped',
							reason: 'the shared secret in this file is damaged and cannot generate codes.'
						});
						continue;
					}

					if (committed.has(steamId64)) {
						outcomes.push({
							stagingId: entry.id,
							accountName: parsed.accountName,
							result: 'skipped',
							reason: 'another file in this import is the same account.'
						});
						continue;
					}

					const index = draft.accounts.findIndex((account) => account.steamId64 === steamId64);
					if (index >= 0 && !selection.replaceExisting) {
						outcomes.push({
							stagingId: entry.id,
							accountName: parsed.accountName,
							result: 'skipped',
							reason: 'this account is already in the vault.'
						});
						continue;
					}

					if (index >= 0) {
						const existing = draft.accounts[index] as Account;
						draft.accounts[index] = mergeAccount(existing, parsed, steamId64, selection.adoptProxy);
						outcomes.push({
							stagingId: entry.id,
							accountName: parsed.accountName,
							result: 'replaced'
						});
					} else {
						draft.accounts.push(newAccount(parsed, steamId64, iso, selection.adoptProxy));
						outcomes.push({
							stagingId: entry.id,
							accountName: parsed.accountName,
							result: 'imported'
						});
					}
					committed.add(steamId64);
					touched.add(steamId64);
				}
			});
		} finally {
			// The secrets are either in the vault now or were never wanted. Either
			// way they have no business staying in memory.
			this.discard();
		}

		// Only reached when the mutation succeeded: a failure throws through the
		// `finally` above, so there is nothing here for a flag to guard.
		for (const steamId64 of touched) {
			const after = this.vault.read().accounts.find((account) => account.steamId64 === steamId64);
			if (!after) {
				continue;
			}
			if (proxyBefore.get(steamId64) !== after.proxyUrl) {
				this.onRoutingChanged(steamId64);
			}
		}

		return outcomes;
	}

	/**
	 * Throw unless the vault can actually receive an import — **and drop whatever
	 * is staged if it cannot.**
	 *
	 * Exists so the IPC layer can check before reading anything off disk, and so
	 * `stage` and `unlock` can check before parsing or decrypting. Reading files
	 * first and discovering the lock afterwards does not un-read them: the
	 * plaintext of every chosen maFile would have been loaded and then left for the
	 * collector, with nobody present to have authorised it.
	 *
	 * The discard is not redundant with the vault's `onLock` hook. That hook is
	 * wiring — one line in `main/index.ts` that a refactor can drop — whereas a
	 * locked vault seen from in here is proof the user is gone, and anything still
	 * staged has no owner. Holding the invariant locally means it survives the
	 * wiring being wrong.
	 */
	assertUnlocked(): void {
		if (!this.vault.isUnlocked()) {
			this.discard();
			throw new VaultLockedError();
		}
	}

	/** Drop every staged secret. */
	discard(): void {
		this.staged = [];
		this.locked = [];
		this.rejected = [];
		this.stagedAt = 0;
	}

	/** How many candidates are staged. Zero once expired. */
	stagedCount(): number {
		return this.expired() ? 0 : this.staged.length;
	}

	/** How many encrypted files are waiting for a passphrase. Zero once expired. */
	lockedCount(): number {
		return this.expired() ? 0 : this.locked.length;
	}

	/**
	 * The TTL covers **locked files too**, not just staged plaintext.
	 *
	 * Checking `staged` alone left a scan of nothing but encrypted files with an
	 * empty staging area, so it never counted as expired — the ciphertext then sat
	 * in memory until quit, waiting for a passphrase prompt the user had walked
	 * away from an hour earlier.
	 */
	private expired(): boolean {
		const held = this.staged.length + this.locked.length;
		return held > 0 && this.now() - this.stagedAt > this.ttlMs;
	}
}

/**
 * The base name of a path recorded in SDA's manifest.
 *
 * SDA normally stores a bare file name, but installs that have been moved carry
 * a full path — and the picker only ever gives us base names, so the two would
 * never match and every file would look like it had no manifest entry.
 * Deliberately not `path.basename`: this splits on both separators regardless of
 * platform, because a manifest written on Windows can be read on Linux.
 */
function basenameOf(value: string): string {
	const parts = value.split(/[\\/]/);
	return parts[parts.length - 1] ?? value;
}

/**
 * How much an account is worth importing, when two chosen files describe the
 * same one.
 *
 * Order used to decide it: whichever file the OS listed first became the
 * candidate and the other was disabled as a duplicate. That quietly discarded
 * the better file — a backup copy often carries the revocation code that the
 * working copy has had stripped, and losing a revocation code is the one loss
 * that cannot be undone.
 *
 * So completeness decides instead, with the revocation code weighted highest
 * because it is the only irreplaceable field here.
 */
function completeness(parsed: ParsedMaFile): number {
	return (
		(parsed.revocationCode !== undefined ? 4 : 0) +
		(parsed.refreshToken !== undefined ? 2 : 0) +
		(parsed.deviceId !== undefined ? 1 : 0)
	);
}

/**
 * The status a freshly-known account should hold.
 *
 * An account with a revocation code enters `pendingRevocationBackup` so the
 * §11 S12 ceremony still happens — importing a file is not the same as having
 * written the code down. An account *without* one has nothing to back up, so it
 * would sit in that state forever; it becomes active, and the missing code is
 * surfaced as a permanent flag on the account instead.
 */
function statusFor(
	revocationCode: string | undefined,
	backedUpAt: string | undefined,
	fullyEnrolled: boolean | undefined
): Account['status'] {
	if (fullyEnrolled === false) {
		return 'pendingActivation';
	}
	if (revocationCode !== undefined && backedUpAt === undefined) {
		return 'pendingRevocationBackup';
	}
	return 'active';
}

function newAccount(
	parsed: ParsedMaFile,
	steamId64: string,
	iso: string,
	adoptProxy: boolean
): Account {
	const account: Account = {
		steamId64,
		accountName: parsed.accountName,
		sharedSecret: parsed.sharedSecret,
		identitySecret: parsed.identitySecret,
		status: statusFor(parsed.revocationCode, undefined, parsed.fullyEnrolled),
		autoConfirm: { ...AUTO_CONFIRM_DEFAULTS },
		addedAt: iso
	};
	if (parsed.revocationCode !== undefined) account.revocationCode = parsed.revocationCode;
	if (parsed.deviceId !== undefined) account.deviceId = parsed.deviceId;
	if (parsed.refreshToken !== undefined) account.refreshToken = parsed.refreshToken;
	// Only when asked for. A proxy inside a maFile is a fact about the file, not
	// an instruction — see `adoptProxy` in the IPC schema.
	if (adoptProxy && parsed.proxyUrl !== undefined) account.proxyUrl = parsed.proxyUrl;
	return account;
}

/**
 * Replace an existing account from a re-imported file.
 *
 * **A replace merges; it never subtracts.** A maFile written by a tool that
 * strips the revocation code would otherwise delete the only copy of it in
 * existence, and the user asked to re-import an account, not to destroy what the
 * vault already knew about it. So every field the incoming file is silent about
 * keeps its stored value, and settings the user chose in the app — auto-confirm,
 * and the date the account was added — are not the import's to overwrite.
 */
function mergeAccount(
	existing: Account,
	parsed: ParsedMaFile,
	steamId64: string,
	adoptProxy: boolean
): Account {
	const revocationCode = parsed.revocationCode ?? existing.revocationCode;

	// The backup ceremony only counts for the code it was performed on. A file
	// bringing a *different* revocation code means the one the user wrote down is
	// no longer the one stored, so the ceremony is owed again.
	const backedUpAt =
		existing.revocationBackedUpAt !== undefined && existing.revocationCode === revocationCode
			? existing.revocationBackedUpAt
			: undefined;

	// Spread `existing` first so fields written by a newer build survive
	// (accountSchema is passthrough for exactly this reason).
	const merged: Account = {
		...existing,
		steamId64,
		accountName: parsed.accountName,
		sharedSecret: parsed.sharedSecret,
		identitySecret: parsed.identitySecret,
		status: statusFor(revocationCode, backedUpAt, parsed.fullyEnrolled),
		// The user's choice, not the file's.
		autoConfirm: existing.autoConfirm,
		addedAt: existing.addedAt
	};

	if (revocationCode !== undefined) merged.revocationCode = revocationCode;
	else delete merged.revocationCode;

	if (backedUpAt !== undefined) merged.revocationBackedUpAt = backedUpAt;
	else delete merged.revocationBackedUpAt;

	const deviceId = parsed.deviceId ?? existing.deviceId;
	if (deviceId !== undefined) merged.deviceId = deviceId;

	// Declining the file's proxy leaves whatever routing the user set in the app
	// alone — it does not clear it. "Do not adopt this file's proxy" and "switch
	// routing off for this account" are different requests, and the second one has
	// its own screen. Adopting replaces, because that is what adopting means.
	const proxyUrl = (adoptProxy ? parsed.proxyUrl : undefined) ?? existing.proxyUrl;
	if (proxyUrl !== undefined) merged.proxyUrl = proxyUrl;

	const refreshToken = parsed.refreshToken ?? existing.refreshToken;

	// **A session established over one route must not survive onto another.**
	// `applyProxyChange` already deletes the refresh token when routing changes
	// in Settings; an import that adopts a different proxy is the same event
	// arriving by a different door, and it was keeping the token. Steam can link
	// the two addresses through one long-lived session, which is precisely what
	// per-account routing exists to prevent.
	//
	// Signing in again is the cost, and it is the right one: the alternative is a
	// silent, permanent link between the user's old exit and their new one.
	const routeChanged = proxyUrl !== existing.proxyUrl;
	if (refreshToken !== undefined && !routeChanged) {
		merged.refreshToken = refreshToken;
	} else {
		delete merged.refreshToken;
	}

	return merged;
}
