import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	describeNetworkError,
	describesDirectRoute,
	redactCredentials,
	routedEndpoint,
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
		const plan = planProxy('http://alice:s3cret@10.0.0.1:8080');

		expect(plan.proxyRules).toBe('http://10.0.0.1:8080');
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

	it('keeps the port, and fills in the one Chromium would have guessed', () => {
		expect(planProxy('http://proxy.example:8080').proxyRules).toBe('http://proxy.example:8080');

		// Not left off. Chromium fills its own default in and then reports that
		// filled-in port back through `resolveProxy`, which `assertRouted` compares
		// against `endpoint` — so a portless endpoint could never match, and every
		// request on a perfectly good portless proxy was refused.
		expect(planProxy('http://proxy.example').proxyRules).toBe('http://proxy.example:80');
		expect(planProxy('https://proxy.example').proxyRules).toBe('https://proxy.example:443');
		expect(planProxy('socks5://proxy.example').proxyRules).toBe('socks5://proxy.example:1080');
		expect(planProxy('socks4://proxy.example').proxyRules).toBe('socks4://proxy.example:1080');
		expect(planProxy('socks5h://proxy.example').proxyRules).toBe('socks5://proxy.example:1080');
	});

	it('gives a portless proxy an endpoint that matches what Chromium reports', () => {
		// The right-hand strings are measured, not guessed: `setProxy` with each
		// rule, then `resolveProxy('https://api.steampowered.com/x')` on Electron 43.
		// This is the pairing `assertRouted` depends on, and it is the pairing that
		// broke when the endpoint comparison stopped being a substring test.
		const measured: ReadonlyArray<readonly [string, string]> = [
			['socks5://proxy.example', 'SOCKS5 proxy.example:1080'],
			['socks4://proxy.example', 'SOCKS proxy.example:1080'],
			['http://proxy.example', 'PROXY proxy.example:80'],
			['https://proxy.example', 'HTTPS proxy.example:443'],
			['socks5://[::1]:1080', 'SOCKS5 [::1]:1080']
		];
		for (const [url, resolved] of measured) {
			expect(routedEndpoint(resolved)).toBe(planProxy(url).endpoint);
		}
	});

	it('decodes percent-encoded credentials', () => {
		// Stored URLs encode them. Authenticating with the literal `%40` rather than
		// the `@` the proxy expects is a failure with no useful error.
		const plan = planProxy('http://user%40host:p%40ss%3Aword@10.0.0.1:1080');

		expect(plan.credentials).toEqual({ username: 'user@host', password: 'p@ss:word' });
	});

	it('redacts credentials for display rather than shortening them', () => {
		const plan = planProxy('http://alice:s3cret@10.0.0.1:8080');

		expect(plan.redacted).toBe('http://***:***@10.0.0.1:8080');
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
		/** Delivers the body in these exact pieces instead of one string chunk. */
		bodyChunks?: Buffer[];
	} = {}
): {
	electron: ElectronNetworking;
	sessions: {
		partition: string;
		proxy: unknown;
		/** How many times `setProxy` landed, so churn is visible. */
		proxyCalls: number;
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
	/**
	 * The live knobs object, not the spread below.
	 *
	 * `...state` copies the values as they are at return time, so a test that
	 * sets `failSetProxy` afterwards was setting it on nothing.
	 */
	state: { failSetProxy?: Error };
	failSetProxy?: Error;
} {
	const sessions: {
		partition: string;
		proxy: unknown;
		proxyCalls: number;
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
				/** How many times `setProxy` landed, so churn is visible. */
				proxyCalls: number;
				userAgent?: string;
				cleared?: number;
			} = {
				partition,
				proxy: undefined,
				proxyCalls: 0,
				cleared: 0
			};
			sessions.push(record);
			const session: ProxyCapableSession = {
				setProxy(config) {
					if (state.failSetProxy) {
						return Promise.reject(state.failSetProxy);
					}
					record.proxy = config;
					record.proxyCalls += 1;
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
							const pieces: (string | Buffer)[] = reply.bodyChunks ?? [
								reply.body ?? '{"success":true}'
							];
							for (const piece of pieces) {
								responseListeners.data?.forEach((fn) =>
									(fn as (c: string | Buffer) => void)(piece)
								);
							}
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
		/*
		 * The live object, not the spread below. `...state` copies the values as
		 * they are at return time, so a test that sets `failSetProxy` afterwards
		 * was setting it on nothing.
		 */
		state,
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
			proxyUrl: 'http://a:secret-a@10.0.0.1:8080'
		});
		await first({ url: STEAM_URL, method: 'GET', cookie: '' });

		factory.forget(routed.steamId64);

		const second = await factory.forAccount({
			...routed,
			proxyUrl: 'http://b:secret-b@10.0.0.2:8080'
		});
		await second({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests[0]?.proxyAuth).toEqual({ username: 'a', password: 'secret-a' });
		expect(requests[1]?.proxyAuth).toEqual({ username: 'b', password: 'secret-b' });
	});

	it('offers no credentials at all once routing is removed', async () => {
		const { electron, sessions, requests } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount({ ...routed, proxyUrl: 'http://a:secret-a@10.0.0.1:8080' });
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
			const plan = planProxy(`http://user:${password}@10.0.0.1:8080`);
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
			'http://***:***@10.0.0.1:8080'
		);

		expect(message).toContain('10.0.0.1:8080');
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
		const plan = planProxy('http://zx9login:hunter2@10.0.0.1:1080');
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
			proxyUrl: 'http://zx9login:hunter2@10.0.0.1:1080'
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
			proxyUrl: 'http://user:secret@10.0.0.1:8080'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(factory.routingStatus(routed.steamId64)).toEqual({
			state: 'verified',
			via: 'http://***:***@10.0.0.1:8080',
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

	it('refuses a transport granted before the lock, even after construction finished', async () => {
		// The epoch used to be read when each request *started*, which cannot detect
		// a lock that already happened: `forgetAll` bumps it to 1, and the next
		// request then reads 1 as its own baseline and compares it against itself.
		// The question is not "did anything change while I was sending" but "is the
		// permission I was granted still valid".
		const { electron, requests } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(routed);

		factory.forgetAll();

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow(
			/closed before the request was sent/
		);
		expect(requests).toHaveLength(0);
	});

	it('refuses a transport whose session was still being built when the lock came', async () => {
		// `forgetAll` can only reach accounts present in `sessions` or `inFlight`,
		// and an account is added to `sessions` only after `setProxy` has been
		// awaited — so for the whole of that await a lock bumped nothing at all.
		//
		// For enrollment that meant `AddAuthenticator`, the one irreversible request
		// in the application, could be sent after the vault locked, leaving Steam
		// holding an authenticator whose secrets the vault could no longer store.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const { electron, requests } = fakeElectron();
		const gatedElectron: ElectronNetworking = {
			...electron,
			sessionFromPartition: (partition, options) => {
				const session = electron.sessionFromPartition(partition, options);
				return { ...session, setProxy: async (): Promise<void> => gate };
			}
		};

		const factory = new SteamTransportFactory(gatedElectron);
		const building = factory.forAccount(routed);
		await Promise.resolve();

		// The vault locks while construction is parked inside setProxy.
		factory.forgetAll();
		release?.();

		// Refused at construction, so no transport is ever handed out.
		await expect(building).rejects.toThrow(/closed before the request was sent/);
		expect(requests).toHaveLength(0);

		// And the session it built is not left behind. It was cached *after* the
		// teardown had already looked for it, so nothing wiped it and nothing would
		// — a session the lock never saw is the state this class promises not to
		// keep, cookies or no cookies.
		expect(factory.routingStatus(routed.steamId64)).toBeUndefined();
	});

	it('aborts the connection when a response is implausibly large', async () => {
		// The size limit bounds how much is *retained*, not how much is sent. The
		// timeout path aborts; this one only rejected, so a peer that kept streaming
		// kept the socket alive — with the timer cleared and the handle already
		// removed from `outstanding`, leaving nothing able to cancel it.
		const oversized = 'x'.repeat(4 * 1024 * 1024 + 1);
		const { electron, aborted } = fakeElectron({ body: oversized });
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(routed);

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow(
			/implausibly large/
		);
		expect(aborted()).toBe(1);
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

/*
 * Redaction has to cover every credential shape the router will actually accept.
 *
 * `planProxy` attaches credentials when *either* the username or the password is
 * present, while the redaction pattern required both to be non-empty. The two
 * disagreed, and the gap is not theoretical: these strings reach the renderer as
 * failure messages and are written into the activity log, so a proxy URL that
 * survived redaction put the credential somewhere the user can read it — and
 * somewhere a screenshot of a bug report carries it.
 */
describe('redacting one-sided proxy credentials', () => {
	it('redacts a username with no password', () => {
		expect(redactCredentials('failed on http://alice@proxy.test:8080')).toBe(
			'failed on http://***:***@proxy.test:8080'
		);
	});

	it('redacts a password with no username', () => {
		expect(redactCredentials('failed on http://:hunter2@proxy.test:8080')).toBe(
			'failed on http://***:***@proxy.test:8080'
		);
	});

	it('still redacts the ordinary pair', () => {
		expect(redactCredentials('socks5://bob:pw@proxy.test:1080')).toBe(
			'socks5://***:***@proxy.test:1080'
		);
	});

	it('leaves an @ in a path alone', () => {
		// `[^\s/@]*` cannot cross a slash, so a profile URL is not mistaken for
		// userinfo. Over-redacting here would corrupt error messages that quote a
		// perfectly ordinary Steam URL.
		const url = 'https://steamcommunity.com/id/someone@example';
		expect(redactCredentials(url)).toBe(url);
	});

	it('redacts every credential a message carries, not just the first', () => {
		expect(redactCredentials('http://a@one.test and socks5://:b@two.test')).toBe(
			'http://***:***@one.test and socks5://***:***@two.test'
		);
	});
});

/*
 * Redaction must not damage a URL that carries no credentials.
 *
 * Widening the pattern to catch one-sided credentials made it worse than the one
 * it replaced: bounded only by `/`, the match ran straight through a query
 * string, so `https://example.com?email=alice@example.net` came out as
 * `https://***:***@example.net` — the real host gone, credentials invented, in a
 * message whose entire job is to tell somebody what failed.
 */
describe('redaction leaves credential-free URLs alone', () => {
	it('does not treat a query string as userinfo', () => {
		const url = 'https://example.com?email=alice@example.net';
		expect(redactCredentials(url)).toBe(url);
	});

	it('does not treat a fragment as userinfo', () => {
		const url = 'https://example.com#contact@example.net';
		expect(redactCredentials(url)).toBe(url);
	});

	it('keeps the host intact in a realistic failure message', () => {
		const message = 'GET https://api.steampowered.com/x?notify=ops@example.net failed';
		expect(redactCredentials(message)).toContain('api.steampowered.com');
		expect(redactCredentials(message)).not.toContain('***');
	});
});

/*
 * A password containing a literal `@`.
 *
 * The URL parser takes the **last** `@` in an authority as the delimiter, so
 * `http://alice:secret@part@proxy:8080` has the password `secret@part` — and
 * `planProxy` accepts it. A pattern that stopped at the first `@` therefore left
 * `part` of that password sitting in the message it was supposed to be scrubbing.
 */
describe('redaction agrees with the parser about where credentials end', () => {
	it('redacts a password containing an @', () => {
		const url = 'http://alice:secret@part@proxy.example:8080';
		// What the parser sees, so the test is anchored to the real ambiguity.
		expect(decodeURIComponent(new URL(url).password)).toBe('secret@part');
		expect(redactCredentials(url)).toBe('http://***:***@proxy.example:8080');
	});

	it('leaves nothing of the password behind', () => {
		expect(redactCredentials('http://alice:secret@part@proxy.example:8080')).not.toContain('part@');
		expect(redactCredentials('http://a:b@c@host.test')).not.toContain('b@c');
	});

	it('still stops at the end of the authority', () => {
		// The greedier class must not start eating query strings again.
		const url = 'https://example.com?to=alice@example.net';
		expect(redactCredentials(url)).toBe(url);
	});
});

/*
 * What Chromium said it would do, parsed rather than searched for.
 *
 * The routing check was `resolved.includes(plan.endpoint)`. `resolveProxy`
 * answers with a PAC-style list, and a substring test over it is wrong three
 * ways at once — all three of these contain the intended endpoint verbatim, none
 * contains `DIRECT`, and all three were recorded as `verified`:
 *
 *   SOCKS5 110.0.0.1:10800                        a different host and port
 *   SOCKS5 10.0.0.1:10800                         the same host, another port
 *   PROXY 203.0.113.9:8080; SOCKS5 10.0.0.1:1080  a stranger's proxy, used first
 *
 * On the one feature whose entire purpose is to fail closed rather than leak the
 * address the proxy exists to hide.
 */
describe('reading the endpoint Chromium will actually use', () => {
	const INTENDED = '10.0.0.1:1080';

	it('accepts the endpoint that was asked for', () => {
		expect(routedEndpoint(`SOCKS5 ${INTENDED}`)).toBe(INTENDED);
	});

	it('refuses a host that merely contains it', () => {
		expect(routedEndpoint('SOCKS5 110.0.0.1:10800')).not.toBe(INTENDED);
	});

	it('refuses the same host on another port', () => {
		expect(routedEndpoint('SOCKS5 10.0.0.1:10800')).not.toBe(INTENDED);
	});

	it('reads only the first entry, which is the one that gets used', () => {
		// The rest are fallbacks. A list whose head is somebody else's proxy sends
		// this request through somebody else's proxy.
		expect(routedEndpoint(`PROXY 203.0.113.9:8080; SOCKS5 ${INTENDED}`)).toBe('203.0.113.9:8080');
	});

	it('reports no endpoint for a direct route', () => {
		expect(routedEndpoint('DIRECT')).toBeUndefined();
	});

	it('reports no endpoint for something it cannot read', () => {
		// Undefined makes the caller refuse rather than guess, which is the right
		// direction for a check that exists to fail closed.
		expect(routedEndpoint('')).toBeUndefined();
		expect(routedEndpoint('SOCKS5')).toBeUndefined();
	});

	it('is not fooled by leading whitespace', () => {
		expect(routedEndpoint(`  SOCKS5 ${INTENDED}`)).toBe(INTENDED);
	});
});

/*
 * A UTF-8 character split across two network chunks.
 *
 * Chromium delivers the body in whatever pieces the network produced, and a TCP
 * boundary lands inside a multi-byte character whenever it feels like it.
 * Decoding chunk by chunk turned both halves of a split character into U+FFFD —
 * and Steam's confirmation payloads are full of multi-byte characters, because
 * item names are (★, ™, every accented letter). The item name is the text a
 * user reads before approving a trade; it must arrive intact.
 */
describe('multi-byte characters across chunk boundaries', () => {
	it('reassembles a character the network split in two', async () => {
		const star = Buffer.from('★ StatTrak™ Karambit', 'utf8');
		const { electron } = fakeElectron({
			// Split inside the middle of ★ (three bytes: e2 98 85).
			bodyChunks: [star.subarray(0, 1), star.subarray(1)]
		});
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000002'
		});

		const response = await transport({
			method: 'GET',
			url: 'https://steamcommunity.com/mobileconf/getlist',
			cookie: ''
		});

		expect(response.text).toBe('★ StatTrak™ Karambit');
		expect(response.text).not.toContain('�');
	});

	it('keeps binary responses byte-faithful chunk by chunk', async () => {
		const bytes = Buffer.from([0x08, 0x96, 0x01, 0xff, 0xe2]);
		const { electron } = fakeElectron({
			bodyChunks: [bytes.subarray(0, 2), bytes.subarray(2)]
		});
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000002'
		});

		const response = await transport({
			method: 'GET',
			url: 'https://steamcommunity.com/mobileconf/getlist',
			cookie: '',
			binary: true
		});

		expect(Buffer.from(response.text, 'latin1')).toEqual(bytes);
	});
});

/*
 * The last-moment hook must run inside the transport, after routing.
 *
 * A consent check made by the caller happens before `assertRouted` awaits, and
 * that await is real: a user turning automatic confirmation off during it still
 * had their trade approved. `beforeSend` exists to close that window, so what
 * matters is *where* the transport invokes it.
 */
describe('the beforeSend hook', () => {
	it('runs after routing is verified and before anything is sent', async () => {
		const order: string[] = [];
		const { electron, requests } = fakeElectron();
		const factory = new SteamTransportFactory({
			...electron,
			request: (options) => {
				order.push('request-built');
				return electron.request(options);
			}
		});
		const transport = await factory.forAccount({
			steamId64: '76561198000000001',
			proxyUrl: 'socks5://10.0.0.1:1080'
		});

		await transport({
			method: 'POST',
			url: 'https://steamcommunity.com/mobileconf/multiajaxop',
			cookie: '',
			beforeSend: () => order.push('beforeSend')
		});

		expect(order).toEqual(['beforeSend', 'request-built']);
		expect(requests).toHaveLength(1);
	});

	it('a throwing hook stops the request going out at all', async () => {
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000001',
			proxyUrl: 'socks5://10.0.0.1:1080'
		});

		await expect(
			transport({
				method: 'POST',
				url: 'https://steamcommunity.com/mobileconf/multiajaxop',
				cookie: '',
				beforeSend: () => {
					throw new Error('consent was withdrawn');
				}
			})
		).rejects.toThrow(/consent was withdrawn/);
		expect(requests).toHaveLength(0);
	});
});

