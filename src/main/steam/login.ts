import { generateGuardCode } from '../codes/totp';
import { steamSessionProxy } from '../net/egress';
import { jwtAudience, jwtExpiry } from '../steam-jwt';

/**
 * Signing in with a password, once (§12 F3).
 *
 * The point of this module is to be used **rarely**. It exchanges a password for
 * a MobileApp refresh token that lasts months; from then on `mintAccessToken`
 * produces working sessions on its own and the password is not needed again. So
 * the password is asked for, used, and dropped — never stored, never written to
 * the vault, never logged.
 *
 * ## The protocol is `steam-session`'s, not ours
 *
 * This module used to speak Steam's authentication API directly: RSA key fetch,
 * encrypted password, guard submission, poll loop. That was a silent deviation
 * from the recorded decision — PLAN_AMENDMENTS Q19 says in as many words that
 * reimplementing the login flow "would be reckless rather than careful", and
 * then it was reimplemented anyway with no amendment arguing the case.
 *
 * `steam-session` is DoctorMcKay's, it is the flow every other Steam tool uses,
 * and it carries **zero** advisories of its own (the eleven in the spike all
 * arrive through `steamcommunity` → `request`, which is why that one is still
 * not shipped). It also removes a class of bug we had already hit once: it
 * authenticates to proxies itself, over Node's HTTP stack, rather than through
 * an Electron mechanism we had to wire by hand.
 *
 * ## What is still ours, and why
 *
 * - **The Guard code.** D13 stands: `generateGuardCode` is twenty auditable
 *   lines checked against `steam-totp` on every push. It is handed to the
 *   library rather than the library being asked to fetch it, which also keeps
 *   code generation offline.
 * - **The audience check.** `steam-session` asks for `MobileApp` and should
 *   return a mobile-scoped token. We verify it anyway. F-13 is the failure that
 *   looks like success — a web-scoped token signs in perfectly and then cannot
 *   drive a single confirmation — and the check costs one base64 decode.
 * - **The refusals.** A library returns "action required"; a person needs to be
 *   told that their account is set up in a way this app cannot complete, and
 *   why.
 */

/**
 * `EAuthTokenPlatformType.MobileApp`.
 *
 * Load-bearing, not cosmetic. A token issued to any other platform cannot drive
 * mobile confirmations — it looks valid and fails at the only thing we need it
 * for (F-13). The library's own enum agrees this is 3, and its documentation
 * records that MobileApp yields the `['web', 'mobile']` audiences.
 */
export const PLATFORM_MOBILE_APP = 3;

/** `EAuthSessionGuardType`, matching the library's enum of the same name. */
const GUARD = {
	none: 1,
	emailCode: 2,
	/** The TOTP from the shared secret — the one we can answer ourselves. */
	deviceCode: 3,
	/** "Approve on your phone." We are replacing the phone, so we cannot. */
	deviceConfirmation: 4,
	emailConfirmation: 5
} as const;

/** `ESessionPersistence.Persistent` — we want a long-lived refresh token. */
const PERSISTENT = 1;

/** How long to wait before giving up. Backstops the library's own timeout. */
const SIGN_IN_TIMEOUT_MS = 90_000;

export class SteamLoginError extends Error {
	/** True when trying again with the same details cannot possibly work. */
	readonly permanent: boolean;

	constructor(message: string, permanent = true) {
		super(message);
		this.name = 'SteamLoginError';
		this.permanent = permanent;
	}
}

export interface SignInRequest {
	accountName: string;
	/** Used once, in this call, and never retained. */
	password: string;
	/** base64 or hex, from the vault — used to answer the Guard challenge. */
	sharedSecret: string;
	/** Steam-corrected seconds, the same clock the codes use. */
	unixSeconds: number;
}

export interface SignInResult {
	/** MobileApp-scoped, long-lived. This is the thing worth keeping. */
	refreshToken: string;
	/** Short-lived. Handed back so the first request after signing in is free. */
	accessToken?: string;
	steamId64?: string;
}

/**
 * The slice of `steam-session`'s `LoginSession` this module uses.
 *
 * Declared structurally so the sign-in logic can be tested without a network,
 * and kept to exactly what is called. **Every member here was checked against
 * the library's own `.d.ts`** — an interface that claims capabilities the real
 * object lacks is precisely how proxy authentication shipped broken once
 * already, and a hand-written shim is where that mistake lives.
 */
