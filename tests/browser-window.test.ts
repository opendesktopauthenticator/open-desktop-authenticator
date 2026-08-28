import { describe, expect, it, vi } from 'vitest';
import {
	AccountBrowsers,
	BROWSER_USER_AGENT,
	addressToUrl,
	BrowserSessionError,
	BrowserSignInRequired,
	isSteamHost,
	titleFor,
	browserPartitionFor,
	looksSignedOut,
	openAccountBrowser,
	START_URL,
	type BrowserHost,
	type BrowserSessionHandle,
	type BrowserWindowHandle,
	type BrowserWindowOptions
} from '../src/main/browser/window';
import { STEAM_USER_AGENT } from '../src/main/net/egress';

/**
 * The in-app browser, and the two properties that make it safe to open.
 *
 * It is signed in and it is routed. Both are worth asserting rather than
 * assuming, because the failure modes are silent: a browser that quietly used
 * the machine's own address would attach a home IP to an account the user was
 * careful to route, and would do it while they were logged in and trading.
 */

interface Recorded {
	partitions: string[];
	proxies: unknown[];
	userAgents: string[];
	cookies: { url: string; name: string; value: string }[];
	windows: BrowserWindowOptions[];
	loaded: string[];
	/** Windows that were closed, and sessions that were wiped, after a bad landing. */
	closed: number;
	wiped: string[];
	/** Times an already-open window was raised instead of a new one being made. */
	focused: number;
	/** Every title the window was given, in order. */
	titles: string[];
	/** Every WebRTC policy the window was given. */
	webRtcPolicies: string[];
	/** Times this session was told to refuse permission requests. */
	permissionsDenied: number;
}

function harness(
	overrides: {
		setProxy?: () => Promise<void>;
		landsOn?: string;
		loadFails?: boolean;
		/** What Chromium claims it would actually do. Defaults to obeying setProxy. */
		resolvesTo?: string;
	} = {}
) {
	// Per-harness, not module-level: two tests sharing one of these is how a
	// fake starts reporting the previous test's partition.
	let partitionName = '';
	/** Set once the window subscribes; a test calls it to move the window. */
	let navigate: (url: string) => void = () => undefined;
	const recorded: Recorded = {
		partitions: [],
		proxies: [],
		userAgents: [],
		cookies: [],
		windows: [],
		loaded: [],
		closed: 0,
		wiped: [],
		focused: 0,
		titles: [],
		webRtcPolicies: [],
		permissionsDenied: 0
	};

	const session: BrowserSessionHandle = {
		denyPermissions: () => {
			recorded.permissionsDenied += 1;
		},
		/*
		 * Answers with whatever the last `setProxy` asked for, which is the honest
		 * default: a fake that always reported the intended proxy would make the
		 * verification untestable, and one that always disagreed would make every
		 * proxy test fail. `resolvesTo` is how a test says Chromium disagreed.
		 */
		resolveProxy: () => {
			if (overrides.resolvesTo !== undefined) {
				return Promise.resolve(overrides.resolvesTo);
			}
			const last = recorded.proxies.at(-1) as { mode?: string; proxyRules?: string } | undefined;
			if (!last || last.mode !== 'fixed_servers' || last.proxyRules === undefined) {
				return Promise.resolve('DIRECT');
			}
			return Promise.resolve(`PROXY ${last.proxyRules.replace(/^[a-z0-9]+:\/\//, '')}`);
		},
		setProxy:
			overrides.setProxy ??
			((config) => {
				recorded.proxies.push(config);
				return Promise.resolve();
			}),
		setUserAgent: (ua) => recorded.userAgents.push(ua),
		clearStorageData: () => {
			recorded.wiped.push(partitionName);
			return Promise.resolve();
		},
		cookies: {
			set: (cookie) => {
				recorded.cookies.push({ url: cookie.url, name: cookie.name, value: cookie.value });
				return Promise.resolve();
			}
		}
	};

	const window: BrowserWindowHandle = {
		loadURL: (url) => {
			recorded.loaded.push(url);
			return overrides.loadFails === true
				? Promise.reject(new Error('ERR_TUNNEL_CONNECTION_FAILED'))
				: Promise.resolve();
		},
		// Deliberately a separate fact from what `loadURL` was handed. A fake that
		// always echoes the requested URL back can never land anywhere else, which
		// is the one thing `looksSignedOut` exists to notice.
		currentUrl: () => overrides.landsOn ?? START_URL,
		setTitle: (title) => recorded.titles.push(title),
		setWebRtcPolicy: (policy) => recorded.webRtcPolicies.push(policy),
		focus: () => {
			recorded.focused += 1;
		},
		close: () => {
			recorded.closed += 1;
		},
		isDestroyed: () => false,
		on: (event: string, listener: unknown) => {
			if (event === 'navigated') {
				navigate = listener as (url: string) => void;
			}
		},
		setWindowOpenHandler: vi.fn()
	};

	const host: BrowserHost = {
		sessionFromPartition: (partition) => {
			recorded.partitions.push(partition);
			partitionName = partition;
			return session;
		},
		createWindow: (options) => {
			recorded.windows.push(options);
			return window;
		}
	};

	return { host, recorded, go: (url: string) => navigate(url) };
}

