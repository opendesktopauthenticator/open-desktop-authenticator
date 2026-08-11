import { describe, expect, it, vi } from 'vitest';
import {
	describeNetworkError,
	describesDirectRoute,
	redactCredentials,
	EgressError,
	isSteamEndpoint,
	planProxy,
	STEAM_USER_AGENT
} from '../src/main/net/egress';
import { SteamTransportFactory } from '../src/main/net/transport';
import type {
	ElectronNetworking,
	NetRequestHandle,
	NetResponseHandle,
	ProxyCapableSession
} from '../src/main/net/transport';

/**
 * Per-account egress (§10.1, F-08).
 *
 * The founder's requirement is that every Steam request for a routed account
 * goes through that account's proxy — not most of them, and never a silent
 * fallback to the user's own address. The tests below are almost all about
 * refusing rather than succeeding, because a routing feature that fails open is
 * worse than none: the user believes they are anonymous and they are not.
 */

describe('planning a proxy', () => {
	it('keeps credentials out of the proxy rule', () => {
		// Chromium's proxy rules have no syntax for credentials. A rule containing
		// them is either rejected or parsed with `user:pass@` as part of the
		// hostname, and the second outcome connects to nothing.
		const plan = planProxy('socks5://alice:s3cret@10.0.0.1:1080');

		expect(plan.proxyRules).toBe('socks5://10.0.0.1:1080');
		expect(plan.proxyRules).not.toContain('alice');
		expect(plan.proxyRules).not.toContain('s3cret');
		expect(plan.credentials).toEqual({ username: 'alice', password: 's3cret' });
	});

	it('translates socks5h, which Chromium does not know by that name', () => {
		// curl's spelling for remote DNS. Chromium's socks5 already resolves at the
		// proxy, so they mean the same thing — but the literal string yields
		// ERR_NO_SUPPORTED_PROXIES, so the translation is mandatory.
		expect(planProxy('socks5h://10.0.0.1:1080').proxyRules).toBe('socks5://10.0.0.1:1080');
	});

	it('keeps the port, because a guessed one fails silently', () => {
		expect(planProxy('http://proxy.example:8080').proxyRules).toBe('http://proxy.example:8080');
		expect(planProxy('http://proxy.example').proxyRules).toBe('http://proxy.example');
	});

	it('decodes percent-encoded credentials', () => {
		// Stored URLs encode them. Authenticating with the literal `%40` rather than
		// the `@` the proxy expects is a failure with no useful error.
		const plan = planProxy('socks5://user%40host:p%40ss%3Aword@10.0.0.1:1080');

		expect(plan.credentials).toEqual({ username: 'user@host', password: 'p@ss:word' });
	});

	it('redacts credentials for display rather than shortening them', () => {
		const plan = planProxy('socks5://alice:s3cret@10.0.0.1:1080');

		expect(plan.redacted).toBe('socks5://***:***@10.0.0.1:1080');
		expect(plan.redacted).not.toContain('s3cret');
	});

	it('refuses a scheme Chromium cannot route', () => {
		// Accepted by setProxy without complaint, then failing per request with an
		// error the user cannot trace back to what they typed.
		for (const bad of ['ftp://h:1', 'gopher://h:1', 'file:///etc/passwd', 'javascript:alert(1)']) {
			expect(() => planProxy(bad), bad).toThrow(EgressError);
		}
	});

	it('refuses something that is not a URL at all', () => {
		for (const bad of ['', 'not a url', '10.0.0.1:1080']) {
			expect(() => planProxy(bad), bad).toThrow(EgressError);
		}
	});

	it('does not announce the application in the User-Agent', () => {
		// Electron's default says `Electron/43.3.0`, which identifies this app to
		// Steam and to the proxy operator — the two parties routing exists to keep
		// at arm's length.
		expect(STEAM_USER_AGENT).not.toMatch(/electron/i);
		expect(STEAM_USER_AGENT).not.toMatch(/open desktop|authenticator/i);
	});
});

/** An allowlisted Steam endpoint, so `isSteamEndpoint` is not what is under test. */
const STEAM_URL = 'https://steamcommunity.com/mobileconf/getlist';

/**
 * A fake Electron that records everything asked of it.
 *
 * `reply.requireProxyAuth` makes it behave like a real authenticating proxy: the
 * request is challenged, and if nothing answers with credentials it fails with
 * `ERR_TUNNEL_CONNECTION_FAILED` — the same way an unanswered CONNECT does.
 * Without that, a fake accepts every request whether or not the credentials were
 * ever delivered, which is exactly how proxy authentication shipped broken.
 */
