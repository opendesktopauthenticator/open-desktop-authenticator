import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	createLoginSession,
	describeProxyLoginError,
	PROXY_POLICY_STOPPED,
	VAULT_LOCKED_DURING_SIGN_IN,
	type LoginSessionFactory,
	type LoginSessionLike
} from './login';
import {
	EnrollmentError,
	EnrollmentPartialSecretsError,
	EnrollmentSecretsError,
	finalizeEnrollment,
	removeAuthenticator,
	startEnrollment
} from './enroll';
import { isUsableMobileToken } from '../steam-jwt';
import { mintAccessToken } from './access-token';
import { storedFaithfully } from './transfer-store';
import { planProxy, redactCredentials } from '../net/egress';
import type { SteamTransportFactory } from '../net/transport';
import type { VaultService } from '../vault/service';
import { wipe } from '../vault/crypto';
import { VaultKeyOperationCoordinator } from '../vault/key-operation-coordinator';
import {
	finishRecoveryBackup,
	markRecoveryBackupNeeded,
	recoveryBackupNeedsAttention
} from '../vault/recovery-state';
import { accountSchema, type Account } from '../../shared/vault-schema';
import { newAutoConfirm } from '../../shared/vault-schema';
import type {
	EnrollmentWorkflowRecord,
	SealedWorkflowPayload,
	WorkflowJournal
} from './workflow-journal';
import { noWorkflowJournal } from './workflow-journal';
import {
	authenticatorFingerprint,
	authenticatorSecretProblem,
	describeAuthenticatorSecretProblem,
	isAuthenticatorFingerprint,
	operationRecordToken
} from './authenticator-secrets';

export { authenticatorFingerprint } from './authenticator-secrets';

/**
 * Keep proxy-controlled prose out of every renderer-visible enrollment error.
 *
 * Enrollment owns its LoginSession directly so it can pause for an emailed
 * Guard code. That means its two failure arms do not pass through `signIn`, and
 * must deliberately share the same numeric-status/local-wording classifier.
 * Ordinary Steam/library errors retain the existing credential-redacted text.
 */
function describeEnrollmentLoginError(error: unknown): string {
	const proxy = describeProxyLoginError(error);
	if (proxy !== undefined) return proxy;
	return `Steam refused the sign-in: ${redactCredentials(
		error instanceof Error ? error.message : String(error)
	)}`;
}

/** The email-code request is another request on the same untrusted proxy. */
function describeEnrollmentCodeError(error: unknown): string {
	const proxy = describeProxyLoginError(error);
	if (proxy !== undefined) return proxy;
	return `Steam did not accept that code: ${redactCredentials(
		error instanceof Error ? error.message : String(error)
	)}`;
}

export interface OperationCompanionIdentity {
	operationId: string;
	kind: 'activate' | 'deactivate';
	fingerprint: string;
	at: string;
}

/**
 * What the reconciliation is allowed to consume from the vault.
 *
 * A vault-backed answer must still name that exact record at the write. A
 * journal-backed answer may proceed only when the vault has no competing debt,
 * or carries the companion written by the same operation.
 */
export type OperationResolutionGuard =
	| { source: 'vault'; operationToken: string }
	| { source: 'journal'; companion?: OperationCompanionIdentity | undefined };

function companionMatches(
	record: NonNullable<Account['unresolvedOperation']>,
	companion: OperationCompanionIdentity | undefined
): boolean {
	return (
		companion !== undefined &&
		record.operationId === companion.operationId &&
		record.kind === companion.kind &&
		record.fingerprint === companion.fingerprint &&
		record.at === companion.at
	);
}

function resolutionMayConsume(
	steamId64: string,
	fingerprint: string,
	record: Account['unresolvedOperation'],
	guard: OperationResolutionGuard
): boolean {
	if (guard.source === 'vault') {
		return (
			record !== undefined &&
			operationRecordToken('vault', { steamId64, ...record }) === guard.operationToken
		);
	}
	return (
		record === undefined ||
		companionMatches(record, guard.companion) ||
		(isAuthenticatorFingerprint(record.fingerprint) && record.fingerprint !== fingerprint)
	);
}

/**
 * Adding a brand-new account to the vault, authenticator and all (§12 F3).
 *
 * ## The rule this class exists to enforce
 *
 * `AddAuthenticator` changes the Steam account. The moment it returns, Steam has
 * attached an authenticator and issued the only copy of its secrets that will
 * ever exist — and the account is now unusable without them.
 *
 * So: **the secrets are written to the vault before anything else happens.**
 * Before the user is told it worked, before the SMS code is requested, before
 * the activation call. Everything after that point is recoverable; everything
 * before it is not. The `pendingActivation` status marks the window.
 *
 * If the process is killed between the write and the activation, the account is
 * in the vault, the revocation code is in the vault, and the user can finish or
 * recover. That is the whole design.
 *
 * ## Why sign-in is different here
 *
 * Every other sign-in in this application is for an account that already has an
 * authenticator, so Steam asks for a device code and `generateGuardCode` answers
 * it. An account being enrolled has none — by definition — so Steam asks for an
 * **emailed** code instead, and only a person can supply that.
 *
 * That makes this the one flow with a genuine pause in the middle, which is why
 * the `LoginSession` is held across calls rather than rebuilt: starting a fresh
 * one sends a second email and invalidates the code the user is looking at.
 */

/** How long a half-finished enrollment stays resumable before it is dropped. */
const PENDING_TTL_MS = 15 * 60_000;

/**
 * How long to wait for Steam to finish a sign-in.
 *
 * The same ninety seconds `login.ts` uses, and for the same reason: the
 * library's `timeout` event is not guaranteed to fire, and a promise that never
 * settles is a screen that never moves.
 */
const SIGN_IN_TIMEOUT_MS = 90_000;
const MAX_PROXY_URL_LENGTH = 8 * 1024;

export type BeginOutcome =
	/** Steam emailed a code. Call `submitEmailCode` with it. */
	| { state: 'needsEmailCode'; emailDomain?: string }
	/** Enrolled and stored. The revocation code must be backed up before activating. */
	| {
			state: 'enrolled';
			steamId64: string;
			accountName: string;
			phoneNumberHint?: string;
			hasRevocationCode?: boolean;
			recoveryWarning?: string;
			recoveryAttemptId?: string;
			recoveryAt?: string;
	  };

export interface ActivationOutcome {
	state: 'activated' | 'wantMore';
	/** Steam and the vault succeeded; only the separate encrypted backup is stale. */
	recoveryWarning?: string;
}

export interface ReconcileActivatedOutcome {
	applied: boolean;
	recoveryWarning?: string;
}

const RECOVERY_BACKUP_WARNING =
	'Steam Guard is active and the vault was updated, but the encrypted recovery backup could not be updated. Keep this vault backed up; that recovery file may still say activation is unfinished.';
const RECOVERY_PUBLICATION_WARNING =
	'The authenticator is safely stored in this vault, but its separate encrypted recovery backup could not be written. The encrypted workflow record was kept. Repair the application data folder and choose “Finish recovery backup”; Steam will not be contacted again.';

/**
 * Steam's outcome is already accounted for, but the local workflow record
 * survived because its cleanup failed. This is actionable cleanup debt, not an
 * ordinary retryable error. `certain` is carried separately because this class
 * is also used for a proven pre-send failure, where Steam definitely did not
 * act.
 */
export class EnrollmentCleanupError extends Error {
	readonly certain: boolean;

	constructor(message: string, certain = false) {
		super(message);
		this.name = 'EnrollmentCleanupError';
		this.certain = certain;
	}
}

export interface EnrollmentServiceOptions {
	now?: () => number;
	/** Elapsed time for the email-code pause; immune to wall-clock corrections. */
	monotonicNow?: () => number;
	timeOffsetSeconds?: () => number;
	loginSession?: LoginSessionFactory;
	startEnrollment?: typeof startEnrollment;
	finalizeEnrollment?: typeof finalizeEnrollment;
	removeAuthenticator?: typeof removeAuthenticator;
	/**
	 * Writes the per-account recovery file. Injected so tests can observe it, and
	 * so this class never learns where the app's data directory is.
	 *
	 * Optional: an enrollment must not fail because a backup could not be written.
	 */
	writeRecovery?: (account: Account) => string;
	/**
	 * Corrects the recovery file once activation has succeeded.
	 *
	 * The file has to be written before activation — that is the window it exists
	 * to survive — so it necessarily records `pendingActivation`. Left uncorrected,
	 * restoring it after an ordinary activate-then-remove produced an account the
	 * app thought had never been activated, offered to finish, and could not.
	 *
	 * Optional and best-effort, exactly like `writeRecovery`: a backup that cannot
	 * be refreshed is not a reason to fail an activation Steam has accepted.
	 */
	updateRecovery?: (account: Account) => unknown;
	/** Durable intent written before AddAuthenticator, once SteamID is known. */
	workflowJournal?: WorkflowJournal;
	/** Shared with transfer and vault IPC so only one key-bound Steam request can run. */
	keyCoordinator?: VaultKeyOperationCoordinator;
	/**
	 * Process-only transfer cleanup debt is absent from the durable journal after
	 * unlink succeeds but its directory flush fails. It still excludes every new
	 * enrollment until the exact transfer record is reconciled.
	 */
	transferCleanupBlocked?: () => boolean;
}

interface PendingLogin {
	session: LoginSessionLike;
	accountName: string;
	/** Carried across the email-code pause so the enrollment finishes on the same route. */
	proxyUrl: string | undefined;
	startedAtElapsedMs: number;
	/** Resolves when the library reports the session authenticated. */
	authenticated: Promise<void>;
}

interface HeldEnrollment {
	account: Account;
	phoneNumberHint?: string;
}

function enrollmentAad(
	record: Pick<
		EnrollmentWorkflowRecord,
		'version' | 'kind' | 'attemptId' | 'steamId64' | 'accountName' | 'at'
	>
): Buffer {
	return Buffer.from(
		JSON.stringify([
			'oda-enrollment',
			record.version,
			record.kind,
			record.attemptId,
			record.steamId64,
			record.accountName,
			record.at
		]),
		'utf8'
	);
}

function sealEnrollment(
	held: HeldEnrollment,
	key: Buffer,
	record: EnrollmentWorkflowRecord
): SealedWorkflowPayload {
	return sealEnrollmentPayload(held, key, record);
}

function sealEnrollmentPayload(
	value: unknown,
	key: Buffer,
	record: EnrollmentWorkflowRecord
): SealedWorkflowPayload {
	const nonce = randomBytes(12);
	const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
	try {
		const cipher = createCipheriv('aes-256-gcm', key, nonce);
		cipher.setAAD(enrollmentAad(record));
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			nonce: nonce.toString('base64'),
			tag: cipher.getAuthTag().toString('base64'),
			ciphertext: ciphertext.toString('base64')
		};
	} finally {
		wipe(plaintext);
	}
}

