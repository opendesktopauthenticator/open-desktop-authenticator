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
	isSteamLoginPage,
	looksSignedOut,
	openAccountBrowser,
	START_URL,
	type BrowserHost,
	type BrowserSessionHandle,
	type BrowserWindowHandle,
	type BrowserWindowOptions
} from '../src/main/browser/window';
import {
	DIRECT_CONTENT_DOMAINS,
	STEAM_ROUTED_DOMAINS,
	STEAM_USER_AGENT,
	isDirectContentHost,
	isSteamRoutedHost
} from '../src/main/net/egress';

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
	/** Every set of proxy credentials the window was given, `undefined` included. */
	proxyCredentials: ({ username: string; password: string } | undefined)[];
	/** Times this session was told to refuse permission requests. */
	permissionsDenied: number;
	/** Every URL `resolveProxy` was asked about, in order. */
	resolved: string[];
}

function harness(
	overrides: {
		setProxy?: () => Promise<void>;
		landsOn?: string;
		loadFails?: boolean;
		/** The load never settles — neither resolves nor rejects. */
		loadHangs?: boolean;
		/** `clearStorageData` rejects, so the partition keeps its cookies. */
		wipeFails?: boolean;
		/**
		 * A redirect the main frame passes through *during* the first load.
		 *
		 * Steam answers a dead session with a 302 to its own login form, so this is
		 * what the common failure actually looks like from inside `loadURL` — not
		 * something that happens calmly afterwards.
		 */
		redirectsToDuringLoad?: string;
		/** What Chromium claims it would actually do. Defaults to obeying setProxy. */
		resolvesTo?: string;
		/**
		 * Answer `DIRECT` for these URLs and obey the proxy rule for the rest.
		 *
		 * How a test says "Chromium disagreed about one host" — which is the only
		 * way to make the per-domain sweep fail on a domain rather than on the
		 * whole mode.
		 */
		resolvesDirectFor?: (url: string) => boolean;
	} = {}
) {
	// Per-harness, not module-level: two tests sharing one of these is how a
	// fake starts reporting the previous test's partition.
	let partitionName = '';
	/** Set once the window subscribes; a test calls it to move the window. */
	let navigate: (url: string) => void = () => undefined;
	/** Everything subscribed to `closed`, so a test can end the window for real. */
	const closedListeners: (() => void)[] = [];
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
		proxyCredentials: [],
		permissionsDenied: 0,
		resolved: []
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
		/*
		 * **This fake answers from the proxy rule and nothing else.**
		 *
		 * It used to evaluate a PAC script the way Chromium would, and that is
		 * how the loopback bug shipped: the fake ran the script and reported what
		 * the script said, while real Chromium bypassed `localhost`, `[::1]` and
		 * `169.254.169.254` before ever consulting it. Every routing test passed.
		 *
		 * A fake cannot be trusted to model a proxy resolver, so it no longer
		 * tries. These tests assert what the code *asks Chromium for* — the mode,
		 * the rules, the bypass list — and `tools/smoke-browser-window.mjs`
		 * asserts what Chromium then does, in a real session.
		 */
		resolveProxy: (url: string) => {
			recorded.resolved.push(url);
			if (overrides.resolvesTo !== undefined) {
				return Promise.resolve(overrides.resolvesTo);
			}
			if (overrides.resolvesDirectFor?.(url)) {
				return Promise.resolve('DIRECT');
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
			// A wipe that rejects is the case the manager used to swallow: the
			// partition name is derived from the account, so the next open lands on
			// the same jar with whatever Steam set still in it.
			if (wipeFails) {
				return Promise.reject(new Error('session gone'));
			}
			return Promise.resolve();
		},
		cookies: {
			set: (cookie) => {
				recorded.cookies.push({ url: cookie.url, name: cookie.name, value: cookie.value });
				return Promise.resolve();
			}
		}
	};

	// Mutable, so a test can let the retry succeed — which is the difference
	// between "refuses for ever" and "asks again once".
	let wipeFails = overrides.wipeFails === true;
	let loadFails = overrides.loadFails === true;

	const window: BrowserWindowHandle = {
		loadURL: (url) => {
			recorded.loaded.push(url);
			// Closes *during this load*, not closes ever. `recorded.closed` counts
			// the whole harness, and some tests open twice against one — reading it
			// directly made the second open fail because the first had ended.
			const closedBefore = recorded.closed;
			if (overrides.redirectsToDuringLoad !== undefined) {
				// Electron reports navigation as the load happens, not after it.
				navigate(overrides.redirectsToDuringLoad);
			}
			if (loadFails) {
				return Promise.reject(new Error('ERR_TUNNEL_CONNECTION_FAILED'));
			}
			/*
			 * **A load that never settles**, which is the case neither a resolve nor
			 * a reject can stand in for. A window whose load hangs is on screen and
			 * signed in, and the code that would disown it runs after the await that
			 * is not coming.
			 */
			if (overrides.loadHangs === true) {
				return new Promise<void>(() => undefined);
			}
			/*
			 * **A load into a window that was closed underneath it does not
			 * succeed.** Electron rejects with ERR_ABORTED when the contents are
			 * destroyed mid-load, and a fake that resolved anyway would hide exactly
			 * the case where something closed this window while it was still
			 * settling — which is now a thing the navigation handler can do.
			 */
			if (recorded.closed > closedBefore) {
				return Promise.reject(new Error('ERR_ABORTED'));
			}
			return Promise.resolve();
		},
		// Deliberately a separate fact from what `loadURL` was handed. A fake that
		// always echoes the requested URL back can never land anywhere else, which
		// is the one thing `looksSignedOut` exists to notice.
		currentUrl: () => overrides.landsOn ?? START_URL,
		setTitle: (title) => recorded.titles.push(title),
		setWebRtcPolicy: (policy) => recorded.webRtcPolicies.push(policy),
		setProxyCredentials: (credentials) => recorded.proxyCredentials.push(credentials),
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
			if (event === 'closed') {
				closedListeners.push(listener as () => void);
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

	return {
		host,
		recorded,
		go: (url: string) => navigate(url),
		/** Let a wipe that was failing start working. */
		letWipeSucceed: () => {
			wipeFails = false;
		},
		/** Let a load that was failing start working. */
		letLoadSucceed: () => {
			loadFails = false;
		},
		/** Fire the window's own `closed`, as Electron would. */
		endWindow: () => {
			for (const listener of [...closedListeners]) {
				listener();
			}
		}
	};
}

const ACCOUNT = {
	steamId64: '76561198000000001',
	accountName: 'demo_trader',
	accessToken: 'eyJhbGciOiJFZERTQSJ9.token.signature',
	// Opted in, so every existing routing test still asks for routing.
	route: 'proxy' as const
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
			route: 'direct'
		});

		expect(recorded.proxies[0]).toMatchObject({ mode: 'system' });
		expect(recorded.windows, 'the window should still open').toHaveLength(1);
	});

	it('does not verify a route it was not asked to take', async () => {
		// `resolvesTo` says Chromium would go direct — which is what was asked for.
		const { host, recorded } = harness({ resolvesTo: 'DIRECT' });
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://10.0.0.9:8080',
			route: 'direct'
		});
		expect(recorded.windows).toHaveLength(1);
	});

	/*
	 * `system`, not `direct` — the same choice `transport.ts` makes, and now for
	 * the same account. The two used to disagree, so on a machine with an OS
	 * proxy the Steam cookie was minted through it and then spent from the
	 * machine's own address: two addresses for one session, arriving by way of
	 * the option offered as the way around routing.
	 */
	it('follows the machine’s own settings when the account has no proxy', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, ACCOUNT);
		expect(recorded.proxies[0]).toMatchObject({ mode: 'system' });
		expect(
			recorded.proxies[0],
			'the window ignored an OS proxy the transport obeys'
		).not.toMatchObject({ mode: 'direct' });
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
		// The real Steam Support sign-in, not a guess at one: that site puts a
		// locale in the path and calls the page a wizard step.
		['help, signed out', 'https://help.steampowered.com/en/wizard/Login', true],
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

		/*
		 * The landing writes its own title, because the navigation handler
		 * deliberately stays quiet until the landing has been judged — Steam
		 * answers a dead session with a redirect to its login form *during* that
		 * first load, and reacting to it there closed the window before the check
		 * that reports it properly could run.
		 *
		 * The real adapter announces a navigation only when the URL changes, so
		 * this is one title per page. `go` here is the test moving the window by
		 * hand, and repeating the address it is already on is not something
		 * Electron does.
		 */
		expect(recorded.titles).toEqual(['demo_trader — steamcommunity.com']);

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
					setProxyCredentials: () => undefined,
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
				setProxyCredentials: () => undefined,
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
				setProxyCredentials: () => undefined,
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
				setProxyCredentials: () => undefined,
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

