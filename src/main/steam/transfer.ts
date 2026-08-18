import { signIn, type LoginSessionFactory } from './login';
import { redactCredentials } from '../net/egress';
import { mintAccessToken } from './access-token';
import {
	continueTransfer,
	startTransferChallenge,
	type StartChallengeResult
} from './transfer-api';
import { decodeContinueResponse, type ReplacementToken } from './transfer-proto';
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
	refreshToken: string;
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

	/** Guards against a double-clicked button starting two sign-ins. */
	private authenticating = false;

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

	/**
	 * Steam's reply, exactly as it arrived, kept until it is safely stored.
	 *
	 * Decoding is the one step between Steam rotating an authenticator and this
	 * application holding anything at all, and a parse failure there would
	 * otherwise destroy the only copy of secrets that are issued once. Held so
	 * that `retryDecode` can have another go — at a bug, a schema surprise, or
	 * anything else that made the first attempt throw.
	 *
	 * Memory only. It is raw secret material and never touches disk unsealed.
	 */
	private rawReply: Buffer | undefined;

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
		if (this.challenging) {
			throw new TransferError('Steam has already been asked for a code.', false);
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
				pending.refreshToken,
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
				pending.refreshToken,
				this.now()
			);

			/*
			 * From here until the vault is written, a failure is expensive.
			 *
			 * `continueTransfer` throws rather than returning failure when it cannot
			 * read the reply, because Steam may have rotated the authenticator
			 * anyway. That is surfaced as an uncertain outcome, not a failed one.
			 */
			const result = await this.performContinue(transport, accessToken, code, (body) => {
				this.rawReply = body;
			}).catch(() => {
				/*
				 * The dangerous branch.
				 *
				 * Steam answered — the request was not refused — but the reply could
				 * not be understood. The authenticator has very likely been replaced
				 * already, and what replaced it is sitting in `rawReply` and nowhere
				 * else. Saying "it failed" here would be false and would invite the
				 * user to close the window.
				 */
				throw new TransferError(
					'Steam answered but the reply could not be read. Your authenticator has probably ' +
						'been replaced already, and the details are still held here — do not close this ' +
						'window. Use Try again to store them.',
					false
				);
			});
			if (!result.success) {
				throw new TransferError(
					'Steam did not accept that code. Nothing has changed — check the code and try again.',
					false
				);
			}

			validateReplacement(result.replacementToken, pending.steamId64);
			const account = accountFromReplacement(
				result.replacementToken,
				pending.accountName,
				pending.proxyUrl,
				new Date(this.now()).toISOString()
			);
			this.unsaved = { account, token: result.replacementToken };

			return await this.persist();
		} finally {
			this.submitting = false;
		}
	}

	/**
	 * Have another go at reading a reply that could not be decoded.
	 *
	 * Separate from `retryPersist` because the failure is at a different stage:
	 * nothing has been understood yet, so there is no account to store. Steam is
	 * not contacted — the bytes are the ones it already sent.
	 */
	async retryDecode(): Promise<TransferComplete> {
		const body = this.rawReply;
		const pending = this.pending;
		if (!body || !pending) {
			throw new TransferError('There is no unread reply from Steam to retry.', false);
		}

		const result = decodeContinueResponse(body);
		if (!result.success) {
			throw new TransferError("Steam's reply says the transfer did not complete.", false);
		}
		validateReplacement(result.replacementToken, pending.steamId64);
		this.unsaved = {
			account: accountFromReplacement(
				result.replacementToken,
				pending.accountName,
				pending.proxyUrl,
				new Date(this.now()).toISOString()
			),
			token: result.replacementToken
		};
		return this.persist();
	}

	/** True when a reply arrived that could not be decoded. */
	hasUnreadReply(): boolean {
		return this.rawReply !== undefined && this.unsaved === undefined;
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
				draft.accounts.push(account);
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
		this.rawReply = undefined;
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
		return pending ? { steamId64: pending.steamId64, accountName: pending.accountName } : undefined;
	}

	/** Abandon a transfer that has not yet asked Steam to change anything. */
	cancel(): void {
		this.pending = undefined;
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
