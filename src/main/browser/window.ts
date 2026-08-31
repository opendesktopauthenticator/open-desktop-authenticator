import {
	STEAM_ROUTED_DOMAINS,
	describesDirectRoute,
	planProxy,
	routedEndpoint,
	steamOnlyBypass,
	type ProxyPlan
} from '../net/egress';
import type { BrowserRoute } from '../../shared/ipc';

/**
 * An in-app browser, signed in as one account and routed like that account.
 *
 * ## Why this cannot reuse the account's existing session
 *
 * `src/main/net/transport.ts` builds a session per account that is deliberately
 * disguised as the Steam Android app: `okhttp/4.9.2` as the User-Agent, the
 * `mobileClient` cookie beside it, and every browser-only header stripped at the
 * session level because — as `egress.ts` puts it — a contradiction is more
 * identifying than any one header.
 *
 * A browser sharing that session breaks in both directions. Steam's web pages
 * served to an `okhttp` client render wrong or are refused, and un-stripping the
 * headers to fix that makes the session send browser fingerprints beside an
 * okhttp User-Agent, which is precisely the contradiction the stripping exists
 * to prevent. Whichever way it is bent, one of two deliberate properties breaks.
 *
 * So this gets its own partition: a real browser, honestly presented, sharing
 * only the proxy. Steam then sees one account with an app session and a web
 * session, which is what an ordinary person with a phone and a PC looks like —
 * and the founder has confirmed against a live account that both refresh tokens
 * survive alongside each other, which is the fact this whole design rests on.
 *
 * ## What it deliberately does not do
 *
 * It carries no preload script and no bridge. The window is a browser and
 * nothing more: it cannot reach the vault, the IPC table, or any part of this
 * application. `sandbox` and `contextIsolation` are on and `nodeIntegration` is
 * off, the same posture the main window has, for the same reason — except here
 * the pages are Valve's rather than ours, which makes it matter more.
 */

/** The subset of Electron this module needs, injected so it can be tested. */
export interface BrowserHost {
	// `cache` is required, not optional — Electron's `FromPartitionOptions`
	// declares it so, and `ElectronNetworking` in transport.ts already had this
	// right. Writing it optional here made the port describe something Electron
	// does not accept, which the adapter refused to compile against.
	sessionFromPartition(partition: string, options?: { cache: boolean }): BrowserSessionHandle;
	createWindow(options: BrowserWindowOptions): BrowserWindowHandle;
}

export interface BrowserSessionHandle {
	setProxy(config: {
		mode?: string;
		proxyRules?: string;
		/**
		 * What is allowed to skip the proxy. Always `<-loopback>` here — see
		 * `openAccountBrowser`.
		 */
		proxyBypassRules?: string;
	}): Promise<void>;
	/**
	 * Ask Chromium what it would actually do with a URL.
	 *
	 * `setProxy` resolving means the configuration was accepted, not that it is
	 * in force. `transport.ts` has refused to send a request without this answer
	 * since the routing feature existed; the browser was opening windows on the
	 * strength of the configuration alone.
	 */
	resolveProxy(url: string): Promise<string>;
	/**
	 * Refuse every permission request on this session.
	 *
	 * Required, not optional. §P8 denies these app-wide, but that call is made
	 * against `session.defaultSession` and this window deliberately runs in a
	 * partition of its own — so it inherited nothing, and Electron's default with
	 * no handler is to **approve**. A page here is not ours, and it was able to
	 * ask for a camera, a microphone or a location while signed in to somebody's
	 * Steam account.
	 */
	denyPermissions(): void;
	setUserAgent?(userAgent: string): void;
	clearStorageData?(): Promise<void>;
	cookies: {
		set(cookie: {
			url: string;
			name: string;
			value: string;
			domain?: string;
			path?: string;
			secure?: boolean;
			httpOnly?: boolean;
		}): Promise<void>;
	};
}

export interface BrowserWindowOptions {
	width: number;
	height: number;
	title: string;
	partition: string;
	userAgent: string;
}

export interface BrowserWindowHandle {
	loadURL(url: string): Promise<void>;
	/**
	 * Stop WebRTC offering the real address around the proxy.
	 *
	 * A proxy carries HTTP. WebRTC opens UDP itself, and a page that asks for a
	 * peer connection is handed the machine's own local and public addresses —
	 * which is the leak this window would otherwise have, in the one place a user
	 * has been told their traffic is routed.
	 */
	setWebRtcPolicy(policy: 'disable_non_proxied_udp' | 'default'): void;
	/**
	 * What to answer when the **proxy** asks who we are.
	 *
	 * `planProxy` strips credentials out of the Chromium rule on purpose — a
	 * password in `proxyRules` ends up in `resolveProxy` output and in every
	 * message quoting it — and hands them back separately for whoever does the
	 * authenticating. `transport.ts` has answered its own `login` event with them
	 * since routing existed. This window never did.
	 *
	 * Electron cancels an unhandled `login`, so the effect was a proxy this
	 * application accepts, stores, and successfully mints tokens through, whose
	 * every page load in the browser died on a 407. Fails closed, which is the
	 * right direction, but a supported configuration that silently only half
	 * works is still a defect.
	 *
	 * Undefined when the proxy needs no credentials, or when there is no proxy.
	 */
	setProxyCredentials(credentials: { username: string; password: string } | undefined): void;
	/** Replace the window's own title. Never called with anything a page supplied. */
	setTitle(title: string): void;
	/** Bring this window to the user, restoring it if it was minimised. */
	focus(): void;
	/**
	 * Where the main frame actually is, after every redirect Steam performed.
	 *
	 * Asking for a URL is not the same as landing on it, and the difference is
	 * the whole of `looksSignedOut`.
	 */
	currentUrl(): string;
	close(): void;
	isDestroyed(): boolean;
	on(event: 'closed', listener: () => void): void;
	/**
	 * The main frame went somewhere. The URL comes from Electron, not from the
	 * page — a page that could name its own location could lie about it.
	 */
	on(event: 'navigated', listener: (url: string) => void): void;
	setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
}

/**
 * A real Chrome User-Agent, and the one place it is stated.
 *
 * The opposite decision to `STEAM_USER_AGENT`. That one lies about what this
 * application is, on purpose, so that accounts do not stand out from one
 * another. This one tells the truth, because a browser claiming not to be a
 * browser gets served a page that does not work.
 */
export const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Where a signed-in browsing session starts. */
export const START_URL = 'https://steamcommunity.com/my/tradeoffers/';

/**
 * A host no list mentions, used to check that a routed window sends the
 * unrecognised ones through the proxy rather than around it.
 *
 * `.invalid` is reserved by RFC 2606 and cannot resolve, so asking about it
 * touches no network — and if it ever *did* resolve, the answer being checked
 * is that it is proxied.
 */
const UNKNOWN_HOST_PROBE = 'https://route-check.invalid/';

/**
 * The addresses Chromium bypasses unless it is told not to.
 *
 * **These are checked because they were once wrong and nothing noticed.** With
 * the "Steam only" route configured as a PAC script, every one of them resolved
 * `DIRECT` — the implicit bypass is applied before a PAC is consulted, and
 * `<-loopback>` does not switch it off in that mode. A window advertised as
 * routed could reach local services and the cloud-metadata address off-proxy.
 *
 * `169.254.169.254` earns its place by name rather than as a sample of the
 * link-local range: on a cloud host it is the instance metadata service, which
 * hands out credentials to anything that can make an unauthenticated request to
 * it. A browser window is exactly that.
 *
 * Asking costs nothing — `resolveProxy` consults the configuration and connects
 * to nothing.
 */
const IMPLICIT_BYPASS_PROBES = [
	'http://localhost/',
	'http://127.0.0.1/',
	'http://[::1]/',
	'http://169.254.169.254/'
];

/**
 * The domains a Steam session cookie is set on.
 *
 * Both, because a trade begins on `steamcommunity.com` and a market listing
 * ends on `store.steampowered.com`, and a user who has to sign in again halfway
 * through is a user who will look for a browser extension instead.
 */
const COOKIE_HOSTS = ['https://steamcommunity.com', 'https://store.steampowered.com'] as const;

export class BrowserSessionError extends Error {}

/**
 * Steam would not accept the session, so no window is open.
 *
 * Separate from `BrowserSessionError` because it is a **state the user can fix
 * in one step**, not a failure to report — the same distinction
 * `confirmationsListResponse.signInRequired` draws, and for the same reason:
 * thrown as an error, the renderer can only print it.
 */
export class BrowserSignInRequired extends Error {}

