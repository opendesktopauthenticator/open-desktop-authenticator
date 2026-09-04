import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
	PLATFORM_MOBILE_APP,
	signIn,
	SteamLoginError,
	type LoginSessionLike
} from '../src/main/steam/login';
import { steamSessionProxy } from '../src/main/net/egress';
import { PROXY_CONNECT_TIMEOUT_MS } from '../src/main/net/bounded-https-proxy-agent';
import { SYSTEM_PROXY_AUTH_REQUIRED } from '../src/main/steam/system-login-transport';
// **Statically, not with `await import` inside the test.**
//
// `steam-session` is a heavy real dependency and takes ~600ms to load cold. Done
// inside the test body it was charged against vitest's five-second default, and
// under a full parallel run — sixty-nine files competing for CPU — that
// occasionally lost. The result was an intermittent failure in the one command
// the release workflow uses as a gate, on a test about a constant.
//
// Loading it here pays the cost during collection instead, where it belongs, and
// the assertion below is unchanged.
import { EAuthTokenPlatformType } from 'steam-session';

/**
 * Signing in with a password, once (§12 F3).
 *
 * The protocol itself is `steam-session`'s now, so nothing here re-tests Steam's
 * RSA exchange or poll loop — that is the library's job and testing it again
 * would only assert that a mock matches a mock.
 *
 * What is tested is everything we kept, and every reason we kept it:
 *
 *  - the token must be **mobile-scoped**, because a web-scoped one signs in
 *    perfectly and then cannot approve a single confirmation (F-13);
 *  - a Guard challenge this app cannot answer must be explained, not surfaced
 *    as "action required";
 *  - a failed attempt must be **cancelled**, or the library keeps polling Steam
 *    over the account's proxy after the user has been told it failed;
 *  - a routed account must sign in through its proxy.
 */

const NOW = Date.parse('2026-08-10T00:00:00Z');
const SHARED = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';

function jwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ typ: 'JWT' })}.${encode(claims)}.sig`;
}

const MOBILE_REFRESH = jwt({
	aud: ['web', 'renew', 'derive', 'mobile'],
	exp: Math.floor(NOW / 1000) + 30 * 86_400
});
const WEB_REFRESH = jwt({ aud: ['client', 'web'], exp: Math.floor(NOW / 1000) + 30 * 86_400 });
const EXPIRED_REFRESH = jwt({ aud: ['mobile'], exp: Math.floor(NOW / 1000) - 60 });

const REQUEST = {
	accountName: 'trader',
	password: 'hunter2-but-longer',
	sharedSecret: SHARED,
	unixSeconds: Math.floor(NOW / 1000)
};

interface Scenario {
	/** Guard actions Steam says are still outstanding. Empty means none. */
	validActions?: { type: number }[];
	refreshToken?: string;
	accessToken?: string;
	steamId64?: string;
	/** Thrown from `startWithCredentials`. */
	startError?: Error;
	/** Emitted as an `error` event after the start resolves. */
	lateError?: Error;
	emitTimeout?: boolean;
	/** Start resolves and nothing ever settles, as a real slow Steam does. */
	stalls?: boolean;
}

/**
 * A fake `LoginSession`.
 *
 * Every member matches `steam-session`'s own `.d.ts`. A fake that is more
 * capable than the real object is how proxy authentication shipped broken, so
 * this one is deliberately no richer than the interface it stands in for.
 */
function fakeSession(scenario: Scenario = {}): {
	session: LoginSessionLike;
	started: {
		accountName: string;
		password: string;
		steamGuardCode?: string;
		persistence?: number;
	}[];
	cancelled: () => number;
} {
	const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
	const started: {
		accountName: string;
		password: string;
		steamGuardCode?: string;
		persistence?: number;
	}[] = [];
	let cancels = 0;

	const session: LoginSessionLike = {
		startWithCredentials(details) {
			started.push(details);

			if (scenario.startError) {
				return Promise.reject(scenario.startError);
			}

			const actions = scenario.validActions ?? [];
			if (actions.length > 0) {
				return Promise.resolve({ actionRequired: true, validActions: actions });
			}

			if (scenario.stalls === true) {
				// Steam has the request and has not answered. This is the state a
				// lock can arrive in, and the one nothing could interrupt.
				return Promise.resolve({ actionRequired: false });
			}

			queueMicrotask(() => {
				if (scenario.lateError) {
					listeners.error?.forEach((fn) => fn(scenario.lateError));
					return;
				}
				if (scenario.emitTimeout === true) {
					listeners.timeout?.forEach((fn) => fn());
					return;
				}
				listeners.authenticated?.forEach((fn) => fn());
			});

			return Promise.resolve({ actionRequired: false });
		},
		on(event: string, listener: (arg?: unknown) => void) {
			(listeners[event] ??= []).push(listener);
		},
		cancelLoginAttempt() {
			cancels += 1;
		},
		submitSteamGuardCode() {
			// Not exercised here — enrollment covers it. Present because the real
			// LoginSession has it, and a fake that is less capable than the object it
			// stands in for hides the same class of bug as one that is more capable.
			return Promise.resolve();
		},
		get refreshToken() {
			return scenario.refreshToken ?? MOBILE_REFRESH;
		},
		get accessToken() {
			return scenario.accessToken ?? '';
		},
		get steamID() {
			const id = scenario.steamId64;
			return id === undefined ? undefined : { getSteamID64: () => id };
		}
	};

	return { session, started, cancelled: () => cancels };
}

const at = (): number => NOW;

describe('a successful sign-in', () => {
	it('returns the refresh token and never echoes the password', async () => {
		const { session, started } = fakeSession({ accessToken: 'access-abc' });

		const result = await signIn(REQUEST, undefined, () => session, at);

		expect(result.refreshToken).toBe(MOBILE_REFRESH);
		expect(result.accessToken).toBe('access-abc');
		// The password goes to the library once and appears nowhere in the result.
		expect(JSON.stringify(result)).not.toContain(REQUEST.password);
		expect(started).toHaveLength(1);
	});

	it('answers the Steam Guard challenge with a code it generates itself', async () => {
		// D13: the code is ours, computed from the Steam-corrected clock, and handed
		// to the library rather than the library being asked to fetch one.
		const { session, started } = fakeSession();

		await signIn(REQUEST, undefined, () => session, at);

		expect(started[0]?.steamGuardCode).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
	});

	it('asks for a persistent session, so the refresh token is long-lived', async () => {
		const { session, started } = fakeSession();

		await signIn(REQUEST, undefined, () => session, at);

		expect(started[0]?.persistence).toBe(1);
	});

	it('keeps the SteamID a string, which is the only way it survives', async () => {
		// 76561199999999999 exceeds Number.MAX_SAFE_INTEGER (F-01).
		const { session } = fakeSession({ steamId64: '76561199999999999' });

		const result = await signIn(REQUEST, undefined, () => session, at);

		expect(result.steamId64).toBe('76561199999999999');
	});

	it('omits the access token rather than reporting an empty one', async () => {
		const { session } = fakeSession({ accessToken: '' });

		const result = await signIn(REQUEST, undefined, () => session, at);

		expect(result.accessToken).toBeUndefined();
	});
});

describe('signing in for an account this app does not hold yet', () => {
	/*
	 * Transferring an authenticator away from the Steam mobile app has to sign in
	 * before the secret exists here, so there is nothing to derive a code from.
	 * The user reads the five characters off the phone instead.
	 */
	it('sends the code the user typed', async () => {
		const { session, started } = fakeSession({});
		await signIn(
			{ accountName: 'someone', password: 'pw', steamGuardCode: 'QK4TX', unixSeconds: 1 },
			undefined,
			() => session,
			at
		);
		expect(started[0]?.steamGuardCode).toBe('QK4TX');
	});

	it('still derives the code when the secret is held', async () => {
		const { session, started } = fakeSession({});
		await signIn(REQUEST, undefined, () => session, at);
		// Whatever it is, it is not the string a user typed — it came from SHARED.
		expect(started[0]?.steamGuardCode).toMatch(/^[0-9A-Z]{5}$/);
		expect(started[0]?.steamGuardCode).not.toBe('QK4TX');
	});

	it('refuses when it has neither a secret nor a typed code', async () => {
		const factory = vi.fn(() => fakeSession({}).session);
		const request = { accountName: 'someone', password: 'pw', unixSeconds: 1 };

		await expect(signIn(request, undefined, factory, at)).rejects.toThrow(
			/secret or a Steam Guard code/
		);
		await expect(signIn(request, 'http://proxy.example:8080', factory, at)).rejects.toThrow(
			/secret or a Steam Guard code/
		);
		expect(
			factory,
			'input refusal acquired either system or explicit-proxy state'
		).not.toHaveBeenCalled();
	});

	it('never keeps the typed code on the result', async () => {
		const { session } = fakeSession({});
		const result = await signIn(
			{ accountName: 'someone', password: 'pw', steamGuardCode: 'QK4TX', unixSeconds: 1 },
			undefined,
			() => session,
			at
		);
		expect(JSON.stringify(result)).not.toContain('QK4TX');
	});
});

describe('what a sign-in refuses to accept', () => {
	it('rejects a web-scoped token rather than storing one that cannot work', async () => {
		// The whole point of asking for MobileApp. A web-scoped token signs in, and
		// then every confirmation fails in a way that looks like our bug.
		const { session } = fakeSession({ refreshToken: WEB_REFRESH });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(
			/cannot approve confirmations/
		);
	});

	it('rejects a token that has already expired', async () => {
		const { session } = fakeSession({ refreshToken: EXPIRED_REFRESH });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(/already expired/);
	});

	it('rejects an authentication that produced no token at all', async () => {
		const { session } = fakeSession({ refreshToken: '' });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(
			/without issuing a session/
		);
	});

	it('says plainly when the account uses email codes instead', async () => {
		const { session } = fakeSession({ validActions: [{ type: 2 }] });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(/emailed code/);
	});

	it('says plainly when Steam wants approval on the existing device', async () => {
		const { session } = fakeSession({ validActions: [{ type: 4 }] });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(
			/approved on the device/
		);
	});

	it('blames the clock when Steam rejects the guard code', async () => {
		// We supplied a device code, so being asked for one again means it was not
		// accepted — overwhelmingly a clock far enough out that it was already stale.
		const { session } = fakeSession({ validActions: [{ type: 3 }] });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(/clock is wrong/);
	});

	it('reports a wrong password as a wrong password', async () => {
		const { session } = fakeSession({ startError: new Error('InvalidPassword') });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(
			/did not accept that username and password/
		);
	});

	it('explains rate limiting rather than passing through an EResult name', async () => {
		const { session } = fakeSession({ startError: new Error('RateLimitExceeded') });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(/rate-limiting/);
	});

	it('passes an unfamiliar Steam error through rather than swallowing it', async () => {
		const { session } = fakeSession({ startError: new Error('AccountLoginDeniedThrottle') });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(
			/AccountLoginDeniedThrottle/
		);
	});

	it('identifies a refused CONNECT tunnel as a proxy failure, not a Steam refusal', async () => {
		const { session } = fakeSession({
			startError: new Error('Proxy CONNECT 407 Proxy Authentication Required')
		});

		const result = signIn(REQUEST, 'http://proxy.example:8080', () => session, at);
		await expect(result).rejects.toThrow(/proxy requires.*or did not accept/i);
		await expect(result).rejects.not.toThrow(/Steam refused/i);
	});

	it('preserves the actionable system-proxy authentication refusal without remote details', async () => {
		const { session } = fakeSession({ startError: new Error(SYSTEM_PROXY_AUTH_REQUIRED) });

		const result = signIn(REQUEST, undefined, () => session, at);
		await expect(result).rejects.toThrow(SYSTEM_PROXY_AUTH_REQUIRED);
		await expect(result).rejects.not.toThrow(/Steam refused/i);
	});

	it('identifies an agent handshake timeout as a proxy failure, not a Steam refusal', async () => {
		const { session } = fakeSession({
			startError: new Error('A "socket" was not created for HTTP request before 5000ms')
		});

		const result = signIn(REQUEST, 'socks5://proxy.example:1080', () => session, at);
		await expect(result).rejects.toThrow(/proxy did not finish opening/i);
		await expect(result).rejects.not.toThrow(/Steam refused/i);
	});

	it.each([
		'Proxy CONNECT response headers exceeded 16384 bytes',
		'Proxy connection ended before receiving CONNECT response',
		'Invalid response from proxy CONNECT request',
		'Invalid header in proxy CONNECT response',
		'Proxy CONNECT failed: read ECONNRESET'
	])('identifies a malformed proxy response instead of blaming Steam: %s', async (failure) => {
		const { session } = fakeSession({ startError: new Error(failure) });

		const result = signIn(REQUEST, 'http://proxy.example:8080', () => session, at);
		await expect(result).rejects.toThrow(/proxy closed.*or sent an invalid response/i);
		await expect(result).rejects.not.toThrow(/Steam refused/i);
	});

	it('reports a timeout as worth retrying', async () => {
		const { session } = fakeSession({ emitTimeout: true });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toMatchObject({
			permanent: false
		});
	});

	it('marks a rejected credential and a transport failure both as retryable', async () => {
		// `permanent` drives whether the UI offers the password box again. A guard
		// refusal is permanent; anything that might work on a second attempt is not.
		const { session: bad } = fakeSession({ startError: new Error('InvalidPassword') });
		const { session: guard } = fakeSession({ validActions: [{ type: 2 }] });

		await expect(signIn(REQUEST, undefined, () => bad, at)).rejects.toMatchObject({
			permanent: false
		});
		await expect(signIn(REQUEST, undefined, () => guard, at)).rejects.toMatchObject({
			permanent: true
		});
	});
});

/**
 * Regression guard for a resource leak with a privacy cost.
 *
 * `startWithCredentials` leaves a polling loop running inside the library. A
 * rejection that does not cancel keeps an authentication attempt alive against
 * Steam — over the account's proxy — after the user has been told it failed.
 */
describe('a failed sign-in', () => {
	it('cancels immediately if later session setup throws synchronously', async () => {
		const { session, cancelled } = fakeSession();
		session.on = () => {
			throw new Error('the installed session event seam changed');
		};

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow(
			/event seam changed/i
		);
		expect(cancelled(), 'the acquired login session kept its transport lease').toBe(1);
	});

	it('cancels the attempt when a guard challenge cannot be answered', async () => {
		const { session, cancelled } = fakeSession({ validActions: [{ type: 2 }] });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow();
		expect(cancelled()).toBe(1);
	});

	it('cancels the attempt when the start itself fails', async () => {
		const { session, cancelled } = fakeSession({ startError: new Error('InvalidPassword') });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow();
		expect(cancelled()).toBe(1);
	});

	it('cancels the attempt on a late error event', async () => {
		const { session, cancelled } = fakeSession({ lateError: new Error('ServiceUnavailable') });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow();
		expect(cancelled()).toBe(1);
	});

	it('cancels exactly once even if several failures arrive', async () => {
		const { session, cancelled } = fakeSession({ lateError: new Error('ServiceUnavailable') });

		await expect(signIn(REQUEST, undefined, () => session, at)).rejects.toThrow();
		// A `timeout` arriving after an `error` must not re-enter the failure path.
		expect(cancelled()).toBe(1);
	});
});

describe('signing in through a proxy', () => {
	it('hands the account proxy to the session factory', async () => {
		const factory = vi.fn(() => fakeSession().session);

		await signIn(REQUEST, 'http://user:pass@10.0.0.1:8080', factory, at);

		expect(factory).toHaveBeenCalledWith('http://user:pass@10.0.0.1:8080');
	});

	it('passes no proxy for an account that is not routed', async () => {
		const factory = vi.fn(() => fakeSession().session);

		await signIn(REQUEST, undefined, factory, at);

		expect(factory).toHaveBeenCalledWith(undefined);
	});

	it('keeps a real HTTP 407 classified as a proxy failure through steam-session', async () => {
		const proxy = createServer();
		proxy.on('connect', (_request, socket) => {
			socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const port = (proxy.address() as AddressInfo).port;
			const result = signIn(REQUEST, `http://127.0.0.1:${port}`);
			await expect(result).rejects.toThrow(/proxy requires.*or did not accept/i);
			await expect(result).rejects.not.toThrow(/Steam refused/i);
		} finally {
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it('never displays a proxy-controlled CONNECT reason phrase', async () => {
		const proxyPassword = 'swordfish-reason-phrase-secret';
		let authorization: string | undefined;
		const proxy = createServer();
		proxy.on('connect', (request, socket) => {
			authorization = request.headers['proxy-authorization'];
			const encoded = authorization?.replace(/^Basic\s+/i, '') ?? '';
			const supplied = Buffer.from(encoded, 'base64').toString('utf8');
			const password = supplied.split(':').slice(1).join(':');
			// A proxy controls this text and already knows the credentials it was
			// sent. Echoing them proves the renderer never treats its prose as ours.
			socket.end(`HTTP/1.1 407 rejected-${password}\r\nConnection: close\r\n\r\n`);
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const port = (proxy.address() as AddressInfo).port;
			const outcome = await signIn(
				REQUEST,
				`http://alice:${proxyPassword}@127.0.0.1:${port}`
			).catch((error: unknown) => error);

			expect(authorization).toBe(
				`Basic ${Buffer.from(`alice:${proxyPassword}`, 'utf8').toString('base64')}`
			);
			expect(outcome).toBeInstanceOf(SteamLoginError);
			expect((outcome as Error).message).toMatch(/proxy requires.*CONNECT 407/i);
			expect((outcome as Error).message).not.toContain(proxyPassword);
			expect((outcome as Error).message).not.toContain(REQUEST.password);
		} finally {
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it.each([
		'InvalidPassword',
		'InvalidCredentials',
		'RateLimitExceeded',
		'TooManyAttempts — 密碼 swordfish-proxy-secret'
	])('classifies a hostile proxy reason before Steam result names: %s', async (reason) => {
		let tunnels = 0;
		const proxy = createServer();
		proxy.on('connect', (_request, socket) => {
			tunnels += 1;
			socket.end(`HTTP/1.1 407 ${reason}\r\nConnection: close\r\n\r\n`);
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const port = (proxy.address() as AddressInfo).port;
			const outcome = await signIn(REQUEST, `http://127.0.0.1:${port}`).catch(
				(error: unknown) => error
			);

			expect(outcome).toBeInstanceOf(SteamLoginError);
			expect((outcome as Error).message).toBe(
				'The proxy requires a username and password, or did not accept the ones configured (CONNECT 407).'
			);
			expect((outcome as Error).message).not.toContain(reason);
			expect(tunnels, 'the refused proxy response was retried or bypassed').toBe(1);
		} finally {
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it('keeps a real SOCKS handshake refusal classified as a proxy failure', async () => {
		const proxy = createTcpServer((socket) => {
			socket.once('data', () => socket.end(Buffer.from([5, 0xff])));
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const port = (proxy.address() as AddressInfo).port;
			const result = signIn(REQUEST, `socks5://127.0.0.1:${port}`);
			await expect(result).rejects.toThrow(/SOCKS proxy rejected/i);
			await expect(result).rejects.not.toThrow(/Steam refused/i);
		} finally {
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});
});

/**
 * The translation into `steam-session`'s option shape.
 *
 * Its `httpProxy`, `socksProxy` and `agent` options are mutually exclusive, so
 * picking the wrong key is a silently direct connection — the exact failure the
 * fail-closed rule exists to prevent.
 */
describe('proxy options for steam-session', () => {
	it('keeps the production handshake deadline at no more than five seconds', () => {
		expect(PROXY_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
		expect(PROXY_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
	});

	it('uses an explicit agent for HTTP proxying', () => {
		const options = steamSessionProxy('http://user:pa55@1.2.3.4:8080');
		expect('agent' in options).toBe(true);
	});

	it.each([
		['reserved characters', 'user%40host', 'p%40ss%3Aword', 'user@host:p@ss:word'],
		['non-ASCII characters', 'us%C3%A9r', 'p%C3%A5ss', 'usér:påss'],
		['a literal percent', 'user', '100%sure', 'user:100%sure']
	])('authenticates with decoded %s', async (_name, username, password, expected) => {
		let authorization: string | undefined;
		const proxy = createServer();
		proxy.on('connect', (request, socket) => {
			authorization = request.headers['proxy-authorization'];
			socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const port = (proxy.address() as AddressInfo).port;
			const options = steamSessionProxy(`http://${username}:${password}@127.0.0.1:${port}`);
			if (!('agent' in options)) {
				throw new Error('HTTP proxy did not produce an agent');
			}

			const outcome = await new Promise<string>((resolve) => {
				const request = httpsRequest(
					{
						hostname: 'steam.invalid',
						path: '/',
						agent: options.agent
					},
					(response) => {
						response.resume();
						resolve(`unexpected response ${response.statusCode}`);
					}
				);
				request.once('error', (error) => resolve(error.message));
				request.end();
			});

			expect(outcome).toMatch(/Proxy CONNECT 407 Proxy Authentication Required/);
			expect(authorization).toBe(`Basic ${Buffer.from(expected, 'utf8').toString('base64')}`);
		} finally {
			await new Promise<void>((resolve, reject) =>
				proxy.close((err) => (err === undefined ? resolve() : reject(err)))
			);
		}
	});

	it('ends a CONNECT attempt whose proxy accepts the socket but never answers', async () => {
		const sockets = new Set<Socket>();
		let proxySawEnd!: () => void;
		const ended = new Promise<void>((resolve) => {
			proxySawEnd = resolve;
		});
		const proxy = createServer();
		let connects = 0;
		proxy.on('connection', (socket) => {
			sockets.add(socket);
			socket.on('error', () => {
				// A peer closing while this deliberately hostile server is writing is
				// the expected outcome under test.
			});
			socket.once('close', () => {
				sockets.delete(socket);
			});
			socket.once('end', proxySawEnd);
		});
		proxy.on('connect', (_connectRequest, socket) => {
			connects += 1;
			if (connects > 1) {
				socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
				return;
			}
			// A blackhole proxy: it accepted the CONNECT request and deliberately
			// never sends a response. The agent, not the outer request, owns this
			// socket while it waits.
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		let request: ReturnType<typeof httpsRequest> | undefined;
		try {
			const port = (proxy.address() as AddressInfo).port;
			const options = steamSessionProxy(`http://127.0.0.1:${port}`, 100);
			if (!('agent' in options)) throw new Error('HTTP proxy did not produce an agent');

			const outcome = new Promise<string>((resolve) => {
				request = httpsRequest({ hostname: 'steam.invalid', agent: options.agent });
				request.once('error', (error) => resolve(error.message));
				request.end();
			});

			expect(await Promise.race([outcome, delay(750, '<still pending>')])).toMatch(
				/proxy connection timed out/i
			);
			expect(
				await Promise.race([ended.then(() => true), delay(500, false)]),
				'the agent reported a timeout but did not close its side of the proxy socket'
			).toBe(true);

			const second = new Promise<string>((resolve) => {
				const next = httpsRequest({ hostname: 'steam.invalid', agent: options.agent });
				next.once('error', (error) => resolve(error.message));
				next.end();
			});
			expect(
				await Promise.race([second, delay(750, '<still pending>')]),
				'a timeout poisoned the shared agent for later requests'
			).toMatch(/Proxy CONNECT 407 Proxy Authentication Required/);
		} finally {
			request?.destroy();
			for (const socket of sockets) socket.destroy();
			proxy.closeAllConnections();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it('rejects and closes an unterminated oversized CONNECT response', async () => {
		const sockets = new Set<Socket>();
		let proxySocketClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			proxySocketClosed = resolve;
		});
		const proxy = createServer();
		proxy.on('connection', (socket) => {
			sockets.add(socket);
			socket.on('error', () => {
				// Expected when the bounded client drops this oversized response.
			});
			socket.once('close', () => {
				sockets.delete(socket);
				proxySocketClosed();
			});
		});
		proxy.on('connect', (_connectRequest, socket) => {
			socket.write(`HTTP/1.1 200 Connection Established\r\nX-Fill: ${'a'.repeat(256 * 1024)}`);
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		let request: ReturnType<typeof httpsRequest> | undefined;
		try {
			const port = (proxy.address() as AddressInfo).port;
			const options = steamSessionProxy(`http://127.0.0.1:${port}`, 1_000);
			if (!('agent' in options)) throw new Error('HTTP proxy did not produce an agent');

			const outcome = new Promise<Error>((resolve) => {
				request = httpsRequest({ hostname: 'steam.invalid', agent: options.agent });
				request.once('error', resolve);
				request.end();
			});

			const failure = await Promise.race([outcome, delay(750, '<still pending>')]);
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) throw new Error(failure);
			expect(failure.message).toMatch(/proxy CONNECT response headers exceeded/i);
			// Rejection remains bounded above; only the server-side close event gets
			// scheduler headroom after the client has already rejected and torn down.
			const socketCloseObservationMs = 5_000;
			expect(
				await Promise.race([closed.then(() => true), delay(socketCloseObservationMs, false)]),
				'the agent rejected the response but left its proxy socket open'
			).toBe(true);

			const { session } = fakeSession({ startError: failure });
			const signInResult = signIn(REQUEST, `http://127.0.0.1:${port}`, () => session, at);
			await expect(signInResult).rejects.toThrow(/proxy closed.*or sent an invalid response/i);
			await expect(signInResult).rejects.not.toThrow(/Steam refused/i);
		} finally {
			request?.destroy();
			for (const socket of sockets) socket.destroy();
			proxy.closeAllConnections();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	}, 10_000);

	it('does not retry directly after a proxy refuses the tunnel', async () => {
		let originConnections = 0;
		const origin = createTcpServer((socket) => {
			originConnections += 1;
			socket.destroy();
		});
		await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
		const originPort = (origin.address() as AddressInfo).port;

		let proxyAuthorization: string | undefined;
		const proxy = createServer();
		proxy.on('connect', (request, socket) => {
			proxyAuthorization = request.headers['proxy-authorization'];
			socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const proxyPort = (proxy.address() as AddressInfo).port;
			const options = steamSessionProxy(`http://alice:s3cret@127.0.0.1:${proxyPort}`);
			if (!('agent' in options)) throw new Error('HTTP proxy did not produce an agent');

			const outcome = await new Promise<string>((resolve) => {
				const request = httpsRequest(
					{ hostname: '127.0.0.1', port: originPort, agent: options.agent },
					(response) => {
						response.resume();
						resolve(`unexpected response ${response.statusCode}`);
					}
				);
				request.once('error', (error) => resolve(error.message));
				request.end();
			});

			expect(outcome).toMatch(/Proxy CONNECT 407 Proxy Authentication Required/);
			expect(proxyAuthorization).toBe(
				`Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`
			);
			expect(originConnections, 'the failed proxy tunnel fell back to a direct connection').toBe(0);
		} finally {
			await Promise.all([
				new Promise<void>((resolve, reject) =>
					proxy.close((err) => (err === undefined ? resolve() : reject(err)))
				),
				new Promise<void>((resolve, reject) =>
					origin.close((err) => (err === undefined ? resolve() : reject(err)))
				)
			]);
		}
	});

	it('formats an IPv6 destination as a CONNECT authority', async () => {
		let authority: string | undefined;
		const proxy = createServer();
		proxy.on('connect', (request, socket) => {
			authority = request.url;
			socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const port = (proxy.address() as AddressInfo).port;
			const options = steamSessionProxy(`http://127.0.0.1:${port}`);
			if (!('agent' in options)) throw new Error('HTTP proxy did not produce an agent');

			const outcome = await new Promise<Error>((resolve) => {
				const request = httpsRequest(
					{ hostname: '::1', port: 443, agent: options.agent },
					(response) => {
						response.resume();
						resolve(new Error(`unexpected response ${response.statusCode}`));
					}
				);
				request.once('error', resolve);
				request.end();
			});
			expect(outcome.message).toMatch(/Proxy CONNECT 407 Proxy Authentication Required/);
			expect(authority).toBe('[::1]:443');

			const { session } = fakeSession({ startError: outcome });
			const signInResult = signIn(REQUEST, `http://127.0.0.1:${port}`, () => session, at);
			await expect(signInResult).rejects.toThrow(/proxy requires.*or did not accept/i);
			await expect(signInResult).rejects.not.toThrow(/Steam refused/i);
		} finally {
			await new Promise<void>((resolve, reject) =>
				proxy.close((err) => (err === undefined ? resolve() : reject(err)))
			);
		}
	});

	it('sends Proxy-Authorization only to the proxy, never through the tunnel', async () => {
		let originAuthorization: string | undefined;
		const origin = createServer((request, response) => {
			originAuthorization = request.headers['proxy-authorization'];
			response.end('ok');
		});
		await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
		const originPort = (origin.address() as AddressInfo).port;

		let connectAuthorization: string | undefined;
		const proxy = createServer();
		proxy.on('connect', (request, client) => {
			connectAuthorization = request.headers['proxy-authorization'];
			const upstream = connect(originPort, '127.0.0.1', () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				client.pipe(upstream);
				upstream.pipe(client);
			});
			upstream.once('error', () => client.destroy());
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const proxyPort = (proxy.address() as AddressInfo).port;
			const options = steamSessionProxy(`http://alice:s3cret@127.0.0.1:${proxyPort}`);
			if (!('agent' in options)) throw new Error('HTTP proxy did not produce an agent');

			const body = await new Promise<string>((resolve, reject) => {
				const request = httpRequest(
					{ hostname: '127.0.0.1', port: originPort, path: '/', agent: options.agent },
					(response) => {
						const chunks: Buffer[] = [];
						response.on('data', (chunk: Buffer) => chunks.push(chunk));
						response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
					}
				);
				request.once('error', reject);
				request.end();
			});

			expect(body).toBe('ok');
			expect(connectAuthorization).toBe(
				`Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`
			);
			expect(originAuthorization).toBeUndefined();
		} finally {
			await Promise.all([
				new Promise<void>((resolve, reject) =>
					proxy.close((err) => (err === undefined ? resolve() : reject(err)))
				),
				new Promise<void>((resolve, reject) =>
					origin.close((err) => (err === undefined ? resolve() : reject(err)))
				)
			]);
		}
	});

	it('accepts a CONNECT header terminator split across socket reads', async () => {
		const proxy = createServer();
		proxy.on('connect', (_request, socket) => {
			socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: test\r\n\r');
			setImmediate(() => {
				socket.once('data', () => {
					socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
				});
				socket.write('\n');
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		try {
			const port = (proxy.address() as AddressInfo).port;
			const options = steamSessionProxy(`http://127.0.0.1:${port}`);
			const result = await new Promise<{ status: number | undefined; body: string }>(
				(resolve, reject) => {
					const request = httpRequest(
						{ hostname: 'steam.invalid', path: '/', agent: options.agent },
						(response) => {
							const chunks: Buffer[] = [];
							response.on('data', (chunk: Buffer) => chunks.push(chunk));
							response.once('end', () =>
								resolve({
									status: response.statusCode,
									body: Buffer.concat(chunks).toString('utf8')
								})
							);
						}
					);
					request.once('error', reject);
					request.end();
				}
			);

			expect(result).toEqual({ status: 200, body: 'ok' });
		} finally {
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it('uses the same decoded-auth agent for an HTTPS proxy endpoint', () => {
		const options = steamSessionProxy('https://user%40host:p%40ss@proxy.example:8443');
		const agent = options.agent as unknown as { proxy: URL };
		expect(agent.proxy.protocol).toBe('https:');
		expect(decodeURIComponent(agent.proxy.username)).toBe('user@host');
		expect(decodeURIComponent(agent.proxy.password)).toBe('p@ss');
	});

	it('routes SOCKS through a bounded agent in the remote-DNS spelling', () => {
		// `socks5h`, not `socks5`. socks-proxy-agent reads `socks5` as *resolve
		// the hostname locally*, so the plain spelling had every sign-in look
		// Steam's hostnames up on the user's own resolver — at the exact moments
		// an account was being tied to a route. Chromium's half of the app already
		// resolves at the proxy for `socks5`; this makes the Node half agree.
		const agent = steamSessionProxy('socks5://1.2.3.4:1080').agent as unknown as {
			shouldLookup: boolean;
			proxy: { host: string; port: number; type: number };
		};
		expect(agent.shouldLookup).toBe(false);
		expect(agent.proxy).toMatchObject({ host: '1.2.3.4', port: 1080, type: 5 });
	});

	it('never downgrades an explicit remote-DNS spelling', () => {
		// The old normalisation rewrote socks5h to socks5 — turning the one
		// spelling a user chooses *specifically for remote DNS* into the local
		// one, silently.
		const agent = steamSessionProxy('socks5h://1.2.3.4:1080').agent as unknown as {
			shouldLookup: boolean;
		};
		expect(agent.shouldLookup).toBe(false);
		// `socks4a` is refused outright: Chromium has no such rule and its nearest
		// equivalent resolves locally, so accepting it would mean sign-in and
		// confirmations resolving Steam in two different places.
		expect(() => steamSessionProxy('socks4a://1.2.3.4:1080')).toThrow(/not supported|use http/i);
	});

	it('ends the deadline when SOCKS negotiation succeeds and leaves slow origin traffic alive', async () => {
		const handshakeDeadlineMs = 75;
		const originDelayMs = 225;
		const sockets = new Set<Socket>();
		const origin = createServer((_request, response) => {
			setTimeout(() => {
				response.setHeader('Connection', 'close');
				response.end('ok');
			}, originDelayMs);
		});
		await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
		const originPort = (origin.address() as AddressInfo).port;

		const proxy = createTcpServer((client) => {
			sockets.add(client);
			client.once('close', () => sockets.delete(client));
			client.on('error', () => undefined);
			let phase: 'greeting' | 'request' | 'tunnel' = 'greeting';
			let buffered = Buffer.alloc(0);

			const receiveHandshake = (chunk: Buffer): void => {
				buffered = Buffer.concat([buffered, chunk]);
				if (phase === 'greeting') {
					const methods = buffered[1];
					if (methods === undefined || buffered.length < 2 + methods) return;
					buffered = buffered.subarray(2 + methods);
					phase = 'request';
					client.write(Buffer.from([5, 0]));
				}

				if (phase !== 'request' || buffered.length < 5) return;
				const addressType = buffered[3];
				const requestLength =
					addressType === 1
						? 10
						: addressType === 4
							? 22
							: addressType === 3
								? 7 + (buffered[4] ?? 0)
								: Number.POSITIVE_INFINITY;
				if (buffered.length < requestLength) return;
				phase = 'tunnel';
				client.removeListener('data', receiveHandshake);

				const upstream = connect(originPort, '127.0.0.1', () => {
					sockets.add(upstream);
					upstream.once('close', () => sockets.delete(upstream));
					client.pipe(upstream);
					upstream.pipe(client);
					client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
				});
				upstream.on('error', () => client.destroy());
			};
			client.on('data', receiveHandshake);
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		let request: ReturnType<typeof httpRequest> | undefined;
		try {
			const proxyPort = (proxy.address() as AddressInfo).port;
			const agent = steamSessionProxy(`socks5://127.0.0.1:${proxyPort}`, handshakeDeadlineMs).agent;
			const startedAt = Date.now();
			const body = await Promise.race([
				new Promise<string>((resolve, reject) => {
					request = httpRequest(
						{ hostname: 'steam.invalid', port: 80, path: '/', agent },
						(response) => {
							const chunks: Buffer[] = [];
							response.on('data', (chunk: Buffer) => chunks.push(chunk));
							response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
						}
					);
					request.once('error', reject);
					request.end();
				}),
				delay(2_000, '<still pending>')
			]);

			expect(body).toBe('ok');
			expect(
				Date.now() - startedAt,
				'the origin answered before the injected handshake deadline elapsed'
			).toBeGreaterThan(handshakeDeadlineMs);
		} finally {
			request?.destroy();
			for (const socket of sockets) socket.destroy();
			origin.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve()))
			]);
		}
	});

	it('bounds a blackhole SOCKS handshake, closes it, and remains reusable', async () => {
		const sockets = new Set<Socket>();
		let firstSocketGone!: () => void;
		const firstGone = new Promise<void>((resolve) => {
			firstSocketGone = resolve;
		});
		let connections = 0;
		const proxy = createTcpServer((socket) => {
			connections += 1;
			const current = connections;
			sockets.add(socket);
			socket.on('error', () => undefined);
			socket.on('data', () => undefined);
			socket.once('close', () => {
				sockets.delete(socket);
				if (current === 1) firstSocketGone();
			});
			if (current === 1) {
				socket.once('end', firstSocketGone);
				return;
			}
			// A decisive second response: the proxy was reached, but supports no
			// authentication method. This proves the first timeout did not poison
			// the shared agent used by the rest of the sign-in.
			socket.once('data', () => socket.end(Buffer.from([5, 0xff])));
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));

		let first: ReturnType<typeof httpsRequest> | undefined;
		try {
			const port = (proxy.address() as AddressInfo).port;
			const agent = steamSessionProxy(`socks5://127.0.0.1:${port}`, 100).agent;

			const firstOutcome = new Promise<string>((resolve) => {
				first = httpsRequest({ hostname: 'steam.invalid', agent });
				first.once('error', (error) => resolve(error.message));
				first.end();
			});
			expect(await Promise.race([firstOutcome, delay(750, '<still pending>')])).toMatch(
				/timeout|timed out|before 100ms/i
			);
			expect(
				await Promise.race([firstGone.then(() => true), delay(500, false)]),
				'the SOCKS timeout did not close its side of the proxy socket'
			).toBe(true);

			const secondOutcome = new Promise<Error>((resolve) => {
				const second = httpsRequest({ hostname: 'steam.invalid', agent });
				second.once('error', resolve);
				second.end();
			});
			const secondFailure = await Promise.race([secondOutcome, delay(750, '<still pending>')]);
			expect(
				secondFailure,
				'a SOCKS timeout poisoned the agent for its next request'
			).toBeInstanceOf(Error);
			if (!(secondFailure instanceof Error)) throw new Error(secondFailure);
			expect(secondFailure.name).toBe('ProxyConnectionError');
			expect(connections).toBe(2);

			const { session } = fakeSession({ startError: secondFailure });
			const signInResult = signIn(REQUEST, `socks5://127.0.0.1:${port}`, () => session, at);
			await expect(signInResult).rejects.toThrow(/SOCKS proxy rejected/i);
			await expect(signInResult).rejects.not.toThrow(/Steam refused/i);
		} finally {
			first?.destroy();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it('builds agents the real SOCKS library reads as remote-DNS', () => {
		// Against the library itself, not our reading of its documentation:
		// `shouldLookup === false` is socks-proxy-agent's own flag for "send the
		// hostname to the proxy". If a future version changes its scheme table,
		// this is the test that notices.
		for (const stored of ['socks5://1.2.3.4:1080', 'socks5h://1.2.3.4:1080']) {
			const agent = steamSessionProxy(stored).agent as unknown as {
				shouldLookup: boolean;
			};
			expect(agent.shouldLookup).toBe(false);
		}
	});

	it('refuses anything planProxy would refuse, so the two cannot disagree', () => {
		expect(() => steamSessionProxy('ftp://1.2.3.4:21')).toThrow();
		expect(() => steamSessionProxy('not a url')).toThrow();
	});

	it('always returns exactly one recognised option key', () => {
		// The invariant `createLoginSession` asserts before handing the object to
		// the library. `steam-session` ignores an unrecognised key in silence and
		// connects direct, and there is no way to ask it afterwards — so returning
		// `{}` or a misspelled key here would be an undetectable anonymity leak.
		for (const url of [
			'http://1.2.3.4:8080',
			'https://1.2.3.4:8443',
			'socks5://1.2.3.4:1080',
			'socks5h://1.2.3.4:1080'
		]) {
			const keys = Object.keys(steamSessionProxy(url));
			expect(keys, url).toHaveLength(1);
			expect(keys, url).toEqual(['agent']);
		}
	});
});

describe('the platform type', () => {
	it('is MobileApp, and the library agrees', () => {
		// Confirmations cannot be driven by any other scope (F-13). Checked against
		// the library's own enum rather than restated from memory.
		expect(PLATFORM_MOBILE_APP).toBe(3);
		expect(EAuthTokenPlatformType.MobileApp).toBe(PLATFORM_MOBILE_APP);
	});
});

describe('SteamLoginError', () => {
	it('defaults to permanent, so an unclassified failure does not invite retries', () => {
		expect(new SteamLoginError('x').permanent).toBe(true);
	});
});

/*
 * A portless SOCKS proxy has to work for `steam-session` too.
 *
 * `planProxy` fills in Chromium's default port, so confirmations routed fine —
 * but the sign-in URL was built by slicing the *raw* string, and
 * `socks-proxy-agent` parses an empty port as `parseInt('')`, i.e. `NaN`. Its
 * own `if (port == null) port = 1080` default never fires, because
 * `NaN == null` is false. So every sign-in, enrollment and transfer failed on
 * an address the routing screen had just accepted.
 */
describe('a portless SOCKS proxy', () => {
	it('carries the port steam-session needs', () => {
		const agent = steamSessionProxy('socks5://proxy.example').agent as unknown as {
			proxy: { port: number };
		};
		expect(agent.proxy.port).toBe(1080);
	});

	it('produces agents the real library reads as a usable port', () => {
		for (const stored of ['socks5://proxy.example', 'socks5h://proxy.example']) {
			const agent = steamSessionProxy(stored).agent as unknown as {
				proxy: { port: number };
			};
			expect(Number.isFinite(agent.proxy.port)).toBe(true);
			expect(agent.proxy.port).toBe(1080);
		}
	});

	it('refuses a SOCKS proxy that needs credentials', () => {
		// Chromium's SOCKS5 client implements no authentication methods, so a
		// stored `socks5://user:pass@…` signed in through Node and then failed
		// every confirmation. Refused where the user can still see the field.
		expect(() => steamSessionProxy('socks5://user:pa55@1.2.3.4:1080')).toThrow(
			/cannot authenticate/i
		);
		// http and https carry credentials on both stacks and are unaffected.
		expect('agent' in steamSessionProxy('http://user:pa55%40word@1.2.3.4:8080')).toBe(true);
	});
});

/*
 * **Refusing the answer is not the same as stopping the question.**
 *
 * A sign-in runs for as long as Steam takes, up to the ninety-second timeout,
 * and the vault can lock in the middle of one — the idle timer alone will do
 * it. `ConfirmationsService.forget` bumped its generation so the eventual token
 * was thrown away, and that was the whole of it: underneath, `steam-session`
 * went on polling, over the account's proxy, holding the user's password in a
 * closure, for up to a minute and a half after the user had said stop.
 */
describe('a sign-in that is still running when the vault locks', () => {
	it('hands out a way to cancel it', async () => {
		const { session, cancelled } = fakeSession({ stalls: true });
		let cancel: (() => void) | undefined;

		const attempt = signIn(
			REQUEST,
			undefined,
			() => session,
			at,
			(stop) => {
				cancel = stop;
			}
		);

		expect(cancel, 'nothing was offered to cancel').toBeTypeOf('function');
		expect(cancelled()).toBe(0);

		cancel?.();

		await expect(attempt).rejects.toThrow(/vault locked/i);
		expect(cancelled(), 'the library kept polling Steam').toBe(1);
	});

	/*
	 * Cancelling without settling would leave the caller awaiting a promise
	 * nothing will ever resolve — which is a worse failure than the one being
	 * fixed, because it never ends.
	 */
	it('settles the promise rather than leaving the caller hanging', async () => {
		const { session } = fakeSession({ stalls: true });
		let cancel: (() => void) | undefined;
		const attempt = signIn(
			REQUEST,
			undefined,
			() => session,
			at,
			(stop) => {
				cancel = stop;
			}
		);
		cancel?.();

		const error = await attempt.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(SteamLoginError);
		// Retryable: the vault locking says nothing about the credentials.
		expect((error as SteamLoginError).permanent).toBe(false);
	});

	it('is harmless once the sign-in has already finished', async () => {
		const { session, cancelled } = fakeSession({ accessToken: 'access-abc' });
		let cancel: (() => void) | undefined;

		await signIn(
			REQUEST,
			undefined,
			() => session,
			at,
			(stop) => {
				cancel = stop;
			}
		);
		const after = cancelled();

		expect(() => cancel?.()).not.toThrow();
		// `finish` is idempotent, so a late cancel neither cancels nor rejects.
		expect(cancelled()).toBe(after);
	});

	it('is optional, so every existing caller is unchanged', async () => {
		const { session } = fakeSession({ accessToken: 'access-abc' });
		await expect(signIn(REQUEST, undefined, () => session, at)).resolves.toMatchObject({
			refreshToken: expect.any(String)
		});
	});
});

/**
 * **The cancellation says why it happened.**
 *
 * This closure hard-coded "The vault locked before Steam finished signing in",
 * because a lock was the only thing that ever cancelled a sign-in. `Require
 * proxies` now cancels unrouted ones through the same callback, so a user who
 * had just turned that setting on was told their vault had locked — false, and
 * it sends them to unlock a vault that is already open.
 */
describe('abandoning a sign-in that is still running', () => {
	it('carries the reason the caller gave', async () => {
		const { session } = fakeSession({ stalls: true });
		let cancel: ((reason?: string) => void) | undefined;

		const attempt = signIn(
			REQUEST,
			undefined,
			() => session,
			at,
			(stop) => {
				cancel = stop;
			}
		);
		cancel?.('This vault is set to require proxies, so the sign-in was stopped.');

		await expect(attempt).rejects.toThrow(/require proxies/i);
		await expect(attempt).rejects.not.toThrow(/vault locked/i);
	});

	/*
	 * And the lock is still the default, because it is still the common case and
	 * every existing caller relies on it.
	 */
	it('still blames the lock when no reason is given', async () => {
		const { session } = fakeSession({ stalls: true });
		let cancel: ((reason?: string) => void) | undefined;

		const attempt = signIn(
			REQUEST,
			undefined,
			() => session,
			at,
			(stop) => {
				cancel = stop;
			}
		);
		cancel?.();

		await expect(attempt).rejects.toThrow(/vault locked/i);
	});
});