function openEnrollment(
	sealed: SealedWorkflowPayload,
	key: Buffer,
	record: EnrollmentWorkflowRecord
): HeldEnrollment {
	const nonce = Buffer.from(sealed.nonce, 'base64');
	const tag = Buffer.from(sealed.tag, 'base64');
	if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16) {
		throw new EnrollmentError(
			'The saved enrollment recovery material has invalid encryption fields.'
		);
	}
	let plaintext: Buffer | undefined;
	let update: Buffer | undefined;
	let final: Buffer | undefined;
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, nonce);
		decipher.setAAD(enrollmentAad(record));
		decipher.setAuthTag(tag);
		// `update` exposes unauthenticated plaintext before `final` verifies the tag.
		// Keep and wipe both intermediates even when `final` throws.
		update = decipher.update(Buffer.from(sealed.ciphertext, 'base64'));
		final = decipher.final();
		plaintext = Buffer.allocUnsafe(update.length + final.length);
		update.copy(plaintext, 0);
		final.copy(plaintext, update.length);
		const decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
		if (typeof decoded !== 'object' || decoded === null) throw new Error('not an object');
		const value = decoded as { account?: unknown; phoneNumberHint?: unknown };
		const account = accountSchema.parse(value.account);
		if (account.steamId64 !== record.steamId64) throw new Error('SteamID mismatch');
		if (
			value.phoneNumberHint !== undefined &&
			(typeof value.phoneNumberHint !== 'string' || value.phoneNumberHint.length > 64)
		) {
			throw new Error('invalid phone hint');
		}
		return value.phoneNumberHint === undefined
			? { account }
			: { account, phoneNumberHint: value.phoneNumberHint };
	} catch (err) {
		if (err instanceof EnrollmentError) throw err;
		throw new EnrollmentError(
			'The saved authenticator could not be decrypted or validated. Do not add another one; ' +
				'restore the matching vault or contact support.'
		);
	} finally {
		if (update !== undefined) wipe(update);
		if (final !== undefined) wipe(final);
		if (plaintext !== undefined) wipe(plaintext);
	}
}

export class EnrollmentService {
	private readonly vault: VaultService;
	private readonly transports: SteamTransportFactory;
	private readonly now: () => number;
	private readonly monotonicNow: () => number;
	private readonly offset: () => number;
	private readonly loginSession: LoginSessionFactory;
	private readonly start: typeof startEnrollment;
	private readonly finalize: typeof finalizeEnrollment;
	private readonly detach: typeof removeAuthenticator;
	private readonly writeRecovery: ((account: Account) => string) | undefined;
	private readonly updateRecovery: ((account: Account) => unknown) | undefined;
	private readonly workflowJournal: WorkflowJournal;
	private readonly keyCoordinator: VaultKeyOperationCoordinator;
	private readonly transferCleanupBlocked: () => boolean;

	/**
	 * An encrypted successful reply whose durable record update failed.
	 *
	 * The plaintext and raw content key are gone. This ciphertext lets the current
	 * process retry publishing the recoverable record, but unlike the record it does
	 * not survive a restart, so the renderer must never promise that it does.
	 */
	private stagedRecovery:
		| {
				record: EnrollmentWorkflowRecord;
				recovery: SealedWorkflowPayload;
				usable: boolean;
		  }
		| undefined;
	private persistingRecovery = false;

	/**
	 * Same-process knowledge that Steam definitely attached an authenticator.
	 *
	 * Normally that fact is advanced durably from `sending` to `attached`. If the
	 * update itself fails, the conservative `sending` record remains, but the
	 * answer that just arrived still proves attachment. Keep that stronger fact
	 * here so this running process cannot offer or accept “not attached”. A restart
	 * deliberately falls back to the durable conservative record and asks the user
	 * to verify Steam, because the stronger fact was never durably published.
	 */
	private readonly knownAttachedAttempts = new Set<string>();

	/**
	 * Exact cleanup debt retained when unlink succeeded but its directory flush
	 * failed. An immediate listing can be empty while the deletion is still not
	 * crash-durable, so this running process must keep the workflow blocked and
	 * retry the same clear rather than treating absence as success.
	 */
	private cleanupDebt: EnrollmentWorkflowRecord | undefined;

	/**
	 * Clear one exact enrollment record while preserving the distinction between
	 * a durable failure and a post-unlink directory-flush failure.
	 *
	 * In the latter case the record exists only in this process, so backup restore
	 * and account mutation must stay blocked until the same clear is flushed.
	 * Failure to read the journal is treated as absent: unknown is not permission
	 * to replace the vault that holds Steam's issued secrets.
	 */
	private clearWorkflowRecord(record: EnrollmentWorkflowRecord): void {
		try {
			this.workflowJournal.clearEnrollment(record);
			if (this.cleanupDebt?.attemptId === record.attemptId) this.cleanupDebt = undefined;
		} catch (err) {
			let stillDurable = false;
			try {
				stillDurable = this.workflowJournal
					.enrollments(record.steamId64)
					.some((entry) => entry.attemptId === record.attemptId);
			} catch {
				// Unknown remains process-only debt so every destructive gate fails closed.
			}
			if (stillDurable) {
				if (this.cleanupDebt?.attemptId === record.attemptId) this.cleanupDebt = undefined;
			} else {
				this.cleanupDebt = record;
			}
			throw err;
		}
	}

	/**
	 * One at a time, deliberately.
	 *
	 * Enrolling is a deliberate, attended act with a code arriving on a phone.
	 * Supporting several at once would mean juggling which email code belongs to
	 * which session, and getting that wrong attaches an authenticator to the
	 * wrong account.
	 */
	/** Guards `submitEmailCode` against overlapping submissions. */
	private submittingEmailCode = false;

	private pendingLogin: PendingLogin | undefined;

	/** Access tokens for accounts mid-enrollment, so activation need not sign in again. */
	private readonly tokens = new Map<string, string>();

	/**
	 * **Accounts with an irreversible Steam operation in flight.**
	 *
	 * One set for both, and that is the whole point. Activation and removal had a
	 * mutex each, so each refused a second of its own kind and neither could see
	 * the other — and they concern the same authenticator. Both could reach Steam
	 * at once, and when both outcomes came back uncertain the second record
	 * overwrote the first, losing the durable warning about the operation that
	 * started earlier.
	 *
	 * It is reachable without contrivance: a notification click navigates away
	 * from the activation screen while it is still waiting on Steam, and Remove
	 * is available from the account list the moment it lands.
	 *
	 * The value carries what is running, so the refusal can say which, **and a
	 * token identifying the attempt**.
	 *
	 * Without the token this was worse than the two mutexes it replaced.
	 * `forget()` cleared the whole map on lock while a Steam request was still
	 * running, so unlocking let a second operation start; the first one's
	 * `finally` then deleted unconditionally, removing the second's marker and
	 * letting a third begin. Reproduced: activation A in flight, lock and unlock
	 * admits removal B, A settles and admits removal C while B is still running.
	 *
	 * So each attempt owns its entry and removes only its own, and a lock no
	 * longer clears entries belonging to operations that have not settled.
	 */
	private readonly inFlight = new Map<string, { kind: 'activation' | 'removal'; token: string }>();

	/**
	 * True from the first line of `begin` until it settles.
	 *
	 * `discardPending` was the only guard, and it cannot be one: `pendingLogin` is
	 * not assigned until after `startWithCredentials` has been awaited, so two
	 * overlapping calls both found nothing pending, both opened a `LoginSession`,
	 * and both could reach `enrol`. The class documents "one at a time,
	 * deliberately"; this is what makes that true.
	 *
	 * A flag rather than a queue, because the second caller should be told no
	 * rather than silently held: enrolling is an attended act with a code arriving
	 * on a phone, and two of them at once is a mistake, not a workload.
	 */
	private beginning = false;

	/**
	 * Every `LoginSession` this service has opened and not yet finished with.
	 *
	 * `pendingLogin` only covers the pause waiting for an emailed code. Once that
	 * code is submitted it is cleared and the session continues into `enrol` as a
	 * local variable — and on the password-only path it is never set at all. So
	 * for the whole of `enrol`, and for every sign-in that needs no email code,
	 * there was no reference a lock could reach, and an authenticated session
	 * outlived the lock that was supposed to end it.
	 */
	private readonly liveSessions = new Set<LoginSessionLike>();

	/**
	 * Live sign-in sessions that are **not** going through a proxy.
	 *
	 * A subset of `liveSessions`, kept beside it rather than derived, because the
	 * route is known only at `begin` and the session carries no record of it.
	 *
	 * **`pendingLogin` is not a substitute.** It is assigned after
	 * `startWithCredentials` has been awaited — which is exactly the window in
	 * which the password is on the wire — so a policy change landing there found
	 * nothing pending and cancelled nothing. `liveSessions` is registered the
	 * moment the session exists, for that same reason, and this narrows it to
	 * the ones a proxy rule would forbid.
	 */
	private readonly unroutedSessions = new Set<LoginSessionLike>();

	/**
	 * Sessions **this application** stopped, and why.
	 *
	 * A cancelled `startWithCredentials` rejects, and the catch around it reports
	 * "Steam refused the sign-in" — which is true of a rejected password and
	 * false of every cancellation. A user who had just switched `Require
	 * proxies` on was told Steam had refused them, and a lock produced the same
	 * sentence. `login.ts` carries a reason through its own cancel callback for
	 * exactly this; enrolment does not use that callback, so it records the
	 * reason here instead.
	 */
	private readonly stoppedBy = new WeakMap<LoginSessionLike, string>();

	/**
	 * Whether Steam said it had a phone to text, per account mid-enrollment.
	 *
	 * Remembered from `AddAuthenticator` rather than inferred later, because it
	 * decides how the activation code is delivered — and therefore what to tell
	 * Steam when checking it. An account with no phone enrols perfectly well and
	 * gets its code by email (F-10, settled by live run).
	 */
	private readonly textedTheCode = new Map<string, boolean>();

	constructor(
		vault: VaultService,
		transports: SteamTransportFactory,
		options: EnrollmentServiceOptions = {}
	) {
		this.vault = vault;
		this.transports = transports;
		this.now = options.now ?? ((): number => Date.now());
		this.monotonicNow = options.monotonicNow ?? ((): number => performance.now());
		this.offset = options.timeOffsetSeconds ?? ((): number => 0);
		this.loginSession = options.loginSession ?? createLoginSession;
		this.start = options.startEnrollment ?? startEnrollment;
		this.finalize = options.finalizeEnrollment ?? finalizeEnrollment;
		this.detach = options.removeAuthenticator ?? removeAuthenticator;
		this.writeRecovery = options.writeRecovery;
		this.updateRecovery = options.updateRecovery;
		this.workflowJournal = options.workflowJournal ?? noWorkflowJournal();
		this.keyCoordinator = options.keyCoordinator ?? new VaultKeyOperationCoordinator();
		this.transferCleanupBlocked = options.transferCleanupBlocked ?? (() => false);
	}

