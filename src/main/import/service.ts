import { randomUUID } from 'node:crypto';
import { MaFileParseError, parseMaFile, type ParsedMaFile } from './mafile';
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
	stage(files: StagedFile[]): ImportReport {
		const existing = new Set(this.vault.read().accounts.map((account) => account.steamId64));

		// Drop the previous staging before parsing, not after: if parsing throws,
		// the old secrets are already gone rather than left behind.
		this.discard();

		const rejected: ImportReport['rejected'] = [];
		const parsedFiles: { id: string; name: string; parsed: ParsedMaFile; usable: boolean }[] = [];

		// Pass one: parse everything. Which file "wins" a repeated account cannot be
		// decided while still reading them, because the answer depends on files not
		// yet seen.
		for (const file of files) {
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

			// Checked here rather than at first use. A secret that cannot produce a
			// code makes the account useless, and discovering that on the account
			// list — days later, as a row that never shows a number — is far worse
			// than being told during the import that the file is damaged.
			const usable = isUsableSharedSecret(parsed.sharedSecret);
			if (!usable) {
				parsed.warnings.push(
					'The shared secret in this file is not usable, so no Steam Guard codes could ever ' +
						'be generated from it. The file is damaged.'
				);
			}

			parsedFiles.push({ id: randomUUID(), name: file.name, parsed, usable });
		}

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
		return { cancelled: false, candidates, rejected };
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
	 * Throw unless the vault can actually receive an import.
	 *
	 * Exists so the IPC layer can check **before** reading anything off disk.
	 * `stage()` discovers a locked vault only after the files have already been
	 * read into memory, and clearing the staging afterwards does not un-read them:
	 * the plaintext of every chosen maFile would have been loaded and then left for
	 * the collector, with nobody present to have authorised it.
	 */
	assertUnlocked(): void {
		if (!this.vault.isUnlocked()) {
			throw new VaultLockedError();
		}
	}

	/** Drop every staged secret. */
	discard(): void {
		this.staged = [];
		this.stagedAt = 0;
	}

	/** How many candidates are staged. Zero once expired. */
	stagedCount(): number {
		return this.expired() ? 0 : this.staged.length;
	}

	private expired(): boolean {
		return this.staged.length > 0 && this.now() - this.stagedAt > this.ttlMs;
	}
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