function fakeElectron(
	reply: {
		status?: number;
		body?: string;
		error?: Error;
		requireProxyAuth?: boolean;
		/** A `login` challenge that is not the proxy — the destination asking for HTTP auth. */
		challengeAsOrigin?: boolean;
		/** Overrides what `resolveProxy` reports, whatever `setProxy` was given. */
		resolvesTo?: string;
		/** Leaves the request hanging, so a lock has something in flight to cancel. */
		neverSettles?: boolean;
	} = {}
): {
	electron: ElectronNetworking;
	sessions: {
		partition: string;
		proxy: unknown;
		userAgent?: string;
		cleared?: number;
	}[];
	requests: {
		url: string;
		method: string;
		headers: Record<string, string>;
		body: string;
		/** Credentials this request answered the proxy challenge with, if any. */
		proxyAuth?: { username?: string; password?: string };
		/** Redirect policy the transport asked for. Must always be `error`. */
		redirect?: string;
	}[];
	/** How many in-flight requests were cancelled. */
	aborted: () => number;
	/**
	 * Applies whatever the transport registered with `onBeforeSendHeaders`.
	 *
	 * Exposed so the stripping can be tested against a realistic header set.
	 * Electron adds client hints *after* our own headers are set, so a test that
	 * only inspects `setHeader` calls would never see them and would pass no
	 * matter what the filter did.
	 */
	headerFilter: () => (headers: Record<string, string>) => Record<string, string>;
	failSetProxy?: Error;
} {
	const sessions: {
		partition: string;
		proxy: unknown;
		userAgent?: string;
		cleared?: number;
	}[] = [];
	const requests: {
		url: string;
		method: string;
		headers: Record<string, string>;
		body: string;
		proxyAuth?: { username?: string; password?: string };
		redirect?: string;
	}[] = [];
	let aborts = 0;
	let onHeaders:
		| ((
				details: { requestHeaders: Record<string, string> },
				callback: (response: { requestHeaders: Record<string, string> }) => void
		  ) => void)
		| undefined;
	const state: { failSetProxy?: Error } = {};

	/**
	 * Partition name → the one session that name refers to.
	 *
	 * Electron returns the **same** `Session` object every time it is asked for a
	 * given partition, and that is not an incidental detail: it is why cookies
	 * survive a dropped reference. A fake that handed back a fresh object each call
	 * would make that bug untestable — and did, until this was fixed.
	 */
	const byPartition = new Map<string, ProxyCapableSession>();

	const electron: ElectronNetworking = {
		sessionFromPartition(partition) {
			const existing = byPartition.get(partition);
			if (existing) {
				return existing;
			}

			const record: {
				partition: string;
				proxy: unknown;
				userAgent?: string;
				cleared?: number;
			} = {
				partition,
				proxy: undefined,
				cleared: 0
			};
			sessions.push(record);
			const session: ProxyCapableSession = {
				setProxy(config) {
					if (state.failSetProxy) {
						return Promise.reject(state.failSetProxy);
					}
					record.proxy = config;
					return Promise.resolve();
				},
				setUserAgent(userAgent) {
					record.userAgent = userAgent;
				},
				webRequest: {
					onBeforeSendHeaders(listener) {
						onHeaders = listener;
					}
				},
				clearStorageData() {
					record.cleared = (record.cleared ?? 0) + 1;
					return Promise.resolve();
				},
				/**
				 * Answers the way Chromium does, from whatever `setProxy` was given.
				 *
				 * `reply.resolvesTo` overrides it, which is how the interesting cases are
				 * reached: a bypassed host going DIRECT, a `; DIRECT` fallback, or a
				 * session carrying somebody else's proxy — all of which look configured.
				 */
				resolveProxy() {
					if (reply.resolvesTo !== undefined) {
						return Promise.resolve(reply.resolvesTo);
					}
					const config = record.proxy as { mode?: string; proxyRules?: string } | undefined;
					if (config?.mode !== 'fixed_servers' || config.proxyRules === undefined) {
						return Promise.resolve('DIRECT');
					}
					const [scheme = '', endpoint = ''] = config.proxyRules.split('://');
					const keyword = scheme.startsWith('socks') ? scheme.toUpperCase() : 'PROXY';
					return Promise.resolve(`${keyword} ${endpoint}`);
				}
				// No `on`. Electron's Session does not emit `login`, so neither does
				// this. A fake that offered one is why proxy credentials were handed to
				// an event that never fired, with a green suite the whole time.
			};
			byPartition.set(partition, session);
			return session;
		},
		request({ url, method, redirect }) {
			const entry: (typeof requests)[number] = {
				url,
				method,
				headers: {},
				body: '',
				...(redirect === undefined ? {} : { redirect })
			};
			requests.push(entry);

			const listeners: Record<string, ((...args: never[]) => void)[]> = {};
			const handle: NetRequestHandle = {
				setHeader(name, value) {
					entry.headers[name] = value;
				},
				write(chunk) {
					entry.body += chunk;
				},
				end() {
					if (reply.neverSettles === true) {
						return;
					}
					queueMicrotask(() => {
						// The proxy challenges during CONNECT, before the request is sent.
						// Nothing answering means no credentials reach it, and Chromium
						// reports the tunnel failure — not a 407, which the caller never
						// sees.
						if (reply.requireProxyAuth === true || reply.challengeAsOrigin === true) {
							const isProxy = reply.challengeAsOrigin !== true;
							let answered: { username?: string; password?: string } | undefined;
							listeners.login?.forEach((fn) =>
								(
									fn as (
										info: { isProxy: boolean },
										cb: (username?: string, password?: string) => void
									) => void
								)({ isProxy }, (username, password) => {
									answered = { username, password };
								})
							);
							entry.proxyAuth = answered;

							// Empty credentials cancel the request, exactly as Electron
							// documents — so an unanswered *or* declined challenge fails.
							if (answered?.username === undefined) {
								listeners.error?.forEach((fn) =>
									(fn as (e: Error) => void)(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'))
								);
								return;
							}
						}

						if (reply.error) {
							listeners.error?.forEach((fn) => (fn as (e: Error) => void)(reply.error as Error));
							return;
						}
						const responseListeners: Record<string, ((arg: never) => void)[]> = {};
						const response: NetResponseHandle = {
							statusCode: reply.status ?? 200,
							on(event, listener) {
								(responseListeners[event] ??= []).push(listener);
							}
						};
						listeners.response?.forEach((fn) => (fn as (r: NetResponseHandle) => void)(response));
						queueMicrotask(() => {
							responseListeners.data?.forEach((fn) =>
								(fn as (c: string) => void)(reply.body ?? '{"success":true}')
							);
							responseListeners.end?.forEach((fn) => (fn as () => void)());
						});
					});
				},
				on(event, listener) {
					(listeners[event] ??= []).push(listener);
				},
				abort() {
					aborts += 1;
				}
			};
			return handle;
		}
	};

	return {
		electron,
		sessions,
		requests,
		aborted: () => aborts,
		headerFilter: () => (headers) => {
			if (!onHeaders) {
				throw new Error('the transport never registered a header filter');
			}
			let result = headers;
			onHeaders({ requestHeaders: headers }, (response) => {
				result = response.requestHeaders;
			});
			return result;
		},
		...state
	};
}

describe('the transport', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };
	const unrouted = { steamId64: '76561198000000002' };

	it('applies the account proxy to its own session', async () => {
		const { electron, sessions } = fakeElectron();
		await new SteamTransportFactory(electron).forAccount(routed);

		expect(sessions[0]?.partition).toBe('steam-76561198000000001');
		expect(sessions[0]?.proxy).toEqual({
			mode: 'fixed_servers',
			proxyRules: 'socks5://10.0.0.1:1080'
		});
	});

	it('keeps the session in memory, so cookies never reach disk', async () => {
		const { electron, sessions } = fakeElectron();
		await new SteamTransportFactory(electron).forAccount(routed);

		// A `persist:` prefix would put Steam session cookies — which are
		// credentials — into a file that outlives the process.
		expect(sessions[0]?.partition.startsWith('persist:')).toBe(false);
	});

	it('gives each account its own session', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		await factory.forAccount(unrouted);

		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.partition).not.toBe(sessions[1]?.partition);
	});

	it('reuses one session per account rather than leaking them', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		await factory.forAccount(routed);

		expect(sessions).toHaveLength(1);
	});

	it('states "system" for an unrouted account rather than leaving it implicit', async () => {
		const { electron, sessions } = fakeElectron();
		await new SteamTransportFactory(electron).forAccount(unrouted);

		expect(sessions[0]?.proxy).toEqual({ mode: 'system' });
	});

	it('REFUSES rather than falling back when the proxy cannot be applied', async () => {
		// The single most important behaviour in this file. A transport that
		// quietly went direct would send the account's traffic from the user's own
		// address — the exact thing they configured a proxy to prevent — and they
		// would have no way to notice.
		const { electron } = fakeElectron();
		const failing: ElectronNetworking = {
			...electron,
			sessionFromPartition: (partition) => ({
				...electron.sessionFromPartition(partition),
				setProxy: () => Promise.reject(new Error('proxy rejected'))
			})
		};

		await expect(new SteamTransportFactory(failing).forAccount(routed)).rejects.toThrow(
			/could not route/
		);
	});

	it('refuses an unusable proxy before any request is made', async () => {
		const { electron, requests } = fakeElectron();

		await expect(
			new SteamTransportFactory(electron).forAccount({
				steamId64: '76561198000000001',
				proxyUrl: 'ftp://nope:21'
			})
		).rejects.toThrow(EgressError);
		expect(requests).toHaveLength(0);
	});

	it('sends the cookie and the body, and hides the application', async () => {
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		await transport({
			method: 'POST',
			url: 'https://steamcommunity.com/mobileconf/multiajaxop',
			body: new URLSearchParams({ op: 'allow' }),
			cookie: 'steamLoginSecure=abc'
		});

		// The session cookie rides alongside the mobile-client identity, not instead
		// of it: Steam's own transport keys off `mobileClientVersion=` to decide a
		// request came from the app, so sending one without the other is half a
		// disguise.
		expect(requests[0]?.headers.Cookie).toContain('steamLoginSecure=abc');
		expect(requests[0]?.headers.Cookie).toContain('mobileClientVersion=');
		expect(requests[0]?.headers['User-Agent']).toBe(STEAM_USER_AGENT);
		expect(requests[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		expect(requests[0]?.body).toBe('op=allow');
	});

	it('returns the status and body to the caller', async () => {
		const { electron } = fakeElectron({ status: 403, body: 'denied' });
		const transport = await new SteamTransportFactory(electron).forAccount(unrouted);

		// Classifying the status is the client's job; the transport reports facts.
		await expect(
			transport({ method: 'GET', url: 'https://steamcommunity.com/', cookie: 'c' })
		).resolves.toEqual({ status: 403, text: 'denied' });
	});

	it('surfaces a connection failure instead of an empty answer', async () => {
		const { electron } = fakeElectron({ error: new Error('net::ERR_PROXY_CONNECTION_FAILED') });
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		await expect(
			transport({ method: 'GET', url: 'https://steamcommunity.com/', cookie: 'c' })
		).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED/);
	});

	it('re-applies routing after an account is forgotten', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		factory.forget(routed.steamId64);
		await factory.forAccount(routed);

		// Electron hands back the same session object, so "fresh" cannot mean a new
		// one. It means emptied and reconfigured.
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.cleared).toBe(1);
		expect(sessions[0]?.proxy).toEqual({
			mode: 'fixed_servers',
			proxyRules: 'socks5://10.0.0.1:1080'
		});
	});
});