export interface OpenBrowserOptions {
	steamId64: string;
	accountName: string;
	/** The account's proxy, exactly as the rest of the app routes it. */
	proxyUrl?: string | undefined;
	/**
	 * Whether to use it for this window.
	 *
	 * The user's choice, made per window rather than assumed. A proxy is often
	 * the reason a page will not load at all: shared addresses collect rate
	 * limits and Cloudflare challenges that a residential connection never sees,
	 * and somebody who only wants to accept one trade is better served by an
	 * honest choice than by a window that will not open.
	 *
	 * Ignored when the account has no proxy. When it is true and routing cannot
	 * be proved, no window opens.
	 */
	route: BrowserRoute;
	/**
	 * A freshly minted access token.
	 *
	 * Passed in rather than minted here, so this module never touches the vault
	 * and never sees a refresh token. What it receives is short-lived and
	 * account-scoped — the smallest credential that does the job.
	 */
	accessToken: string;
	/**
	 * Told the moment the window exists, before anything is loaded into it.
	 *
	 * **This is what makes a lock able to reach a window whose load hangs.** The
	 * caller records what this function *returns*, and a load that never settles
	 * never returns — so without this the physical window is on screen, signed
	 * in, in no map, for as long as the hang lasts.
	 */
	onCreated?: (window: BrowserWindowHandle) => void;
	/**
	 * Told whether a failed open managed to empty the partition behind it.
	 *
	 * Both refusal paths below close the window and wipe the session, and both
	 * used to discard whether the wipe worked. A failure there leaves the jar
	 * holding the `steamLoginSecure` this function had just set — so a retry, or
	 * an open on a *different* route, silently inherits the session the failed
	 * attempt established. That is the two routes sharing a cookie jar, which is
	 * the thing the caller's dirty-partition tracking exists to prevent.
	 */
	onWipe?: (cleared: boolean) => void;
	/**
	 * Throw if this attempt has been disowned since it started.
	 *
	 * **The caller could only ask afterwards, and afterwards is too late.**
	 * `AccountBrowsers.open` checked its generation and epoch around its single
	 * `await openAccountBrowser(...)`, which makes the whole of this function one
	 * indivisible step from outside — and it is not. It waits on `setProxy`,
	 * which is Chromium IPC and can take as long as Chromium likes.
	 *
	 * A lock landing inside that wait ran `closeAll`, which found nothing:
	 * `onCreated` had not fired, so the account was in no map. This function then
	 * carried on, wrote Steam's cookie into the partition the sweep had just
	 * wiped, and created a signed-in window that was registered *after* the sweep
	 * had finished. Measured: one window created after the lock, still on screen,
	 * while `isOpen()` reported false — so nothing could find it to close it, and
	 * the next lock had no record of it either.
	 *
	 * Called after every await here, and before the two irreversible steps: the
	 * cookie, and the window. Where it throws after the cookie exists, the
	 * partition is wiped again on the way out.
	 *
	 * **The call sites are deliberately redundant, and mutation testing says so.**
	 * Deleting any single one of them leaves the suite green, because the next
	 * one down catches the same disown a moment later; deleting the lot — or
	 * stubbing this to a no-op — fails three tests. That is defence in depth
	 * behaving exactly as intended rather than missing coverage, and it is
	 * recorded here so the next person to run a mutant does not go looking for a
	 * test that cannot exist. What is genuinely pinned is the property: no cookie
	 * is written and no window is built for an attempt that has been disowned.
	 */
	stillWanted?: () => void;
}

/**
 * Open the window, or refuse.
 *
 * **Fails closed on routing, like everything else here.** If an account has a
 * proxy configured and it cannot be applied, no window opens — because a
 * browser that quietly falls back to the machine's own address would attach a
 * home IP to an account the user has been careful to route, and would do it
 * while they were logged in and trading.
 */
