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
import { newAutoConfirm } from '../../shared/vault-schema';
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

/**
 * A proxy destination an import is about to adopt, on its way to a consent
 * dialog.
 *
 * This type is the one place a proxy URL from a maFile leaves this module, and
 * it goes to the **main** process — `import/ipc.ts`, which hands it straight to
 * `ProxyConsent.require`. It is not, and must never become, part of anything the
 * renderer receives: `ImportCandidate` deliberately carries `hasProxy` and not
 * the address, because a proxy URL routinely embeds a username and password.
 */
export interface ProxyAdoption {
	/** The whole address, credentials included. `planProxy` has already accepted it. */
	proxyUrl: string;
	/** Whose traffic this would be, so the dialog can name somebody. */
	accountName: string;
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
	/**
	 * Called for each account this import newly stored.
	 *
	 * Exists so an imported account gets the same recovery file an enrolled one
	 * gets. Only enrollment wrote one, which left every imported account with no
	 * safety net at all: delete the maFile it came from, then remove the account,
	 * and its shared secret and revocation code are gone — the exact accident the
	 * recovery file was built for, on the accounts most likely to hit it.
	 *
	 * Not called for a **replace**. A recovery file already exists for that
	 * account, `writeRecoveryFile` refuses to overwrite one, and a second copy per
	 * re-import would pile up files that make the real one harder to identify.
	 */
	onAccountStored?: (account: Account) => void;
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
	private readonly onAccountStored: (account: Account) => void;
	private staged: StagedEntry[] = [];
	private stagedAt = 0;

	/**
	 * The last discard was the expiry sweep, not the user.
	 *
	 * Set only by `enforceExpiry`, cleared by every other discard. Without it, a
	 * passphrase typed a moment after the sweep was answered with "none of the
	 * chosen files are encrypted" — true of the emptied arrays, and a lie about
	 * what happened.
	 */
	private tookTooLong = false;
	/** Encrypted files from this scan, awaiting a passphrase. */
	private locked: LockedFile[] = [];
	/** Files rejected during the scan, carried so `unlock` can re-report them. */
	private rejected: ImportReport['rejected'] = [];

	constructor(vault: VaultService, options: ImportServiceOptions = {}) {
		this.vault = vault;
		this.now = options.now ?? (() => Date.now());
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.onRoutingChanged = options.onRoutingChanged ?? (() => undefined);
		this.onAccountStored = options.onAccountStored ?? ((): void => undefined);
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

		if (this.tookTooLong || this.expired()) {
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
				// Getting here means the bytes decrypted and begin with `{`, and are
				// still not a usable maFile. Two very different things cause that, and
				// the cost of confusing them is not symmetric.
				//
				// **Valid JSON that is not a maFile** is a real file: random bytes are
				// essentially never parseable JSON. The passphrase was right and no
				// amount of retyping will help, so this is final.
				//
				// **Not valid JSON** means a wrong passphrase got past both guards —
				// valid padding *and* a leading brace, roughly one in sixty-five
				// thousand. Rare, but treating it as final would permanently strand a
				// file whose real passphrase the user is about to type, and the stake
				// here is access to a Steam account. So it stays retryable.
				//
				// An earlier version of this branch rejected both outright, on the
				// reasoning that decrypting proves the passphrase — which is exactly
				// the thing an unauthenticated cipher cannot prove.
				if (isJsonObject(plaintext)) {
					failures.push({
						sourceName: file.name,
						reason:
							err instanceof MaFileParseError
								? `it decrypted, but ${err.message}`
								: 'it decrypted, but could not be read as a maFile.'
					});
				} else {
					stillLocked.push({
						...file,
						lastError:
							'this decrypted into something that is not a maFile. Either the passphrase is ' +
							'wrong, or the file is damaged.'
					});
				}
			}
		}

		this.locked = stillLocked;
		// Remembered, not merely reported. These files are gone from `locked`, so
		// only `this.rejected` can carry them into the *next* report — and each
		// passphrase attempt rebuilds the whole report the renderer shows. Keeping
		// them in the local array alone meant a file rejected on the first
		// passphrase vanished from the screen the moment a second passphrase
		// succeeded, and the user imported the rest believing everything was in.
		this.rejected = [...this.rejected, ...failures];
		return this.finish(parsedFiles);
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