describe('forgetting a session actually empties it', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };
	const other = { steamId64: '76561198000000002' };

	it('clears the cookie jar, not just our reference to it', async () => {
		// `fromPartition` hands back the SAME session for the same name, so dropping
		// a reference leaves every cookie Steam set exactly where it was. A Steam
		// session cookie is a live credential; forgetting has to mean emptying.
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		await factory.forAccount(routed);

		factory.forget(routed.steamId64);

		expect(sessions[0]?.cleared).toBe(1);
	});

	it('empties every account when the vault locks', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		await factory.forAccount(routed);
		await factory.forAccount(other);

		factory.forgetAll();

		expect(sessions.map((entry) => entry.cleared)).toEqual([1, 1]);
	});

	it('is safe to call when nothing is open', () => {
		const { electron } = fakeElectron();
		expect(() => new SteamTransportFactory(electron).forgetAll()).not.toThrow();
	});

	it('answers a later proxy with its own credentials, never the previous one', async () => {
		// The bug guarded against is not a memory leak but a credential one: the
		// operator of proxy B being told proxy A's password. It used to be prevented
		// by clearing stacked session handlers; now it cannot arise, because the
		// credentials come from the plan the request was built with.
		const { electron, requests } = fakeElectron({ requireProxyAuth: true });
		const factory = new SteamTransportFactory(electron);

		const first = await factory.forAccount({
			...routed,
			proxyUrl: 'socks5://a:secret-a@10.0.0.1:1080'
		});
		await first({ url: STEAM_URL, method: 'GET', cookie: '' });

		factory.forget(routed.steamId64);

		const second = await factory.forAccount({
			...routed,
			proxyUrl: 'socks5://b:secret-b@10.0.0.2:1080'
		});
		await second({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests[0]?.proxyAuth).toEqual({ username: 'a', password: 'secret-a' });
		expect(requests[1]?.proxyAuth).toEqual({ username: 'b', password: 'secret-b' });
	});

	it('offers no credentials at all once routing is removed', async () => {
		const { electron, sessions, requests } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount({ ...routed, proxyUrl: 'socks5://a:secret-a@10.0.0.1:1080' });
		factory.forget(routed.steamId64);
		const plain = await factory.forAccount({ steamId64: routed.steamId64 });
		await plain({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests[0]?.proxyAuth).toBeUndefined();
		expect(sessions[0]?.proxy).toEqual({ mode: 'system' });
	});
});

