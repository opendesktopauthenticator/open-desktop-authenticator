import { describe, expect, it, vi } from 'vitest';
import {
	BROWSER_USER_AGENT,
	BrowserSessionError,
	browserPartitionFor,
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
}

function harness(overrides: { setProxy?: () => Promise<void> } = {}) {
	const recorded: Recorded = {
		partitions: [],
		proxies: [],
		userAgents: [],
		cookies: [],
		windows: [],
		loaded: []
	};

	const session: BrowserSessionHandle = {
		setProxy: overrides.setProxy
			? overrides.setProxy
			: async (config) => {
					recorded.proxies.push(config);
				},
		setUserAgent: (ua) => recorded.userAgents.push(ua),
		cookies: {
			set: async (cookie) => {
				recorded.cookies.push({ url: cookie.url, name: cookie.name, value: cookie.value });
			}
		}
	};

	const window: BrowserWindowHandle = {
		loadURL: async (url) => {
			recorded.loaded.push(url);
		},
		close: vi.fn(),
		isDestroyed: () => false,
		on: vi.fn(),
		setWindowOpenHandler: vi.fn()
	};

	const host: BrowserHost = {
		sessionFromPartition: (partition) => {
			recorded.partitions.push(partition);
			return session;
		},
		createWindow: (options) => {
			recorded.windows.push(options);
			return window;
		}
	};

	return { host, recorded };
}

const ACCOUNT = {
	steamId64: '76561198000000001',
	accountName: 'demo_trader',
	accessToken: 'eyJhbGciOiJFZERTQSJ9.token.signature'
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

	it('routes through the account’s proxy when it has one', async () => {
		const { host, recorded } = harness();
		await openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://user:pass@10.0.0.9:8080' });

		expect(recorded.proxies).toHaveLength(1);
		expect(recorded.proxies[0]).toMatchObject({ mode: 'fixed_servers' });
		expect(JSON.stringify(recorded.proxies[0])).toContain('10.0.0.9:8080');
		// Credentials belong to the proxy, never to a rule string.
		expect(JSON.stringify(recorded.proxies[0])).not.toContain('pass');
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
			setProxy: async () => {
				throw new Error('ERR_PROXY_CONNECTION_FAILED');
			}
		});

		await expect(
			openAccountBrowser(host, { ...ACCOUNT, proxyUrl: 'http://10.0.0.9:8080' })
		).rejects.toBeInstanceOf(BrowserSessionError);

		expect(recorded.windows, 'a window was opened despite routing failing').toHaveLength(0);
		expect(recorded.loaded).toHaveLength(0);
	});

	it('names the proxy in the failure without leaking its password', async () => {
		const { host } = harness({
			setProxy: async () => {
				throw new Error('nope');
			}
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