export interface LoginSessionLike {
	startWithCredentials(details: {
		accountName: string;
		password: string;
		persistence?: number;
		steamGuardCode?: string;
	}): Promise<{ actionRequired: boolean; validActions?: { type: number }[] }>;
	on(event: 'authenticated', listener: () => void): void;
	on(event: 'timeout', listener: () => void): void;
	on(event: 'error', listener: (err: unknown) => void): void;
	/** Stops the library's internal polling. Called on every failure path. */
	cancelLoginAttempt(): void;
	readonly refreshToken: string;
	readonly accessToken: string;
	readonly steamID?: { getSteamID64(): string } | undefined;
}

export type LoginSessionFactory = (proxyUrl: string | undefined) => LoginSessionLike;

/**
 * Build a real `LoginSession`, routed through the account's proxy if it has one.
 *
 * Imported lazily so that requiring this module does not drag protobuf parsing
 * and a websocket stack into every test that only wants the error mapping.
 */
export const createLoginSession: LoginSessionFactory = (proxyUrl) => {
	/* eslint-disable @typescript-eslint/no-require-imports -- lazy by design, see above */
	const { LoginSession, EAuthTokenPlatformType } =
		require('steam-session') as typeof import('steam-session');
	/* eslint-enable @typescript-eslint/no-require-imports */

	// Fails closed. `steamSessionProxy` throws for anything unroutable, and an
	// account configured to route must never sign in over the machine's own
	// address — that is the one request that ties the account to the user.
	const routed = proxyUrl !== undefined && proxyUrl !== '';
	const options = routed ? steamSessionProxy(proxyUrl) : {};

	// Checked rather than assumed, because `steam-session` **silently ignores an
	// option key it does not recognise** and connects direct. There is no
	// equivalent of Chromium's `resolveProxy` to ask afterwards, so this is the
	// only moment the mistake is catchable — and its failure mode is the account
	// signing in from the user's real address with nothing on screen to say so.
	if (routed && !('httpProxy' in options) && !('socksProxy' in options)) {
		throw new SteamLoginError(
			'this account is set to route through a proxy, but the routing could not be applied to ' +
				'the sign-in. Refusing to continue rather than signing in from this machine’s own address.'
		);
	}

	// **No cast.** The real `LoginSession` satisfies `LoginSessionLike`
	// structurally, so the compiler checks that the interface above describes the
	// library rather than being told to accept it. If a future version needs a
	// cast here, that is the signal the shim has drifted from `steam-session` —
	// which is exactly the drift that broke proxy authentication once already.
	return new LoginSession(EAuthTokenPlatformType.MobileApp, options);
};

/**
 * Exchange a password for a MobileApp refresh token.
 *
 * @throws SteamLoginError — `permanent: false` only when retrying could help.
 */
export async function signIn(
	request: SignInRequest,
	proxyUrl: string | undefined,
	factory: LoginSessionFactory = createLoginSession,
	now: () => number = () => Date.now()
): Promise<SignInResult> {
	const session = factory(proxyUrl);

	// Generated here rather than left to the library, so the only clock involved
	// is the Steam-corrected one the codes already use (D13).
	const steamGuardCode = generateGuardCode(request.sharedSecret, request.unixSeconds);

	return new Promise<SignInResult>((resolve, reject) => {
		let settled = false;
		const finish = (run: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			run();
		};

		/**
		 * Every failure path cancels.
		 *
		 * `startWithCredentials` leaves a polling loop running inside the library.
		 * Rejecting without cancelling would keep an authentication attempt alive
		 * against Steam — over the account's proxy — after the user has been told
		 * the sign-in failed.
		 */
		const fail = (error: SteamLoginError): void =>
			finish(() => {
				try {
					session.cancelLoginAttempt();
				} catch {
					// Already finished or never started. Nothing to stop.
				}
				reject(error);
			});

		const timer = setTimeout(
			() =>
				fail(new SteamLoginError('Steam did not finish the sign-in in time. Try again.', false)),
			SIGN_IN_TIMEOUT_MS
		);
		timer.unref?.();

		session.on('timeout', () =>
			fail(new SteamLoginError('Steam did not finish the sign-in in time. Try again.', false))
		);

		session.on('error', (err) =>
			// Retryable: an `error` here is a transport or Steam-side failure, not a
			// rejected credential — those arrive as a refused start.
			fail(new SteamLoginError(describeLibraryError(err), false))
		);

		session.on('authenticated', () =>
			finish(() => {
				try {
					resolve(collectTokens(session, now));
				} catch (err) {
					// `collectTokens` throws only `SteamLoginError`. Normalised anyway so
					// the rejection is an Error whatever future edits do to it.
					reject(err instanceof Error ? err : new SteamLoginError(String(err)));
				}
			})
		);

		session
			.startWithCredentials({
				accountName: request.accountName,
				password: request.password,
				persistence: PERSISTENT,
				steamGuardCode
			})
			.then((started) => {
				if (started.actionRequired) {
					fail(refusalFor(started.validActions ?? []));
				}
				// Otherwise `authenticated` is coming; nothing to do but wait.
			})
			.catch((err: unknown) => fail(new SteamLoginError(describeLibraryError(err), false)));
	});
}