/**
 * Regression: proxy credentials were registered on the **session**.
 *
 * Electron's `Session` has no `login` event — only `App`, `ClientRequest`,
 * `UtilityProcess` and `WebContents` emit one. The listener was therefore never
 * called, no credentials ever reached the proxy, and every authenticating proxy
 * failed its CONNECT with a 407 that surfaced as `ERR_TUNNEL_CONNECTION_FAILED`
 * — indistinguishable, from the outside, from a wrong password. It survived a
 * green suite because the fake session implemented the event that the real one
 * does not have.
 */
describe('proxy authentication', () => {
	const routed = { steamId64: '76561198000000001' };

	it('answers the proxy challenge on the request', async () => {
		const { electron, requests } = fakeElectron({ requireProxyAuth: true });
		const transport = await new SteamTransportFactory(electron).forAccount({
			...routed,
			// RFC 5737 documentation range. Never a real endpoint: this file is
			// public, and a proxy address is infrastructure belonging to somebody.
			proxyUrl: 'http://user:pa55@203.0.113.7:30013'
		});

		const response = await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(response.status).toBe(200);
		expect(requests[0]?.proxyAuth).toEqual({ username: 'user', password: 'pa55' });
	});

	it('decodes percent-encoded credentials before answering', async () => {
		const { electron, requests } = fakeElectron({ requireProxyAuth: true });
		const transport = await new SteamTransportFactory(electron).forAccount({
			...routed,
			proxyUrl: 'http://user%40host:p%40ss%3Aword@10.0.0.1:8080'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests[0]?.proxyAuth).toEqual({ username: 'user@host', password: 'p@ss:word' });
	});

	it('refuses to answer a challenge that is not the proxy', async () => {
		// A non-proxy `login` is the destination asking for HTTP authentication.
		// Steam does not, so this is somebody else — and answering would hand them
		// the user's proxy password.
		const { electron, requests } = fakeElectron({ challengeAsOrigin: true });
		const transport = await new SteamTransportFactory(electron).forAccount({
			...routed,
			proxyUrl: 'http://user:pa55@10.0.0.1:8080'
		});

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow();
		expect(requests[0]?.proxyAuth).toEqual({ username: undefined, password: undefined });
	});

	it('sends nothing for an account with no proxy', async () => {
		const { electron, requests } = fakeElectron({ requireProxyAuth: true });
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		// No credentials to offer, so the challenge goes unanswered and the request
		// fails — which is correct. The point is that it fails empty-handed rather
		// than offering some other account's credentials.
		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow();
		expect(requests[0]?.proxyAuth).toBeUndefined();
	});

	it('offers nothing when the proxy URL carries no credentials', async () => {
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount({
			...routed,
			proxyUrl: 'socks5://10.0.0.1:1080'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests[0]?.proxyAuth).toBeUndefined();
	});
});

describe('the cookie header', () => {
	it('still carries the mobile-client identity when there is no session yet', async () => {
		// Minting an access token happens before any session exists. There is no
		// session cookie to send — but the client identity is not a session, and a
		// request that drops it mid-flow announces that this client is not what the
		// other requests claimed it was.
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000001'
		});

		await transport({
			method: 'POST',
			url: 'https://api.steampowered.com/IAuthenticationService/GenerateAccessTokenForApp/v1/',
			body: new URLSearchParams({ refresh_token: 'x' }),
			cookie: ''
		});

		expect(requests[0]?.headers.Cookie).toBe(
			'mobileClient=android; mobileClientVersion=777777 3.10.3'
		);
		// And nothing that looks like an empty session.
		expect(requests[0]?.headers.Cookie).not.toContain('steamLoginSecure');
	});

	it('presents as the Steam mobile app, not as a browser', () => {
		// `okhttp/4.9.2` is what the real Android app sends, and what steam-session
		// hardcodes for MobileApp logins. Matching it exactly is the strategy: the
		// crowd to hide in is the millions of ordinary mobile users, not a unique
		// string per account that makes each one individually rare.
		expect(STEAM_USER_AGENT).toBe('okhttp/4.9.2');
		expect(STEAM_USER_AGENT).not.toMatch(/mozilla|chrome|safari/i);
	});

	it('strips the browser-only headers Chromium adds', async () => {
		// Setting a User-Agent does not stop Electron adding client hints and fetch
		// metadata beside it. Those next to an okhttp User-Agent are a contradiction
		// no genuine client produces — which is more identifying than either alone.
		const { electron, headerFilter } = fakeElectron();
		await new SteamTransportFactory(electron).forAccount({ steamId64: '76561198000000001' });

		const filtered = headerFilter()({
			'User-Agent': 'okhttp/4.9.2',
			'sec-ch-ua': '"Chromium";v="120"',
			'sec-fetch-site': 'none',
			'Accept-Language': 'en-GB,en;q=0.9',
			Cookie: 'mobileClient=android'
		});

		expect(filtered).toEqual({ 'User-Agent': 'okhttp/4.9.2', Cookie: 'mobileClient=android' });
	});
});