export async function openAccountBrowser(
	host: BrowserHost,
	options: OpenBrowserOptions
): Promise<BrowserWindowHandle> {
	const partition = browserPartitionFor(options.steamId64);
	const session = host.sessionFromPartition(partition, { cache: false });
	session.setUserAgent?.(BROWSER_USER_AGENT);

	/*
	 * Before anything loads. A page cannot be asked to wait while we decide
	 * whether it may use the camera, and Steam needs none of these to work.
	 */
	session.denyPermissions();

	let plan: ProxyPlan | undefined;
	if (options.route !== 'direct' && options.proxyUrl !== undefined && options.proxyUrl !== '') {
		// Validated before use, for the same reason the transport does it: a
		// scheme Chromium does not know is accepted by `setProxy` without
		// complaint and fails much later, per request, as an error the user
		// cannot connect back to the address they typed.
		plan = planProxy(options.proxyUrl);
	}

	/**
	 * Whether Steam alone is routed, or everything is.
	 *
	 * Only meaningful with a plan: an account with no proxy has nothing to route
	 * Steam *through*, and `plan` is already undefined for it.
	 */
	const steamOnly = plan !== undefined && options.route === 'steam-only';

	try {
		await session.setProxy(
			plan
				? {
						/*
						 * **One shape for both routed choices, differing only in what may
						 * skip the proxy.**
						 *
						 * `<-loopback>` is the part neither of them may go without. Chromium
						 * bypasses loopback and link-local addresses by default, so "routed"
						 * quietly meant "routed except for a list nobody was shown" — and
						 * that list includes `169.254.169.254`, the cloud-metadata address.
						 * `<-loopback>` removes the default rather than adding to it.
						 *
						 * This route used to be a PAC script, which looked equivalent and
						 * was not: Chromium applies the implicit bypass *before* consulting
						 * a PAC, and `<-loopback>` does not switch it off in that mode.
						 * `egress.ts` records the measurement.
						 *
						 * "Steam only" then adds the third-party sites that may go direct.
						 * Steam is not in that list and neither is anything unrecognised, so
						 * both keep going through the proxy — which is why a Steam domain
						 * nobody remembered to write down cannot leak.
						 */
						mode: 'fixed_servers',
						proxyRules: plan.proxyRules,
						proxyBypassRules: steamOnly ? steamOnlyBypass() : '<-loopback>'
					}
				: /*
					 * **`system`, not `direct`, and for the reason `transport.ts` gives.**
					 *
					 * These two are halves of one action — the token is minted by the
					 * transport and spent by this window — and they disagreed: an
					 * unrouted transport follows the machine's proxy settings, an
					 * unrouted window ignored them. On a machine with an OS proxy that
					 * meant the Steam cookie was issued to one address and used from
					 * another, which is the correlation routing exists to prevent,
					 * reintroduced by the option offered as the way *around* routing.
					 *
					 * It also simply did not work there: `direct` on a network that
					 * requires a proxy reaches nothing, so the window opened and loaded
					 * no page.
					 */
					{ mode: 'system' }
		);
	} catch (cause) {
		throw new BrowserSessionError(
			plan
				? `the browser could not be routed through ${plan.redacted}, so it was not opened`
				: 'the browser session could not be prepared',
			{ cause }
		);
	}

	/*
	 * **The first await is over, so ask whether this is still wanted.**
	 *
	 * `setProxy` is Chromium IPC and takes as long as Chromium takes. A lock
	 * landing inside it used to be invisible here: this function had told nobody
	 * it existed yet, so the sweep found nothing to close and this carried on.
	 */
	options.stillWanted?.();

	/*
	 * **Configured is not applied, and only Chromium can settle which.**
	 *
	 * `setProxy` resolving means the settings were accepted. `transport.ts` has
	 * refused to send a single request without asking `resolveProxy` what would
	 * actually happen — because a proxy that is configured and not applied is the
	 * one failure that looks exactly like success — and this window was opening on
	 * the strength of the configuration alone.
	 */
	if (plan) {
		/*
		 * **What has to be true before a window opens.**
		 *
		 * The fully routed window has one question: does the start page go through
		 * the proxy. Everything in that session is routed by one rule, so one
		 * answer settles it.
		 *
		 * "Steam only" adds a bypass list, and a bypass list can be wrong in ways
		 * a bare rule cannot: an entry with the wrong spelling covers more or less
		 * than it reads as, and a Steam domain that fell into it would be sent
		 * around the proxy by the very mode that promises to route it. None of
		 * that fails loudly — the window opens, Steam loads, and the address on
		 * the account is this machine's. So every domain the mode promises to
		 * route is asked about individually, plus one host on no list at all,
		 * which is the fail-closed default being checked rather than assumed.
		 */
		const mustRoute = [
			START_URL,
			/*
			 * Both routed choices carry `<-loopback>`, so both are checked. The
			 * fully routed window has always set it and never proved it — and
			 * "configured is not applied" is the failure this whole block exists
			 * for, whichever route asked.
			 */
			...IMPLICIT_BYPASS_PROBES,
			...(options.route === 'steam-only'
				? [...STEAM_ROUTED_DOMAINS.map((d) => `https://${d}/`), UNKNOWN_HOST_PROBE]
				: [])
		];

		for (const target of mustRoute) {
			let resolved: string;
			try {
				resolved = await session.resolveProxy(target);
			} catch (cause) {
				throw new BrowserSessionError(
					`the routing through ${plan.redacted} could not be checked, so no window was opened`,
					{ cause }
				);
			}
			// Each probe is a round trip of its own, and there are several.
			options.stillWanted?.();
			if (describesDirectRoute(resolved) || routedEndpoint(resolved) !== plan.endpoint) {
				throw new BrowserSessionError(
					`this account is set to route through ${plan.redacted}, but this window would not. ` +
						'Refusing to open it: browsing anyway would put your own address on the account ' +
						'the proxy exists to hide.'
				);
			}
		}
	}

	/*
	 * **The last moment nothing has happened yet.**
	 *
	 * Everything above is a question — apply a proxy, ask Chromium where a URL
	 * would go — and every one of them was an await this attempt could be
	 * disowned during. Below is the cookie, which is a signed-in Steam session
	 * sitting in a partition, and after it a window. Asked here so a lock that
	 * landed in any of those waits costs nothing at all.
	 */
	options.stillWanted?.();

	await signIn(session, options.steamId64, options.accessToken);

	/*
	 * **And again, because the cookie is the point of no return.**
	 *
	 * `signIn` is two `cookies.set` calls, which is two more awaits. A lock
	 * during them leaves Steam's session in a partition that the sweep has
	 * already wiped and will not look at again — so this clears it rather than
	 * leaving it for a lock that has been and gone.
	 */
	try {
		options.stillWanted?.();
	} catch (cause) {
		options.onWipe?.(await clearSession(session));
		throw cause;
	}

	const window = host.createWindow({
		width: 1280,
		height: 860,
		title: `${options.accountName} — browser`,
		partition,
		userAgent: BROWSER_USER_AGENT
	});

	/*
	 * **Handed over before it is loaded, not after it settles.**
	 *
	 * The note below says nothing past this point may leave a window behind, and
	 * covers every path that *throws*. A load that never settles throws nothing:
	 * it simply does not return, so the caller's post-await disown never runs and
	 * the window it would have closed is not in any map. A lock then completes,
	 * reports success and starts wiping storage while a signed-in `WebContents`
	 * is still on screen — for as long as the load hangs, which has no bound.
	 *
	 * So the manager is told about the physical window the instant it exists.
	 * From here a sweep can close it synchronously without waiting for anything.
	 */
	options.onCreated?.(window);

	/*
	 * **Once more, now that the window exists and is findable.**
	 *
	 * `createWindow` is synchronous, so nothing can have changed since the check
	 * above — but this is the first instant a sweep could have closed this window
	 * itself, and the first instant `abandon` has something to close. Asking here
	 * means a disown that arrived during `signIn` ends with the window shut and
	 * the partition wiped, rather than a signed-in window nobody is holding.
	 */
	try {
		options.stillWanted?.();
	} catch (cause) {
		options.onWipe?.(await abandon(window, session));
		throw cause;
	}

	/*
	 * A proxy carries HTTP; WebRTC opens its own UDP and hands a page the
	 * machine's real local and public addresses. Turned off whenever this window
	 * is routed — it is the one leak that survives a correctly applied proxy, and
	 * Steam needs no peer connections.
	 */
	window.setWebRtcPolicy(plan ? 'disable_non_proxied_udp' : 'default');

	/*
	 * Before the first tab exists, like the WebRTC policy above and for the same
	 * reason: a tab that loaded before this was set would meet the proxy's 407
	 * with nothing to say, and Electron cancels an unanswered `login`.
	 */
	window.setProxyCredentials(plan?.credentials);

	/*
	 * Popups stay inside this window's partition rather than opening in the
	 * user's own browser. Steam's trade and market flows use them, and a popup
	 * that escaped to the default browser would arrive unrouted and signed out —
	 * the two things this window exists to provide.
	 */
	window.setWindowOpenHandler(() => ({ action: 'allow' }));

	/*
	 * The title follows the address, so the window always says where it is.
	 * `page-title-updated` is prevented in the adapter, so this is the only
	 * thing that writes a title and a page cannot overwrite it.
	 */
	/**
	 * Whether the first load has been judged yet.
	 *
	 * **The guard below must not fire during the first load, and armed eagerly it
	 * did.** Steam answers a dead session with a 302 to its own login form, so
	 * the login page is not some later surprise — it is precisely what the most
	 * common failure looks like from *inside* `loadURL`. Firing there closed the
	 * window before the landing check could reach it, the load then aborted, and
	 * the user was told "the browser could not reach Steam": a routing-shaped
	 * error for a sign-in-shaped problem, on the one screen whose whole job is to
	 * offer the sign-in.
	 *
	 * So the first load belongs to the landing check, which reports it properly,
	 * and this belongs to everything after.
	 */
	let landed = false;

	window.on('navigated', (url) => {
		if (!landed) {
			// The landing check owns this one. It runs on the URL the load actually
			// ended on, which is the same question asked once rather than at every
			// hop through it.
			return;
		}

		/*
		 * **The landing check, applied for the rest of the window's life.**
		 *
		 * It used to run once. A Steam session that expires mid-trade is answered
		 * with a redirect to Steam's own login form, and that form would then have
		 * been drawn inside this application's chrome, under the account's name,
		 * with a correct `steamcommunity.com` in the address bar — a password
		 * prompt where every signal a careful person checks agrees.
		 *
		 * Closed and wiped rather than merely navigated away from: the session is
		 * over either way, and leaving the window open on some other Steam page
		 * would only postpone the next redirect back to the same form.
		 */
		if (isSteamLoginPage(url)) {
			void abandon(window, session);
			return;
		}
		window.setTitle(titleFor(options.accountName, url));
	});

	/*
	 * **Nothing below here may leave a window behind.**
	 *
	 * From this point there is a window on screen holding a signed-in session.
	 * `AccountBrowsers` knows about it — `onCreated` above handed it over — but
	 * only as one still being built, so anything that throws from here must still
	 * close it and wipe the session. Both exits below do.
	 *
	 * The hand-over is what covers the exit this list cannot: a load that hangs
	 * for ever reaches neither branch.
	 */
	try {
		await window.loadURL(START_URL);
	} catch (cause) {
		// **Awaited into a variable, never inline into `onWipe?.()`.** Optional
		// chaining short-circuits the whole call expression *including its
		// arguments*, so with no listener attached the `abandon` would never run —
		// the window would stay open and the partition unwiped, on the two paths
		// whose entire job is to undo a signed-in window.
		const cleared = await abandon(window, session);
		options.onWipe?.(cleared);
		throw new BrowserSessionError('the browser could not reach Steam, so it was closed', {
			cause
		});
	}

	if (looksSignedOut(window.currentUrl())) {
		const cleared = await abandon(window, session);
		options.onWipe?.(cleared);
		throw new BrowserSignInRequired(
			`Steam did not accept the saved session for ${options.accountName}. ` +
				'Sign in to that account again.'
		);
	}

	// Landed, signed in, on Steam. From here every navigation is the user's, and
	// the guard above takes over.
	landed = true;
	// The title the first load earned, which the guard deliberately did not write
	// while it was still being judged.
	window.setTitle(titleFor(options.accountName, window.currentUrl()));

	return window;
}

/** Steam's own hosts, and the only ones a signed-in landing may be on. */
const STEAM_HOSTS = [
	'steamcommunity.com',
	'store.steampowered.com',
	'help.steampowered.com',
	// Valve's sign-in host. Recognised so `isSteamLoginPage` can refuse it — see
	// `LOGIN_HOST`.
	'login.steampowered.com'
];

/**
 * Did the browser land on a login page rather than on the user's trade offers?
 *
 * **The question the rest of this feature only approximated.** `ipc.ts` refuses
 * to open a window for an account with no saved session, precisely so nobody is
 * shown a Steam login form inside a window this application drew. But holding a
 * refresh token is not the same as Steam accepting the cookie minted from it:
 * that is a fact about Valve's servers, and the only way to learn it is to look
 * at where the page ended up.
 *
 * Answers "signed in" only for a Steam page that is not a login page. Anything
 * else — an unparseable URL, a blank window, a redirect somewhere unexpected —
 * counts as signed out, because the one answer that does harm here is a
 * confident yes.
 */
export function looksSignedOut(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// `about:blank`, an empty string, anything that never loaded.
		return true;
	}
	if (parsed.protocol !== 'https:') {
		return true;
	}
	if (!STEAM_HOSTS.includes(parsed.hostname.replace(/^www\./, ''))) {
		return true;
	}
	return isSteamLoginPage(url);
}

/**
 * Is this one of Valve's own sign-in forms?
 *
 * **Split out of `looksSignedOut` because the landing was not the only way to
 * reach one.** That check runs once, against the URL the first load ended on,
 * and everything after it was only ever used to write a title. So a session
 * that expired an hour into a trade — Steam answers with a redirect to
 * `/login/home/?goto=…`, which is ordinary and expected — put a real Steam
 * password form inside this application's chrome, under the account's own name,
 * which is exactly the deception §2.6b promises never happens here. The address
 * bar would have said `steamcommunity.com`, correctly, and that makes it worse:
 * every signal a careful person checks would have agreed.
 *
 * Narrower than `looksSignedOut` on purpose. That one answers "should this
 * window have opened at all", so anything unexpected counts. This one answers
 * "is a password being asked for", and being wrong in the other direction closes
 * a window somebody was using.
 *
 * `/openid/login` is deliberately not included. It is how Steam signs a user in
 * to third-party trading sites, it is a page an already-signed-in account passes
 * through without typing anything, and refusing it would break the workflow this
 * browser exists for.
 */