/*
 * One stored URL has to mean one route.
 *
 * Two schemes could not honour that. A SOCKS proxy carrying credentials worked
 * for `steam-session` — which hands the URL to socks-proxy-agent — and could
 * never work for Chromium, whose SOCKS5 client implements no authentication
 * methods and whose `login` event is an HTTP 407 mechanism a SOCKS handshake
 * never produces. So sign-in succeeded and every confirmation, enrollment
 * attach and clock sync failed. And `socks4a` is remote-DNS on Node while
 * Chromium has no such rule at all, resolving locally instead — the exact split
 * a previous release closed for `socks5`.
 */
describe('proxies the two network stacks would route differently', () => {
	it('refuses a SOCKS proxy that carries credentials', () => {
		for (const url of [
			'socks5://user:pass@10.0.0.1:1080',
			'socks5h://user:pass@10.0.0.1:1080',
			'socks4://user@10.0.0.1:1080',
			'socks5://:pass@10.0.0.1:1080'
		]) {
			expect(() => planProxy(url)).toThrow(/cannot authenticate/i);
		}
	});

	it('still accepts a SOCKS proxy without them', () => {
		expect(planProxy('socks5://10.0.0.1:1080').proxyRules).toBe('socks5://10.0.0.1:1080');
	});

	it('still accepts credentials on http and https, which carry them on both', () => {
		expect(planProxy('http://user:pass@10.0.0.1:8080').credentials).toEqual({
			username: 'user',
			password: 'pass'
		});
		expect(planProxy('https://user:pass@10.0.0.1:8443').credentials).toBeDefined();
	});

	it('refuses socks4a outright', () => {
		expect(() => planProxy('socks4a://10.0.0.1:1080')).toThrow();
	});

	it('does not offer the broken form as an example anywhere in the UI', () => {
		// The routing screen's placeholder was `socks5://user:password@host:1080` —
		// teaching the one shape that cannot work.
		for (const screen of ['AccountRouting', 'AddAuthenticator', 'MoveAuthenticator']) {
			const source = readFileSync(join(__dirname, `../src/renderer/screens/${screen}.tsx`), 'utf8');
			expect(source).not.toMatch(/placeholder="socks[^"]*@/);
		}
	});
});