/**
 * Read the tokens off a session that has authenticated, checking them first.
 *
 * The library asked for `MobileApp`, so this should always pass. It is checked
 * because the failure it catches is invisible: a web-scoped token signs in,
 * stores fine, and then cannot approve a single confirmation — which reads as
 * the app being broken rather than the sign-in having been wrong.
 */
function collectTokens(session: LoginSessionLike, now: () => number): SignInResult {
	const refreshToken = session.refreshToken;
	if (!refreshToken) {
		throw new SteamLoginError('Steam completed the sign-in without issuing a session.');
	}

	if (!jwtAudience(refreshToken).includes('mobile')) {
		throw new SteamLoginError(
			'Steam issued a session that cannot approve confirmations. This is a bug in this app, ' +
				'not something you did.'
		);
	}
	if ((jwtExpiry(refreshToken)?.getTime() ?? 0) <= now()) {
		throw new SteamLoginError('Steam issued a session that has already expired.');
	}

	const result: SignInResult = { refreshToken };

	const accessToken = session.accessToken;
	if (accessToken) result.accessToken = accessToken;

	// Read through the library's own accessor: a SteamID64 exceeds
	// `Number.MAX_SAFE_INTEGER`, so it must stay a string end to end (F-01).
	const steamId64 = session.steamID?.getSteamID64();
	if (steamId64) result.steamId64 = steamId64;

	return result;
}

/**
 * Explain a Guard challenge this app cannot answer.
 *
 * We supplied a device code up front, so reaching here means Steam wants
 * something else. Each of these is a real account configuration, and a user in
 * one of them needs to be told which rather than watching a spinner — an
 * "action required" with no explanation is the failure mode this replaces.
 */
function refusalFor(actions: { type: number }[]): SteamLoginError {
	const types = actions.map((action) => action.type);

	if (types.includes(GUARD.deviceConfirmation) || types.includes(GUARD.emailConfirmation)) {
		return new SteamLoginError(
			'Steam wants this sign-in approved on the device that currently holds the authenticator. ' +
				'Approve it there, or move the authenticator to this app first.'
		);
	}
	if (types.includes(GUARD.emailCode)) {
		return new SteamLoginError(
			'This account is protected by an emailed code rather than an authenticator, so this ' +
				'app cannot complete the sign-in.'
		);
	}
	if (types.includes(GUARD.deviceCode)) {
		// We sent one and it was not accepted. A clock far enough out is by far the
		// most common cause — the code was already stale when it arrived.
		return new SteamLoginError(
			'Steam rejected the Steam Guard code. If this machine’s clock is wrong, that is why.'
		);
	}
	if (types.length === 0 || types.includes(GUARD.none)) {
		return new SteamLoginError('Steam asked for a confirmation this version does not understand.');
	}
	return new SteamLoginError('Steam asked for a confirmation this version does not understand.');
}

/**
 * A library error, in words a user can act on.
 *
 * `steam-session` reports Steam's own `EResult` names. The two that matter are
 * mapped; the rest are passed through, because an unfamiliar Steam error is
 * still more informative than "sign-in failed" and is what makes a pasted
 * report searchable.
 */
function describeLibraryError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);

	if (/InvalidPassword|InvalidCredentials/i.test(message)) {
		return 'Steam did not accept that username and password.';
	}
	if (/RateLimitExceeded|TooManyAttempts/i.test(message)) {
		return 'Steam is rate-limiting sign-ins from this address. Wait a few minutes and try again.';
	}
	return `Steam refused the sign-in: ${message}`;
}