export function isSteamLoginPage(url: string): boolean {
	if (!isSteamHost(url)) {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname.replace(/^www\./, '');

	// A host that exists to sign people in, so every path on it is one.
	if (host === LOGIN_HOST) {
		return true;
	}

	/*
	 * **Steam Support is a different application with different URLs.**
	 *
	 * `help.steampowered.com` puts a locale in the path and calls the page a
	 * wizard step: the real sign-in is `/en/wizard/Login`. Matching `^/login`
	 * answered *false* for it — so the one Valve password form this predicate
	 * missed was the one on Valve's own support site, sitting under this
	 * application's chrome with the account's name on the window.
	 *
	 * The locale is stripped only here, and deliberately not on the other two
	 * hosts: `steamcommunity.com/id/<name>` is a vanity profile, so stripping a
	 * two-letter first segment there would read `/id/login` — a real person whose
	 * profile name is "login" — as a password form and close the window on them.
	 */
	if (host === HELP_HOST) {
		const path = withoutLocale(parsed.pathname);
		return /^login(\/|$)/i.test(path) || /^wizard\/login(\/|$)/i.test(path);
	}

	return /^\/login(\/|$)/i.test(parsed.pathname);
}

/** Steam Support's sign-in lives behind a locale segment; nothing else does. */
const HELP_HOST = 'help.steampowered.com';

/**
 * Valve's dedicated sign-in host.
 *
 * Every path on it is part of signing in, so it needs no path test — and a
 * signed-in window has no business arriving here at all. Listed among the Steam
 * hosts so it is recognised rather than merely labelled "NOT STEAM", which
 * would have warned about the right page for the wrong reason and left it open.
 */
const LOGIN_HOST = 'login.steampowered.com';

/**
 * A Steam Support path with its `/en/`-style prefix removed, if it had one.
 *
 * Conservative about what counts: a locale, and only when something follows it.
 * `/wizard/Login` has no prefix and must survive unchanged.
 */
function withoutLocale(pathname: string): string {
	const trimmed = pathname.replace(/^\/+/, '');
	const [first, ...rest] = trimmed.split('/');
	return /^[a-z]{2}(-[a-z0-9]{2,4})?$/i.test(first ?? '') && rest.length > 0
		? rest.join('/')
		: trimmed;
}

/**
 * Close a window that should never have stayed open, and take its session with
 * it.
 *
 * Swallows both failures on purpose: this runs on the way to throwing something
 * the caller needs to see, and a secondary error here would replace it with a
 * less useful one.
 */
/**
 * Close the window and empty its partition.
 *
 * **Returns whether the storage was actually cleared**, which it did not used
 * to. The window closing and the session emptying are different promises: the
 * first is cosmetic, the second is what stops a Steam login cookie outliving
 * the lock that was supposed to end it. Swallowing the second failure silently
 * made them look like one thing.
 */
/**
 * Empty a partition when there is no window to close yet.
 *
 * `abandon` needs a window; the disown that arrives between the cookie and the
 * window has none, and the cookie is already there. Same answer to the same
 * question — did the storage actually clear — so the caller records it the same
 * way.
 */
async function clearSession(session: BrowserSessionHandle): Promise<boolean> {
	try {
		await session.clearStorageData?.();
		return true;
	} catch {
		return false;
	}
}

async function abandon(
	window: BrowserWindowHandle,
	session: BrowserSessionHandle
): Promise<boolean> {
	try {
		if (!window.isDestroyed()) {
			window.close();
		}
	} catch {
		// Already gone.
	}
	try {
		await session.clearStorageData?.();
		return true;
	} catch {
		// The window is closed either way, so this is the lesser problem — but it
		// is not nothing, and the caller has to know rather than assume.
		return false;
	}
}

/**
 * Every browser window this process has opened, and the way to end them.
 *
 * **Built because the lock did not reach them.** `SteamTransportFactory.forgetAll`
 * wipes the `steam-*` sessions it created; the `browser-*` partition is not one
 * of those, so a signed-in Steam session survived the vault locking — and
 * reopening the browser would have found it still logged in, without a
 * passphrase. The vault's promise is that everything stops while it is locked,
 * and a live web session is not nothing.
 *
 * Closing the window is not enough on its own. `fromPartition` hands back the
 * same session object next time it is asked, so the cookie outlives the window
 * that used it unless the storage is cleared too.
 */
/**
 * One open in flight, and the means to give up on it.
 *
 * `done` is the attempt as a joiner sees it: it settles when the attempt does,
 * **or** when a sweep calls `abandon` because it has closed the window out from
 * under it. Without that second door a joiner parked on a load that never
 * settles waits for the life of the process.
 */
interface OpeningAttempt {
	readonly route: string;
	readonly done: Promise<void>;
	readonly abandon: (reason: Error) => void;
}

export class AccountBrowsers {
	private readonly windows = new Map<string, BrowserWindowHandle>();

	/**
	 * Windows that exist but have not finished opening.
	 *
	 * **Separate from `windows` because they are not usable yet** — nothing may
	 * hand one to a caller as this account's browser — but they are absolutely
	 * closable, and that is the whole point. `openAccountBrowser` creates the
	 * window and then loads a page into it; the load can hang with no bound, and
	 * until it settles the caller has nothing to record. A lock during that
	 * window used to complete, report success, and begin wiping storage while a
	 * signed-in `WebContents` stayed on screen.
	 *
	 * Keyed by account like the rest. A second open for the same account replaces
	 * the entry, and the first is closed by the `stillWanted` check that already
	 * governs concurrent opens.
	 *
	 * **A sweep that empties this map must empty `opening` too** — see
	 * {@link abandonOpening}. They describe the same attempt, and closing the
	 * window without releasing the record left the account unopenable for the
	 * life of the process.
	 */
	private readonly building = new Map<string, BrowserWindowHandle>();

	/**
	 * Opens that have started and not yet produced a window.
	 *
	 * **The map above only ever held finished windows, and that was the hole.**
	 * An open is four awaits long — proxy applied, route verified, cookie set,
	 * first page loaded — and for all of it there was no record anywhere that a
	 * window was on its way. So a second press created a second one, and only the
	 * later of the two was ever tracked; the earlier stayed on screen, signed in,
	 * invisible to the lock.
	 */
	private readonly opening = new Map<string, OpeningAttempt>();

	/**
	 * The route each `open` was *asked* for, from its first line.
	 *
	 * **`opening` is registered too late to police a route switch.** Changing an
	 * open account to another route tears the old window down first and awaits
	 * its storage wipe; only then is this attempt recorded. Throughout that wait
	 * the account is in no map at all, so `closeNotFullyRouted` — the sweep that
	 * makes `Require proxies` true of what is already running — walked straight
	 * past a Direct request that was seconds from producing a window.
	 *
	 * Set before any teardown and cleared in the same `finally` as `opening`, so
	 * there is no instant between "the user asked for this route" and "something
	 * can refuse it".
	 */
	private readonly requested = new Map<string, string>();

	/**
	 * The route each open window is actually on.
	 *
	 * **Because "one window per account" was answering a question nobody asked.**
	 * The account list offers two buttons — _Open browser_, routed, and _Direct_
	 * beside it — and this map was keyed by account alone. So somebody who opened
	 * an account directly to get past a Cloudflare check, finished, and then
	 * pressed the routed button was handed the **direct window back**, focused,
	 * with no proxy applied and nothing said. They had asked for the proxy in the
	 * one place the application lets them ask, and their real address kept going
	 * to Steam on that account.
	 *
	 * Focusing is right for a second press of the *same* button. It is exactly
	 * wrong for the other one.
	 */
	private readonly routes = new Map<string, string>();

	/**
	 * Bumped by `closeAll`, so an open that began before the lock cannot outlive
	 * it.
	 *
	 * `closeAll` sweeps the map. An open in flight is not in the map — it has not
	 * finished — so the sweep passed straight over it and the window appeared
	 * afterwards: a signed-in Steam window created **by** a locked vault, which
	 * is the one thing the lock is supposed to make impossible. Checking the
	 * counter after the last await is what closes that.
	 *
	 * Global here and per-account below, the same pair `ConfirmationsService`
	 * uses and for the same reason: a lock stops everything, a routing change
	 * stops one account.
	 */
	private generation = 0;
	private readonly epochs = new Map<string, number>();

	/**
	 * Session wipes that have started and not finished, per account.
	 *
	 * **A wipe outlives the call that started it.** `dropAccountRouting` fires
	 * `closeAccount` and moves on — it has to, every caller of it is a
	 * synchronous handler — so `clearStorageData` is still running after the map
	 * entry is gone. Press Trade in that gap and a *new* browser opened on the
	 * same partition, set its Steam cookie, and then the old wipe arrived and
	 * erased it: a window that signs itself out a moment after opening, for
	 * reasons nothing on screen could explain.
	 *
	 * So an open waits for a wipe that is still going, rather than racing it.
	 */
	private readonly clearing = new Map<string, Promise<void>>();

	/**
	 * Every account whose browser partition has ever been given a Steam cookie.
	 *
	 * **`windows` is a map of what is *open*, and the lock swept that.** So a
	 * window the user closed themselves had already removed its own entry, and
	 * `closeAll` then had nothing to wipe: the partition kept its `steamLoginSecure`
	 * until the process exited, and reopening the browser found it still signed
	 * in — which is the precise thing `closeAll` exists to prevent, defeated by
	 * the ordinary act of closing a window.
	 *
	 * A set rather than reusing `windows`, because the question is different.
	 * "Which windows are on screen" changes constantly; "which partitions hold a
	 * session that has to die with the vault" only ever grows within an unlock,
	 * and it includes the ones whose window never finished being built.
	 */
	private readonly seeded = new Set<string>();

	/**
	 * Partitions this process tried to empty and could not.
	 *
	 * **`clearStorageData` failing used to be swallowed and forgotten.** The
	 * marker that said "there is something here" was dropped in the same breath,
	 * so the next open reused the same deterministic partition — still holding
	 * the previous `steamLoginSecure` — without retrying and without refusing.
	 *
	 * That turns a transient failure into two of the things this module exists to
	 * prevent: a Steam session outliving the lock that ended it, and an account's
	 * old route and its new one sharing a cookie jar, which links them.
	 *
	 * An entry here is cleared only by a wipe that actually succeeds.
	 */
	private readonly dirty = new Set<string>();

	constructor(
		private readonly host: BrowserHost,
		/**
		 * Whether the vault currently refuses an unrouted window.
		 *
		 * **Asked again inside the open, not only at the door.** `browser/ipc.ts`
		 * checks this before calling `open`, which answers a question about the
		 * moment the button was pressed — and a route switch then tears the old
		 * window down and *awaits its storage wipe* before this attempt is
		 * registered anywhere. A sweep landing in that gap found nothing to
		 * refuse, and the Direct window arrived afterwards under a rule that
		 * forbids it. Re-asking after the teardown closes the gap with the rule
		 * itself rather than with a counter that the teardown's own epoch bump
		 * would swallow.
		 *
		 * Defaults to permissive so every existing test constructs unchanged; the
		 * refusal that matters is still `ipc.ts`'s, and this is the second one.
		 */
		private readonly requireProxies: () => boolean = () => false
	) {}

	/**
	 * What `closeAll` has bumped so far.
	 *
	 * Read by the IPC handler *before* it mints a Steam token, so a lock during
	 * that round trip is caught by the same counter as a lock during the open
	 * itself. Without it the handler's own `isUnlocked()` answered a question
	 * about the moment the button was pressed, and the mint takes seconds.
	 */
	/**
	 * This account's routing epoch right now.
	 *
	 * The per-account half of `generationNow`, and needed for the same reason:
	 * a caller that awaits something slow before calling `open` has to say
	 * *when* it asked. `open` defaults this parameter to the current value,
	 * which is right for a direct call and wrong for a deferred one — the
	 * default is read after the wait, so it compares the new epoch with itself
	 * and agrees.
	 *
	 * `browser/ipc.ts` mints a Steam token between the press and the open, and a
	 * proxy change or an account removal inside that window bumps this. Without
	 * capturing it first, the browser opened on the routing the user had just
	 * moved off, or for an account that was no longer in the vault.
	 */
	epochNow(steamId64: string): number {
		return this.epochOf(steamId64);
	}

	generationNow(): number {
		return this.generation;
	}

	/**
	 * @param since the generation this request belongs to. Defaults to now, which
	 * is right for a caller with nothing to do beforehand; the browser IPC
	 * handler passes the value it read before minting a token.
	 */
	async open(
		options: OpenBrowserOptions,
		since = this.generation,
		/**
		 * The account's routing epoch when this request was made.
		 *
		 * **The lock counter travelled with a retry and this did not.** A press of
		 * the other routing button waits for the open already running, then takes
		 * the decision again — and that retry re-read the epoch *fresh*, after any
		 * routing change that had happened while it waited. So saving a new proxy
		 * cancelled the request in flight, correctly, and the one queued behind it
		 * carried on and opened a signed-in Steam window through the proxy the
		 * user had just replaced.
		 */
		sinceEpoch = this.epochOf(options.steamId64)
	): Promise<void> {
		const wanted = routeKey(options);

		/*
		 * **Declared before anything is torn down, because there is a gap there.**
		 *
		 * Switching an open account to a different route closes the old window
		 * first and *awaits its storage wipe*, and only registers this attempt in
		 * `opening` afterwards. For the whole of that wipe, a `Require proxies`
		 * sweep saw neither the old window — already out of `windows` — nor the
		 * Direct request that was about to replace it. Measured: open proxied,
		 * hold the old partition's wipe, ask for Direct, turn the setting on and
		 * let its sweep finish, then release the wipe. Result: a second, live,
		 * unrouted window, created by an attempt the sweep had no way to see.
		 *
		 * A route is recorded here so the sweep can disown the *request* rather
		 * than only the window it has not produced yet. Cleared in the same
		 * `finally` that clears `opening`.
		 */
		this.requested.set(options.steamId64, wanted);
		try {
			await this.attempt(options, since, sinceEpoch, wanted);
		} finally {
			if (this.requested.get(options.steamId64) === wanted) {
				this.requested.delete(options.steamId64);
			}
		}
	}

	/** The body of `open`, so its route registration can wrap everything. */
	private async attempt(
		options: OpenBrowserOptions,
		since: number,
		sinceEpoch: number,
		wanted: string
	): Promise<void> {

		/*
		 * **Captured before the first await, not after the last one.**
		 *
		 * This used to be read further down, which was fine while everything above
		 * it was synchronous. Tearing down a window on a route switch put an
		 * `await` in front of it, and that reopened the hole the counter exists to
		 * close: a lock landing during the teardown would bump the generation, the
		 * capture below would read the *new* value, and the check would compare it
		 * with itself and agree — producing a signed-in Steam window after the
		 * vault had locked, which is the one thing this whole mechanism is for.
		 *
		 * Now it comes from the caller by default, which pushes the same reasoning
		 * one step further out: the request begins when the *user* asked, not when
		 * this method happened to be reached.
		 */
		const generation = since;

		/*
		 * A lock or a routing change that has already happened needs no await to
		 * be noticed. Checked here, at the door, and **before** the route-switch
		 * teardown below bumps the epoch on purpose — otherwise this request would
		 * cancel itself over its own cleanup.
		 */
		if (generation !== this.generation) {
			throw new BrowserSessionError(
				'the vault locked while the browser was opening, so it was closed'
			);
		}
		if (sinceEpoch !== this.epochOf(options.steamId64)) {
			throw new BrowserSessionError(
				"this account's routing changed while the browser was opening, so it was closed"
			);
		}

		// One window per account **on one route**. A second on the same route would
		// share the partition and the session, so it adds nothing except a way to
		// lose track of one.
		const existing = this.windows.get(options.steamId64);
		if (existing && !existing.isDestroyed()) {
			if (this.routes.get(options.steamId64) === wanted) {
				/*
				 * **Raised, not ignored.**
				 *
				 * The window is almost certainly behind the one the button was pressed
				 * in, so returning quietly makes the second press do nothing visible —
				 * and a user who cannot see the window they just asked for concludes the
				 * feature is broken and presses again. This screen's own copy button
				 * carries the rule: silently doing nothing is the one response a button
				 * must never give.
				 */
				existing.focus();
				return;
			}

			/*
			 * A different route was asked for, so the window on the old one goes.
			 *
			 * Closed and wiped rather than re-proxied. `setProxy` would change where
			 * the *next* request goes and leave the pages already on screen, and the
			 * cookies they collected, belonging to the previous route — a window that
			 * is half one thing and half the other, which is precisely the state the
			 * user pressed a button to leave. A fresh window has one answer for
			 * "where does this leave from", which is the only answer worth giving.
			 */
			await this.closeAccount(options.steamId64);
		}

		// A press while one is already opening joins it rather than starting a
		// second. The window takes a few seconds to appear, which is exactly long
		// enough for somebody to press again.
		const inFlight = this.opening.get(options.steamId64);
		if (inFlight) {
			if (inFlight.route === wanted) {
				await inFlight.done;
				this.windows.get(options.steamId64)?.focus();
				return;
			}
			/*
			 * The other button, pressed while this one was still opening. Let it
			 * finish or fail — its failure is not this caller's to report — and then
			 * take the decision again against whatever it left behind, which is the
			 * branch above.
			 */
			await inFlight.done.catch(() => undefined);
			/*
			 * **Carrying both counters, not starting fresh.**
			 *
			 * This recursed with no argument, so the retry read the counter *again*
			 * — after the lock that had just cancelled the request it was waiting
			 * on. So locking the vault cancelled the first open and the queued one
			 * went on to succeed, leaving exactly the window the lock existed to
			 * prevent. A request is cancelled by a lock once and stays cancelled.
			 */
			return this.open(options, generation, sinceEpoch);
		}

		// The epoch, unlike the generation, is read *here* — a route switch bumps it
		// deliberately a few lines above, and capturing it at the door would make
		// this open cancel itself over its own teardown.
		const epoch = this.epochOf(options.steamId64);

		/*
		 * **And the rule itself, re-asked now the teardown is over.**
		 *
		 * The epoch cannot carry this one. A route switch bumps it on purpose a
		 * few lines above, so it is re-read here — which means a sweep that bumped
		 * it during the teardown is absorbed by that re-read and vanishes.
		 * `Require proxies` turning on during the awaited wipe was therefore
		 * invisible to everything: the old window was already out of `windows`,
		 * this attempt was not yet in `opening`, and the counter that would have
		 * disowned it had just been re-read.
		 *
		 * Asking the rule directly has no such gap, and it is the same reader
		 * `ipc.ts` uses rather than a second source of truth.
		 */
		if (this.requireProxies() && !wanted.startsWith('proxy:')) {
			throw new BrowserSessionError(
				'this vault now requires every account to browse through its proxy, so the window ' +
					'was not opened. Choose “Through the proxy”, or turn the setting off in Settings.'
			);
		}

		const attempt = (async () => {
			/*
			 * **Synchronously, before anything is built.**
			 *
			 * A route switch tears the old window down first, and that teardown is
			 * awaited out in the caller — so a lock landing inside it went unnoticed
			 * until *after* `openAccountBrowser` had set the Steam cookie, created
			 * the window and loaded Steam into it. The generation check then closed
			 * what it had just finished making: right in the end, and a signed-in
			 * Steam window had existed and fetched a page for a locked vault to get
			 * there.
			 *
			 * No `await` above this line, so it runs in the tick the attempt starts
			 * — which is what makes it cost nothing and still catch that case.
			 */
			this.stillWanted(options.steamId64, generation, epoch);

			/*
			 * **Wait for any wipe still running on this partition.**
			 *
			 * `dropAccountRouting` fires `closeAccount` and does not await it, so
			 * saving a proxy and immediately pressing Trade raced the cleanup: the
			 * new window opened, set its Steam cookie, and the previous account's
			 * `clearStorageData` then erased it. A browser that signs itself out a
			 * second after opening, with nothing on screen able to explain why.
			 */
			const wiping = this.clearing.get(options.steamId64);
			if (wiping) {
				// Only when there is something to wait for. An unconditional `await`
				// here would put a microtask between this method being called and its
				// first real step, for every open, to serve the rare one.
				await wiping.catch(() => undefined);
				this.stillWanted(options.steamId64, generation, epoch);
			}

			/*
			 * Recorded *before* the attempt, not after it succeeds.
			 *
			 * `openAccountBrowser` sets the Steam cookie and then loads a page, and
			 * either half can fail. A failure between the two leaves a partition
			 * holding a live session with no window and no map entry anywhere —
			 * `abandon` cleans up the paths it knows about, and this is the backstop
			 * for the ones it does not.
			 */
			/*
			 * **A partition that could not be emptied is not reused.**
			 *
			 * Its name is derived from the account id, so this open lands on the
			 * exact jar the last teardown failed to clear — still holding whatever
			 * Steam set. Reusing it would put the previous session back on screen,
			 * or link an old route to a new one through a shared cookie.
			 *
			 * One retry first: the usual cause is a session that was momentarily
			 * unreachable, and it costs nothing to ask again before refusing
			 * something the user just asked for.
			 */
			if (this.dirty.has(options.steamId64)) {
				try {
					await this.sessionFor(options.steamId64).clearStorageData?.();
					this.mark(options.steamId64, true);
				} catch {
					this.mark(options.steamId64, false);
				}
				this.stillWanted(options.steamId64, generation, epoch);
				if (this.dirty.has(options.steamId64)) {
					throw new BrowserSessionError(
						'the previous browser session for this account could not be cleared, so a new ' +
							'window would reuse it. Lock and unlock the vault, or restart the app, before ' +
							'opening it again.'
					);
				}
			}

			this.seeded.add(options.steamId64);
			let window: BrowserWindowHandle;
			try {
				window = await openAccountBrowser(this.host, {
					...options,
					// Recorded while it is still being built, so a lock or a routing
					// change can close it without waiting for a load that may never
					// finish.
					onCreated: (created) => this.building.set(options.steamId64, created),
					onWipe: (cleared) => this.mark(options.steamId64, cleared),
					/*
					 * **The same two counters, asked from inside.**
					 *
					 * Checking them either side of this call treats the whole open as one
					 * step, and it is four awaits long. The check below covers a disown
					 * that arrives while the *page* loads; this covers the ones that
					 * arrive while the proxy is being applied and while the cookie is
					 * being written, which is where the window gets created.
					 */
					stillWanted: () => this.stillWanted(options.steamId64, generation, epoch)
				});
			} finally {
				// **In a `finally`, because the throwing paths matter as much.**
				// `openAccountBrowser` closes the window itself before rethrowing;
				// leaving the entry behind would hand a later sweep a destroyed
				// handle and, worse, make a retry look like it was still building.
				this.building.delete(options.steamId64);
			}
			if (generation !== this.generation || epoch !== this.epochOf(options.steamId64)) {
				// The vault locked, or this account's routing changed, while the
				// window was being built. Either way what just opened is signed in
				// under conditions that no longer hold.
				// **Recorded, like every other wipe.** Dropping this boolean meant a
				// partition emptied on the one path that exists to undo a signed-in
				// window was never marked when it failed — so the next open reused a
				// jar still holding the session this branch was cancelling.
				this.mark(options.steamId64, await abandon(window, this.sessionFor(options.steamId64)));
				throw new BrowserSessionError(
					generation !== this.generation
						? 'the vault locked while the browser was opening, so it was closed'
						: "this account's routing changed while the browser was opening, so it was closed"
				);
			}
			this.windows.set(options.steamId64, window);
			// Recorded with the window, so the next press can tell which button this
			// one came from.
			this.routes.set(options.steamId64, wanted);
			window.on('closed', () => {
				// Only if it is still ours. Deleting unconditionally let a window
				// that had already been replaced in the map remove its successor's
				// entry on the way out — leaving a live window the next lock could
				// not see.
				if (this.windows.get(options.steamId64) !== window) {
					return;
				}
				this.windows.delete(options.steamId64);
				this.routes.delete(options.steamId64);

				/*
				 * **And the session goes with it.**
				 *
				 * Closing the window used to be the one way to end a browsing session
				 * without ending the session: the entry left the map, so the vault
				 * lock had nothing to sweep, and `fromPartition` handed the same
				 * signed-in jar back the next time the account was opened. Reopening
				 * found Steam still logged in, with no passphrase asked for in
				 * between.
				 *
				 * Fired rather than awaited — this is an event handler — and safe to
				 * repeat: `wipe` serialises per account, so a close during a lock
				 * sweep queues behind it instead of racing it.
				 */
				void this.wipe(options.steamId64).catch(() => undefined);
			});
		})();

		/*
		 * **A second way for `done` to settle, because the first one can hang.**
		 *
		 * `attempt` ends with a page load, and a load has no bound — that is the
		 * premise the whole `building` map is written around. A sweep closes the
		 * half-built window, but closing it does not settle the promise a joiner
		 * is parked on, and nothing else ever will.
		 */
		// Named for what it does to the record, and **not** `abandon`: that is a
		// module function this method calls, and shadowing it here silently turned
		// the close-and-wipe on the cancelled-open path into a no-op.
		let giveUp: (reason: Error) => void = () => undefined;
		const abandoned = new Promise<never>((_, reject) => {
			giveUp = reject;
		});
		// Nobody awaits these two directly, and an unhandled rejection in the main
		// process is a crash on some Node builds. The joiners await `done`, which
		// rejects for them regardless of this handler.
		abandoned.catch(() => undefined);
		const done = Promise.race([attempt, abandoned]);
		done.catch(() => undefined);

		const entry: OpeningAttempt = { route: wanted, done, abandon: giveUp };
		this.opening.set(options.steamId64, entry);
		try {
			/*
			 * **`attempt`, not `done`** — this caller owns the attempt, and its
			 * promise means "everything I started has finished, cleanup included".
			 * Several callers and tests depend on that ordering.
			 *
			 * `done` is for the *joiners*, who own nothing and need only to be told
			 * when to stop waiting. Releasing this caller early instead would return
			 * from `open` before the window it built had been closed and its
			 * partition wiped.
			 *
			 * A load that never settles therefore still parks this caller. In
			 * Electron it does settle: closing the window destroys the contents and
			 * the load rejects — measured, not assumed, by
			 * tools/smoke-browser-window.mjs, which reports `ERR_FAILED (-2)` there.
			 * That is why teardown never waits for the load, and why a fake whose
			 * `loadURL` hangs is a worse case than production has.
			 */
			await attempt;
		} finally {
			if (this.opening.get(options.steamId64) === entry) {
				this.opening.delete(options.steamId64);
			}
		}
	}

	private epochOf(steamId64: string): number {
		return this.epochs.get(steamId64) ?? 0;
	}

	/**
	 * Give up on an open in flight: forget the record, and release the joiners.
	 *
	 * **Every sweep closed the half-built window and left this map alone**, and
	 * the two describe the same attempt. `open` deletes its own entry in a
	 * `finally`, which needs the attempt to settle — and the case the sweeps
	 * exist for is precisely the one where it does not, because the load hangs.
	 * So the entry outlived the window by the life of the process, and every
	 * later press for that account found it, joined it, and waited for ever: an
	 * account whose browser could not be opened again until a restart, with no
	 * error and nothing on screen.
	 *
	 * Measured before the fix, against a host whose `loadURL` never settles:
	 * `closeAll` closed the window and wiped the partition, and the next `open`
	 * was still pending 800ms later — as were `closeAccount`'s and
	 * `closeNotFullyRouted`'s.
	 */
	private abandonOpening(steamId64: string, message: string): void {
		const entry = this.opening.get(steamId64);
		if (!entry) {
			return;
		}
		this.opening.delete(steamId64);
		// The same sentence the attempt itself would have thrown at its next
		// `stillWanted`, which is the check it can no longer reach.
		entry.abandon(new BrowserSessionError(message));
	}

	/**
	 * Throw if a lock or a routing change has overtaken this request.
	 *
	 * One place, so every point that needs asking reads the same two counters the
	 * same way. Called before the window is built as well as after, because
	 * "built and then closed" still means a signed-in Steam window existed and
	 * loaded a page to get there.
	 */
	private stillWanted(steamId64: string, generation: number, epoch: number): void {
		if (generation !== this.generation) {
			throw new BrowserSessionError(
				'the vault locked while the browser was opening, so it was closed'
			);
		}
		if (epoch !== this.epochOf(steamId64)) {
			throw new BrowserSessionError(
				"this account's routing changed while the browser was opening, so it was closed"
			);
		}
	}

	private sessionFor(steamId64: string): BrowserSessionHandle {
		return this.host.sessionFromPartition(browserPartitionFor(steamId64), { cache: false });
	}

	/**
	 * Close a window and wipe its session, remembering the wipe until it is done.
	 *
	 * The remembering is the point: `closeAccount` is fired and forgotten by
	 * every caller, so without this a later `open` on the same partition could
	 * finish first and have its brand-new cookie erased by the previous
	 * account's cleanup.
	 */
	/** Record whether a wipe actually emptied the partition. */
	private mark(steamId64: string, cleared: boolean): void {
		if (cleared) {
			this.dirty.delete(steamId64);
		} else {
			this.dirty.add(steamId64);
		}
	}

	private async wipe(steamId64: string, window?: BrowserWindowHandle): Promise<void> {
		const done = (async () => {
			// Anything already wiping for this account finishes first, so two
			// overlapping teardowns cannot interleave with an open between them.
			await this.clearing.get(steamId64)?.catch(() => undefined);
			if (window) {
				this.mark(steamId64, await abandon(window, this.sessionFor(steamId64)));
				return;
			}
			try {
				await this.sessionFor(steamId64).clearStorageData?.();
				this.mark(steamId64, true);
			} catch {
				// **Remembered, not shrugged at.** The partition name is derived from
				// the account id, so the next open lands on this same jar — and it
				// still holds whatever Steam set.
				this.mark(steamId64, false);
			}
		})();
		this.clearing.set(steamId64, done);
		try {
			await done;
		} finally {
			if (this.clearing.get(steamId64) === done) {
				this.clearing.delete(steamId64);
			}
		}
	}

	/**
	 * Close and wipe one account's browser, because its routing changed or it is
	 * being removed.
	 *
	 * **The lock reached these windows and a proxy change did not.**
	 * `dropAccountRouting` dropped the transport's cookie jar and the cached
	 * access token, which is everything an account had *until this window
	 * existed*. The browser has its own session in its own partition, so saving a
	 * new proxy left a signed-in Steam window running on the old route — the
	 * previous address still attached to the account, in the one place the user
	 * is actually looking at Steam. Removing the account left the same window
	 * open for an account that no longer exists here.
	 *
	 * Cancels an open in flight too, through the per-account epoch: a routing
	 * change during those few seconds would otherwise be overtaken by the window
	 * it was meant to invalidate.
	 *
	 * **Never rejects**, for the same reason `closeAll` does not: every caller is
	 * a synchronous handler that fires this and moves on.
	 */
	async closeAccount(steamId64: string): Promise<void> {
		this.epochs.set(steamId64, this.epochOf(steamId64) + 1);
		// Wiped now, so the lock has nothing left to find for this account.
		this.seeded.delete(steamId64);
		const window = this.windows.get(steamId64);
		this.windows.delete(steamId64);
		this.routes.delete(steamId64);

		/*
		 * **And one still being built.** The epoch bump above disowns an open in
		 * flight, but only where it checks — after its last await. A load that
		 * hangs never reaches that check, so the window it would have closed goes
		 * on browsing over the route the user just replaced.
		 */
		const halfBuilt = this.building.get(steamId64);
		this.building.delete(steamId64);
		if (halfBuilt) {
			try {
				if (!halfBuilt.isDestroyed()) {
					halfBuilt.close();
				}
			} catch {
				// Already gone. Nothing left to close.
			}
		}
		// And the record of it, which the attempt can only clear by settling.
		this.abandonOpening(
			steamId64,
			"this account's routing changed while the browser was opening, so it was closed"
		);

		await this.wipe(steamId64, window);
	}

	/**
	 * Close every window that is not fully routed, and wipe its session.
	 *
	 * **Turning a rule on has to reach the work already running.** Saving
	 * `Require proxies` used to write a vault field and nothing else, so a Direct
	 * or Steam-only window opened a minute earlier stayed open, stayed signed in,
	 * and went on making requests the vault now forbade — and the user had just
	 * been told the opposite by the switch they pressed.
	 *
	 * `closeAccount` per offender rather than `closeAll`: a fully routed window
	 * satisfies the new rule and there is no reason to take it down. It also
	 * bumps that account's epoch, which cancels an open still in flight for it.
	 *
	 * An open that has not yet reached `routes` is invisible here, and is caught
	 * instead by the re-check `browser/ipc.ts` performs after minting. Neither
	 * mechanism covers the other's window on its own.
	 */
	async closeNotFullyRouted(): Promise<void> {
		/*
		 * **Opens in flight, invalidated first and synchronously.**
		 *
		 * A window that has not finished opening is not in `routes` yet, so a
		 * sweep reading only that map walked straight past the request most likely
		 * to be non-compliant — the one somebody started a second before turning
		 * the rule on. Bumping the epoch is what `open` re-reads after every
		 * await, so the request is disowned before its window can exist.
		 *
		 * Before any await, for the reason `closeAll` gives about its own counter:
		 * anything that runs later races the sweep, and wins.
		 */
		/*
		 * **And the routes only *asked* for, which `opening` does not yet hold.**
		 *
		 * A route switch tears the old window down and awaits its wipe before
		 * registering the new attempt, so for the length of that wipe the account
		 * appears in neither `windows` nor `opening`. A sweep in that gap saw
		 * nothing to refuse and the Direct window arrived afterwards, under a rule
		 * that forbids it. Bumping the epoch here disowns the request itself —
		 * `open` re-reads it after every await, including the one it is sitting in.
		 */
		for (const [steamId64, route] of [...this.requested]) {
			if (!route.startsWith('proxy:')) {
				this.epochs.set(steamId64, this.epochOf(steamId64) + 1);
			}
		}

		// Snapshotted, because `abandonOpening` deletes from this map.
		for (const [steamId64, entry] of [...this.opening]) {
			if (!entry.route.startsWith('proxy:')) {
				this.epochs.set(steamId64, this.epochOf(steamId64) + 1);

				/*
				 * **And close the window if one already exists.**
				 *
				 * The epoch bump above is read by `open` after every await, and a
				 * load that never settles never reaches one — which is the whole
				 * reason the window is handed over before the load rather than
				 * after. Bumping alone left the exact window this sweep exists for,
				 * signed in and unrouted, on screen under a rule that forbids it.
				 */
				const halfBuilt = this.building.get(steamId64);
				this.building.delete(steamId64);
				if (halfBuilt) {
					try {
						if (!halfBuilt.isDestroyed()) {
							halfBuilt.close();
						}
					} catch {
						// Already gone.
					}
					this.dirty.add(steamId64);
				}

				/*
				 * **And the record, whether or not a window had been built yet.**
				 *
				 * Outside the `halfBuilt` guard on purpose: an attempt disowned
				 * before it reached the window is still an attempt whose `finally`
				 * may never run, and leaving the entry behind makes 'Through the
				 * proxy' — the compliant route this sweep is asking the user to
				 * take — park for ever.
				 */
				this.abandonOpening(
					steamId64,
					"this account's routing changed while the browser was opening, so it was closed"
				);
			}
		}

		/*
		 * Then the windows already up. Snapshotted, because `closeAccount` deletes
		 * from the map being read — and closed **in parallel**, because each one
		 * ends in a session wipe. Awaited one at a time, a slow wipe on the first
		 * offender left the second window open, signed in, and making requests for
		 * as long as that took: the sweep's own bookkeeping holding the door for
		 * the thing it was sent to close.
		 *
		 * `closeAccount` never rejects, so nothing here needs a catch.
		 */
		const windowed = [...this.routes.entries()]
			.filter(([, key]) => !key.startsWith('proxy:'))
			.map(([steamId64]) => steamId64);
		await Promise.all(windowed.map((steamId64) => this.closeAccount(steamId64)));
	}

	/** True while a window for this account is on screen. */
	isOpen(steamId64: string): boolean {
		const window = this.windows.get(steamId64);
		return window !== undefined && !window.isDestroyed();
	}

	/**
	 * Close every window, then wipe every browser session.
	 *
	 * Called when the vault locks.
	 *
	 * **Windows first, storage second.** The other order clears a session out
	 * from under a page that is still on screen and still able to make requests
	 * with what it already holds — which is a strange half-state to leave a
	 * signed-in Steam tab in, and slower to reach the thing that matters. Closing
	 * first stops the page; the wipe then removes what it was using.
	 *
	 * **Never rejects.** Every other call in `onLock` is synchronous, so this one
	 * is fired and not awaited; a rejection would surface as an unhandled one
	 * with nothing to catch it, at the exact moment the application is supposed
	 * to be making itself safe. Failures are swallowed per account for the same
	 * reason a sweep should not abort halfway: one window that was already gone
	 * must not leave the others signed in.
	 */
	async closeAll(): Promise<void> {
		/*
		 * **First, and synchronously.**
		 *
		 * This is what an open in flight checks after its last await. Bumping it
		 * before anything else means a window still being built is already
		 * disowned by the time it exists, rather than racing the sweep below —
		 * which it would win, because the sweep only knows about windows that have
		 * finished opening.
		 */
		this.generation += 1;

		// Snapshot before clearing, so a window removing itself on `closed`
		// cannot mutate what is being iterated.
		const closing = new Map(this.windows);
		this.windows.clear();
		this.routes.clear();

		/*
		 * **And the ones still being built**, which is the case this sweep used to
		 * miss entirely.
		 *
		 * Bumping `generation` above disowns an open in flight, but only where it
		 * checks — after its last await. A load that never settles never gets
		 * there, so the disown never runs and the window it would have closed
		 * stays on screen, signed in, while this method reports the vault locked
		 * and goes on to wipe its storage.
		 *
		 * Closing them here needs no await: the handle exists, and that is the
		 * whole reason it was recorded before the load rather than after it.
		 *
		 * Kept out of `closing`, whose keys become the partitions to wipe below.
		 * These accounts are already in `seeded` — added before the attempt, for
		 * exactly this reason — so their partitions are covered without inventing
		 * a key that is not an account id.
		 */
		const halfBuilt = [...this.building.values()];
		this.building.clear();

		/*
		 * **And every record of an open in flight**, built or not.
		 *
		 * `open` clears its own entry when the attempt settles, and a hung load
		 * never settles — so before this, a lock during an open left the account
		 * unopenable after the next unlock, for the life of the process: every
		 * press joined the dead attempt and waited.
		 */
		for (const steamId64 of [...this.opening.keys()]) {
			this.abandonOpening(
				steamId64,
				'the vault locked while the browser was opening, so it was closed'
			);
		}

		/*
		 * Every partition seeded this unlock, not only the ones still on screen.
		 * A window the user closed themselves is exactly the case the map cannot
		 * answer for, and it is the common one.
		 */
		/*
		 * **And every partition a previous teardown failed to empty.**
		 *
		 * `closeAccount` removes the account from `seeded` before it wipes, so a
		 * wipe that then failed left it in neither map — and this sweep, built
		 * from those two, issued no clear for it at all. The refusal a later open
		 * gives tells the user to lock and unlock the vault, which is advice this
		 * sweep could not act on. Now it can, and that is the whole reason the
		 * message says it.
		 */
		const partitions = new Set([...closing.keys(), ...this.seeded, ...this.dirty]);
		this.seeded.clear();

		for (const window of [...closing.values(), ...halfBuilt]) {
			try {
				if (!window.isDestroyed()) {
					window.close();
				}
			} catch {
				// Already gone, or going. Either way there is nothing left to close.
			}
		}

		// Through the same tracker the routing path uses, so an open that begins
		// during a lock sweep waits for the wipe rather than racing it.
		await Promise.all([...partitions].map((steamId64) => this.wipe(steamId64)));
	}
}

/** Is this address one of Valve's, over https? */
export function isSteamHost(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === 'https:' && STEAM_HOSTS.includes(parsed.hostname.replace(/^www\./, ''))
		);
	} catch {
		return false;
	}
}