/*
 * **The browser's "Direct" option needs a session of its own.**
 *
 * That option is the way past a proxy that is rate-limited, blocked or dead —
 * and the Steam token behind the window was still minted through the proxy
 * being avoided. So a dead proxy failed at the token and no window opened at
 * all, and a working one issued the session cookie to the proxy's address and
 * then spent it from the user's own: two addresses for one sign-in, which is
 * the correlation this whole file exists to prevent.
 *
 * The fix cannot be "ask the account's factory for an unrouted transport".
 * Electron returns the *same* session object for the same partition name, so
 * that would reconfigure the account's own session — and every later
 * confirmation would be refused by `assertRouted`, correctly, for an account
 * whose proxy nobody had touched.
 */
describe('a second transport factory for unrouted work', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

	it('partitions its sessions away from the account transport', async () => {
		const { electron, sessions } = fakeElectron();

		await new SteamTransportFactory(electron).forAccount(routed);
		await new SteamTransportFactory(electron, () => Date.now(), 'steam-direct-').forAccount({
			steamId64: routed.steamId64
		});

		const names = sessions.map((session) => session.partition);
		expect(names).toContain('steam-76561198000000001');
		expect(names).toContain('steam-direct-76561198000000001');
		expect(new Set(names).size, 'the two factories shared one session').toBe(names.length);
	});

	/*
	 * The account's session keeps its proxy. If these shared a partition, the
	 * direct factory's `setProxy` would land on the account's session and unroute
	 * it — the failure this separation exists to make impossible.
	 */
	it('leaves the account session routed', async () => {
		const { electron, sessions } = fakeElectron();

		await new SteamTransportFactory(electron).forAccount(routed);
		await new SteamTransportFactory(electron, () => Date.now(), 'steam-direct-').forAccount({
			steamId64: routed.steamId64
		});

		const account = sessions.find((session) => session.partition === 'steam-76561198000000001');
		expect(JSON.stringify(account?.proxy ?? {}), 'the account session was unrouted').toContain(
			'10.0.0.1:1080'
		);
	});

	it('asks for no proxy on its own', async () => {
		const { electron, sessions } = fakeElectron();

		await new SteamTransportFactory(electron, () => Date.now(), 'steam-direct-').forAccount({
			steamId64: routed.steamId64
		});

		const direct = sessions.find(
			(session) => session.partition === 'steam-direct-76561198000000001'
		);
		expect(JSON.stringify(direct?.proxy ?? {})).not.toContain('10.0.0.1');
	});

	it('still defaults to the account prefix when none is given', async () => {
		const { electron, sessions } = fakeElectron();
		await new SteamTransportFactory(electron).forAccount(routed);
		expect(sessions[0]?.partition).toBe('steam-76561198000000001');
	});
});