	/** The newest pre-account enrollment that still needs a human answer. */
	unresolvedEnrollment(): EnrollmentWorkflowRecord | undefined {
		const durable = this.workflowJournal.enrollments()[0];
		return this.cleanupDebt ?? durable;
	}

	/** Whether this exact attempt has restart-safe or process-only encrypted secrets. */
	recoveryState(
		record: Pick<EnrollmentWorkflowRecord, 'attemptId'>
	): 'durable' | 'memory' | undefined {
		let current: EnrollmentWorkflowRecord | undefined;
		try {
			current = this.workflowJournal
				.enrollments()
				.find((entry) => entry.attemptId === record.attemptId);
		} catch {
			return record.attemptId === this.stagedRecovery?.record.attemptId ? 'memory' : undefined;
		}
		if (current?.state === 'recoverable' || current?.state === 'unreadable') {
			if (record.attemptId === this.stagedRecovery?.record.attemptId) {
				// `replaceDurably` may publish the final record and then report a failed
				// directory flush. A readable exact final is authoritative; retaining the
				// process-only copy would mislabel it and keep vault-key operations blocked.
				this.stagedRecovery = undefined;
			}
			return 'durable';
		}
		if (record.attemptId === this.stagedRecovery?.record.attemptId) return 'memory';
		return undefined;
	}

	/** Whether this process or the durable record proves Steam attached it. */
	enrollmentKnownAttached(record: EnrollmentWorkflowRecord): boolean {
		return (
			this.knownAttachedAttempts.has(record.attemptId) ||
			record.state === 'attached' ||
			record.state === 'recoverable' ||
			record.state === 'unreadable'
		);
	}

	/** A failed durable clear still owns this account until that exact clear succeeds. */
	hasEnrollmentCleanupDebt(steamId64?: string): boolean {
		return (
			this.cleanupDebt !== undefined &&
			(steamId64 === undefined || this.cleanupDebt.steamId64 === steamId64)
		);
	}

	/** Whether retained one-time material can produce both codes and confirmations. */
	enrollmentRecoveryUsable(record: EnrollmentWorkflowRecord): boolean {
		let current = record;
		try {
			const published = this.workflowJournal
				.enrollments(record.steamId64)
				.find((entry) => entry.attemptId === record.attemptId);
			if (published?.state === 'recoverable' || published?.state === 'unreadable') {
				current = published;
				if (this.stagedRecovery?.record.attemptId === record.attemptId) {
					this.stagedRecovery = undefined;
				}
			} else if (this.stagedRecovery?.record.attemptId === record.attemptId) {
				return this.stagedRecovery.usable;
			}
		} catch {
			if (this.stagedRecovery?.record.attemptId === record.attemptId) {
				return this.stagedRecovery.usable;
			}
			return false;
		}
		try {
			return authenticatorSecretProblem(this.openRecovery(current).account) === undefined;
		} catch {
			return false;
		}
	}

	/** A new vault key would orphan active or unreadable key-bound material. */
	hasDurableWorkflow(): boolean {
		if (this.cleanupDebt !== undefined) return true;
		try {
			const records = this.workflowJournal.enrollments();
			if (
				this.stagedRecovery !== undefined &&
				records.some(
					(record) =>
						record.attemptId === this.stagedRecovery?.record.attemptId &&
						(record.state === 'recoverable' || record.state === 'unreadable')
				)
			) {
				this.stagedRecovery = undefined;
			}
			return (
				this.stagedRecovery !== undefined ||
				this.persistingRecovery ||
				records.some((record) => record.wrappedKey !== undefined)
			);
		} catch {
			return true;
		}
	}

	/**
	 * Clear only the attempt the user actually inspected on Steam.
	 *
	 * There is no account row to reconcile: if Steam attached an authenticator
	 * and its one response was lost, this app never received the secrets. Both
	 * answers therefore mean the Steam-side situation has been dealt with before
	 * another AddAuthenticator is allowed.
	 */
	resolveEnrollment(
		attemptId: string,
		steamId64: string,
		resolution: 'notAttached' | 'storedHere' | 'resolvedOutsideApp'
	): void {
		if (this.beginning || this.submittingEmailCode || this.persistingRecovery) {
			throw new EnrollmentError(
				'This enrollment request is still in progress. Its safety record cannot be resolved until it settles.',
				false
			);
		}
		const durable = this.workflowJournal
			.enrollments(steamId64)
			.find((entry) => entry.attemptId === attemptId);
		const record =
			durable ??
			(this.cleanupDebt?.steamId64 === steamId64 && this.cleanupDebt.attemptId === attemptId
				? this.cleanupDebt
				: undefined);
		if (record === undefined) {
			throw new EnrollmentError(
				'That enrollment record is no longer present. Re-open this screen before changing anything.'
			);
		}
		const recovery = this.recoveryState(record);
		const stored = this.enrollmentStoredFaithfully(record);
		const usable = recovery === undefined ? false : this.enrollmentRecoveryUsable(record);
		if (resolution === 'storedHere' && !stored) {
			throw new EnrollmentError(
				'This vault does not hold that authenticator. Re-open this screen and choose the answer ' +
					'that matches what you found on Steam.'
			);
		}
		if (
			resolution === 'notAttached' &&
			(this.knownAttachedAttempts.has(record.attemptId) ||
				record.state === 'attached' ||
				record.state === 'recoverable' ||
				record.state === 'unreadable' ||
				recovery !== undefined ||
				stored)
		) {
			throw new EnrollmentError(
				'Steam is known to have attached this authenticator, so this record cannot be cleared as ' +
					'a safe retry. Resolve or remove it on Steam first.'
			);
		}
		if (resolution === 'resolvedOutsideApp' && stored) {
			throw new EnrollmentError(
				'This vault still holds that exact authenticator. Choose “The account is stored — clear the record”; ' +
					'remove the account separately only after Steam no longer uses it.'
			);
		}
		if (resolution === 'resolvedOutsideApp' && recovery !== undefined && usable) {
			throw new EnrollmentError(
				'This record still holds recoverable authenticator secrets. Save them into this vault; ' +
					'they cannot be discarded as an external resolution.'
			);
		}
		this.clearWorkflowRecord(record);
		this.knownAttachedAttempts.delete(record.attemptId);
		if (this.stagedRecovery?.record.attemptId === record.attemptId) {
			this.stagedRecovery = undefined;
		}
	}

	/** True only when this exact issued authenticator, not merely its SteamID, is stored. */
	enrollmentStoredFaithfully(record: EnrollmentWorkflowRecord): boolean {
		try {
			const held = this.openRecovery(record);
			const stored = this.vault
				.read()
				.accounts.find((account) => account.steamId64 === held.account.steamId64);
			return storedFaithfully(stored, held.account);
		} catch {
			return false;
		}
	}

	/**
	 * Save a successful AddAuthenticator reply without contacting Steam again.
	 * The exact attempt id prevents a stale renderer from applying another record.
	 */
	async retryEnrollmentPersist(
		attemptId: string,
		steamId64: string
	): Promise<Extract<BeginOutcome, { state: 'enrolled' }>> {
		if (this.beginning || this.submittingEmailCode) {
			throw new EnrollmentError(
				'This enrollment request is still in progress. Wait for it to settle before saving its reply.',
				false
			);
		}
		if (this.persistingRecovery) {
			throw new EnrollmentError('This authenticator recovery is already being saved.', false);
		}
		this.persistingRecovery = true;
		let releaseVaultKey: (() => void) | undefined;
		try {
			try {
				releaseVaultKey = this.keyCoordinator.beginEnrollmentRecovery(steamId64);
			} catch (err) {
				throw new EnrollmentError(
					err instanceof Error ? err.message : 'The vault is being replaced.',
					false
				);
			}
			let record = this.workflowJournal
				.enrollments(steamId64)
				.find((entry) => entry.attemptId === attemptId);
			if (record === undefined) {
				throw new EnrollmentError(
					'That enrollment record is no longer present. Re-open this screen before changing anything.'
				);
			}

			const staged =
				this.stagedRecovery?.record.attemptId === record.attemptId
					? this.stagedRecovery
					: undefined;
			if (record.state === 'unreadable') {
				throw new EnrollmentError(
					"Steam's retained authenticator has unusable secret material and cannot be saved as a working account. Resolve it through Steam or Steam Support; the encrypted record has been kept."
				);
			}
			if (record.state !== 'recoverable') {
				if (staged === undefined || record.wrappedKey === undefined) {
					throw new EnrollmentError(
						'This safety record does not contain recoverable authenticator secrets. Check Steam Guard ' +
							'on that account before resolving it.'
					);
				}
				if (!staged.usable) {
					try {
						record = this.workflowJournal.updateEnrollment(record, {
							state: 'unreadable',
							wrappedKey: record.wrappedKey,
							recovery: staged.recovery
						});
						this.stagedRecovery = undefined;
					} catch {
						throw new EnrollmentError(
							'The encrypted authenticator reply is still held only by this running app because its ' +
								'safety record could not be updated. Do not quit. Repair the application data folder before continuing.'
						);
					}
					throw new EnrollmentError(
						"Steam's retained authenticator has unusable or incomplete secret material and cannot be saved as a working account. The encrypted record has been kept; resolve it through Steam or Steam Support."
					);
				}
				const held = this.openRecovery(record);
				const invalidSecret = authenticatorSecretProblem(held.account);
				try {
					record = this.workflowJournal.updateEnrollment(record, {
						state: invalidSecret === undefined ? 'recoverable' : 'unreadable',
						wrappedKey: record.wrappedKey,
						recovery: staged.recovery
					});
					this.stagedRecovery = undefined;
				} catch {
					throw new EnrollmentError(
						'The encrypted authenticator reply is still held only by this running app because its ' +
							'safety record could not be updated. Do not quit. Repair the application data folder before continuing.'
					);
				}
				if (invalidSecret !== undefined) {
					throw new EnrollmentError(
						`Steam's retained authenticator cannot be stored as usable because ${describeAuthenticatorSecretProblem(invalidSecret)}. ` +
							'The encrypted record has been kept; resolve it through Steam or Steam Support.'
					);
				}
			}

			const held = this.openRecovery(record);
			return await this.persistEnrollment(record, held);
		} finally {
			releaseVaultKey?.();
			this.persistingRecovery = false;
		}
	}