/**
 * A host whose opens can be held part-way through, so the window and the thing
 * that should have stopped it can be made to race deterministically.
 *
 * `AccountBrowsers` records a window only once `openAccountBrowser` has
 * resolved, and that takes four awaits — proxy applied, route verified, cookie
 * set, first page loaded. Everything below is about what happens *during* those,
 * which is a window nothing has a reference to yet.
 */
function slowHarness() {
	const created: { closed: boolean }[] = [];
	const wiped: string[] = [];
	/*
	 * Every gate currently held, not just the newest one.
	 *
	 * A single `let release` was enough while only one open could be in flight.
	 * It is not enough once a press of the *other* routing button makes a second
	 * open follow the first: the second overwrote the first's resolver, and a
	 * test that released once released the wrong one and hung on the other.
	 */
	const gates: (() => void)[] = [];
	const proxies: { mode?: string; proxyRules?: string }[] = [];

	const host: BrowserHost = {
		sessionFromPartition: (partition) => ({
			denyPermissions: () => undefined,
			// Obeys whatever was last asked for, like the main harness. Answering
			// DIRECT unconditionally would make every routed open in here fail the
			// verification check for a reason that has nothing to do with the test.
			resolveProxy: () => {
				const last = proxies.at(-1);
				if (!last || last.mode !== 'fixed_servers' || last.proxyRules === undefined) {
					return Promise.resolve('DIRECT');
				}
				return Promise.resolve(`PROXY ${last.proxyRules.replace(/^[a-z0-9]+:\/\//, '')}`);
			},
			// Held open until a test lets it go.
			setProxy: (config) =>
				new Promise<void>((resolve) => {
					proxies.push(config);
					gates.push(resolve);
				}),
			setUserAgent: () => undefined,
			clearStorageData: () => {
				wiped.push(partition);
				return Promise.resolve();
			},
			cookies: { set: () => Promise.resolve() }
		}),
		createWindow: () => {
			const record = { closed: false };
			created.push(record);
			return {
				loadURL: () => Promise.resolve(),
				currentUrl: () => START_URL,
				setTitle: () => undefined,
				setWebRtcPolicy: () => undefined,
				setProxyCredentials: () => undefined,
				focus: () => undefined,
				close: () => {
					record.closed = true;
				},
				isDestroyed: () => record.closed,
				on: () => undefined,
				setWindowOpenHandler: () => undefined
			};
		}
	};

	return {
		host,
		created,
		wiped,
		/** Let go of everything currently held, and say how much that was. */
		release: (): number => {
			const held = gates.splice(0);
			for (const gate of held) {
				gate();
			}
			return held.length;
		}
	};
}

describe('a browser that opens while something is trying to stop it', () => {
	/*
	 * **The lock swept a map the window was not in yet.**
	 *
	 * `closeAll` iterates finished windows. An open in flight is not one, so the
	 * sweep passed over it and the window appeared afterwards — a signed-in Steam
	 * window created by a locked vault, which is the single thing the lock exists
	 * to prevent.
	 */
	it('closes a window that finished opening after the vault locked', async () => {
		const { host, created, wiped, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const opening = settled(browsers.open(ACCOUNT));
		// The lock lands while the open is still waiting on its proxy.
		await browsers.closeAll();
		release();

		expect(why(await opening)).toMatch(/locked/i);
		expect(created, 'the window was still built').toHaveLength(1);
		expect(created[0]?.closed, 'it outlived the lock').toBe(true);
		expect(wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
	});

	it('closes a window that finished opening after the account’s routing changed', async () => {
		const { host, created, wiped, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const opening = settled(browsers.open(ACCOUNT));
		await browsers.closeAccount(ACCOUNT.steamId64);
		release();

		expect(why(await opening)).toMatch(/routing changed/i);
		expect(created[0]?.closed).toBe(true);
		expect(wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
	});

	/*
	 * The window takes seconds to appear, which is exactly long enough for
	 * somebody to press the button again. Both presses used to build a window and
	 * only the second was ever recorded; the first stayed on screen, signed in,
	 * invisible to the lock.
	 */
	it('builds one window when the button is pressed twice', async () => {
		const { host, created, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const first = browsers.open(ACCOUNT);
		const second = browsers.open(ACCOUNT);
		release();
		await Promise.all([first, second]);

		expect(created).toHaveLength(1);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);
	});
});

describe('a browser whose account changed underneath it', () => {
	/*
	 * **The lock reached these windows and a routing change did not.**
	 *
	 * `dropAccountRouting` dropped the transport's cookie jar and the cached
	 * token — everything an account had until this window existed. The browser
	 * has its own session in its own partition, so saving a new proxy left a
	 * signed-in window running on the old route, with the previous address still
	 * attached to the account, on the one screen where the user is actually
	 * looking at Steam.
	 */
	it('closes and wipes the window when routing changes', async () => {
		const cleared: string[] = [];
		const closed: string[] = [];
		const browsers = new AccountBrowsers(lockHarness(cleared, closed));
		await browsers.open(ACCOUNT);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);

		await browsers.closeAccount(ACCOUNT.steamId64);

		expect(closed).toHaveLength(1);
		expect(cleared).toContain(browserPartitionFor(ACCOUNT.steamId64));
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
	});

	it('says nothing and does nothing for an account with no window', async () => {
		const cleared: string[] = [];
		const closed: string[] = [];
		const browsers = new AccountBrowsers(lockHarness(cleared, closed));

		await expect(browsers.closeAccount(ACCOUNT.steamId64)).resolves.toBeUndefined();
		expect(closed).toHaveLength(0);
	});

	/*
	 * A window removing itself on `closed` used to delete whatever was under its
	 * key, which after a reopen is a different, live window — leaving a
	 * signed-in browser the next lock could not find.
	 */
	it('does not let a closing window disown its replacement', async () => {
		const listeners: (() => void)[] = [];
		let destroyed = false;
		const host: BrowserHost = {
			sessionFromPartition: () => ({
				denyPermissions: () => undefined,
				resolveProxy: () => Promise.resolve('DIRECT'),
				setProxy: () => Promise.resolve(),
				setUserAgent: () => undefined,
				clearStorageData: () => Promise.resolve(),
				cookies: { set: () => Promise.resolve() }
			}),
			createWindow: () => {
				const mine = listeners.length;
				return {
					loadURL: () => Promise.resolve(),
					currentUrl: () => START_URL,
					setTitle: () => undefined,
					setWebRtcPolicy: () => undefined,
					setProxyCredentials: () => undefined,
					focus: () => undefined,
					close: () => undefined,
					// Only the first window is gone; the second is live.
					isDestroyed: () => mine === 0 && destroyed,
					on: (event: string, listener: unknown) => {
						if (event === 'closed') {
							listeners[mine] = listener as () => void;
						}
					},
					setWindowOpenHandler: () => undefined
				};
			}
		};

		const browsers = new AccountBrowsers(host);
		await browsers.open(ACCOUNT);
		// The first window goes, and a second is opened in its place.
		destroyed = true;
		await browsers.open(ACCOUNT);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);

		// The first window's `closed` finally fires, late, as Electron's does.
		listeners[0]?.();

		expect(browsers.isOpen(ACCOUNT.steamId64), 'the live window was disowned').toBe(true);
	});
});

describe('a Steam login page reached after the landing', () => {
	it('is recognised on every Steam host', () => {
		expect(isSteamLoginPage('https://steamcommunity.com/login/home/?goto=')).toBe(true);
		expect(isSteamLoginPage('https://store.steampowered.com/login/')).toBe(true);
		// Steam Support's real address. `help.steampowered.com/login` — what this
		// line used to assert — is a route that exists nowhere, so the suite and
		// the code agreed about a page neither had ever seen.
		expect(isSteamLoginPage('https://help.steampowered.com/en/wizard/Login')).toBe(true);
	});

	it('is not confused by a page that merely mentions logging in', () => {
		expect(isSteamLoginPage('https://steamcommunity.com/my/tradeoffers/')).toBe(false);
		expect(isSteamLoginPage('https://steamcommunity.com/loginhistory')).toBe(false);
		expect(isSteamLoginPage('https://steamcommunity.com/market/login')).toBe(false);
	});

	/*
	 * Steam's OpenID endpoint is how an already-signed-in account signs in to a
	 * third-party trading site. Nothing is typed there, and refusing it would
	 * break the workflow this browser exists for.
	 */
	it('leaves the OpenID hand-off alone', () => {
		expect(isSteamLoginPage('https://steamcommunity.com/openid/login')).toBe(false);
	});

	it('is not a Steam login page just because a lookalike says so', () => {
		expect(isSteamLoginPage('https://steamcommunity.com.evil.example/login/')).toBe(false);
		expect(isSteamLoginPage('http://steamcommunity.com/login/')).toBe(false);
	});

	/*
	 * **The invariant §2.6b promises, applied for the whole life of the window.**
	 *
	 * The landing check ran once. A session that expires an hour into a trade is
	 * answered with a redirect to Steam's own login form — ordinary, expected —
	 * and that form would then have been drawn inside this application's chrome,
	 * under the account's own name, with a correct `steamcommunity.com` in the
	 * address bar. Every signal a careful person checks would have agreed.
	 */
	it('closes the window and wipes the session', async () => {
		const { host, recorded, go } = harness();
		await openAccountBrowser(host, ACCOUNT);
		expect(recorded.closed).toBe(0);

		go('https://steamcommunity.com/login/home/?goto=my%2Ftradeoffers');
		await Promise.resolve();

		expect(recorded.closed, 'a Steam password form was left on screen').toBe(1);
		expect(recorded.wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});

	it('does not retitle the window on the way out', async () => {
		const { host, recorded, go } = harness();
		await openAccountBrowser(host, ACCOUNT);
		const before = recorded.titles.length;

		go('https://store.steampowered.com/login/');

		expect(recorded.titles).toHaveLength(before);
	});

	it('leaves ordinary browsing alone', async () => {
		const { host, recorded, go } = harness();
		await openAccountBrowser(host, ACCOUNT);

		go('https://steamcommunity.com/market/');
		go('https://csgoempire.com/trade');

		expect(recorded.closed).toBe(0);
		expect(recorded.titles.at(-1)).toBe('demo_trader — NOT STEAM: csgoempire.com');
	});
});

describe('the proxy’s own credentials', () => {
	/*
	 * `planProxy` strips them out of the Chromium rule on purpose, and hands them
	 * back separately for whoever authenticates. The transport has answered its
	 * `login` event with them since routing existed; this window never did, and
	 * Electron cancels an unanswered one — so a proxy this application accepts,
	 * stores and mints tokens through met a 407 on every page load.
	 */
	it('are given to the window when the proxy needs them', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://user:hunter2@10.0.0.9:8080'
		});

		expect(recorded.proxyCredentials).toEqual([{ username: 'user', password: 'hunter2' }]);
	});

	it('are still kept out of the rule Chromium is given', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://user:hunter2@10.0.0.9:8080'
		});

		expect(JSON.stringify(recorded.proxies)).not.toContain('hunter2');
	});

	it('are absent for a proxy that needs none', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080' });

		expect(recorded.proxyCredentials).toEqual([undefined]);
	});

	it('are absent when the user chose to go direct', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://user:hunter2@10.0.0.9:8080',
			route: 'direct'
		});

		expect(recorded.proxyCredentials).toEqual([undefined]);
	});

	it('are set before the first page is asked for', async () => {
		const order: string[] = [];
		const { host } = harness();
		// Bound before it is replaced, so the wrapper below calls the original
		// rather than itself.
		const inner = host.createWindow.bind(host);
		host.createWindow = (options) => {
			const window = inner(options);
			return {
				...window,
				setProxyCredentials: (credentials) => {
					order.push('credentials');
					window.setProxyCredentials(credentials);
				},
				loadURL: (url) => {
					order.push('load');
					return window.loadURL(url);
				}
			};
		};

		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://user:hunter2@10.0.0.9:8080'
		});

		expect(order).toEqual(['credentials', 'load']);
	});
});

