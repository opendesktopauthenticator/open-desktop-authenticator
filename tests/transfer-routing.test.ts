import { describe, expect, it, vi } from 'vitest';
import { TransferService } from '../src/main/steam/transfer';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';

/*
 * Every request a transfer makes has to leave by the account's proxy.
 *
 * This is the leak that matters most in the whole feature. A transfer signs in
 * with a password and then asks Steam to rotate an authenticator — if any one of
 * those requests goes out over the machine's own address, it ties the account to
 * the person running the app, permanently and invisibly. The proxy either covers
 * all of it or it is decoration.
 *
 * The transport layer already refuses to send an unrouted request for an account
 * that is configured to route. What these tests check is the layer above it: that
 * this feature actually *hands* the route down, at every step, rather than
 * quietly building an unrouted transport that the checks below would then have
 * no reason to complain about.
 */

const STEAM_ID = '76561198000000001';
const PROXY = 'socks5://someone:secret@proxy.example:1080';
const TOKEN = 'eyJhbGciOiJub25lIn0.eyJhdWQiOlsibW9iaWxlIl0sImV4cCI6MjAwMDAwMDAwMH0.';

const REPLACEMENT = {
	sharedSecret: 'c2hhcmVk',
	identitySecret: 'aWRlbnRpdHk=',
	revocationCode: 'R55555',
	serverTime: '1700000000',
	steamId64: STEAM_ID
};

function harness(): {
	service: TransferService;
	signInProxies: (string | undefined)[];
	transportRequests: { steamId64: string; proxyUrl?: string }[];
} {
	const signInProxies: (string | undefined)[] = [];
	const transportRequests: { steamId64: string; proxyUrl?: string }[] = [];

	// One array, read and written. Two would make the read-back check fail for a
	// reason that has nothing to do with routing — as the first version did.
	const accounts: unknown[] = [];
	const vault = {
		read: () => ({ accounts }),
		mutate: (change: (draft: { accounts: unknown[] }) => void) => {
			change({ accounts });
			return Promise.resolve();
		}
	} as unknown as VaultService;

	const transports = {
		forAccount: (account: { steamId64: string; proxyUrl?: string }) => {
			transportRequests.push(account);
			return Promise.resolve(vi.fn());
		}
	} as unknown as SteamTransportFactory;

	const service = new TransferService(vault, transports, () => 0, {
		now: () => 1_700_000_000_000,
		signIn: ((_request: unknown, proxyUrl: string | undefined) => {
			signInProxies.push(proxyUrl);
			return Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID });
		}) as never,
		mintAccessToken: (() => Promise.resolve('access')) as never,
		startChallenge: (() => Promise.resolve({ sent: true, shape: 'protobuf' })) as never,
		continueChallenge: (() =>
			Promise.resolve({ success: true, replacementToken: REPLACEMENT })) as never,
		writeRecovery: () => undefined
	});

	return { service, signInProxies, transportRequests };
}

describe('a transfer for a routed account', () => {
	it('signs in through the proxy', async () => {
		const h = harness();
		await h.service.authenticate('someone', 'pw', 'QK4TX', PROXY);
		expect(h.signInProxies).toEqual([PROXY]);
	});

	it('asks Steam for the code through the proxy', async () => {
		const h = harness();
		await h.service.authenticate('someone', 'pw', 'QK4TX', PROXY);
		await h.service.startChallenge();
		expect(h.transportRequests.at(-1)).toEqual({ steamId64: STEAM_ID, proxyUrl: PROXY });
	});

	it('submits the code through the proxy', async () => {
		const h = harness();
		await h.service.authenticate('someone', 'pw', 'QK4TX', PROXY);
		await h.service.completeTransfer('12345');
		expect(h.transportRequests.at(-1)).toEqual({ steamId64: STEAM_ID, proxyUrl: PROXY });
	});

	/*
	 * Every one of them, not merely the last. A flow that routes two calls out of
	 * three leaks on the third, and the two that behaved prove nothing.
	 */
	it('routes every request it makes, without exception', async () => {
		const h = harness();
		await h.service.authenticate('someone', 'pw', 'QK4TX', PROXY);
		await h.service.startChallenge();
		await h.service.completeTransfer('12345');

		expect(h.signInProxies.every((p) => p === PROXY)).toBe(true);
		expect(h.transportRequests.length).toBeGreaterThan(0);
		expect(h.transportRequests.every((r) => r.proxyUrl === PROXY)).toBe(true);
	});

	/*
	 * The route is captured at sign-in and carried, rather than read again later.
	 * Re-reading it would mean a transfer could start on one route and finish on
	 * another, which Steam sees as two different clients — and which would put the
	 * irreversible call on whichever route happened to be configured by then.
	 */
	it('carries the same route across the whole transfer', async () => {
		const h = harness();
		await h.service.authenticate('someone', 'pw', 'QK4TX', PROXY);
		await h.service.startChallenge();
		await h.service.completeTransfer('12345');

		const routes = new Set(h.transportRequests.map((r) => r.proxyUrl));
		expect(routes.size).toBe(1);
	});

	it('stores the account with the proxy it was transferred over', async () => {
		const stored: { proxyUrl?: string }[] = [];
		const vault = {
			read: () => ({ accounts: stored }),
			mutate: (change: (draft: { accounts: unknown[] }) => void) => {
				change({ accounts: stored });
				return Promise.resolve();
			}
		} as unknown as VaultService;
		const transports = {
			forAccount: () => Promise.resolve(vi.fn())
		} as unknown as SteamTransportFactory;
		const service = new TransferService(vault, transports, () => 0, {
			now: () => 1_700_000_000_000,
			signIn: (() => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID })) as never,
			mintAccessToken: (() => Promise.resolve('access')) as never,
			continueChallenge: (() =>
				Promise.resolve({ success: true, replacementToken: REPLACEMENT })) as never,
			writeRecovery: () => undefined
		});

		await service.authenticate('someone', 'pw', 'QK4TX', PROXY);
		await service.completeTransfer('12345');
		// Otherwise the account would be transferred over the proxy and then used
		// without one, which is the same leak arriving a minute later.
		expect(stored[0]?.proxyUrl).toBe(PROXY);
	});
});

describe('a transfer for an unrouted account', () => {
	it('passes no proxy rather than an empty one', async () => {
		const h = harness();
		await h.service.authenticate('someone', 'pw', 'QK4TX');
		await h.service.startChallenge();
		expect(h.signInProxies).toEqual([undefined]);
		expect(h.transportRequests.at(-1)?.proxyUrl).toBeUndefined();
	});
});