const ACCOUNT = {
	steamId64: '76561198000000001',
	accountName: 'demo_trader',
	accessToken: 'eyJhbGciOiJFZERTQSJ9.token.signature',
	// Opted in, so every existing routing test still asks for routing.
	useProxy: true
};

describe('the in-app browser', () => {
	it('uses its own partition, never the account transport’s', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);

		expect(recorded.partitions).toEqual([browserPartitionFor(ACCOUNT.steamId64)]);
		// The transport's partition is `steam-<id>`. Sharing it would mean either
		// serving Steam's web pages to an okhttp client or stripping the disguise
		// off the app's own requests.
		expect(recorded.partitions[0]).not.toBe(`steam-${ACCOUNT.steamId64}`);
	});

	it('keeps the session out of the browser’s reach after the process ends', () => {
		// No `persist:` prefix means in-memory: a signed-in Steam session must not
		// outlive the process, let alone survive on disk.
		expect(browserPartitionFor(ACCOUNT.steamId64)).not.toContain('persist:');
	});

	/*
	 * The whole reason for a second session. `okhttp/4.9.2` is a deliberate lie
	 * told by the transport so accounts do not stand out from one another; told
	 * by a browser it produces a page that does not work.
	 */
	it('presents as a real browser, not as the mobile app', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);

		expect(recorded.userAgents).toContain(BROWSER_USER_AGENT);
		expect(recorded.userAgents).not.toContain(STEAM_USER_AGENT);
		expect(BROWSER_USER_AGENT).not.toContain('okhttp');
	});

	/*
	 * **A partition inherits none of the application's hardening.**
	 *
	 * §P8 refuses every permission request, and `src/main/index.ts` applies that
	 * to `session.defaultSession`. This window runs in a partition of its own, so
	 * it got none of it — and Electron with no handler installed *approves*. A
	 * page nobody here wrote could ask for a camera, a microphone or a location
	 * and be granted it, in a window signed in to somebody's Steam account.
	 *
	 * Steam needs none of them, so the answer is the same as everywhere else.
	 */
	it('refuses every permission request on its own session', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);
		expect(recorded.permissionsDenied, 'the partition kept Electron’s defaults').toBe(1);
	});

	it('refuses them before the first page loads', async () => {
		// A page cannot be asked to wait while we decide whether it may use a
		// camera; the handler has to be installed before anything runs.
		const order: string[] = [];
		const { host } = harness();
		const wrapped: BrowserHost = {
			sessionFromPartition: (partition, options) => {
				const real = host.sessionFromPartition(partition, options);
				return {
					...real,
					denyPermissions: () => order.push('deny'),
					cookies: {
						set: (cookie) => {
							order.push('cookie');
							return real.cookies.set(cookie);
						}
					}
				};
			},
			createWindow: (options) => {
				order.push('window');
				return host.createWindow(options);
			}
		};

		await openAccountBrowser(wrapped, ACCOUNT);
		expect(order[0]).toBe('deny');
	});

	it('routes through the account’s proxy when it has one', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://user:hunter2@10.0.0.9:8080' });

		expect(recorded.proxies).toHaveLength(1);
		expect(recorded.proxies[0]).toMatchObject({ mode: 'fixed_servers' });
		expect(JSON.stringify(recorded.proxies[0])).toContain('10.0.0.9:8080');
		/*
		 * Credentials belong to the proxy, never to a rule string.
		 *
		 * The password here was `pass`, and this assertion started failing the day
		 * `proxyBypassRules` was added — because "Bypass" contains "pass". It was
		 * passing on a coincidence, and would have gone on passing if the real
		 * password had ever been a substring of a key name. A distinctive secret
		 * is the point of the check.
		 */
		expect(JSON.stringify(recorded.proxies[0])).not.toContain('hunter2');
	});

	/**
	 * **When the proxy is chosen, nothing skips it.**
	 *
	 * Chromium bypasses loopback and link-local addresses by default, so
	 * "routed" quietly meant "routed except for a list nobody was shown".
	 * `<-loopback>` removes that default rather than adding to it.
	 */
	it('leaves nothing outside the proxy', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080' });
		expect(recorded.proxies[0]).toMatchObject({ proxyBypassRules: '<-loopback>' });
	});

	/*
	 * A proxy carries HTTP. WebRTC opens its own UDP and hands a page the
	 * machine's real local and public addresses — the one leak that survives a
	 * correctly applied proxy, in the window where the user has been told their
	 * traffic is routed.
	 */
	it('stops WebRTC going around the proxy', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080' });
		expect(recorded.webRtcPolicies).toEqual(['disable_non_proxied_udp']);
	});

	it('leaves WebRTC alone when the window is not routed', async () => {
		// Nothing to leak around: this window is already on the machine's address,
		// and breaking peer connections for no reason is not hardening.
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);
		expect(recorded.webRtcPolicies).toEqual(['default']);
	});

	/**
	 * **Configured is not applied.**
	 *
	 * `setProxy` resolving means the settings were accepted. `transport.ts` has
	 * refused to send a request without asking `resolveProxy` what would actually
	 * happen, because a proxy that is configured and not applied is the one
	 * failure that looks exactly like success. This window was opening on the
	 * strength of the configuration alone.
	 */
	it('opens no window when Chromium would route it somewhere else', async () => {
		const { host, recorded } = harness({ resolvesTo: 'PROXY 10.9.9.9:3128' });

		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080' })
		).rejects.toBeInstanceOf(BrowserSessionError);

		expect(recorded.windows, 'a window was opened on an unverified route').toHaveLength(0);
	});

	it('opens no window when Chromium would go direct', async () => {
		const { host, recorded } = harness({ resolvesTo: 'DIRECT' });

		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080' })
		).rejects.toThrow(/would not/i);

		expect(recorded.windows).toHaveLength(0);
	});

	it('names the proxy in that refusal without leaking its password', async () => {
		const { host } = harness({ resolvesTo: 'DIRECT' });
		const open = () =>
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://user:hunter2@10.0.0.9:8080' });
		await expect(open()).rejects.toThrow(/10\.0\.0\.9:8080/);
		await expect(open()).rejects.not.toThrow(/hunter2/);
	});

	/**
	 * The user's choice, and the reason it exists: a shared proxy address
	 * collects rate limits and Cloudflare challenges a home connection never
	 * sees, so the routed window is sometimes the one that will not load.
	 */
	it('goes direct when the user asked it to, even with a proxy stored', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://10.0.0.9:8080',
			useProxy: false
		});

		expect(recorded.proxies[0]).toMatchObject({ mode: 'direct' });
		expect(recorded.windows, 'the window should still open').toHaveLength(1);
	});

	it('does not verify a route it was not asked to take', async () => {
		// `resolvesTo` says Chromium would go direct — which is what was asked for.
		const { host, recorded } = harness({ resolvesTo: 'DIRECT' });
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://10.0.0.9:8080',
			useProxy: false
		});
		expect(recorded.windows).toHaveLength(1);
	});

	it('connects directly when the account has no proxy', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);
		expect(recorded.proxies[0]).toMatchObject({ mode: 'direct' });
	});

	/*
	 * The case this file exists for.
	 *
	 * An account with routing configured must never reach Steam from the user's
	 * own address. Everywhere else in this application that rule is "make no
	 * connection at all"; here it is "open no window", which is the same rule
	 * where the unit of work is a window.
	 */
	it('opens no window at all if a configured proxy cannot be applied', async () => {
		const { host, recorded } = harness({
			setProxy: () => Promise.reject(new Error('ERR_PROXY_CONNECTION_FAILED'))
		});

		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080' })
		).rejects.toBeInstanceOf(BrowserSessionError);

		expect(recorded.windows, 'a window was opened despite routing failing').toHaveLength(0);
		expect(recorded.loaded).toHaveLength(0);
	});

	it('names the proxy in the failure without leaking its password', async () => {
		const { host } = harness({
			setProxy: () => Promise.reject(new Error('nope'))
		});

		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://user:hunter2@10.0.0.9:8080' })
		).rejects.toThrow(/10\.0\.0\.9:8080/);
		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://user:hunter2@10.0.0.9:8080' })
		).rejects.not.toThrow(/hunter2/);
	});

	it('refuses a proxy scheme Chromium cannot use, before opening anything', async () => {
		const { host, recorded } = harness();
		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'ftp://10.0.0.9:8080' })
		).rejects.toThrow();
		expect(recorded.windows).toHaveLength(0);
	});

	it('signs in with Steam’s own cookie on both hosts it is needed', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);

		const hosts = recorded.cookies.map((c) => c.url);
		expect(hosts).toContain('https://steamcommunity.com');
		expect(hosts).toContain('https://store.steampowered.com');
		for (const cookie of recorded.cookies) {
			expect(cookie.name).toBe('steamLoginSecure');
			expect(cookie.value).toContain(ACCOUNT.steamId64);
			expect(cookie.value).toContain(ACCOUNT.accessToken);
		}
	});

	it('lands on the trade offers page', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);
		expect(recorded.loaded).toEqual([START_URL]);
		expect(START_URL.startsWith('https://steamcommunity.com/')).toBe(true);
	});
});

