import { describe, expect, it, vi } from 'vitest';
import {
	PLATFORM_MOBILE_APP,
	signIn,
	SteamLoginError,
	type LoginSessionLike
} from '../src/main/steam/login';
import { steamSessionProxy } from '../src/main/net/egress';
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
		const { session } = fakeSession({});
		await expect(
			signIn(
				{ accountName: 'someone', password: 'pw', unixSeconds: 1 },
				undefined,
				() => session,
				at
			)
		).rejects.toThrow(/secret or a Steam Guard code/);
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

		await signIn(REQUEST, 'socks5://user:pass@10.0.0.1:1080', factory, at);

		expect(factory).toHaveBeenCalledWith('socks5://user:pass@10.0.0.1:1080');
	});

	it('passes no proxy for an account that is not routed', async () => {
		const factory = vi.fn(() => fakeSession().session);

		await signIn(REQUEST, undefined, factory, at);

		expect(factory).toHaveBeenCalledWith(undefined);
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
	it('keeps credentials, which the library authenticates with itself', () => {
		expect(steamSessionProxy('http://user:pa55@1.2.3.4:8080')).toEqual({
			httpProxy: 'http://user:pa55@1.2.3.4:8080'
		});
	});

	it('routes SOCKS through socksProxy, never httpProxy — in the remote-DNS spelling', () => {
		// `socks5h`, not `socks5`. socks-proxy-agent reads `socks5` as *resolve
		// the hostname locally*, so the plain spelling had every sign-in look
		// Steam's hostnames up on the user's own resolver — at the exact moments
		// an account was being tied to a route. Chromium's half of the app already
		// resolves at the proxy for `socks5`; this makes the Node half agree.
		expect(steamSessionProxy('socks5://user:pa55@1.2.3.4:1080')).toEqual({
			socksProxy: 'socks5h://user:pa55@1.2.3.4:1080'
		});
	});

	it('never downgrades an explicit remote-DNS spelling', () => {
		// The old normalisation rewrote socks5h to socks5 — turning the one
		// spelling a user chooses *specifically for remote DNS* into the local
		// one, silently.
		expect(steamSessionProxy('socks5h://1.2.3.4:1080')).toEqual({
			socksProxy: 'socks5h://1.2.3.4:1080'
		});
		expect(steamSessionProxy('socks4a://1.2.3.4:1080')).toEqual({
			socksProxy: 'socks4a://1.2.3.4:1080'
		});
	});

	it('produces URLs the real agent reads as remote-DNS', async () => {
		// Against the library itself, not our reading of its documentation:
		// `shouldLookup === false` is socks-proxy-agent's own flag for "send the
		// hostname to the proxy". If a future version changes its scheme table,
		// this is the test that notices.
		const { SocksProxyAgent } = await import('socks-proxy-agent');
		for (const stored of ['socks5://1.2.3.4:1080', 'socks5h://1.2.3.4:1080']) {
			const options = steamSessionProxy(stored);
			if (!('socksProxy' in options)) {
				throw new Error('expected a socksProxy');
			}
			const agent = new SocksProxyAgent(options.socksProxy) as unknown as {
				shouldLookup: boolean;
			};
			expect(agent.shouldLookup).toBe(false);
		}
	});

	it('refuses anything planProxy would refuse, so the two cannot disagree', () => {
		expect(() => steamSessionProxy('ftp://1.2.3.4:21')).toThrow();
		expect(() => steamSessionProxy('not a url')).toThrow();
	});

	it('always returns exactly one of the two option keys', () => {
		// The invariant `createLoginSession` asserts before handing the object to
		// the library. `steam-session` ignores an unrecognised key in silence and
		// connects direct, and there is no way to ask it afterwards — so returning
		// `{}` or a misspelled key here would be an undetectable anonymity leak.
		for (const url of [
			'http://1.2.3.4:8080',
			'https://1.2.3.4:8443',
			'socks5://1.2.3.4:1080',
			'socks5h://1.2.3.4:1080',
			'socks4://1.2.3.4:1080'
		]) {
			const keys = Object.keys(steamSessionProxy(url));
			expect(keys, url).toHaveLength(1);
			expect(['httpProxy', 'socksProxy'], url).toContain(keys[0]);
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
		expect(steamSessionProxy('socks5://proxy.example')).toEqual({
			socksProxy: 'socks5h://proxy.example:1080'
		});
		expect(steamSessionProxy('socks4://proxy.example')).toEqual({
			socksProxy: 'socks4://proxy.example:1080'
		});
	});

	it('produces a URL the real agent reads as a usable port', async () => {
		const { SocksProxyAgent } = await import('socks-proxy-agent');
		for (const stored of ['socks5://proxy.example', 'socks5h://proxy.example']) {
			const options = steamSessionProxy(stored);
			if (!('socksProxy' in options)) {
				throw new Error('expected a socksProxy');
			}
			const agent = new SocksProxyAgent(options.socksProxy) as unknown as {
				proxy: { port: number };
			};
			expect(Number.isFinite(agent.proxy.port)).toBe(true);
			expect(agent.proxy.port).toBe(1080);
		}
	});

	it('keeps credentials, including a password containing @', () => {
		expect(steamSessionProxy('socks5://user:pa55%40word@1.2.3.4:1080')).toEqual({
			socksProxy: 'socks5h://user:pa55%40word@1.2.3.4:1080'
		});
	});
});
