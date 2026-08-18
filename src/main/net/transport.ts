import {
	BROWSER_ONLY_HEADERS,
	describeNetworkError,
	describesDirectRoute,
	EgressError,
	redactCredentials,
	isSteamEndpoint,
	planProxy,
	STEAM_MOBILE_CLIENT_COOKIE,
	STEAM_USER_AGENT,
	type ProxyPlan
} from './egress';
import type { SteamRequest, SteamResponse, SteamTransport } from '../confirmations/client';

/**
 * The one place this application opens a connection to Valve (§10.1).
 *
 * Built on Electron's own network stack rather than a proxy-agent dependency,
 * because Chromium already proxies HTTP, HTTPS and SOCKS5 per session — and,
 * measured, **fails closed** when the proxy is unreachable rather than quietly
 * going direct (see `egress.ts`).
 *
 * ## One session per account
 *
 * Each account gets its own Electron session partition, which gives it its own
 * proxy *and* its own cookie jar. Two consequences, both deliberate:
 *
 *  - **Accounts cannot bleed into each other.** F-08 found that process-global
 *    agent injection does not survive concurrent pollers; per-session routing is
 *    not a discipline anyone has to maintain, it is a property of the object.
 *  - **Sessions are in-memory.** The partition name has no `persist:` prefix, so
 *    Steam cookies — which are credentials — never reach disk. They die with the
 *    process, like everything else the vault holds.
 *
 * Electron is injected rather than imported so all of this is testable without
 * launching an app.
 */

/** The slice of Electron this module needs. Injected so tests can supply fakes. */
export interface ElectronNetworking {
	sessionFromPartition(partition: string, options?: { cache: boolean }): ProxyCapableSession;
	request(options: {
		url: string;
		method: string;
		session: ProxyCapableSession;
		/**
		 * Redirect policy. **Always `'error'` for Steam traffic.**
		 *
		 * `isSteamEndpoint` is checked against the URL we are about to request, and
		 * Electron's default is to follow redirects — so a `302` from Valve's
		 * infrastructure, or from anything able to answer in its place, would carry
		 * the `steamLoginSecure` cookie to whatever host the `Location` header
		 * names. The allowlist would never see that hop.
		 *
		 * mobileconf does not redirect in normal operation, so failing on one costs
		 * nothing and closes a session-exfiltration path that no other check covers.
		 */
		redirect?: 'follow' | 'error' | 'manual';
	}): NetRequestHandle;
}

/** Chromium's proxy modes, spelled as Electron declares them. */
export type ProxyMode = 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers' | 'system';

export interface ProxyCapableSession {
	setProxy(config: { mode: ProxyMode; proxyRules?: string }): Promise<void>;
	setUserAgent?(userAgent: string): void;
	/**
	 * What Chromium will actually do with a URL: `DIRECT`, or `SOCKS5 host:port`.
	 *
	 * A local lookup with no network cost, which is what makes it affordable
	 * before every request rather than once at construction.
	 */
	resolveProxy(url: string): Promise<string>;
	/**
	 * Chromium's own headers, before they go out.
	 *
	 * Optional because a fake need not implement it — but the real Session does,
	 * and it is the only place browser-only headers can be removed. Setting a
	 * User-Agent does not stop Electron adding client hints and fetch metadata
	 * beside it, and those beside an `okhttp` User-Agent are a contradiction no
	 * genuine client produces.
	 */
	webRequest?: {
		onBeforeSendHeaders(
			listener: (
				details: { requestHeaders: Record<string, string> },
				callback: (response: { requestHeaders: Record<string, string> }) => void
			) => void
		): void;
	};
	/**
	 * Empties this session's cookie jar and everything else it accumulated.
	 *
	 * Load-bearing, not housekeeping. Steam sets cookies on its responses and
	 * Chromium stores them here; dropping our reference to the session does not
	 * remove them, because `fromPartition` hands back the *same* session next time
	 * it is asked. Without this, a Steam web session outlives the vault lock that
	 * was supposed to end it.
	 */
	clearStorageData?(): Promise<void>;

