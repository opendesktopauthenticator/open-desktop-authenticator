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
	close(): void;
	isDestroyed(): boolean;
	on(event: 'closed', listener: () => void): void;
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

	await window.loadURL(START_URL);
	return window;
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