	/**
	 * Sign in to an account that has no authenticator yet, then enrol it.
	 *
	 * **`proxyUrl` applies from the very first request, not afterwards.** An
	 * earlier version enrolled unrouted and left routing to be configured later,
	 * on the grounds that the account did not exist yet. That is precisely
	 * backwards: Steam would see the account enrolled from the user's real
	 * address and every later request from the proxy, which links the two through
	 * the account permanently. Nothing configured afterwards can undo it.
	 */
	async begin(accountName: string, password: string, proxyUrl?: string): Promise<BeginOutcome> {
		// Before a password, a session, or any network. A malformed/newer record is
		// a fail-closed state, and an unresolved record for account A blocks account
		// B too because the recovery screen intentionally exposes one exact attempt.
		this.ensureNoUnresolvedEnrollment();
		// Set before anything is awaited, which is the whole point — see `beginning`.
		//
		// `submittingEmailCode` counts too. `beginOnce` starts by discarding the
		// pending login, and a begin arriving while a code submission was mid-air
		// cancelled the very session that submission was riding — then went on to
		// open a second one, with both able to reach `enrol`. The mirror of the
		// guard `submitEmailCode` itself carries.
		if (this.beginning || this.submittingEmailCode) {
			throw new EnrollmentError('another sign-in is already in progress.');
		}
		this.beginning = true;
		try {
			return await this.beginOnce(accountName, password, proxyUrl);
		} finally {
			this.beginning = false;
		}
	}

	private ensureNoUnresolvedEnrollment(): void {
		let outstanding: EnrollmentWorkflowRecord | undefined = this.cleanupDebt;
		let transferAccount: string | undefined;
		try {
			outstanding ??= this.workflowJournal.enrollments()[0];
			transferAccount = this.workflowJournal.transfers()[0]?.accountName;
		} catch {
			throw new EnrollmentError(
				'A saved enrollment safety record cannot be read, so no password was sent and no ' +
					'authenticator will be added. Repair the application data folder or update the app first.',
				false
			);
		}
		if (outstanding !== undefined) {
			throw new EnrollmentError(
				`An earlier attempt to add an authenticator to ${outstanding.accountName} is unresolved. ` +
					'Check that exact account and clear its safety record before adding any authenticator.',
				false
			);
		}
		if (transferAccount !== undefined) {
			throw new EnrollmentError(
				`An authenticator transfer for ${transferAccount} is unresolved. Finish or resolve it before adding any authenticator.`,
				false
			);
		}
		this.ensureNoTransferCleanupDebt();
	}

	private ensureNoTransferCleanupDebt(): void {
		let transferCleanupBlocked: boolean;
		try {
			transferCleanupBlocked = this.transferCleanupBlocked();
		} catch {
			throw new EnrollmentError(
				'A transfer cleanup state cannot be checked. This enrollment will not continue and AddAuthenticator was not sent; repair the application data folder or reopen the app first.',
				false
			);
		}
		if (transferCleanupBlocked) {
			throw new EnrollmentError(
				'An authenticator transfer still owes an exact local cleanup. Finish or resolve it before adding any authenticator.',
				false
			);
		}
	}

	private async beginOnce(
		accountName: string,
		password: string,
		proxyUrl?: string
	): Promise<BeginOutcome> {
		this.discardPending();

		// Validated before a password is sent anywhere. A proxy that cannot work
		// must fail while nothing has happened yet — discovering it after Steam has
		// attached an authenticator would mean the enrollment already leaked.
		const route = proxyUrl !== undefined && proxyUrl.trim() !== '' ? proxyUrl.trim() : undefined;
		if (route !== undefined && route.length > MAX_PROXY_URL_LENGTH) {
			throw new EnrollmentError('The proxy address is too long to use safely.', false);
		}
		if (route !== undefined) {
			planProxy(route);
		}

		const session = this.loginSession(route);
		// Registered the moment it exists, so a lock can reach it wherever the flow
		// has got to. `cancel` removes it again.
		this.liveSessions.add(session);
		if (route === undefined) {
			this.unroutedSessions.add(session);
		}

		/**
		 * Stops the sign-in timeout below.
		 *
		 * Hoisted out of the promise so the `needsEmailCode` path can reach it. That
		 * path does not await `authenticated` — it returns and waits for a person —
		 * and the timer fired ninety seconds later and cancelled the very session the
		 * user was about to submit their code to. `PENDING_TTL_MS` says that pause
		 * may last fifteen minutes; in practice it lasted ninety seconds, and the
		 * failure surfaced as the code being rejected.
		 */
		let disarm = (): void => undefined;

		const authenticated = new Promise<void>((resolve, reject) => {
			session.on('authenticated', () => resolve());

			// A timer of our own, not just the library's `timeout` event.
			//
			// `login.ts` already backstops that event for every other sign-in in the
			// application, for the reason its comment gives: if the library never
			// emits it, the promise never settles. Enrollment trusted the event alone,
			// so a sign-in that hung left the screen on "Talking to Steam…" with its
			// Cancel button disabled — no timeout, no error, and nothing to press.
			const timer = setTimeout(() => {
				this.cancel(session);
				reject(new EnrollmentError('Steam did not finish the sign-in in time.', false));
			}, SIGN_IN_TIMEOUT_MS);
			// Never hold the process open on a sign-in nobody is waiting for.
			timer.unref?.();
			const settle = (): void => clearTimeout(timer);
			disarm = settle;
			session.on('authenticated', settle);
			session.on('timeout', settle);
			session.on('error', settle);

			session.on('timeout', () =>
				reject(new EnrollmentError('Steam did not finish the sign-in in time.', false))
			);
			session.on('error', (err) =>
				reject(new EnrollmentError(describeEnrollmentLoginError(err), false))
			);
		});
		// Attached now so a rejection before anything awaits it is not an unhandled
		// rejection that takes the process down.
		authenticated.catch(() => undefined);

		let started;
		try {
			started = await session.startWithCredentials({ accountName, password, persistence: 1 });
		} catch (err) {
			/*
			 * **Ours or Steam's?** A cancellation lands here as a rejection, and
			 * reporting it as "Steam refused the sign-in" blames Steam for
			 * something this application did — after the user pressed a setting, or
			 * after their vault locked. Only a rejection nobody here asked for is
			 * Steam's answer.
			 */
			const stopped = this.stoppedBy.get(session);
			this.cancel(session);
			if (stopped !== undefined) {
				throw new EnrollmentError(stopped, false);
			}
			throw new EnrollmentError(describeEnrollmentLoginError(err), false);
		}

		if (started.actionRequired) {
			const actions = started.validActions ?? [];
			const emailCode = actions.find((action) => action.type === 2);
			if (!emailCode) {
				this.cancel(session);
				/*
				 * The advice this used to give was the expensive one.
				 *
				 * "Remove it in the Steam mobile app first" is remove-then-add, which
				 * costs fifteen days of no trading and leaves a window with no second
				 * factor. It was the only answer available when enrolment was the only
				 * path; it is not any more, and pointing at the transfer costs nothing.
				 */
				throw new EnrollmentError(
					'Steam wants this sign-in approved in a way this app cannot complete, which usually ' +
						'means the account already has an authenticator. Do not remove it — use "Move one ' +
						'from the Steam app" instead, which keeps the shorter restriction.'
				);
			}

			// The sign-in has resolved — into a pause, but resolved. What guards the
			// pause is `PENDING_TTL_MS`, and `submitEmailCode` arms a fresh timeout
			// around the wait that follows the code.
			disarm();

			this.pendingLogin = {
				session,
				accountName,
				proxyUrl: route,
				startedAtElapsedMs: this.monotonicNow(),
				authenticated
			};
			const outcome: BeginOutcome = { state: 'needsEmailCode' };
			if (emailCode.detail !== undefined) outcome.emailDomain = emailCode.detail;
			return outcome;
		}

		try {
			/*
			 * **Inside the try, because it is the step most likely to fail.**
			 *
			 * It sat above it, so a rejected authentication — a wrong password, a
			 * refused Steam Guard code, a proxy that dropped — threw straight past the
			 * `finally` and the live session was never released. It holds an open
			 * connection to Steam and, on a routed account, a proxy socket; leaking
			 * one per failed attempt is the shape a user retrying a mistyped password
			 * produces.
			 */
			await authenticated;
			return await this.enrol(session, accountName, route);
		} finally {
			// The sign-in is over either way; only the vault matters from here.
			this.release(session);
		}
	}

	/** Answer the emailed Steam Guard code, then enrol. */
	async submitEmailCode(code: string): Promise<BeginOutcome> {
		// One submission at a time. Without this, two overlapping calls captured
		// the same pending login, both awaited the same authentication, and both
		// entered `enrol` — whose duplicate check runs before an await, so both
		// passed it and `AddAuthenticator` was sent twice for one account. A
		// double-pressed button is all it takes.
		if (this.submittingEmailCode) {
			throw new EnrollmentError('That code is already being checked. Wait for it.', false);
		}
		this.submittingEmailCode = true;
		try {
			return await this.submitEmailCodeOnce(code);
		} finally {
			this.submittingEmailCode = false;
		}
	}