	// Deliberately no `login` event. Electron's `Session` does not emit one —
	// only `App`, `ClientRequest`, `UtilityProcess` and `WebContents` do. An
	// earlier version of this interface declared one, the adapter's
	// `as unknown as ProxyCapableSession` cast waved it through, and the test fake
	// implemented it. So proxy credentials were handed to an event that never
	// fired: every authenticating proxy failed its CONNECT with a 407, surfacing
	// as `ERR_TUNNEL_CONNECTION_FAILED` while looking exactly like wrong
	// credentials. Leaving it off means a listener cannot be registered here again
	// without the compiler objecting.
}

export interface NetRequestHandle {
	setHeader(name: string, value: string): void;
	write(chunk: string): void;
	end(): void;
	/**
	 * Cancel a request that is already on the wire.
	 *
	 * Needed because a generation check between calls does not stop the call in
	 * the middle. Auto-confirm's approve POST is the case that matters: the vault
	 * locking after the request is sent leaves Steam approving a trade the app has
	 * already promised it stopped doing.
	 *
	 * This narrows the window rather than abolishing it — a POST Steam has already
	 * received cannot be recalled by anyone. What it removes is the app continuing
	 * to *issue* work after a lock, which is the part we control.
	 */
	abort?(): void;
	on(event: 'response', listener: (response: NetResponseHandle) => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	/**
	 * Emitted when an authenticating proxy asks for credentials.
	 *
	 * This is the documented channel for `net.request` and the only one that
	 * actually fires. Answering with empty credentials cancels the request.
	 */
	on(
		event: 'login',
		listener: (
			authInfo: { isProxy: boolean },
			callback: (username?: string, password?: string) => void
		) => void
	): void;
}

export interface NetResponseHandle {
	statusCode: number;
	/**
	 * Response headers, as Electron's net module supplies them.
	 *
	 * Narrowed to what is read: Steam puts the result of its protobuf-shaped
	 * calls in `x-eresult`, and a body that is empty says nothing either way.
	 */
	headers?: Record<string, string | string[] | undefined>;
	on(event: 'data', listener: (chunk: Buffer | string) => void): void;
	on(event: 'end', listener: () => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
}

export interface EgressAccount {
	steamId64: string;
	/** Absent means this account is not routed. */
	proxyUrl?: string | undefined;
}

/**
 * Permission to talk to Steam as one account, as of one moment.
 *
 * Two counters because two different things revoke it: `epoch` is per account
 * and moves when that one account is forgotten (a lock, or a routing change);
 * `generation` is factory-wide and moves on `forgetAll`, which is the only one
 * able to reach an account that is still being constructed.
 */
interface Grant {
	generation: number;
	epoch: number;
}

/** How long any single Steam request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A response body larger than this is not one of Steam's. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The URL routing is verified against.
 *
 * Chromium resolves proxies per URL, so "is this account routed" is only
 * meaningful about a specific destination. This is the host confirmations
 * actually go to, which makes the check about the traffic that matters rather
 * than about the setting in the abstract.
 */
const ROUTING_PROBE_URL = 'https://steamcommunity.com/mobileconf/getlist';

/**
 * What is actually known about an account's egress — not what was configured.
 *
 * The distinction is the whole point. `hasProxy` says a URL is stored; this says
 * whether Chromium was asked, and what it answered.
 */
export type RoutingStatus =
	| { state: 'off' }
	/** Checked, and Chromium named a proxy. `via` is redacted. */
	| { state: 'verified'; via: string; checkedAtMs: number }
	/** Configured but proven not applied. The account is refused, not degraded. */
	| { state: 'blocked'; via: string; reason: string };

export class SteamTransportFactory {
	private readonly electron: ElectronNetworking;
	private readonly sessions = new Map<string, ProxyCapableSession>();
	/**
	 * Wipes still running, per account.
	 *
	 * `clearStorageData` is asynchronous and `fromPartition` is not: the same
	 * partition name always yields the same session object, so a rebuild during a
	 * wipe races it. `forAccount` waits on whatever is here first.
	 */
	private readonly clearing = new Map<string, Promise<void>>();
	private readonly routing = new Map<string, RoutingStatus>();
	/**
	 * Requests currently on the wire, per account, so a lock can cancel them.
	 *
	 * Without this, "everything stops while the vault is locked" is only true
	 * between calls. Auto-confirm's approve POST is the case that made it matter:
	 * a lock landing after the request was sent left Steam approving a trade the
	 * application had already reported it would not.
	 */
	private readonly inFlight = new Map<string, Set<NetRequestHandle>>();
	/**
	 * Bumped whenever an account is forgotten.
	 *
	 * Aborting handles only reaches requests that exist. `perform` awaits the
	 * routing check before it builds one, so a lock landing inside that await
	 * would find nothing to cancel and the request would then go out anyway —
	 * after the lock, over a session that was meant to be gone. Comparing this
	 * across the await closes that window.
	 */
	private readonly epoch = new Map<string, number>();