describe('a Steam session goes only to Steam', () => {
	it('accepts the hosts this app actually talks to', () => {
		for (const url of [
			'https://steamcommunity.com/mobileconf/getlist',
			'https://api.steampowered.com/IAuthenticationService/GenerateAccessTokenForApp/v1/'
		]) {
			expect(isSteamEndpoint(url), url).toBe(true);
		}
	});

	it('refuses anywhere else, and anything unencrypted', () => {
		for (const url of [
			'https://steamcommunity.com.evil.test/mobileconf/getlist',
			'https://evil.test/mobileconf/getlist',
			'http://steamcommunity.com/mobileconf/getlist',
			'file:///etc/passwd',
			'not a url'
		]) {
			expect(isSteamEndpoint(url), url).toBe(false);
		}
	});

	it('refuses to send the request at all, rather than sending it without the cookie', async () => {
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000001'
		});

		await expect(
			transport({ method: 'GET', url: 'https://evil.test/', cookie: 'steamLoginSecure=abc' })
		).rejects.toThrow(/anywhere but Steam/);
		expect(requests).toHaveLength(0);
	});
});

describe('proxy credentials that were never percent-encoded', () => {
	it('does not throw on a stray percent sign', () => {
		// `decodeURIComponent` raises URIError on `100%sure`, which is a perfectly
		// valid password. The sensible reading of an undecodable value is that it
		// was never encoded.
		for (const password of ['100%sure', 'bad%ZZ', '%']) {
			const plan = planProxy(`socks5://user:${password}@10.0.0.1:1080`);
			expect(plan.credentials?.password, password).toBe(password);
		}
	});
});