	private async submitEmailCodeOnce(code: string): Promise<BeginOutcome> {
		const pending = this.pendingLogin;
		if (!pending || this.monotonicNow() - pending.startedAtElapsedMs > PENDING_TTL_MS) {
			this.discardPending();
			throw new EnrollmentError('That sign-in expired. Start again.', false);
		}

		try {
			await pending.session.submitSteamGuardCode(code.trim());
		} catch (err) {
			// Deliberately not discarded: a mistyped code should not cost the user
			// the session and a fresh email. The same one can be tried again.
			throw new EnrollmentError(describeEnrollmentCodeError(err), false);
		}

		// A fresh timeout around this wait, because the one armed in `begin` was
		// disarmed when the flow paused for the code. Without it, disarming there
		// would have swapped one defect for the original: a sign-in that never
		// completes leaving the screen waiting forever.
		await Promise.race([
			pending.authenticated,
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(() => {
					this.cancel(pending.session);
					reject(new EnrollmentError('Steam did not finish the sign-in in time.', false));
				}, SIGN_IN_TIMEOUT_MS);
				timer.unref?.();
				pending.authenticated.finally(() => clearTimeout(timer)).catch(() => undefined);
			})
		]);
		this.pendingLogin = undefined;
		try {
			return await this.enrol(pending.session, pending.accountName, pending.proxyUrl);
		} finally {
			this.release(pending.session);
		}
	}

	/**
	 * Activate the authenticator with the code Steam texted.
	 *
	 * Separate from `begin` because a person has to read a phone in between. The
	 * account is already in the vault by this point; failing here is recoverable
	 * and failing before it would not have been.
	 */
	async activate(steamId64: string, activationCode: string): Promise<'activated' | 'wantMore'> {
		return (await this.activateWithRecoveryStatus(steamId64, activationCode)).state;
	}

	/** The IPC path also needs to report a stale recovery backup without calling activation failed. */
	async activateWithRecoveryStatus(
		steamId64: string,
		activationCode: string
	): Promise<ActivationOutcome> {
		const account = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!account) {
			throw new EnrollmentError('that account is not in this vault');
		}

		// Only an account actually waiting to be activated. Without this, an already
		// active account could be pushed back through `finalizeEnrollment` — a call
		// that changes state on Steam's side — by a stale screen or a double
		// submission, for no possible benefit.
		if (account.status !== 'pendingActivation') {
			throw new EnrollmentError(
				`${account.accountName} is already activated. There is nothing left to finish.`
			);
		}

		// Activation is the point after which this authenticator is live on Steam.
		// If the pre-activation recovery publication failed, sending the request now
		// would recreate the very gap the durable marker records: Steam changed and
		// no independently recoverable copy of the secrets exists. The repair action
		// is local-only and must finish before a transport is even constructed.
		if (recoveryBackupNeedsAttention(account)) {
			throw new EnrollmentError(
				`Finish the encrypted recovery backup for ${account.accountName} before activating it. ` +
					'Use “Finish recovery backup” on the account row; that repair does not contact Steam.'
			);
		}

		// One activation at a time, for the same reason `begin` allows one sign-in:
		// two `finalizeEnrollment` calls racing on one account send Steam two codes
		// for the same window, and the loser's failure is indistinguishable from a
		// wrong code.
		const running = this.inFlight.get(steamId64);
		if (running !== undefined) {
			throw new EnrollmentError(
				running.kind === 'activation'
					? 'that account is already being activated.'
					: 'that account is having its authenticator removed from Steam. Wait for that to ' +
							'finish before activating it.'
			);
		}
		const token = randomUUID();
		this.inFlight.set(steamId64, { kind: 'activation', token });
		try {
			return await this.finishActivation(account, steamId64, activationCode);
		} finally {
			this.releaseInFlight(steamId64, token);
		}
	}

	/** The body of `activate`, split out so the mutex above is impossible to skip. */
	private async finishActivation(
		account: Account,
		steamId64: string,
		activationCode: string
	): Promise<ActivationOutcome> {
		const transport = await this.transports.forAccount({
			steamId64,
			proxyUrl: account.proxyUrl
		});

		/**
		 * Minted from the stored refresh token when the in-memory one has gone.
		 *
		 * The first version relied solely on the token cached during `begin`, which
		 * meant a restart or a vault lock stranded the account: it stayed
		 * `pendingActivation` forever with no way to finish, and the authenticator
		 * was already attached on Steam's side. Recovering from that needed Steam
		 * Support for something the app should simply be able to resume.
		 *
		 * The refresh token was saved during enrollment precisely so this is
		 * possible.
		 */
		const accessToken = await this.accessTokenFor(account, transport);

		const outcome = await this.finalize(transport, {
			steamId64,
			accessToken,
			sharedSecret: account.sharedSecret,
			activationCode: activationCode.trim(),
			unixSeconds: this.unixSeconds(),
			// Unknown after a restart. `false` is the safe default: it omits a claim
			// rather than making a wrong one, and a code that arrived by email is the
			// case that breaks if we assert SMS.
			validateSmsCode: this.textedTheCode.get(steamId64) ?? false
		});

		if (outcome.state === 'wantMore') {
			return { state: 'wantMore' };
		}

		let present = false;
		try {
			await this.vault.mutate((draft) => {
				// **Matched on the secret, not only on the SteamID.** Steam was asked
				// about the shared secret this call snapshotted, and an import-replace
				// or a transfer persist landing during that await can leave a
				// different authenticator under the same identity. Marking *that* row
				// activated attaches one authenticator's outcome to another's secrets.
				const stored = draft.accounts.find(
					(entry) => entry.steamId64 === steamId64 && entry.sharedSecret === account.sharedSecret
				);
				if (stored) {
					present = true;
					const previousRecovery = stored.recoveryBackup;
					// Only now. Until Steam confirms, this account's authenticator is
					// attached but unproven, and `pendingActivation` is what says so.
					stored.status =
						stored.revocationCode === undefined || stored.revocationBackedUpAt
							? 'active'
							: 'pendingRevocationBackup';
					if (previousRecovery !== undefined || this.writeRecovery !== undefined) {
						markRecoveryBackupNeeded(stored, previousRecovery, new Date(this.now()).toISOString());
					}
				}
			});
		} catch {
			// Steam finalized. The vault did not hear about it, so it still reads
			// `pendingActivation` and will offer to finish something already finished
			// — and `finalizeEnrollment` on an activated authenticator fails, which
			// looks like a wrong code. Saying what actually happened is the only way
			// the user can make sense of the next screen.
			throw new EnrollmentError(
				`Steam activated the authenticator on ${account.accountName}, but this could not be ` +
					'saved here. The account works — the codes it generates are valid — and this ' +
					'application will not ask Steam to activate it again, because Steam already has. ' +
					'This entry will keep saying it is waiting to be activated until the vault can be ' +
					'written; that is a record that is behind, not an account that is unprotected.',
				// **Steam did this.** Not a maybe: the call returned success and the
				// local write is what failed. Left as an ordinary error, the screen
				// cleared itself and offered the same irreversible action again.
				true,
				true,
				true
			);
		}

		// **The row can be gone.** `mutate` succeeding proves the write, not the
		// account: a removal that landed while `finalizeEnrollment` was in the air
		// leaves a mutation that found nothing to update — and reporting
		// 'activated' then claims durable local state that does not exist, for an
		// authenticator Steam has just made live.
		if (!present) {
			throw new EnrollmentError(
				`Steam activated the authenticator on ${account.accountName}, but this vault no longer ` +
					'holds the authenticator that was activated — it was removed, or replaced by a ' +
					'different one for the same account, while Steam was answering. The recovery file ' +
					'written at enrollment still holds those secrets: use "Recover from file" to ' +
					'restore them.',
				// **Steam did this.** Not a maybe: the call returned success and the
				// local write is what failed. Left as an ordinary error, the screen
				// cleared itself and offered the same irreversible action again.
				true,
				true,
				true
			);
		}

		// The recovery file still says `pendingActivation`, because that was true
		// when it was written. Correct it now, from the stored account rather than
		// the local one, so what lands on disk is exactly what the vault holds.
		//
		// **The vault read is inside the try**, not beside it. `mutate` above is
		// awaited, so the vault can lock during it — and `read` throws when locked.
		// Left outside, that turned an activation Steam accepted and the vault
		// recorded into a reported failure, which sends the user back to a screen
		// that will then tell them the account is already activated.
		let recoveryWarning: string | undefined;
		if (this.updateRecovery) {
			try {
				const stored = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
				if (stored) {
					const result =
						stored.recoveryBackup !== undefined && stored.recoveryBackup.state !== 'current'
							? await finishRecoveryBackup(this.vault, {
									steamId64,
									expectedId: stored.recoveryBackup.id,
									writeRecovery: this.writeRecovery,
									updateRecovery: this.updateRecovery,
									now: this.now
								})
							: this.updateRecovery(stored);
					if (result !== 'updated' && result !== 'current') {
						recoveryWarning = RECOVERY_BACKUP_WARNING;
					}
				}
			} catch {
				// This is not an activation failure: Steam and the vault already agree.
				// It is still news the completion screen must retain, because silently
				// leaving the separate backup stale makes a future restore misleading.
				recoveryWarning = RECOVERY_BACKUP_WARNING;
			}
		}

		this.tokens.delete(steamId64);
		this.textedTheCode.delete(steamId64);
		return {
			state: 'activated',
			...(recoveryWarning === undefined ? {} : { recoveryWarning })
		};
	}

	/**
	 * Detach the authenticator from Steam, then drop the account (F-09, Q15).
	 *
	 * **The most destructive operation in the application.** It removes Steam
	 * Guard from the account entirely — not from this app, from Steam — leaving it
	 * with no second factor until the owner adds one elsewhere.
	 *
	 * F-09 named the consequence: without gating, an attacker holding an unlocked
	 * vault could strip 2FA from every account in one pass, turning a bounded
	 * compromise into permanent takeover of all of them. So the passphrase is
	 * verified against the file for **each** account, and there is deliberately no
	 * bulk form of this method for a caller to reach for.
	 *
	 * Order matters: Steam first, vault second. Removing the local record first
	 * would leave an account with an authenticator nobody holds if the network
	 * call then failed — the same unrecoverable state enrollment works so hard to
	 * avoid, arrived at from the other direction.
	 */
	/**
	 * Give up this attempt's claim, **and only this attempt's**.
	 *
	 * An unconditional delete removes whatever is there, which after a lock and
	 * an unlock is somebody else's marker — so the operation that finished let a
	 * third start alongside the second. Compare before removing.
	 */
	private releaseInFlight(steamId64: string, token: string): void {
		if (this.inFlight.get(steamId64)?.token === token) {
			this.inFlight.delete(steamId64);
		}
	}

	/**
	 * **Bring the vault into line with an activation the user confirmed on Steam.**
	 *
	 * Lives here rather than in the IPC handler because the rules it has to obey
	 * are this file's rules, and the version that was written in the handler got
	 * two of them wrong: it set `active` outright, skipping the revocation-code
	 * ceremony that `pendingRevocationBackup` exists to force, and it left the
	 * recovery file saying `pendingActivation` for an account that is now live.
	 * Both are the same mistake — restating a rule instead of calling the code
	 * that owns it.
	 */
	async reconcileActivated(
		steamId64: string,
		fingerprint: string,
		guard: OperationResolutionGuard
	): Promise<boolean> {
		return (await this.reconcileActivatedWithRecoveryStatus(steamId64, fingerprint, guard)).applied;
	}

	/** Detailed reconciliation result for the UI; the legacy boolean stays useful to other callers. */
	async reconcileActivatedWithRecoveryStatus(
		steamId64: string,
		fingerprint: string,
		guard: OperationResolutionGuard
	): Promise<ReconcileActivatedOutcome> {
		let applied = false;
		await this.vault.mutate((draft) => {
			/*
			 * **Checked again here, at the moment of the write.**
			 *
			 * The handler checks the fingerprint before calling in, and then there
			 * are awaits — a passphrase derivation, the mutate itself — before
			 * anything is written. A row replaced inside that window is a different
			 * authenticator wearing the same SteamID, and the ordinary removal path
			 * has always matched on identity inside its own mutate for exactly this
			 * reason. This is the same rule.
			 */
			const stored = draft.accounts.find(
				(entry) => entry.steamId64 === steamId64 && authenticatorFingerprint(entry) === fingerprint
			);
			if (stored === undefined) {
				return;
			}
			if (!resolutionMayConsume(steamId64, fingerprint, stored.unresolvedOperation, guard)) {
				return;
			}
			const previousRecovery = stored.recoveryBackup;
			// The same expression the activation path uses, and deliberately not a
			// copy of its conclusion: an account whose revocation code has never been
			// shown is not finished, however Steam feels about it.
			stored.status =
				stored.revocationCode === undefined || stored.revocationBackedUpAt
					? 'active'
					: 'pendingRevocationBackup';
			if (previousRecovery !== undefined || this.writeRecovery !== undefined) {
				markRecoveryBackupNeeded(stored, previousRecovery, new Date(this.now()).toISOString());
			}
			if (
				guard.source === 'vault' ||
				(stored.unresolvedOperation !== undefined &&
					companionMatches(stored.unresolvedOperation, guard.companion))
			) {
				delete stored.unresolvedOperation;
			}
			applied = true;
		});

		/*
		 * **Nothing matched, so nothing is claimed.** The identity re-check above
		 * makes the write conditional, and a method that returns the same way
		 * either side of it tells the caller a reconciliation happened when the row
		 * had moved on — leaving the record in place, the account still blocked,
		 * and the screen closed as though it were sorted.
		 */
		if (!applied) {
			return { applied: false };
		}

		// And the recovery file, which still says `pendingActivation` — written
		// before Steam was asked, and true until this moment.
		let recoveryWarning: string | undefined;
		if (this.updateRecovery) {
			try {
				const stored = this.vault
					.read()
					.accounts.find(
						(entry) =>
							entry.steamId64 === steamId64 && authenticatorFingerprint(entry) === fingerprint
					);
				if (stored) {
					const result =
						stored.recoveryBackup !== undefined && stored.recoveryBackup.state !== 'current'
							? await finishRecoveryBackup(this.vault, {
									steamId64,
									expectedId: stored.recoveryBackup.id,
									writeRecovery: this.writeRecovery,
									updateRecovery: this.updateRecovery,
									now: this.now
								})
							: this.updateRecovery(stored);
					if (result !== 'updated' && result !== 'current') {
						recoveryWarning = RECOVERY_BACKUP_WARNING;
					}
				}
			} catch {
				recoveryWarning = RECOVERY_BACKUP_WARNING;
			}
		}

		// The same teardown the ordinary activation does. An access token and the
		// SMS marker for an account that is finished are credentials and state
		// nothing needs, and leaving them until the next lock is a difference from
		// the path this mirrors with no reason behind it.
		this.tokens.delete(steamId64);
		this.textedTheCode.delete(steamId64);
		return {
			applied: true,
			...(recoveryWarning === undefined ? {} : { recoveryWarning })
		};
	}

	/**
	 * **Forget an account whose authenticator the user confirmed Steam removed.**
	 *
	 * The passphrase is required and verified against the file, exactly as
	 * `deactivate` requires it. This deletes the only copy of a set of secrets,
	 * and the handler that used to do it inline asked for nothing at all — so an
	 * unattended unlocked machine could destroy an account through a screen whose
	 * own removal form refuses to work without the passphrase.
	 */
	async reconcileDetached(
		steamId64: string,
		passphrase: string,
		fingerprint: string,
		guard: OperationResolutionGuard
	): Promise<boolean> {
		await this.vault.verifyPassphrase(passphrase);
		let applied = false;
		await this.vault.mutate((draft) => {
			// Identity at the moment of the delete, not at the moment of the check.
			// `deactivateOnce` matches this way for the same reason: the passphrase
			// derivation above is a long await, and this call destroys secrets.
			const index = draft.accounts.findIndex(
				(entry) =>
					entry.steamId64 === steamId64 &&
					authenticatorFingerprint(entry) === fingerprint &&
					resolutionMayConsume(steamId64, fingerprint, entry.unresolvedOperation, guard)
			);
			if (index >= 0) {
				draft.accounts.splice(index, 1);
				applied = true;
			}
		});
		if (!applied) {
			// The row moved on between the check and the delete. Saying "removed"
			// about an account that is still there is the one answer this must not
			// give — the caller tears down the session on the strength of it.
			return false;
		}
		this.tokens.delete(steamId64);
		return true;
	}

	async deactivate(steamId64: string, passphrase: string): Promise<void> {
		// One at a time per account, exactly as `activate` guards itself: the
		// passphrase check below is deliberately slow, so a double-pressed confirm
		// sent `RemoveAuthenticator` twice — the second answered for an
		// authenticator already gone, and its failure surfaced as an error for an
		// operation that had in fact succeeded.
		const running = this.inFlight.get(steamId64);
		if (running !== undefined) {
			throw new EnrollmentError(
				running.kind === 'removal'
					? 'that account is already being removed.'
					: 'that account is being activated. Wait for that to finish before removing its ' +
							'authenticator from Steam.'
			);
		}
		const token = randomUUID();
		this.inFlight.set(steamId64, { kind: 'removal', token });
		try {
			await this.deactivateOnce(steamId64, passphrase);
		} finally {
			this.releaseInFlight(steamId64, token);
		}
	}

	private async deactivateOnce(steamId64: string, passphrase: string): Promise<void> {
		// Verified against the file, not against "the session happens to be open".
		await this.vault.verifyPassphrase(passphrase);

		const account = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!account) {
			throw new EnrollmentError('that account is not in this vault');
		}
		if (account.revocationCode === undefined) {
			// Checked before anything else so the user is told why rather than
			// watching Steam refuse. An account imported without one — which §12 F2
			// permits, loudly — simply cannot do this.
			throw new EnrollmentError(
				'This account has no revocation code stored, and Steam will not detach an authenticator ' +
					'without one. Remove it from the Steam mobile app instead.'
			);
		}

		const transport = await this.transports.forAccount({
			steamId64,
			proxyUrl: account.proxyUrl
		});

		const accessToken = await this.accessTokenFor(account, transport);

		await this.detach(transport, {
			steamId64,
			accessToken,
			revocationCode: account.revocationCode
		});

		// Only after Steam has confirmed. Everything this account had in memory goes
		// with the record — its cookie jar, cached session and pending list are
		// dropped by the routing hook the caller wires to removal.
		/**
		 * Whether the row this detach was about was still there to remove.
		 *
		 * **A miss is not success.** The guard below can legitimately find
		 * nothing — an import-replace during the detach puts a different
		 * authenticator at this SteamID — and the old code returned `void`
		 * either way, so the screen closed as though the account had been
		 * removed while it was still listed, still showing codes, for an
		 * authenticator Steam had just detached.
		 */
		let removedLocally = false;

		try {
			await this.vault.mutate((draft) => {
				/*
				 * **The row whose authenticator was actually detached**, matched on
				 * the whole secret set rather than on the revocation code.
				 *
				 * Matching the SteamID alone deleted whatever held that identity by
				 * the time Steam answered. Adding the revocation code fixed the
				 * common case and left two:
				 *
				 *  - A replacement that carries no revocation code of its own
				 *    *inherits* the previous one through the import merge. It then
				 *    matched this guard, and its new shared and identity secrets —
				 *    a working authenticator Steam still honours — were deleted for
				 *    a removal that was never about it.
				 *  - A replacement with a different code correctly survived, and the
				 *    caller was told the account had been removed anyway.
				 *
				 * The secrets are what the detach was about, so they are what the
				 * guard compares.
				 */
				const index = draft.accounts.findIndex(
					(entry) =>
						entry.steamId64 === steamId64 &&
						entry.sharedSecret === account.sharedSecret &&
						entry.identitySecret === account.identitySecret &&
						entry.revocationCode === account.revocationCode
				);
				if (index >= 0) {
					draft.accounts.splice(index, 1);
					removedLocally = true;
				}
			});
		} catch {
			// **The worse direction of the two.** Steam Guard is gone from the account
			// and the vault still lists it, so the app goes on showing codes for an
			// authenticator Steam no longer honours — an account the user believes is
			// protected and is not. Silence here would be the app lying by omission
			// about a second factor.
			throw new EnrollmentError(
				`Steam Guard has been removed from ${account.accountName} on Steam, but the account ` +
					'could not be removed from this vault. It is no longer protected — add a new ' +
					'authenticator to it as soon as you can. The codes this app still shows for it are ' +
					'meaningless now, and removing the account here will not change anything on Steam.',
				// **Steam did this.** Not a maybe: the call returned success and the
				// local write is what failed. Left as an ordinary error, the screen
				// cleared itself and offered the same irreversible action again.
				true,
				true,
				true
			);
		}

		this.tokens.delete(steamId64);
		this.textedTheCode.delete(steamId64);

		/*
		 * **Steam said yes and the vault did not change, so this did not fully
		 * happen.**
		 *
		 * Reported rather than swallowed. The guard above deliberately declines to
		 * delete an authenticator this detach was not about — which is right — but
		 * returning quietly then told the screen the account had been removed
		 * while it was still listed, still generating codes, for an authenticator
		 * Steam had just detached. The user closes the dialog believing two things
		 * that are both false.
		 *
		 * Not thrown from the `catch` above: that one is a failed write, and this
		 * is a write that succeeded and found nothing to do. They need different
		 * words because they need different actions.
		 */
		if (!removedLocally) {
			throw new EnrollmentError(
				`Steam Guard has been removed from ${account.accountName} on Steam, but this vault now ` +
					'holds a different authenticator for that account — so nothing was removed here. ' +
					'That entry was not the one detached and is still yours. Check the account before ' +
					'removing anything by hand.',
				// **Steam did this.** The detach succeeded; what failed is local.
				true,
				true,
				true
			);
		}
	}

	/**
	 * Drop a half-finished sign-in that `Require proxies` has just forbidden.
	 *
	 * The IPC guard refuses a new enrolment with no proxy. One already running
	 * was untouched, so a password kept travelling unrouted after the user had
	 * turned the rule on — and enrolling is precisely when an account's address
	 * is first shown to Steam.
	 *
	 * Only the unrouted one. An enrolment started *with* a proxy still satisfies
	 * the rule, and enrolling is an attended act with a code arriving on a
	 * phone: cancelling it because an unrelated switch moved would be a poor
	 * trade for a leak that is not happening.
	 */
	forgetUnrouted(): void {
		for (const session of [...this.unroutedSessions]) {
			this.stoppedBy.set(session, PROXY_POLICY_STOPPED);
			this.cancel(session);
			if (this.pendingLogin?.session === session) {
				this.pendingLogin = undefined;
			}
		}
	}

	/**
	 * Drop what this service holds for one account. Called when its route changes.
	 *
	 * **The shared teardown reached every other cache and not this one.** A proxy
	 * change drops the transports, the confirmation session, the notifier state,
	 * the poller's schedule and the browser window — and left the access token
	 * minted over the *old* route sitting here, so the next enrollment step
	 * reused it rather than minting through the new one. Removing an account left
	 * the same credential, and the SMS marker with it, resident until the vault
	 * locked.
	 *
	 * Narrower than `forget()` on purpose: another account's half-finished
	 * enrolment is nothing to do with this one's routing.
	 */
	forgetAccount(steamId64: string): void {
		this.tokens.delete(steamId64);
		// The "we already texted them a code" marker belongs to the same attempt as
		// the token. Keeping it would make a retry over the new route skip the step
		// that sends one.
		this.textedTheCode.delete(steamId64);
	}

	/** Drop any half-finished sign-in. Called when the vault locks. */
	forget(): void {
		this.discardPending();
		// Every session, not just a pending one. See `liveSessions`.
		for (const session of [...this.liveSessions]) {
			this.stoppedBy.set(session, VAULT_LOCKED_DURING_SIGN_IN);
			this.cancel(session);
		}
		this.tokens.clear();
		this.textedTheCode.clear();
		/*
		 * **The in-flight markers are deliberately NOT cleared here.**
		 *
		 * They were, on the reasoning that a lock means nobody is waiting and a
		 * stale marker would refuse the retry after the next unlock. But a lock
		 * does not stop the request: the promise is still running, Steam is still
		 * going to answer, and clearing the marker let a second irreversible
		 * operation start against the same authenticator while the first was in
		 * the air.
		 *
		 * Each attempt removes its own entry when it settles, and every request
		 * here is bounded by the transport timeout, so nothing is stranded for
		 * longer than that.
		 */
	}

	private openRecovery(record: EnrollmentWorkflowRecord): HeldEnrollment {
		let current = record;
		let staged =
			this.stagedRecovery?.record.attemptId === record.attemptId ? this.stagedRecovery : undefined;
		try {
			const published = this.workflowJournal
				.enrollments(record.steamId64)
				.find((entry) => entry.attemptId === record.attemptId);
			if (published?.state === 'recoverable' || published?.state === 'unreadable') {
				current = published;
				staged = undefined;
				if (this.stagedRecovery?.record.attemptId === record.attemptId) {
					this.stagedRecovery = undefined;
				}
			}
		} catch {
			// The in-memory ciphertext is still the usable copy when the journal cannot
			// be inspected. Opening it does not make a durability claim.
		}
		const sealed = current.state === 'recoverable' ? current.recovery : staged?.recovery;
		if (current.wrappedKey === undefined || sealed === undefined) {
			throw new EnrollmentError('This enrollment record does not contain recoverable secrets.');
		}
		let key: Buffer | undefined;
		try {
			key = this.vault.openScopedEnvelope(current.wrappedKey);
			return openEnrollment(sealed, key, current);
		} catch (err) {
			if (err instanceof EnrollmentError) throw err;
			throw new EnrollmentError(
				'The saved authenticator could not be opened with this vault. Restore the matching vault ' +
					'or contact support; the recovery record has been kept.'
			);
		} finally {
			if (key !== undefined) wipe(key);
		}
	}

	/**
	 * Recover the exact retained update when publication completed before its
	 * durability check reported an error. Reading the journal also gives its
	 * staged-file reconciler a chance to finish the directory flush. The payload
	 * comparison prevents a same-id but different record from being mistaken for
	 * the ciphertext held by this call.
	 */
	private publishedRetainedEnrollment(
		record: EnrollmentWorkflowRecord,
		state: 'recoverable' | 'unreadable',
		recovery: SealedWorkflowPayload
	): EnrollmentWorkflowRecord | undefined {
		try {
			const published = this.workflowJournal
				.enrollments(record.steamId64)
				.find((entry) => entry.attemptId === record.attemptId);
			return published?.state === state &&
				isDeepStrictEqual(published.wrappedKey, record.wrappedKey) &&
				isDeepStrictEqual(published.recovery, recovery)
				? published
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async persistEnrollment(
		record: EnrollmentWorkflowRecord,
		held: HeldEnrollment,
		accessToken?: string
	): Promise<Extract<BeginOutcome, { state: 'enrolled' }>> {
		const invalidSecret = authenticatorSecretProblem(held.account);
		if (invalidSecret !== undefined) {
			throw new EnrollmentError(
				`Steam's retained authenticator cannot be stored as usable because ${describeAuthenticatorSecretProblem(invalidSecret)}. ` +
					'The encrypted recovery record has been kept; resolve the authenticator through Steam or Steam Support.',
				true,
				true,
				true
			);
		}
		const movedOn = (): EnrollmentError =>
			new EnrollmentError(
				`This vault now holds a different authenticator for ${held.account.accountName}. The saved ` +
					'enrollment reply was not written over it, and its recovery record was kept.'
			);
		const notSaved = (): EnrollmentError =>
			new EnrollmentError(
				`Steam attached the authenticator to ${held.account.accountName}, but it could not be saved ` +
					'to the vault. Its encrypted recovery record is intact — unlock this same vault and choose “Save it now”.',
				true,
				true,
				true
			);

		let before: Account | undefined;
		try {
			before = this.vault
				.read()
				.accounts.find((entry) => entry.steamId64 === held.account.steamId64);
		} catch {
			throw notSaved();
		}
		if (before !== undefined && !storedFaithfully(before, held.account)) throw movedOn();
		if (before === undefined) {
			try {
				await this.vault.mutate((draft) => {
					const existing = draft.accounts.findIndex(
						(entry) => entry.steamId64 === held.account.steamId64
					);
					if (existing >= 0) {
						if (!storedFaithfully(draft.accounts[existing], held.account)) throw movedOn();
						return;
					}
					const stored = { ...held.account };
					if (this.writeRecovery !== undefined) {
						markRecoveryBackupNeeded(stored, undefined, new Date(this.now()).toISOString());
					}
					draft.accounts.push(stored);
				});
			} catch (err) {
				if (err instanceof EnrollmentError) throw err;
				throw notSaved();
			}
		} else if (
			this.writeRecovery !== undefined &&
			record.recoveryPublished !== true &&
			before.recoveryBackup === undefined
		) {
			// Upgrade a retained workflow written before recovery ownership lived on
			// the account. Persist the debt before touching the filesystem.
			try {
				await this.vault.mutate((draft) => {
					const current = draft.accounts.find(
						(entry) =>
							entry.steamId64 === held.account.steamId64 && storedFaithfully(entry, held.account)
					);
					if (current === undefined) throw movedOn();
					if (current.recoveryBackup === undefined) {
						markRecoveryBackupNeeded(current, undefined, new Date(this.now()).toISOString());
					}
				});
			} catch (err) {
				if (err instanceof EnrollmentError) throw err;
				throw notSaved();
			}
		}

		// Re-check before the external recovery file. Another account operation may
		// have replaced the row after the mutate settled; never overwrite that newer
		// authenticator's recovery file with this older workflow.
		let stored: Account | undefined;
		try {
			stored = this.vault
				.read()
				.accounts.find((entry) => entry.steamId64 === held.account.steamId64);
		} catch {
			throw notSaved();
		}
		if (stored === undefined || !storedFaithfully(stored, held.account)) throw movedOn();

		let recoveryWarning: string | undefined;
		if (record.recoveryPublished !== true || stored.recoveryBackup?.state !== 'current') {
			try {
				if (stored.recoveryBackup !== undefined && stored.recoveryBackup.state !== 'current') {
					const result = await finishRecoveryBackup(this.vault, {
						steamId64: stored.steamId64,
						expectedId: stored.recoveryBackup.id,
						writeRecovery: this.writeRecovery,
						updateRecovery: this.updateRecovery,
						now: this.now
					});
					if (result !== 'current') throw new Error(`recovery publication is ${result}`);
				}
				record = this.workflowJournal.markEnrollmentRecovery(record, true);
			} catch {
				recoveryWarning = RECOVERY_PUBLICATION_WARNING;
				// Do not write `false` after a failure: the account marker is the
				// authority, and this catch can run after publication succeeded but the
				// journal update failed. A later retry rereads both durable records.
			}
		}

		if (accessToken !== undefined) this.tokens.set(held.account.steamId64, accessToken);
		this.textedTheCode.set(held.account.steamId64, held.phoneNumberHint !== undefined);
		if (recoveryWarning === undefined) {
			try {
				this.clearWorkflowRecord(record);
			} catch {
				throw new EnrollmentCleanupError(
					`The authenticator for ${held.account.accountName} is safely stored in this vault, but its local safety record could not be cleared. ` +
						'Do not add or activate it again. Re-open Add authenticator and choose “The account is stored — clear the record” after repairing the application data folder.',
					true
				);
			}
			this.knownAttachedAttempts.delete(record.attemptId);
			if (this.stagedRecovery?.record.attemptId === record.attemptId) {
				this.stagedRecovery = undefined;
			}
		}

		const outcome: Extract<BeginOutcome, { state: 'enrolled' }> = {
			state: 'enrolled',
			steamId64: held.account.steamId64,
			accountName: held.account.accountName,
			hasRevocationCode: held.account.revocationCode !== undefined,
			...(recoveryWarning === undefined
				? {}
				: {
						recoveryWarning,
						recoveryAttemptId: record.attemptId,
						recoveryAt: record.at
					})
		};
		if (held.phoneNumberHint !== undefined) outcome.phoneNumberHint = held.phoneNumberHint;
		return outcome;
	}

	private async requestEnrollment(
		transport: Awaited<ReturnType<SteamTransportFactory['forAccount']>>,
		steamId64: string,
		accountName: string,
		accessToken: string,
		refreshToken: string | undefined,
		proxyUrl: string | undefined
	): Promise<{ record: EnrollmentWorkflowRecord; held: HeldEnrollment }> {
		let releaseVaultKey: (() => void) | undefined;
		try {
			releaseVaultKey = this.keyCoordinator.beginEnrollmentSubmission(steamId64);
		} catch (err) {
			throw new EnrollmentError(
				err instanceof Error ? err.message : 'Another protected operation is in progress.',
				false
			);
		}

		let contentKey: Buffer | undefined;
		let workflow: EnrollmentWorkflowRecord | undefined;
		try {
			// The first duplicate check ran before `forAccount`, which is awaited. An
			// import can legitimately finish in that interval. The coordinator closes
			// the write race; this read, made while holding it, closes the stale decision
			// that would otherwise send AddAuthenticator for an account now in the vault.
			if (this.vault.read().accounts.some((entry) => entry.steamId64 === steamId64)) {
				throw new EnrollmentError(
					'This account entered the vault while Steam was signing in. Nothing was changed on Steam.'
				);
			}

			contentKey = randomBytes(32);
			try {
				workflow = this.workflowJournal.beginEnrollment({
					steamId64,
					accountName,
					at: new Date(this.now()).toISOString(),
					wrappedKey: this.vault.sealScopedKey(contentKey)
				});
			} catch {
				throw new EnrollmentError(
					'This application could not write and verify the encrypted safety record required before ' +
						'asking Steam to add an authenticator. Nothing was sent. Free some disk space or repair the application data folder, then try again.',
					false
				);
			}

			let started: Awaited<ReturnType<typeof startEnrollment>>;
			let retainedSecretProblem: string | undefined;
			let retainedPartial: EnrollmentPartialSecretsError | undefined;
			try {
				started = await this.start(transport, {
					steamId64,
					accessToken,
					unixSeconds: this.unixSeconds()
				});
			} catch (err) {
				if (err instanceof EnrollmentPartialSecretsError) {
					retainedPartial = err;
					started = undefined as never;
				} else if (err instanceof EnrollmentSecretsError) {
					// Unlike an unreadable/partial reply, this error carries every byte Steam
					// returned. Continue only far enough to seal it under the vault key.
					started = err.started;
					retainedSecretProblem = err.message;
				} else {
					if (err instanceof EnrollmentError && err.committed) {
						if (err.certain) this.knownAttachedAttempts.add(workflow.attemptId);
						try {
							this.workflowJournal.updateEnrollment(
								workflow,
								err.certain ? 'attached' : 'unanswered'
							);
						} catch {
							// The sending record remains a conservative durable refusal.
						}
					} else {
						try {
							this.clearWorkflowRecord(workflow);
						} catch {
							try {
								workflow = this.workflowJournal.updateEnrollment(workflow, 'not-attached');
								if (this.cleanupDebt?.attemptId === workflow.attemptId) {
									this.cleanupDebt = undefined;
								}
							} catch {
								// The verified sending record remains conservative and blocking.
							}
							throw new EnrollmentCleanupError(
								'Steam did not add the authenticator, but this application could not remove its ' +
									'local safety record. Choose “Steam Guard was not added” on this screen to clear ' +
									'the record before trying again.'
							);
						}
					}
					throw err;
				}
			}

			if (retainedPartial !== undefined) {
				const recovery = sealEnrollmentPayload(
					{
						kind: 'unreadable-enrollment-reply',
						accountName,
						retained: retainedPartial.retained,
						reason: retainedPartial.message
					},
					contentKey,
					workflow
				);
				this.stagedRecovery = { record: workflow, recovery, usable: false };
				try {
					workflow = this.workflowJournal.updateEnrollment(workflow, {
						state: 'unreadable',
						wrappedKey: workflow.wrappedKey as NonNullable<typeof workflow.wrappedKey>,
						recovery
					});
					this.stagedRecovery = undefined;
				} catch {
					const published = this.publishedRetainedEnrollment(workflow, 'unreadable', recovery);
					if (published === undefined) {
						throw new EnrollmentError(
							`Steam returned one-time authenticator fields for ${accountName}, but their encrypted reply is ` +
								'held only by this running app because the safety record could not be updated. Do not quit. Repair the application data folder and choose “Save safety record now”.',
							true,
							true,
							retainedPartial.certain
						);
					}
					workflow = published;
					this.stagedRecovery = undefined;
				}
				throw new EnrollmentError(
					`${retainedPartial.message} Its encrypted one-time fields survive a restart.`,
					true,
					true,
					retainedPartial.certain
				);
			}

			const iso = new Date(this.now()).toISOString();
			const account: Account = {
				steamId64,
				accountName: started.accountName ?? accountName,
				sharedSecret: started.sharedSecret,
				identitySecret: started.identitySecret,
				...(started.revocationCode === undefined ? {} : { revocationCode: started.revocationCode }),
				deviceId: started.deviceId,
				...(refreshToken !== undefined && isUsableMobileToken(refreshToken, this.now())
					? { refreshToken }
					: {}),
				...(proxyUrl !== undefined ? { proxyUrl } : {}),
				...(started.serialNumber !== undefined ? { serialNumber: started.serialNumber } : {}),
				...(started.tokenGid !== undefined ? { tokenGid: started.tokenGid } : {}),
				...(started.uri !== undefined ? { uri: started.uri } : {}),
				...(started.secret1 !== undefined ? { secret1: started.secret1 } : {}),
				status: 'pendingActivation',
				autoConfirm: newAutoConfirm(),
				addedAt: iso
			};
			const held: HeldEnrollment =
				started.phoneNumberHint === undefined
					? { account }
					: { account, phoneNumberHint: started.phoneNumberHint };
			const recovery = sealEnrollment(held, contentKey, workflow);
			const invalidSecret = authenticatorSecretProblem(account);
			this.stagedRecovery = {
				record: workflow,
				recovery,
				usable: invalidSecret === undefined
			};
			try {
				workflow = this.workflowJournal.updateEnrollment(workflow, {
					state: invalidSecret === undefined ? 'recoverable' : 'unreadable',
					wrappedKey: workflow.wrappedKey as NonNullable<typeof workflow.wrappedKey>,
					recovery
				});
				this.stagedRecovery = undefined;
			} catch {
				const published = this.publishedRetainedEnrollment(
					workflow,
					invalidSecret === undefined ? 'recoverable' : 'unreadable',
					recovery
				);
				if (published === undefined) {
					throw new EnrollmentError(
						`Steam attached the authenticator to ${account.accountName}, but its encrypted reply is ` +
							'held only by this running app because the safety record could not be updated. Do not quit. Repair the application data folder before continuing.',
						true,
						true,
						true
					);
				}
				workflow = published;
				this.stagedRecovery = undefined;
			}
			if (invalidSecret !== undefined) {
				throw new EnrollmentError(
					`Steam attached an authenticator, but ${describeAuthenticatorSecretProblem(invalidSecret)}. ` +
						`${retainedSecretProblem ?? 'The reply cannot be used safely.'} Its encrypted one-time reply survives a restart; ` +
						'do not add another authenticator. Resolve this one through Steam or Steam Support.',
					true,
					true,
					true
				);
			}
			return { record: workflow, held };
		} finally {
			if (contentKey !== undefined) wipe(contentKey);
			releaseVaultKey();
		}
	}

	/**
	 * The dangerous middle: Steam attaches the authenticator, we store it.
	 *
	 * The vault write is awaited before this returns, so the caller cannot report
	 * success for secrets that are still only in memory — and the recovery file is
	 * written *before* the vault, so the window between Steam accepting and this
	 * machine having a durable copy is as small as it can be made.
	 *
	 * This comment used to claim everything in that window survived a crash. It
	 * did not: nothing was written until after the vault mutate, so a failure there
	 * left Steam holding an authenticator whose secrets existed nowhere.
	 */
	private async enrol(
		session: LoginSessionLike,
		accountName: string,
		proxyUrl: string | undefined
	): Promise<BeginOutcome> {
		const steamId64 = session.steamID?.getSteamID64();
		const accessToken = session.accessToken;

		if (!steamId64) {
			throw new EnrollmentError('Steam signed in without saying which account. Nothing changed.');
		}
		if (!accessToken || !isUsableMobileToken(accessToken, this.now())) {
			throw new EnrollmentError(
				'Steam issued a session that cannot add an authenticator. Nothing changed.'
			);
		}

		if (this.vault.read().accounts.some((entry) => entry.steamId64 === steamId64)) {
			throw new EnrollmentError(
				'This account is already in the vault. Remove it here first if you mean to enrol it again.'
			);
		}

		// Routed from the first request this account ever makes, so `AddAuthenticator`
		// itself leaves through the proxy rather than from the user's own address.
		const transport = await this.transports.forAccount({ steamId64, proxyUrl });

		// **Re-checked after that await, immediately before the irreversible call.**
		//
		// `vault.read()` above already refuses a locked vault, and the transport
		// layer now refuses a grant that predates a lock — but neither is a reason
		// to leave the gap here open. `forAccount` awaits, the idle timer does not
		// pause for it, and the very next statement asks Steam to attach an
		// authenticator that this vault would then be unable to store. A second
		// check costs one line at the one place in the application where being
		// wrong cannot be undone.
		if (!this.vault.isUnlocked()) {
			throw new EnrollmentError(
				'The vault locked before the authenticator could be created, so nothing was changed ' +
					'on Steam. Unlock and start again.',
				false
			);
		}

		let outstanding: EnrollmentWorkflowRecord | undefined;
		let transferAccount: string | undefined;
		try {
			outstanding = this.workflowJournal.enrollments()[0];
			transferAccount = this.workflowJournal.transfers()[0]?.accountName;
		} catch {
			throw new EnrollmentError(
				'A saved Steam workflow record cannot be read, so this application will not send ' +
					'AddAuthenticator. Repair the application data folder or update the app first.',
				false
			);
		}
		if (outstanding !== undefined) {
			throw new EnrollmentError(
				`An earlier attempt to add an authenticator to ${outstanding.accountName} was ` +
					'not resolved. Check Steam Guard on that account before adding any authenticator.',
				true,
				true,
				outstanding.state === 'attached'
			);
		}
		if (transferAccount !== undefined) {
			throw new EnrollmentError(
				`An authenticator transfer for ${transferAccount} became unresolved while this account was signing in. Finish or resolve it before adding an authenticator.`,
				false
			);
		}
		this.ensureNoTransferCleanupDebt();

		const requested = await this.requestEnrollment(
			transport,
			steamId64,
			accountName,
			accessToken,
			session.refreshToken,
			proxyUrl
		);
		return this.persistEnrollment(requested.record, requested.held, accessToken);
	}

	/**
	 * A usable MobileApp access token for this account, minting one if needed.
	 *
	 * Shared by activation and deactivation because both hit the same wall: the
	 * cached token lives only in memory, so a restart or a vault lock leaves an
	 * account that Steam has already changed with no way to finish or undo it.
	 * The refresh token stored at enrollment exists precisely so neither is a
	 * dead end.
	 */
	private async accessTokenFor(
		account: { steamId64: string; refreshToken?: string | undefined },
		transport: Awaited<ReturnType<SteamTransportFactory['forAccount']>>
	): Promise<string> {
		const cached = this.tokens.get(account.steamId64);
		if (cached !== undefined && isUsableMobileToken(cached, this.now())) {
			return cached;
		}

		if (account.refreshToken === undefined) {
			// Sign-in first, revocation code second. A recovered account arrives here
			// by design — the recovery file deliberately carries no refresh token, so
			// it restores an authenticator without also restoring a way in — and the
			// old wording sent those users straight to detaching an account they were
			// trying to keep.
			throw new EnrollmentError(
				'This account has no saved session, so this cannot be done yet. Sign in to it first — ' +
					'the Confirmations screen will ask for the password — and then try again. If you ' +
					'cannot sign in, the revocation code you wrote down removes the authenticator on ' +
					'Steam.'
			);
		}

		const minted = await mintAccessToken(
			transport,
			account.steamId64,
			account.refreshToken,
			this.now()
		);
		this.tokens.set(account.steamId64, minted);
		return minted;
	}

	private unixSeconds(): number {
		return Math.floor(this.now() / 1000) + this.offset();
	}

	private cancel(session: LoginSessionLike): void {
		// Deregistered whether or not the cancel throws: a session we can no longer
		// stop is not one worth holding a reference to.
		this.liveSessions.delete(session);
		this.unroutedSessions.delete(session);
		try {
			session.cancelLoginAttempt();
		} catch {
			// Already finished. Nothing left to stop.
		}
	}

	/** Done with this session, successfully. Stops tracking it without cancelling. */
	private release(session: LoginSessionLike): void {
		this.liveSessions.delete(session);
		this.unroutedSessions.delete(session);
	}

	private discardPending(): void {
		if (this.pendingLogin) {
			this.cancel(this.pendingLogin.session);
			this.pendingLogin = undefined;
		}
	}
}
