import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
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
		expect(planProxy('socks5h://proxy.example').proxyRules).toBe('socks5://proxy.example:1080');
	});

	it('gives a portless proxy an endpoint that matches what Chromium reports', () => {
		// The right-hand strings are measured, not guessed: `setProxy` with each
		// rule, then `resolveProxy('https://api.steampowered.com/x')` on Electron 43.
		// This is the pairing `assertRouted` depends on, and it is the pairing that
		// broke when the endpoint comparison stopped being a substring test.
		const measured: ReadonlyArray<readonly [string, string]> = [
			['socks5://proxy.example', 'SOCKS5 proxy.example:1080'],
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
		/**
		 * Holds `resolveProxy` open until `releaseResolveProxy` is called.
		 *
		 * The routing check is the one `await` a vault lock can land inside, so
		 * without this there is no way to test what a late answer does to state the
		 * lock has already torn down.
		 */
		deferResolveProxy?: boolean;
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
	state: { failSetProxy?: Error; failClear?: Error };
	failSetProxy?: Error;
	/**
	 * Make an already-registered request fail **now**.
	 *
	 * `abort()` only counts in this fake, exactly as Electron's does not settle
	 * synchronously — so a request cancelled by a lock stays pending, and the
	 * interesting question is what its cleanup does when it finally notices.
	 */
	failLate: (index: number) => void;
	/** Answer a `resolveProxy` that `deferResolveProxy` is holding open. */
	releaseResolveProxy: (answer: string) => void;
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
	const state: { failSetProxy?: Error; failClear?: Error } = {};
	/** Each request's listener map, in the order the requests were made. */
	const handleListeners: Record<string, ((...args: never[]) => void)[]>[] = [];
	let releaseProxy: ((answer: string) => void) | undefined;

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
					if (state.failClear) {
						return Promise.reject(state.failClear);
					}
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
					if (reply.deferResolveProxy === true) {
						return new Promise<string>((resolve) => {
							releaseProxy = resolve;
						});
					}
					if (reply.resolvesTo !== undefined) {
						return Promise.resolve(reply.resolvesTo);
					}
					const config = record.proxy as { mode?: string; proxyRules?: string } | undefined;
					if (config?.mode !== 'fixed_servers' || config.proxyRules === undefined) {
						return Promise.resolve('DIRECT');
					}
					const [scheme = '', rawEndpoint = ''] = config.proxyRules.split('://');
					/*
					 * **Canonicalised, because Chromium canonicalises.** It does not echo
					 * back the rule it was given: it lowercases and IDNA-encodes the proxy
					 * host first. Measured on this project's own Electron 43.3.0 —
					 * `socks5://Proxy.Example:1080` is reported as
					 * `SOCKS5 proxy.example:1080`. A fake that echoed the rule verbatim
					 * agreed with `plan.endpoint` no matter how it was spelled, which is
					 * why a real proxy being blocked for a capital letter was invisible
					 * here.
					 */
					const lastColon = rawEndpoint.lastIndexOf(':');
					const rawHost = lastColon === -1 ? rawEndpoint : rawEndpoint.slice(0, lastColon);
					const rawPort = lastColon === -1 ? '' : rawEndpoint.slice(lastColon);
					let decodedHost = rawHost;
					try {
						decodedHost = decodeURIComponent(rawHost);
					} catch {
						/* already literal */
					}
					const endpoint = `${domainToASCII(decodedHost) || decodedHost.toLowerCase()}${rawPort}`;
					// The measured tokens, per the `DEFAULT_PORT` docblock in `egress.ts`:
					// Chromium reports an HTTPS proxy as `HTTPS`, not `PROXY`. This fake
					// said `PROXY` for both, which is the very confusion the routing check
					// was missing — a fake that reproduces the bug cannot detect it.
					const keyword = scheme.startsWith('socks')
						? scheme.toUpperCase()
						: scheme === 'https'
							? 'HTTPS'
							: 'PROXY';
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
			handleListeners.push(listeners);
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
		failLate: (index) => {
			handleListeners[index]?.error?.forEach((fn) =>
				(fn as (e: Error) => void)(new Error('net::ERR_ABORTED'))
			);
		},
		releaseResolveProxy: (answer) => {
			releaseProxy?.(answer);
		},
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
	/**
	 * **The scan never crosses a line break, and nothing pinned that.**
	 *
	 * A password may contain a space — that is the whole reason the whitespace-
	 * delimited regex had to go — but it cannot contain a newline and still have
	 * arrived as one line of a quoted URL. Refusing to scan past one bounds how
	 * much of a multi-line message a single wrong guess can rewrite.
	 *
	 * A verifier reported both halves of `CROSSING_END` as unguarded. The
	 * line-break half is pinned below, and the mutant that removes it now fails
	 * three of these.
	 *
	 * **The other half I could not reproduce, and say so rather than pretend
	 * otherwise.** Dropping the path, query and fragment terminators — leaving
	 * only the line breaks — produced byte-identical output on twelve probed
	 * shapes spanning both scan branches, including the ambiguous one where
	 * those characters are the only bound. So either that escape needs a shape
	 * nobody has found, or those terminators are redundant with the `@`-scan and
	 * the word-boundary rule that already run. Left in place either way: they
	 * cost nothing and the reasoning for them still reads correctly. Whoever
	 * finds the shape should add it here.
	 */
	it('stops at a newline rather than swallowing the next line', () => {
		const message =
			'could not reach http://alice@proxy.example:8080\nnext line mentions bob@example.net';
		const redacted = redactCredentials(message);
		expect(redacted, 'the scan crossed a line break and rewrote unrelated prose').toContain(
			'next line mentions bob@example.net'
		);
	});

	it('stops at a carriage return too', () => {
		const message = 'could not reach http://alice@proxy.example:8080\r\nbob@example.net follows';
		expect(redactCredentials(message)).toContain('bob@example.net follows');
	});

	/*
	 * And the other half of the same constant: a path, query or fragment ends the
	 * authority, so an `@` beyond one belongs to the path and not to a credential.
	 */
	it('does not treat an @ in the path as a credential', () => {
		const message = 'could not reach http://proxy.example:8080/inbox/alice@example.net';
		expect(
			redactCredentials(message),
			'an @ after the path separator was read as userinfo, so a path was rewritten as a secret'
		).toContain('/inbox/alice@example.net');
	});

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
 * A proxy password containing whitespace.
 *
 * The pattern was `[^\s/?#]*@`, and the `\s` in it was a hole a real password
 * fits through. `new URL('http://alice:hunter 2@proxy.example:8080')` parses,
 * `planProxy` accepts it, and `steamSessionProxy` hands the raw string — space
 * and all — to the library that quotes it back inside its error message. The
 * match stopped at the space, so `redactCredentials` returned that URL
 * completely unchanged and `hunter 2` went to the renderer and into the
 * activity log through the one function whose entire job is to keep it out of
 * them.
 *
 * A tab is the same hole and worse: the URL parser strips tabs, so
 * `url.password` reads back as `hunter2` while the raw text everybody logs
 * still has the tab in it. Nothing downstream normalises this away.
 *
 * The table is the point. Each row is a shape somebody can actually store, and
 * the two halves — what must be scrubbed, what must be left alone — have to
 * hold at the same time, because widening this pattern is how it last broke.
 */
describe('redacting a password that contains whitespace', () => {
	it.each([
		[
			'a space',
			'connect ECONNREFUSED http://alice:hunter 2@proxy.example:8080',
			'connect ECONNREFUSED http://***:***@proxy.example:8080'
		],
		[
			'a tab',
			'connect ECONNREFUSED http://alice:hunter\t2@proxy.example:8080',
			'connect ECONNREFUSED http://***:***@proxy.example:8080'
		],
		[
			'several spaces',
			'http://alice:correct horse battery staple@proxy.example:8080',
			'http://***:***@proxy.example:8080'
		],
		[
			// Ambiguous on its face: a bare `alice` is a valid host, so the fragment
			// before the space reads as a finished URL as easily as it reads as half
			// a username.
			'a space in the username',
			'http://alice smith:pw@proxy.example:8080',
			'http://***:***@proxy.example:8080'
		],
		[
			// The same ambiguity from the other side: `alice:1234` is a valid
			// `host:port`, and a password beginning with digits is not unusual.
			'a password whose first fragment is digits',
			'http://alice:1234 5@proxy.example:8080',
			'http://***:***@proxy.example:8080'
		],
		[
			'percent-encoding instead of a raw space',
			'connect ECONNREFUSED http://alice:hunter%202@proxy.example:8080',
			'connect ECONNREFUSED http://***:***@proxy.example:8080'
		],
		[
			'a space and an @ together',
			'http://alice:se cret@part@proxy.example:8080',
			'http://***:***@proxy.example:8080'
		],
		[
			'a URL embedded mid-sentence',
			'Steam refused the sign-in: proxy http://alice:hunter 2@proxy.example:8080 rejected it',
			'Steam refused the sign-in: proxy http://***:***@proxy.example:8080 rejected it'
		],
		[
			'two URLs in one message',
			'tried http://alice:hunter 2@one.test:8080 then socks5://bob:pass word@two.test:1080',
			'tried http://***:***@one.test:8080 then socks5://***:***@two.test:1080'
		],
		[
			'a path after the authority',
			'GET http://alice:hunter 2@proxy.example:8080/probe failed',
			'GET http://***:***@proxy.example:8080/probe failed'
		]
	])('scrubs %s', (_name, message, expected) => {
		expect(redactCredentials(message), 'a proxy password survived redaction').toBe(expected);
	});

	it.each([
		['a URL with no credentials at all', 'could not reach http://proxy.example:8080'],
		[
			'a credential-free URL followed by prose containing an @',
			'could not reach http://proxy.example:8080 for account alice@example.net'
		],
		[
			'a credential-free URL with a comma stuck to it',
			'could not reach http://proxy.example:8080, mail ops@example.net'
		],
		['a credential-free URL with a path', 'failed on https://steamcommunity.com/mobileconf'],
		['a Steam URL with an @ in the path', 'https://steamcommunity.com/id/someone@example'],
		['a query string carrying an address', 'https://example.com?email=alice@example.net'],
		[
			'an IPv6 literal beside an address',
			'could not reach http://[::1]:8080 ask alice@example.net'
		],
		['a plain sentence', 'Steam did not accept that username and password.'],
		['a sentence with an address in it', 'write to security@example.net about this']
	])('leaves %s alone', (_name, message) => {
		expect(
			redactCredentials(message),
			'redaction rewrote a message that carried no credentials'
		).toBe(message);
	});

	/*
	 * Stated on its own rather than left to the table, because this is the
	 * property the whole function exists for and it must fail on the reason.
	 *
	 * One `not.toMatch` over every fragment at once is deliberate: an exact-match
	 * table can be satisfied by a function that mangles the message in some new
	 * way, but any piece of a username or password anywhere in the output is a
	 * leak however tidy the rest of it looks. The alternation is the assertion —
	 * a per-fragment `not.toContain` would say the same thing in six lines.
	 */
	it('leaves no fragment of a spaced password behind', () => {
		for (const message of [
			'http://alice:hunter 2@proxy.example:8080',
			'http://alice:hunter\t2@proxy.example:8080',
			'http://alice:correct horse battery staple@proxy.example:8080',
			'socks5://bob:pass word@10.0.0.1:1080'
		]) {
			const redacted = redactCredentials(message);
			expect(redacted, message).not.toMatch(/hunter|horse|battery|staple|pass\b|alice|bob/);
			expect(redacted, message).toContain('***:***@');
		}
	});

	/*
	 * The host has to survive. Redaction that eats the address is not a safer
	 * kind of redaction — it is a failure message that no longer says which
	 * proxy failed, which is the one thing `describeNetworkError` promises.
	 */
	it('keeps the host and port it was scrubbing around', () => {
		expect(redactCredentials('http://alice:hunter 2@proxy.example:8080')).toBe(
			'http://***:***@proxy.example:8080'
		);
	});
});

/*
 * Two edges the redactor is not allowed to fall off. Each of them was deleted
 * from `egress.ts` with this suite still reporting 144 passed, which is the
 * only reason these rows exist.
 *
 * Both mutants fail in the same direction, and it is the worse direction: not
 * a password left sitting in the message, but a real host destroyed and a
 * stranger's email address rewritten as though it were the proxy's
 * credentials, inside a message whose only job is to say what failed.
 *
 *   - Drop `\r` and `\n` from `CROSSING_END` and the whitespace-crossing scan
 *     runs off the end of the line it started on. `http://bob:hunter` at the
 *     end of one line and `ops@example.net` on the next collapse into
 *     `http://***:***@example.net`.
 *   - Add `]` to `TRAILING_PROSE` and `isBareAuthority` can no longer parse
 *     `[::1]`, because the bracket it needs has just been trimmed off the end.
 *     A rejected authority is exactly what sends the scan hunting further
 *     along the sentence, so `http://[::1] ask alice@example.net` collapses
 *     the same way — and from the other side, a genuine credential in front of
 *     a bracketed host stops being redacted at all.
 *
 * These rows assert the whole string rather than the absence of a password.
 * Over-redaction is what is being pinned here, and an assertion that only
 * looks for a leak cannot see it.
 */
describe('redaction stays inside the line and inside the brackets', () => {
	it.each([
		[
			'a line feed between a wrapped proxy URL and a person',
			'connect ECONNREFUSED http://bob:hunter\nnotify ops@example.net'
		],
		[
			'a CRLF, which is what a log on this platform actually writes',
			'connect ECONNREFUSED http://bob:hunter\r\nnotify ops@example.net'
		],
		[
			// A bare CR is not exotic — progress output writes them — and pinning
			// it keeps the guard on the whole character class instead of on
			// whichever line ending somebody happened to think of.
			'a bare carriage return',
			'connect ECONNREFUSED http://bob:hunter\rnotify ops@example.net'
		],
		[
			// The IPv6 row further up carries a port, so nothing is ever trimmed
			// from its tail and a `]` inside TRAILING_PROSE goes unnoticed there.
			// Portless is the shape that catches it.
			'a portless IPv6 literal beside an address',
			'could not reach http://[::1] ask alice@example.net'
		]
	])('leaves %s alone', (_name, message) => {
		expect(
			redactCredentials(message),
			'redaction crossed a boundary it had no business crossing and invented credentials out of unrelated text — the host that actually failed is now missing from the message'
		).toBe(message);
	});

	/*
	 * The same bracket from the side where trimming it leaks rather than
	 * mangles: `[::1]` has to parse as a host on its own for the `@` in front of
	 * it to be recognised as the end of a real credential.
	 */
	it('still scrubs a spaced password in front of a portless IPv6 host', () => {
		expect(
			redactCredentials('proxy http://alice:hunter 2@[::1] refused the connection'),
			'a proxy password in front of a bracketed IPv6 host survived redaction'
		).toBe('proxy http://***:***@[::1] refused the connection');
	});
});

/*
 * A leak that is still in here, written down so it cannot change unnoticed.
 *
 * `http://alice:1234 5 6@proxy.example:8080` comes back untouched. `new URL`
 * parses it and `planProxy` accepts it — username `alice`, password `1234 5 6`
 * — so this is a live leak into the renderer and the activity log, not a
 * curiosity.
 *
 * It is recorded rather than fixed because the shape is undecidable from the
 * message alone. `alice:1234` is a valid `host:port`, so the text reads just as
 * well as a finished URL followed by prose — and the row
 * `could not reach http://proxy.example:8080, mail ops@example.net` in the
 * table above is that same shape word for word: an authority, a word, then a
 * word carrying an `@` and a host.
 *
 * Letting the crossing reach one word further does close this leak, and it was
 * tried before this test was written instead. It also rewrote that row, and
 * both IPv6 rows, into `could not reach http://***:***@example.net` — a
 * credential-free URL and a stranger's address fused into credentials nobody
 * ever had. That is the failure this function has already had once, and it is
 * worse than the leak it would buy off.
 *
 * So the boundary is pinned where it is. If this test fails, the behaviour
 * moved: work out whether whatever moved it also rewrites the leaves-alone
 * rows above, and rewrite this test to say whichever thing is true then.
 */
describe('the residual leak this redactor knowingly keeps', () => {
	it('returns a multi-word ambiguous tail completely unchanged', () => {
		const leaking = 'http://alice:1234 5 6@proxy.example:8080';
		// Anchored to the parser, so this row cannot quietly decay into a string
		// nobody could have stored in the first place.
		expect(decodeURIComponent(new URL(leaking).password)).toBe('1234 5 6');
		expect(
			redactCredentials(leaking),
			'the known residual leak behaves differently now — that may be the fix or may be a new way of mangling messages; decide which, prove it against the leaves-alone rows, and rewrite this test to match'
		).toBe(leaking);
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

/**
 * **SOCKS4 cannot keep the promise the routing screen makes.**
 *
 * The protocol takes an IP address, not a hostname, so the client resolves
 * first: every Steam host this application contacts is looked up on the machine,
 * in the clear, by whatever resolver the network hands out. The proxy sees the
 * connection and the ISP sees the question.
 *
 * It was accepted before, with a comment noting local resolution as a known
 * limitation. A known limitation that defeats the guarantee is not a limitation
 * — and `Require proxies` exists precisely to make "this account's traffic
 * leaves by the address I chose" absolute rather than best-effort. The rest of
 * this module already fails closed for far less: a browser window refuses to
 * open rather than quietly use the real address.
 */
describe('SOCKS4', () => {
	it('is refused', () => {
		expect(() => planProxy('socks4://proxy.example:1080')).toThrow();
	});

	it('is refused in the strict-mode spelling too', () => {
		expect(() => planProxy('socks4a://proxy.example:1080')).toThrow();
	});

	/*
	 * The message has to name the replacement. Somebody with a working SOCKS4
	 * endpoint almost always has SOCKS5 on the same host, and an error that only
	 * says "no" sends them to look for a different proxy.
	 */
	it('says why, and what to use instead', () => {
		let message = '';
		try {
			planProxy('socks4://proxy.example:1080');
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message, 'the refusal did not explain the leak').toMatch(/hostname|resolve/i);
		expect(message, 'the refusal did not name a working alternative').toContain('socks5');
	});

	it('leaves the schemes that do resolve remotely working', () => {
		expect(planProxy('socks5://proxy.example').proxyRules).toBe('socks5://proxy.example:1080');
		expect(planProxy('socks5h://proxy.example').proxyRules).toBe('socks5://proxy.example:1080');
	});
});

/**
 * **Credentials that `redactCredentials` cannot see, refused before they exist.**
 *
 * That function decides from text alone whether a space after a scheme continues
 * the URL or ends it — `http://alice:hunter 2@proxy` against `could not reach
 * http://proxy:8080 for alice@example.net`. It crosses exactly one word, and its
 * own comment names what escapes: a multi-word tail.
 *
 * Measured before this: `http://alice:1234 5 6@proxy.example:8080` was accepted
 * by `planProxy` and returned **unchanged** by `redactCredentials`, so the
 * password reached every message an error is displayed or logged in. One space
 * was redacted; two were not.
 *
 * Widening the scan is the fix that looks obvious and has already been tried —
 * it rewrote whole sentences, inventing credentials and destroying the real
 * host. The ambiguity is not resolvable from text, so the text is not produced:
 * RFC 3986 has no way to carry a raw space in userinfo anyway, and `%20` arrives
 * encoded, survives redaction, and is decoded before it reaches the proxy.
 */
/** A proxy URL whose password carries one byte, named by its codepoint. */
const withByte = (code: number): string =>
	`http://alice:hunter${String.fromCharCode(code)}2@proxy.example:8080`;

describe('proxy credentials that could survive redaction', () => {
	it.each([
		['a space in the password', 'http://alice:hunter 2@proxy.example:8080'],
		['two spaces in the password', 'http://alice:1234 5 6@proxy.example:8080'],
		['a space in the username', 'http://ali ce:hunter2@proxy.example:8080'],
		/*
		 * Built from codepoints rather than written as escapes, for the reason
		 * `tests/no-binary-sources.test.ts` gives: spelling a control character in a
		 * source file means typing one, and every tool between here and the file has
		 * a chance to hand over the byte instead of the escape. It did, twice, and
		 * that guard caught it both times. A carriage return cannot appear in a
		 * string literal at all, so there is no spelling of this line that works.
		 */
		['a tab in the password', withByte(9)],
		['a form feed in the password', withByte(12)],
		['a carriage return in the password', withByte(13)],
		['a null in the password', withByte(0)],
		['a delete character in the password', withByte(127)]
	])('are refused: %s', (_what, url) => {
		expect(
			() => planProxy(url),
			`${url} was accepted, and redactCredentials cannot reliably strip it from a message`
		).toThrow(EgressError);
	});

	it('says how to write one instead', () => {
		expect(() => planProxy('http://alice:hunter 2@proxy.example:8080')).toThrow(/%20/);
	});

	/*
	 * The point of refusing rather than mangling: the password is still usable,
	 * just spelled the way a URL can carry it.
	 */
	it('accepts the percent-encoded spelling and decodes it for the proxy', () => {
		const plan = planProxy('http://alice:hunter%202@proxy.example:8080');
		expect(plan.credentials).toEqual({ username: 'alice', password: 'hunter 2' });
		expect(plan.redacted).toBe('http://***:***@proxy.example:8080');
	});

	/**
	 * **Whitespace is not only U+0020, and the first version of this fix thought
	 * it was.**
	 *
	 * It refused codepoints `<= 0x20`, which is ASCII space and the C0 controls.
	 * Measured afterwards: `http://alice:1234\u00a05\u00a06@proxy.example:8080`
	 * was accepted and came back from `redactCredentials` **unchanged** — the
	 * reported defect exactly, spelled with a different space character. U+2028,
	 * U+2003 and U+3000 did the same, and none of them was in any test.
	 *
	 * They work for the reason the ASCII space did: `AUTHORITY_END` is built from
	 * `\s`, so the redactor stops at every one of them, while `CROSSING_END` does
	 * not, and the one-word crossing is beaten by a multi-word tail. Which is why
	 * the check is now `\s` and not a list of numbers — the same class the
	 * redactor's own boundaries are made of.
	 */
	it.each([
		['a no-break space', 0x00a0],
		['a line separator', 0x2028],
		['a paragraph separator', 0x2029],
		['an ideographic space', 0x3000],
		['an em space', 0x2003],
		['a next line', 0x0085],
		['an en quad', 0x2000],
		['a narrow no-break space', 0x202f]
	])('are refused when separated by %s', (_what, code) => {
		const ws = String.fromCharCode(code);
		expect(
			() => planProxy(`http://alice:1234${ws}5${ws}6@proxy.example:8080`),
			`U+${code.toString(16)} was accepted, and redactCredentials cannot strip it either`
		).toThrow(EgressError);
	});

	/**
	 * **And the regression the first version caused.**
	 *
	 * The check ran on the whole raw string with no trim, so a pasted
	 * `http://proxy.example:8080` carrying a trailing newline — no credentials
	 * anywhere in it — was refused, with a message about usernames and passwords.
	 * `new URL` has always ignored surrounding whitespace; the two now agree.
	 */
	it.each([
		['a leading space', ' http://proxy.example:8080'],
		['a trailing space', 'http://proxy.example:8080 '],
		// Built from codepoints: written as escapes these reach the file as real
		// bytes, which is a broken string literal for a newline and invisible for a
		// tab. tests/no-binary-sources.test.ts exists because of the second one.
		['a trailing newline', `http://proxy.example:8080${String.fromCharCode(10)}`],
		[
			'a tab either side',
			`${String.fromCharCode(9)}http://proxy.example:8080${String.fromCharCode(9)}`
		]
	])('still accepts an address pasted with %s', (_what, raw) => {
		expect(
			planProxy(raw).proxyRules,
			'an address people paste all the time was refused, and the message talked about a ' +
				'password it does not have'
		).toBe('http://proxy.example:8080');
	});

	/*
	 * And the property the refusal exists to protect, asserted directly: whatever
	 * `planProxy` accepts, `redactCredentials` can strip.
	 */
	it('leaves nothing accepted that redaction cannot strip', () => {
		for (const password of ['hunter2', 'hunter%202', 'p@ssword', 'a%3Ab', '%09tab']) {
			const url = `http://alice:${password}@proxy.example:8080`;
			const plan = planProxy(url);
			const redacted = redactCredentials(`could not connect: ${url}`);
			expect(redacted, `${url} survived redaction`).toBe(
				'could not connect: http://***:***@proxy.example:8080'
			);
			expect(plan.redacted).not.toContain('alice');
		}
	});

	/**
	 * **The rule itself, over every separator a document could use.**
	 *
	 * The two lists above are cases somebody thought of, and both times the case
	 * nobody thought of is what shipped. This asserts the invariant instead: for
	 * every codepoint below U+3001, a proxy URL whose credentials are split by it
	 * is either refused outright or fully redacted. Never accepted and left
	 * legible, which is the only outcome that puts a password in a log.
	 */
	it('never accepts a separator that redaction cannot strip', () => {
		const leaked: string[] = [];
		for (let code = 1; code <= 0x3000; code += 1) {
			const ws = String.fromCharCode(code);
			const url = `http://alice:1234${ws}5${ws}6@proxy.example:8080`;

			let credentials: { username: string; password: string } | undefined;
			try {
				credentials = planProxy(url).credentials;
			} catch {
				// Refused, which is one of the two acceptable answers.
				continue;
			}

			/*
			 * **Only when the URL really carries credentials.** For `/`, `?` and `#`
			 * the parser reads `alice:1234` as host and port and everything after as
			 * a path, query or fragment — there is no password in that string, so
			 * `alice` surviving is a host name surviving, which is not a leak and
			 * not something redaction should touch. Asserting on the raw text alone
			 * flagged all three, which is the test being wrong rather than the code.
			 */
			if (!credentials) {
				continue;
			}

			const redacted = redactCredentials(`could not connect: ${url}`);
			if (redacted.includes(credentials.password) || redacted.includes(credentials.username)) {
				leaked.push(`U+${code.toString(16).padStart(4, '0')}`);
			}
		}
		expect(
			leaked,
			'these separators produce a URL that planProxy accepts as carrying credentials and that ' +
				'redactCredentials leaves legible, so the password reaches every message an error is ' +
				'displayed or logged in'
		).toEqual([]);
	});
});

/**
 * **Whether the request went is the whole of what `enroll.ts` needs to know.**
 *
 * `AddAuthenticator`, `FinalizeAddAuthenticator` and `RemoveAuthenticator` all
 * change a Steam account. When one of them fails, the only question that matters
 * is whether Steam might have acted — and the transport is the only thing that
 * can answer it.
 *
 * It answered wrongly for the case the distinction exists for. Every rejection
 * marked itself by hand and the timeout was missed: a timeout happens by
 * definition *after* `handle.end()`, and it reported `sent: false`, so a real
 * lost reply on an irreversible call was passed through as an ordinary failure
 * with no warning and an offer to try again.
 *
 * It is derived from `handle.end()` now, so a handler added later cannot be the
 * one somebody forgot to mark.
 */
describe('whether a failed request had already gone', () => {
	const direct = { steamId64: '76561198000000001' };
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

	it('says it had, when the answer never came', async () => {
		vi.useFakeTimers();
		try {
			const { electron } = fakeElectron({ neverSettles: true });
			const factory = new SteamTransportFactory(electron);
			const transport = await factory.forAccount(direct);

			const failing = transport({ url: STEAM_URL, method: 'GET', cookie: '' });
			const settled = failing.then(
				() => undefined,
				(err: unknown) => err
			);

			await vi.advanceTimersByTimeAsync(60_000);
			const thrown = (await settled) as EgressError;

			expect(thrown, 'the request did not time out at all').toBeInstanceOf(EgressError);
			expect(thrown.message).toMatch(/did not answer in time/);
			expect(
				thrown.sent,
				'a timeout was reported as though the request had never gone, so an irreversible Steam ' +
					'call loses its "may already have happened" warning'
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('says it had not, when the endpoint was refused before anything was built', async () => {
		const { electron, requests } = fakeElectron({});
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(direct);

		const thrown = (await transport({
			url: 'https://not-steam.example/x',
			method: 'GET',
			cookie: ''
		}).then(
			() => undefined,
			(err: unknown) => err
		)) as EgressError;

		expect(thrown).toBeInstanceOf(EgressError);
		expect(requests, 'a request was built for an endpoint that should have been refused').toEqual(
			[]
		);
		expect(
			thrown.sent,
			'a refusal in which no request was ever created claimed the bytes had gone'
		).toBe(false);
	});

	it('says it had not, when the routing check refuses', async () => {
		// The proxy is set but Chromium reports a direct route: nothing is sent.
		const { electron, requests } = fakeElectron({ resolvesTo: 'DIRECT' });
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(routed);

		const thrown = (await transport({ url: STEAM_URL, method: 'GET', cookie: '' }).then(
			() => undefined,
			(err: unknown) => err
		)) as EgressError;

		expect(thrown).toBeInstanceOf(EgressError);
		expect(requests).toEqual([]);
		expect(thrown.sent).toBe(false);
	});
});

/** Let every pending microtask and timer callback run. */
const settleAll = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * **A route is a protocol as well as an address.**
 *
 * `assertRouted` compared `host:port` and nothing else, so a proxy configured
 * `https://` — chosen precisely so the hop to the operator is encrypted — was
 * recorded `verified` against an applied plain `PROXY host:443`. Same operator,
 * same port, no TLS: every Steam cookie and every proxy credential on that hop
 * readable by anything in between, and the account card reporting the route as
 * confirmed.
 *
 * The endpoint half of this check was itself a fix for a substring test. It got
 * the address right and never looked at the scheme.
 */
describe('the protocol a proxy is actually applied over', () => {
	const overTls = { steamId64: '76561198000000009', proxyUrl: 'https://10.0.0.1:8080' };

	it('refuses an https proxy that Chromium applies in the clear', async () => {
		const { electron, requests } = fakeElectron({ resolvesTo: 'PROXY 10.0.0.1:8080' });
		const transport = await new SteamTransportFactory(electron).forAccount(overTls);

		await expect(transport({ url: STEAM_URL, method: 'GET', cookie: '' })).rejects.toThrow(
			/HTTPS|protocol/i
		);
		expect(
			requests,
			'the request went out over an unencrypted hop to the proxy, which is the one thing ' +
				'configuring an https proxy is for'
		).toEqual([]);
	});

	it('records it as blocked rather than verified', async () => {
		const { electron } = fakeElectron({ resolvesTo: 'PROXY 10.0.0.1:8080' });
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(overTls);

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' }).catch(() => undefined);

		expect(factory.routingStatus(overTls.steamId64)?.state).toBe('blocked');
	});

	/*
	 * The other direction, and the reason the tokens are taken from the measured
	 * list rather than guessed: a scheme missing from that map refuses a proxy
	 * that works perfectly, which is a worse outcome for the person holding it
	 * than the leak this check closes.
	 */
	it('allows an https proxy that Chromium applies as HTTPS', async () => {
		const { electron, requests } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount(overTls);

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests, 'a correctly applied https proxy was refused').toHaveLength(1);
		expect(factory.routingStatus(overTls.steamId64)?.state).toBe('verified');
	});

	it('still allows a socks5 proxy applied as SOCKS5', async () => {
		const { electron, requests } = fakeElectron();
		const transport = await new SteamTransportFactory(electron).forAccount({
			steamId64: '76561198000000010',
			proxyUrl: 'socks5://10.0.0.1:1080'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });
		expect(requests).toHaveLength(1);
	});
});

/**
 * **What a lock can still reach.**
 *
 * These are the two places where an operation the vault has already finished
 * with comes back later and writes into state belonging to the account as it is
 * *now*. Both are the shape of the enrolment mutex bug: something captured
 * before an await, acted on after it, without asking whether it is still the
 * current thing.
 */
describe('an operation that outlived the account it belonged to', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

	it('cannot take a newer request off the cancel list', async () => {
		const { electron, aborted, failLate } = fakeElectron({ neverSettles: true });
		const factory = new SteamTransportFactory(electron);

		const first = await factory.forAccount(routed);
		void first({ url: STEAM_URL, method: 'GET', cookie: '' }).catch(() => undefined);
		await settleAll();

		// The vault locks. The first request is cancelled and the account's entry in
		// the cancel list goes with it — but Electron does not settle an aborted
		// request synchronously, so the request itself is still out there.
		factory.forget(routed.steamId64);
		const afterFirstLock = aborted();

		// Unlocked again, and a second request goes out under the same account.
		const second = await factory.forAccount(routed);
		void second({ url: STEAM_URL, method: 'GET', cookie: '' }).catch(() => undefined);
		await settleAll();

		// Only now does the abandoned first request notice. Its cleanup holds a
		// reference to the cancel list as it was, which is no longer the one the
		// account is using.
		failLate(0);
		await settleAll();

		factory.forget(routed.steamId64);

		expect(
			aborted() - afterFirstLock,
			'the second request was not cancelled by the lock: a dead request cleaned up the live ' +
				"request's entry, so the vault sealed while a connection to Steam carried on"
		).toBe(1);
	});

	it('cannot restore a route verified for a session that is gone', async () => {
		const { electron, releaseResolveProxy } = fakeElectron({ deferResolveProxy: true });
		const factory = new SteamTransportFactory(electron);

		const transport = await factory.forAccount(routed);
		const inFlight = transport({ url: STEAM_URL, method: 'GET', cookie: '' }).catch(
			() => undefined
		);
		await settleAll();

		// The lock lands while the routing check is still waiting for its answer.
		factory.forget(routed.steamId64);
		expect(factory.routingStatus(routed.steamId64)).toBeUndefined();

		releaseResolveProxy('SOCKS5 10.0.0.1:1080');
		await inFlight;

		expect(
			factory.routingStatus(routed.steamId64),
			'the account card reports a verified route on the strength of a check made against a ' +
				'session that no longer exists — a stale yes from the one control whose job is to ' +
				'say whether traffic really left through the proxy'
		).toBeUndefined();
	});
});

/**
 * **A cookie jar that refused to empty must not be handed back.**
 *
 * `clearStorageData` rejecting was caught and discarded. `fromPartition` returns
 * the same session object for the same partition name, so the next sign-in for
 * that account got the very jar whose Steam cookies had just refused to be
 * destroyed — a live credential outliving the lock that exists to end it, with
 * nothing anywhere saying so.
 */
describe('a session whose jar could not be emptied', () => {
	const routed = { steamId64: '76561198000000001', proxyUrl: 'socks5://10.0.0.1:1080' };

	it('is never handed back to the account', async () => {
		const { electron, sessions, state } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		expect(sessions).toHaveLength(1);

		state.failClear = new Error('net::ERR_ACCESS_DENIED');
		factory.forget(routed.steamId64);
		await settleAll();

		await factory.forAccount(routed);

		expect(sessions, 'no new session was built at all').toHaveLength(2);
		expect(
			sessions[1]?.partition,
			'the same partition was reused, so Chromium handed back the session holding the Steam ' +
				'cookies the lock failed to destroy'
		).not.toBe(sessions[0]?.partition);
	});

	/*
	 * And the ordinary case is untouched: a jar that empties keeps its name, so
	 * this does not quietly leak a partition per lock.
	 */
	it('keeps its name when the jar empties normally', async () => {
		const { electron, sessions } = fakeElectron();
		const factory = new SteamTransportFactory(electron);

		await factory.forAccount(routed);
		factory.forget(routed.steamId64);
		await settleAll();
		await factory.forAccount(routed);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.cleared).toBe(1);
	});
});

/**
 * **The proxy host, spelled the way Chromium will spell it back.**
 *
 * `socks5:` and `socks5h:` are not "special" schemes, so the WHATWG URL parser
 * leaves their host exactly as typed — case preserved, non-ASCII
 * percent-encoded. `http:` and `https:` are special, and the parser lowercases
 * and IDNA-encodes those itself. Chromium makes no such distinction: it
 * canonicalises every proxy host before reporting it through `resolveProxy`.
 *
 * So `endpoint` was built from the raw string and compared with `!==` against a
 * canonicalised one, and for a SOCKS proxy the two could never agree. One
 * capital letter in a SOCKS hostname blocked every request on that account —
 * every confirmation, poll, clock sync, enrolment and transfer — with
 * `assertRouted` reporting "a different proxy is applied to it" about the very
 * same proxy. The identical failure the `DEFAULT_PORT` docblock was written
 * for, reached through the other half of the same string.
 *
 * The right-hand sides below are **measured**, not assumed: each was produced by
 * `session.setProxy` followed by
 * `resolveProxy('https://steamcommunity.com/mobileconf/getlist')` on this
 * project's own Electron 43.3.0.
 */
describe('a proxy host that is not spelled canonically', () => {
	it.each([
		['socks5://Proxy.Example:1080', 'SOCKS5 proxy.example:1080'],
		['socks5h://Proxy.Example:1080', 'SOCKS5 proxy.example:1080'],
		[
			'socks5://%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80.%D1%80%D1%84:1080',
			'SOCKS5 xn--e1afmkfd.xn--p1ai:1080'
		],
		['https://Proxy.Example:8080', 'HTTPS proxy.example:8080'],
		['http://MY-PROXY.example:8080', 'PROXY my-proxy.example:8080'],
		['socks5://10.0.0.1:1080', 'SOCKS5 10.0.0.1:1080']
	])('%s is planned as the endpoint Chromium reports', (configured, chromiumSaid) => {
		expect(
			planProxy(configured).endpoint,
			`Chromium answers "${chromiumSaid}" for this proxy, and the routing check compares its ` +
				'answer to the planned endpoint with strict equality — so a disagreement here blocks ' +
				'every request on the account with a message naming the very proxy that is working'
		).toBe(routedEndpoint(chromiumSaid));
	});

	/*
	 * End to end through the real factory, so the whole path is exercised rather
	 * than the parsing half alone.
	 */
	it('does not block an account whose SOCKS proxy is typed with capitals', async () => {
		const { electron, requests } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount({
			steamId64: '76561198000000021',
			proxyUrl: 'socks5://Proxy.Example:1080'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests, 'a working proxy was refused over a capital letter').toHaveLength(1);
		expect(factory.routingStatus('76561198000000021')?.state).toBe('verified');
	});

	it('does not block an account whose SOCKS proxy is an internationalised name', async () => {
		const { electron, requests } = fakeElectron();
		const factory = new SteamTransportFactory(electron);
		const transport = await factory.forAccount({
			steamId64: '76561198000000022',
			proxyUrl: 'socks5://пример.рф:1080'
		});

		await transport({ url: STEAM_URL, method: 'GET', cookie: '' });

		expect(requests).toHaveLength(1);
		expect(factory.routingStatus('76561198000000022')?.state).toBe('verified');
	});

	/*
	 * And the endpoint still identifies the proxy: canonicalising must not make
	 * two different proxies compare equal.
	 */
	it('still tells two different proxies apart', () => {
		expect(planProxy('socks5://a.example:1080').endpoint).not.toBe(
			planProxy('socks5://b.example:1080').endpoint
		);
		expect(planProxy('socks5://proxy.example:1080').endpoint).not.toBe(
			planProxy('socks5://proxy.example:1081').endpoint
		);
	});
});