/**
 * What the user typed in the address bar, as something safe to load — or
 * nothing.
 *
 * **The schemes matter more than the convenience.** A browser address bar
 * accepts `javascript:` in some browsers and `file:` in most, and either would
 * be a mistake here: `javascript:` runs in whatever origin the page currently
 * holds, which is a signed-in Steam session, and `file:` reads the user's disk
 * from a window that a moment ago was showing somebody else's website. Only
 * `http` and `https` are honoured; anything else is refused rather than
 * guessed at.
 *
 * Text with no scheme is treated as a host, the way every browser does it, so
 * `steamcommunity.com/market` works without typing the protocol.
 */
export function addressToUrl(typed: string): string | undefined {
	const text = typed.trim();
	if (text === '') {
		return undefined;
	}

	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
	if (scheme) {
		const named = (scheme[1] ?? '').toLowerCase();
		if (named !== 'http' && named !== 'https') {
			return undefined;
		}
		try {
			return new URL(text).toString();
		} catch {
			return undefined;
		}
	}

	try {
		const guessed = new URL(`https://${text}`);
		// A bare word with no dot is more likely a mistake than a hostname, and
		// silently loading `https://trade/` helps nobody.
		return guessed.hostname.includes('.') ? guessed.toString() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * What the window is called, which is the only place its address is shown.
 *
 * **The threat model promised this and the window did not have it.** That
 * section accepts the largest risk here — the user can navigate anywhere,
 * because a browser that reached one page could not finish a trade — and the
 * mitigation it named was that the address stays visible. It was not visible
 * anywhere: a plain `BrowserWindow` has no address bar, and the title was
 * frozen to the account name.
 *
 * So somebody who followed a link out of Steam saw this application's chrome
 * and their own account name above a page that was not Steam, which makes a
 * phishing page look *more* trustworthy rather than less. That is the precise
 * deception `/scam-clones` exists to warn people about, reproduced in our own
 * window.
 *
 * The host, not the full URL: phishing is a question about who you are talking
 * to, and a long path pushes the answer off the end of a title bar. Anything
 * that is not Steam is labelled rather than merely shown, because "not Steam"
 * is the fact worth reading, and a hostname alone asks the reader to know
 * Valve's domains by heart.
 */
export function titleFor(accountName: string, url: string): string {
	let host: string;
	try {
		host = new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return accountName;
	}
	if (host === '') {
		return accountName;
	}
	return isSteamHost(url) ? `${accountName} — ${host}` : `${accountName} — NOT STEAM: ${host}`;
}

/**
 * Which route a request to open a browser is asking for.
 *
 * The *effective* route, not the raw switch: an account with no proxy is direct
 * whichever route is asked for, so pressing the same button twice on such an
 * account must not be read as changing anything. What matters is where the
 * traffic actually leaves from, because that is the fact the user pressed a
 * button to choose.
 *
 * The proxy URL rather than a bare "routed": if the stored proxy changed, the
 * open window is on an address the account no longer uses.
 * `dropAccountRouting` already closes it when the change goes through this
 * process, and this is the belt to that braces.
 */
function routeKey(options: OpenBrowserOptions): string {
	return options.route !== 'direct' && options.proxyUrl !== undefined && options.proxyUrl !== ''
		? `${options.route}:${options.proxyUrl}`
		: 'direct';
}

/** The partition name, kept in one place so the wipe and the open agree. */
export function browserPartitionFor(steamId64: string): string {
	// No `persist:` prefix, matching the account transport: a signed-in Steam
	// session must not outlive the process, let alone the vault lock.
	return `browser-${steamId64}`;
}

/**
 * Hand Steam's own cookie to the browser, rather than driving a login form.
 *
 * `steamLoginSecure` is `steamid||token`, which is what Steam's web session is
 * underneath. Setting it directly means no password is typed into a window this
 * application opened — the user's password never exists in this process at all,
 * which is the property `THREAT_MODEL` claims and the reason not to build a
 * convenient login box here.
 */
async function signIn(
	session: BrowserSessionHandle,
	steamId64: string,
	accessToken: string
): Promise<void> {
	const value = `${steamId64}%7C%7C${accessToken}`;
	for (const url of COOKIE_HOSTS) {
		await session.cookies.set({
			url,
			name: 'steamLoginSecure',
			value,
			path: '/',
			secure: true,
			httpOnly: true
		});
	}
}
