import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { maFileName, toMaFile } from '../import/export';
import { DEACTIVATE_ACK, matchesDeactivateAck } from '../../shared/ipc';
import { readRecoveryFile, RecoveryError } from '../vault/recovery';
import type { EnrollmentService } from './enrollment';
import { EnrollmentError } from './enroll';
import { authenticatorFingerprint } from './enrollment';
import type { Account } from '../../shared/vault-schema';
import { PROXY_REQUIRED } from '../net/egress';
import { ProxyConsent } from '../net/proxy-consent';
import { VaultLockedError, type VaultService } from '../vault/service';
import { noOperationJournal, type OperationJournal } from './operation-journal';

/**
 * IPC for enrollment and maFile export (§12 F2, F3).
 *
 * Both surfaces share one rule with import: **no filesystem path crosses IPC in
 * either direction.** The renderer asks for a file to be written, the OS dialog
 * decides where, and the answer is a file name. A full path names the user's
 * machine and their folder layout to a process that has no use for either.
 */

export interface SaveDialog {
	/** Resolves to the chosen path, or undefined if the user cancelled. */
	show(suggestedName: string): Promise<string | undefined>;
}

export interface OpenRecoveryDialog {
	/** Resolves to the file's contents, or undefined if the user cancelled. */
	pick(): Promise<string | undefined>;
}

/**
 * What identifies the authenticator this export is a copy of.
 *
 * Not the account id: an account removed and re-enrolled keeps its SteamID and
 * shares nothing else, and a maFile written from the old secrets would be a
 * backup of something Steam has already stopped accepting.
 */
function fingerprint(account: {
	steamId64: string;
	sharedSecret: string;
	identitySecret: string;
	revocationCode?: string | undefined;
}): string {
	return [
		account.steamId64,
		account.sharedSecret,
		account.identitySecret,
		account.revocationCode ?? ''
	].join('|');
}

/**
 * `rm`, answering whether the file is **gone** — not whether the call was made.
 *
 * `force: true` already treats an absent file as success, so `false` here means
 * one thing only: the file is still on disk. Every rollback in the export below
 * used to write `.catch(() => undefined)` and carry on regardless, which is how
 * a refusal reading "nothing was written" came to be thrown while the plaintext
 * maFile it was talking about sat at the destination.
 */
async function removed(path: string): Promise<boolean> {
	return rm(path, { force: true }).then(
		() => true,
		() => false
	);
}

/**
 * The sentence appended to any refusal whose cleanup did not finish.
 *
 * A maFile is `shared_secret` and `identity_secret` in the clear — the asset
 * this application exists to protect — so a rollback that leaves one behind and
 * still says "nothing was written" is the worst pair available: a real exposure
 * plus a message that stops the user looking for it. Naming the file is the
 * whole remedy, because a file nobody can find is a file nobody deletes.
 *
 * Names, never paths: the rule at the top of this module. "The folder you
 * chose" is as precise as the *where* can honestly get from here — the OS
 * dialog is the only thing that knows the rest — and the name is what the user
 * needs to spot the file once they are looking in it. The set-aside copy in
 * particular carries a random suffix nobody would recognise otherwise.
 */
/**
 * One export at a time per destination path.
 *
 * Every step below — set the old file aside, rename the new one in, check the
 * account is still ours, undo if it is not — is a read-modify-write on one path,
 * spread across four awaits. Two exports aimed at the same file interleaved
 * freely through it, and the outcome was not a lost update but a **deleted**
 * one: export B renamed its file in and answered `saved`, then export A found
 * its own account gone, ran its rollback, and removed the destination. B's file
 * was the one that went, and nothing at either end said so — A reported a
 * refusal it had earned, B reported a success it no longer had.
 *
 * Serialising the whole sequence is the fix rather than a longer chain of
 * checks, because there is no point in the sequence where "is this still mine"
 * can be asked once and stay true.
 *
 * Keyed on the path as the dialog returned it. Two spellings of one path would
 * defeat this, which is why the ownership check below exists as well: it is what
 * catches a writer this map never knew about.
 */
const exportsInFlight = new Map<string, Promise<unknown>>();

/**
 * One key per file, whatever the caller spelled.
 *
 * The key was the string the dialog returned, and on Windows one file has many
 * of those: `out.maFile` and `OUT.MAFILE` are the same NTFS entry, as are a
 * mapped drive and its UNC form, and a path with a trailing separator. Two
 * exports aimed at one file through two spellings took two different locks, ran
 * concurrently, both answered `saved`, and one silently replaced the other —
 * which is the whole of the defect the lock exists to prevent, reached by typing
 * the same thing differently.
 *
 * `resolve` settles separators, `.`, `..` and the trailing slash. The case fold
 * is applied only where the filesystem is case-insensitive: doing it on Linux
 * would merge two genuinely different files into one lock, which is slower than
 * necessary but not wrong — and doing it there is still wrong, because it would
 * make this code claim something about the filesystem that is false.
 *
 * ## And the spellings `resolve` cannot settle
 *
 * `resolve` is textual. It knows nothing about junctions, symlinks, `\\?\`
 * prefixes or 8.3 short names, so `C:/Users/x/Documents/out.maFile` and a
 * junction pointing at that directory stayed two keys for one file — which is
 * the defect this lock exists to prevent, reached by a shortcut somebody made
 * years ago.
 *
 * `realpath` on the destination is the obvious answer and cannot be used: it
 * fails outright when the file does not exist, which is the ordinary case for an
 * export, so it would leave the common path unlocked. The **directory** does
 * exist — the dialog just picked it — so the canonical form of the directory
 * plus the name settles all of that without depending on the file.
 *
 * `.native` rather than plain `realpathSync`, because on Windows only the native
 * call restores the true on-disk case and expands short names. Measured on
 * Windows 11: it resolves a junction to its target and strips a `\\?\` prefix.
 *
 * **What this still does not close**: a mapped drive and its UNC form. `Z:` is a
 * per-session mapping and `realpath` will not turn it into `\\server\share`,
 * so those remain two keys for one file. That is what the content-based
 * ownership check downstream is for — it is what catches a writer this map never
 * knew about, whatever the reason it did not know.
 */
