import { createLoginSession, type LoginSessionFactory, type LoginSessionLike } from './login';
import { EnrollmentError, finalizeEnrollment, startEnrollment } from './enroll';
import { isUsableMobileToken } from '../steam-jwt';
import type { SteamTransportFactory } from '../net/transport';
import type { VaultService } from '../vault/service';

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

export type BeginOutcome =
	/** Steam emailed a code. Call `submitEmailCode` with it. */
	| { state: 'needsEmailCode'; emailDomain?: string }
	/** Enrolled and stored. The revocation code must be backed up before activating. */
	| { state: 'enrolled'; steamId64: string; accountName: string; phoneNumberHint?: string };

export interface EnrollmentServiceOptions {
	now?: () => number;
	timeOffsetSeconds?: () => number;
	loginSession?: LoginSessionFactory;
	startEnrollment?: typeof startEnrollment;
	finalizeEnrollment?: typeof finalizeEnrollment;
}

interface PendingLogin {
	session: LoginSessionLike;
	accountName: string;
	startedAtMs: number;
	/** Resolves when the library reports the session authenticated. */
	authenticated: Promise<void>;
}

export class EnrollmentService {
	private readonly vault: VaultService;
	private readonly transports: SteamTransportFactory;
	private readonly now: () => number;
	private readonly offset: () => number;
	private readonly loginSession: LoginSessionFactory;
	private readonly start: typeof startEnrollment;
	private readonly finalize: typeof finalizeEnrollment;

	/**
	 * One at a time, deliberately.
	 *
	 * Enrolling is a deliberate, attended act with a code arriving on a phone.
	 * Supporting several at once would mean juggling which email code belongs to
	 * which session, and getting that wrong attaches an authenticator to the
	 * wrong account.
	 */
	private pendingLogin: PendingLogin | undefined;

	/** Access tokens for accounts mid-enrollment, so activation need not sign in again. */
	private readonly tokens = new Map<string, string>();

	constructor(
		vault: VaultService,
		transports: SteamTransportFactory,
		options: EnrollmentServiceOptions = {}
	) {
		this.vault = vault;
		this.transports = transports;
		this.now = options.now ?? ((): number => Date.now());
		this.offset = options.timeOffsetSeconds ?? ((): number => 0);
		this.loginSession = options.loginSession ?? createLoginSession;
		this.start = options.startEnrollment ?? startEnrollment;
		this.finalize = options.finalizeEnrollment ?? finalizeEnrollment;
	}

	/** Sign in to an account that has no authenticator yet, then enrol it. */
	async begin(accountName: string, password: string): Promise<BeginOutcome> {
		this.discardPending();

		// Unrouted. The account is not in the vault yet, so it has no proxy — and
		// inventing one here would tie an enrollment to a route the user never
		// chose for it. Routing is set afterwards, on an account that exists.
		const session = this.loginSession(undefined);

		const authenticated = new Promise<void>((resolve, reject) => {
			session.on('authenticated', () => resolve());
			session.on('timeout', () =>
				reject(new EnrollmentError('Steam did not finish the sign-in in time.', false))
			);
			session.on('error', (err) =>
				reject(
					new EnrollmentError(
						`Steam refused the sign-in: ${err instanceof Error ? err.message : String(err)}`,
						false
					)
				)
			);
		});
		// Attached now so a rejection before anything awaits it is not an unhandled
		// rejection that takes the process down.
		authenticated.catch(() => undefined);

		let started;
		try {
			started = await session.startWithCredentials({ accountName, password, persistence: 1 });
		} catch (err) {
			this.cancel(session);
			throw new EnrollmentError(
				`Steam refused the sign-in: ${err instanceof Error ? err.message : String(err)}`,
				false
			);
		}

		if (started.actionRequired) {
			const actions = started.validActions ?? [];
			const emailCode = actions.find((action) => action.type === 2);
			if (!emailCode) {
				this.cancel(session);
				throw new EnrollmentError(
					'Steam wants this sign-in approved in a way this app cannot complete. If the account ' +
						'already has an authenticator, remove it in the Steam mobile app first.'
				);
			}

			this.pendingLogin = {
				session,
				accountName,
				startedAtMs: this.now(),
				authenticated
			};
			const outcome: BeginOutcome = { state: 'needsEmailCode' };
			if (emailCode.detail !== undefined) outcome.emailDomain = emailCode.detail;
			return outcome;
		}

		await authenticated;
		return this.enrol(session, accountName);
	}

