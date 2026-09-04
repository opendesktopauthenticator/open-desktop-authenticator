import { generateGuardCode } from '../codes/totp';
import { redactCredentials, steamSessionProxy } from '../net/egress';
import { ProxyConnectionError } from '../net/bounded-https-proxy-agent';
import { jwtAudience, jwtExpiry } from '../steam-jwt';
import type { ApiRequest, ApiResponse, ITransport } from 'steam-session';
import {
	SYSTEM_PROXY_AUTH_REQUIRED,
	type SystemLoginTransportFactory
} from './system-login-transport';

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
 * not shipped). Explicit account proxies stay on its proven Node agent path.
 * Accounts without one receive the application's system-aware Electron
 * transport, because a plain Node agent cannot follow Windows/PAC settings.
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
	/**
	 * base64 or hex, from the vault — used to answer the Guard challenge.
	 *
	 * Absent for an account this app does not hold yet. Transferring an
	 * authenticator away from the Steam mobile app has to sign in *before* the
	 * secret exists here, so that flow supplies `steamGuardCode` instead: the
	 * five characters the user reads off the phone that still holds it.
	 */
	sharedSecret?: string;
	/**
	 * A Guard code typed by the user, for when there is no secret to derive one
	 * from. Exactly one of this and `sharedSecret` must be given.
	 */
	steamGuardCode?: string;
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
	}): Promise<{
		actionRequired: boolean;
		/** `detail` carries the email domain for an EmailCode challenge. */
		validActions?: { type: number; detail?: string }[];
	}>;
	/**
	 * Answer a Guard challenge on the session that raised it.
	 *
	 * Used by enrollment, where the account has no authenticator yet and Steam
	 * therefore asks for an emailed code. The library's own guidance is to keep
	 * the session that triggered the email alive and submit into it, rather than
	 * starting a new one — a new session sends a second email and invalidates the
	 * code the user is looking at.
	 */
	submitSteamGuardCode(code: string): Promise<void>;
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
 * The private dependency hook used to retain `steam-session`'s own transport.
 *
 * For an explicit account proxy, this is the exact transport the dependency
 * constructed around the selected agent. For the machine route, it is the
 * application-owned Electron transport supplied through the library's public
 * `ITransport` option. The same fence wraps either one, so route selection does
 * not weaken cancellation.
 *
 * This is the one private shape on which the fence depends. It is checked at
 * runtime before a credential is accepted; dependency drift therefore refuses
 * the sign-in instead of silently returning to unfenced requests.
 */
interface FencableLoginSession extends LoginSessionLike {
	_handler?: {
		_transport?: unknown;
	};
}

const LOGIN_CANCELLED = 'The Steam sign-in was cancelled before another request could be sent.';

function cancellationError(): SteamLoginError {
	return new SteamLoginError(LOGIN_CANCELLED, false);
}

/**
 * A synchronous ownership fence around the library's already-configured
 * transport.
 *
 * It cannot recall the one request already on the wire. It does stop a late
 * answer from advancing the login state, and it refuses every request the
 * library tries to begin afterwards. Both checks matter: the original defect
 * was an RSA-key request resolving after cancellation and immediately starting
 * a password-bearing BeginAuthSession request.
 */
class CancellationFencedTransport implements ITransport {
	private cancelled = false;

	constructor(readonly delegate: ITransport) {}

	cancel(): void {
		this.cancelled = true;
		// AuthenticationClient delays transport cleanup for two seconds. A vault
		// lock or policy change cannot wait for that timer: the system transport
		// owns a live Electron request and close() is its synchronous abort seam.
		this.delegate.close();
	}

	async sendRequest(request: ApiRequest): Promise<ApiResponse> {
		if (this.cancelled) {
			throw cancellationError();
		}
		const response = await this.delegate.sendRequest(request);
		if (this.cancelled) {
			throw cancellationError();
		}
		return response;
	}

	close(): void {
		// Cleanup is still the dependency's job. In particular, a future transport
		// may own a socket even though today's MobileApp WebAPI transport does not.
		this.delegate.close();
	}
}

/** Install the cancellation fence before the session can start a request. */
export function fenceLoginCancellation(session: LoginSessionLike): LoginSessionLike {
	const candidate = session as FencableLoginSession;
	const handler = candidate._handler;
	const transport = handler?._transport;
	if (
		handler === undefined ||
		transport === undefined ||
		typeof (transport as Partial<ITransport>).sendRequest !== 'function' ||
		typeof (transport as Partial<ITransport>).close !== 'function'
	) {
		try {
			session.cancelLoginAttempt();
		} catch {
			// No request has started. Refusal below is the fail-closed outcome.
		}
		throw new SteamLoginError(
			'The installed Steam sign-in library cannot be cancelled safely. Refusing to sign in; update the app before trying again.'
		);
	}

	const fence = new CancellationFencedTransport(transport as ITransport);
	try {
		handler._transport = fence;
		if (handler._transport !== fence) {
			throw new Error('the Steam transport hook is not writable');
		}
	} catch {
		try {
			session.cancelLoginAttempt();
		} catch {
			// No request has started. Refusal below is the fail-closed outcome.
		}
		throw new SteamLoginError(
			'The installed Steam sign-in library cannot be cancelled safely. Refusing to sign in; update the app before trying again.'
		);
	}

	const cancel = session.cancelLoginAttempt.bind(session);
	session.cancelLoginAttempt = (): void => {
		// First, synchronously. The dependency's own cleanup is delayed and cannot
		// be the boundary that decides whether another request is allowed to start.
		fence.cancel();
		cancel();
	};
	return session;
}

