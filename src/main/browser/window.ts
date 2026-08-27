import { planProxy, type ProxyPlan } from '../net/egress';

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
	setProxy(config: { mode?: string; proxyRules?: string }): Promise<void>;
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
	 * A freshly minted access token.
	 *
	 * Passed in rather than minted here, so this module never touches the vault
	 * and never sees a refresh token. What it receives is short-lived and
	 * account-scoped — the smallest credential that does the job.
	 */
	accessToken: string;
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
	if (options.proxyUrl !== undefined && options.proxyUrl !== '') {
		// Validated before use, for the same reason the transport does it: a
		// scheme Chromium does not know is accepted by `setProxy` without
		// complaint and fails much later, per request, as an error the user
		// cannot connect back to the address they typed.
		plan = planProxy(options.proxyUrl);
	}

	try {
		await session.setProxy(
			plan ? { mode: 'fixed_servers', proxyRules: plan.proxyRules } : { mode: 'direct' }
		);
	} catch (cause) {
		throw new BrowserSessionError(
			plan
				? `the browser could not be routed through ${plan.redacted}, so it was not opened`
				: 'the browser session could not be prepared',
			{ cause }
		);
	}

	await signIn(session, options.steamId64, options.accessToken);

	const window = host.createWindow({
		width: 1280,
		height: 860,
		title: `${options.accountName} — browser`,
		partition,
		userAgent: BROWSER_USER_AGENT
	});

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
	window.on('navigated', (url) => {
		window.setTitle(titleFor(options.accountName, url));
	});

	/*
	 * **Nothing below here may leave a window behind.**
	 *
	 * From this point there is a window on screen holding a signed-in session,
	 * and `AccountBrowsers` has not recorded it — it records what this function
	 * returns. So anything that throws from here leaves a signed-in Steam window
	 * that the vault lock cannot reach and the user cannot see the origin of.
	 * Both exits below close it and wipe the session before rethrowing.
	 */
	try {
		await window.loadURL(START_URL);
	} catch (cause) {
		await abandon(window, session);
		throw new BrowserSessionError('the browser could not reach Steam, so it was closed', {
			cause
		});
	}

	if (looksSignedOut(window.currentUrl())) {
		await abandon(window, session);
		throw new BrowserSignInRequired(
			`Steam did not accept the saved session for ${options.accountName}. ` +
				'Sign in to that account again.'
		);
	}

	return window;
}

/** Steam's own hosts, and the only ones a signed-in landing may be on. */
const STEAM_HOSTS = ['steamcommunity.com', 'store.steampowered.com', 'help.steampowered.com'];

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
	return /^\/login(\/|$)/i.test(parsed.pathname);
}

/**
 * Close a window that should never have stayed open, and take its session with
 * it.
 *
 * Swallows both failures on purpose: this runs on the way to throwing something
 * the caller needs to see, and a secondary error here would replace it with a
 * less useful one.
 */
async function abandon(window: BrowserWindowHandle, session: BrowserSessionHandle): Promise<void> {
	try {
		if (!window.isDestroyed()) {
			window.close();
		}
	} catch {
		// Already gone.
	}
	try {
		await session.clearStorageData?.();
	} catch {
		// The window is closed either way; an unreachable session is the lesser
		// problem and still worth having tried to remove.
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
export class AccountBrowsers {
	private readonly windows = new Map<string, BrowserWindowHandle>();

	constructor(private readonly host: BrowserHost) {}

	async open(options: OpenBrowserOptions): Promise<void> {
		// One window per account. A second would share the partition and the
		// session, so it adds nothing except a way to lose track of one.
		const existing = this.windows.get(options.steamId64);
		if (existing && !existing.isDestroyed()) {
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
		const window = await openAccountBrowser(this.host, options);
		this.windows.set(options.steamId64, window);
		window.on('closed', () => {
			this.windows.delete(options.steamId64);
		});
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
		// Snapshot before clearing, so a window removing itself on `closed`
		// cannot mutate what is being iterated.
		const closing = new Map(this.windows);
		this.windows.clear();

		for (const window of closing.values()) {
			try {
				if (!window.isDestroyed()) {
					window.close();
				}
			} catch {
				// Already gone, or going. Either way there is nothing left to close.
			}
		}

		await Promise.all(
			[...closing.keys()].map(async (steamId64) => {
				try {
					const session = this.host.sessionFromPartition(browserPartitionFor(steamId64), {
						cache: false
					});
					await session.clearStorageData?.();
				} catch {
					// The window is already closed; a session that outlives it is
					// unreachable but still worth having tried to remove.
				}
			})
		);
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
	return STEAM_HOSTS.includes(host)
		? `${accountName} — ${host}`
		: `${accountName} — NOT STEAM: ${host}`;
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