/**
 * Regression: `net::ERR_TUNNEL_CONNECTION_FAILED` reached the user verbatim.
 *
 * It was the first error the founder hit on live testing, and it is the worst
 * possible one to pass through raw: the account had inherited a dead proxy from
 * an imported maFile, so the string named neither the proxy nor anything the
 * user recognised as a setting they had made.
 */
describe('network error messages', () => {
	const err = (code: string): Error => new Error(`net::${code}`);

	it('names the proxy whenever there is one', () => {
		const message = describeNetworkError(
			err('ERR_TUNNEL_CONNECTION_FAILED'),
			'socks5://***:***@10.0.0.1:1080'
		);

		expect(message).toContain('10.0.0.1:1080');
		expect(message).toContain('routed through');
		// The likely cause, not just the fact of failure.
		expect(message).toMatch(/username or password|expired/i);
	});

	it('keeps the raw code so a pasted error is still searchable', () => {
		expect(describeNetworkError(err('ERR_TUNNEL_CONNECTION_FAILED'))).toContain(
			'ERR_TUNNEL_CONNECTION_FAILED'
		);
	});

	it('does not claim a proxy is involved when none is', () => {
		const message = describeNetworkError(err('ERR_CONNECTION_TIMED_OUT'));

		expect(message).not.toMatch(/routed through|proxy/i);
		expect(message).toContain('timed out');
	});

	it('still says something useful for a code it does not know', () => {
		const message = describeNetworkError(err('ERR_SOMETHING_NEW'), 'http://***:***@1.2.3.4:8080');

		expect(message).toContain('1.2.3.4:8080');
		expect(message).toContain('ERR_SOMETHING_NEW');
	});

	it('falls back to the raw text when there is no code at all', () => {
		expect(describeNetworkError(new Error('socket hang up'))).toContain('socket hang up');
	});

	it('never leaks proxy credentials, since it is given the redacted form', () => {
		// The caller passes `plan.redacted`. This asserts the contract holds end to
		// end rather than that the function scrubs anything itself.
		// Distinctive values: an earlier version of this test asserted the message
		// did not contain "user", which the explanation's own word "username"
		// satisfies by accident.
		const plan = planProxy('socks5://zx9login:hunter2@10.0.0.1:1080');
		const message = describeNetworkError(err('ERR_TUNNEL_CONNECTION_FAILED'), plan.redacted);

		expect(message).not.toContain('hunter2');
		expect(message).not.toContain('zx9login');
		expect(message).toContain('***:***@');
	});
});

/**
 * The routing guarantee (§10.1, F-08).
 *
 * "This account is routed" must mean the traffic went through the proxy, not
 * that a URL is stored against it. Every case here is a way for a configured
 * proxy to silently not apply — and from inside the app, without this check,
 * every one of them is indistinguishable from working.
 */
describe('verifying that a request is actually proxied', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

	it('sends the request when Chromium confirms the intended proxy', async () => {
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests).toHaveLength(1);
	});

	it('refuses when the connection would be made directly', async () => {
		// The failure the feature exists to prevent: every setting reads as
		// configured, and the traffic leaves from the user's own address.
		const { electron, requests } = fakeElectron({ resolvesTo: 'DIRECT' });
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow(
			/directly instead/
		);
		expect(requests).toHaveLength(0);
	});

	it('refuses a proxy list that falls back to DIRECT', async () => {
		// `SOCKS5 x; DIRECT` is routed until the proxy is unreachable and then
		// silently is not — exactly when anonymity matters most.
		const { electron, requests } = fakeElectron({ resolvesTo: 'SOCKS5 10.0.0.1:1080; DIRECT' });
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});

	it('refuses when a different proxy is applied than the one configured', async () => {
		// Routed, but to the wrong operator — a session carrying a previous
		// configuration. Non-direct is not sufficient; it has to be ours.
		const { electron, requests } = fakeElectron({ resolvesTo: 'SOCKS5 203.0.113.9:1080' });
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow(
			/different proxy/
		);
		expect(requests).toHaveLength(0);
	});

	it('refuses when the routing cannot be checked at all', async () => {
		// An unanswerable check is not permission to proceed.
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount(routed);
		const session = electron.sessionFromPartition(`steam-${routed.steamId64}`);
		session.resolveProxy = () => Promise.reject(new Error('resolver unavailable'));

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow(
			/could not be checked/
		);
		expect(requests).toHaveLength(0);
	});

	it('checks before every request, not once per session', async () => {
		// A session is long-lived and its configuration can change underneath.
		// Verifying once would leave every later request unguarded.
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount(routed);

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });
		expect(requests).toHaveLength(1);

		const session = electron.sessionFromPartition(`steam-${routed.steamId64}`);
		session.resolveProxy = () => Promise.resolve('DIRECT');

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow();
		expect(requests).toHaveLength(1);
	});

	it('does not check, or block, an account with no proxy', async () => {
		// Routing is optional. An unrouted account is not a failed routed one.
		const { electron, requests } = fakeElectron({ resolvesTo: 'DIRECT' });
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000002'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests).toHaveLength(1);
	});

	it('never puts proxy credentials in the refusal', async () => {
		const { electron } = fakeElectron({ resolvesTo: 'DIRECT' });
		const transport = await new SteamTransportFactory(electron).forAccount({
			...routed,
			proxyUrl: 'socks5://zx9login:hunter2@10.0.0.1:1080'
		});

		const error = await transport({ url: STEAM_URL, method: 'GET', cookie: '' }).catch(
			(err: unknown) => err
		);

		expect(String(error)).toContain('***:***@');
		expect(String(error)).not.toContain('hunter2');
		expect(String(error)).not.toContain('zx9login');
	});
});