/**
 * A host that answers every open with a distinct window, and remembers the
 * proxy each one's session was actually given.
 *
 * The single shared window the main harness returns is right for testing what
 * `openAccountBrowser` does; it cannot tell two windows apart, which is the
 * whole question here.
 */
function routingHarness() {
	const proxies: unknown[] = [];
	const wiped: string[] = [];
	const windows: { closed: boolean; focused: number }[] = [];

	const host: BrowserHost = {
		sessionFromPartition: (partition) => ({
			denyPermissions: () => undefined,
			resolveProxy: () => {
				const last = proxies.at(-1) as { mode?: string; proxyRules?: string } | undefined;
				if (!last || last.mode !== 'fixed_servers' || last.proxyRules === undefined) {
					return Promise.resolve('DIRECT');
				}
				return Promise.resolve(`PROXY ${last.proxyRules.replace(/^[a-z0-9]+:\/\//, '')}`);
			},
			setProxy: (config) => {
				proxies.push(config);
				return Promise.resolve();
			},
			setUserAgent: () => undefined,
			clearStorageData: () => {
				wiped.push(partition);
				return Promise.resolve();
			},
			cookies: { set: () => Promise.resolve() }
		}),
		createWindow: () => {
			const record = { closed: false, focused: 0 };
			windows.push(record);
			return {
				loadURL: () => Promise.resolve(),
				currentUrl: () => START_URL,
				setTitle: () => undefined,
				setWebRtcPolicy: () => undefined,
				setProxyCredentials: () => undefined,
				focus: () => {
					record.focused += 1;
				},
				close: () => {
					record.closed = true;
				},
				isDestroyed: () => record.closed,
				on: () => undefined,
				setWindowOpenHandler: () => undefined
			};
		}
	};

	return { host, proxies, wiped, windows };
}