		// Pass two: for an account described by more than one chosen file, the best
		// one is the candidate — not whichever the OS happened to list first. See
		// `outranks`.
		const bestForAccount = new Map<string, string>();
		for (const entry of parsedFiles) {
			const steamId64 = entry.parsed.steamId64;
			if (!steamId64 || !entry.usable) {
				continue;
			}
			const incumbentId = bestForAccount.get(steamId64);
			const incumbent = parsedFiles.find((candidate) => candidate.id === incumbentId);
			if (!incumbent || outranks(entry.parsed, incumbent.parsed)) {
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
				} else if (bestForAccount.has(steamId64) && bestForAccount.get(steamId64) !== id) {
					/*
					 * **`has` first, because the map does not hold unusable files at all.**
					 *
					 * Pass two skips every entry with `!entry.usable`, so an unusable file
					 * is never in the map — and `get(...) !== id` is then `undefined !== id`,
					 * which is true. A single damaged file was therefore reported as a
					 * duplicate of a selection containing only itself, and the screen told
					 * the user another file they chose was the same account. They were sent
					 * looking for a duplicate that does not exist instead of being shown the
					 * real reason the row was blocked.
					 */
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

		// **Checked too, and separately.** The shared-secret gate exists so a damaged
		// file is caught here rather than discovered days later as a row that never
		// shows a number. The identity secret had no such check — the schema only
		// asked that it be a non-empty string — so a file with a broken one imported
		// as a perfectly good account, generated codes correctly, and failed at the
		// first confirmation with nothing connecting the two.
		//
		// A warning rather than a refusal, because the two failures are not the same
		// size. No shared secret means the account is inert; no identity secret means
		// codes still work and confirmations do not, which is worth importing and
		// worth saying out loud.
		if (!hasUsableIdentitySecret(parsed)) {
			parsed.warnings.push(
				'The identity secret in this file is not usable. Steam Guard codes will work, but ' +
					'confirmations — approving trades and market listings — will not, until this account ' +
					'is re-imported from a good file.'
			);
		}

		return { id: randomUUID(), name, parsed, usable };
	}

	/**
	 * The staged entries these selections name, or a refusal.
	 *
	 * Pulled out of `commit` because the commit path now has two moments that must
	 * both be sure the staging is still real: once before the proxy dialogs are
	 * raised, and again after they have been answered. Anything asked between
	 * those two points can take arbitrarily long — the question is on screen, in
	 * front of a person — so the second check is not a formality.
	 *
	 * An unknown id means the renderer is working from a stale report: the vault
	 * locked and re-unlocked, or another scan replaced this one. Ids are random
	 * per parse, so "every id is still known" is also what says the entries behind
	 * them are the same files the user reviewed. Applying only the selections we
	 * recognise would import a subset nobody agreed to, so the whole thing is
	 * refused.
	 */
	private requireStaging(selections: ImportSelection[]): Map<string, StagedEntry> {
		if (this.tookTooLong || this.expired()) {
			this.discard();
			throw new ImportError(
				'this import took too long and the files were dropped for safety. Choose them again.'
			);
		}

		const byId = new Map(this.staged.map((entry) => [entry.id, entry]));
		for (const selection of selections) {
			if (!byId.has(selection.stagingId)) {
				throw new ImportError(
					'this import is no longer valid — the files it refers to are gone. Choose them again.'
				);
			}
		}
		return byId;
	}

	/**
	 * For each account these selections name, the one staged file that a commit
	 * would actually write — keyed by SteamID, valued by staging id.
	 *
	 * Files that a commit would refuse outright are left out, so they cannot win a
	 * ranking and thereby suppress a file that *would* have been written: a
	 * damaged shared secret is skipped by name a few lines into the mutation, and
	 * a file with no SteamID has nothing to be stored under.
	 */
	private preferredIds(
		selections: ImportSelection[],
		byId: Map<string, StagedEntry>
	): Map<string, string> {
		const best = new Map<string, StagedEntry>();
		for (const selection of selections) {
			const entry = byId.get(selection.stagingId);
			if (!entry) {
				continue;
			}
			const { parsed } = entry;
			if (parsed.steamId64 === undefined || !isUsableSharedSecret(parsed.sharedSecret)) {
				continue;
			}
			const incumbent = best.get(parsed.steamId64);
			if (!incumbent || outranks(parsed, incumbent.parsed)) {
				best.set(parsed.steamId64, entry);
			}
		}
		return new Map([...best].map(([steamId64, entry]) => [steamId64, entry.id] as const));
	}

	/**
	 * Every proxy destination this commit would newly adopt, deduplicated by
	 * address — so the IPC layer can put each one to the user **before** anything
	 * is written.
	 *
	 * **Import was the fourth way a proxy destination reached the vault, and the
	 * one nobody guarded.** `accountSetProxy`, `enrollmentBegin` and
	 * `transferAuthenticate` all go through `ProxyConsent`, whose whole reason for
	 * existing is that an endpoint adopted unseen becomes the route for every
	 * later Steam request — passwords, Guard codes, session cookies — and the
	 * renderer is not allowed to open one on its own say-so. Ticking "also route
	 * this account through the proxy saved in the file" opened exactly that
	 * channel, and the screen could not even show the address: the candidate
	 * carries `hasProxy`, a boolean, because the URL usually embeds credentials.
	 * So the user adopted a destination they were never shown, chosen by whoever
	 * wrote the maFile.
	 *
	 * Deduplicated by the whole address rather than asked once per file. An SDA
	 * folder is routinely twenty accounts behind one proxy, and twenty identical
	 * dialogs is not twenty decisions — it is one decision and nineteen lessons in
	 * clicking Allow. Skipping the address an account already routes through is
	 * the same argument: there is no decision in a question whose answer changes
	 * nothing.
	 *
	 * Nothing is asked about a file the commit would skip anyway, because a
	 * destination that is never stored was never introduced.
	 */
	proxiesToAdopt(selections: ImportSelection[]): ProxyAdoption[] {
		// The vault has to be open before it can be read for what is already
		// stored, and a locked vault means the person who ticked these boxes is
		// gone — which is not somebody to raise a consent dialog in front of.
		this.assertUnlocked();
		const byId = this.requireStaging(selections);
		const preferred = this.preferredIds(selections, byId);

		const storedProxy = new Map(
			this.vault.read().accounts.map((account) => [account.steamId64, account.proxyUrl] as const)
		);

		const adoptions: ProxyAdoption[] = [];
		const seen = new Set<string>();
		for (const selection of selections) {
			const entry = byId.get(selection.stagingId);
			if (!entry || !selection.adoptProxy) {
				continue;
			}
			const { proxyUrl, steamId64 } = entry.parsed;
			if (proxyUrl === undefined || steamId64 === undefined) {
				continue;
			}
			// Every reason the mutation would skip this file, applied here so the
			// dialog is never raised for a destination that would not be written.
			if (preferred.get(steamId64) !== entry.id) {
				continue;
			}
			if (storedProxy.has(steamId64) && !selection.replaceExisting) {
				continue;
			}
			// Already this account's route, so adopting it introduces nothing.
			if (storedProxy.get(steamId64) === proxyUrl) {
				continue;
			}
			if (seen.has(proxyUrl)) {
				continue;
			}
			seen.add(proxyUrl);
			adoptions.push({ proxyUrl, accountName: entry.parsed.accountName });
		}
		return adoptions;
	}

	/**
	 * Write the chosen candidates into the vault.
	 *
	 * Every selection is applied in a **single** vault mutation, so a vault that
	 * rejects one account does not end up holding a partial import that the user
	 * believes succeeded. Staging is cleared afterwards either way.
	 */
	async commit(selections: ImportSelection[]): Promise<ImportOutcome[]> {
		// **Re-checked here even though `proxiesToAdopt` just checked it.**
		//
		// Between the two calls the IPC layer puts an OS dialog on screen for every
		// proxy this commit would adopt, and a person can leave one of those sitting
		// for as long as they like. The TTL can lapse under it, the vault can lock,
		// another scan can replace the staging — and a commit that trusted the
		// check it made before the dialog would then write files nobody validated.
		// See `requireStaging`.
		const byId = this.requireStaging(selections);

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
		/*
		 * **And the credentials, because a replacement can keep the same proxy.**
		 *
		 * The teardown below was fired only when the proxy URL changed, on the
		 * reasoning that a live session on the right proxy should be left alone.
		 * True as far as it goes — and it misses the case where the *account*
		 * changed underneath a session that is still on the right proxy.
		 *
		 * Re-importing an account whose authenticator was replaced keeps its
		 * cached access token, its pending nonces, its failure count and its
		 * ten-strike halt, all attached to secrets the vault no longer holds. A
		 * halted account stays halted after a successful replacement, which is
		 * exactly the repair somebody performs to fix it.
		 */
		const credentialsBefore = new Map(
			this.vault
				.read()
				.accounts.map(
					(account) =>
						[
							account.steamId64,
							`${account.sharedSecret}|${account.identitySecret}|${account.refreshToken ?? ''}`
						] as const
				)
		);
		const touched = new Set<string>();
		/** Accounts that did not exist before this commit. See `onAccountStored`. */
		const freshlyStored = new Set<string>();
		/**
		 * Replacements whose recovery-critical secrets actually changed.
		 *
		 * A replace can bring a different `sharedSecret`, `identitySecret` or
		 * revocation code — re-enrolling an account and importing the new maFile
		 * does exactly that. The recovery file written at first import still held
		 * the *old* ones and nothing rewrote it, so recovery restored secrets Steam
		 * had already stopped accepting: the mechanism failed at the only moment it
		 * is ever used.
		 *
		 * Tracked separately from `freshlyStored` because most replacements change
		 * nothing that matters here, and a second backup for a renamed account
		 * teaches people to ignore the pile.
		 */
		const secretsChanged = new Set<string>();

		/*
		 * **Which selected file wins, when the selection names one account twice.**
		 *
		 * This loop used to take whichever selection arrived first and skip the
		 * rest, which is `buildReport`'s old file-order bug reached through the
		 * other door: the renderer disables the losing row, but "the renderer
		 * disabled it" is not a reason for the vault to accept whatever order it
		 * was sent. Everything else here is re-derived rather than trusted from the
		 * report — the shared-secret check a few lines down says so in as many
		 * words — and the choice between two copies of an account is exactly the
		 * decision worth re-deriving, because getting it wrong stores a damaged
		 * identity secret and breaks confirmations silently.
		 *
		 * The same `outranks` the report used, so the screen and the write can
		 * never name different winners.
		 */
		const preferred = this.preferredIds(selections, byId);

		try {
			await this.vault.mutate((draft) => {
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

					if (preferred.get(steamId64) !== entry.id) {
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
						const replacement = mergeAccount(existing, parsed, steamId64, selection.adoptProxy);
						if (recoveryCriticalChange(existing, replacement)) {
							secretsChanged.add(steamId64);
						}
						draft.accounts[index] = replacement;
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
					touched.add(steamId64);
					if (index < 0) {
						freshlyStored.add(steamId64);
					}
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
			// Either reason, one teardown. What has to be dropped is the same set
			// in both cases — the session, the nonces, the schedule — and keeping
			// two callbacks in step would be one more thing to get wrong.
			const credentialsAfter = `${after.sharedSecret}|${after.identitySecret}|${after.refreshToken ?? ''}`;
			if (
				proxyBefore.get(steamId64) !== after.proxyUrl ||
				credentialsBefore.get(steamId64) !== credentialsAfter
			) {
				this.onRoutingChanged(steamId64);
			}

			// From the stored account rather than the parsed file, so the backup holds
			// exactly what the vault does. Swallowed on failure for the same reason
			// enrollment swallows it: the account is imported either way, and
			// reporting a failure for something that worked would send the user round
			// again.
			// Also for a replacement that changed the secrets: `writeRecoveryFile`
			// refuses to overwrite and drops a timestamped sibling instead, so the
			// previous enrollment's backup survives beside the new one. Two files and
			// a clear choice beats one file that silently no longer works.
			if (freshlyStored.has(steamId64) || secretsChanged.has(steamId64)) {
				try {
					this.onAccountStored(after);
				} catch {
					// A backup that cannot be written is not a reason to fail an import.
				}
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
		this.tookTooLong = false;
	}

	/**
	 * Drop the staged secrets if their time is up. Polled from the same
	 * once-a-second sweep as the vault's idle lock.
	 *
	 * This is what makes the TTL true. Before it, `expired()` was only ever
	 * *consulted* — the counts reported zero and the next action refused — while
	 * the shared secrets themselves stayed in the arrays until another import ran
	 * or the screen unmounted. A TTL that hides material without dropping it is a
	 * claim, not a control.
	 */
	enforceExpiry(): boolean {
		if (!this.expired()) {
			return false;
		}
		this.discard();
		// After `discard`, which clears it: the flag is what lets the next action
		// explain *why* the files are gone instead of claiming none were chosen.
		this.tookTooLong = true;
		return true;
	}

	/** How many candidates are staged. Zero once expired. */
	stagedCount(): number {
		this.enforceExpiry();
		return this.staged.length;
	}

	/** How many encrypted files are waiting for a passphrase. Zero once expired. */
	lockedCount(): number {
		this.enforceExpiry();
		return this.locked.length;
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
 * Whether text parses as a JSON object.
 *
 * Used to tell a real file apart from a freak decryption collision. Random bytes
 * can begin with `{` about one time in 256; they are essentially never valid
 * JSON, so this is the line between "the passphrase was right and this file is
 * unusable" and "the passphrase was wrong and got lucky twice".
 */
function isJsonObject(text: string): boolean {
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
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
 * Whether this file's identity secret can actually approve a confirmation.
 *
 * The same decoder the shared secret goes through, because it is the same kind
 * of key: twenty bytes, base64 or forty hex characters, and anything else is a
 * string that will HMAC to a signature Steam rejects.
 *
 * Named and exported to one place on purpose. `toEntry` uses it to raise the
 * warning the user reads, and `outranks` uses it to decide which of two files
 * wins — and those two must never be able to disagree about what "damaged"
 * means, because a warning on a row that was silently discarded anyway is worse
 * than no warning at all.
 */
function hasUsableIdentitySecret(parsed: ParsedMaFile): boolean {
	return isUsableSharedSecret(parsed.identitySecret);
}

/**
 * Which of two files describing the same account should be the one imported.
 *
 * **File order used to be the tie-break, and it lost accounts their
 * confirmations.** Ranking was `completeness` alone, compared with a strict
 * `>`, so two files for one account that carried the same fields left the first
 * one the OS happened to list as the candidate and disabled the other as a
 * duplicate. Give the user a damaged copy and a good copy of the same account —
 * exactly what a folder of backups looks like — and if the damaged one sorted
 * first, its unusable identity secret went into the vault. Guard codes still
 * appeared, so nothing looked wrong; every trade and market confirmation failed,
 * days later, on the one feature this product exists for.
 *
 * So usability of the identity secret is the **first** key and file order is not
 * a key at all: a usable secret beats an unusable one whichever way round the
 * two files were listed. `completeness` only decides between two files that
 * agree on that, and its own reason for existing — a backup copy often still
 * carries the revocation code the working copy has had stripped — is unchanged.
 *
 * Ranking a good identity secret above a revocation code is a deliberate trade
 * and the only one available, since the candidate is a whole file rather than a
 * merge of two. An account whose confirmations do not work is broken now; a
 * revocation code is lost only if the account also has to be recovered later,
 * and the losing file is still on disk to be imported afterwards. The warning on
 * the damaged row says which one it is.
 *
 * Strict comparisons throughout, so two files that rank identically leave the
 * incumbent in place and the report keeps naming the same candidate across a
 * re-scan.
 */
function outranks(challenger: ParsedMaFile, incumbent: ParsedMaFile): boolean {
	const challengerIdentity = hasUsableIdentitySecret(challenger);
	if (challengerIdentity !== hasUsableIdentitySecret(incumbent)) {
		return challengerIdentity;
	}
	return completeness(challenger) > completeness(incumbent);
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
		autoConfirm: newAutoConfirm(),
		addedAt: iso
	};
	if (parsed.revocationCode !== undefined) account.revocationCode = parsed.revocationCode;
	if (parsed.deviceId !== undefined) account.deviceId = parsed.deviceId;
	// Carried through so exporting this account again writes the maFile Steam
	// issued rather than one with these fields blanked.
	if (parsed.serialNumber !== undefined) account.serialNumber = parsed.serialNumber;
	if (parsed.tokenGid !== undefined) account.tokenGid = parsed.tokenGid;
	if (parsed.uri !== undefined) account.uri = parsed.uri;
	if (parsed.secret1 !== undefined) account.secret1 = parsed.secret1;
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
/**
 * Whether a replacement invalidates the recovery file written for the old one.
 *
 * Only the three things recovery actually restores. An account renamed, a proxy
 * adopted or a device id filled in leaves the existing backup perfectly usable.
 */
function recoveryCriticalChange(before: Account, after: Account): boolean {
	return (
		before.sharedSecret !== after.sharedSecret ||
		before.identitySecret !== after.identitySecret ||
		before.revocationCode !== after.revocationCode
	);
}

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

	// A replace merges and never subtracts, so a file missing these keeps what the
	// vault already had.
	const serialNumber = parsed.serialNumber ?? existing.serialNumber;
	if (serialNumber !== undefined) merged.serialNumber = serialNumber;
	const tokenGid = parsed.tokenGid ?? existing.tokenGid;
	if (tokenGid !== undefined) merged.tokenGid = tokenGid;
	const uri = parsed.uri ?? existing.uri;
	if (uri !== undefined) merged.uri = uri;
	const secret1 = parsed.secret1 ?? existing.secret1;
	if (secret1 !== undefined) merged.secret1 = secret1;

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