/**
 * Asking for a page is not the same as landing on it.
 *
 * Everything above this point is about what the window is *given*: a partition,
 * a proxy, a user agent, a cookie. None of it establishes the thing the feature
 * actually promises, which is that Steam accepted the session — that is a fact
 * about Valve's servers, and the only place it shows up is the URL the main
 * frame ended on.
 *
 * The refusal in `ipc.ts` checks for a stored refresh token, which is a proxy
 * for this and not the thing itself: a token can exist and be declined. Until
 * these tests the gap between the two was invisible, and what fell into it was
 * a Steam login form inside a window this application drew.
 */
describe('where the window actually ended up', () => {
	it.each([
		['the trade offers page', 'https://steamcommunity.com/my/tradeoffers/', false],
		['a market listing', 'https://steamcommunity.com/market/listings/730/x', false],
		['the store, signed in', 'https://store.steampowered.com/account/', false],
		['a www. host', 'https://www.steamcommunity.com/my/tradeoffers/', false],
		[
			'the community login page',
			'https://steamcommunity.com/login/home/?goto=my%2Ftradeoffers',
			true
		],
		['the store login page', 'https://store.steampowered.com/login/', true],
		['help, signed out', 'https://help.steampowered.com/login/', true],
		['a page that never loaded', 'about:blank', true],
		['nothing at all', '', true],
		['something that is not a URL', 'not a url', true],
		['a host that is not Steam', 'https://steamcommunity.com.evil.example/my/', true],
		['plain http, even on Steam', 'http://steamcommunity.com/my/tradeoffers/', true]
	])('%s', (_name, url, signedOut) => {
		expect(looksSignedOut(url)).toBe(signedOut);
	});

	/*
	 * The case the whole check exists for.
	 *
	 * A user shown a Steam login form inside this application is being taught the
	 * exact habit every page on the site tells them to refuse. So the window does
	 * not stay open to be looked at — it closes, and its session goes with it.
	 */
	it('closes the window and wipes the session when Steam sent us to a login page', async () => {
		const { host, recorded } = harness({
			landsOn: 'https://steamcommunity.com/login/home/?goto=my%2Ftradeoffers'
		});

		await expect(openAccountBrowser(host, ACCOUNT)).rejects.toBeInstanceOf(BrowserSignInRequired);

		expect(recorded.closed, 'a login page was left on screen').toBe(1);
		expect(recorded.wiped, 'the declined session was left in place').toEqual([
			browserPartitionFor(ACCOUNT.steamId64)
		]);
	});

	it('says which account to sign in to, and does not call it a failure', async () => {
		const { host } = harness({ landsOn: 'https://steamcommunity.com/login/home/' });
		await expect(openAccountBrowser(host, ACCOUNT)).rejects.toThrow(/demo_trader/);
		await expect(openAccountBrowser(host, ACCOUNT)).rejects.toThrow(/sign in/i);
	});

	/*
	 * A window that failed to load is still a window, holding a signed-in
	 * session, and `AccountBrowsers` has not recorded it yet — it records what
	 * `openAccountBrowser` returns. So an unhandled throw here left a Steam
	 * window on screen that the vault lock could not reach.
	 */
	it('closes the window when the page could not be reached at all', async () => {
		const { host, recorded } = harness({ loadFails: true });

		await expect(openAccountBrowser(host, ACCOUNT)).rejects.toBeInstanceOf(BrowserSessionError);

		expect(recorded.closed, 'a window survived a failed load').toBe(1);
		expect(recorded.wiped).toEqual([browserPartitionFor(ACCOUNT.steamId64)]);
	});

	it('never records a window it did not open successfully', async () => {
		const { host } = harness({ landsOn: 'https://steamcommunity.com/login/home/' });
		const browsers = new AccountBrowsers(host);

		await expect(browsers.open(ACCOUNT)).rejects.toBeInstanceOf(BrowserSignInRequired);

		// If it had been recorded, the next attempt would be treated as "already
		// open" and quietly do nothing, leaving the user with no window and no
		// error either.
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
	});
});

