import { signIn, type LoginSessionFactory } from './login';
import { redactCredentials } from '../net/egress';
import { mintAccessToken } from './access-token';
import {
	continueTransfer,
	startTransferChallenge,
	TransferApiError,
	type StartChallengeResult
} from './transfer-api';
import type { ReplacementToken } from './transfer-proto';
import {
	accountFromReplacement,
	offsetFrom,
	storedFaithfully,
	validateReplacement
} from './transfer-store';
import type { Account } from '../../shared/vault-schema';
import type { SteamTransportFactory } from '../net/transport';
import type { VaultService } from '../vault/service';

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
 * Two shapes, and the difference is the whole point of recording it:
 *
 *  - `unanswered` — the request went out and nothing came back. Steam may or may
 *    not have acted. The user has to look at their phone to find out.
 *  - `unreadable` — Steam answered, so it rotated, and this build cannot use
 *    what it sent. That is a dead end, and the account needs Steam Support.
 *
 * Holds a name and an id, never a credential, so it can outlive a lock — losing
 * it would cost the user the only record that either happened.
 */
interface TerminalTransfer {
	steamId64: string;
	accountName: string;
	kind: 'unanswered' | 'unreadable';
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
function unreadableMessage(accountName: string, reason?: string): string {
	return (
		`Steam replaced the authenticator on ${accountName}, and this version could not read what ` +
		`it sent back${reason ? ` (${reason})` : ''}. That cannot be recovered here. The account ` +
		'still has Steam Guard — it is now an authenticator nothing holds — so Steam Support is ' +
		'the route back into it.'
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
};

export type AuthenticateOutcome = {
	state: 'authenticated';
	steamId64: string;
	accountName: string;
};

export interface TransferServiceOptions {
	now?: () => number;
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
	writeRecovery?: (account: Account) => void;
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
	 * but it also holds a refresh token and an access token, and nothing stripped
	 * those when the request settled. A lock therefore left a live Steam session
	 * behind, usable to start another challenge, for as long as the vault stayed
	 * shut. What recovery needs is the identity; what it does not need is the
	 * credentials.
	 */
	refreshToken: string | undefined;
	accessToken: string | undefined;
	/** Carried so every later call in this transfer takes the same route. */
	proxyUrl: string | undefined;
	startedAtMs: number;
}

export class TransferService {
	private readonly vault: VaultService;
	private readonly transports: SteamTransportFactory;
	private readonly now: () => number;
	private readonly offset: () => number;
	private readonly loginSession: LoginSessionFactory | undefined;
	private readonly performSignIn: typeof signIn;
	private readonly performStart: typeof startTransferChallenge;
	private readonly mint: typeof mintAccessToken;
	private readonly performContinue: typeof continueTransfer;
	private readonly writeRecovery: ((account: Account) => void) | undefined;

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

	/**
	 * A replacement Steam has issued that is not yet safely stored.
	 *
	 * Its presence means the account's authenticator has already rotated. It is
	 * held so that a storage failure can be retried without asking Steam again —
	 * which is impossible, because the code is spent and the secrets are issued
	 * once.
	 */
	private unsaved: { account: Account; token: ReplacementToken } | undefined;

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
		this.loginSession = options.loginSession;
		this.performSignIn = options.signIn ?? signIn;
		this.performStart = options.startChallenge ?? startTransferChallenge;
		this.mint = options.mintAccessToken ?? mintAccessToken;
		this.performContinue = options.continueChallenge ?? continueTransfer;
		this.writeRecovery = options.writeRecovery;
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
	async authenticate(
		accountName: string,
		password: string,
		steamGuardCode: string,
		proxyUrl?: string
	): Promise<AuthenticateOutcome> {
		if (this.authenticating) {
			throw new TransferError('A sign-in for this transfer is already in progress.', false);
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
		if (this.unsaved !== undefined || this.terminal !== undefined) {
			throw new TransferError(
				'Another transfer has not finished: Steam has already replaced an authenticator and it ' +
					'is not saved yet. Finish that one before signing in to a different account.',
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
				this.now
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
			if (this.unsaved !== undefined || this.terminal !== undefined || this.submitting) {
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
				accessToken: result.accessToken,
				proxyUrl,
				startedAtMs: this.now()
			};

			return { state: 'authenticated', steamId64, accountName };
		} finally {
			this.authenticating = false;
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
		if (this.unsaved !== undefined || this.terminal !== undefined) {
			throw new TransferError(
				'This transfer has not finished. Asking Steam to text another code cannot help, and ' +
					'spends a message and a rate limit that the unfinished one may still need.',
				false
			);
		}
		if (this.challenging) {
			throw new TransferError('Steam has already been asked for a code.', false);
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
			pending.accessToken = accessToken;
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
	 * 3. The recovery file is written *before* the vault, because it is the copy
	 *    that survives a vault this process cannot write.
	 * 4. The vault is written, then read back, and only a faithful read-back is
	 *    reported as success.
	 *
	 * If any step after Steam answers fails, the bundle stays in memory and the
	 * transfer enters a state `retryPersist` can finish. Nothing is discarded and
	 * nothing claims to have worked.
	 */
	async completeTransfer(smsCode: string): Promise<TransferComplete> {
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
					: unreadableMessage(this.terminal.accountName),
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
		if (this.unsaved !== undefined || this.terminal !== undefined) {
			throw new TransferError(
				'Steam has already replaced this authenticator and the result is still unsaved. ' +
					'Sending the code again cannot help and would discard what it sent back.',
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

		this.submitting = true;
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

			const result = await this.performContinue(transport, accessToken, code, () => {
				bodyArrived = true;
			}).catch((err: unknown) => {
				/*
				 * Two very different failures arrive here, and telling them apart is
				 * the difference between a shrug and an emergency.
				 *
				 * A `TransferApiError` means Steam declined to act — rate limit,
				 * expired token, malformed request. It answered with a status and did
				 * nothing, so the authenticator is untouched and its own message is
				 * both accurate and actionable. Dressing that up as "your
				 * authenticator has probably been replaced" would be false, and
				 * frightening in a way that invites the wrong reaction.
				 */
				if (err instanceof TransferApiError) {
					throw new TransferError(err.message, false);
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
			if (!result.success) {
				// Steam read the request and refused it, so nothing rotated.
				throw new TransferError(
					'Steam did not accept that code. Nothing has changed — check the code and try again.',
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
				// Decoded and still unusable — a SteamID that does not match, or a Guard
				// scheme this build does not know. Steam rotated the authenticator
				// either way, so this is the same dead end as a reply that would not
				// parse, and it gets the same answer.
				//
				// The reason is carried through: "a replacement issued for a different
				// account" and "no login secret" say different things about what went
				// wrong, and a support conversation starts from whichever it was.
				this.finish(pending, 'unreadable');
				throw new TransferError(
					unreadableMessage(pending.accountName, err instanceof Error ? err.message : undefined),
					false
				);
			}
			this.unsaved = { account, token: result.replacementToken };

			return await this.persist();
		} finally {
			this.submitting = false;
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
	private finish(pending: PendingTransfer, kind: TerminalTransfer['kind']): void {
		// The session goes with `pending`: there is nothing left to ask Steam, and a
		// refresh token sitting in memory after a dead end is exactly the credential
		// a lock exists to remove.
		this.terminal = { steamId64: pending.steamId64, accountName: pending.accountName, kind };
		this.pending = undefined;
	}

	private dropCredentials(): void {
		if (this.pending) {
			this.pending.refreshToken = undefined;
			this.pending.accessToken = undefined;
		}
	}

	awaiting(): 'persist' | 'unanswered' | 'unreadable' | undefined {
		// The one state that can still be recovered: decoded, and the vault refused
		// it. Retrying storage genuinely works.
		if (this.unsaved !== undefined) {
			return 'persist';
		}
		// The two that cannot. Reported so the screen can say which, because they
		// call for different things from the user — one is "go and look at your
		// phone", the other is "this account needs Steam Support".
		return this.terminal?.kind;
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

		if (this.submitting || this.unsaved !== undefined) {
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
	async retryPersist(): Promise<TransferComplete> {
		if (!this.unsaved) {
			throw new TransferError('There is no unsaved authenticator to store.', false);
		}
		return this.persist();
	}

	/** True when secrets are held that the vault has not accepted yet. */
	hasUnsaved(): boolean {
		return this.unsaved !== undefined;
	}

	private async persist(): Promise<TransferComplete> {
		const held = this.unsaved;
		if (!held) {
			throw new TransferError('There is no unsaved authenticator to store.', false);
		}
		const { account, token } = held;

		/*
		 * The recovery file first.
		 *
		 * It is written with the vault's own key, so it is no less protected — and
		 * it is the copy that survives if the vault write is the thing that fails.
		 * Best-effort: a backup that cannot be written is not a reason to abandon
		 * secrets that exist nowhere else.
		 */
		let recovered = false;
		try {
			this.writeRecovery?.(account);
			recovered = this.writeRecovery !== undefined;
		} catch {
			// Already false. A backup that cannot be written is not a reason to
			// abandon secrets that exist nowhere else.
		}

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
					draft.accounts[existing] = account;
				} else {
					draft.accounts.push(account);
				}
			});
		} catch {
			throw new TransferError(
				`Steam has moved the authenticator for ${account.accountName} to this app, but it ` +
					'could not be saved' +
					(recovered
						? '. A recovery file was written first, so nothing is lost. Unlock the vault and ' +
							'try again from this screen.'
						: ', and the recovery file could not be written either. Do not close this window: ' +
							`write down this recovery code now, it is the only way to detach the ` +
							`authenticator yourself — ${account.revocationCode}.`)
			);
		}

		/*
		 * Read it back before saying it worked.
		 *
		 * "The write did not throw" and "the secrets are on disk and decryptable"
		 * are different claims. Only the second one is safe to tell somebody whose
		 * phone stopped being their authenticator a moment ago.
		 */
		const stored = this.vault.read().accounts.find((a) => a.steamId64 === account.steamId64);
		if (!storedFaithfully(stored, account)) {
			throw new TransferError(
				`Steam has moved the authenticator for ${account.accountName}, but what was saved does ` +
					'not read back correctly. Nothing has been discarded — try again from this screen. ' +
					`If it keeps failing, write down this recovery code: ${account.revocationCode}.`
			);
		}

		this.unsaved = undefined;
		this.pending = undefined;

		return {
			steamId64: account.steamId64,
			accountName: account.accountName,
			revocationCode: account.revocationCode ?? '',
			timeOffsetSeconds: offsetFrom(token, this.now())
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
			: undefined;
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
		if (this.unsaved !== undefined) {
			throw new TransferError(
				'This transfer cannot be abandoned: Steam has already replaced the authenticator and ' +
					'the new one is not saved yet. Use the retry on this screen.',
				false
			);
		}
		this.pending = undefined;
		// The user's way out of an unresolved submission: they have checked their
		// phone and are telling this application to stop asking.
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
		if (this.unsaved !== undefined || this.terminal !== undefined) {
			return this.pending;
		}
		if (this.now() - this.pending.startedAtMs > PENDING_TTL_MS) {
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