	/**
	 * Bumped by `forgetAll`, and checked by every transport it granted.
	 *
	 * The per-account `epoch` above cannot cover a lock on its own, because
	 * `forgetAll` can only reach accounts that appear in `sessions` or `inFlight`
	 * — and an account whose session is still being constructed is in neither. It
	 * is added to `sessions` only after `setProxy` has been awaited, so for the
	 * whole of that await a lock bumped nothing, and the transport handed back
	 * afterwards was indistinguishable from one granted while unlocked.
	 *
	 * For enrollment that meant `AddAuthenticator` — the one irreversible request
	 * in the application — could be sent after the vault had locked, with the
	 * vault then unable to store the secrets Steam had just issued.
	 *
	 * A factory-wide counter needs no bookkeeping per in-flight construction and
	 * cannot miss an account it has never heard of.
	 */
	private generation = 0;
	private readonly now: () => number;

	constructor(electron: ElectronNetworking, now: () => number = () => Date.now()) {
		this.electron = electron;
		this.now = now;
	}

	/**
	 * What is known about this account's egress right now.
	 *
	 * Absent means no request has been attempted since the last lock, so nothing
	 * is known — which the UI must show as unverified rather than as fine.
	 */
	routingStatus(steamId64: string): RoutingStatus | undefined {
		return this.routing.get(steamId64);
	}

	/**
	 * A transport bound to one account's egress.
	 *
	 * **Refuses rather than falls back.** If the account is configured to route
	 * through a proxy and that cannot be applied, no transport is returned at all.
	 * Returning an unrouted one would send the account's traffic from the user's
	 * own address — precisely the thing they configured a proxy to prevent, and
	 * they would have no way to notice.
	 */
	async forAccount(account: EgressAccount): Promise<SteamTransport> {
		// **Captured before the first await, and carried into every request this
		// transport ever makes.**
		//
		// It used to be read at the start of each request instead, which cannot
		// detect a lock that happened *earlier*: `forgetAll` would bump the epoch to
		// 1, and the next request would then read 1 as its own baseline and compare
		// it against itself. The question a transport has to answer is not "did
		// anything change while I was sending" but "is the permission I was granted
		// still valid", and only a value captured at the grant can answer that.
		const granted = this.currentGrant(account.steamId64);

		// Any wipe still running against this partition finishes first. See `forget`.
		await this.clearing.get(account.steamId64);

		const session = await this.sessionFor(account);

		// Construction is itself a window — `setProxy` is awaited above, and for its
		// duration this account exists in none of the maps `forgetAll` walks. Fail
		// here rather than hand back a transport whose first use will throw.
		try {
			this.assertGranted(account.steamId64, granted);
		} catch (err) {
			// `sessionFor` cached this session *after* the teardown had already looked
			// for it, so nothing wiped it and nothing will. It holds no cookies yet —
			// no request was ever made through it — but a session the lock never saw
			// is exactly the state this class promises not to keep.
			this.forget(account.steamId64);
			throw err;
		}

		// Planned again rather than remembered from `sessionFor`, which caches
		// sessions and returns early for one it already has. Safe: it has already
		// returned, so this URL parsed.
		//
		// Both halves are carried into every request. `redacted` so a failure can
		// name the proxy instead of leaving the user guessing whether one is even
		// involved; `credentials` because Electron asks the **request**, not the
		// session, and each request therefore answers for the proxy that this
		// transport was built for.
		const plan =
			account.proxyUrl !== undefined && account.proxyUrl !== ''
				? planProxy(account.proxyUrl)
				: undefined;

		if (!plan) {
			this.routing.set(account.steamId64, { state: 'off' });
		}

		return (request) => this.perform(session, request, plan, account.steamId64, granted);
	}