/**
 * The only place this window shows its address.
 *
 * The threat model accepts the biggest risk here — the user may navigate
 * anywhere, because a browser that reached one page could not finish a trade —
 * and the mitigation it named was that the address stays visible. It was not:
 * a plain window has no address bar, and the title was pinned to the account
 * name. Somebody who followed a link off Steam saw this application's chrome
 * and their own account name above a page that was not Steam, which makes a
 * fake page look better rather than worse.
 */
describe('the window says where it is', () => {
	it.each([
		['steam', 'https://steamcommunity.com/my/tradeoffers/', 'demo_trader — steamcommunity.com'],
		[
			'the store',
			'https://store.steampowered.com/account/',
			'demo_trader — store.steampowered.com'
		],
		['a www host', 'https://www.steamcommunity.com/market/', 'demo_trader — steamcommunity.com'],
		[
			'a lookalike',
			'https://steamcommunity.com.evil.example/login',
			'demo_trader — NOT STEAM: steamcommunity.com.evil.example'
		],
		['anywhere else', 'https://example.org/x', 'demo_trader — NOT STEAM: example.org'],
		// Nothing loaded yet: the account name alone, never "NOT STEAM: ".
		['a blank window', 'about:blank', 'demo_trader'],
		['nothing at all', '', 'demo_trader']
	])('%s', (_name, url, expected) => {
		expect(titleFor('demo_trader', url)).toBe(expected);
	});

	/*
	 * The lookalike case is the one that matters. `steamcommunity.com.evil.example`
	 * ends in a domain nobody owns but reads as Steam at a glance, which is
	 * exactly the trick /scam-clones documents for download pages.
	 */
	it('never calls a lookalike host Steam', () => {
		const title = titleFor('demo_trader', 'https://steamcommunity.com.evil.example/login');
		expect(title).toContain('NOT STEAM');
	});

	it('renames the window as it moves, from the first page onward', async () => {
		const { host, recorded, go } = harness();
		await openAccountBrowser(host, ACCOUNT);

		go('https://steamcommunity.com/my/tradeoffers/');
		go('https://evil.example/steam-login');

		expect(recorded.titles).toEqual([
			'demo_trader — steamcommunity.com',
			'demo_trader — NOT STEAM: evil.example'
		]);
	});

	it('keeps the account name, which is what the window is for', async () => {
		const { host, recorded, go } = harness();
		await openAccountBrowser(host, ACCOUNT);
		go(START_URL);
		// Several of these are open at once; which account you are about to trade
		// as is the other question a title has to answer.
		expect(recorded.titles.at(-1)).toContain(ACCOUNT.accountName);
	});
});