describe('what the account list is told about routing', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

	it('reports nothing until a request has actually been attempted', async () => {
		// The distinction the card depends on: configured is not verified, and an
		// account that has not connected yet must not be shown as proven.
		const { electron } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		await factory.forAccount(routed);

		expect(factory.routingStatus(routed.steamId64)).toBeUndefined();
	});

	it('reports verified, with the redacted proxy, after a successful request', async () => {
		const { electron } = fakeElectron();
		const factory = new SteamTransportFactory(electron, () => 1_700_000_000_000);
		const transport = await factory.forAccount({
			...routed,
			proxyUrl: 'socks5://user:secret@10.0.0.1:1080'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(factory.routingStatus(routed.steamId64)).toEqual({
			state: 'verified',
			via: 'socks5://***:***@10.0.0.1:1080',
			checkedAtMs: 1_700_000_000_000
		});
	});

	it('reports blocked, with a reason, when routing did not apply', async () => {
		const { electron } = fakeElectron({ resolvesTo: 'DIRECT' });
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(routed);

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow();

		expect(factory.routingStatus(routed.steamId64)).toMatchObject({ state: 'blocked' });
	});

	it('reports off for an account that is not routed', async () => {
		const { electron } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		await factory.forAccount({ steamId64: '76561198000000002' });

		expect(factory.routingStatus('76561198000000002')).toEqual({ state: 'off' });
	});
});

describe('reading a resolveProxy answer', () => {
	it('treats every form of direct as direct', () => {
		for (const answer of ['DIRECT', 'direct', ' DIRECT ', 'PROXY 1.2.3.4:8080; DIRECT', '']) {
			expect(describesDirectRoute(answer), answer).toBe(true);
		}
	});

	it('accepts a proxy list with no direct fallback', () => {
		for (const answer of ['SOCKS5 10.0.0.1:1080', 'PROXY 1.2.3.4:8080', 'PROXY a:1; PROXY b:2']) {
			expect(describesDirectRoute(answer), answer).toBe(false);
		}
	});
});

/**
 * Regression: a lock did not stop a request already on the wire.
 *
 * `runAutoConfirm` checked the generation counter between calls, which does
 * nothing to a call in the middle: the approve POST was already sent, so Steam
 * accepted the trade while the application had reported that locking stops
 * automatic confirmation. Aborting narrows that to the physical race nobody can
 * close — a request Steam has already received cannot be recalled.
 */
describe('redacting credentials out of messages', () => {
	it('strips a password from a proxy URL a library quoted back', () => {
		// Libraries quote what they were given. `steam-session` and Chromium both
		// embed the URL they failed on, and enrollment, sign-in and routing all
		// forwarded those messages to the renderer verbatim.
		expect(redactCredentials('connect ECONNREFUSED socks5://user:hunter2@10.0.0.1:1080')).toBe(
			'connect ECONNREFUSED socks5://***:***@10.0.0.1:1080'
		);
	});

	it('leaves a URL without credentials alone', () => {
		expect(redactCredentials('failed on https://steamcommunity.com/mobileconf')).toBe(
			'failed on https://steamcommunity.com/mobileconf'
		);
	});

	it('handles more than one', () => {
		const redacted = redactCredentials('http://a:b@one:1 and socks5://c:d@two:2');
		expect(redacted).not.toContain('b@');
		expect(redacted).not.toContain('d@');
	});

	it('does not mangle an ordinary sentence', () => {
		expect(redactCredentials('Steam did not accept that username and password.')).toBe(
			'Steam did not accept that username and password.'
		);
	});
});

describe('cancelling work when the vault locks', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

	it('aborts a request that is still in flight', async () => {
		const { electron, aborted } = fakeElectron({ neverSettles: true });
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(routed);

		void transport({ url: STEAM_URL, method: 'GET', cookie: '' });
		// The routing check is awaited before the request is built, so the handle
		// does not exist synchronously. Letting the microtask queue drain puts the
		// request genuinely on the wire, which is the state under test.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(aborted()).toBe(0);

		factory.forget(routed.steamId64);

		expect(aborted()).toBe(1);
	});

	it('finishes emptying a cookie jar before handing that session out again', async () => {
		// `fromPartition` returns the same underlying session for the same name, and
		// `clearStorageData` is asynchronous. Rebuilding an account's transport while
		// the wipe was still running gave the new session the old object with a wipe
		// in flight against it, and whichever finished last decided what was left in
		// the jar.
		let releaseClear: (() => void) | undefined;
		const clearFinished = new Promise<void>((resolve) => {
			releaseClear = resolve;
		});
		let cleared = false;

		const { electron } = fakeElectron();
		const original = electron.sessionFromPartition.bind(electron);
		const slowClearing: ElectronNetworking = {
			...electron,
			sessionFromPartition: (partition, options) => {
				const session = original(partition, options);
				session.clearStorageData = async (): Promise<void> => {
					await clearFinished;
					cleared = true;
				};
				return session;
			}
		};

		const factory = new SteamTransportFactory(slowClearing);
		await factory.forAccount(routed);
		factory.forget(routed.steamId64);

		let rebuilt = false;
		const rebuilding = factory.forAccount(routed).then(() => {
			rebuilt = true;
		});

		// The wipe has not finished, so the rebuild must not have either.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cleared).toBe(false);
		expect(rebuilt).toBe(false);

		releaseClear?.();
		await rebuilding;

		expect(cleared).toBe(true);
	});

	it('forgets what it knew about the route, so a lock leaves nothing verified', async () => {
		// `routingStatus` documents exactly this: "absent means no request has been
		// attempted since the last lock, so nothing is known — which the UI must
		// show as unverified rather than as fine". The map was never cleared, so an
		// account card went on reporting `verified` after a lock, on the strength of
		// a check made in a session that no longer exists. For a control whose only
		// job is to say whether traffic really left through the proxy, a stale yes is
		// the one answer it must never give.
		const { electron } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(routed);
		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(factory.routingStatus(routed.steamId64)?.state).toBe('verified');

		factory.forgetAll();

		expect(factory.routingStatus(routed.steamId64)).toBeUndefined();
	});

	it('aborts a request it has given up waiting for', async () => {
		// Timing out used to reject and walk away, leaving the request running: the
		// socket stayed open and Steam could still act on it. Worse, the reject path
		// also drops the handle from the in-flight set, so the abort a lock performs
		// could no longer reach it — a timed-out request was the one kind this
		// transport could not cancel, which is precisely backwards.
		vi.useFakeTimers();
		try {
			const { electron, aborted } = fakeElectron({ neverSettles: true });
			const factory = new SteamTransportFactory(electron);
			const transport = await factory.forAccount(routed);

			const inFlight = transport({ url: STEAM_URL, method: 'GET', cookie: '' });
			const settled = inFlight.then(
				() => 'resolved',
				(err: Error) => err.message
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(aborted()).toBe(0);

			await vi.advanceTimersByTimeAsync(31_000);

			await expect(settled).resolves.toMatch(/did not answer in time/);
			expect(aborted()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('aborts every account on forgetAll, which is what a lock calls', async () => {
		const { electron, aborted } = fakeElectron({ neverSettles: true });
		const factory = new SteamTransportFactory(electron);

		const a = await factory.forAccount(routed);
		const b = await factory.forAccount({ steamId64: '76561198000000002' });
		void a({ url: STEAM_URL, method: 'GET', cookie: '' });
		void b({ url: STEAM_URL, method: 'GET', cookie: '' });
		await new Promise((resolve) => setTimeout(resolve, 0));

		factory.forgetAll();

		expect(aborted()).toBe(2);
	});

	it('does not abort a request that already finished', async () => {
		const { electron, aborted } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(routed);

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });
		factory.forget(routed.steamId64);

		// Settled requests are dropped from tracking, so a lock has nothing to
		// cancel and cannot spend time on dead handles.
		expect(aborted()).toBe(0);
	});
});

describe('redirects', () => {
	it('refuses to follow one, so a session cookie cannot leave Steam', async () => {
		// `isSteamEndpoint` only ever sees the first URL. Electron follows redirects
		// by default, so a 302 would carry `steamLoginSecure` to whatever host the
		// Location header named, and nothing would check it.
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000001'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: 'steamLoginSecure=live' });

		expect(requests[0]?.redirect).toBe('error');
	});
});

describe('a request committed but not yet sent', () => {
	it('is refused if the account is forgotten during the routing check', async () => {
		// The window `abort` cannot reach: `perform` awaits `resolveProxy` before it
		// builds a handle, so a lock landing inside that await finds nothing to
		// cancel — and the request would then be sent afterwards, over a session the
		// lock was supposed to end.
		const { electron, requests } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount({
			steamId64: '76561198000000001',
			proxyUrl: 'socks5://10.0.0.1:1080'
		});

		const pending = transport({ url: STEAM_URL, method: 'GET', cookie: '' });
		factory.forget('76561198000000001');

		await expect(pending).rejects.toThrow(/closed before the request was sent/);
		expect(requests).toHaveLength(0);
	});
});