	/**
	 * Refuse unless Chromium confirms this request will leave through the proxy.
	 *
	 * **Run before every request, not once per session.** `setProxy` succeeding
	 * says a rule was accepted, not that it applies to this URL — Chromium keeps
	 * an implicit bypass list, a proxy list can end in a `DIRECT` fallback, and a
	 * session is a long-lived object whose configuration can be changed by a code
	 * path that forgot to re-verify. Asking per request costs a local lookup and
	 * removes every one of those gaps.
	 *
	 * The applied proxy is compared against the **intended** one, not merely
	 * checked to be non-direct: a session carrying a stale proxy from a previous
	 * configuration is routed, and routed to the wrong operator.
	 */
	private async assertRouted(
		session: ProxyCapableSession,
		steamId64: string,
		plan: ProxyPlan,
		url: string
	): Promise<void> {
		const block = (reason: string): never => {
			this.routing.set(steamId64, { state: 'blocked', via: plan.redacted, reason });
			throw new EgressError(
				`this account is set to route through ${plan.redacted}, but ${reason}. ` +
					'Refusing to connect: sending this request anyway would expose the address the ' +
					'proxy exists to hide.'
			);
		};

		let resolved: string;
		try {
			resolved = await session.resolveProxy(url);
		} catch (err) {
			return block(
				`the routing could not be checked (${redactCredentials(
					err instanceof Error ? err.message : String(err)
				)})`
			);
		}

		if (describesDirectRoute(resolved)) {
			return block('this connection would be made directly instead');
		}

		// `resolveProxy` answers `SOCKS5 10.0.0.1:1080`, so the endpoint appears
		// verbatim. A mismatch means some other proxy is applied to this session.
		if (!resolved.includes(plan.endpoint)) {
			return block('a different proxy is applied to it');
		}

		this.routing.set(steamId64, {
			state: 'verified',
			via: plan.redacted,
			checkedAtMs: this.now()
		});
	}

	/**
	 * Drop an account's session **and empty it**.
	 *
	 * Forgetting our reference is not enough: `fromPartition` returns the same
	 * session for the same name, so the cookies Steam set would still be there the
	 * next time this account connected. The jar has to be emptied explicitly.
	 */
	forget(steamId64: string): void {
		// **Before** the session goes. A request already on the wire is the part a
		// generation check cannot reach: the caller is inside `await`, so nothing
		// re-examines whether the vault is still unlocked until the answer arrives —
		// by which point Steam has acted on it.
		this.abortInFlight(steamId64);

		// **What was known about this account's route is no longer known.**
		//
		// `routingStatus` documents exactly this: "absent means no request has been
		// attempted since the last lock, so nothing is known — which the UI must
		// show as unverified rather than as fine". The map was never cleared, so
		// after a lock an account card went on reporting `verified` on the strength
		// of a check made in a session that no longer exists. For a control whose
		// entire job is to say whether traffic really left through the proxy, a
		// stale yes is the one answer it must never give.
		this.routing.delete(steamId64);

		const session = this.sessions.get(steamId64);
		this.sessions.delete(steamId64);

		// Not awaited here — a lock or a settings change must not block on a cookie
		// jar, and a failure emptying one must not take either of them down.
		//
		// But it is **remembered**, because `fromPartition` hands back the same
		// underlying session for the same name. Rebuilding this account's transport
		// while the clear was still running gave the new session the old object with
		// a wipe in flight against it, and whichever finished last decided what was
		// in the jar. `sessionFor` waits on this before handing the session out, so
		// the ordering is settled in the one place that can settle it.
		const cleared = session?.clearStorageData?.();
		if (cleared) {
			const pending = cleared
				.catch(() => undefined)
				.finally(() => {
					if (this.clearing.get(steamId64) === pending) {
						this.clearing.delete(steamId64);
					}
				});
			this.clearing.set(steamId64, pending);
		}
	}