const PROXIED = { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080', route: 'proxy' as const };
const STEAM_ONLY = { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080', route: 'steam-only' as const };
const DIRECT = { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080', route: 'direct' as const };

/*
 * **The account list has two buttons and this map had one key.**
 *
 * Somebody opens an account directly to get past a Cloudflare check, finishes,
 * and then presses the routed button. They were handed the *direct window
 * back*, focused, with no proxy applied and nothing said — having asked for the
 * proxy in the one place the application lets them ask. Their real address kept
 * going to Steam on that account for as long as the window stayed open.
 */
describe('pressing the other routing button', () => {
	it('does not hand back the direct window when the proxy was asked for', async () => {
		const { host, proxies, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(DIRECT);
		expect(proxies.at(-1)).toMatchObject({ mode: 'system' });

		await browsers.open(PROXIED);

		expect(windows, 'the direct window was reused').toHaveLength(2);
		expect(windows[0]?.closed, 'the direct window is still open').toBe(true);
		expect(proxies.at(-1), 'the proxy was never applied').toMatchObject({
			mode: 'fixed_servers',
			proxyRules: 'http://10.0.0.9:8080'
		});
	});

	it('does not keep the proxied window when direct was asked for', async () => {
		const { host, proxies, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(PROXIED);
		await browsers.open(DIRECT);

		expect(windows).toHaveLength(2);
		expect(windows[0]?.closed).toBe(true);
		expect(proxies.at(-1)).toMatchObject({ mode: 'system' });
	});

	it('wipes the old window’s session rather than handing it to the new route', async () => {
		const { host, wiped } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(DIRECT);
		await browsers.open(PROXIED);

		// The cookies collected over the previous route do not follow the account
		// onto the new one.
		expect(wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});

	/*
	 * Focusing is right for a second press of the *same* button, and the reason
	 * that behaviour exists: the window is behind the one the button was pressed
	 * in, so a quiet return reads as the feature being broken.
	 */
	it('still just raises the window when the same button is pressed twice', async () => {
		const { host, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(PROXIED);
		await browsers.open(PROXIED);

		expect(windows).toHaveLength(1);
		expect(windows[0]?.focused).toBe(1);
	});

	/*
	 * An account with no proxy is direct whichever way the switch is set, so
	 * neither button is a change and neither should tear a window down.
	 */
	it('treats both buttons as the same route for an account with no proxy', async () => {
		const { host, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open({ ...ACCOUNT, route: 'proxy' });
		await browsers.open({ ...ACCOUNT, route: 'direct' });

		expect(windows).toHaveLength(1);
		expect(windows[0]?.closed).toBe(false);
	});

	/*
	 * **Three buttons now, and the third is not either of the other two.**
	 *
	 * "Steam only" shares the proxy with the fully routed window and shares
	 * `DIRECT` for everything else with the direct one, so a key built from the
	 * proxy URL alone — or from a boolean — collapses it into whichever it was
	 * opened beside. The user presses the third button and is handed back a
	 * window running the route they were trying to change away from.
	 */
	it('does not hand back the fully proxied window when Steam-only was asked for', async () => {
		const { host, proxies, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(PROXIED);
		expect(proxies.at(-1)).toMatchObject({ mode: 'fixed_servers' });

		await browsers.open(STEAM_ONLY);

		expect(windows, 'the fully proxied window was reused').toHaveLength(2);
		expect(windows[0]?.closed).toBe(true);
		expect(proxies.at(-1), 'the Steam-only route was never applied').toMatchObject({
			mode: 'fixed_servers',
			proxyBypassRules: expect.stringContaining('csfloat.com')
		});
	});

	it('does not hand back the Steam-only window when Direct was asked for', async () => {
		const { host, proxies, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(STEAM_ONLY);
		await browsers.open(DIRECT);

		expect(windows).toHaveLength(2);
		expect(windows[0]?.closed).toBe(true);
		expect(proxies.at(-1)).toMatchObject({ mode: 'system' });
	});

	it('still just raises the window when Steam-only is pressed twice', async () => {
		const { host, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.open(STEAM_ONLY);
		await browsers.open(STEAM_ONLY);

		expect(windows).toHaveLength(1);
		expect(windows[0]?.focused).toBe(1);
	});

	it('takes the decision again when the other button is pressed mid-open', async () => {
		const { host, created, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const first = browsers.open(DIRECT);
		const second = browsers.open(PROXIED);

		// The direct open finishes first; the proxied press was waiting on it.
		expect(release()).toBe(1);
		await first;

		// A turn of the event loop, so the waiting press can re-enter `open`, tear
		// the direct window down, and reach the proxy step of its own.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(release(), 'the second press never started an open of its own').toBe(1);
		await second;

		expect(created).toHaveLength(2);
		expect(created[0]?.closed, 'the direct window survived the switch').toBe(true);
	});
});

/*
 * **A regression the post-landing check introduced, caught before shipping.**
 *
 * Guarding every navigation against Steam's login form armed that guard
 * *before* the first load — and the first load is exactly where Steam answers a
 * dead session with a 302 to that form. So the most common failure this feature
 * has, the one a user meets whenever a saved session has gone stale, went from
 * "Steam did not accept the saved session, sign in again" to "the browser could
 * not reach Steam": a routing-shaped error for a sign-in-shaped problem, on the
 * screen whose whole job is to offer the sign-in.
 */
describe('a dead session that redirects to the login form mid-load', () => {
	it('is still reported as needing a sign-in', async () => {
		const { host } = harness({
			redirectsToDuringLoad: 'https://steamcommunity.com/login/home/?goto=my%2Ftradeoffers',
			landsOn: 'https://steamcommunity.com/login/home/?goto=my%2Ftradeoffers'
		});

		const failure = await openAccountBrowser(host, ACCOUNT).catch((err: unknown) => err);

		expect(failure, 'a stale session now reads as an unreachable Steam').toBeInstanceOf(
			BrowserSignInRequired
		);
		expect((failure as Error).message).toMatch(/sign in/i);
	});

	it('still closes the window and wipes the session', async () => {
		const { host, recorded } = harness({
			redirectsToDuringLoad: 'https://steamcommunity.com/login/home/',
			landsOn: 'https://steamcommunity.com/login/home/'
		});

		await openAccountBrowser(host, ACCOUNT).catch(() => undefined);

		// Once, not twice: the landing check owns this load.
		expect(recorded.closed).toBe(1);
		expect(recorded.wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});

	/*
	 * And an ordinary redirect through Steam's own pages during the first load —
	 * `steamcommunity.com/my/…` resolves to `/profiles/<id>/…` — must still land.
	 */
	it('does not disturb an ordinary redirect on the way in', async () => {
		const { host, recorded } = harness({
			redirectsToDuringLoad: 'https://steamcommunity.com/profiles/76561198000000001/tradeoffers/'
		});

		await expect(openAccountBrowser(host, ACCOUNT)).resolves.toBeDefined();
		expect(recorded.closed).toBe(0);
	});
});

/**
 * Hold a rejection the moment it can happen, not when it is asserted.
 *
 * **This is what made the suite exit 1 while every test passed.** These opens
 * reject during a `closeAll()` or a `release()` several lines above the
 * `await expect(...).rejects` that checks them — so for those few ticks the
 * rejection had no handler, Node reported an unhandled rejection, and Vitest
 * failed the *run* while reporting 1,784 passing tests. A green summary and a
 * red exit code is the worst possible pair: it is exactly the shape of thing a
 * `grep` for FAIL does not catch.
 *
 * Attaching `.catch` at the call keeps the promise handled from the start; the
 * assertion then inspects a value rather than racing a rejection.
 */
const settled = (work: Promise<unknown>): Promise<unknown> =>
	work.then(
		() => undefined,
		(err: unknown) => err
	);

/** The message of a rejection captured by `settled`, or '' if it resolved. */
const why = (outcome: unknown): string => {
	if (outcome instanceof Error) {
		return outcome.message;
	}
	// A non-Error rejection is a bug in whatever threw it, so say what it was
	// rather than stringifying an object into '[object Object]'.
	return outcome === undefined ? '' : JSON.stringify(outcome);
};

/*
 * **A hole the route-switch teardown reopened, closed again.**
 *
 * The lock counter is what stops an open that began before a lock from
 * producing a window after it. It used to be read just before the open started,
 * which was safe while everything ahead of it was synchronous — and then
 * switching routes put a window teardown, with its own awaits, in front of it.
 * A lock landing in that gap bumped the counter, the capture read the new value,
 * and the check compared it with itself and agreed.
 */
describe('a lock that lands while the old window is being torn down', () => {
	it('still stops the replacement window from appearing', async () => {
		const { host, created, wiped, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		// A direct window, open and tracked.
		const first = browsers.open(DIRECT);
		expect(release()).toBe(1);
		await first;
		expect(created).toHaveLength(1);

		// The other button, which tears the direct window down first.
		const switching = settled(browsers.open(PROXIED));
		// The lock arrives during that teardown, before the replacement's own open
		// has captured anything.
		await browsers.closeAll();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();

		expect(why(await switching)).toMatch(/locked/i);

		/*
		 * **Never built, not built and then closed.**
		 *
		 * This used to assert `created[1].closed === true` — and in doing so wrote
		 * down the weaker behaviour as intended. The generation was only consulted
		 * *after* `openAccountBrowser` returned, so the replacement had already had
		 * its Steam cookie set, its window created and a Steam page loaded into it
		 * before anything noticed the lock. Closing it afterwards is the right
		 * ending to a sequence that should never have started.
		 */
		expect(created, 'a signed-in window was built for a locked vault').toHaveLength(1);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
		expect(wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});
});

/*
 * **The one Valve password form the predicate missed was Valve's own support
 * site.**
 *
 * `help.steampowered.com` is a different application with different URLs: it
 * puts a locale in the path and calls the sign-in a wizard step, so the real
 * page is `/en/wizard/Login`. Matching `^/login` answered false for it. The
 * earlier test used an invented `help.steampowered.com/login`, which exists
 * nowhere, so the suite agreed with the code about a route neither had checked.
 */
describe('Steam Support’s real sign-in page', () => {
	it('is recognised with a locale in the path', () => {
		expect(isSteamLoginPage('https://help.steampowered.com/en/wizard/Login')).toBe(true);
		expect(isSteamLoginPage('https://help.steampowered.com/fr/wizard/Login')).toBe(true);
		expect(isSteamLoginPage('https://help.steampowered.com/zh-cn/wizard/Login')).toBe(true);
	});

	it('is recognised without one', () => {
		expect(isSteamLoginPage('https://help.steampowered.com/wizard/Login')).toBe(true);
	});

	it('is recognised whatever it is cased as, and with a query on it', () => {
		expect(isSteamLoginPage('https://help.steampowered.com/en/wizard/login?redir=%2Fen%2F')).toBe(
			true
		);
	});

	/*
	 * Account recovery is not a password form — it asks who you are, not what
	 * your password is — and it is exactly where somebody with a broken session
	 * needs to get to.
	 */
	it('leaves the recovery wizard alone', () => {
		expect(isSteamLoginPage('https://help.steampowered.com/en/wizard/HelpWithLogin')).toBe(false);
		expect(isSteamLoginPage('https://help.steampowered.com/en/wizard/HelpWithLoginInfo')).toBe(
			false
		);
		expect(isSteamLoginPage('https://help.steampowered.com/en/wizard/HelpWithAccountAccess')).toBe(
			false
		);
	});

	/*
	 * **The locale strip is why this one matters.**
	 *
	 * `steamcommunity.com/id/<name>` is a vanity profile, and `id` passes for a
	 * locale. Stripping it there would read the profile of a real person whose
	 * chosen name is "login" as a password form and close the window on them —
	 * so the strip is applied on the support host and nowhere else.
	 */
	it('does not mistake a vanity profile for a sign-in', () => {
		expect(isSteamLoginPage('https://steamcommunity.com/id/login')).toBe(false);
		expect(isSteamLoginPage('https://steamcommunity.com/id/loginhelper/inventory')).toBe(false);
	});

	it('still recognises the two it always did', () => {
		expect(isSteamLoginPage('https://steamcommunity.com/login/home/?goto=')).toBe(true);
		expect(isSteamLoginPage('https://store.steampowered.com/login/')).toBe(true);
	});

	/*
	 * Valve's dedicated sign-in host. A signed-in window has no business landing
	 * here at all, so every path on it counts — and it has to be a *known* Steam
	 * host first, or it would merely be labelled "NOT STEAM" and left open,
	 * warning about the right page for the wrong reason.
	 */
	it('treats the sign-in host as a sign-in wherever it lands', () => {
		expect(isSteamHost('https://login.steampowered.com/jwt/begin')).toBe(true);
		expect(isSteamLoginPage('https://login.steampowered.com/jwt/begin')).toBe(true);
		expect(isSteamLoginPage('https://login.steampowered.com/')).toBe(true);
	});

	it('is not fooled by a lookalike of the support host', () => {
		expect(isSteamLoginPage('https://help.steampowered.com.evil.example/en/wizard/Login')).toBe(
			false
		);
	});

	/*
	 * And the whole point: reaching one closes the window, wherever it is.
	 */
	it('closes the window when the support sign-in is reached mid-session', async () => {
		const { host, recorded, go } = harness();
		await openAccountBrowser(host, ACCOUNT);

		go('https://help.steampowered.com/en/wizard/Login');

		expect(recorded.closed, 'a Steam password form was left on screen').toBe(1);
		expect(recorded.wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});
});

/*
 * **A cancelled request must stay cancelled, including the one behind it.**
 *
 * When one route is opening and the other button is pressed, the second request
 * waits for the first and then takes the decision again. That retry used to
 * read the lock counter *afresh* — after the lock that had just cancelled the
 * request it was waiting on. So `closeAll` cancelled the first open and the
 * queued one went on to succeed, leaving exactly the signed-in window the lock
 * existed to prevent.
 */
describe('a queued route switch when the vault locks', () => {
	it('is cancelled along with the request it was waiting for', async () => {
		const { host, created, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const first = settled(browsers.open(DIRECT));
		const second = settled(browsers.open(PROXIED));

		// The lock lands while the first is still opening and the second waits.
		await browsers.closeAll();
		release();

		expect(why(await first)).toMatch(/locked/i);
		expect(why(await second), 'the queued request outlived the lock').toMatch(/locked/i);

		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
		for (const window of created) {
			expect(window.closed, 'a window survived the lock').toBe(true);
		}
	});

	/*
	 * A request that began before a lock is refused even if it never reached an
	 * await — the counter is compared at the door, not only after the work.
	 */
	it('refuses a request that belongs to a generation the lock has passed', async () => {
		const { host, created } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const since = browsers.generationNow();
		await browsers.closeAll();

		expect(why(await settled(browsers.open(DIRECT, since)))).toMatch(/locked/i);
		expect(created, 'a window was built for a request the lock had cancelled').toHaveLength(0);
	});

	it('still opens for a request that began after the lock', async () => {
		const { host, created, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		await browsers.closeAll();
		const after = browsers.open(DIRECT);
		release();
		await after;

		expect(created).toHaveLength(1);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);
	});
});

/*
 * **A wipe outlives the call that started it.**
 *
 * `dropAccountRouting` fires `closeAccount` and moves on — every caller of it
 * is a synchronous handler, so it has to. That left `clearStorageData` running
 * after the bookkeeping was already gone: save a proxy, press Trade
 * immediately, and the new window opened on the same partition, set its Steam
 * cookie, and then the previous account's wipe arrived and erased it. A browser
 * that signs itself out a moment after opening, with nothing on screen able to
 * say why.
 */
describe('a browser opened while the previous session is still being wiped', () => {
	/** A host whose storage wipe can be held open. */
	function wipeHarness() {
		const order: string[] = [];
		let releaseWipe: (() => void) | undefined;
		const host: BrowserHost = {
			sessionFromPartition: (partition) => ({
				denyPermissions: () => undefined,
				resolveProxy: () => Promise.resolve('DIRECT'),
				setProxy: () => Promise.resolve(),
				setUserAgent: () => undefined,
				clearStorageData: () =>
					new Promise<void>((resolve) => {
						order.push(`wipe:${partition}`);
						releaseWipe = () => {
							order.push('wiped');
							resolve();
						};
					}),
				cookies: {
					set: () => {
						order.push('cookie');
						return Promise.resolve();
					}
				}
			}),
			createWindow: () => ({
				loadURL: () => Promise.resolve(),
				currentUrl: () => START_URL,
				setTitle: () => undefined,
				setWebRtcPolicy: () => undefined,
				setProxyCredentials: () => undefined,
				focus: () => undefined,
				close: () => undefined,
				isDestroyed: () => false,
				on: () => undefined,
				setWindowOpenHandler: () => undefined
			})
		};
		return { host, order, release: () => releaseWipe?.() };
	}

	it('waits for the wipe instead of racing it', async () => {
		const { host, order, release } = wipeHarness();
		const browsers = new AccountBrowsers(host);

		// A routing change, fired and not awaited — exactly as `dropAccountRouting`
		// does it.
		void browsers.closeAccount(ACCOUNT.steamId64).catch(() => undefined);
		// And Trade pressed immediately afterwards.
		const opening = browsers.open(ACCOUNT);

		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		await opening;

		// The new cookie must be set *after* the old wipe finished, or the wipe
		// erases it.
		expect(order.indexOf('wiped')).toBeLessThan(order.indexOf('cookie'));
	});

	it('still opens once the wipe is done', async () => {
		const { host, release } = wipeHarness();
		const browsers = new AccountBrowsers(host);

		void browsers.closeAccount(ACCOUNT.steamId64).catch(() => undefined);
		const opening = browsers.open(ACCOUNT);
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		await opening;

		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);
	});
});

/*
 * **Closing the window was a way to end a session without ending it.**
 *
 * `windows` is a map of what is *open*, and the vault lock swept exactly that.
 * So a window the user closed themselves had already removed its own entry, and
 * `closeAll` found nothing to wipe: the partition kept its `steamLoginSecure`
 * until the process exited, and reopening the browser found Steam still signed
 * in with no passphrase asked for in between.
 */
describe('a browser the user closes themselves', () => {
	it('takes its Steam session with it', async () => {
		const { host, recorded, endWindow } = harness();
		const browsers = new AccountBrowsers(host);
		await browsers.open(ACCOUNT);
		expect(recorded.wiped).toEqual([]);

		// The window's own `closed`, as Electron fires it when somebody clicks the X.
		endWindow();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(recorded.wiped, 'the cookie jar outlived the window').toContain(
			browserPartitionFor(ACCOUNT.steamId64)
		);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
	});

	/*
	 * And the lock is still a backstop for it, because the close handler is an
	 * event: nothing awaits it, and a partition seeded by an open that failed
	 * halfway never had a window to close at all.
	 */
	it('is wiped again by the lock, not skipped by it', async () => {
		const { host, recorded, endWindow } = harness();
		const browsers = new AccountBrowsers(host);
		await browsers.open(ACCOUNT);
		endWindow();
		recorded.wiped.length = 0;

		await browsers.closeAll();

		expect(recorded.wiped, 'the lock passed over a partition it had seeded').toContain(
			browserPartitionFor(ACCOUNT.steamId64)
		);
	});

	it('is wiped by the lock even when the open never finished', async () => {
		const { host, recorded } = harness({ loadFails: true });
		const browsers = new AccountBrowsers(host);
		await browsers.open(ACCOUNT).catch(() => undefined);
		recorded.wiped.length = 0;

		await browsers.closeAll();

		expect(recorded.wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});
});

/*
 * **A routing change must cancel the request queued behind the one it cancels.**
 *
 * Pressing the other routing button queues a request behind the open already
 * running, and that retry re-read the account's routing epoch *fresh* — after
 * any change that had landed while it waited. So saving a new proxy cancelled
 * the request in flight, correctly, and the one queued behind it carried on:
 * a signed-in Steam window, opened through the proxy the user had just
 * replaced, in front of the operator they had just moved away from.
 *
 * The lock counter already travelled with the retry. The per-account one did
 * not, which is why a lock was caught here and a routing change was not.
 */
describe('a queued route switch when the account’s routing changes', () => {
	it('is cancelled along with the request it was waiting for', async () => {
		const { host, created, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const first = settled(browsers.open(DIRECT));
		const second = settled(browsers.open(PROXIED));

		// The proxy is replaced while the first is opening and the second waits.
		await browsers.closeAccount(ACCOUNT.steamId64);
		release();

		expect(why(await first)).toMatch(/routing changed/i);
		expect(
			why(await second),
			'the queued request opened through the proxy that was just replaced'
		).toMatch(/routing changed/i);

		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
		for (const window of created) {
			expect(window.closed, 'a window survived the routing change').toBe(true);
		}
	});

	/*
	 * And the request's own teardown is not mistaken for somebody else's change.
	 * Switching routes bumps the same counter on purpose, a few lines before the
	 * check — reading it too late would make every switch cancel itself.
	 */
	it('still lets an ordinary route switch through', async () => {
		const { host, created, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const first = browsers.open(DIRECT);
		expect(release()).toBe(1);
		await first;

		const switching = browsers.open(PROXIED);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(release()).toBe(1);
		await switching;

		expect(created).toHaveLength(2);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);
	});
});

/*
 * **Steam through the proxy, everything else direct.**
 *
 * The mode exists because a fully routed window is often the one that will not
 * load: a proxy address shared between accounts collects the rate limits and
 * Cloudflare interstitials a home connection never sees, and a market page
 * pulls in far more from CDNs and third-party trade sites than from Steam
 * itself. Going fully direct fixes the loading and puts this machine's address
 * on the account, which is what the proxy was for.
 *
 * So the promise has two halves, and only one of them is a security property:
 * **every** Steam request goes through the proxy, and non-Steam requests are
 * allowed not to. A bug in the second half is slow browsing. A bug in the first
 * half is the user's real address arriving at Steam on a routed account, from a
 * window that looks exactly like the one they asked for.
 */
describe('routing only Steam through the proxy', () => {
	/** The bypass list the session was actually given. */
	function bypassOf(proxies: unknown[]): string {
		return String((proxies.at(-1) as { proxyBypassRules?: string }).proxyBypassRules ?? '');
	}

	/**
	 * **These assert the configuration, not the routing.**
	 *
	 * That split is deliberate and was learned the hard way. This mode was built
	 * as a PAC script, and the tests evaluated the script themselves to decide
	 * what Chromium "would" do. They agreed with the script perfectly and were
	 * wrong about Chromium: it bypasses `localhost`, `[::1]` and
	 * `169.254.169.254` *before* consulting a PAC, and `<-loopback>` does not
	 * switch that off in `pac_script` mode. A window sold as routed could reach
	 * the cloud-metadata address off-proxy, and 175 green tests said otherwise.
	 *
	 * So a fake no longer pretends to resolve proxies. What the code asks for is
	 * checked here; what Chromium does with it is checked against a real session
	 * in `tools/smoke-browser-window.mjs`, which now prints the whole resolution
	 * table including loopback and link-local.
	 */
	it('routes through the proxy and names exceptions, rather than the reverse', async () => {
		const { host, proxies } = routingHarness();
		await new AccountBrowsers(host).open(STEAM_ONLY);

		/*
		 * `fixed_servers`, like the fully routed window. The mode is the whole
		 * fix: it is the only one of the two in which `<-loopback>` is honoured.
		 */
		expect(proxies.at(-1)).toMatchObject({
			mode: 'fixed_servers',
			proxyRules: 'http://10.0.0.9:8080'
		});
		expect(proxies.at(-1), 'a PAC script came back').not.toHaveProperty('pacScript');
	});

	it('keeps <-loopback>, so local and link-local addresses cannot skip it', async () => {
		const { host, proxies } = routingHarness();
		await new AccountBrowsers(host).open(STEAM_ONLY);

		/*
		 * Without this, Chromium's implicit bypass stands and the window reaches
		 * `127.0.0.1` and `169.254.169.254` directly — the second of which is the
		 * instance metadata service on any cloud host.
		 */
		expect(bypassOf(proxies)).toContain('<-loopback>');
	});

	it('gives the fully routed window <-loopback> and nothing else', async () => {
		const { host, proxies } = routingHarness();
		await new AccountBrowsers(host).open(PROXIED);

		// "Everything in the window goes through it" is what the button promises.
		expect(bypassOf(proxies)).toBe('<-loopback>');
	});

	it.each(DIRECT_CONTENT_DOMAINS.map((domain) => [domain]))(
		'lets %s out directly, in both spellings',
		async (domain) => {
			const { host, proxies } = routingHarness();
			await new AccountBrowsers(host).open(STEAM_ONLY);
			const rules = bypassOf(proxies).split(',');

			/*
			 * **Both, and this was measured rather than assumed.** In Electron
			 * 43.3.0 a bypass entry of `csfloat.com` does not match
			 * `www.csfloat.com`, and `*.csfloat.com` does not match the apex. A
			 * list carrying one spelling proxies half of each site — the half
			 * nobody happens to open while testing.
			 */
			expect(rules, `${domain} apex is not exempt`).toContain(domain);
			expect(rules, `${domain} subdomains are not exempt`).toContain(`*.${domain}`);
		}
	);

	/**
	 * **Nothing Steam owns may appear in the bypass list.**
	 *
	 * The list is the only thing in this mode that sends traffic around the
	 * proxy, so this is the invariant with teeth: an entry that covered a Steam
	 * domain would put the account's own traffic on this machine's address, in
	 * the mode chosen to prevent exactly that.
	 */
	it('never exempts anything Steam owns', async () => {
		const { host, proxies } = routingHarness();
		await new AccountBrowsers(host).open(STEAM_ONLY);

		for (const rule of bypassOf(proxies).split(',')) {
			if (rule === '<-loopback>') {
				continue;
			}
			const bare = rule.replace(/^\*\./, '');
			expect(isSteamRoutedHost(bare), `${rule} exempts a Steam domain`).toBe(false);
			expect(isDirectContentHost(bare), `${rule} is on neither list`).toBe(true);
		}
	});

	/*
	 * The predicates and the bypass list are two statements of one rule, so the
	 * lists are checked against each other rather than against a fake resolver.
	 */
	it('keeps the two lists disjoint', () => {
		for (const domain of STEAM_ROUTED_DOMAINS) {
			expect(isDirectContentHost(domain), `${domain} was treated as third-party`).toBe(false);
		}
		for (const domain of DIRECT_CONTENT_DOMAINS) {
			expect(isSteamRoutedHost(domain), `${domain} was treated as Steam`).toBe(false);
		}
	});

	/**
	 * **Every domain the mode promises, asked about one at a time.**
	 *
	 * The fully routed window can be settled with one question, because one rule
	 * decides its whole session. A bypass list cannot: an entry with the wrong
	 * spelling covers more or less than it reads as, and the failure is per host.
	 * Checking only the start page would pass a list that exempted the store, the
	 * CDNs and the login server — and the window would open on a page that looked
	 * right.
	 */
	it('refuses when the start page routes but the rest of Steam does not', async () => {
		const { host, recorded } = harness({
			resolvesDirectFor: (url) => url.includes('steampowered.com')
		});

		await expect(
			openAccountBrowser(host, {
				...ACCOUNT,
				proxyUrl: 'http://10.0.0.9:8080',
				route: 'steam-only'
			})
		).rejects.toThrow(/would not/i);

		expect(recorded.windows, 'the store and the CDNs would have leaked').toHaveLength(0);
	});

	it('refuses when an unrecognised host would go around the proxy', async () => {
		const { host, recorded } = harness({
			resolvesDirectFor: (url) => url.includes('.invalid')
		});

		await expect(
			openAccountBrowser(host, {
				...ACCOUNT,
				proxyUrl: 'http://10.0.0.9:8080',
				route: 'steam-only'
			})
		).rejects.toThrow(/would not/i);

		expect(recorded.windows).toHaveLength(0);
	});

	/**
	 * And the one the PAC design failed, on both routed choices.
	 *
	 * `169.254.169.254` is named rather than sampled: on a cloud host it is the
	 * instance metadata service, which answers unauthenticated requests with
	 * credentials.
	 */
	it.each([
		['proxy' as const, 'localhost'],
		['proxy' as const, '127.0.0.1'],
		['proxy' as const, '169.254.169.254'],
		['steam-only' as const, 'localhost'],
		['steam-only' as const, '127.0.0.1'],
		['steam-only' as const, '169.254.169.254']
	])('refuses when %s would let %s skip the proxy', async (route, hostname) => {
		const { host, recorded } = harness({
			resolvesDirectFor: (url) => url.includes(hostname)
		});

		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080', route })
		).rejects.toThrow(/would not/i);

		expect(recorded.windows).toHaveLength(0);
	});

	it('asks about every Steam domain, and about one host on no list at all', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://10.0.0.9:8080',
			route: 'steam-only'
		});

		for (const domain of STEAM_ROUTED_DOMAINS) {
			expect(recorded.resolved, `${domain} was never checked`).toContain(`https://${domain}/`);
		}
		expect(
			recorded.resolved.some((url) => url.endsWith('.invalid/')),
			'the fail-closed default was never checked'
		).toBe(true);
	});

	it('checks the loopback and link-local addresses on both routed choices', async () => {
		for (const route of ['proxy', 'steam-only'] as const) {
			const { host, recorded } = harness();
			await openAccountBrowser(host, {
				...ACCOUNT,
				proxyUrl: 'http://10.0.0.9:8080',
				route
			});

			for (const probe of ['localhost', '127.0.0.1', '[::1]', '169.254.169.254']) {
				expect(
					recorded.resolved.some((url) => url.includes(probe)),
					`${route} never checked ${probe}`
				).toBe(true);
			}
		}
	});

	/*
	 * An account with nothing stored has no proxy to send Steam through, so the
	 * mode has nothing to offer and must not pretend otherwise.
	 */
	it('applies no bypass list for an account with no proxy', async () => {
		const { host, proxies } = routingHarness();
		await new AccountBrowsers(host).open({ ...ACCOUNT, route: 'steam-only' });

		expect(proxies.at(-1)).toMatchObject({ mode: 'system' });
	});

	/*
	 * WebRTC leaks the host's real address around whatever the page was told to
	 * use, and a Steam page is exactly where that matters. The fully routed
	 * window blocks it; this one is no less routed as far as Steam is concerned.
	 */
	it('still blocks non-proxied WebRTC', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, {
			...ACCOUNT,
			proxyUrl: 'http://10.0.0.9:8080',
			route: 'steam-only'
		});

		expect(recorded.webRtcPolicies).toEqual(['disable_non_proxied_udp']);
	});
});

/**
 * **Turning the rule on has to reach the work already running.**
 *
 * Saving `Require proxies` wrote a vault field and did nothing else. A Direct or
 * Steam-only window opened a minute earlier stayed on screen, stayed signed in
 * to Steam, and went on making the requests the user had just forbidden — while
 * the switch they pressed told them otherwise.
 */
describe('closing the windows a new policy forbids', () => {
	it('closes the direct window', async () => {
		const { host, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);
		await browsers.open(DIRECT);

		await browsers.closeNotFullyRouted();

		expect(windows[0]?.closed, 'a direct window survived the rule that forbids it').toBe(true);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
	});

	/*
	 * And the partially direct one, which is the case most likely to be argued
	 * about: Steam is routed, and a short list of trade sites is not.
	 */
	it('closes the Steam-only window', async () => {
		const { host, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);
		await browsers.open(STEAM_ONLY);

		await browsers.closeNotFullyRouted();

		expect(windows[0]?.closed).toBe(true);
	});

	it('leaves the fully routed window alone', async () => {
		const { host, windows } = routingHarness();
		const browsers = new AccountBrowsers(host);
		await browsers.open(PROXIED);

		await browsers.closeNotFullyRouted();

		expect(windows[0]?.closed, 'a compliant window was taken down for no reason').toBe(false);
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(true);
	});

	/*
	 * The session goes with the window. A closed window whose partition still
	 * holds `steamLoginSecure` is a signed-in Steam session waiting for the next
	 * open to inherit it — which is the state `closeAll` exists to prevent.
	 */
	it('wipes the session of the window it closes', async () => {
		const { host, wiped } = routingHarness();
		const browsers = new AccountBrowsers(host);
		await browsers.open(DIRECT);

		await browsers.closeNotFullyRouted();

		expect(wiped).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});

	it('does nothing when there is nothing open', async () => {
		const { host, windows } = routingHarness();
		await new AccountBrowsers(host).closeNotFullyRouted();
		expect(windows).toEqual([]);
	});

	/**
	 * **The open that has not finished yet, which is the likeliest offender.**
	 *
	 * Somebody presses Direct and turns the rule on a second later. That request
	 * is not in `routes` — it has no window yet — so a sweep reading only that
	 * map walked straight past it, and the window appeared *after* the rule
	 * forbidding it was already in force.
	 */
	it('cancels a non-compliant open that has not produced a window yet', async () => {
		const { host, created, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const opening = browsers.open(DIRECT);
		// Let it reach the first await, so it is registered as in flight.
		await new Promise((resolve) => setTimeout(resolve, 0));

		await browsers.closeNotFullyRouted();
		release();

		await expect(opening, 'the window opened under a rule that forbids it').rejects.toThrow();
		expect(browsers.isOpen(ACCOUNT.steamId64)).toBe(false);
		expect(created.filter((window) => !window.closed)).toEqual([]);
	});

	it('leaves a fully routed open in flight alone', async () => {
		const { host, release } = slowHarness();
		const browsers = new AccountBrowsers(host);

		const opening = browsers.open(PROXIED);
		await new Promise((resolve) => setTimeout(resolve, 0));

		await browsers.closeNotFullyRouted();
		release();

		await expect(opening, 'a compliant open was cancelled for no reason').resolves.toBeUndefined();
	});

	/**
	 * **And the sweep does not queue behind its own cleanup.**
	 *
	 * Each close ends in a session wipe. Awaited one at a time, a slow wipe on
	 * the first offender left the second window open, signed in, and making
	 * requests for as long as that took — the sweep's own bookkeeping holding
	 * the door for the thing it was sent to close.
	 */
	it('closes every offender without waiting for the first wipe', async () => {
		let releaseWipe!: () => void;
		const slowWipe = new Promise<void>((resolve) => {
			releaseWipe = resolve;
		});
		const closed: string[] = [];
		const first = '76561198000000003';
		const second = '76561198000000004';

		const host: BrowserHost = {
			sessionFromPartition: (partition) => ({
				denyPermissions: () => undefined,
				resolveProxy: () => Promise.resolve('DIRECT'),
				setProxy: () => Promise.resolve(),
				setUserAgent: () => undefined,
				clearStorageData: () =>
					partition === browserPartitionFor(first) ? slowWipe : Promise.resolve(),
				cookies: { set: () => Promise.resolve() }
			}),
			createWindow: () => {
				throw new Error('no window is created in this test');
			}
		};

		const browsers = new AccountBrowsers(host);
		const state = browsers as unknown as {
			windows: Map<string, { close: () => void; isDestroyed: () => boolean }>;
			routes: Map<string, string>;
		};
		for (const id of [first, second]) {
			state.windows.set(id, {
				close: () => closed.push(id),
				isDestroyed: () => false
			});
			state.routes.set(id, 'direct');
		}

		const sweeping = browsers.closeNotFullyRouted();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(closed, 'the second window waited on the first wipe').toEqual([first, second]);
		releaseWipe();
		await sweeping;
	});
});

/**
 * **A window whose load never settles is still a signed-in window.**
 *
 * `openAccountBrowser` creates the window, then loads a page into it. The
 * manager records what that function *returns*, so for the whole duration of
 * the load there is a signed-in `WebContents` on screen that no map knows
 * about. Every failure path was covered — both of them close the window and
 * wipe the session before rethrowing — and a load that simply hangs reaches
 * neither, because it never returns at all.
 *
 * A lock in that window used to complete, report success, and begin wiping
 * storage while the window stayed open and logged in, for as long as the hang
 * lasted. Nothing bounds that.
 *
 * These hold `loadURL` unresolved on purpose. The assertion that matters is
 * that the real handle is closed **before** the load is ever released.
 */
describe('a browser whose first load never settles', () => {
	it('is closed by a vault lock, without waiting for the load', async () => {
		const h = harness({ loadHangs: true });
		const browsers = new AccountBrowsers(h.host);

		// Never awaited: it cannot settle. The catch keeps the rejection this
		// eventually produces from failing the run.
		void browsers.open(ACCOUNT).catch(() => undefined);
		// Let the open reach `createWindow` and park on the load.
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}

		expect(h.recorded.windows, 'the window should exist by now').toHaveLength(1);
		expect(h.recorded.closed, 'it should still be open before the lock').toBe(0);

		await browsers.closeAll();

		expect(
			h.recorded.closed,
			'the lock finished while a signed-in window was still on screen'
		).toBe(1);
	});

	it('is closed when the account routing changes', async () => {
		const h = harness({ loadHangs: true });
		const browsers = new AccountBrowsers(h.host);

		void browsers.open(ACCOUNT).catch(() => undefined);
		// Let the open reach `createWindow` and park on the load.
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}
		expect(h.recorded.closed).toBe(0);

		await browsers.closeAccount(ACCOUNT.steamId64);

		expect(
			h.recorded.closed,
			'the window went on browsing over the route the user just replaced'
		).toBe(1);
	});

	/*
	 * And the partition is wiped, which is the other half of what a lock owes:
	 * the Steam cookie was written before the load began.
	 */
	it('has its partition wiped by the lock as well', async () => {
		const h = harness({ loadHangs: true });
		const browsers = new AccountBrowsers(h.host);

		void browsers.open(ACCOUNT).catch(() => undefined);
		// Let the open reach `createWindow` and park on the load.
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}
		await browsers.closeAll();

		expect(h.recorded.wiped.length, 'a signed-in partition survived the lock').toBeGreaterThan(0);
	});
});

/**
 * **An open that ended must leave nothing behind to close again.**
 *
 * `openAccountBrowser` closes the window itself before rethrowing, so the entry
 * recorded while it was building is stale the moment the throw happens. Left
 * there, a later lock closes an already-closed window — harmless in isolation,
 * but it means the map grows one dead handle per failed open and a sweep can no
 * longer tell what it actually closed.
 */
describe('after an open that did not finish', () => {
	it('leaves nothing half-built for a later lock to close twice', async () => {
		const h = harness({ loadFails: true });
		const browsers = new AccountBrowsers(h.host);

		await expect(browsers.open(ACCOUNT)).rejects.toBeInstanceOf(BrowserSessionError);
		const afterOpen = h.recorded.closed;
		expect(afterOpen, 'the failed open should have closed its own window').toBe(1);

		await browsers.closeAll();
		expect(h.recorded.closed, 'the lock closed a window that was already gone').toBe(afterOpen);
	});
});

/**
 * **A partition that could not be emptied must not be reused.**
 *
 * `clearStorageData` rejecting was swallowed, and the marker saying "there is
 * something in here" was dropped in the same breath. The partition name is
 * derived from the account id, so the next open landed on that exact jar —
 * still holding the previous `steamLoginSecure`.
 *
 * Two of the things this module exists to prevent, from one swallowed error: a
 * Steam session outliving the lock that ended it, and an account's old route
 * and its new one sharing a cookie jar, which links them.
 */
describe('a partition the app could not clear', () => {
	it('refuses the next open rather than reusing it', async () => {
		const h = harness({ wipeFails: true });
		const browsers = new AccountBrowsers(h.host);

		await browsers.open(ACCOUNT);
		await browsers.closeAccount(ACCOUNT.steamId64);

		await expect(
			browsers.open(ACCOUNT),
			'a window opened onto a jar that still held the old session'
		).rejects.toBeInstanceOf(BrowserSessionError);
	});

	it('says why, and what would clear it', async () => {
		const h = harness({ wipeFails: true });
		const browsers = new AccountBrowsers(h.host);
		await browsers.open(ACCOUNT);
		await browsers.closeAccount(ACCOUNT.steamId64);

		const outcome = await settled(browsers.open(ACCOUNT));
		expect(why(outcome)).toMatch(/could not be cleared/i);
		expect(why(outcome), 'the refusal did not say how to recover').toMatch(/lock|restart/i);
	});

	/*
	 * One retry before refusing: the usual cause is a session that was
	 * momentarily unreachable, and refusing something the user just asked for
	 * without asking again is worse than the failure.
	 */
	it('retries once, and opens when the retry succeeds', async () => {
		const h = harness({ wipeFails: true });
		const browsers = new AccountBrowsers(h.host);
		await browsers.open(ACCOUNT);
		await browsers.closeAccount(ACCOUNT.steamId64);

		// Whatever was wrong has passed.
		h.letWipeSucceed();
		await expect(browsers.open(ACCOUNT)).resolves.toBeUndefined();
	});

	it('does not refuse when the wipe worked', async () => {
		const h = harness();
		const browsers = new AccountBrowsers(h.host);
		await browsers.open(ACCOUNT);
		await browsers.closeAccount(ACCOUNT.steamId64);
		await expect(browsers.open(ACCOUNT)).resolves.toBeUndefined();
	});
});

/*
 * The other wipe path. `closeAccount` hands the window to `abandon`; a lock
 * sweep wipes partitions it has no window for — a window the user closed
 * themselves is the common case — and that branch clears storage directly.
 * Both have to record the outcome, and only one of them did.
 */
describe('a partition a lock could not clear', () => {
	it('refuses the next open rather than reusing it', async () => {
		const h = harness({ wipeFails: true });
		const browsers = new AccountBrowsers(h.host);

		await browsers.open(ACCOUNT);
		h.endWindow(); // the user closed it, so the lock has no handle
		await browsers.closeAll();

		await expect(
			browsers.open(ACCOUNT),
			'a lock that could not empty the jar let the next window reuse it'
		).rejects.toBeInstanceOf(BrowserSessionError);
	});

	it('opens normally when the lock did clear it', async () => {
		const h = harness();
		const browsers = new AccountBrowsers(h.host);
		await browsers.open(ACCOUNT);
		h.endWindow();
		await browsers.closeAll();
		await expect(browsers.open(ACCOUNT)).resolves.toBeUndefined();
	});
});

/**
 * **The sweeps that must reach a window whose load never settled.**
 *
 * Handing the window over before the load is only half the fix; every path that
 * tears a window down has to look in that map. `closeNotFullyRouted` did not,
 * so turning on `Require proxies` bumped the epoch for an in-flight open — a
 * check that only runs after an await which, for a hanging load, never
 * arrives — and left the unrouted signed-in window on screen under a rule
 * forbidding exactly it.
 */
describe('Require proxies while a window is still being built', () => {
	it('closes an unrouted window whose load has not settled', async () => {
		const h = harness({ loadHangs: true });
		const browsers = new AccountBrowsers(h.host);

		void browsers.open({ ...ACCOUNT, route: 'direct' }).catch(() => undefined);
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}
		expect(h.recorded.windows, 'the window should exist by now').toHaveLength(1);

		await browsers.closeNotFullyRouted();

		expect(
			h.recorded.closed,
			'an unrouted signed-in window survived the rule that forbids it'
		).toBe(1);
	});
});

/**
 * **A wipe that failed has to be remembered on every path that performs one.**
 *
 * Three of them dropped the answer: the cancel branch inside `open`, and both
 * refusal paths inside `openAccountBrowser`. A partition left holding a
 * `steamLoginSecure` is then reused by the next open — including one on a
 * different route, which is the two routes sharing a cookie jar that links
 * them.
 */
describe('a wipe that failed on a path other than closeAccount', () => {
	it('is remembered when a failed load could not clear the jar', async () => {
		const h = harness({ loadFails: true, wipeFails: true });
		const browsers = new AccountBrowsers(h.host);

		await expect(browsers.open(ACCOUNT)).rejects.toBeInstanceOf(BrowserSessionError);

		// The retry is the observable: a remembered dirty partition refuses rather
		// than reusing the jar the failed attempt signed into.
		h.letLoadSucceed();
		await expect(
			browsers.open(ACCOUNT),
			'the next open reused a jar the failed attempt had signed into'
		).rejects.toBeInstanceOf(BrowserSessionError);
	});

	/*
	 * And a lock reaches it. `closeAccount` removes the account from `seeded`
	 * before wiping, so a wipe that then failed left it in neither map — and the
	 * lock sweep, built from those two, issued no clear at all. The refusal the
	 * user sees says to lock and unlock the vault; this is what makes that true.
	 */
	it('is wiped by the next lock, which is what the refusal advises', async () => {
		const h = harness({ wipeFails: true });
		const browsers = new AccountBrowsers(h.host);

		await browsers.open(ACCOUNT);
		await browsers.closeAccount(ACCOUNT.steamId64);
		const afterClose = h.recorded.wiped.length;

		await browsers.closeAll();

		expect(
			h.recorded.wiped.length,
			'the lock did not even try the partition it had been told was dirty'
		).toBeGreaterThan(afterClose);
	});
});