/**
 * The address bar, and the schemes it refuses.
 *
 * A real browser's address bar accepts more than http. Here it must not: this
 * window holds a signed-in Steam session, so `javascript:` would run in that
 * origin, and `file:` would read the user's disk from a window that a moment
 * ago was showing somebody else's website. Both are refused rather than
 * guessed at — a bar that quietly does nothing is better than one that quietly
 * does that.
 */
describe('what the user may type into the address bar', () => {
	it.each([
		['a full URL', 'https://steamcommunity.com/market/', 'https://steamcommunity.com/market/'],
		['plain http', 'http://example.org/x', 'http://example.org/x'],
		['a bare host', 'steamcommunity.com', 'https://steamcommunity.com/'],
		['a host and path', 'steamcommunity.com/market', 'https://steamcommunity.com/market'],
		['surrounding space', '  steamcommunity.com  ', 'https://steamcommunity.com/']
	])('accepts %s', (_name, typed, expected) => {
		expect(addressToUrl(typed)).toBe(expected);
	});

	it.each([
		['javascript', 'javascript:alert(document.cookie)'],
		['javascript with spacing', '  JavaScript:fetch("/x")  '],
		['a local file', 'file:///C:/Users/someone/vault.json'],
		['a data url', 'data:text/html,<h1>hi'],
		['an app scheme', 'steam://run/730'],
		['nothing at all', '   '],
		['a bare word', 'tradeoffers']
	])('refuses %s', (_name, typed) => {
		expect(addressToUrl(typed)).toBeUndefined();
	});

	/*
	 * The two that matter most, stated separately so a future edit that
	 * broadened the scheme check fails on the reason rather than on a list.
	 */
	it('never returns a javascript: URL, whatever the casing', () => {
		for (const typed of ['javascript:1', 'JAVASCRIPT:1', 'JaVaScRiPt:1', ' javascript:1']) {
			expect(addressToUrl(typed), typed).toBeUndefined();
		}
	});

	it('never returns a file: URL', () => {
		for (const typed of ['file:///etc/passwd', 'FILE:///C:/', ' file://x']) {
			expect(addressToUrl(typed), typed).toBeUndefined();
		}
	});
});