/*
 * **A stale construction must not revoke the one that replaced it.**
 *
 * Saving a new proxy while an older `setProxy` is still pending leaves two
 * constructions in the air. The older one finds its grant stale — correctly —
 * and used to clean up by calling the public `forget()`, which bumps the
 * account epoch a second time and clears the cache. By then the cache holds the
 * *newer* transport's session, so a confirmation started right after saving the
 * new proxy failed with "this account was closed before the request was sent",
 * using the new configuration, for no reason visible anywhere.
 *
 * Fail-closed, so no address leaked. It simply did not work.
 */
/** Hold a rejection at the call site; see `browser-window.test.ts` for why. */
const settledValue = (work: Promise<unknown>): Promise<unknown> =>
	work.then(
		(value) => value,
		(err: unknown) => err
	);

describe('two transport constructions overlapping a routing change', () => {
	/*
	 * **A session whose `setProxy` can be held open.**
	 *
	 * The first version of this test used the shared fake, which applies the
	 * configuration synchronously the moment `setProxy` is called — so the newest
	 * call always won no matter what order the promises settled in, and the test
	 * named after that ordering never produced it. A real `setProxy` is a round
	 * trip to the network service, and whichever finishes last is what Chromium
	 * ends up using.
	 */
	function heldProxySession() {
		const applied: string[] = [];
		const pending: (() => void)[] = [];
		let current = 'DIRECT';
		const session = {
			setProxy: (config: { mode: string; proxyRules?: string }) =>
				new Promise<void>((resolve) => {
					pending.push(() => {
						// Applied when it *finishes*, which is the whole point.
						applied.push(config.proxyRules ?? config.mode);
						current =
							config.mode === 'fixed_servers' && config.proxyRules
								? `SOCKS5 ${config.proxyRules.replace(/^[a-z0-9]+:\/\//, '')}`
								: 'DIRECT';
						resolve();
					});
				}),
			setUserAgent: () => undefined,
			resolveProxy: () => Promise.resolve(current),
			webRequest: { onBeforeSendHeaders: () => undefined },
			clearStorageData: () => Promise.resolve(),
			cookies: { set: () => Promise.resolve() }
		};
		return {
			electron: { sessionFromPartition: () => session } as unknown as ElectronNetworking,
			applied,
			/** Let the oldest held application finish. */
			releaseOldest: () => pending.shift()?.(),
			/** Let the newest held application finish. */
			releaseNewest: () => pending.pop()?.(),
			held: () => pending.length
		};
	}

	it('applies the newest configuration last, whatever order they settle in', async () => {
		const { electron, applied, releaseOldest, releaseNewest, held } = heldProxySession();
		const factory = new SteamTransportFactory(electron);
		const before = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };
		const after = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.2:1080' };

		// The old construction is in flight when the routing changes.
		const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

		const stale = settledValue(factory.forAccount(before));
		// A macrotask, not a microtask: `forAccount` waits on any pending wipe and
		// then builds the session before it ever reaches `setProxy`.
		await tick();
		expect(held(), 'the old application never started').toBe(1);

		factory.forget(before.steamId64);
		const replacement = settledValue(factory.forAccount(after));
		await tick();

		/*
		 * The old one is let go **last**, which without ordering left its address
		 * applied to a session the replacement had already been built against.
		 * Chained, the second application cannot start until the first has
		 * finished, so this releases them in the order they were issued and the
		 * newest is still the last word.
		 */
		releaseNewest();
		await tick();
		releaseOldest();
		await tick();
		releaseNewest();
		await tick();

		await stale;
		await replacement;

		expect(applied.at(-1), 'an older application was the last word on the session').toBe(
			'socks5://10.0.0.2:1080'
		);
	});

	/*
	 * A lock is the other reason a grant goes stale, and there the cleanup is
	 * still right: nothing for this account is legitimate any more, and the
	 * session was cached after the sweep had already looked for it.
	 */
	it('still wipes a session cached after a lock swept past it', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const account = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

		const opening = factory.forAccount(account);
		factory.forgetAll();

		await expect(opening).rejects.toThrow(/closed before the request was sent/i);

		const own = sessions.find((s) => s.partition === 'steam-76561198000000001');
		expect(own?.cleared, 'a session the lock never saw was left holding a jar').toBeGreaterThan(0);
	});
});