function lockKey(path: string): string {
	const full = resolve(path);
	const name = basename(full);
	let canonical = full;
	if (name !== '') {
		try {
			canonical = join(realpathSync.native(dirname(full)), name);
		} catch {
			/*
			 * No directory, or one that cannot be read. The resolved path is then the
			 * best available and is still better than nothing: an export into a
			 * directory that does not exist is about to fail anyway.
			 */
		}
	}
	return process.platform === 'win32' || process.platform === 'darwin'
		? canonical.toLowerCase()
		: canonical;
}

async function exclusively<T>(rawPath: string, run: () => Promise<T>): Promise<T> {
	const path = lockKey(rawPath);
	const queued = exportsInFlight.get(path) ?? Promise.resolve();
	// Settled either way: a failed export must not wedge the path forever.
	const mine = queued.then(run, run);
	const settled = mine.then(
		() => undefined,
		() => undefined
	);
	exportsInFlight.set(path, settled);
	try {
		return await mine;
	} finally {
		// Only if nobody queued behind us, or the next export clears its own turn.
		if (exportsInFlight.get(path) === settled) {
			exportsInFlight.delete(path);
		}
	}
}

/**
 * Turn a request Steam may already have acted on into an outcome, not an error.
 *
 * **`committed` existed and never left the main process.** An error crosses IPC
 * as a message and nothing else, so the screens received the sentence "do not
 * try again until you have looked at the account", cleared `busy`, and enabled
 * the very button that would send the request a second time. The text forbade
 * the retry the application was offering.
 *
 * Returned rather than thrown for exactly that reason: a thrown error is a
 * failure the screen recovers from by letting the user try again, and this is
 * not one. The guidance travels with it so the screen can show what to do
 * instead of what went wrong.
 *
 * Anything else is rethrown untouched — an ordinary failure is still an ordinary
 * failure, and turning them all into a dead end would be its own defect.
 */
function uncertainOrRethrow(err: unknown): {
	state: 'uncertain';
	guidance: string;
	certain?: boolean;
} {
	if (err instanceof EnrollmentError && err.committed) {
		return err.certain
			? { state: 'uncertain', guidance: err.message, certain: true }
			: { state: 'uncertain', guidance: err.message };
	}
	throw err;
}

function stillOnDisk(names: readonly string[]): string {
	if (names.length === 0) {
		return '';
	}
	const listed = names.map((name) => `"${name}"`).join(' and ');
	return names.length === 1
		? ` The plaintext file ${listed} could not be removed and is still in the folder you chose: it holds this account's shared_secret and identity_secret unencrypted, so delete it yourself.`
		: ` The plaintext files ${listed} could not be removed and are still in the folder you chose: they hold this account's shared_secret and identity_secret unencrypted, so delete them yourself.`;
}

/**
 * The refusal for an export overtaken by a change to the account it copies.
 *
 * The check before the publish and the check after it say the same sentences,
 * so a user who hits the later one is not told something different about the
 * same situation. Neither may claim "nothing was written" once cleanup has left
 * a plaintext file behind: that clause is the one that sends somebody away
 * satisfied, and it was a lie at exactly the moment it mattered.
 */
function raceLost(wasRemoved: boolean, left: readonly string[]): Error {
	const overtaken = wasRemoved
		? 'that account was removed while it was being exported'
		: "that account's authenticator was replaced while it was being exported";
	if (left.length > 0) {
		return new Error(`${overtaken}, so the export was cancelled.${stillOnDisk(left)}`);
	}
	return new Error(
		wasRemoved
			? `${overtaken}, so nothing was written.`
			: `${overtaken}, so nothing was written. Export it again to get the current one.`
	);
}

/**
 * Said when a reconciliation matched nothing by the time it wrote.
 *
 * The identity is re-checked at the moment of the write, so a row replaced
 * inside the window is not acted on — and the caller must not be told the work
 * happened. Reporting success for changing nothing is the defect this whole
 * mechanism keeps producing.
 */
const MOVED_ON =
	'That account changed while this was being resolved, so nothing was altered. Open it again ' +
	'and check what it is waiting on.';