	/**
	 * Forget every account. Called when the vault locks.
	 *
	 * A Steam session cookie is a live credential. The vault dropping its keys
	 * while the network layer quietly keeps a usable web session would make the
	 * lock a smaller thing than it claims to be.
	 */
	forgetAll(): void {
		// **First, and unconditionally.** The loop below can only reach accounts
		// that already appear in one of the maps; an account whose session is still
		// being built appears in neither, and bumping the shared generation is what
		// reaches it.
		this.generation += 1;

		// Every account with work in the air, not only those holding a session — an
		// account can have a request out before its session is cached.
		for (const steamId64 of new Set([...this.sessions.keys(), ...this.inFlight.keys()])) {
			this.forget(steamId64);
		}
	}

	/**
	 * Cancel this account's outstanding requests.
	 *
	 * Best effort by nature. A POST Steam has already received cannot be recalled
	 * by anyone, so this narrows the window rather than abolishing it — what it
	 * removes is the application continuing to issue and await work after a lock,
	 * which is the part we actually control.
	 */
	/** Permission as it stands right now, to be checked against later. */
	private currentGrant(steamId64: string): Grant {
		return { generation: this.generation, epoch: this.epoch.get(steamId64) ?? 0 };
	}

	/** Throw unless the permission granted earlier is still the current one. */
	private assertGranted(steamId64: string, granted: Grant): void {
		if (
			this.generation !== granted.generation ||
			(this.epoch.get(steamId64) ?? 0) !== granted.epoch
		) {
			throw new EgressError('this account was closed before the request was sent');
		}
	}

	private abortInFlight(steamId64: string): void {
		this.epoch.set(steamId64, (this.epoch.get(steamId64) ?? 0) + 1);

		const handles = this.inFlight.get(steamId64);
		this.inFlight.delete(steamId64);
		for (const handle of handles ?? []) {
			try {
				handle.abort?.();
			} catch {
				// Already finished, or a fake without one. Either way there is nothing
				// left to stop, and a lock must not fail because of it.
			}
		}
	}

	private async sessionFor(account: EgressAccount): Promise<ProxyCapableSession> {
		const existing = this.sessions.get(account.steamId64);
		if (existing) {
			return existing;
		}

		// No `persist:` prefix: in-memory, so cookies never touch the disk.
		const session = this.electron.sessionFromPartition(`steam-${account.steamId64}`, {
			cache: false
		});
		session.setUserAgent?.(STEAM_USER_AGENT);

		// Stripped at the session, not per request: Electron adds these itself
		// after our own headers are set, so the request handle never sees them.
		session.webRequest?.onBeforeSendHeaders((details, callback) => {
			const headers = { ...details.requestHeaders };
			for (const name of Object.keys(headers)) {
				if (BROWSER_ONLY_HEADERS.includes(name.toLowerCase() as never)) {
					delete headers[name];
				}
			}
			callback({ requestHeaders: headers });
		});

		let plan: ProxyPlan | undefined;
		if (account.proxyUrl !== undefined && account.proxyUrl !== '') {
			// Validated here rather than left to Chromium. A scheme it does not know
			// is accepted by `setProxy` without complaint and only fails much later,
			// per request, as `ERR_NO_SUPPORTED_PROXIES` — an error the user cannot
			// connect back to the address they typed.
			plan = planProxy(account.proxyUrl);
		}

		try {
			await session.setProxy(
				plan
					? { mode: 'fixed_servers', proxyRules: plan.proxyRules }
					: // **`system`, and it is worth being precise about what that means.**
						//
						// Not "no proxy" — it is whatever the operating system is configured
						// to use, which on a corporate machine or behind a VPN client may
						// well be a proxy the user never thinks about. This comment used to
						// say it meant "the machine's own egress and nothing more
						// surprising", which reads as a stronger promise than it is.
						//
						// It is still the right choice. `direct` would be a lie of a
						// different kind: it would silently stop working for everyone whose
						// network requires a proxy, and an authenticator that cannot reach
						// Steam is worse than one that reaches it the same way the user's
						// browser does. What matters is that the account card reports the
						// route that was actually resolved rather than the one configured
						// here, and `assertRouted` is what makes that true.
						{ mode: 'system' }
			);
		} catch (err) {
			throw new EgressError(
				`could not route this account through ${plan?.redacted ?? 'the network'}: ${redactCredentials(
					err instanceof Error ? err.message : String(err)
				)}`
			);
		}

		// Credentials are NOT attached here. They are answered per request, in
		// `perform` — Electron emits `login` on the ClientRequest, never on the
		// Session. Attaching them to the session also solved a problem that no
		// longer exists: `fromPartition` returns the same object every time, so
		// handlers stacked across proxy changes and an old one could answer the new
		// proxy's challenge with the previous operator's password. A request built
		// from the current plan cannot do that.

		this.sessions.set(account.steamId64, session);
		return session;
	}