describe('whether an address belongs to Valve', () => {
	it.each([
		['https://steamcommunity.com/my/', true],
		['https://store.steampowered.com/', true],
		['https://www.steamcommunity.com/', true],
		['https://help.steampowered.com/', true],
		['https://steamcommunity.com.evil.example/', false],
		['https://example.org/', false],
		['http://steamcommunity.com/', false],
		['about:blank', false],
		['', false]
	])('%s -> %s', (url, expected) => {
		expect(isSteamHost(url)).toBe(expected);
	});
});

/**
 * What the vault lock has to reach.
 *
 * `SteamTransportFactory.forgetAll` wipes the `steam-*` sessions it made. The
 * browser's partition is not one of those, so before `AccountBrowsers` existed
 * a signed-in Steam session survived the vault locking — and reopening the
 * browser found it still logged in, with no passphrase asked for.
 */
describe('closing every browser when the vault locks', () => {
	it('clears the session as well as closing the window', async () => {
		const cleared: string[] = [];
		const closed: string[] = [];
		const host = lockHarness(cleared, closed);
		const browsers = new AccountBrowsers(host);

		await browsers.open(ACCOUNT);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);

		await browsers.closeAll();

		// Both, and the first is the one that is easy to forget: `fromPartition`
		// hands back the same session next time, so a closed window leaves its
		// cookie behind unless the storage goes too.
		expect(cleared, 'the session was not wiped').toEqual([browserPartitionFor(ACCOUNT.steamId64)]);
		expect(closed, 'the window was not closed').toHaveLength(1);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
	});

	/*
	 * Windows first, storage second.
	 *
	 * The other order clears the session out from under a page that is still on
	 * screen and still able to use what it holds. Closing first stops the page;
	 * the wipe then removes what it was using.
	 */
	it('closes the window before wiping its session', async () => {
		const order: string[] = [];
		const host: BrowserHost = {
			sessionFromPartition: () => ({
				denyPermissions: () => undefined,
				resolveProxy: () => Promise.resolve('DIRECT'),
				setProxy: () => Promise.resolve(),
				setUserAgent: () => undefined,
				clearStorageData: () => {
					order.push('wipe');
					return Promise.resolve();
				},
				cookies: { set: () => Promise.resolve() }
			}),
			createWindow: () => {
				let destroyed = false;
				return {
					loadURL: () => Promise.resolve(),
					currentUrl: () => START_URL,
					setTitle: () => undefined,
					setWebRtcPolicy: () => undefined,
					focus: () => undefined,
					close: () => {
						destroyed = true;
						order.push('close');
					},
					isDestroyed: () => destroyed,
					on: () => undefined,
					setWindowOpenHandler: () => undefined
				};
			}
		};

		const browsers = new AccountBrowsers(host);
		await browsers.open(ACCOUNT);
		await browsers.closeAll();

		expect(order).toEqual(['close', 'wipe']);
	});

	/*
	 * `onLock` is synchronous, so this is fired and not awaited. A rejection
	 * would surface as an unhandled one at the exact moment the application is
	 * supposed to be making itself safe — and a lock that gave up partway would
	 * leave the remaining accounts signed in.
	 */
	it('finishes the sweep even when closing throws', async () => {
		const cleared: string[] = [];
		const host: BrowserHost = {
			sessionFromPartition: (partition) => ({
				denyPermissions: () => undefined,
				resolveProxy: () => Promise.resolve('DIRECT'),
				setProxy: () => Promise.resolve(),
				setUserAgent: () => undefined,
				clearStorageData: () => {
					cleared.push(partition);
					return Promise.resolve();
				},
				cookies: { set: () => Promise.resolve() }
			}),
			createWindow: () => ({
				loadURL: () => Promise.resolve(),
				currentUrl: () => START_URL,
				setTitle: () => undefined,
				setWebRtcPolicy: () => undefined,
				focus: () => undefined,
				close: () => {
					throw new Error('window already gone');
				},
				isDestroyed: () => false,
				on: () => undefined,
				setWindowOpenHandler: () => undefined
			})
		};

		const browsers = new AccountBrowsers(host);
		await browsers.open(ACCOUNT);

		await expect(browsers.closeAll()).resolves.toBeUndefined();
		// The wipe still happened despite the close failing.
		expect(cleared).toEqual([browserPartitionFor(ACCOUNT.steamId64)]);
	});

	it('survives a session that cannot be wiped', async () => {
		const host: BrowserHost = {
			sessionFromPartition: () => ({
				denyPermissions: () => undefined,
				resolveProxy: () => Promise.resolve('DIRECT'),
				setProxy: () => Promise.resolve(),
				setUserAgent: () => undefined,
				clearStorageData: () => Promise.reject(new Error('session gone')),
				cookies: { set: () => Promise.resolve() }
			}),
			createWindow: () => ({
				loadURL: () => Promise.resolve(),
				currentUrl: () => START_URL,
				setTitle: () => undefined,
				setWebRtcPolicy: () => undefined,
				focus: () => undefined,
				close: () => undefined,
				isDestroyed: () => false,
				on: () => undefined,
				setWindowOpenHandler: () => undefined
			})
		};

		const browsers = new AccountBrowsers(host);
		await browsers.open(ACCOUNT);
		await expect(browsers.closeAll()).resolves.toBeUndefined();
	});

	/*
	 * Pressing the button again, with the window already open behind the one the
	 * button is in.
	 *
	 * Returning quietly here makes the second press do nothing the user can see,
	 * and somebody who cannot find the window they just asked for presses again.
	 * The account list's own copy button carries the rule this follows: silently
	 * doing nothing is the one response a button must never give.
	 */
	it('raises the window it already has rather than opening a second', async () => {
		const { host, recorded } = harness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(ACCOUNT);
		await browsers.open(ACCOUNT);

		// A second window would share the partition and the session anyway, so it
		// adds nothing but a window to lose track of.
		expect(recorded.windows, 'a second window was opened').toHaveLength(1);
		expect(recorded.focused, 'the second press did nothing at all').toBe(1);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);
	});
});

/** A host that records what was wiped and what was closed. */
function lockHarness(cleared: string[], closed: string[]): BrowserHost {
	return {
		sessionFromPartition: (partition) => ({
			denyPermissions: () => undefined,
			resolveProxy: () => Promise.resolve('DIRECT'),
			setProxy: () => Promise.resolve(),
			setUserAgent: () => undefined,
			clearStorageData: () => {
				cleared.push(partition);
				return Promise.resolve();
			},
			cookies: { set: () => Promise.resolve() }
		}),
		createWindow: () => {
			let destroyed = false;
			return {
				loadURL: () => Promise.resolve(),
				currentUrl: () => START_URL,
				setTitle: () => undefined,
				setWebRtcPolicy: () => undefined,
				focus: () => undefined,
				close: () => {
					destroyed = true;
					closed.push('closed');
				},
				isDestroyed: () => destroyed,
				on: () => undefined,
				setWindowOpenHandler: () => undefined
			};
		}
	};
}