export function registerEnrollmentHandlers(
	enrollment: EnrollmentService,
	vault: VaultService,
	dialog: SaveDialog,
	/** Drops an account's in-memory session, exactly as a local removal does. */
	onRemoved: (steamId64: string) => void = () => undefined,
	recoveryDialog: OpenRecoveryDialog = { pick: () => Promise.resolve(undefined) },
	/** See `ProxyConsent`. Refuses by default when nothing supplies a way to ask. */
	proxyConsent: ProxyConsent = new ProxyConsent(),
	/**
	 * Where an irreversible call is written down **before** it goes.
	 *
	 * Defaults to remembering nothing so the existing call sites keep compiling.
	 * `operation-journal.test.ts` asserts that `index.ts` supplies a real one,
	 * because a dependency that quietly defaults to doing nothing is how
	 * `requireProxies` shipped as a field no code read.
	 */
	journal: OperationJournal = noOperationJournal()
): void {
	/**
	 * Checked before a password is sent anywhere, and before a secret is read.
	 *
	 * Enrolling writes to the vault. Discovering it is locked *after* Steam has
	 * attached an authenticator is the one failure this flow must not have.
	 */
	const requireUnlocked = (): void => {
		if (!vault.isUnlocked()) {
			throw new VaultLockedError();
		}
		// **And count this as activity.** Enrolling has a pause in the middle while
		// the user goes to find an emailed code, and typing into another application
		// is not something the idle timer can see. Without this, the vault could lock
		// partway through the one flow whose failure costs an authenticator — and it
		// would look like the app locking for no reason, because from the user's
		// point of view they had been working the whole time.
		vault.touch();
	};

	registerHandler(CHANNELS.enrollBegin, async ({ accountName, password, proxyUrl }) => {
		requireUnlocked();
		/*
		 * **`Require proxies` reaches this, and it did not.**
		 *
		 * The setting is enforced at `SteamTransportFactory.forAccount`, which
		 * every Steam request crosses — except the ones that do not use a
		 * transport. `steam-session` speaks over Node's own HTTP stack, so an
		 * enrolment sent a password to Steam's login servers from this machine's
		 * own address, on a vault that forbade exactly that.
		 *
		 * There is no stored account to read a proxy from: this is the call that
		 * creates one. So the field on the form is what decides, and empty means
		 * refused rather than "unrouted for now" — an account enrolled from the
		 * user's own address has already told Steam the thing the proxy was for.
		 */
		if (vault.settings().requireProxies && (proxyUrl === undefined || proxyUrl === '')) {
			throw new EnrollmentError(PROXY_REQUIRED);
		}
		/*
		 * **And the address itself needs approving before a password goes down it.**
		 *
		 * There is no stored account to compare against here, so every proxy on
		 * this path is a destination the vault has never seen — which is exactly
		 * the case the gate exists for. The renderer chooses this host, and this
		 * call sends a password and reaches Steam through it; without the gate a
		 * compromised renderer picks the host and gets both the exfiltration
		 * channel and the credential travelling through it.
		 */
		if (proxyUrl !== undefined && proxyUrl !== '') {
			await proxyConsent.require(proxyUrl, { accountName, reason: 'signIn' });
			/*
			 * **And the vault is checked again, because the dialog waits.**
			 *
			 * `requireUnlocked()` above answered for the moment the button was
			 * pressed. Consent is an OS dialog a person can leave on screen
			 * indefinitely, and the vault locks on its own schedule — so without
			 * this, approving after a lock sent the password to Steam for a vault
			 * that had closed, over an endpoint approved by nobody who was there.
			 * The rule is re-asked too: `Require proxies` can be turned on inside
			 * the same wait.
			 */
			requireUnlocked();
			if (vault.settings().requireProxies && (proxyUrl === undefined || proxyUrl === '')) {
				throw new EnrollmentError(PROXY_REQUIRED);
			}
		}
		/*
		 * **The add is irreversible too, and it was the one left out.**
		 *
		 * `enrollActivate` and `accountDeactivate` return their committed failures
		 * as outcomes; this handler returned `enrollment.begin(...)` bare, so a
		 * timeout on `AddAuthenticator` — sent, unanswered — crossed IPC as an
		 * ordinary error and the screen put the form back with the button live. So
		 * did the two branches where Steam is *known* to have attached one.
		 */
		try {
			return await enrollment.begin(accountName, password, proxyUrl);
		} catch (err) {
			return uncertainOrRethrow(err);
		}
	});

	registerHandler(CHANNELS.enrollEmailCode, async ({ code }) => {
		requireUnlocked();
		// The same path: this call finishes the sign-in and goes straight on to
		// `AddAuthenticator`, so every outcome above reaches here too.
		try {
			return await enrollment.submitEmailCode(code);
		} catch (err) {
			return uncertainOrRethrow(err);
		}
	});

	// No `requireUnlocked` here, and that is deliberate: this only drops state we
	// are already holding. Refusing to clean up because the vault happened to lock
	// would leave the live session running for exactly the reason it should not.
	registerHandler(CHANNELS.enrollCancel, () => {
		enrollment.forget();
		return { ok: true as const };
	});

	/**
	 * **The same refusal, written down where it outlives the screen.**
	 *
	 * Returning the outcome stops the screen offering the action again for as
	 * long as that component is mounted, which is not very long: close it, or
	 * restart, and the application offered "Finish activation" or "Remove" again
	 * — having just said, in as many words, that it would not send the request a
	 * second time. A promise that survives only until a re-render is not a
	 * promise.
	 *
	 * Best effort on purpose. The vault write can fail, and if it does the
	 * outcome still has to reach the user: a lost latch costs the durability, and
	 * refusing to answer would cost them the guidance as well.
	 */
	/** The digest of the authenticator currently on an account, or none. */
	function operatedOn(steamId64: string): string {
		const account = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		return account === undefined ? '' : authenticatorFingerprint(account);
	}

	async function latch(
		steamId64: string,
		kind: 'activate' | 'deactivate',
		outcome: { guidance: string; certain?: boolean },
		/**
		 * **The authenticator the operation ran against**, sampled before it ran.
		 *
		 * The record exists to say which authenticator an unfinished operation was
		 * about, and this stamped whatever row was there *afterwards* — by SteamID
		 * alone, after the Steam call had already failed. An import-replace landing
		 * during that call therefore produced a record about the replacement, and
		 * the resolve guard then compared the replacement against itself, agreed,
		 * and let "yes, Steam did it" act on an authenticator the operation never
		 * touched.
		 *
		 * Not a lucky race, either: the import's own commit drops the account's
		 * routing, which aborts the request in flight — so the replace is what
		 * *causes* the uncertain outcome whose record is then mis-stamped.
		 *
		 * `deactivateOnce` captures identity before its Steam call for exactly this
		 * reason, and both reconciliations re-check it at the write. This is the
		 * one path that did neither.
		 */
		fingerprint: string
	): Promise<boolean> {
		/*
		 * **Two facts, and only one of them is "it was written".**
		 *
		 * `updated` says the callback found the row and changed the draft;
		 * `recorded` says the vault write that followed actually landed. Setting
		 * one flag inside the callback conflates them: `mutate` applies the change
		 * to a clone and installs it only once `writeEnvelope` returns, so a
		 * failure *after* the callback discards the draft — and the flag, already
		 * set, would go on claiming the refusal was saved. That is the same false
		 * promise this function exists to stop making, one level down.
		 */
		let updated = false;
		let recorded = false;
		try {
			await vault.mutate((draft) => {
				const account = draft.accounts.find(
					(entry) =>
						entry.steamId64 === steamId64 && authenticatorFingerprint(entry) === fingerprint
				);
				if (account === undefined) {
					// The row this operation was about is gone. There is nothing to
					// record against, and recording against its replacement is the
					// defect the fingerprint argument exists to stop.
					return;
				}
				account.unresolvedOperation = {
					kind,
					guidance: outcome.guidance,
					fingerprint,
					at: new Date().toISOString(),
					...(outcome.certain === true ? { certain: true } : {})
				};
				updated = true;
			});
			// Only now: the write is done.
			recorded = updated;
		} catch (err) {
			console.error('an unresolved Steam operation could not be recorded in the vault', err);
		}
		return recorded;
	}

	/*
	 * **Only the user can settle this.** Nothing local knows what Steam did, so
	 * the latch is cleared by the person saying they have been and looked -
	 * which is also the moment the guidance stops being useful to them.
	 */
	registerHandler(
		CHANNELS.accountResolveOperation,
		async ({ steamId64, kind, steamActed, passphrase }) => {
			requireUnlocked();

			/*
			 * **Three things have to match before this touches anything.**
			 *
			 * The first version took a SteamID and a yes/no, read whichever record
			 * happened to be stored, and acted on it. Every one of those was a way to
			 * act on the wrong thing:
			 *
			 *   - It read the *stored* kind rather than the one the screen asked
			 *     about, so an activation screen answering "yes, Steam Guard is on"
			 *     could resolve a left-over removal record — and "yes" there means
			 *     "the removal succeeded", which deleted the account.
			 *   - It matched on the SteamID alone, and a SteamID outlives the
			 *     authenticator attached to it: a record about a replaced
			 *     authenticator acted on its replacement.
			 *   - It answered `ok` when there was no record at all, so a screen whose
			 *     write had failed reported success for doing nothing.
			 *
			 * All three are refusals now. Nothing here guesses which operation a
			 * person meant.
			 */
			const { account, held, stale } = recordFor(steamId64);

			/*
			 * **A record about an authenticator that is gone is cleared, not refused.**
			 *
			 * Refusing it was the first version, and its message even claimed the
			 * record had been cleared while nothing cleared it — so an account whose
			 * authenticator had been re-imported was blocked from every operation
			 * with no way out of it. There is nothing to reconcile: the thing the
			 * record was about does not exist any more, and what the user needs back
			 * is the account.
			 */
			if (stale) {
				// The note goes with it. A record about an authenticator that no longer
				// exists must not be able to come back from disk after the vault copy
				// is cleared — that is how an account ends up refusing every operation
				// with nothing in the application able to lift it.
				journal.clear(steamId64, 'activate');
				journal.clear(steamId64, 'deactivate');
				await vault.mutate((draft) => {
					const stored = draft.accounts.find((entry) => entry.steamId64 === steamId64);
					if (stored !== undefined) {
						delete stored.unresolvedOperation;
					}
				});
				return { ok: true as const };
			}

			if (account === undefined || held === undefined) {
				throw new EnrollmentError(
					'There is nothing recorded against that account to resolve. It may have been ' +
						'resolved already, or the record was never saved — check the account on Steam ' +
						'before doing anything else here.'
				);
			}
			if (held.kind !== kind) {
				throw new EnrollmentError(
					'That account has a different unfinished operation recorded against it, so this ' +
						'answer does not apply to it. Open the account and resolve the one it is ' +
						'actually waiting on.'
				);
			}

			/*
			 * **The user has answered this operation, so the note is spent.**
			 *
			 * Cleared here, once the three checks above agree the answer is about this
			 * record — and before acting, so that a failure while acting cannot leave
			 * an answered note to be read again on the next start. The vault record,
			 * where there is one, is cleared by the branches below.
			 */
			journal.clear(steamId64, kind);

			if (!steamActed) {
				// Steam did nothing, so the account is what it always was and the
				// operation is worth trying again. Only the refusal is lifted.
				await vault.mutate((draft) => {
					const stored = draft.accounts.find((entry) => entry.steamId64 === steamId64);
					if (stored !== undefined) {
						delete stored.unresolvedOperation;
					}
				});
				return { ok: true as const };
			}

			if (kind === 'activate') {
				// The service owns what an activated account looks like — including the
				// revocation-code ceremony and the recovery file, both of which the
				// version written here skipped.
				if (!(await enrollment.reconcileActivated(steamId64, authenticatorFingerprint(account)))) {
					throw new EnrollmentError(MOVED_ON);
				}
				return { ok: true as const };
			}

			/*
			 * **A deletion, so it is asked for like one.** `accountDeactivate` demands
			 * the passphrase because being unlocked is not enough to destroy the only
			 * copy of a set of secrets, and this path destroys exactly the same thing.
			 */
			if (passphrase === undefined || passphrase === '') {
				throw new EnrollmentError(
					'Removing the account here needs your vault passphrase, the same as removing it any ' +
						'other way.'
				);
			}
			if (
				!(await enrollment.reconcileDetached(
					steamId64,
					passphrase,
					authenticatorFingerprint(account)
				))
			) {
				// Nothing was deleted, so nothing is torn down and nothing is claimed.
				throw new EnrollmentError(MOVED_ON);
			}
			// The same teardown a local removal does: cookie jar, cached session,
			// pending list.
			onRemoved(steamId64);
			return { ok: true as const };
		}
	);

	/**
	 * **The stored refusal, enforced rather than displayed.**
	 *
	 * Writing the unresolved operation to the vault made it outlive the screen.
	 * It did not make it binding: both screens read it and stop offering the
	 * action, and the main process went on accepting the request from anything
	 * that asked. This file already argues the other way, three handlers down —
	 * "Checked here, not by the screen. The auto-confirm gate taught this lesson
	 * the expensive way: a phrase enforced only in the renderer is a convention"
	 * — and these are the two operations that convention is least survivable on.
	 *
	 * A stale account list is enough to get past a renderer-side check. So is a
	 * renderer that has been compromised by the Steam content it renders, which
	 * is the threat the whole process boundary exists for.
	 *
	 * **Either operation is refused while either is unresolved.** What is unknown
	 * is the account's state on Steam, not one verb's outcome, and the answer to
	 * "should I detach this?" is not knowable while "did the activation land?"
	 * is open.
	 */
	/**
	 * The record on an account, **if it is about the authenticator now on it**.
	 *
	 * A record whose fingerprint does not match is about an authenticator that has
	 * since been replaced, and it does not apply to the one that took its place.
	 * Reading it without that check turned the guard against acting on a
	 * replacement into something worse: every activation and removal for the
	 * account was refused, the resolution refused too, and nothing in the
	 * application could unblock it.
	 */
	function recordFor(steamId64: string): {
		account: Account | undefined;
		held: Account['unresolvedOperation'];
		stale: boolean;
	} {
		const account = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		const stored = account?.unresolvedOperation;

		/*
		 * **The floor under the vault record.**
		 *
		 * `latch` runs after Steam answers and writes to the vault, so a lock, a
		 * crash or a power cut between the send and the answer left nothing at all
		 * — and the account then looked ordinary, with the same button offering the
		 * same irreversible call. The note on disk was written before the send and
		 * survives all three.
		 *
		 * Consulted only when the vault has nothing, so the guidance a real failure
		 * produced always wins over this generic one.
		 */
		const note = stored === undefined ? journal.read(steamId64) : undefined;
		const held =
			stored ??
			(note === undefined
				? undefined
				: {
						kind: note.kind,
						guidance:
							note.kind === 'activate'
								? 'This app asked Steam to finish adding an authenticator to this account ' +
									'and never found out what happened — it was interrupted before Steam ' +
									'answered. Sign in to Steam and check whether Steam Guard is on this ' +
									'account before doing anything else here.'
								: 'This app asked Steam to remove this authenticator and never found out ' +
									'what happened — it was interrupted before Steam answered. Sign in to ' +
									'Steam and check whether Steam Guard is still on this account before ' +
									'doing anything else here.',
						fingerprint: note.fingerprint,
						at: note.at
					});

		if (account === undefined || held === undefined) {
			// A note with no account row left to hang it on is unreachable from here.
			// The initial-enrolment case, where there may never have been a row, needs
			// a surface of its own.
			return { account, held: undefined, stale: false };
		}
		const stale =
			held.fingerprint === undefined || held.fingerprint !== authenticatorFingerprint(account);
		return { account, held: stale ? undefined : held, stale };
	}

	function heldBack(
		steamId64: string
	): { state: 'uncertain'; guidance: string; certain?: boolean; persisted?: boolean } | undefined {
		const { held } = recordFor(steamId64);
		if (held === undefined) {
			return undefined;
		}
		// Read back out of the vault, so it is durable by construction.
		return held.certain === true
			? { state: 'uncertain', guidance: held.guidance, certain: true, persisted: true }
			: { state: 'uncertain', guidance: held.guidance, persisted: true };
	}

	registerHandler(CHANNELS.enrollActivate, async ({ steamId64, code }) => {
		requireUnlocked();
		const blocked = heldBack(steamId64);
		if (blocked !== undefined) {
			return blocked;
		}
		// Sampled before the request goes, so a row replaced while Steam is failing
		// to answer cannot be what the record ends up describing.
		const ran = operatedOn(steamId64);

		// **Written down before the request goes.** `latch` below runs after Steam
		// answers, so a lock on the idle timer, a crash or a power cut in between
		// left no trace at all — and the account then looked ordinary, with the same
		// irreversible button on it.
		journal.record({
			steamId64,
			kind: 'activate',
			fingerprint: ran,
			at: new Date().toISOString()
		});

		try {
			const state = await enrollment.activate(steamId64, code);
			// The outcome is known, so the note has done its job.
			journal.clear(steamId64, 'activate');
			return { state };
		} catch (err) {
			let outcome: { state: 'uncertain'; guidance: string; certain?: boolean };
			try {
				outcome = uncertainOrRethrow(err);
			} catch (known) {
				/*
				 * **A refusal Steam gave us is not an uncertainty.** A mistyped code or
				 * a rejected password says plainly that nothing happened, and leaving
				 * the note behind would turn every ordinary typo into an account that
				 * reports an unfinished operation for ever, with a warning telling the
				 * user to go and check Steam over nothing at all.
				 */
				journal.clear(steamId64, 'activate');
				throw known;
			}
			/*
			 * **Whether the refusal survives this window is part of the answer.**
			 *
			 * The write can fail — a full disk, a vault that locked while Steam was
			 * being waited on, a row that is no longer there — and it was caught,
			 * logged and swallowed, after which the screen went on saying "this
			 * application will not send the request again". That is a promise about
			 * a record that does not exist: close the window and the account looks
			 * ordinary, with the same button offering the same irreversible call.
			 */
			const persisted = await latch(steamId64, 'activate', outcome, ran);
			if (persisted) {
				// The vault now carries the guidance the failure actually produced,
				// which is better than the note's generic wording.
				journal.clear(steamId64, 'activate');
			}
			// The promise the screen makes — that this will not be sent again — is now
			// backed by the note whenever the vault write is the thing that failed.
			return { ...outcome, persisted: persisted || journal.read(steamId64) !== undefined };
		}
	});

	registerHandler(
		CHANNELS.accountDeactivate,
		async ({ steamId64, passphrase, acknowledgement }) => {
			requireUnlocked();

			// Checked here, not by the screen. The auto-confirm gate taught this lesson
			// the expensive way: a phrase enforced only in the renderer is a convention,
			// and this is the one operation more destructive than switching trades on.
			if (!matchesDeactivateAck(acknowledgement)) {
				throw new Error(`type "${DEACTIVATE_ACK}" to remove this authenticator from Steam`);
			}

			const blocked = heldBack(steamId64);
			if (blocked !== undefined) {
				return blocked;
			}

			// Before the request goes. See `latch`.
			const ran = operatedOn(steamId64);

			// Before the request goes, for the reason given on the activation path.
			journal.record({
				steamId64,
				kind: 'deactivate',
				fingerprint: ran,
				at: new Date().toISOString()
			});

			try {
				await enrollment.deactivate(steamId64, passphrase);
				journal.clear(steamId64, 'deactivate');
			} catch (err) {
				let outcome: { state: 'uncertain'; guidance: string; certain?: boolean };
				try {
					outcome = uncertainOrRethrow(err);
				} catch (known) {
					// A refusal, not an uncertainty. See the activation path.
					journal.clear(steamId64, 'deactivate');
					throw known;
				}
				/*
				 * The account is still in the vault — a removal whose outcome is
				 * unknown does not get to delete the secrets that might still be the
				 * live ones — so there is a row to write this on. Whether the write
				 * landed travels with the outcome; see the activation path above.
				 */
				const persisted = await latch(steamId64, 'deactivate', outcome, ran);
				if (persisted) {
					journal.clear(steamId64, 'deactivate');
				}
				return { ...outcome, persisted: persisted || journal.read(steamId64) !== undefined };
			}

			// The same cleanup a local removal does: cookie jar, cached session,
			// pending list. An account whose authenticator is gone must not still have
			// a live session sitting in memory.
			onRemoved(steamId64);
			return { ok: true as const };
		}
	);

	registerHandler(CHANNELS.accountRecover, async ({ passphrase }) => {
		requireUnlocked();

		const text = await recoveryDialog.pick();
		if (text === undefined) {
			return { state: 'cancelled' as const };
		}

		// **Checked again, and this is the one that matters.** The picker stays open
		// for as long as the user browses, and the vault auto-locks on its own
		// schedule — so by the time a file comes back, the session that authorised
		// this may be gone. Decrypting anyway pulls a shared secret, an identity
		// secret and a revocation code into memory with nobody present, and the
		// `vault.read()` further down throws far too late to un-read them.
		//
		// The maFile import path has guarded exactly this window since it was
		// written. This one did not.
		requireUnlocked();

		// Decrypted in the main process and never handed outward. The renderer
		// learns which account came back and nothing else.
		const recovered = await readRecoveryFile(text, passphrase);

		// And once more with the plaintext in hand. The decrypt is a deliberate
		// second of scrypt, and the idle lock does not pause for it — a lock that
		// landed during it means nobody is present for the secrets that were just
		// decrypted. They cannot be un-read, but nothing further happens with
		// them, and the refusal names the real reason instead of surfacing the
		// vault read below failing incidentally.
		requireUnlocked();

		// **The account's own SteamID decides, not the file's metadata.**
		//
		// A recovery file carries the SteamID twice: once at the top level, where it
		// is informational so files can be told apart without decrypting them, and
		// once inside the account itself. The duplicate check read the outer one and
		// the insert used the inner one, so a file whose two copies disagreed —
		// corrupt, hand-edited, or built by something else — could pass a check
		// against one identity and then push an account under another, landing a
		// second row for an account already present.
		const identity = recovered.account.steamId64;
		if (identity !== recovered.steamId64) {
			throw new RecoveryError(
				'that recovery file disagrees with itself about which account it is for, so it was not used.'
			);
		}

		const already = vault.read().accounts.some((entry) => entry.steamId64 === identity);
		if (already) {
			// Not an error. Somebody recovering a file they did not need should be
			// told that plainly rather than shown a failure.
			return { state: 'alreadyPresent' as const, accountName: recovered.accountName };
		}

		await vault.mutate((draft) => {
			draft.accounts.push(recovered.account);
		});

		return {
			state: 'restored' as const,
			accountName: recovered.accountName,
			steamId64: recovered.steamId64
		};
	});

	registerHandler(CHANNELS.accountExport, async ({ steamId64 }) => {
		requireUnlocked();

		const account = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!account) {
			throw new Error('no such account in this vault');
		}

		const suggested = maFileName(account);
		const destination = await dialog.show(suggested);
		if (destination === undefined) {
			return { state: 'cancelled' as const };
		}

		return exclusively(destination, async () => {
			// **Checked again, after the dialog.** A save dialog sits open for as long as
			// the user takes to pick a folder, and the idle timer, a suspend or an OS
			// screen lock can all fire in that window. The account was copied out before
			// the dialog opened, so without this the plaintext secrets are written after
			// the vault has locked — the one moment the application has been told nobody
			// is present.
			requireUnlocked();

			// And re-read, for the same reason. The copy taken before the dialog
			// outlives anything that happened during it — writing it out for an
			// account since removed would put secrets the user just chose to be rid of
			// into a fresh plaintext file.
			const current = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
			if (!current) {
				throw new Error('that account is no longer in this vault, so nothing was exported.');
			}

			// `mode: 0o600` — owner-only. This file contains the same secrets as the
			// vault and none of its encryption, so the one protection available is that
			// other users on the machine cannot read it. The user is told as much on
			// the screen that offers this.
			//
			// **Temp beside the destination, then rename — never truncate in place.**
			// Writing straight to the chosen path opens it for truncation first, so a
			// write that then failed — disk full, a drive unplugged mid-copy — had
			// already emptied the previous maFile at that name. Re-exporting over an
			// existing backup is the ordinary case, and a failed export must leave the
			// old file exactly as it was; the vault and recovery writers have always
			// worked this way.
			//
			// Wrapped because a failed write throws with the absolute path in its
			// message, and the rule at the top of this module is that no path crosses
			// IPC in either direction.
			// A unique name, and `wx`. A fixed `.tmp` suffix truncated whatever already
			// sat at that name — a sibling file that was never ours — and two exports
			// to the same destination shared one temp, so either's failure path could
			// delete the other's work. The random name makes collisions impossible and
			// `wx` makes this write constitutionally unable to empty an existing file.
			const temp = `${destination}.${randomUUID()}.tmp`;

			/*
			 * What this file is about to contain, captured before the write.
			 *
			 * Re-read and compared after it, beside the lock check — see there. The
			 * revocation code is included because replacing it alone makes an exported
			 * copy wrong in the way that matters most: it is the one secret whose loss
			 * cannot be undone, and a backup holding the previous one is worse than no
			 * backup, because somebody will believe it.
			 */
			const exported = fingerprint(current);

			/*
			 * Cleanup and refusal in one place, so both failure paths below can keep a
			 * **bare** `catch`.
			 *
			 * That is not style. `preserve-caught-error` wants a `cause` on anything
			 * rethrown from a bound error — and the whole rule of this module is that
			 * no filesystem path crosses IPC. A failed write throws with the absolute
			 * destination in its message, so attaching it as a cause would hand the
			 * renderer the user's folder layout through the back door, to satisfy a
			 * lint rule about diagnostics.
			 */
			const giveUp = async (alsoLeft: readonly string[] = []): Promise<never> => {
				// Verified, not merely attempted. The staged file holds the same plaintext
				// the destination would have, so a removal that failed and was swallowed
				// left a maFile in the user's folder under a message telling them the
				// export had not been written at all.
				const staged = (await removed(temp)) ? [] : [basename(temp)];
				// Concatenated rather than interpolated so the sentence the user is given
				// for a failed write stays one literal in this file: `transfer-screen-wiring`
				// reads it from the source to prove the refusal names the file that was
				// asked for and never the path the OS dialog chose.
				throw new Error(
					`${suggested} could not be written to that location.` +
						stillOnDisk([...alsoLeft, ...staged])
				);
			};

			/*
			 * Kept beyond the write: it is what makes the file at the destination
			 * this export's own, and the rollback below has no other way to tell.
			 */
			const contents = toMaFile(current);

			try {
				await writeFile(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			} catch {
				await giveUp();
			}

			{
				/*
				 * **Checked once more, between writing and publishing.**
				 *
				 * The check before this covers the save dialog, which is the long wait —
				 * but the write is a wait too, and a slow one on the drives people
				 * actually export to: a USB stick, a network share, an SD card. Lock the
				 * vault during it — manually, by idling, by shutting the lid — and the
				 * rename still completed and put a plaintext maFile at the destination,
				 * carrying the same secrets as the vault and none of its encryption,
				 * after the application had been told nobody is present.
				 *
				 * The rename is the moment the file becomes real, so this is the last
				 * place the answer can still be no. The temp goes with it: it holds the
				 * same plaintext, and it exists only because the destination is not
				 * safe to write directly.
				 */
				// A lock is not a disk problem, and telling somebody their drive would
				// not take the file when what actually happened is that their vault
				// locked sends them to fix the wrong thing — so this is thrown from
				// outside the write's own catch, where it cannot be mistaken for one.
				if (!vault.isUnlocked()) {
					// And if the staged plaintext cannot be taken back, the lock is not the
					// only thing the user needs to hear about.
					const staged = (await removed(temp)) ? [] : [basename(temp)];
					throw staged.length === 0
						? new VaultLockedError()
						: new VaultLockedError(`the vault is locked.${stillOnDisk(staged)}`);
				}

				/*
				 * **And that it is still the same account.**
				 *
				 * The lock is re-checked here and the account's identity was not, so
				 * only half the race was closed. The write is the wait — slow on the
				 * drives people export to — and an account can be removed, or have its
				 * authenticator replaced, while it runs. The rename then published a
				 * plaintext maFile holding secrets the vault no longer has, and told the
				 * user it had saved their account.
				 *
				 * Removed is the worse half: it puts the secrets somebody just chose to
				 * be rid of into a fresh unencrypted file at a path of their choosing.
				 * Replaced is quieter and lasts longer — a backup that silently holds
				 * the previous authenticator, which Steam has already stopped accepting,
				 * discovered at the one moment it is ever used.
				 *
				 * Compared on the secrets themselves rather than on presence, because
				 * "still in the vault" is true of a re-enrolled account that shares
				 * nothing with the one this file describes.
				 */
				const stillThere = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
				if (!stillThere || fingerprint(stillThere) !== exported) {
					const staged = (await removed(temp)) ? [] : [basename(temp)];
					throw raceLost(!stillThere, staged);
				}
			}

			/*
			 * Whether the destination was already there, read before the rename.
			 *
			 * It decides what a lock *during* the rename is allowed to do about it —
			 * see below. `access` rather than a stat: only existence matters, and this
			 * is a question about the path, not about its contents.
			 */
			/*
			 * **The previous file is set aside, not merely noted.**
			 *
			 * An earlier version recorded whether the destination existed and, if it
			 * did, left the replacement in place when a lock landed during the rename —
			 * on the reasoning that deleting would destroy a backup the user had before
			 * they pressed anything.
			 *
			 * That reasoning had a hole, and it produced the worst available outcome:
			 * the old backup was gone, freshly exported plaintext was sitting at that
			 * path, and the user was told the export had failed because the vault
			 * locked. Every part of that is wrong at once — a destroyed file, a new
			 * exposure, and a message saying neither happened.
			 *
			 * Moving it aside first makes the rename undoable, so the lock can be
			 * honoured exactly: the new file goes, the old one comes back, and
			 * "nothing was replaced" is true. The same set-aside-then-restore the vault
			 * writer has always used, for the same reason.
			 */
			const kept = `${destination}.${randomUUID()}.prev`;
			const replacing = await rename(destination, kept)
				.then(() => true)
				.catch(() => false);

			/**
			 * What this export left at the destination, so the rollback can tell
			 * whether the file it is about to delete is still that one.
			 *
			 * The mutex above stops another *export* getting in, and cannot stop
			 * anything else: a sync client, a backup tool, the user saving over it.
			 * The rollback deletes the destination outright, so without this it is one
			 * unlucky moment from removing a file this export never created, under a
			 * message saying nothing was written.
			 *
			 * Size and modification time rather than an inode, because Windows reports
			 * `ino` as 0 and a check that is inert on the platform most of these
			 * installs run on is not a check.
			 */
			/**
			 * **What this export wrote, byte for byte.**
			 *
			 * Ownership was size plus modification time, and neither carries any
			 * identity worth the name: every maFile this application writes is within
			 * a few bytes of every other, and two files created in the same
			 * millisecond share an mtime. A foreign file of the same size written in
			 * the same tick was classified as ours and deleted.
			 *
			 * The content is what makes a file this export's own, it is already in
			 * memory, and a maFile is a few hundred bytes — so it is compared
			 * directly. There is no cheaper check that means anything.
			 */
			const written = contents;

			try {
				await rename(temp, destination);
			} catch {
				// Put back whatever was there before saying the export failed — and when
				// it cannot go back, name it. It is the user's own previous export,
				// stranded under a random suffix they never chose, while the message about
				// to be thrown talks only about the file that was not written.
				const stranded = replacing
					? await rename(kept, destination).then(
							() => [],
							() => [basename(kept)]
						)
					: [];
				await giveUp(stranded);
			}

			/*
			 * **The rename is the commit, and it is not instant.**
			 *
			 * The check above covers everything up to it. The rename itself is a
			 * filesystem round trip — on the removable and network drives people
			 * actually export to, a slow one — and a lock landing inside it still
			 * published the plaintext maFile, then answered `saved`.
			 *
			 * There is no way to make a rename part of the same transaction as a lock,
			 * so this undoes it instead, and only where undoing is honest:
			 *
			 *  - **Nothing was there before.** This export created the file, so
			 *    removing it restores the directory exactly as it was, and the lock
			 *    means nobody is present to have wanted it.
			 *  - **Something was there.** The rename has already replaced it, and
			 *    deleting now would destroy a backup the user had before they pressed
			 *    anything — a worse outcome than a plaintext file for the same account
			 *    that already existed at that path a second ago, which is no new
			 *    exposure at all. It stays, and the refusal still says the vault
			 *    locked.
			 */
			/*
			 * **And the account is checked again, not only the lock.**
			 *
			 * The fingerprint was taken before this sequence and never re-read, so the
			 * post-rename check asked one question — is the vault still open — and let
			 * everything else through. Removing the account during the awaited renames
			 * therefore answered `{ state: 'saved' }` with the plaintext maFile sitting
			 * at the destination: secrets published for an authenticator the vault no
			 * longer holds, by an export the user had already superseded.
			 *
			 * The same fingerprint, for the same reason it exists at all — an account
			 * removed and re-enrolled keeps its SteamID and shares nothing else, so a
			 * file written from the old secrets is a backup of something Steam has
			 * already stopped accepting.
			 */
			const stillOurs = vault.isUnlocked()
				? vault.read().accounts.find((entry) => entry.steamId64 === steamId64)
				: undefined;
			if (!vault.isUnlocked() || !stillOurs || fingerprint(stillOurs) !== exported) {
				/*
				 * **Undone completely — and where it cannot be undone, said out loud.**
				 *
				 * Both halves of this rollback used to be fired and forgotten:
				 * `rm(destination).catch(() => undefined)` and
				 * `rename(kept, destination).catch(() => undefined)`, followed by a refusal
				 * saying nothing was written no matter which of them had actually worked.
				 * Hold the destination open — a scanner, a network share dropping, a
				 * removable drive pulled — and the freshly published maFile stayed exactly
				 * where it was, `shared_secret` and `identity_secret` in the clear, under a
				 * message that told the user to stop looking. A silent exposure is worse
				 * than a loud one, because only the loud one gets deleted.
				 *
				 * So each half is verified on its own, and what survives is named.
				 */
				/*
				 * Only if it is still the file this export wrote. If something replaced
				 * it in the meantime, deleting is not a rollback — it destroys a file
				 * this export never created, under a message saying nothing was
				 * written. Unknown counts as not ours: `written` is undefined only when
				 * the stat failed, and guessing from there is what this avoids.
				 */
				/**
				 * Three answers, not two: it is ours, it is not ours, or nothing here
				 * can tell.
				 *
				 * A read that fails with anything but "no such file" is the third. It
				 * was folded into the second — `undefined` meant both "absent" and
				 * "could not look" — so an `EACCES` on the destination read as an empty
				 * path and the restore below renamed straight over whatever was there.
				 * Unknown has to behave like foreign, because that is the assumption
				 * that cannot destroy anything.
				 */
				/*
				 * **Sized before it is read.** The comparison is against a maFile a few
				 * hundred bytes long, and the destination is whatever path a save
				 * dialog returned. Reading it whole to find out it is not ours meant an
				 * arbitrarily large file — or a device that never ends — loaded into the
				 * Electron main process, which is the one that must not stop.
				 *
				 * A file of a different length cannot be this export's own, so the stat
				 * answers most of it for nothing. Only an exact-length match is worth
				 * reading, and then it is bounded by construction.
				 */
				const atDestination: 'ours' | 'foreign' | 'absent' | 'unknown' = await stat(destination)
					.then(async (info) => {
						if (!info.isFile() || info.size !== Buffer.byteLength(written, 'utf8')) {
							return 'foreign' as const;
						}
						return (await readFile(destination, 'utf8')) === written
							? ('ours' as const)
							: ('foreign' as const);
					})
					.catch((err: NodeJS.ErrnoException) =>
						err.code === 'ENOENT' ? ('absent' as const) : ('unknown' as const)
					);
				const stillOurFile = atDestination === 'ours';

				const tookItBack = stillOurFile ? await removed(destination) : false;
				/*
				 * Attempted even when the removal failed, because the restore lands *on
				 * top* of the published file: a rename that succeeds replaces the fresh
				 * plaintext with the copy that was there before, which is this rollback's
				 * goal reached by the other door. Only when neither worked is the export
				 * still sitting at the destination.
				 *
				 * **But not on top of a file this export did not write.** The ownership
				 * check above stops the *removal* from deleting a stranger's file and
				 * this half went on overwriting one, which is the same loss by the other
				 * door — a rename replaces silently. So the restore is skipped when
				 * something is at the destination and it is not ours, and the set-aside
				 * copy is then named as stranded, which is exactly what it is.
				 */
				// `absent` is the only state the restore may write into besides `ours`.
				const foreignAtDestination = atDestination === 'foreign' || atDestination === 'unknown';
				const putBack =
					replacing && !foreignAtDestination
						? await rename(kept, destination).then(
								() => true,
								() => false
							)
						: false;

				const left: string[] = [];
				// Only when what is sitting there is this export's own plaintext. A
				// file somebody else wrote is not something to warn this user about,
				// and naming it would send them to delete it.
				if (!tookItBack && !putBack && !foreignAtDestination) {
					left.push(basename(destination));
				}
				if (replacing && !putBack) {
					// The set-aside copy could not go home. It is the user's own earlier
					// export — the same secrets, no encryption — now sitting under a random
					// suffix in a folder where they have been told nothing happened.
					left.push(basename(kept));
				}

				if (!vault.isUnlocked()) {
					throw left.length === 0
						? new VaultLockedError()
						: new VaultLockedError(`the vault is locked.${stillOnDisk(left)}`);
				}
				// The same sentences the pre-rename check gives, so the two read alike —
				// and so a user who hits the later one is not told something different
				// about the same situation.
				throw raceLost(!stillOurs, left);
			}

			/*
			 * The export stands, so the copy it replaced is no longer needed. Removed
			 * rather than left beside it: a stray `.prev` full of the same secrets is
			 * a second plaintext file nobody asked for.
			 *
			 * **And when it cannot be removed, the caller is told.** A swallowed
			 * failure here answered `saved` while a second plaintext file sat in the
			 * user's folder — the previous authenticator's secrets, at a path only the
			 * OS dialog knows, with nothing anywhere mentioning it. A scanner holding
			 * the file, a network share dropping, a removable drive pulled: all
			 * ordinary, all silent.
			 */
			let staleCopy = false;
			if (replacing) {
				staleCopy = !(await removed(kept));
			}
			// **`mode` alone was not enough.** POSIX applies it only when the file is
			// created, so exporting over a file that already existed — a second export to
			// the same name, which is the ordinary case — kept whatever permissions it
			// had, commonly `0644`, while replacing its contents with an unencrypted
			// shared_secret and identity_secret.
			//
			// Best effort: Windows has no POSIX mode, and failing an export that has
			// already written its bytes would leave the user worse off than a permission
			// bit that could not be set.
			try {
				await chmod(destination, 0o600);
			} catch {
				/* not supported here; the directory's own permissions still apply */
			}

			return {
				state: 'saved' as const,
				/*
				 * The name on disk, not the one this application proposed. The save
				 * dialog lets somebody type whatever they like, and reporting
				 * `suggested` told a user who had renamed it to look for a file that is
				 * not there.
				 */
				fileName: basename(destination),
				...(staleCopy ? { staleCopy } : {})
			};
		});
	});
}