/**
 * **`Require proxies`, at the boundary every Steam request crosses.**
 *
 * It was enforced in three handlers — opening a browser, an explicitly direct
 * sign-in, the update check. Everything else this application does to Steam
 * went out unguarded on an account with no proxy: fetching confirmations,
 * approving them, the background auto-confirm loop, clock synchronisation,
 * enrolling an authenticator, transferring one. Each of those looked as correct
 * as the three that were guarded, which is why guarding callers one at a time
 * was the wrong shape of fix — the next feature to make a request would have
 * been unguarded too.
 *
 * A transport is the thing that makes requests. One that cannot honour the
 * policy is not built.
 */
describe('the transport under Require proxies', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };
	const unrouted = { steamId64: '76561198000000002' };
	const strict = (electron: ElectronNetworking): SteamTransportFactory =>
		new SteamTransportFactory(
			electron,
			() => Date.now(),
			'steam-',
			() => true
		);

	it('refuses to build one for an account with no proxy', async () => {
		const { electron } = fakeElectron();
		await expect(strict(electron).forAccount(unrouted)).rejects.toThrow(/require proxies/i);
	});

	it('refuses one whose proxy is the empty string', async () => {
		// How a cleared field arrives from the vault, and it is not "no proxy
		// configured" to a `?? undefined` check written the obvious way.
		const { electron } = fakeElectron();
		await expect(
			strict(electron).forAccount({ steamId64: '76561198000000003', proxyUrl: '' })
		).rejects.toThrow(/require proxies/i);
	});

	it('opens no session at all for the refused account', async () => {
		// Refusing after construction would leave a Steam-shaped session cached
		// under that partition, which the next unlock would find and reuse.
		const { electron, sessions } = fakeElectron();
		await expect(strict(electron).forAccount(unrouted)).rejects.toThrow();
		expect(sessions, 'a session was built for an account that may not talk to Steam').toEqual([]);
	});

	it('still builds one for a routed account', async () => {
		const { electron } = fakeElectron();
		await expect(strict(electron).forAccount(routed)).resolves.toBeDefined();
	});

	it('builds one for an unrouted account when the setting is off', async () => {
		const { electron } = fakeElectron();
		await expect(new SteamTransportFactory(electron).forAccount(unrouted)).resolves.toBeDefined();
	});

	/*
	 * Read per construction, not captured once. The setting is saved while the
	 * application is running, and a factory built at launch would otherwise go on
	 * answering with the policy that was in force then.
	 */
	it('reads the setting again for every transport', async () => {
		const { electron } = fakeElectron();
		let on = false;
		const factory = new SteamTransportFactory(
			electron,
			() => Date.now(),
			'steam-',
			() => on
		);

		await expect(factory.forAccount(unrouted)).resolves.toBeDefined();
		on = true;
		factory.forget(unrouted.steamId64);
		await expect(factory.forAccount(unrouted)).rejects.toThrow(/require proxies/i);
	});

	it('says what to do about it', async () => {
		const { electron } = fakeElectron();
		await expect(strict(electron).forAccount(unrouted)).rejects.toThrow(/Settings/);
		await expect(strict(electron).forAccount(unrouted)).rejects.toThrow(
			/Give the account a proxy/i
		);
	});
});

