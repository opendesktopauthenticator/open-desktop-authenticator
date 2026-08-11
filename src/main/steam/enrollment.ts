import { createLoginSession, type LoginSessionFactory, type LoginSessionLike } from './login';
import {
	EnrollmentError,
	finalizeEnrollment,
	removeAuthenticator,
	startEnrollment
} from './enroll';
import { isUsableMobileToken } from '../steam-jwt';
import { mintAccessToken } from './access-token';
import { planProxy } from '../net/egress';
import type { SteamTransportFactory } from '../net/transport';
import type { VaultService } from '../vault/service';
import type { Account } from '../../shared/vault-schema';

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
	removeAuthenticator?: typeof removeAuthenticator;
	/**
	 * Writes the per-account recovery file. Injected so tests can observe it, and
	 * so this class never learns where the app's data directory is.
	 *
	 * Optional: an enrollment must not fail because a backup could not be written.
	 */
	writeRecovery?: (account: Account) => void;
}

interface PendingLogin {
	session: LoginSessionLike;
	accountName: string;
	/** Carried across the email-code pause so the enrollment finishes on the same route. */
	proxyUrl: string | undefined;
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
	private readonly detach: typeof removeAuthenticator;
	private readonly writeRecovery: ((account: Account) => void) | undefined;

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
		this.offset = options.timeOffsetSeconds ?? ((): number => 0);
		this.loginSession = options.loginSession ?? createLoginSession;
		this.start = options.startEnrollment ?? startEnrollment;
		this.finalize = options.finalizeEnrollment ?? finalizeEnrollment;
		this.detach = options.removeAuthenticator ?? removeAuthenticator;
		this.writeRecovery = options.writeRecovery;
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
		this.discardPending();

		// Validated before a password is sent anywhere. A proxy that cannot work
		// must fail while nothing has happened yet — discovering it after Steam has
		// attached an authenticator would mean the enrollment already leaked.
		const route = proxyUrl !== undefined && proxyUrl.trim() !== '' ? proxyUrl.trim() : undefined;
		if (route !== undefined) {
			planProxy(route);
		}

		const session = this.loginSession(route);

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
				proxyUrl: route,
				startedAtMs: this.now(),
				authenticated
			};
			const outcome: BeginOutcome = { state: 'needsEmailCode' };
			if (emailCode.detail !== undefined) outcome.emailDomain = emailCode.detail;
			return outcome;
		}

		await authenticated;
		return this.enrol(session, accountName, route);
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
		return this.enrol(pending.session, pending.accountName, pending.proxyUrl);
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
		this.textedTheCode.delete(steamId64);
		return 'activated';
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
	async deactivate(steamId64: string, passphrase: string): Promise<void> {
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
		await this.vault.mutate((draft) => {
			const index = draft.accounts.findIndex((entry) => entry.steamId64 === steamId64);
			if (index >= 0) {
				draft.accounts.splice(index, 1);
			}
		});

		this.tokens.delete(steamId64);
		this.textedTheCode.delete(steamId64);
	}

	/** Drop any half-finished sign-in. Called when the vault locks. */
	forget(): void {
		this.discardPending();
		this.tokens.clear();
		this.textedTheCode.clear();
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

		// From here until the vault write completes is the only unrecoverable
		// window in the application. Nothing is awaited in between that does not
		// have to be.
		const started = await this.start(transport, {
			steamId64,
			accessToken,
			unixSeconds: this.unixSeconds()
		});

		const iso = new Date(this.now()).toISOString();
		const account: Account = {
			steamId64,
			accountName: started.accountName ?? accountName,
			sharedSecret: started.sharedSecret,
			identitySecret: started.identitySecret,
			revocationCode: started.revocationCode,
			deviceId: started.deviceId,
			refreshToken: session.refreshToken,
			...(proxyUrl !== undefined ? { proxyUrl } : {}),
			...(started.serialNumber !== undefined ? { serialNumber: started.serialNumber } : {}),
			...(started.tokenGid !== undefined ? { tokenGid: started.tokenGid } : {}),
			...(started.uri !== undefined ? { uri: started.uri } : {}),
			status: 'pendingActivation',
			autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
			addedAt: iso
		};

		/**
		 * The recovery file goes down **first**, before the vault.
		 *
		 * It used to be written afterwards, from the stored account, which read
		 * naturally and left the worst failure in the application wide open: if
		 * `mutate` threw — the vault locking mid-write, a full disk — Steam had an
		 * authenticator attached and this machine had nothing. No shared secret, no
		 * revocation code, and no way to generate a code or detach it. Only Steam
		 * Support can undo that, and the comment above this method claimed the
		 * window was survivable while nothing in it was written anywhere.
		 *
		 * Writing here costs an ordering that reads slightly oddly and buys the one
		 * guarantee worth having: by the time anything can fail, the secrets exist
		 * on disk in a file the user can import back.
		 */
		let recovered = false;
		if (this.writeRecovery) {
			try {
				this.writeRecovery(account);
				recovered = true;
			} catch {
				// Swallowed, as before: a recovery file that cannot be written is not a
				// reason to fail an enrollment Steam has already accepted. The vault
				// write below is still the one that matters.
			}
		}

		try {
			await this.vault.mutate((draft) => {
				draft.accounts.push(account);
			});
		} catch {
			// Never a bare rethrow. Whatever went wrong, Steam's side of this is
			// already done, and a generic failure message would send the user round
			// again against an account that now has an authenticator they cannot use.
			//
			// **The underlying error is deliberately not included.** Node embeds the
			// absolute path in every filesystem failure, so forwarding it would put
			// the user's home directory into the renderer — the same leak the import
			// path already had to fix once.
			//
			// The revocation code *is* included, but only on the branch where the
			// recovery file could not be written either. At that point it is the last
			// copy in existence and the alternative is an account only Steam Support
			// can recover; the ceremony would have shown it on screen a moment later
			// anyway, and the activity log is in memory, so nothing of it reaches
			// disk.
			throw new EnrollmentError(
				`Steam attached the authenticator to ${account.accountName}, but it could not be saved ` +
					(recovered
						? 'to the vault. A recovery file was written first, so nothing is lost — unlock the ' +
							'vault and use Recover from file to finish. Do not remove the authenticator on ' +
							'Steam before you do.'
						: 'here, and the recovery file could not be written either. Write this down now, ' +
							'before you close this window — it is the only way to detach the authenticator ' +
							`yourself: revocation code ${account.revocationCode ?? '(not issued)'}.`)
			);
		}

		this.tokens.set(steamId64, accessToken);
		this.textedTheCode.set(steamId64, started.phoneNumberHint !== undefined);

		const outcome: BeginOutcome = {
			state: 'enrolled',
			steamId64,
			accountName: started.accountName ?? accountName
		};
		if (started.phoneNumberHint !== undefined) outcome.phoneNumberHint = started.phoneNumberHint;
		return outcome;
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
			throw new EnrollmentError(
				'This account has no saved session, so this cannot be done from here. The ' +
					'authenticator is attached on Steam — use the revocation code you wrote down to ' +
					'remove it there.'
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