	/** Answer the emailed Steam Guard code, then enrol. */
	async submitEmailCode(code: string): Promise<BeginOutcome> {
		const pending = this.pendingLogin;
		if (!pending || this.now() - pending.startedAtMs > PENDING_TTL_MS) {
			this.discardPending();
			throw new EnrollmentError('That sign-in expired. Start again.', false);
		}

		try {
			await pending.session.submitSteamGuardCode(code.trim());
		} catch (err) {
			// Deliberately not discarded: a mistyped code should not cost the user
			// the session and a fresh email. The same one can be tried again.
			throw new EnrollmentError(
				`Steam did not accept that code: ${err instanceof Error ? err.message : String(err)}`,
				false
			);
		}

		await pending.authenticated;
		this.pendingLogin = undefined;
		return this.enrol(pending.session, pending.accountName);
	}

	/**
	 * Activate the authenticator with the code Steam texted.
	 *
	 * Separate from `begin` because a person has to read a phone in between. The
	 * account is already in the vault by this point; failing here is recoverable
	 * and failing before it would not have been.
	 */
	async activate(steamId64: string, activationCode: string): Promise<'activated' | 'wantMore'> {
		const account = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!account) {
			throw new EnrollmentError('that account is not in this vault');
		}

		const accessToken = this.tokens.get(steamId64);
		if (!accessToken) {
			throw new EnrollmentError(
				'The sign-in for this account has expired. Remove it and enrol again — the ' +
					'authenticator on Steam is the one you already wrote the revocation code for.',
				false
			);
		}

		const transport = await this.transports.forAccount({
			steamId64,
			proxyUrl: account.proxyUrl
		});

		const outcome = await this.finalize(transport, {
			steamId64,
			accessToken,
			sharedSecret: account.sharedSecret,
			activationCode: activationCode.trim(),
			unixSeconds: this.unixSeconds()
		});

		if (outcome.state === 'wantMore') {
			return 'wantMore';
		}

		await this.vault.mutate((draft) => {
			const stored = draft.accounts.find((entry) => entry.steamId64 === steamId64);
			if (stored) {
				// Only now. Until Steam confirms, this account's authenticator is
				// attached but unproven, and `pendingActivation` is what says so.
				stored.status = stored.revocationBackedUpAt ? 'active' : 'pendingRevocationBackup';
			}
		});

		this.tokens.delete(steamId64);
		return 'activated';
	}

	/** Drop any half-finished sign-in. Called when the vault locks. */
	forget(): void {
		this.discardPending();
		this.tokens.clear();
	}

	/**
	 * The dangerous middle: Steam attaches the authenticator, we store it.
	 *
	 * Everything between the two is written to survive a crash. The vault write is
	 * awaited before this returns, so the caller cannot report success for secrets
	 * that are still only in memory.
	 */
	private async enrol(session: LoginSessionLike, accountName: string): Promise<BeginOutcome> {
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

		const transport = await this.transports.forAccount({ steamId64 });

		// From here until the vault write completes is the only unrecoverable
		// window in the application. Nothing is awaited in between that does not
		// have to be.
		const started = await this.start(transport, {
			steamId64,
			accessToken,
			unixSeconds: this.unixSeconds()
		});

		const iso = new Date(this.now()).toISOString();
		await this.vault.mutate((draft) => {
			draft.accounts.push({
				steamId64,
				accountName: started.accountName ?? accountName,
				sharedSecret: started.sharedSecret,
				identitySecret: started.identitySecret,
				revocationCode: started.revocationCode,
				deviceId: started.deviceId,
				refreshToken: session.refreshToken,
				...(started.serialNumber !== undefined ? { serialNumber: started.serialNumber } : {}),
				...(started.tokenGid !== undefined ? { tokenGid: started.tokenGid } : {}),
				...(started.uri !== undefined ? { uri: started.uri } : {}),
				status: 'pendingActivation',
				autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
				addedAt: iso
			});
		});

		this.tokens.set(steamId64, accessToken);

		const outcome: BeginOutcome = {
			state: 'enrolled',
			steamId64,
			accountName: started.accountName ?? accountName
		};
		if (started.phoneNumberHint !== undefined) outcome.phoneNumberHint = started.phoneNumberHint;
		return outcome;
	}

	private unixSeconds(): number {
		return Math.floor(this.now() / 1000) + this.offset();
	}

	private cancel(session: LoginSessionLike): void {
		try {
			session.cancelLoginAttempt();
		} catch {
			// Already finished. Nothing left to stop.
		}
	}

	private discardPending(): void {
		if (this.pendingLogin) {
			this.cancel(this.pendingLogin.session);
			this.pendingLogin = undefined;
		}
	}
}
