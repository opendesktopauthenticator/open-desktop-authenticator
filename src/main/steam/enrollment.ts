import { createLoginSession, type LoginSessionFactory, type LoginSessionLike } from './login';
import {
	EnrollmentError,
	finalizeEnrollment,
	removeAuthenticator,
	startEnrollment
} from './enroll';
import { isUsableMobileToken } from '../steam-jwt';
import { mintAccessToken } from './access-token';
import { planProxy, redactCredentials } from '../net/egress';
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

/**
 * How long to wait for Steam to finish a sign-in.
 *
 * The same ninety seconds `login.ts` uses, and for the same reason: the
 * library's `timeout` event is not guaranteed to fire, and a promise that never
 * settles is a screen that never moves.
 */
const SIGN_IN_TIMEOUT_MS = 90_000;

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
	updateRecovery?: (account: Account) => void;
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
	private readonly updateRecovery: ((account: Account) => void) | undefined;

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

	/** Accounts with an activation in flight. See the guard in `activate`. */
	private readonly activating = new Set<string>();

	/** Accounts with a removal in flight. See the guard in `deactivate`. */
	private readonly deactivating = new Set<string>();

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
		this.updateRecovery = options.updateRecovery;
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
		if (route !== undefined) {
			planProxy(route);
		}

		const session = this.loginSession(route);
		// Registered the moment it exists, so a lock can reach it wherever the flow
		// has got to. `cancel` removes it again.
		this.liveSessions.add(session);

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
				reject(
					new EnrollmentError(
						`Steam refused the sign-in: ${redactCredentials(err instanceof Error ? err.message : String(err))}`,
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
				`Steam refused the sign-in: ${redactCredentials(err instanceof Error ? err.message : String(err))}`,
				false
			);
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
				startedAtMs: this.now(),
				authenticated
			};
			const outcome: BeginOutcome = { state: 'needsEmailCode' };
			if (emailCode.detail !== undefined) outcome.emailDomain = emailCode.detail;
			return outcome;
		}

		await authenticated;
		try {
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
				`Steam did not accept that code: ${redactCredentials(err instanceof Error ? err.message : String(err))}`,
				false
			);
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

		// One activation at a time, for the same reason `begin` allows one sign-in:
		// two `finalizeEnrollment` calls racing on one account send Steam two codes
		// for the same window, and the loser's failure is indistinguishable from a
		// wrong code.
		if (this.activating.has(steamId64)) {
			throw new EnrollmentError('that account is already being activated.');
		}
		this.activating.add(steamId64);
		try {
			return await this.finishActivation(account, steamId64, activationCode);
		} finally {
			this.activating.delete(steamId64);
		}
	}

	/** The body of `activate`, split out so the mutex above is impossible to skip. */
	private async finishActivation(
		account: Account,
		steamId64: string,
		activationCode: string
	): Promise<'activated' | 'wantMore'> {
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

		try {
			await this.vault.mutate((draft) => {
				const stored = draft.accounts.find((entry) => entry.steamId64 === steamId64);
				if (stored) {
					// Only now. Until Steam confirms, this account's authenticator is
					// attached but unproven, and `pendingActivation` is what says so.
					stored.status = stored.revocationBackedUpAt ? 'active' : 'pendingRevocationBackup';
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
					'saved. The account works — codes it generates are valid — and the app will keep ' +
					'offering to finish activation until it can write. Unlock the vault and try once ' +
					'more; if it says the account is already activated, that is the truth and nothing ' +
					'is wrong.'
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
		if (this.updateRecovery) {
			try {
				const stored = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
				if (stored) {
					this.updateRecovery(stored);
				}
			} catch {
				// Swallowed. Steam has activated and the vault agrees; a stale backup is
				// a smaller problem than reporting a failure for something that worked.
			}
		}

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
		// One at a time per account, exactly as `activate` guards itself: the
		// passphrase check below is deliberately slow, so a double-pressed confirm
		// sent `RemoveAuthenticator` twice — the second answered for an
		// authenticator already gone, and its failure surfaced as an error for an
		// operation that had in fact succeeded.
		if (this.deactivating.has(steamId64)) {
			throw new EnrollmentError('that account is already being removed.');
		}
		this.deactivating.add(steamId64);
		try {
			await this.deactivateOnce(steamId64, passphrase);
		} finally {
			this.deactivating.delete(steamId64);
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
		try {
			await this.vault.mutate((draft) => {
				const index = draft.accounts.findIndex((entry) => entry.steamId64 === steamId64);
				if (index >= 0) {
					draft.accounts.splice(index, 1);
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
					'meaningless now, and removing the account here will not change anything on Steam.'
			);
		}

		this.tokens.delete(steamId64);
		this.textedTheCode.delete(steamId64);
	}

	/** Drop any half-finished sign-in. Called when the vault locks. */
	forget(): void {
		this.discardPending();
		// Every session, not just a pending one. See `liveSessions`.
		for (const session of [...this.liveSessions]) {
			this.cancel(session);
		}
		this.tokens.clear();
		this.textedTheCode.clear();
		// An activation in flight will clear its own entry when it settles, but a
		// lock means nobody is waiting on it — and a stale marker would refuse the
		// retry after the next unlock.
		this.activating.clear();
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
			// Gated the same way the import path gates one, and for the same reason
			// (F-13): a token scoped for the Steam website cannot approve
			// confirmations, so storing one produces an account that looks signed in
			// and fails at the first confirmation with nothing to explain it. The
			// access token above is already checked; this was not, which made
			// enrollment the one door into the vault that skipped the rule.
			...(session.refreshToken !== undefined &&
			isUsableMobileToken(session.refreshToken, this.now())
				? { refreshToken: session.refreshToken }
				: {}),
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
							'vault and use Recover from file to restore it, then sign in to that account to ' +
							'finish activating. Do not remove the authenticator on Steam before you do.'
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
		try {
			session.cancelLoginAttempt();
		} catch {
			// Already finished. Nothing left to stop.
		}
	}

	/** Done with this session, successfully. Stops tracking it without cancelling. */
	private release(session: LoginSessionLike): void {
		this.liveSessions.delete(session);
	}

	private discardPending(): void {
		if (this.pendingLogin) {
			this.cancel(this.pendingLogin.session);
			this.pendingLogin = undefined;
		}
	}
}
