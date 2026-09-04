import { randomUUID } from 'node:crypto';
import { chmod, link, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { maFileName, toMaFile } from '../import/export';
import { DEACTIVATE_ACK, matchesDeactivateAck } from '../../shared/ipc';
import { readRecoveryFile, RecoveryError } from '../vault/recovery';
import {
	authenticatorFingerprint,
	EnrollmentCleanupError,
	type EnrollmentService,
	type OperationCompanionIdentity,
	type OperationResolutionGuard
} from './enrollment';
import { EnrollmentError } from './enroll';
import type { Account } from '../../shared/vault-schema';
import { PROXY_REQUIRED } from '../net/egress';
import { ProxyConsent } from '../net/proxy-consent';
import { VaultLockedError, type VaultService } from '../vault/service';
import {
	noOperationJournal,
	type OperationJournal,
	type PendingOperation
} from './operation-journal';
import type { EnrollmentWorkflowRecord } from './workflow-journal';
import { VaultKeyOperationCoordinator } from '../vault/key-operation-coordinator';
import { markRecoveryBackupNeeded } from '../vault/recovery-state';
import {
	isAuthenticatorFingerprint,
	isOperationId,
	operationRecordToken
} from './authenticator-secrets';

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

type FileIdentity = 'exact' | 'different' | 'absent' | 'unknown';

async function identifies(path: string, expected: string): Promise<FileIdentity> {
	return stat(path)
		.then(async (info) => {
			if (!info.isFile() || info.size !== Buffer.byteLength(expected, 'utf8')) {
				return 'different' as const;
			}
			return (await readFile(path, 'utf8')) === expected
				? ('exact' as const)
				: ('different' as const);
		})
		.catch((err: NodeJS.ErrnoException) =>
			err.code === 'ENOENT' ? ('absent' as const) : ('unknown' as const)
		);
}

async function flushFile(path: string): Promise<void> {
	const handle = await open(path, 'r+');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Directory fsync is unsupported on Windows, but real I/O failures elsewhere are not success. */
async function flushDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, 'r');
		await handle.sync();
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (
			process.platform === 'win32' &&
			['EACCES', 'EBADF', 'EINVAL', 'EPERM'].includes(code ?? '')
		) {
			return;
		}
		throw err;
	} finally {
		await handle?.close();
	}
}

