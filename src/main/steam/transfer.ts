import { signIn, type LoginSessionFactory } from './login';
import { redactCredentials } from '../net/egress';
import { mintAccessToken } from './access-token';
import { startTransferChallenge, type StartChallengeResult } from './transfer-api';
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
	mintAccessToken?: typeof mintAccessToken;
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

	/** At most one transfer at a time. A second would race the first over storage. */
	private pending: PendingTransfer | undefined;

	/** Guards against a double-clicked button starting two sign-ins. */
	private authenticating = false;

	/** The same guard for the challenge, where a double press costs a text message. */
	private challenging = false;

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