/**
 * **A cached session keeps the proxy it was given, and the cache did not check.**
 *
 * Electron returns the same session object for a partition name forever, so a
 * proxy applied to it outlives our cache of it. `sessionFor` returned a cached
 * session without looking at what that session was configured with — so
 * clearing an account's proxy could reuse one still holding the old rule:
 * traffic went out through a proxy the user had deleted, `setProxy` was never
 * called, and the account card reported routing as off.
 */
describe('a session cached with the wrong proxy', () => {
	const id = '76561198000000001';
	const routed = { steamId64: id, proxyUrl: 'socks5://10.0.0.1:1080' };
	const cleared = { steamId64: id };

	it('applies system mode when the proxy is cleared', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		expect(sessions[0]?.proxy).toMatchObject({ proxyRules: 'socks5://10.0.0.1:1080' });

		await factory.forAccount(cleared);

		expect(sessions[0]?.proxy, 'the session kept a proxy the account no longer has').toMatchObject({
			mode: 'system'
		});
	});

	/*
	 * The case the audit reproduced: a routing change drops our cache but
	 * deliberately keeps the session — so the next proxyless call found it and
	 * returned early, before anything could reconsider the rule on it.
	 */
	it('applies it even when the session survived a forget', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		factory.forget(id);
		await factory.forAccount(cleared);

		expect(sessions[0]?.proxy).toMatchObject({ mode: 'system' });
	});

	it('re-applies when the proxy changes to a different one', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		await factory.forAccount({ steamId64: id, proxyUrl: 'socks5://10.0.0.2:1080' });

		expect(sessions[0]?.proxy).toMatchObject({ proxyRules: 'socks5://10.0.0.2:1080' });
	});

	/**
	 * **A failed application must not be recorded as one.**
	 *
	 * The record is what lets the cache be reused, so writing it before the
	 * `setProxy` lands would mean a rejected application still counted: the
	 * session keeps whatever rule it had, and the next call reuses it as though
	 * the new configuration were in place. An absent record means "unknown",
	 * which fails toward applying it again.
	 */
	it('applies again after an application that failed', async () => {
		const { electron, sessions, state } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		const before = sessions[0]?.proxyCalls ?? 0;

		state.failSetProxy = new Error('Chromium refused');
		await expect(factory.forAccount(cleared)).rejects.toThrow();
		delete state.failSetProxy;

		await factory.forAccount(cleared);
		expect(
			sessions[0]?.proxyCalls ?? 0,
			'a rejected application was remembered as though it had landed'
		).toBeGreaterThan(before);
		expect(sessions[0]?.proxy).toMatchObject({ mode: 'system' });
	});

	/**
	 * **The same failure reads the same way whether the session was cached.**
	 *
	 * Only the fresh-session path translated a rejected `setProxy` into a message
	 * naming the proxy — and, crucially, ran it through `redactCredentials`. The
	 * cached branch threw Chromium's own error straight out, so an account whose
	 * session happened to exist already could surface a proxy password in an
	 * error the user is shown.
	 */
	it('reports a failed re-application the same way, without the password', async () => {
		const { electron, state } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const withPassword = { steamId64: id, proxyUrl: 'http://alice:hunter2@10.0.0.1:8080' };

		// First call builds and caches the session.
		await factory.forAccount(withPassword);

		// Second call has to re-apply, and that is the one that fails.
		state.failSetProxy = new Error('Chromium refused http://alice:hunter2@10.0.0.1:8080');
		const failure = await factory
			.forAccount({ steamId64: id, proxyUrl: 'http://alice:hunter2@10.0.0.2:8080' })
			.catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(EgressError);
		expect((failure as Error).message).toMatch(/could not route this account/);
		expect(
			(failure as Error).message,
			'a proxy password reached a message shown to the user'
		).not.toContain('hunter2');
	});

	/**
	 * **The hard case: the first application is still in flight when the routing
	 * changes.**
	 *
	 * `setProxy(P1)` is held. `forget` drops the cache for a routing change, and
	 * the held call then completes — so the stale construction caches a session
	 * carrying P1 and, because the failure was a routing change rather than a
	 * lock, `forAccount` deliberately keeps that session. The next proxyless call
	 * finds it.
	 *
	 * Before the fix, that call returned the cached session untouched: traffic
	 * went out through a proxy the user had deleted while the account card said
	 * routing was off. The `setProxy` this now issues has to be released
	 * concurrently — awaiting the call first deadlocks on the very work being
	 * asserted, which is how this scenario first looked like a hang.
	 */
	it('applies system mode even when the old proxy landed after a forget', async () => {
		const applied: string[] = [];
		const pending: (() => void)[] = [];
		const session = {
			setProxy: (config: { mode: string; proxyRules?: string }) =>
				new Promise<void>((resolve) => {
					pending.push(() => {
						applied.push(config.proxyRules ?? config.mode);
						resolve();
					});
				}),
			setUserAgent: () => undefined,
			resolveProxy: () => Promise.resolve('DIRECT'),
			webRequest: { onBeforeSendHeaders: () => undefined },
			clearStorageData: () => Promise.resolve()
		};
		const factory = new SteamTransportFactory({
			sessionFromPartition: () => session
		} as unknown as ElectronNetworking);

		/** Release every held `setProxy` until none is outstanding. */
		const drain = async (): Promise<void> => {
			for (let i = 0; i < 20; i += 1) {
				while (pending.length > 0) {
					pending.shift()?.();
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		};

		// The routed construction, held at `setProxy`.
		const stale = factory.forAccount(routed).catch((err: unknown) => err);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pending).toHaveLength(1);

		// The routing changes underneath it, and only then does P1 land.
		factory.forget(id);
		await Promise.all([stale, drain()]);
		expect(applied).toEqual(['socks5://10.0.0.1:1080']);

		// The proxy is cleared. This must not reuse the session as it stands.
		const cleared = factory.forAccount({ steamId64: id }).catch((err: unknown) => err);
		await Promise.all([cleared, drain()]);

		expect(applied.at(-1), 'a session still holding the deleted proxy was handed back').toBe(
			'system'
		);
	});

	/*
	 * And does not churn: an unchanged configuration must not re-apply on every
	 * request, which would put a `setProxy` in front of work that needs none.
	 */
	it('leaves an unchanged configuration alone', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		const applied = sessions[0]?.proxyCalls ?? 0;
		await factory.forAccount(routed);

		expect(sessions[0]?.proxyCalls ?? 0, 'the proxy was re-applied for no reason').toBe(applied);
	});
});