const LINK_UNSUPPORTED = new Set(['EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);

type PublishAbsentResult = { published: true } | { published: false; destinationClaimed: boolean };

/** Publish an already-durable stage without replacing a path another writer claimed. */
async function publishAbsent(
	stage: string,
	destination: string,
	contents: string
): Promise<PublishAbsentResult> {
	try {
		await link(stage, destination);
		try {
			await rm(stage);
			return { published: true };
		} catch {
			// Both names may now expose the same plaintext. Let the caller verify and
			// clean each name rather than hiding the failed unlink.
			return { published: false, destinationClaimed: true };
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (!LINK_UNSUPPORTED.has(code ?? '')) {
			return { published: false, destinationClaimed: false };
		}
	}

	let claimed: Awaited<ReturnType<typeof open>>;
	try {
		claimed = await open(destination, 'wx', 0o600);
	} catch {
		return { published: false, destinationClaimed: false };
	}
	let failed = false;
	try {
		await claimed.writeFile(contents, 'utf8');
		await claimed.sync();
	} catch {
		failed = true;
	}
	try {
		await claimed.close();
	} catch {
		failed = true;
	}
	if (failed || (await identifies(destination, contents)) !== 'exact') {
		// Do not unlink here. Another process can replace the path while this
		// handle is open. The caller owns the conservative identity check and the
		// warning for a partial or otherwise unverifiable destination.
		return { published: false, destinationClaimed: true };
	}
	try {
		await rm(stage);
	} catch {
		return { published: false, destinationClaimed: true };
	}
	return { published: true };
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
 * needs to spot the file once they are looking in it.
 */
/**
 * One export at a time per destination path.
 *
 * Staging, claiming the name, checking the live account, and rolling back span
 * several awaits. Serialising the complete sequence prevents one export from
 * removing the result another export has just published to the same path.
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
	if (err instanceof EnrollmentCleanupError) {
		return err.certain
			? { state: 'uncertain', guidance: err.message, certain: true }
			: { state: 'uncertain', guidance: err.message };
	}
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

function possiblyStillOnDisk(names: readonly string[]): string {
	if (names.length === 0) {
		return '';
	}
	const listed = names.map((name) => `"${name}"`).join(' and ');
	return ` The file ${listed} could not be verified or safely removed. It may contain part or all of this account's shared_secret and identity_secret unencrypted. Check it before deleting it, because another program may have replaced it.`;
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
	/** Drops all account state after the vault row is gone; `true` prevents reroute-only cleanup. */
	onRemoved: (steamId64: string, removed: true) => void = () => undefined,
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
	journal: OperationJournal = noOperationJournal(),
	/** Shared with irreversible workflows and every other account identity mutation. */
	keyCoordinator: VaultKeyOperationCoordinator = new VaultKeyOperationCoordinator(),
	/** Refuses recovery-file insertion beside a durable workflow for the same account. */
	accountMutationBlocked: (steamId64: string) => boolean = () => false,
	/** Local-only publication of changed portable refusal state; never contacts Steam. */
	onFinishRecoveryBackup: (steamId64: string) => Promise<void> | void = () => {
		throw new Error('Recovery backup completion is not available.');
	}
): void {
	const tryRefreshRecoveryBackup = async (steamId64: string): Promise<void> => {
		try {
			await onFinishRecoveryBackup(steamId64);
		} catch {
			// The pending/stale account marker is durable, visible, and locally retryable.
		}
	};

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

	const durableEnrollmentOutcome = (
		outcome: ReturnType<typeof uncertainOrRethrow>
	): ReturnType<typeof uncertainOrRethrow> & {
		kind?: 'enroll';
		attemptId?: string;
		steamId64?: string;
		accountName?: string;
		persisted?: boolean;
		enrollmentState?: EnrollmentWorkflowRecord['state'];
		recovery?: 'durable' | 'memory';
		usable?: boolean;
		stored?: boolean;
	} => {
		const pending = enrollment.unresolvedEnrollment?.();
		const recovery = pending === undefined ? undefined : enrollment.recoveryState(pending);
		const stored = pending === undefined ? false : enrollment.enrollmentStoredFaithfully(pending);
		return pending === undefined
			? { ...outcome, persisted: false }
			: {
					...outcome,
					kind: 'enroll',
					attemptId: pending.attemptId,
					steamId64: pending.steamId64,
					accountName: pending.accountName,
					persisted: true,
					stored,
					enrollmentState: pending.state,
					...(recovery === undefined
						? {}
						: { recovery, usable: enrollment.enrollmentRecoveryUsable(pending) })
				};
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
			return durableEnrollmentOutcome(uncertainOrRethrow(err));
		}
	});

	registerHandler(CHANNELS.enrollEmailCode, async ({ code }) => {
		requireUnlocked();
		// The same path: this call finishes the sign-in and goes straight on to
		// `AddAuthenticator`, so every outcome above reaches here too.
		try {
			return await enrollment.submitEmailCode(code);
		} catch (err) {
			return durableEnrollmentOutcome(uncertainOrRethrow(err));
		}
	});

	registerHandler(CHANNELS.enrollStatus, () => {
		requireUnlocked();
		try {
			const pending = enrollment.unresolvedEnrollment();
			const recovery = pending === undefined ? undefined : enrollment.recoveryState(pending);
			return pending === undefined
				? {}
				: {
						pending: {
							attemptId: pending.attemptId,
							steamId64: pending.steamId64,
							accountName: pending.accountName,
							state: pending.state,
							at: pending.at,
							stored: enrollment.enrollmentStoredFaithfully(pending),
							certain: enrollment.enrollmentKnownAttached(pending),
							...(recovery === undefined
								? {}
								: { recovery, usable: enrollment.enrollmentRecoveryUsable(pending) })
						}
					};
		} catch {
			return {
				problem:
					'A saved enrollment safety record cannot be read. No new authenticator will be ' +
					'added until the application data folder is repaired or this app is updated.'
			};
		}
	});

	registerHandler(CHANNELS.enrollRetryPersist, async ({ attemptId, steamId64 }) => {
		requireUnlocked();
		try {
			return await enrollment.retryEnrollmentPersist(attemptId, steamId64);
		} catch (err) {
			return durableEnrollmentOutcome(uncertainOrRethrow(err));
		}
	});

	registerHandler(CHANNELS.enrollResolve, ({ attemptId, steamId64, resolution }) => {
		requireUnlocked();
		enrollment.resolveEnrollment(attemptId, steamId64, resolution);
		return { ok: true as const };
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
		if (account === undefined) {
			throw new EnrollmentError(
				'That account is not in this vault, so no request was sent to Steam.',
				false
			);
		}
		return authenticatorFingerprint(account);
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
		note: PendingOperation
	): Promise<NonNullable<Account['unresolvedOperation']> | undefined> {
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
		let recoveryChanged = false;
		let recorded: NonNullable<Account['unresolvedOperation']> | undefined;
		const operation = {
			kind,
			guidance: outcome.guidance,
			fingerprint: note.fingerprint,
			at: note.at,
			...(note.identity.source === 'v2' && isOperationId(note.identity.recordId)
				? { operationId: note.identity.recordId }
				: {}),
			...(outcome.certain === true ? { certain: true } : {})
		};
		try {
			await vault.mutate((draft) => {
				const account = draft.accounts.find(
					(entry) =>
						entry.steamId64 === steamId64 && authenticatorFingerprint(entry) === note.fingerprint
				);
				if (account === undefined) {
					// The row this operation was about is gone. There is nothing to
					// record against, and recording against its replacement is the
					// defect the fingerprint argument exists to stop.
					return;
				}
				account.unresolvedOperation = { ...operation };
				markRecoveryBackupNeeded(account, account.recoveryBackup, note.at);
				recoveryChanged = true;
				updated = true;
			});
			// Only now: the write is done.
			recorded = updated ? operation : undefined;
			if (recoveryChanged) {
				await tryRefreshRecoveryBackup(steamId64);
			}
		} catch (err) {
			console.error('an unresolved Steam operation could not be recorded in the vault', err);
		}
		return recorded;
	}

	/**
	 * Persist an unresolved outcome to both independent stores.
	 *
	 * A known Steam acceptance is too important for either write to suppress the
	 * other. In particular, a failed journal-side certainty upgrade must not skip
	 * the vault latch that may still be perfectly writable. Conversely, the
	 * journal remains the fallback when the vault write is the failure that
	 * produced the outcome in the first place.
	 */
	async function persistOperationOutcome(
		steamId64: string,
		kind: 'activate' | 'deactivate',
		outcome: { guidance: string; certain?: boolean },
		note: PendingOperation
	): Promise<{
		durableNote: PendingOperation;
		persisted: NonNullable<Account['unresolvedOperation']> | undefined;
	}> {
		let durableNote = note;
		let journalCertain = false;
		if (outcome.certain === true) {
			try {
				const marked = journal.markCertain(note);
				if (marked.certain !== true) {
					throw new Error('the certainty record did not read back as certain');
				}
				durableNote = marked;
				journalCertain = true;
			} catch (err) {
				// Do not return yet: the vault is an independent durability sink and
				// may still retain the exact known outcome.
				console.error('a known Steam outcome could not be recorded in the operation journal', err);
			}
		}

		const persisted = await latch(steamId64, kind, outcome, durableNote);
		if (outcome.certain === true && !journalCertain && persisted?.certain !== true) {
			throw new EnrollmentError(
				'Steam accepted the request, but neither durable certainty record could be written. ' +
					'The pre-send safety record remains, so this action is blocked and will not be sent ' +
					'again. Repair the application data folder before resolving the saved operation.',
				true,
				true,
				true
			);
		}

		return { durableNote, persisted };
	}

	/*
	 * **Only the user can settle this.** Nothing local knows what Steam did, so
	 * the latch is cleared by the person saying they have been and looked -
	 * which is also the moment the guidance stops being useful to them.
	 */
	registerHandler(CHANNELS.accountResolveOperation, async (request) => {
		const { steamId64, kind } = request;
		requireUnlocked();
		let releaseAccountMutation: () => void;
		try {
			releaseAccountMutation = keyCoordinator.beginAccountMutation(steamId64);
		} catch (err) {
			throw new EnrollmentError(
				err instanceof Error ? err.message : 'Another protected operation is in progress.',
				false
			);
		}
		try {
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
			const { account, identified, unidentified } = locatedRecords(steamId64);

			if ('discardStale' in request) {
				/*
				 * This is deliberately a different command from saying what Steam did.
				 * The evidence names an authenticator that is no longer stored here, so
				 * neither "Steam acted" answer may be applied to the current secrets.
				 * Only the exact stale kind the screen displayed is removed; a current
				 * note or a debt of the other kind stays untouched.
				 */
				const stale = identified.find(
					(entry) => entry.record.kind === kind && entry.token === request.staleToken
				);
				if (account === undefined || stale === undefined) {
					if (unidentified !== undefined) {
						throw new EnrollmentError(
							'That safety record does not identify which authenticator it describes, so it cannot be discarded. Keep your backup and contact support before changing Steam Guard.'
						);
					}
					throw new EnrollmentError(
						'That old safety record changed or is no longer present. Reopen the account before doing anything else.'
					);
				}
				if (stale.record.fingerprint === authenticatorFingerprint(account)) {
					throw new EnrollmentError(MOVED_ON);
				}
				await clearEvidence(stale, exactCompanion(stale, identified));
				return { ok: true as const };
			}

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
			const displayed = identified.find((entry) => entry.token === request.operationToken);
			if (displayed !== undefined && displayed.record.kind !== kind) {
				throw new EnrollmentError(
					'That account has a different unfinished operation recorded against it. Reopen the account and answer the operation actually displayed.'
				);
			}
			const held = displayed?.record.kind === kind ? displayed : undefined;
			const currentFingerprint =
				account === undefined ? undefined : authenticatorFingerprint(account);
			if (
				account === undefined ||
				held === undefined ||
				held.record.fingerprint !== currentFingerprint
			) {
				if (unidentified !== undefined) {
					throw new EnrollmentError(
						'That safety record does not identify which authenticator it describes, so it cannot be cleared or applied. Keep your backup and contact support before changing Steam Guard.'
					);
				}
				throw new EnrollmentError(
					'There is nothing recorded under that exact operation to resolve. It changed, was already resolved, or belongs to another authenticator; reopen the account before answering it.'
				);
			}
			const { steamActed, passphrase } = request;
			const companion = exactCompanion(held, identified);
			const knownAccepted = [held, companion].some((entry) => entry?.record.certain === true);
			if (knownAccepted && !steamActed) {
				throw new EnrollmentError(
					'Steam is known to have accepted that request, so it cannot be recorded as not having happened. Reopen the account and follow the recovery instructions.'
				);
			}
			const guard: OperationResolutionGuard =
				held.source === 'vault'
					? { source: 'vault', operationToken: held.token }
					: { source: 'journal', companion: companionIdentity(held) };
			if (
				steamActed &&
				identified.some(
					(entry) =>
						entry !== held && entry !== companion && entry.record.fingerprint === currentFingerprint
				)
			) {
				throw new EnrollmentError(
					'This account has another unfinished Steam operation. Resolve that record before removing the account here.'
				);
			}

			/*
			 * **The note is spent only once the answer has been acted on.**
			 *
			 * It was cleared here, before the work — and every branch below can fail
			 * without changing anything: a mistyped vault passphrase rejects inside
			 * `reconcileDetached`, and both reconciliations return false when the
			 * authenticator moved on. Each of those deliberately leaves the vault's
			 * record intact so the refusal survives, and the note had already gone.
			 *
			 * Where the note is the only record — which is exactly what it exists for,
			 * the case where `latch`'s vault write never happened — one typo in the
			 * passphrase destroyed the durable refusal, and the next attempt sent the
			 * irreversible request to Steam again.
			 *
			 * So each success path clears it, next to the vault record it belongs
			 * with. A failure leaves both standing.
			 */
			if (!steamActed) {
				// Steam did nothing, so the account is what it always was and the
				// operation is worth trying again. Only the refusal for this exact
				// kind and authenticator is lifted. A disk note for deactivation may
				// coexist with an applicable activation record in the vault (or vice
				// versa); resolving the note must not erase the other debt.
				await clearEvidence(held, companion);
				return { ok: true as const };
			}

			if (kind === 'activate') {
				// The service owns what an activated account looks like — including the
				// revocation-code ceremony and the recovery file, both of which the
				// version written here skipped.
				const reconciliation =
					typeof enrollment.reconcileActivatedWithRecoveryStatus !== 'function'
						? await enrollment.reconcileActivated(
								steamId64,
								authenticatorFingerprint(account),
								guard
							)
						: await enrollment.reconcileActivatedWithRecoveryStatus(
								steamId64,
								authenticatorFingerprint(account),
								guard
							);
				const reconciled =
					typeof reconciliation === 'boolean' ? { applied: reconciliation } : reconciliation;
				if (!reconciled.applied) {
					throw new EnrollmentError(MOVED_ON);
				}
				clearJournalEvidence(held, companion);
				return {
					ok: true as const,
					...(reconciled.recoveryWarning === undefined
						? {}
						: { recoveryWarning: reconciled.recoveryWarning })
				};
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
					authenticatorFingerprint(account),
					guard
				))
			) {
				// Nothing was deleted, so nothing is torn down and nothing is claimed.
				throw new EnrollmentError(MOVED_ON);
			}
			// The same teardown a local removal does: cookie jar, cached session,
			// pending list. Do it immediately after the local deletion: a later
			// journal-cleanup failure must not leave a signed-in session for an
			// account whose vault row is already gone.
			onRemoved(steamId64, true);
			clearJournalEvidence(held, companion);
			return { ok: true as const };
		} finally {
			releaseAccountMutation();
		}
	});

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
	type LocatedOperation =
		| {
				source: 'vault';
				steamId64: string;
				record: NonNullable<Account['unresolvedOperation']>;
				guidance: string;
				token: string;
		  }
		| {
				source: 'journal';
				steamId64: string;
				record: PendingOperation;
				guidance: string;
				token: string;
		  };

	function journalGuidance(note: PendingOperation): string {
		if (note.certain === true) {
			return note.kind === 'activate'
				? 'Steam accepted the request to finish adding this authenticator, but the vault update did not finish. Do not say that Steam did nothing and do not send the request again; follow the recovery instructions.'
				: 'Steam accepted the request to remove this authenticator, but the local vault update did not finish. Do not say that Steam did nothing and do not send the request again; follow the recovery instructions.';
		}
		return note.kind === 'activate'
			? 'This app asked Steam to finish adding an authenticator to this account and never found out what happened — it was interrupted before Steam answered. Sign in to Steam and check whether Steam Guard is on this account before doing anything else here.'
			: 'This app asked Steam to remove this authenticator and never found out what happened — it was interrupted before Steam answered. Sign in to Steam and check whether Steam Guard is still on this account before doing anything else here.';
	}

	function locatedRecords(steamId64: string): {
		account: Account | undefined;
		identified: LocatedOperation[];
		unidentified?: { kind: 'activate' | 'deactivate'; guidance: string };
	} {
		const account = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		const stored = account?.unresolvedOperation;
		const identified: LocatedOperation[] = [];
		if (stored !== undefined && isAuthenticatorFingerprint(stored.fingerprint)) {
			identified.push({
				source: 'vault',
				steamId64,
				record: stored,
				guidance: stored.guidance,
				token: operationRecordToken('vault', { steamId64, ...stored })
			});
		}
		for (const note of journal.readAll(steamId64)) {
			if (!isAuthenticatorFingerprint(note.fingerprint)) {
				throw new Error('the saved Steam operation record has an invalid authenticator identity');
			}
			identified.push({
				source: 'journal',
				steamId64,
				record: note,
				guidance: journalGuidance(note),
				token: operationRecordToken('journal', note)
			});
		}
		return {
			account,
			identified,
			...(stored !== undefined && !isAuthenticatorFingerprint(stored.fingerprint)
				? { unidentified: { kind: stored.kind, guidance: stored.guidance } }
				: {})
		};
	}

	function operationIdOf(operation: LocatedOperation): string | undefined {
		const value =
			operation.source === 'vault'
				? operation.record.operationId
				: operation.record.identity.source === 'v2'
					? operation.record.identity.recordId
					: undefined;
		return isOperationId(value) ? value : undefined;
	}

	function sameOperation(left: LocatedOperation, right: LocatedOperation): boolean {
		const operationId = operationIdOf(left);
		return (
			left.source !== right.source &&
			operationId !== undefined &&
			operationId === operationIdOf(right) &&
			left.steamId64 === right.steamId64 &&
			left.record.kind === right.record.kind &&
			left.record.fingerprint === right.record.fingerprint &&
			left.record.at === right.record.at
		);
	}

	function companionIdentity(operation: LocatedOperation): OperationCompanionIdentity | undefined {
		const operationId = operationIdOf(operation);
		const fingerprint = operation.record.fingerprint;
		return operationId === undefined || !isAuthenticatorFingerprint(fingerprint)
			? undefined
			: {
					operationId,
					kind: operation.record.kind,
					fingerprint,
					at: operation.record.at
				};
	}

	function exactCompanion(
		operation: LocatedOperation,
		all: LocatedOperation[]
	): LocatedOperation | undefined {
		return all.find((candidate) => candidate !== operation && sameOperation(operation, candidate));
	}

	async function clearVaultEvidence(operation: LocatedOperation): Promise<void> {
		if (operation.source !== 'vault') return;
		let recoveryChanged = false;
		await vault.mutate((draft) => {
			const account = draft.accounts.find((entry) => entry.steamId64 === operation.steamId64);
			const record = account?.unresolvedOperation;
			if (
				account === undefined ||
				record === undefined ||
				operationRecordToken('vault', { steamId64: operation.steamId64, ...record }) !==
					operation.token
			) {
				throw new EnrollmentError(MOVED_ON);
			}
			delete account.unresolvedOperation;
			markRecoveryBackupNeeded(account, account.recoveryBackup, new Date().toISOString());
			recoveryChanged = true;
		});
		if (recoveryChanged) {
			await tryRefreshRecoveryBackup(operation.steamId64);
		}
	}

	function clearJournalEvidence(
		operation: LocatedOperation,
		companion: LocatedOperation | undefined
	): void {
		for (const entry of [operation, companion]) {
			if (entry?.source === 'journal') journal.clear(entry.record);
		}
	}

	async function clearEvidence(
		operation: LocatedOperation,
		companion: LocatedOperation | undefined
	): Promise<void> {
		// Clear the vault first. If the journal clear fails, its durable refusal
		// remains; the reverse order could lose the last surviving evidence.
		for (const entry of [operation, companion]) {
			if (entry?.source === 'vault') await clearVaultEvidence(entry);
		}
		clearJournalEvidence(operation, companion);
	}

	function recordFor(
		steamId64: string,
		preferredKind?: 'activate' | 'deactivate'
	): {
		account: Account | undefined;
		held?: LocatedOperation;
		companion?: LocatedOperation;
		stale?: LocatedOperation;
		unidentified?: { kind: 'activate' | 'deactivate'; guidance: string };
	} {
		const { account, identified, unidentified } = locatedRecords(steamId64);
		if (account === undefined) return { account };
		const current = authenticatorFingerprint(account);
		const applies = (entry: LocatedOperation): boolean => entry.record.fingerprint === current;
		const applicable = identified.filter(applies);
		const held =
			applicable.find((entry) => entry.source === 'vault' && entry.record.kind === preferredKind) ??
			applicable.find((entry) => entry.source === 'vault') ??
			applicable.find((entry) => entry.record.kind === preferredKind) ??
			applicable[0];
		if (held !== undefined) {
			const companion = exactCompanion(held, identified);
			return { account, held, ...(companion === undefined ? {} : { companion }) };
		}
		if (unidentified !== undefined) return { account, unidentified };
		const staleCandidates = identified.filter((entry) => !applies(entry));
		const stale =
			staleCandidates.find(
				(entry) => entry.source === 'vault' && entry.record.kind === preferredKind
			) ??
			staleCandidates.find((entry) => entry.source === 'vault') ??
			staleCandidates.find((entry) => entry.record.kind === preferredKind) ??
			staleCandidates[0];
		return { account, ...(stale === undefined ? {} : { stale }) };
	}

	function heldBack(
		steamId64: string,
		preferredKind: 'activate' | 'deactivate'
	):
		| {
				state: 'uncertain' | 'staleOperation' | 'unidentifiedOperation';
				kind: 'activate' | 'deactivate';
				guidance: string;
				certain?: boolean;
				persisted?: boolean;
				staleToken?: string;
				operationToken?: string;
		  }
		| undefined {
		let held: LocatedOperation | undefined;
		let companion: LocatedOperation | undefined;
		let stale: LocatedOperation | undefined;
		let unidentified: { kind: 'activate' | 'deactivate'; guidance: string } | undefined;
		try {
			({ held, companion, stale, unidentified } = recordFor(steamId64, preferredKind));
		} catch {
			throw new EnrollmentError(
				'The saved Steam operation safety records cannot be read, so no request was sent. ' +
					'Repair the application data folder or update the app, then try again.',
				false
			);
		}
		if (held === undefined) {
			if (unidentified !== undefined) {
				return {
					state: 'unidentifiedOperation',
					kind: unidentified.kind,
					guidance:
						`${unidentified.guidance} This safety record does not identify which authenticator it describes, ` +
						'so this app cannot safely clear it, apply it to the current secrets, or contact Steam. Keep your backup and contact support before changing Steam Guard.',
					persisted: true
				};
			}
			return stale === undefined
				? undefined
				: {
						state: 'staleOperation',
						kind: stale.record.kind,
						guidance:
							'An old safety record belongs to an authenticator that is no longer stored here. ' +
							'No new request was sent. Clear only that old record before trying again.',
						persisted: true,
						staleToken: stale.token
					};
		}
		// Either exact companion can carry the durable one-way fact. Prefer the
		// guidance from the evidence that actually knows Steam accepted the request,
		// so the heading, copy, and resolution choices all tell the same story.
		const accepted = [held, companion].find((entry) => entry?.record.certain === true);
		return accepted !== undefined
			? {
					state: 'uncertain',
					kind: held.record.kind,
					guidance: accepted.guidance,
					certain: true,
					persisted: true,
					operationToken: held.token
				}
			: {
					state: 'uncertain',
					kind: held.record.kind,
					guidance: held.guidance,
					persisted: true,
					operationToken: held.token
				};
	}

	registerHandler(CHANNELS.enrollActivate, async ({ steamId64, code }) => {
		requireUnlocked();
		let releaseProtectedOperation: () => void;
		try {
			releaseProtectedOperation = keyCoordinator.beginActivation(steamId64);
		} catch (err) {
			throw new EnrollmentError(
				err instanceof Error ? err.message : 'Another protected operation is in progress.',
				false
			);
		}
		try {
			const blocked = heldBack(steamId64, 'activate');
			if (blocked !== undefined) {
				return blocked;
			}
			if (accountMutationBlocked(steamId64)) {
				throw new EnrollmentError(
					'Finish or resolve this account’s saved authenticator workflow before asking Steam to activate it.',
					false
				);
			}
			// Sampled before the request goes, so a row replaced while Steam is failing
			// to answer cannot be what the record ends up describing.
			const ran = operatedOn(steamId64);

			// **Written down before the request goes.** `latch` below runs after Steam
			// answers, so a lock on the idle timer, a crash or a power cut in between
			// left no trace at all — and the account then looked ordinary, with the same
			// irreversible button on it.
			const note = journal.record({
				steamId64,
				kind: 'activate',
				fingerprint: ran,
				at: new Date().toISOString()
			});

			let knownState:
				| Awaited<ReturnType<EnrollmentService['activateWithRecoveryStatus']>>
				| 'activated'
				| 'wantMore';
			try {
				knownState =
					typeof enrollment.activateWithRecoveryStatus !== 'function'
						? await enrollment.activate(steamId64, code)
						: await enrollment.activateWithRecoveryStatus(steamId64, code);
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
					try {
						journal.clear(note);
					} catch {
						throw new EnrollmentError(
							`The activation did not change Steam (${known instanceof Error ? known.message : 'the request was refused'}), ` +
								'but its safety record could not be cleared. The action remains blocked; repair the application data folder and resolve the saved record.',
							false
						);
					}
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
				const { durableNote, persisted } = await persistOperationOutcome(
					steamId64,
					'activate',
					outcome,
					note
				);
				/*
				 * Keep the independent pre-send note even when the richer vault latch
				 * lands. That save puts the pre-latch vault into `.bak`; clearing the note
				 * here let Restore from backup erase the only refusal and offer the same
				 * irreversible request again. A known outcome or explicit resolution
				 * clears both records together.
				 */
				// The promise the screen makes — that this will not be sent again — is now
				// backed by the note whenever the vault write is the thing that failed.
				return {
					...outcome,
					kind: 'activate' as const,
					persisted: persisted !== undefined || journal.inspect(durableNote) === 'pending',
					operationToken:
						persisted === undefined
							? operationRecordToken('journal', durableNote)
							: operationRecordToken('vault', { steamId64, ...persisted })
				};
			}
			// Keep a known Steam/vault result out of the uncertainty classifier. If
			// cleanup fails, the note deliberately remains and blocks repetition.
			try {
				journal.clear(note);
			} catch {
				throw new EnrollmentError(
					`Steam answered the activation request (${typeof knownState === 'string' ? knownState : knownState.state}), and the vault was updated, ` +
						'but its safety record could not be cleared. The action will not be repeated; reopen the account and resolve the saved record.',
					false
				);
			}
			return typeof knownState === 'string' ? { state: knownState } : knownState;
		} finally {
			releaseProtectedOperation();
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
			let releaseProtectedOperation: () => void;
			try {
				releaseProtectedOperation = keyCoordinator.beginDeactivation(steamId64);
			} catch (err) {
				throw new EnrollmentError(
					err instanceof Error ? err.message : 'Another protected operation is in progress.',
					false
				);
			}
			try {
				const blocked = heldBack(steamId64, 'deactivate');
				if (blocked !== undefined) {
					return blocked;
				}
				if (accountMutationBlocked(steamId64)) {
					throw new EnrollmentError(
						'Finish or resolve this account’s saved authenticator workflow before asking Steam to remove it.',
						false
					);
				}

				// Before the request goes. See `latch`.
				const ran = operatedOn(steamId64);

				// Before the request goes, for the reason given on the activation path.
				const note = journal.record({
					steamId64,
					kind: 'deactivate',
					fingerprint: ran,
					at: new Date().toISOString()
				});

				try {
					await enrollment.deactivate(steamId64, passphrase);
				} catch (err) {
					let outcome: { state: 'uncertain'; guidance: string; certain?: boolean };
					try {
						outcome = uncertainOrRethrow(err);
					} catch (known) {
						// A refusal, not an uncertainty. See the activation path.
						try {
							journal.clear(note);
						} catch {
							throw new EnrollmentError(
								`The removal did not change Steam (${known instanceof Error ? known.message : 'the request was refused'}), ` +
									'but its safety record could not be cleared. The action remains blocked; repair the application data folder and resolve the saved record.',
								false
							);
						}
						throw known;
					}
					/*
					 * The account is still in the vault — a removal whose outcome is
					 * unknown does not get to delete the secrets that might still be the
					 * live ones — so there is a row to write this on. Whether the write
					 * landed travels with the outcome; see the activation path above.
					 */
					const { durableNote, persisted } = await persistOperationOutcome(
						steamId64,
						'deactivate',
						outcome,
						note
					);
					// The pre-send note stays beside the vault latch until a known outcome
					// or explicit resolution. See the activation path: `.bak` predates this
					// latch and must not be able to erase the only refusal.
					return {
						...outcome,
						kind: 'deactivate' as const,
						persisted: persisted !== undefined || journal.inspect(durableNote) === 'pending',
						operationToken:
							persisted === undefined
								? operationRecordToken('journal', durableNote)
								: operationRecordToken('vault', { steamId64, ...persisted })
					};
				}

				// The same cleanup a local removal does: cookie jar, cached session,
				// pending list. An account whose authenticator is gone must not still have
				// a live session sitting in memory.
				onRemoved(steamId64, true);
				try {
					journal.clear(note);
				} catch {
					throw new EnrollmentError(
						'Steam removed the authenticator and the account was removed from this vault, but the safety record could not be cleared. Nothing will be sent again; repair the application data folder.',
						false
					);
				}
				return { ok: true as const };
			} finally {
				releaseProtectedOperation();
			}
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

		const releaseAccountMutation = keyCoordinator.beginAccountMutation(identity);
		try {
			// The reservation closes the interval between this read and the write. An
			// irreversible submission cannot create a journal in that interval, and a
			// concurrent import/remove cannot change which account this decision saw.
			requireUnlocked();
			const already = vault.read().accounts.some((entry) => entry.steamId64 === identity);
			if (already) {
				// Not an error. Somebody recovering a file they did not need should be
				// told that plainly rather than shown a failure.
				return { state: 'alreadyPresent' as const, accountName: recovered.accountName };
			}
			if (accountMutationBlocked(identity)) {
				throw new RecoveryError(
					'finish or resolve this account’s unfinished authenticator operation before restoring an older recovery file.'
				);
			}

			await vault.mutate((draft) => {
				draft.accounts.push(recovered.account);
			});
		} finally {
			releaseAccountMutation();
		}

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
			const releaseAccountSnapshot = keyCoordinator.beginAccountSnapshot(steamId64);
			try {
				// And re-read, for the same reason. The copy taken before the dialog
				// outlives anything that happened during it — writing it out for an
				// account since removed would put secrets the user just chose to be rid of
				// into a fresh plaintext file.
				const current = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
				if (!current) {
					throw new Error('that account is no longer in this vault, so nothing was exported.');
				}

				// Stage the plaintext beside the destination under an owner-only, unique
				// name. The final name is claimed separately with a no-clobber operation;
				// an occupied destination is always refused and never replaced.
				const temp = `${destination}.${randomUUID()}.tmp`;

				/*
				 * What this file is about to contain, captured byte for byte before the
				 * write. The same projection is made from the live account at both commit
				 * boundaries below. Comparing the serialized maFile rather than a hand-picked
				 * fingerprint means `fully_enrolled`, device metadata and any future exported
				 * field cannot change unnoticed, while routing and automatic-confirmation
				 * settings — which the maFile does not contain — do not create false races.
				 */
				const contents = toMaFile(current);

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
				const giveUp = async (
					alsoLeft: readonly string[] = [],
					possiblyLeft: readonly string[] = []
				): Promise<never> => {
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
							stillOnDisk([...alsoLeft, ...staged]) +
							possiblyStillOnDisk(possiblyLeft)
					);
				};

				try {
					await writeFile(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
					await flushFile(temp);
					if ((await readFile(temp, 'utf8')) !== contents) {
						throw new Error('the staged export did not read back exactly');
					}
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
					 * publication still completed and put a plaintext maFile at the destination,
					 * carrying the same secrets as the vault and none of its encryption,
					 * after the application had been told nobody is present.
					 *
					 * Publication is the moment the file becomes real, so this is the last
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
					 * authenticator replaced, while it runs. Publication then exposed a
					 * plaintext maFile holding secrets the vault no longer has, and told the
					 * user it had saved their account.
					 *
					 * Removed is the worse half: it puts the secrets somebody just chose to
					 * be rid of into a fresh unencrypted file at a path of their choosing.
					 * Replaced is quieter and lasts longer — a backup that silently holds
					 * the previous authenticator, which Steam has already stopped accepting,
					 * discovered at the one moment it is ever used.
					 *
					 * Compared as the complete export projection rather than on presence,
					 * because "still in the vault" is true of a re-enrolled account and a
					 * status transition can change `fully_enrolled` without changing a secret.
					 */
					const stillThere = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
					if (!stillThere || toMaFile(stillThere) !== contents) {
						const staged = (await removed(temp)) ? [] : [basename(temp)];
						throw raceLost(!stillThere, staged);
					}
				}

				// Node has no portable conditional replacement for an occupied path. Refuse
				// every occupied name, then use an atomic no-clobber claim for the absent
				// path so a competing writer at the publication boundary is preserved.
				const destinationState = await stat(destination).then(
					() => 'occupied' as const,
					(err: NodeJS.ErrnoException) =>
						err.code === 'ENOENT' ? ('absent' as const) : ('unknown' as const)
				);
				if (destinationState === 'occupied') {
					const staged = (await removed(temp)) ? [] : [basename(temp)];
					throw new Error(
						`${suggested} was not saved because that name is already in use. Choose an unused file name; the existing file was left unchanged.` +
							stillOnDisk(staged)
					);
				}
				if (destinationState === 'unknown') {
					await giveUp();
				}
				const publishAccount = vault.isUnlocked()
					? vault.read().accounts.find((entry) => entry.steamId64 === steamId64)
					: undefined;
				if (!vault.isUnlocked() || !publishAccount || toMaFile(publishAccount) !== contents) {
					const left: string[] = [];
					const staged = (await removed(temp)) ? [] : [basename(temp)];
					if (!vault.isUnlocked()) {
						throw left.length + staged.length === 0
							? new VaultLockedError()
							: new VaultLockedError(`the vault is locked.${stillOnDisk([...left, ...staged])}`);
					}
					throw raceLost(!publishAccount, [...left, ...staged]);
				}

				const abandonPublication = async (destinationClaimed: boolean): Promise<never> => {
					const atDestination = await identifies(destination, contents);
					const stranded: string[] = [];
					const possible: string[] = [];
					if (atDestination === 'exact') {
						if (!(await removed(destination))) {
							stranded.push(basename(destination));
						}
					} else if (destinationClaimed && atDestination !== 'absent') {
						// A fallback write can fail after creating only a prefix. It is not safe
						// to delete a non-exact file because another process may have replaced it.
						possible.push(basename(destination));
					}
					return giveUp(stranded, possible);
				};

				const publication = await publishAbsent(temp, destination, contents);
				if (!publication.published) {
					await abandonPublication(publication.destinationClaimed);
				}
				try {
					await flushDirectory(dirname(destination));
				} catch {
					await abandonPublication(true);
				}
				if ((await identifies(destination, contents)) !== 'exact') {
					await abandonPublication(true);
				}

				// Publication is a filesystem wait. Re-check both lock state and the exact
				// serialized account afterwards, then remove only bytes proven to be ours.
				const stillOurs = vault.isUnlocked()
					? vault.read().accounts.find((entry) => entry.steamId64 === steamId64)
					: undefined;
				if (!vault.isUnlocked() || !stillOurs || toMaFile(stillOurs) !== contents) {
					const atDestination = await identifies(destination, contents);
					const left: string[] = [];
					if (atDestination === 'exact' && !(await removed(destination))) {
						left.push(basename(destination));
					}

					if (!vault.isUnlocked()) {
						throw left.length === 0
							? new VaultLockedError()
							: new VaultLockedError(`the vault is locked.${stillOnDisk(left)}`);
					}
					throw raceLost(!stillOurs, left);
				}

				// Best effort after the durable write: Windows has no POSIX mode, while
				// POSIX destinations must remain owner-only.
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
					fileName: basename(destination)
				};
			} finally {
				releaseAccountSnapshot();
			}
		});
	});
}