	private async perform(
		session: ProxyCapableSession,
		request: SteamRequest,
		plan: ProxyPlan | undefined,
		steamId64: string,
		granted: Grant
	): Promise<SteamResponse> {
		const routedThrough = plan?.redacted;

		// Before anything is sent. A transport granted before a lock must not be
		// usable after it, however long it sat unused in between.
		this.assertGranted(steamId64, granted);

		// Before anything is sent, and before the endpoint check below, because a
		// refusal to route is not a reason to look at the URL — it is a reason to
		// send nothing at all.
		if (plan) {
			await this.assertRouted(session, steamId64, plan, ROUTING_PROBE_URL);
		}

		// Re-checked after the await. A lock or a routing change landing inside it
		// had no handle to abort, so without this the request is built and sent
		// afterwards — which is precisely the "auto-confirm approves after lock"
		// case, one layer lower than where it was first noticed.
		this.assertGranted(steamId64, granted);

		return new Promise<SteamResponse>((resolve, reject) => {
			// Checked on every request, not once at construction. This function
			// attaches a live Steam session cookie to whatever URL it is given;
			// nothing currently builds one from anything but our own constants, but
			// "nothing currently" is not a control, and the cost of being wrong is a
			// session posted to somebody else's server.
			if (!isSteamEndpoint(request.url)) {
				reject(new EgressError('refusing to send a Steam session anywhere but Steam'));
				return;
			}

			const handle = this.electron.request({
				url: request.url,
				method: request.method,
				session,
				// See `ElectronNetworking.request`. The allowlist only ever sees the
				// first URL, so following a redirect would send a live Steam session
				// somewhere nothing checked.
				redirect: 'error'
			});

			// Registered before anything is written, because the challenge arrives
			// during the CONNECT that opens the tunnel — before a single byte of the
			// request itself is on the wire.
			if (plan?.credentials) {
				const { username, password } = plan.credentials;
				handle.on('login', (authInfo, callback) => {
					// Only ever answer the proxy. A `login` that is not `isProxy` is the
					// destination asking for HTTP auth, and answering it would send the
					// user's proxy password to Valve.
					if (authInfo.isProxy) {
						callback(username, password);
					} else {
						// Empty cancels the request, which is the right outcome: Steam does
						// not use HTTP authentication, so being asked for it means this is
						// not a conversation to continue.
						callback();
					}
				});
			}

			handle.setHeader('User-Agent', STEAM_USER_AGENT);
			// Only when there is one. Minting an access token happens *before* any
			// session exists, and an empty header value is not something to hand a
			// networking stack and hope about.
			// The mobile-client cookie goes on every request, with or without a
			// session. It is half of the identity the User-Agent claims — Steam's own
			// `WebApiTransport` keys off `mobileClientVersion=` to decide a request
			// came from the app — and sending one without the other is half a
			// disguise, which is worse than none.
			const cookie =
				request.cookie === ''
					? STEAM_MOBILE_CLIENT_COOKIE
					: `${STEAM_MOBILE_CLIENT_COOKIE}; ${request.cookie}`;
			handle.setHeader('Cookie', cookie);

			// Matches what `steam-session` sends, so both halves of a session agree
			// about what kind of client this is.
			handle.setHeader('Accept', 'application/json, text/plain, */*');
			if (request.body) {
				handle.setHeader('Content-Type', 'application/x-www-form-urlencoded');
			}

			// Tracked from the moment it exists, so a lock arriving mid-request has
			// something to cancel. Removed on settle, whatever the outcome —
			// otherwise a long-lived account accumulates dead handles forever.
			const outstanding = this.inFlight.get(steamId64) ?? new Set<NetRequestHandle>();
			outstanding.add(handle);
			this.inFlight.set(steamId64, outstanding);

			let settled = false;
			const finish = (run: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				outstanding.delete(handle);
				if (outstanding.size === 0) {
					this.inFlight.delete(steamId64);
				}
				run();
			};

			// A hung proxy is the common case, not an exotic one, and a request that
			// never settles would stall the poller behind it forever.
			const timer = setTimeout(() => {
				// **Aborted, not merely abandoned.** Rejecting alone left the request
				// running: the socket stayed open, and Steam could still act on it —
				// while `finish` had already removed the handle from `outstanding`, so
				// the lock-time `abortInFlight` could no longer reach it either. A
				// timed-out request was therefore the one kind this transport could not
				// cancel, which is exactly backwards.
				try {
					handle.abort?.();
				} catch {
					// Already finished or never connected. Nothing to stop.
				}
				finish(() =>
					reject(
						new EgressError('Steam did not answer in time; the connection or proxy may be down.')
					)
				);
			}, REQUEST_TIMEOUT_MS);
			timer.unref?.();

			handle.on('error', (error) =>
				finish(() => reject(new EgressError(describeNetworkError(error, routedThrough))))
			);

			handle.on('response', (response) => {
				const chunks: string[] = [];
				let length = 0;

				response.on('data', (chunk) => {
					length += chunk.length;
					if (length > MAX_RESPONSE_BYTES) {
						// Steam's answers are kilobytes. Anything of this size is a captive
						// portal or a proxy error page, and it is not going to parse.
						//
						// **Aborted, not merely abandoned** — the same rule the timeout path
						// follows, and for the same reason. `finish` removes the handle from
						// `outstanding`, so rejecting alone left a peer streaming into a
						// request nothing could cancel: the timer is cleared, the lock-time
						// `abortInFlight` can no longer see it, and the socket stays open for
						// as long as the other end keeps writing.
						try {
							handle.abort?.();
						} catch {
							// Already finished or never connected. Nothing to stop.
						}
						finish(() => reject(new EgressError('Steam sent an implausibly large response.')));
						return;
					}
					chunks.push(
						typeof chunk === 'string'
							? chunk
							: chunk.toString(request.binary === true ? 'latin1' : 'utf8')
					);
				});
				response.on('error', (error) =>
					finish(() => reject(new EgressError(describeNetworkError(error, routedThrough))))
				);
				response.on('end', () =>
					finish(() => {
						// Steam reports the outcome of its protobuf-shaped methods here rather
						// than in the body, which is frequently empty. Only the one header is
						// taken: the rest belong to the transport, not to its callers.
						const raw = response.headers?.['x-eresult'];
						const eresult = Number(Array.isArray(raw) ? raw[0] : raw);
						resolve({
							status: response.statusCode,
							text: chunks.join(''),
							...(Number.isFinite(eresult) ? { eresult } : {})
						});
					})
				);
			});

			if (request.body) {
				handle.write(request.body.toString());
			}
			handle.end();
		});
	}
}
