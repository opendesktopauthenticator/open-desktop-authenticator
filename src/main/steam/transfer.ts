import { PROXY_POLICY_STOPPED, signIn, type LoginSessionFactory } from './login';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EgressError, redactCredentials } from '../net/egress';
import { mintAccessToken } from './access-token';
import {
	continueTransfer,
	startTransferChallenge,
	TransferApiError,
	type StartChallengeResult
} from './transfer-api';
import { boundedReplacementToken, type ReplacementToken } from './transfer-proto';
import {
	accountFromReplacement,
	offsetFrom,
	storedFaithfully,
	validateReplacement
} from './transfer-store';
import { accountSchema, type Account } from '../../shared/vault-schema';
import type { SteamTransportFactory } from '../net/transport';
import type { VaultService } from '../vault/service';
import { wipe } from '../vault/crypto';
import { VaultKeyOperationCoordinator } from '../vault/key-operation-coordinator';
import { finishRecoveryBackup, markRecoveryBackupNeeded } from '../vault/recovery-state';
import {
	noWorkflowJournal,
	type SealedTransferReplacement,
	type TransferWorkflowRecord,
	type WorkflowJournal
} from './workflow-journal';
import {
	authenticatorSecretProblem,
	authenticatorFingerprint,
	describeAuthenticatorSecretProblem
} from './authenticator-secrets';

/**
 * Moving an existing authenticator off the Steam mobile app and into this one.
 *
 * ## What this is, and what it deliberately is not
 *
 * Steam has a server-side *replacement* flow: it rotates the authenticator and
 * hands back a fresh secret bundle. That is what this implements. It is not an
 * extraction — nothing reads the secret off the phone, and nothing could.
 *
 * It is also not `RemoveAuthenticator` followed by `AddAuthenticator`. That
 * pair reaches the same end state and costs the account a fifteen-day trade and
 * Market restriction, against the shorter one a transfer carries. Anybody
 * editing this file should treat substituting that pair as a bug, not a
 * simplification.
 *
 * ## Why sign-in is its own step
 *
 * `EnrollmentService` refuses accounts that already hold an authenticator, and
 * that refusal is correct: enrolling one on top of another is not a thing Steam
 * does. But its refusal message suggests removing the authenticator first,
 * which for a transfer is precisely the fifteen-day mistake above.
 *
 * So this owns its own authentication. It does not reuse enrolment's session
 * handling — it calls `signIn`, which already carries the timeout, the
 * cancellation and the token-audience check every other sign-in in the app
 * relies on, and which now accepts a Guard code the user reads off the phone
 * rather than deriving one from a secret this app does not have yet.
 *
 * ## Why nothing is written to the vault yet
 *
 * The account model requires `sharedSecret` and `identitySecret`. Until Steam
 * returns the replacement bundle there are none, and inventing placeholders
 * would put a record in the vault that looks like a working authenticator and
 * cannot produce a code. So the authenticated session is held in memory here,
 * exactly as `EnrollmentService` holds its pending login, and the first write
 * happens only once there are real secrets to write.
 */

/**
 * Take the secrets out of a message before anybody can see it.
 *
 * `redactCredentials` handles the proxy credentials embedded in a URL and
 * nothing else — this file originally called it and claimed it removed the
 * password and the Guard code, which it never did. A test asserting the claim
 * is what found that, which is the argument for asserting claims rather than
 * writing them in a comment.
 *
 * Literal replacement rather than a pattern, because the values are known here
 * exactly and a pattern that tries to recognise a password is a pattern that
 * eventually misses one.
 */
function scrub(message: string, secrets: string[]): string {
	let out = redactCredentials(message);
	for (const secret of secrets) {
		// A one- or two-character value would turn the whole message into markers
		// and tell the reader nothing; those cannot be real credentials anyway.
		if (secret.length < 3) {
			continue;
		}
		out = out.split(secret).join('[redacted]');
	}
	return out;
}

/**
 * The saved session, or a refusal that says why it is gone.
 *
 * A transfer that was locked partway through keeps its identity and loses its
 * credentials, so every call that would reach Steam has to stop here rather than
 * discover an `undefined` further down.
 */
function requireSession(refreshToken: string | undefined): string {
	if (refreshToken === undefined) {
		throw new TransferError(
			'The vault locked during this transfer, so its Steam session was dropped. Sign in again ' +
				'to continue.',
			false
		);
	}
	return refreshToken;
}

/**
 * A transfer that ended without a usable authenticator.
 *
 * Three shapes, and the difference is the whole point of recording it:
 *
 *  - `unanswered` — the request went out and nothing came back. Steam may or may
 *    not have acted. The user has to look at their phone to find out.
 *  - `unreadable` — Steam answered, so it rotated, and this build cannot use
 *    what it sent. That is a dead end, and the account needs Steam Support.
 *  - `not-replaced` — Steam provably made no change, but the local safety record
 *    could not be cleared. Retrying is blocked until that cleanup succeeds.
 *
 * Holds a name and an id, never a credential, so it can outlive a lock — losing
 * it would cost the user the only record that either happened.
 */
interface TerminalTransfer {
	steamId64: string;
	accountName: string;
	kind: 'unanswered' | 'unreadable' | 'not-replaced';
}

type HeldReplacement = { account: Account; timeOffsetSeconds: number };
const MAX_PROXY_URL_LENGTH = 8 * 1024;

/**
 * A decoded reply that must be retained but must never enter the normal vault
 * persistence path. `reason` is the validation failure that made it unusable.
 *
 * This is deliberately separate from `unsaved`: `unsaved` means "a usable
 * authenticator whose storage may be retried", while this means "ciphertext
 * safety-record write only". Mixing the two lets a retry turn a missing
 * revocation code, server time, or unsupported scheme into a stored account.
 */
type RetainedUnreadablePayload = {
	replacementToken: ReplacementToken;
	accountName: string;
	proxyUrl?: string;
	receivedAt: string;
	reason: string;
};

type HeldUnreadableReplacement = {
	/** Already encrypted; no Steam secret remains in the held retry object. */
	replacement: SealedTransferReplacement;
	accountName: string;
	reason: string;
};