/**
 * Build a real `LoginSession`: explicit account proxy, or injected system route.
 *
 * Imported lazily so that requiring this module does not drag protobuf parsing
 * and a websocket stack into every test that only wants the error mapping.
 */
export function createLoginSession(
	proxyUrl: string | undefined,
	systemTransport?: SystemLoginTransportFactory
): LoginSessionLike {
	/* eslint-disable @typescript-eslint/no-require-imports -- lazy by design, see above */
	const { LoginSession, EAuthTokenPlatformType } =
		require('steam-session') as typeof import('steam-session');
	/* eslint-enable @typescript-eslint/no-require-imports */

	// Fails closed. `steamSessionProxy` throws for anything unroutable, and an
	// account configured to route must never sign in over the machine's own
	// address — that is the one request that ties the account to the user.
	const routed = proxyUrl !== undefined && proxyUrl !== '';
	let options;
	if (routed) {
		options = steamSessionProxy(proxyUrl);
	} else {
		if (systemTransport === undefined) {
			throw new SteamLoginError(
				"the machine's system proxy route is unavailable. Refusing to sign in rather than using a direct Node connection."
			);
		}
		options = { transport: systemTransport() };
	}

	// Checked rather than assumed, because `steam-session` **silently ignores an
	// option key it does not recognise** and connects direct. There is no
	// equivalent of Chromium's `resolveProxy` to ask afterwards, so this is the
	// only moment the mistake is catchable — and its failure mode is the account
	// signing in from the user's real address with nothing on screen to say so.
	if (routed && !('agent' in options) && !('socksProxy' in options)) {
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
	return fenceLoginCancellation(new LoginSession(EAuthTokenPlatformType.MobileApp, options));
}

/** Bind application-owned system routing once, then inject the resulting seam. */
export function createSystemAwareLoginSessionFactory(
	systemTransport: SystemLoginTransportFactory
): LoginSessionFactory {
	return (proxyUrl) => createLoginSession(proxyUrl, systemTransport);
}

/**
 * Exchange a password for a MobileApp refresh token.
 *
 * @throws SteamLoginError — `permanent: false` only when retrying could help.
 */
/**
 * Why a sign-in was stopped when the proxy policy forbade it.
 *
 * Exported so the two callers that cancel for this reason say the same thing —
 * a password path is a bad place for two sentences describing one cause.
 */
/**
 * Why a sign-in was stopped when the vault locked under it.
 *
 * Shared for the same reason as `PROXY_POLICY_STOPPED`: enrolment cancels its
 * session directly rather than through the callback below, so without a name
 * to reach for it reported "Steam refused the sign-in" — blaming Steam for a
 * lock this application performed.
 */
export const VAULT_LOCKED_DURING_SIGN_IN = 'The vault locked before Steam finished signing in.';

export const PROXY_POLICY_STOPPED =
	'This vault is set to require proxies, so the sign-in was stopped. Give the account a ' +
	'proxy, or turn off "Require proxies" in Settings.';

export async function signIn(
	request: SignInRequest,
	proxyUrl: string | undefined,
	factory: LoginSessionFactory = createLoginSession,
	now: () => number = () => Date.now(),
	/**
	 * Handed a way to abandon this attempt while it is still running.
	 *
	 * **Every failure path already cancels; nothing outside could.** A sign-in
	 * takes as long as Steam takes, up to the ninety-second timeout, and the
	 * vault can lock in the middle of it — by the idle timer, by the lid, by the
	 * user. `ConfirmationsService.forget` bumps its generation so the token that
	 * eventually arrives is refused, which is the important half; but the
	 * authentication polling kept running against Steam over the account's proxy,
	 * and the closure holding the user's password stayed alive with it, for up to
	 * a minute and a half after the user had said "stop".
	 *
	 * Refusing the result is not the same as stopping the work. This is the
	 * other half.
	 */
	onAttempt?: (cancel: (reason?: string) => void) => void
): Promise<SignInResult> {
	/*
	 * Derived from the secret when this app holds it, typed by the user when it
	 * does not.
	 *
	 * Derivation stays the default because it is the case that must not depend on
	 * a human reading a rolling code correctly, and because generating it here
	 * rather than leaving it to the library keeps the only clock involved the
	 * Steam-corrected one the codes already use (D13).
	 *
	 * Supplying the code up front matters more than it looks: Steam then completes
	 * the sign-in outright instead of answering `actionRequired`, which is the
	 * branch that refuses every guard type this app cannot drive.
	 */
	const steamGuardCode = request.sharedSecret
		? generateGuardCode(request.sharedSecret, request.unixSeconds)
		: (request.steamGuardCode ?? '');
	if (!steamGuardCode) {
		throw new SteamLoginError(
			'Signing in needs either a stored authenticator secret or a Steam Guard code.'
		);
	}

	/*
	 * The factory owns a system-session lease when there is no explicit proxy.
	 * Keep every throwing input precondition above this line: a refusal before a
	 * LoginSession exists has nothing it can cancel, so acquiring first leaves the
	 * shared Electron owner permanently believing an attempt is still alive.
	 */
	const session = factory(proxyUrl);

	return new Promise<SignInResult>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (run: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
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

		/*
		 * Handed out before the attempt starts, so a lock arriving between the
		 * first packet and the last always finds something to cancel — and after
		 * `timer` exists, because `fail` clears it.
		 *
		 * Routed through `fail` rather than calling the library directly:
		 * cancelling without settling would leave the caller awaiting a promise
		 * nothing will ever resolve.
		 */
		/*
		 * **The caller says why, because there is now more than one why.**
		 *
		 * This read "The vault locked before Steam finished signing in" and was
		 * the only sentence a cancellation could produce. `Require proxies` now
		 * cancels unrouted sign-ins through the same callback, and told the user
		 * their vault had locked — which had not happened, and sends them to
		 * unlock a vault that is already open. The default is still the lock,
		 * because that is still the common case.
		 */
		try {
			timer = setTimeout(
				() =>
					fail(new SteamLoginError('Steam did not finish the sign-in in time. Try again.', false)),
				SIGN_IN_TIMEOUT_MS
			);
			timer.unref?.();

			onAttempt?.((reason) =>
				fail(new SteamLoginError(reason ?? VAULT_LOCKED_DURING_SIGN_IN, false))
			);
			// A registration callback is allowed to cancel immediately. The fence
			// would stop the network request, but not starting it at all also avoids
			// handing a password to a session whose answer is already unwanted.
			if (settled) return;

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
		} catch (err) {
			// Dependency drift or a throwing registration callback is still a failed
			// attempt. Cancel it through the same one-settlement boundary immediately;
			// otherwise its system-session lease survives until process exit.
			fail(new SteamLoginError(describeLibraryError(err), false));
		}
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
	/*
	 * A proxy controls its CONNECT reason phrase. Classify that transport
	 * boundary before looking for Steam result names: a 407 phrase such as
	 * "InvalidPassword" describes the proxy's answer, not Steam's verdict on the
	 * account password. `describeProxyLoginError` retains only local wording and
	 * the numeric status.
	 */
	const proxy = describeProxyLoginError(err);
	if (proxy !== undefined) return proxy;

	if (/InvalidPassword|InvalidCredentials/i.test(message)) {
		return 'Steam did not accept that username and password.';
	}
	if (/RateLimitExceeded|TooManyAttempts/i.test(message)) {
		return 'Steam is rate-limiting sign-ins from this address. Wait a few minutes and try again.';
	}
	// Redacted, because this is the branch that forwards whatever the library
	// said — and what it says routinely includes the URL it failed on, proxy
	// credentials and all.
	return `Steam refused the sign-in: ${redactCredentials(message)}`;
}

/** A failure produced before the proxy has opened a route to Steam. */
export function describeProxyLoginError(err: unknown): string | undefined {
	const message = err instanceof Error ? err.message : String(err);
	if (message === SYSTEM_PROXY_AUTH_REQUIRED) return message;
	if (
		/Proxy connection timed out/i.test(message) ||
		/A "socket" was not created for HTTP request before \d+ms/i.test(message)
	) {
		return 'The proxy did not finish opening a connection to Steam in time. Try again.';
	}

	const proxyConnect = /\bProxy CONNECT (\d{3})(?: ([^\r\n]*))?/i.exec(message);
	if (proxyConnect !== null) {
		/*
		 * The status text is supplied by the proxy, not by Node or this app. A
		 * proxy has already received its configured credentials and can echo them
		 * in that phrase; including it here put the password straight into the
		 * renderer-visible error while bypassing `redactCredentials`. The numeric
		 * status is enough to distinguish the actionable 407 case and contains no
		 * remote-controlled prose.
		 */
		const status = `CONNECT ${proxyConnect[1]}`;
		return proxyConnect[1] === '407'
			? `The proxy requires a username and password, or did not accept the ones configured (${status}).`
			: `The proxy refused to open a connection to Steam (${status}).`;
	}
	if (
		/Proxy CONNECT (?:failed|response headers exceeded)/i.test(message) ||
		/Proxy connection ended before receiving CONNECT response/i.test(message) ||
		/Invalid (?:response from proxy CONNECT request|header in proxy CONNECT response)/i.test(
			message
		)
	) {
		return 'The proxy closed the connection or sent an invalid response while opening a route to Steam.';
	}
	if (err instanceof ProxyConnectionError || /SOCKS proxy handshake failed:/i.test(message)) {
		return 'The SOCKS proxy rejected or could not finish opening a connection to Steam.';
	}
	return undefined;
}