function transferAad(
	record: Pick<
		TransferWorkflowRecord,
		'version' | 'kind' | 'attemptId' | 'steamId64' | 'accountName' | 'at'
	>
): Buffer {
	return Buffer.from(
		JSON.stringify([
			'oda-transfer',
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

function sealTransferPayload(
	value: unknown,
	key: Buffer,
	record: TransferWorkflowRecord
): SealedTransferReplacement {
	const nonce = randomBytes(12);
	const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
	try {
		const cipher = createCipheriv('aes-256-gcm', key, nonce);
		cipher.setAAD(transferAad(record));
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

function sealReplacement(
	held: HeldReplacement,
	key: Buffer,
	record: TransferWorkflowRecord
): SealedTransferReplacement {
	return sealTransferPayload(held, key, record);
}

function hasRetainableReplacementMaterial(
	token: ReplacementToken | undefined,
	expectedSteamId64: string
): token is ReplacementToken & { steamId64: string } {
	return (
		token?.steamId64 === expectedSteamId64 &&
		[
			token.sharedSecret,
			token.identitySecret,
			token.secret1,
			token.revocationCode,
			token.uri,
			token.tokenGid,
			token.serialNumber
		].some((value) => value !== undefined)
	);
}

function unreadableFromHeld(
	held: HeldReplacement,
	reason: string,
	replacement: SealedTransferReplacement
): HeldUnreadableReplacement {
	const account = held.account;
	return {
		accountName: account.accountName,
		reason,
		replacement
	};
}

function unreadablePayloadFromHeld(
	held: HeldReplacement,
	reason: string
): RetainedUnreadablePayload {
	const account = held.account;
	return {
		replacementToken: {
			steamId64: account.steamId64,
			sharedSecret: account.sharedSecret,
			identitySecret: account.identitySecret,
			revocationCode: account.revocationCode,
			serialNumber: account.serialNumber,
			tokenGid: account.tokenGid,
			uri: account.uri,
			secret1: account.secret1
		},
		accountName: account.accountName,
		...(account.proxyUrl === undefined ? {} : { proxyUrl: account.proxyUrl }),
		receivedAt: account.addedAt,
		reason
	};
}

function openReplacement(
	sealed: SealedTransferReplacement,
	key: Buffer,
	record: TransferWorkflowRecord
): HeldReplacement {
	const nonce = Buffer.from(sealed.nonce, 'base64');
	const tag = Buffer.from(sealed.tag, 'base64');
	if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16) {
		throw new TransferError('The saved transfer recovery material has invalid encryption fields.');
	}
	let plaintext: Buffer | undefined;
	let update: Buffer | undefined;
	let final: Buffer | undefined;
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, nonce);
		decipher.setAAD(transferAad(record));
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
		const value = decoded as { account?: unknown; timeOffsetSeconds?: unknown };
		const account = accountSchema.parse(value.account);
		if (account.steamId64 !== record.steamId64) throw new Error('SteamID mismatch');
		if (!Number.isFinite(value.timeOffsetSeconds)) throw new Error('invalid time offset');
		return { account, timeOffsetSeconds: value.timeOffsetSeconds as number };
	} catch (err) {
		if (err instanceof TransferError) throw err;
		throw new TransferError(
			'The saved replacement could not be decrypted or validated. Do not start another ' +
				'transfer; restore this vault or contact support.'
		);
	} finally {
		if (update !== undefined) wipe(update);
		if (final !== undefined) wipe(final);
		if (plaintext !== undefined) wipe(plaintext);
	}
}

/**
 * What to tell somebody whose reply this build could not use.
 *
 * One sentence, said the same way from both places that reach it — a decoder
 * that threw and a replacement that would not validate are the same situation
 * to the person reading it.
 *
 * It says Steam Support without softening, because there is no other route. An
 * earlier version kept the bytes and offered to try again; the retry ran the
 * same pure decoder over the same bytes, and the copy it saved had nothing able
 * to read it. Offering a recovery that cannot recover is worse than saying
 * plainly that there is none.
 */
function unreadableMessage(accountName: string, reason?: string, retained = false): string {
	return (
		`Steam replaced the authenticator on ${accountName}, and this version could not read what ` +
		`it sent back${reason ? ` (${reason})` : ''}. ` +
		(retained
			? 'Its encrypted reply was retained for diagnosis, but this version cannot turn it into a working authenticator. '
			: 'No usable replacement secrets could be retained. ') +
		'The account still has Steam Guard, so Steam Support is the route back into it.'
	);
}

/** How long an authenticated-but-unfinished transfer stays usable. */
const PENDING_TTL_MS = 15 * 60_000;

export class TransferError extends Error {
	/** True when retrying the same way cannot help. */
	readonly permanent: boolean;

	constructor(message: string, permanent = true) {
		super(message);
		this.name = 'TransferError';
		this.permanent = permanent;
	}
}

/**
 * A transfer that is finished and stored.
 *
 * The revocation code is here because the screen has to show it — it is the one
 * value the user must copy out before doing anything else, and it exists in
 * exactly two places at this moment: the vault and this object.
 */
export type TransferComplete = {
	steamId64: string;
	accountName: string;
	revocationCode: string;
	/** Steam's clock minus this machine's, from the replacement itself. */
	timeOffsetSeconds: number;
	/** Vault success with a retained, locally retryable recovery-publication debt. */
	recoveryWarning?: string;
};

export type AuthenticateOutcome = {
	state: 'authenticated';
	steamId64: string;
	accountName: string;
};

export interface TransferServiceOptions {
	now?: () => number;
	/** Elapsed time for the pre-submit credential lifetime. */
	monotonicNow?: () => number;
	loginSession?: LoginSessionFactory;
	signIn?: typeof signIn;
	startChallenge?: typeof startTransferChallenge;
	continueChallenge?: typeof continueTransfer;
	mintAccessToken?: typeof mintAccessToken;
	/**
	 * Writes the per-account recovery file.
	 *
	 * Optional and best-effort in enrolment; here it is the durable copy of a
	 * secret bundle Steam will never reissue, written *before* the vault so that
	 * a vault failure is survivable.
	 */
	writeRecovery?: (account: Account) => string;
	/** Rewrites the exact recovery file owned by a persisted account marker. */
	updateRecovery?: (account: Account) => unknown;
	/** Required durable state across process exit for the irreversible submission. */
	workflowJournal?: WorkflowJournal;
	/** Shared with vault IPC so a key change cannot race the irreversible request. */
	keyCoordinator?: VaultKeyOperationCoordinator;
	/**
	 * Process-only enrollment cleanup debt is absent from the on-disk journal after
	 * unlink succeeds but its directory flush fails. It still excludes every
	 * transfer until the exact enrollment record is reconciled.
	 */
	enrollmentCleanupBlocked?: () => boolean;
	/**
	 * Tears down every process-local session and cache after recovery commits an
	 * account deletion. It is invoked before journal cleanup so a later cleanup
	 * failure cannot leave a deleted account signed in.
	 */
	onAccountRemoved?: (steamId64: string, removed: true) => void;
	/** Drops sessions tied to a pre-transfer authenticator after it is replaced. */
	onAccountReplaced?: (steamId64: string) => void;
}

/**
 * An authenticated account, held only in memory.
 *
 * The tokens here are credentials as real as a password. They are never handed
 * to the renderer, never logged, and never persisted at this stage — the whole
 * point of holding them here is that the window between signing in and Steam
 * returning a replacement is short and survives no restart.
 */
interface PendingTransfer {
	steamId64: string;
	accountName: string;
	/**
	 * **Dropped when a lock happens mid-submission.**
	 *
	 * `forgetIfIdle` refuses to clear `pending` while a submission is in the air,
	 * because `pending` is the identity a retained reply is validated against —
	 * but it also holds a refresh token, and nothing stripped
	 * those when the request settled. A lock therefore left a live Steam session
	 * behind, usable to start another challenge, for as long as the vault stayed
	 * shut. What recovery needs is the identity; what it does not need is the
	 * credentials.
	 */
	refreshToken: string | undefined;
	/** Carried so every later call in this transfer takes the same route. */
	proxyUrl: string | undefined;
	startedAtElapsedMs: number;
}

export class TransferService {
	private readonly vault: VaultService;
	private readonly transports: SteamTransportFactory;
	private readonly now: () => number;
	private readonly monotonicNow: () => number;
	private readonly offset: () => number;
	private readonly loginSession: LoginSessionFactory | undefined;
	private readonly performSignIn: typeof signIn;
	private readonly performStart: typeof startTransferChallenge;
	private readonly mint: typeof mintAccessToken;
	private readonly performContinue: typeof continueTransfer;
	private readonly writeRecovery: ((account: Account) => string) | undefined;
	private readonly updateRecovery: ((account: Account) => unknown) | undefined;
	private readonly workflowJournal: WorkflowJournal;
	private readonly keyCoordinator: VaultKeyOperationCoordinator;
	private readonly enrollmentCleanupBlocked: () => boolean;
	private readonly onAccountRemoved: (steamId64: string, removed: true) => void;
	private readonly onAccountReplaced: (steamId64: string) => void;
	private workflow: TransferWorkflowRecord | undefined;
	private workflowProblem: string | undefined;
	/**
	 * A workflow whose file was removed but whose directory flush did not finish.
	 *
	 * The record remains usable in this process, while the on-disk journal can no
	 * longer protect it from an older vault restore. Keep that distinction
	 * explicit: an ordinary durable transfer is allowed to restore its matching
	 * backup, but this process-only state is not.
	 */
	private cleanupDebt: TransferWorkflowRecord | undefined;

	/** At most one transfer at a time. A second would race the first over storage. */
	private pending: PendingTransfer | undefined;

	/**
	 * A submission that ended without a usable authenticator.
	 *
	 * Set when the irreversible request failed with no reply at all — a timeout, a
	 * reset, a dead proxy. Steam may well have received it and rotated the
	 * authenticator; absence of an answer is not evidence of absence of an action.
	 *
	 * Held **separately from `pending`** so a lock can drop the tokens and still
	 * leave the warning standing. It carries no credential — a name and an id — so
	 * outliving a lock costs nothing, and losing it would cost the user the only
	 * hint that they need to go and look at their phone.
	 */
	private terminal: TerminalTransfer | undefined;

	/** Guards against a double-clicked button starting two sign-ins. */
	private authenticating = false;

	/**
	 * Bumped whenever a lock disowns this transfer.
	 *
	 * Work already in the air cannot be recalled, only refused on arrival. An
	 * operation captures this before it awaits and checks it after; a changed
	 * value means "a lock happened while I was working", and the only correct
	 * response is to keep nothing.
	 */
	private generation = 0;

	/** The same guard for the challenge, where a double press costs a text message. */
	private challenging = false;

	/** And for the code, where a double press costs an authenticator. */
	private submitting = false;
	private recovering = false;

	/**
	 * A replacement Steam has issued that is not yet safely stored.
	 *
	 * Its presence means the account's authenticator has already rotated. It is
	 * held so that a storage failure can be retried without asking Steam again —
	 * which is impossible, because the code is spent and the secrets are issued
	 * once.
	 */
	private unsaved: HeldReplacement | undefined;

	/**
	 * An unusable replacement waiting only for its encrypted safety-record write.
	 * It is never passed to `persist()` and therefore can never become an account.
	 */
	private unreadableHeld: HeldUnreadableReplacement | undefined;

	constructor(
		vault: VaultService,
		transports: SteamTransportFactory,
		timeOffsetSeconds: () => number,
		options: TransferServiceOptions = {}
	) {
		this.vault = vault;
		this.transports = transports;
		this.offset = timeOffsetSeconds;
		this.now = options.now ?? (() => Date.now());
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.loginSession = options.loginSession;
		this.performSignIn = options.signIn ?? signIn;
		this.performStart = options.startChallenge ?? startTransferChallenge;
		this.mint = options.mintAccessToken ?? mintAccessToken;
		this.performContinue = options.continueChallenge ?? continueTransfer;
		this.writeRecovery = options.writeRecovery;
		this.updateRecovery = options.updateRecovery;
		this.workflowJournal = options.workflowJournal ?? noWorkflowJournal();
		this.keyCoordinator = options.keyCoordinator ?? new VaultKeyOperationCoordinator();
		this.enrollmentCleanupBlocked = options.enrollmentCleanupBlocked ?? (() => false);
		this.onAccountRemoved = options.onAccountRemoved ?? (() => undefined);
		this.onAccountReplaced = options.onAccountReplaced ?? (() => undefined);
		try {
			const records = this.workflowJournal.transfers();
			if (records.length > 1) {
				this.workflowProblem =
					'More than one unfinished transfer is saved. No Steam operation will be started until ' +
					'the application data is repaired.';
			} else if (records[0] !== undefined) {
				this.workflow = records[0];
				if (records[0].state !== 'replacement') {
					this.terminal = {
						steamId64: records[0].steamId64,
						accountName: records[0].accountName,
						kind:
							records[0].state === 'unreadable'
								? 'unreadable'
								: records[0].state === 'not-replaced'
									? 'not-replaced'
									: 'unanswered'
					};
				}
			}
		} catch {
			this.workflowProblem =
				'A saved transfer safety record cannot be read. No new transfer will be started until ' +
				'the application data is repaired or this app is updated.';
		}
	}

	private ensureNoEnrollmentWorkflow(): void {
		let cleanupBlocked: boolean;
		try {
			cleanupBlocked = this.enrollmentCleanupBlocked();
		} catch {
			throw new TransferError(
				'An enrollment cleanup state could not be checked. This transfer will not continue and no authenticator change was requested; repair the application data folder or reopen the app first.',
				false
			);
		}
		if (cleanupBlocked) {
			throw new TransferError(
				'An authenticator enrollment still owes an exact local cleanup. Finish or resolve it before starting or continuing a transfer.',
				false
			);
		}
		let enrollmentAccount: string | undefined;
		try {
			enrollmentAccount = this.workflowJournal.enrollments()[0]?.accountName;
		} catch {
			throw new TransferError(
				'A saved enrollment workflow cannot be read. This transfer will not continue and no authenticator change was requested; repair the application data folder or update the app first.',
				false
			);
		}
		if (enrollmentAccount !== undefined) {
			throw new TransferError(
				`An authenticator enrollment for ${enrollmentAccount} is unresolved. Finish or resolve it before starting a transfer.`,
				false
			);
		}
	}

	/**
	 * Sign in to the account whose authenticator is being moved.
	 *
	 * The Guard code is typed by the user from the phone that still holds the
	 * authenticator. Supplying it up front is what lets Steam complete the
	 * sign-in outright: left to challenge us, it asks for a device confirmation
	 * this app cannot drive, which is the error the enrolment path returns.
	 *
	 * Nothing about the Steam account changes here. This call is safe to repeat
	 * and safe to abandon.
	 */
	/**
	 * The sign-in this transfer is running, while it is running.
	 *
	 * `routed` is the route it actually took, not what the account has stored —
	 * there is no stored account yet, so the form's proxy field is the only
	 * answer there is.
	 */
	private authenticatingAttempt: { cancel: (reason?: string) => void; routed: boolean } | undefined;

	/**
	 * Abandon an authentication `Require proxies` has just forbidden.
	 *
	 * Narrow on purpose: see the note where the callback is registered. Only the
	 * stage that has changed nothing is stopped.
	 */
	cancelUnroutedAuthentication(): void {
		const attempt = this.authenticatingAttempt;
		if (attempt === undefined || attempt.routed) {
			return;
		}
		this.authenticatingAttempt = undefined;
		try {
			attempt.cancel(PROXY_POLICY_STOPPED);
		} catch {
			// Already finished. Nothing left to stop.
		}
	}

	async authenticate(
		accountName: string,
		password: string,
		steamGuardCode: string,
		proxyUrl?: string
	): Promise<AuthenticateOutcome> {
		if (proxyUrl !== undefined && proxyUrl.length > MAX_PROXY_URL_LENGTH) {
			throw new TransferError('The proxy address is too long to use safely.', false);
		}
		this.ensureNoEnrollmentWorkflow();
		if (this.authenticating) {
			throw new TransferError('A sign-in for this transfer is already in progress.', false);
		}
		if (this.workflowProblem !== undefined) {
			throw new TransferError(this.workflowProblem, false);
		}
		// **Refused while a replacement is still held.**
		//
		// An unstored replacement is only meaningful next to the `pending` it belongs
		// to: that is the account name and routing it is stored under, and the
		// SteamID it was validated against. Signing in as somebody else overwrote all
		// of it while the replacement stayed the same, so what was held for account A
		// was suddenly labelled account B — recovery
		// then either refused on a SteamID mismatch or ran with the wrong context.
		//
		// There is no safe merge here. The only correct answer is to finish the
		// transfer that is already outstanding.
		// **`submitting` and `challenging` count too.** Guarding only on state that
		// is already *held* let a new sign-in start beside an older submission still
		// in the air. The old one then finished — producing terminal or unsaved state
		// for account A — while this one installed account B as `pending`. `current()`
		// prefers `pending` and `awaiting()` reads the other, so one status response
		// claimed B owned A's outcome; retrying A's storage cleared B's session.
		if (this.submitting || this.challenging) {
			throw new TransferError(
				'This transfer is in the middle of a request to Steam. Wait for it to finish before ' +
					'signing in to another account.',
				false
			);
		}
		if (
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined ||
			this.terminal !== undefined ||
			this.workflow !== undefined
		) {
			throw new TransferError(
				'Another transfer has an unresolved safety record. Finish or resolve that transfer ' +
					'before signing in again.',
				false
			);
		}
		// Captured before anything is awaited. Read after the sign-in instead and it
		// would be the value the lock already changed, so the guard would agree with
		// itself and catch nothing.
		const generation = this.generation;
		const code = steamGuardCode.trim().toUpperCase();
		if (!code) {
			throw new TransferError('Enter the Steam Guard code shown in the Steam mobile app.', false);
		}

		this.authenticating = true;
		try {
			const result = await this.performSignIn(
				{
					accountName,
					password,
					steamGuardCode: code,
					unixSeconds: this.unixSeconds()
				},
				proxyUrl,
				this.loginSession,
				this.now,
				/*
				 * **Only this stage registers a cancellation, and deliberately.**
				 *
				 * `authenticate` changes nothing on Steam — the docblock above says
				 * so — which makes it the one transfer stage safe to abandon. It
				 * sends a password *and* a Steam Guard code, so a policy change that
				 * cannot reach it leaves both travelling unrouted for as long as the
				 * sign-in timeout allows.
				 *
				 * The later stages are the opposite: by then Steam may have rotated
				 * the authenticator and `pending` holds the only route back to
				 * secrets Steam will not reissue. `cancel()` refuses during those for
				 * that reason, and nothing here overrides it.
				 */
				(cancel) => {
					this.authenticatingAttempt = {
						cancel,
						routed: proxyUrl !== undefined && proxyUrl !== ''
					};
				}
			).catch((err: unknown) => {
				throw new TransferError(
					scrub(err instanceof Error ? err.message : String(err), [password, code]),
					false
				);
			});

			const steamId64 = result.steamId64;
			if (!steamId64) {
				throw new TransferError(
					'Steam completed the sign-in without saying which account it was for.'
				);
			}
			// Enrollment cleanup can become outstanding while Steam is answering the
			// sign-in. Refuse the result before retaining its session; no account-side
			// change has happened at this stage, so abandoning it is exact.
			this.ensureNoEnrollmentWorkflow();

			/*
			 * The duplicate check belongs here, before anything irreversible.
			 *
			 * Steam rotates the authenticator the moment the SMS code is accepted. If
			 * this app then found it already had a record for that account and
			 * refused to store the replacement, the user would be left holding
			 * secrets nothing had saved — the one outcome this whole feature has to
			 * avoid. Finding out now costs a sign-in; finding out later costs an
			 * account.
			 */
			this.refuseIfAlreadyHeld(steamId64);

			/*
			 * **Disowned by a lock that happened while this was in the air.**
			 *
			 * `result` holds a MobileApp refresh token and an access token —
			 * credentials as real as the password that produced them. Installing them
			 * now would undo the lock that has just dropped everything else, and they
			 * would sit there for as long as the vault stayed shut. Nothing is kept:
			 * the user signs in again, which costs them one form.
			 */
			if (this.generation !== generation) {
				throw new TransferError(
					'The vault locked while signing in, so nothing was kept. Unlock and start again.',
					false
				);
			}

			// Re-checked with the answer in hand. The guards above ran before this
			// awaited Steam, and another transfer can reach a terminal state or leave
			// a replacement unstored in that window — installing over it would attach
			// one account's outcome to another account's session.
			if (
				this.unsaved !== undefined ||
				this.unreadableHeld !== undefined ||
				this.terminal !== undefined ||
				this.submitting
			) {
				throw new TransferError(
					'Another transfer finished while this sign-in was in progress, and it has not been ' +
						'dealt with yet. Nothing was kept here; finish that one first.',
					false
				);
			}

			this.pending = {
				steamId64,
				accountName,
				refreshToken: result.refreshToken,
				proxyUrl,
				startedAtElapsedMs: this.monotonicNow()
			};

			return { state: 'authenticated', steamId64, accountName };
		} finally {
			this.authenticating = false;
			// Whatever happened, nothing is in the air for this stage any more.
			this.authenticatingAttempt = undefined;
		}
	}

	/**
	 * Ask Steam to text a code to the phone on the account.
	 *
	 * Still nothing irreversible: no authenticator changes, and a user who never
	 * uses the code has lost nothing but a text message. What it does spend is
	 * the account's tolerance — Steam rate-limits this, and somebody's phone is
	 * on the other end — so it is offered once and repeated only on request.
	 */
	async startChallenge(): Promise<StartChallengeResult> {
		const pending = this.live();
		if (!pending) {
			throw new TransferError(
				'That transfer has expired. Sign in again to start a new one.',
				false
			);
		}
		// The account may have entered enrollment cleanup after transfer sign-in.
		// Re-check before spending a text message or minting another Steam token.
		this.ensureNoEnrollmentWorkflow();
		if (
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined ||
			this.terminal !== undefined
		) {
			throw new TransferError(
				'This transfer has not finished. Asking Steam to text another code cannot help, and ' +
					'spends a message and a rate limit that the unfinished one may still need.',
				false
			);
		}
		if (this.challenging) {
			throw new TransferError('Steam has already been asked for a code.', false);
		}
		// Nor while a code is being submitted. Asking Steam for another text while
		// the irreversible submission is in flight spends a message — and possibly
		// the rate limit — against an authenticator that is being rotated away.
		if (this.submitting) {
			throw new TransferError(
				'The code is already being submitted. Wait for that to finish.',
				false
			);
		}
		// **And not while a sign-in is still in the air.** `authenticate` refuses to
		// start beside a challenge; without the mirror of that here, a challenge for
		// account A could start during a sign-in for B, and B was installed as
		// `pending` the moment the sign-in landed. A's text message had already gone
		// out, the screen showed A's challenge, and the code typed from A's phone was
		// then submitted against B's session.
		if (this.authenticating) {
			throw new TransferError(
				'A sign-in for this transfer is still in progress. Wait for it to finish.',
				false
			);
		}

		this.challenging = true;
		try {
			const transport = await this.transports.forAccount({
				steamId64: pending.steamId64,
				proxyUrl: pending.proxyUrl
			});
			/*
			 * A fresh access token rather than the one the sign-in returned.
			 *
			 * The short-lived token is minutes old by the time somebody has read the
			 * warnings on this screen, and an expired token here fails a call that
			 * has already texted a phone on some other attempt. Minting is cheap.
			 */
			const accessToken = await this.mint(
				transport,
				pending.steamId64,
				// Absent when a lock dropped the session mid-transfer. Nothing may talk
				// to Steam again on this transfer without a fresh sign-in.
				requireSession(pending.refreshToken),
				this.now()
			);
			return await this.performStart(transport, accessToken);
		} finally {
			this.challenging = false;
		}
	}

	/**
	 * Submit the texted code. **This rotates the authenticator.**
	 *
	 * The ordering below is the whole point of the method, and it is ordered by
	 * what is irreversible rather than by what is convenient:
	 *
	 * 1. Everything that can refuse, refuses first — while refusing is free.
	 * 2. Steam is asked, once, and never asked again automatically.
	 * 3. Steam's replacement is encrypted into the durable workflow before the
	 *    vault can contain it, so a failed vault write remains locally recoverable.
	 * 4. The vault is written with recovery-publication debt, then read back. The
	 *    separate recovery file is published locally and only its exact generation
	 *    may clear that debt.
	 *
	 * If any step after Steam answers fails, the bundle stays in memory and the
	 * transfer enters a state `retryPersist` can finish. Nothing is discarded and
	 * nothing claims to have worked.
	 */
	async completeTransfer(smsCode: string): Promise<TransferComplete> {
		this.ensureNoEnrollmentWorkflow();
		// **Before `live()`.** A lock clears `pending` while keeping `uncertain`, so
		// placed after the expiry check this said "that transfer has expired" for a
		// submission whose outcome is unknown — technically true and exactly the
		// wrong thing to tell somebody who needs to go and look at their phone.
		if (this.terminal !== undefined) {
			// Two different dead ends, and one message for both would be wrong for
			// whichever it was not: `unanswered` means go and look at the phone,
			// `unreadable` means the account needs Steam Support.
			throw new TransferError(
				this.terminal.kind === 'unanswered'
					? 'The last submission was never answered, so this application cannot tell whether ' +
							'the authenticator was replaced. Check the Steam mobile app before trying ' +
							'anything else.'
					: this.terminal.kind === 'not-replaced'
						? 'Steam did not replace the authenticator, but its local safety record still needs ' +
							'to be cleared before trying again.'
						: unreadableMessage(
								this.terminal.accountName,
								undefined,
								this.workflow?.state === 'unreadable' && this.workflow.replacement !== undefined
							),
				false
			);
		}
		const pending = this.live();
		if (!pending) {
			throw new TransferError(
				'That transfer has expired before the code was submitted. Nothing has changed; sign ' +
					'in again to start over.',
				false
			);
		}
		if (this.submitting) {
			throw new TransferError('That code is already being submitted.', false);
		}
		// The mirror of the guard `startChallenge` carries: a submission during a
		// challenge still in the air raced the request that asks Steam to text a
		// code against the one that spends it.
		if (this.challenging) {
			throw new TransferError(
				'Steam is still being asked to send the code. Wait for that to finish.',
				false
			);
		}
		/*
		 * **Refused once anything is outstanding.**
		 *
		 * A second submission cannot help and can mislead. Steam answers a spent
		 * code with `success: false`, which this reads — correctly, for a *first*
		 * attempt — as "nothing rotated". Reached after a transfer that already
		 * ended, it would report an account whose authenticator has been rotated
		 * away as though the transfer had simply been refused.
		 *
		 * The screen no longer offers the button; this is the channel behind it.
		 */
		if (
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined ||
			this.terminal !== undefined ||
			this.workflow !== undefined
		) {
			throw new TransferError(
				'This transfer already has an unresolved outcome or an unsaved replacement. Sending ' +
					'the code again is unsafe; finish or resolve the saved recovery record instead.',
				false
			);
		}
		const code = smsCode.trim();
		if (!code) {
			throw new TransferError('Enter the code Steam sent to your phone.', false);
		}

		// Re-checked here rather than trusted from the sign-in: minutes of reading
		// warnings may have passed, and this is the last moment refusing is free.
		this.refuseIfAlreadyHeld(pending.steamId64);

		let releaseVaultKey: (() => void) | undefined;
		try {
			releaseVaultKey = this.keyCoordinator.beginTransferSubmission(pending.steamId64);
		} catch (err) {
			throw new TransferError(
				err instanceof Error ? err.message : 'The vault is being changed.',
				false
			);
		}
		this.submitting = true;
		let contentKey: Buffer | undefined;
		try {
			const transport = await this.transports.forAccount({
				steamId64: pending.steamId64,
				proxyUrl: pending.proxyUrl
			});
			const accessToken = await this.mint(
				transport,
				pending.steamId64,
				// Absent when a lock dropped the session mid-transfer. Nothing may talk
				// to Steam again on this transfer without a fresh sign-in.
				requireSession(pending.refreshToken),
				this.now()
			);

			/*
			 * Durable intent before the irreversible request, with a fresh content
			 * key wrapped by the vault. The raw key stays only in this stack frame so
			 * a reply can still be encrypted if the idle lock lands while Steam is
			 * answering; it is wiped at settlement on every path.
			 */
			contentKey = randomBytes(32);
			let workflow: TransferWorkflowRecord;
			try {
				const wrappedKey = this.vault.sealScopedKey(contentKey);
				const priorAuthenticatorFingerprint = this.vault.backupAuthenticatorFingerprint?.(
					pending.steamId64
				);
				workflow = this.workflowJournal.beginTransfer({
					steamId64: pending.steamId64,
					accountName: pending.accountName,
					at: new Date(this.now()).toISOString(),
					wrappedKey,
					...(priorAuthenticatorFingerprint === undefined ? {} : { priorAuthenticatorFingerprint })
				});
				this.workflow = workflow;
			} catch {
				throw new TransferError(
					'This application could not write and verify the safety record required before ' +
						'asking Steam to replace the authenticator. Nothing was sent. Free some disk ' +
						'space or repair the application data folder, then try again.',
					false
				);
			}

			/*
			 * From here until the vault is written, a failure is expensive.
			 *
			 * `continueTransfer` throws rather than returning failure when it cannot
			 * read the reply, because Steam may have rotated the authenticator
			 * anyway. That is surfaced as an uncertain outcome, not a failed one.
			 */
			/*
			 * Whether a body arrived, not the body itself.
			 *
			 * The bytes used to be retained so a "read it again" retry could be
			 * offered. That retry could never work: `decodeContinueResponse` is pure,
			 * so a reply that failed once fails identically every time, and there was
			 * never anything able to read the copy it was saved to. What is actually
			 * needed here is the *distinction* — a reply that arrived and could not be
			 * understood is a different statement from no reply at all — and a boolean
			 * carries that without keeping secret material nothing can use.
			 */
			let bodyArrived = false;

			const rawResult = await this.performContinue(transport, accessToken, code, () => {
				bodyArrived = true;
			}).catch((err: unknown) => {
				/*
				 * Two very different failures arrive here, and telling them apart is
				 * the difference between a shrug and an emergency.
				 *
				 * An HTTP status is not itself proof that the irreversible request was
				 * rolled back: a gateway can answer after Steam acted. Only an
				 * application-level negative result carried by `TransferApiError` is a
				 * known no-change outcome. Everything else remains restart-safe.
				 */
				if (err instanceof TransferApiError) {
					if (err.provesNoChange) {
						this.clearKnownNoChange(workflow);
						throw new TransferError(err.message, false);
					}
					this.finish(pending, 'unanswered');
					throw new TransferError(
						'Steam did not provide a conclusive transfer result, so this application cannot ' +
							'tell whether the authenticator was replaced. Do not retry until you have checked ' +
							'the Steam mobile app or resolved the saved recovery record.',
						false
					);
				}

				/* A transport refusal that explicitly says zero bytes crossed the send
				 * boundary is the one network failure safe to retry. This is intentionally
				 * an exact `=== false`; unknown errors remain conservative. */
				if (err instanceof EgressError && err.sent === false) {
					this.clearKnownNoChange(workflow);
					throw new TransferError(
						`${err.message}. The replacement request did not leave this machine, so it is safe to retry.`,
						false
					);
				}

				/*
				 * **No body ever arrived.** A timeout, a reset or a dead proxy rejects
				 * before `onRaw` is called — but the request may well have reached
				 * Steam and been acted on. Absence of a reply is not evidence of
				 * absence of a rotation.
				 *
				 * Recorded rather than merely described: `awaiting()` answering
				 * "nothing outstanding" is what let the screen conclude the submission
				 * had not happened and re-offer both Cancel and a second irreversible
				 * submit.
				 */
				if (!bodyArrived) {
					this.finish(pending, 'unanswered');
					throw new TransferError(
						'The connection failed before Steam answered, so this application cannot tell ' +
							'whether the authenticator was replaced. Do not assume it was not. Check the ' +
							'Steam mobile app: if it no longer shows a code for this account, the ' +
							'transfer went through and you will need Steam Support to recover it.',
						false
					);
				}

				/*
				 * A reply arrived and could not be understood. Steam was not refusing,
				 * so the authenticator has rotated and this build cannot use what
				 * replaced it. That is a dead end, and saying so is the only honest
				 * thing left — see `finish`.
				 */
				this.finish(pending, 'unreadable');
				throw new TransferError(unreadableMessage(pending.accountName), false);
			});
			const result =
				rawResult.replacementToken === undefined
					? rawResult
					: {
							...rawResult,
							replacementToken: boundedReplacementToken(rawResult.replacementToken)
						};
			if (result.success === false && result.replacementToken === undefined) {
				// The field was present on the wire and explicitly false.
				this.clearKnownNoChange(workflow);
				throw new TransferError(
					'Steam did not accept that code. Nothing has changed — check the code and try again.',
					false
				);
			}
			if (result.success !== true && result.replacementToken === undefined) {
				this.finish(pending, 'unanswered');
				throw new TransferError(
					'Steam answered without saying whether the authenticator was replaced. Do not retry ' +
						'until you have checked the Steam mobile app or resolved the saved recovery record.',
					false
				);
			}

			/*
			 * **Decoded is not the same as usable, and both are irreplaceable.**
			 *
			 * A reply can parse perfectly and still fail here — a SteamID that does
			 * not match, or a replacement built on a Guard scheme this build does not
			 * know. Steam has rotated the authenticator either way, and these bytes
			 * are still the only copy of what replaced it. Saving only on a decoder
			 * exception left exactly this case in memory, to be lost on quit.
			 */
			// Steam has answered with whatever replacement it will issue. Validation and
			// storage are local from here, so its session credentials have no reason to
			// survive either the usable or the retained-unreadable branch.
			this.dropCredentials();
			let account: Account;
			try {
				validateReplacement(result.replacementToken, pending.steamId64);
				account = accountFromReplacement(
					result.replacementToken,
					pending.accountName,
					pending.proxyUrl,
					new Date(this.now()).toISOString()
				);
			} catch (err) {
				// Decoded and still unusable — a SteamID that does not match, invalid
				// key material, or a Guard scheme this build does not know. Steam
				// rotated the authenticator either way. When the reply still contains a
				// complete account for the expected SteamID, retain those exact bytes
				// encrypted: unusable is not the same thing as disposable.
				//
				// The reason is carried through: "a replacement issued for a different
				// account" and "no login secret" say different things about what went
				// wrong, and a support conversation starts from whichever it was.
				const reason = err instanceof Error ? err.message : 'the replacement was invalid';
				const token = result.replacementToken;
				if (hasRetainableReplacementMaterial(token, pending.steamId64)) {
					const payload: RetainedUnreadablePayload = {
						replacementToken: { ...token },
						accountName: pending.accountName,
						...(pending.proxyUrl === undefined ? {} : { proxyUrl: pending.proxyUrl }),
						receivedAt: new Date(this.now()).toISOString(),
						reason
					};
					const held: HeldUnreadableReplacement = {
						accountName: pending.accountName,
						reason,
						replacement: sealTransferPayload(payload, contentKey, workflow)
					};
					this.unreadableHeld = held;
					try {
						this.retainUnreadableReplacement(workflow, held);
					} catch {
						this.terminal = {
							steamId64: pending.steamId64,
							accountName: pending.accountName,
							kind: 'unreadable'
						};
						this.pending = undefined;
						throw new TransferError(
							`Steam replaced the authenticator on ${pending.accountName} with a reply this ` +
								`version cannot use (${held.reason}). Its encrypted reply is held only by this running app because ` +
								'the safety record could not be saved. Do not quit; repair the application data ' +
								'folder and choose “Save it now” to retry the safety-record write.',
							false
						);
					}
					this.unreadableHeld = undefined;
					this.terminal = {
						steamId64: pending.steamId64,
						accountName: pending.accountName,
						kind: 'unreadable'
					};
					this.pending = undefined;
				} else if (result.success !== true) {
					// A contradictory/missing success bit is not allowed to discard a
					// concrete exact-account replacement above. With no retainable token,
					// however, Steam's action genuinely remains unknown.
					this.finish(pending, 'unanswered');
					throw new TransferError(
						'Steam returned an incomplete replacement without confirming that it changed the ' +
							'authenticator. Do not retry until you have checked the Steam mobile app or resolved ' +
							'the saved recovery record.',
						false
					);
				} else {
					this.finish(pending, 'unreadable');
				}
				throw new TransferError(
					unreadableMessage(
						pending.accountName,
						reason,
						this.workflow?.state === 'unreadable' && this.workflow.replacement !== undefined
					),
					false
				);
			}
			const held: HeldReplacement = {
				account,
				timeOffsetSeconds: offsetFrom(result.replacementToken, this.now())
			};
			this.unsaved = held;
			try {
				workflow = this.workflowJournal.updateTransfer(workflow, {
					state: 'replacement',
					wrappedKey: workflow.wrappedKey as NonNullable<typeof workflow.wrappedKey>,
					replacement: sealReplacement(held, contentKey, workflow)
				});
				this.workflow = workflow;
			} catch {
				throw new TransferError(
					`Steam replaced the authenticator on ${pending.accountName}, but its encrypted ` +
						'recovery record could not be saved. Do not close this app. Use “Finish recovery” ' +
						'to store the replacement in the vault.'
				);
			}

			// The ciphertext is now the durable source. Do not retain a second plaintext
			// copy across a vault lock or a failed disk write; retryPersist decrypts it
			// only for the duration of the next save attempt.
			this.unsaved = undefined;
			return await this.retryPersistUnderReservation();
		} finally {
			if (contentKey !== undefined) wipe(contentKey);
			this.submitting = false;
			releaseVaultKey?.();
			// The lock could not clear `pending` while this was running, so it does it
			// here instead — keeping the identity a retained reply needs and dropping
			// the session that has no business outliving the lock.
		}
	}

	/**
	 * Which retry, if any, this transfer is waiting on.
	 *
	 * Exists so the *renderer* can find out. Every lock reloads the window, which
	 * destroys the React state that was the only record that a retry was owed —
	 * and the status channel could not express it, so a reload after a failed
	 * persist left one-time secrets held here with nothing able to ask for them
	 * again. They then died with the process, on an account whose authenticator
	 * Steam had already rotated.
	 */
	/**
	 * Forget the Steam session while keeping who the transfer is for.
	 *
	 * Called when a lock lands during the one request that cannot be interrupted.
	 * Afterwards `retryPersist` still works — it needs a name, a SteamID and a
	 * route — while nothing can talk to Steam again without a fresh sign-in.
	 */
	private finish(pending: PendingTransfer, kind: 'unanswered' | 'unreadable'): void {
		// The session goes with `pending`: there is nothing left to ask Steam, and a
		// refresh token sitting in memory after a dead end is exactly the credential
		// a lock exists to remove.
		this.terminal = { steamId64: pending.steamId64, accountName: pending.accountName, kind };
		if (this.workflow !== undefined) {
			try {
				this.workflow = this.workflowJournal.updateTransfer(this.workflow, { state: kind });
			} catch {
				// The verified `sending` record is deliberately left in place. On restart
				// it says the outcome is unknown, which is conservative and still blocks.
			}
		}
		this.pending = undefined;
	}

	/**
	 * Clear one exact transfer record and remember when the only surviving copy
	 * is now in this process.
	 *
	 * A clear can fail before unlinking or during the directory flush after it.
	 * Re-reading the exact attempt distinguishes those cases. An unreadable
	 * journal is treated as process-only because permitting a vault replacement
	 * on an unknown answer is the irreversible direction.
	 */
	private clearWorkflowRecord(record: TransferWorkflowRecord): void {
		try {
			this.workflowJournal.clearTransfer(record);
			if (this.cleanupDebt?.attemptId === record.attemptId) this.cleanupDebt = undefined;
		} catch (err) {
			let stillDurable = false;
			try {
				stillDurable = this.workflowJournal
					.transfers(record.steamId64)
					.some((entry) => entry.attemptId === record.attemptId);
			} catch {
				// Unknown is kept as debt; restore must fail closed on it.
			}
			if (stillDurable) {
				if (this.cleanupDebt?.attemptId === record.attemptId) this.cleanupDebt = undefined;
			} else {
				this.cleanupDebt = record;
			}
			throw err;
		}
	}

	private clearKnownNoChange(record: TransferWorkflowRecord): void {
		try {
			this.clearWorkflowRecord(record);
			if (this.workflow?.attemptId === record.attemptId) this.workflow = undefined;
		} catch {
			try {
				this.workflow = this.workflowJournal.updateTransfer(record, { state: 'not-replaced' });
				if (this.cleanupDebt?.attemptId === record.attemptId) this.cleanupDebt = undefined;
			} catch {
				// The already-verified sending intent stays conservative on disk. In this
				// process the terminal state below still prevents a duplicate request.
			}
			this.terminal = {
				steamId64: record.steamId64,
				accountName: record.accountName,
				kind: 'not-replaced'
			};
			throw new TransferError(
				'Steam did not replace the authenticator, but the safety record could not be ' +
					'cleared. Re-open this screen and resolve that record before retrying.',
				false
			);
		}
	}

	private dropCredentials(): void {
		if (this.pending) {
			this.pending.refreshToken = undefined;
		}
	}

	awaiting():
		'persist' | 'unreadablePersist' | 'unanswered' | 'unreadable' | 'cleanup' | undefined {
		// The one state that can still be recovered: decoded, and the vault refused
		// it. Retrying storage genuinely works.
		if (this.unreadableHeld !== undefined) {
			return 'unreadablePersist';
		}
		if (this.unsaved !== undefined || this.workflow?.state === 'replacement') {
			return 'persist';
		}
		// The two that cannot. Reported so the screen can say which, because they
		// call for different things from the user — one is "go and look at your
		// phone", the other is "this account needs Steam Support".
		return this.terminal?.kind === 'not-replaced' ? 'cleanup' : this.terminal?.kind;
	}

	/**
	 * Drop a transfer that has not yet changed anything, and keep one that has.
	 *
	 * The lock handler's counterpart to `EnrollmentService.forget`. Before the SMS
	 * code is submitted this holds a live refresh token and access token, which
	 * are credentials as real as any other and had no business outliving a lock.
	 *
	 * **After it, the same call must do nothing.** What is held then is the only
	 * copy of a replacement Steam will not reissue, and an idle lock — something
	 * that happens by itself, while the user is away — is the last event that
	 * should be allowed to destroy it. So this is deliberately not `cancel()`,
	 * which throws in that situation: a lock is not a mistake to report, it is
	 * simply not a reason to discard anything.
	 */
	forgetIfIdle(): boolean {
		// **`submitting` counts as held, even though nothing is held yet.**
		//
		// Mid-submission the request is in the air: `unsaved` is still undefined, so
		// this looked idle and cleared `pending` — and `pending` is the identity the
		// outcome is reported against. An answer arriving a moment later then had
		// no account to name.
		//
		// A lock during the one request that rotates an authenticator is exactly
		// when this must not tidy up.
		// **Bumped first, whatever this call decides.** The generation records that a
		// *lock happened*, not that this managed to clear anything.
		//
		// A sign-in may be awaiting Steam right now, and it finishes by installing a
		// refresh token and an access token into `pending`. Clearing alone let that
		// land *after* the lock, so the credentials this call exists to drop
		// reappeared a second later and stayed for the whole locked period. The
		// generation is how the resolving sign-in learns it has been disowned — the
		// same shape the vault uses for a key derived across a lock.
		//
		// Bumping it twice, once here and once on the clearing path, was harmless
		// and misleading: it read as though the two cases were different events.
		this.generation += 1;

		// **Always, whatever this call decides about `pending`.**
		//
		// The first version of this dropped the session only when a lock landed
		// *during* a submission, which covered one scenario and left the more likely
		// one beside it: a lock arriving while a decoded replacement sits waiting to
		// be stored keeps `pending` — correctly, that is the identity a retry needs —
		// and kept its refresh token with it. `startChallenge` then succeeded, and
		// spent an SMS, with the vault locked.
		//
		// Nothing in flight breaks: both callers capture their access token in a
		// local before this can run, and `retryPersist` needs a name, a SteamID and
		// a route, never a credential.
		this.dropCredentials();

		// **`challenging` counts too.** A lock landing inside the SMS request left
		// Steam sending the message and spending the account's rate-limit tolerance,
		// while `pending` — the identity the challenge belongs to — was cleared:
		// after unlocking there was no transfer to come back to, and the text the
		// user was about to read had nothing to be typed into. `cancel` already
		// refuses in exactly this window, and a lock is not a stronger reason to
		// discard the work than an explicit abandonment is.
		//
		// The credentials go regardless — `dropCredentials` above runs first — so
		// what survives is the identity and nothing that can reach Steam again
		// without a fresh sign-in.
		if (
			this.submitting ||
			this.challenging ||
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined
		) {
			return false;
		}
		this.pending = undefined;
		// `uncertain` deliberately survives. It holds no credential, and it is the
		// only remaining record that a submission went out unanswered.
		return true;
	}

	/**
	 * Finish storing a replacement Steam has already issued.
	 *
	 * Separate and callable again because the expensive half is done: the
	 * authenticator has rotated and the code is spent. Retrying storage costs
	 * nothing and is the only way out of a failed write that does not end in a
	 * support ticket.
	 */
	async retryPersist(passphrase?: string): Promise<TransferComplete> {
		if (this.recovering || this.submitting) {
			throw new TransferError('This authenticator transfer is already being saved.', false);
		}
		let releaseVaultKey: (() => void) | undefined;
		const recoverySteamId64 = this.current()?.steamId64;
		if (recoverySteamId64 === undefined) {
			throw new TransferError('There is no unsaved authenticator to store.', false);
		}
		try {
			releaseVaultKey = this.keyCoordinator.beginTransferRecovery(recoverySteamId64);
		} catch (err) {
			throw new TransferError(
				err instanceof Error ? err.message : 'The vault is being replaced.',
				false
			);
		}
		this.recovering = true;
		try {
			return await this.retryPersistUnderReservation(passphrase);
		} finally {
			this.recovering = false;
			releaseVaultKey();
		}
	}

	private async retryPersistUnderReservation(passphrase?: string): Promise<TransferComplete> {
		const unreadable = this.unreadableHeld;
		if (unreadable !== undefined) {
			const record = this.workflow;
			if (record === undefined) {
				throw new TransferError(
					'The unusable replacement is still held in memory, but its safety-record identity is missing. Do not quit; repair the application data folder before retrying.',
					false
				);
			}
			try {
				this.retainUnreadableReplacement(record, unreadable);
			} catch {
				throw new TransferError(
					`The encrypted safety record for ${unreadable.accountName} still could not be saved. ` +
						'Do not quit; repair the application data folder and choose “Save it now” again.',
					false
				);
			}
			this.unreadableHeld = undefined;
			throw new TransferError(
				unreadableMessage(unreadable.accountName, unreadable.reason, true),
				false
			);
		}
		this.hydrateReplacement();
		if (!this.unsaved)
			throw new TransferError('There is no unsaved authenticator to store.', false);
		try {
			return await this.persist(passphrase);
		} finally {
			// A durable replacement can be decrypted again after unlock. Keeping its
			// plaintext account object in memory after a failed attempt would defeat the
			// lock boundary this journal was added to survive.
			if (this.workflow?.state === 'replacement') {
				this.unsaved = undefined;
			}
		}
	}

	/** True when secrets are held that the vault has not accepted yet. */
	hasUnsaved(): boolean {
		return (
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined ||
			this.workflow?.state === 'replacement'
		);
	}

	private hydrateReplacement(): void {
		if (this.unsaved !== undefined) return;
		const record = this.workflow;
		if (
			record?.state !== 'replacement' ||
			record.wrappedKey === undefined ||
			record.replacement === undefined
		) {
			return;
		}
		if (!this.vault.isUnlocked()) {
			throw new TransferError(
				'The replacement is saved in its encrypted recovery record, but the vault is locked. ' +
					'Unlock this vault and choose “Finish recovery”; Steam will not be contacted again.',
				false
			);
		}
		let key: Buffer | undefined;
		try {
			key = this.vault.openScopedEnvelope(record.wrappedKey);
			this.unsaved = openReplacement(record.replacement, key, record);
		} finally {
			if (key !== undefined) wipe(key);
		}
	}

	/** Encrypt a decoded-but-unusable replacement without making it saveable. */
	private retainUnreadableReplacement(
		record: TransferWorkflowRecord,
		held: HeldUnreadableReplacement
	): void {
		if (record.wrappedKey === undefined) {
			throw new TransferError('The transfer safety record has no wrapped recovery key.', false);
		}
		this.workflow = this.workflowJournal.updateTransfer(record, {
			state: 'unreadable',
			wrappedKey: record.wrappedKey,
			replacement: held.replacement
		});
	}

	/**
	 * Make the usable replacement independently recoverable before the vault is
	 * allowed to contain it.
	 *
	 * A failed first promotion deliberately leaves `unsaved` in memory and stops
	 * here. On a later retry we re-read the journal first: an update can have
	 * reached its final filename before its directory flush reported failure, so
	 * retrying from the stale in-memory `sending` object would manufacture a
	 * conflicting replacement ciphertext for the same attempt.
	 */
	private promoteReplacementBeforeVaultWrite(held: HeldReplacement): TransferWorkflowRecord {
		const remembered = this.workflow;
		if (remembered === undefined || remembered.wrappedKey === undefined) {
			throw new TransferError(
				'The replacement is still held in memory, but its transfer safety-record identity is missing. Nothing was written to the vault.',
				false
			);
		}

		let records: TransferWorkflowRecord[];
		try {
			records = this.workflowJournal.transfers(remembered.steamId64);
		} catch {
			throw new TransferError(
				'The replacement is still held in memory, but its transfer safety record could not be verified. Nothing was written to the vault.',
				false
			);
		}
		const exact = records.find((entry) => entry.attemptId === remembered.attemptId);
		const processOnly =
			this.cleanupDebt?.attemptId === remembered.attemptId &&
			this.cleanupDebt.steamId64 === remembered.steamId64
				? this.cleanupDebt
				: undefined;
		if (
			records.length > 1 ||
			(records.length === 1 && exact === undefined) ||
			(exact !== undefined && exact.steamId64 !== remembered.steamId64)
		) {
			throw new TransferError(
				'The replacement is still held in memory, but its exact transfer safety record is missing or ambiguous. Nothing was written to the vault.',
				false
			);
		}
		const record = exact ?? processOnly;
		if (record === undefined) {
			throw new TransferError(
				'The replacement is still held in memory, but its exact transfer safety record is missing or ambiguous. Nothing was written to the vault.',
				false
			);
		}

		if (record.state === 'replacement') {
			if (record.wrappedKey === undefined || record.replacement === undefined) {
				throw new TransferError('The saved replacement safety record is incomplete.', false);
			}
			let key: Buffer | undefined;
			try {
				key = this.vault.openScopedEnvelope(record.wrappedKey);
				const recovered = openReplacement(record.replacement, key, record);
				if (
					!storedFaithfully(recovered.account, held.account) ||
					recovered.timeOffsetSeconds !== held.timeOffsetSeconds
				) {
					throw new TransferError(
						'The saved transfer replacement does not match the replacement held by this process. Nothing was written to the vault.',
						false
					);
				}
			} finally {
				if (key !== undefined) wipe(key);
			}
			this.workflow = record;
			return record;
		}

		if (record.state !== 'sending') {
			throw new TransferError(
				`The transfer safety record is already classified as ${record.state}; it cannot be promoted from the in-memory replacement. Nothing was written to the vault.`,
				false
			);
		}
		const wrappedKey = record.wrappedKey;
		if (wrappedKey === undefined) {
			throw new TransferError('The sending transfer safety record has no recovery key.', false);
		}

		let key: Buffer | undefined;
		try {
			key = this.vault.openScopedEnvelope(wrappedKey);
			const promoted = this.workflowJournal.updateTransfer(record, {
				state: 'replacement',
				wrappedKey,
				replacement: sealReplacement(held, key, record)
			});
			this.workflow = promoted;
			return promoted;
		} catch (err) {
			if (err instanceof TransferError) throw err;
			throw new TransferError(
				`Steam replaced the authenticator on ${held.account.accountName}, but its encrypted recovery record still could not be saved. Nothing was written to the vault; do not close this app and choose “Finish recovery” again after repairing the application data folder.`,
				false
			);
		} finally {
			if (key !== undefined) wipe(key);
		}
	}

	private async persist(passphrase?: string): Promise<TransferComplete> {
		const held = this.unsaved;
		if (!held) {
			throw new TransferError('There is no unsaved authenticator to store.', false);
		}
		const { account, timeOffsetSeconds } = held;
		const invalidSecret = authenticatorSecretProblem(account);
		if (invalidSecret !== undefined) {
			const reason = describeAuthenticatorSecretProblem(invalidSecret);
			const record = this.workflow;
			if (record === undefined || record.wrappedKey === undefined) {
				throw new TransferError('The transfer safety record has no wrapped recovery key.', false);
			}
			let openedKey: Buffer | undefined;
			let replacement = record.replacement;
			try {
				if (replacement === undefined) {
					openedKey = this.vault.openScopedEnvelope(record.wrappedKey);
					replacement = sealTransferPayload(
						unreadablePayloadFromHeld(held, reason),
						openedKey,
						record
					);
				}
			} finally {
				if (openedKey !== undefined) wipe(openedKey);
			}
			const unreadable = unreadableFromHeld(held, reason, replacement);
			this.unreadableHeld = unreadable;
			this.unsaved = undefined;
			try {
				this.retainUnreadableReplacement(record, unreadable);
				this.unreadableHeld = undefined;
			} catch {
				// Only encrypted ciphertext remains for another explicit retry. It is
				// never offered to the vault and no plaintext survives a lock.
			}
			this.terminal = {
				steamId64: account.steamId64,
				accountName: account.accountName,
				kind: 'unreadable'
			};
			this.pending = undefined;
			throw new TransferError(
				`The retained replacement cannot be stored as a working authenticator because ${reason}. ` +
					'The safety record has been kept; resolve it through Steam or Steam Support.',
				false
			);
		}
		const movedOn = (): TransferError =>
			new TransferError(
				`This vault now holds a different authenticator for ${account.accountName}. The saved ` +
					'transfer replacement was not written over it, and its encrypted workflow was kept.',
				false
			);
		const notSaved = (): TransferError =>
			new TransferError(
				`Steam has moved the authenticator for ${account.accountName} to this app, but it ` +
					'could not be saved. Its encrypted workflow is intact. Unlock this same vault and ' +
					'choose “Finish recovery”; Steam will not be contacted again.'
			);

		// The encrypted workflow must become authoritative before the first vault
		// write. Otherwise a successful vault write followed by a failed journal
		// clear leaves a `sending` record indistinguishable from an old account
		// resurrected by backup restore.
		let replacementRecord = this.promoteReplacementBeforeVaultWrite(held);

		/*
		 * A restart-time retry may be old. Inspect the current row before either
		 * destination: overwriting the vault is bad, but overwriting that newer
		 * authenticator's recovery file first is the same loss one file later.
		 * An exact row is cleanup debt only; preserving it also preserves activation,
		 * routing, auto-confirm settings and future passthrough fields.
		 */
		let before: Account | undefined;
		try {
			before = this.vault.read().accounts.find((entry) => entry.steamId64 === account.steamId64);
		} catch {
			throw notSaved();
		}
		let replaceFingerprint: string | undefined;
		if (before !== undefined && !storedFaithfully(before, account)) {
			const candidateFingerprint = authenticatorFingerprint(before);
			if (
				replacementRecord.priorAuthenticatorFingerprint !== undefined &&
				replacementRecord.priorAuthenticatorFingerprint !== candidateFingerprint
			) {
				throw movedOn();
			}
			if (passphrase === undefined || passphrase === '') {
				throw new TransferError(
					`This vault contains a different authenticator for ${account.accountName}. If a backup restored that older copy, enter the vault passphrase to replace it with Steam's saved replacement.`,
					false
				);
			}
			replaceFingerprint = candidateFingerprint;
			await this.vault.verifyPassphrase(passphrase);

			// The proof above is intentionally slow. Re-read both sources afterwards:
			// a changed workflow or authenticator identity invalidates the authority to
			// replace what was inspected before the await.
			replacementRecord = this.promoteReplacementBeforeVaultWrite(held);
			if (
				replacementRecord.priorAuthenticatorFingerprint !== undefined &&
				replacementRecord.priorAuthenticatorFingerprint !== replaceFingerprint
			) {
				throw movedOn();
			}
			let afterProof: Account | undefined;
			try {
				afterProof = this.vault
					.read()
					.accounts.find((entry) => entry.steamId64 === account.steamId64);
			} catch {
				throw notSaved();
			}
			if (
				afterProof === undefined ||
				storedFaithfully(afterProof, account) ||
				authenticatorFingerprint(afterProof) !== replaceFingerprint
			) {
				throw movedOn();
			}
		}
		let replacedObsolete = false;

		if (before === undefined || replaceFingerprint !== undefined) {
			try {
				await this.vault.mutate((draft) => {
					/*
					 * Replace, never blindly append.
					 *
					 * `persist` is deliberately re-runnable: a failed read-back keeps the
					 * secrets and invites a retry. But the vault write may well have
					 * succeeded on the attempt that failed its read-back, so a retry that
					 * pushed unconditionally would leave two records for one SteamID —
					 * holding the same live secrets, shown twice everywhere, and with
					 * "remove the account" leaving a copy behind.
					 */
					const existing = draft.accounts.findIndex((a) => a.steamId64 === account.steamId64);
					if (existing >= 0) {
						if (!storedFaithfully(draft.accounts[existing], account)) {
							if (
								replaceFingerprint === undefined ||
								authenticatorFingerprint(draft.accounts[existing]!) !== replaceFingerprint
							) {
								throw movedOn();
							}
							const stored = { ...account };
							if (this.writeRecovery !== undefined) {
								markRecoveryBackupNeeded(
									stored,
									draft.accounts[existing]!.recoveryBackup,
									new Date(this.now()).toISOString()
								);
							}
							draft.accounts[existing] = stored;
							replacedObsolete = true;
						}
					} else {
						if (replaceFingerprint !== undefined) throw movedOn();
						const stored = { ...account };
						if (this.writeRecovery !== undefined) {
							markRecoveryBackupNeeded(stored, undefined, new Date(this.now()).toISOString());
						}
						draft.accounts.push(stored);
					}
				});
			} catch (err) {
				if (err instanceof TransferError) throw err;
				throw notSaved();
			}
		} else if (
			this.writeRecovery !== undefined &&
			this.workflow?.recoveryPublished !== true &&
			before.recoveryBackup === undefined
		) {
			// Backfill durable publication debt for a retained transfer written by a
			// build that did not yet store recovery ownership on the account.
			try {
				await this.vault.mutate((draft) => {
					const current = draft.accounts.find(
						(entry) => entry.steamId64 === account.steamId64 && storedFaithfully(entry, account)
					);
					if (current === undefined) throw movedOn();
					if (current.recoveryBackup === undefined) {
						markRecoveryBackupNeeded(current, undefined, new Date(this.now()).toISOString());
					}
				});
			} catch (err) {
				if (err instanceof TransferError) throw err;
				throw notSaved();
			}
		}
		if (replacedObsolete) {
			// The vault commit has retired the old authenticator and route. Drop its
			// browser/session state before any later recovery-file or journal failure.
			this.onAccountReplaced(account.steamId64);
		}

		/*
		 * Read it back before saying it worked.
		 *
		 * "The write did not throw" and "the secrets are on disk and decryptable"
		 * are different claims. Only the second one is safe to tell somebody whose
		 * phone stopped being their authenticator a moment ago.
		 */
		let stored: Account | undefined;
		try {
			stored = this.vault.read().accounts.find((a) => a.steamId64 === account.steamId64);
		} catch {
			throw notSaved();
		}
		if (stored !== undefined && !storedFaithfully(stored, account)) throw movedOn();
		if (stored === undefined || !storedFaithfully(stored, account)) {
			throw new TransferError(
				`Steam has moved the authenticator for ${account.accountName}, but what was saved does ` +
					'not read back correctly. Nothing has been discarded — try again from this screen. ' +
					`If it keeps failing, write down this recovery code: ${account.revocationCode}.`
			);
		}

		let recoveryWarning: string | undefined;
		if (
			this.workflow !== undefined &&
			(this.workflow.recoveryPublished !== true || stored.recoveryBackup?.state !== 'current')
		) {
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
				this.workflow = this.workflowJournal.markTransferRecovery(this.workflow, true);
			} catch {
				recoveryWarning =
					'The replacement authenticator is safely stored in this vault, but its separate encrypted recovery backup could not be written. The encrypted transfer record was kept. Repair the application data folder and choose “Finish recovery”; Steam will not be contacted again.';
				// The account marker remains the authority. Do not write `false` here:
				// this catch can run after the file and account marker succeeded but the
				// journal update failed.
			}
		}

		this.unsaved = undefined;
		this.pending = undefined;
		if (recoveryWarning === undefined && this.workflow !== undefined) {
			try {
				this.clearWorkflowRecord(this.workflow);
				this.workflow = undefined;
			} catch {
				throw new TransferError(
					`The replacement authenticator for ${account.accountName} is safely stored in this vault, but its local transfer safety record could not be cleared. ` +
						'Do not start another transfer. Repair the application data folder, then choose “Finish recovery”; Steam will not be contacted again.',
					false
				);
			}
		}

		return {
			steamId64: account.steamId64,
			accountName: account.accountName,
			revocationCode: account.revocationCode ?? '',
			timeOffsetSeconds,
			...(recoveryWarning === undefined ? {} : { recoveryWarning })
		};
	}

	/**
	 * The account this transfer is for, or undefined once it has lapsed.
	 *
	 * Exposed rather than the pending record itself, so no caller — and in
	 * particular no IPC handler — can reach the tokens.
	 */
	current(): { steamId64: string; accountName: string } | undefined {
		const pending = this.live();
		if (pending) {
			return { steamId64: pending.steamId64, accountName: pending.accountName };
		}
		// An unresolved submission outlives its tokens, so the screen can still name
		// the account it is telling the user to go and check.
		return this.terminal
			? { steamId64: this.terminal.steamId64, accountName: this.terminal.accountName }
			: this.workflow
				? { steamId64: this.workflow.steamId64, accountName: this.workflow.accountName }
				: undefined;
	}

	/** A malformed/newer durable record is a blocking, user-visible state. */
	problem(): string | undefined {
		return this.workflowProblem;
	}

	/** A key-changing vault operation would orphan the wrapped transfer key. */
	hasDurableWorkflow(): boolean {
		return (
			this.submitting ||
			this.recovering ||
			this.workflow?.wrappedKey !== undefined ||
			this.workflowProblem !== undefined
		);
	}

	/** A failed clear left this process holding the only exact transfer record. */
	hasTransferCleanupDebt(steamId64?: string): boolean {
		return (
			this.cleanupDebt !== undefined &&
			(steamId64 === undefined || this.cleanupDebt.steamId64 === steamId64)
		);
	}

	recovery():
		| {
				attemptId: string;
				state: TransferWorkflowRecord['state'];
				at: string;
				retained: boolean;
				requiresPassphrase?: boolean;
		  }
		| undefined {
		if (this.workflow === undefined) return undefined;
		const record = this.workflow;
		let requiresPassphrase = false;
		try {
			const current = this.vault
				.read()
				.accounts.find((account) => account.steamId64 === record.steamId64);
			if (current !== undefined) {
				const currentFingerprint = authenticatorFingerprint(current);
				if (
					record.state === 'replacement' &&
					record.wrappedKey !== undefined &&
					record.replacement !== undefined
				) {
					let key: Buffer | undefined;
					try {
						key = this.vault.openScopedEnvelope(record.wrappedKey);
						const replacement = openReplacement(record.replacement, key, record);
						requiresPassphrase =
							!storedFaithfully(current, replacement.account) &&
							(record.priorAuthenticatorFingerprint === undefined ||
								record.priorAuthenticatorFingerprint === currentFingerprint);
					} finally {
						if (key !== undefined) wipe(key);
					}
				} else if (
					record.priorAuthenticatorFingerprint === currentFingerprint &&
					record.state !== 'sending' &&
					record.state !== 'not-replaced' &&
					!(record.state === 'unreadable' && record.replacement !== undefined)
				) {
					requiresPassphrase = true;
				}
			}
		} catch {
			// Status remains non-authoritative while the vault or recovery material
			// cannot be read. The service still requires proof before any mutation.
		}
		return {
			attemptId: this.workflow.attemptId,
			state: this.workflow.state,
			at: this.workflow.at,
			retained: this.workflow.state === 'unreadable' && this.workflow.replacement !== undefined,
			...(requiresPassphrase ? { requiresPassphrase: true } : {})
		};
	}

	/**
	 * Resolve the exact durable transfer after the user checked the phone/Steam.
	 * No generic close button calls this: each choice has a different meaning.
	 */
	async resolve(
		attemptId: string,
		resolution: 'notReplaced' | 'replaced' | 'resolvedOutsideApp',
		passphrase?: string
	): Promise<void> {
		if (
			this.submitting ||
			this.recovering ||
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined
		) {
			throw new TransferError(
				'This transfer still holds or is saving replacement secrets. Its safety record cannot be resolved or discarded.',
				false
			);
		}
		const remembered =
			this.workflow?.attemptId === attemptId
				? this.workflow
				: this.cleanupDebt?.attemptId === attemptId
					? this.cleanupDebt
					: undefined;
		if (remembered === undefined) {
			throw new TransferError(
				'That transfer safety record is no longer current. Re-open this screen before changing it.',
				false
			);
		}

		let releaseAccountMutation: () => void;
		try {
			releaseAccountMutation = this.keyCoordinator.beginAccountMutation(remembered.steamId64);
		} catch (err) {
			throw new TransferError(
				err instanceof Error ? err.message : 'Another protected account change is in progress.',
				false
			);
		}

		try {
			/*
			 * Re-read the exact durable record after taking the shared account
			 * reservation. Process-only cleanup debt is the one valid exception to an
			 * absent file. The same function is called again after passphrase derivation,
			 * because that await must not turn an old renderer choice into authority over
			 * a newer workflow state.
			 */
			const readExact = (): TransferWorkflowRecord => {
				let durable: TransferWorkflowRecord[];
				try {
					durable = this.workflowJournal.transfers();
				} catch {
					throw new TransferError(
						'The saved transfer safety record could not be verified, so nothing was changed. Repair the application data folder and try again.',
						false
					);
				}
				const exact = durable.find((entry) => entry.attemptId === attemptId);
				if (
					durable.length > 1 ||
					(durable.length === 1 && exact === undefined) ||
					(exact !== undefined && exact.steamId64 !== remembered.steamId64)
				) {
					throw new TransferError(
						'The saved transfer state is ambiguous, so nothing was changed. Repair the application data folder before resolving it.',
						false
					);
				}
				const record =
					exact ??
					(this.cleanupDebt?.attemptId === attemptId &&
					this.cleanupDebt.steamId64 === remembered.steamId64
						? this.cleanupDebt
						: undefined);
				if (record === undefined) {
					throw new TransferError(
						'That transfer safety record is no longer current. Re-open this screen before changing it.',
						false
					);
				}
				return record;
			};

			let record = readExact();
			this.workflow = record;

			if (record.state === 'not-replaced') {
				if (resolution !== 'notReplaced') {
					throw new TransferError(
						'This safety record proves Steam did not replace the authenticator. Re-open the screen and clear only that exact no-change record.',
						false
					);
				}
				this.clearKnownNoChange(record);
				this.terminal = undefined;
				this.pending = undefined;
				return;
			}

			if (resolution === 'notReplaced') {
				if (record.state !== 'sending' && record.state !== 'unanswered') {
					throw new TransferError(
						'Steam is known to have issued a replacement, so this cannot be cleared as a safe retry.',
						false
					);
				}
				this.clearKnownNoChange(record);
				this.terminal = undefined;
				this.pending = undefined;
				return;
			}

			if (record.state === 'replacement') {
				throw new TransferError(
					resolution === 'replaced'
						? 'The replacement secrets are recoverable here. Finish recovery instead of discarding them.'
						: 'This record contains a recoverable replacement. Finish recovery; it cannot be discarded through the ordinary recovery acknowledgement.',
					false
				);
			}
			if (
				(resolution === 'replaced' &&
					record.state !== 'sending' &&
					record.state !== 'unanswered' &&
					!(record.state === 'unreadable' && record.replacement === undefined)) ||
				(resolution === 'resolvedOutsideApp' &&
					record.state !== 'unanswered' &&
					record.state !== 'unreadable')
			) {
				throw new TransferError(
					'That resolution does not match the transfer state now on disk. Re-open this screen before changing it.',
					false
				);
			}

			/*
			 * `unanswered` and an unretained `unreadable` record were published while
			 * this SteamID was absent from the vault. A row that later appears beside one
			 * therefore came from a compatible pre-transfer backup. A raw `sending`
			 * record is different: it does not prove whether a usable reply was received,
			 * so a same-ID row is ambiguous and may never be deleted. Likewise retained
			 * ciphertext can describe secrets this build cannot compare safely.
			 */
			const restored = this.vault
				.read()
				.accounts.find((account) => account.steamId64 === record.steamId64);
			if (
				restored !== undefined &&
				(record.state === 'sending' ||
					record.replacement !== undefined ||
					record.priorAuthenticatorFingerprint === undefined ||
					authenticatorFingerprint(restored) !== record.priorAuthenticatorFingerprint)
			) {
				throw new TransferError(
					'This vault contains an authenticator for that account, but the saved transfer cannot prove which secrets are current. Nothing was removed; finish recovery or repair the safety record first.',
					false
				);
			}

			if (restored !== undefined) {
				if (passphrase === undefined || passphrase === '') {
					throw new TransferError(
						'Removing the obsolete authenticator from this vault needs your vault passphrase, the same as removing an account any other way.',
						false
					);
				}
				const fingerprint = authenticatorFingerprint(restored);
				await this.vault.verifyPassphrase(passphrase);

				const afterProof = readExact();
				if (JSON.stringify(afterProof) !== JSON.stringify(record)) {
					throw new TransferError(
						'The transfer safety record changed while the passphrase was being checked. Nothing was removed; re-open this screen and try again.',
						false
					);
				}
				record = afterProof;
				this.workflow = record;

				let removed = false;
				try {
					await this.vault.mutate((draft) => {
						const index = draft.accounts.findIndex(
							(account) => account.steamId64 === record.steamId64
						);
						if (index < 0) return;
						if (authenticatorFingerprint(draft.accounts[index]!) !== fingerprint) {
							throw new TransferError(
								'This vault now holds a different authenticator for that account. Nothing was removed; re-open the recovery screen.',
								false
							);
						}
						draft.accounts.splice(index, 1);
						removed = true;
					});
				} catch (err) {
					if (err instanceof TransferError) throw err;
					throw new TransferError(
						'The obsolete pre-transfer authenticator could not be removed from this vault, so its transfer safety record was kept. Repair vault storage and try the same resolution again.',
						false
					);
				}
				if (removed) {
					this.onAccountRemoved(record.steamId64, true);
				}
			}

			if (resolution === 'replaced') {
				if (record.state !== 'unreadable') {
					try {
						this.workflow = this.workflowJournal.updateTransfer(record, { state: 'unreadable' });
					} catch {
						/*
						 * A replace can reach its final filename and then fail the directory
						 * flush. Re-read before reporting it: the renderer asks status after
						 * every failed resolution, and must see the state actually on disk
						 * rather than keep offering actions for the old `unanswered` object.
						 */
						try {
							const durable = this.workflowJournal.transfers(record.steamId64);
							const exact = durable.find((entry) => entry.attemptId === record.attemptId);
							if (durable.length === 1 && exact?.state === 'unreadable') {
								this.workflow = exact;
								this.terminal = {
									steamId64: exact.steamId64,
									accountName: exact.accountName,
									kind: 'unreadable'
								};
							}
						} catch {
							// Preserve the conservative in-memory state when the durable answer
							// itself cannot be verified.
						}
						throw new TransferError(
							'The obsolete authenticator was removed, but the transfer safety record could not be updated. Repair the application data folder and choose the same resolution again.',
							false
						);
					}
				}
				this.terminal = {
					steamId64: record.steamId64,
					accountName: record.accountName,
					kind: 'unreadable'
				};
				return;
			}

			// The user explicitly says Steam/Support has repaired or removed the
			// replacement outside this app. Reconcile the vault first, then retire only
			// this exact record; a failed clear remains available for an exact retry.
			try {
				this.clearWorkflowRecord(record);
			} catch {
				throw new TransferError(
					'The vault was reconciled, but its transfer safety record could not be cleared. Repair the application data folder and choose the same resolution again.',
					false
				);
			}
			this.workflow = undefined;
			this.terminal = undefined;
			this.unsaved = undefined;
			this.unreadableHeld = undefined;
		} finally {
			releaseAccountMutation();
		}
	}

	/**
	 * Abandon a transfer that has not yet asked Steam to change anything.
	 *
	 * Refuses once secrets are held, rather than obliging. By then the
	 * authenticator has rotated and `pending` is the account the replacement is
	 * stored under, so discarding it would strip the user of the only route back to
	 * secrets Steam will not reissue — on a channel the renderer can reach at any
	 * time, for a button the screen is merely careful not to show.
	 */
	cancel(): void {
		// **`submitting` and `authenticating` count, even with nothing held yet.**
		//
		// `pending` carries the SteamID and account name a failure is reported
		// against. Clearing it while the irreversible request is in the air meant an
		// answer arriving a moment later had nothing to name. The screen hides this
		// button then, but the channel stays callable.
		// `challenging` belongs here with the other two. Cancelling during it cleared
		// `pending` and closed the screen while the request that asks Steam to text a
		// code was still in flight — so the message was still sent, and the user's
		// rate limit still spent, on a transfer they had just abandoned.
		if (this.submitting || this.authenticating || this.challenging) {
			throw new TransferError(
				'This transfer is in the middle of a request to Steam and cannot be abandoned yet.',
				false
			);
		}
		// **`unsaved` only — a terminal transfer is the one this discharges.**
		//
		// Refusing while secrets are held is right: they are irreplaceable and the
		// retry is the way out. A transfer that ended without them holds nothing,
		// and cancelling is how the user says "I have read this and checked my
		// phone". Guarding on it too would trap them on a screen whose only button
		// calls this.
		if (
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined ||
			this.workflow !== undefined
		) {
			throw new TransferError(
				'This transfer cannot be abandoned: its durable safety record cannot be dismissed as a generic cancel. ' +
					'Use the answer on the recovery screen that matches what you found on Steam.',
				false
			);
		}
		this.pending = undefined;
		this.terminal = undefined;
	}

	/**
	 * The pending transfer, if it has not expired.
	 *
	 * Expiry is checked on read rather than by a timer: a timer that fires while
	 * the app is asleep proves nothing about how long the user was away, and the
	 * question is only ever asked when somebody is about to use it.
	 */
	private live(): PendingTransfer | undefined {
		if (!this.pending) {
			return undefined;
		}
		/*
		 * A transfer holding secrets never lapses.
		 *
		 * The TTL exists to drop an abandoned sign-in, which costs nothing. Once
		 * Steam has answered it is the opposite: the authenticator has rotated, the
		 * only copy of its replacement is in `unsaved`, and `retryPersist` needs the
		 * pending record for the account it stores under.
		 *
		 * Without this, the status channel was enough to lose an account. It calls
		 * `current()`, which calls this — so one poll fifteen minutes after a failed
		 * decode would clear the record and leave the reply unreadable, while the
		 * user was still reading the error telling them not to close the window.
		 */
		if (
			this.unsaved !== undefined ||
			this.unreadableHeld !== undefined ||
			this.terminal !== undefined
		) {
			return this.pending;
		}
		if (this.monotonicNow() - this.pending.startedAtElapsedMs > PENDING_TTL_MS) {
			this.pending = undefined;
			return undefined;
		}
		return this.pending;
	}

	/**
	 * Refuse an account this app already holds.
	 *
	 * Overwriting would destroy a working authenticator's secrets, and Steam will
	 * happily rotate an authenticator this app already has a record of.
	 */
	private refuseIfAlreadyHeld(steamId64: string): void {
		const held = this.vault.read().accounts.some((account) => account.steamId64 === steamId64);
		if (held) {
			throw new TransferError(
				'This app already holds an authenticator for that account. Remove it here first if you ' +
					'mean to replace it.'
			);
		}
	}

	/**
	 * A transport routed the same way as this transfer's sign-in.
	 *
	 * Every call in one transfer has to leave by the same address: Steam treats a
	 * challenge answered from somewhere else as a different client, and the SMS
	 * step is not one to spend twice.
	 */
	async transportFor(): Promise<ReturnType<SteamTransportFactory['forAccount']> | undefined> {
		const pending = this.live();
		if (!pending) {
			return undefined;
		}
		return this.transports.forAccount({
			steamId64: pending.steamId64,
			proxyUrl: pending.proxyUrl
		});
	}

	/** Steam-corrected seconds, the clock every code in this app is cut against. */
	private unixSeconds(): number {
		return Math.floor(this.now() / 1000) + this.offset();
	}
}
