import { describe, expect, it, vi } from 'vitest';
import { queryTimeOffset, SteamTimeError } from '../src/main/steam/time';
import { SteamClock } from '../src/main/steam/clock';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';
import type { CodeService } from '../src/main/codes/service';
import type { VaultService } from '../src/main/vault/service';
import type { SteamTransportFactory } from '../src/main/net/transport';

/**
 * Steam clock sync (§12 F4 / F5).
 *
 * The failure mode this protects against is silent: a skewed machine produces
 * codes Steam rejects, and without a real QueryTime (routed through the
 * transport, never via bare https) the UI has no way to tell the user why.
 */

const NOW = Date.parse('2026-08-10T12:00:00Z');

function transportReturning(reply: SteamResponse): {
	transport: (request: SteamRequest) => Promise<SteamResponse>;
	sent: SteamRequest[];
} {
	const sent: SteamRequest[] = [];
	return {
		sent,
		transport: (request) => {
			sent.push(request);
			return Promise.resolve(reply);
		}
	};
}

describe('queryTimeOffset', () => {
	it('returns server_time minus local unix seconds', async () => {
		const localSeconds = Math.floor(NOW / 1000);
		const { transport, sent } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { server_time: String(localSeconds + 42) } })
		});

		await expect(queryTimeOffset(transport, () => NOW)).resolves.toBe(42);
		expect(sent[0]?.method).toBe('POST');
		expect(sent[0]?.url).toContain('ITwoFactorService/QueryTime');
		expect(sent[0]?.cookie).toBe('');
	});

	it('accepts a numeric server_time', async () => {
		const localSeconds = Math.floor(NOW / 1000);
		const { transport } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { server_time: localSeconds - 7 } })
		});
		await expect(queryTimeOffset(transport, () => NOW)).resolves.toBe(-7);
	});

	it('refuses a non-200 without inventing an offset', async () => {
		const { transport } = transportReturning({ status: 503, text: '' });
		await expect(queryTimeOffset(transport, () => NOW)).rejects.toBeInstanceOf(SteamTimeError);
	});

	it('refuses a malformed body', async () => {
		const { transport } = transportReturning({ status: 200, text: '<html>' });
		await expect(queryTimeOffset(transport, () => NOW)).rejects.toBeInstanceOf(SteamTimeError);
	});
});

describe('SteamClock', () => {
	it('applies a successful offset and marks the clock verified', async () => {
		const setTimeOffset = vi.fn();
		const codes = {
			clockUnverified: () => true,
			clockStale: () => true,
			setTimeOffset
		} as unknown as CodeService;
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts: [{ steamId64: '76561198000000001' }] })
		} as unknown as VaultService;

		const localSeconds = Math.floor(NOW / 1000);
		const transport = vi.fn(() =>
			Promise.resolve({
				status: 200,
				text: JSON.stringify({ response: { server_time: localSeconds + 15 } })
			})
		);
		const forget = vi.fn();
		const transports = {
			forAccount: vi.fn(() => Promise.resolve(transport)),
			forget
		} as unknown as SteamTransportFactory;

		const clock = new SteamClock({ codes, vault, transports, now: () => NOW });
		await clock.ensureSynced();

		expect(setTimeOffset).toHaveBeenCalledWith(15);
		expect(forget).not.toHaveBeenCalled();
	});

	it('does not call setTimeOffset when QueryTime fails', async () => {
		const setTimeOffset = vi.fn();
		const codes = {
			clockUnverified: () => true,
			clockStale: () => true,
			setTimeOffset
		} as unknown as CodeService;
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts: [] })
		} as unknown as VaultService;
		// Held in its own binding rather than read back off the object: asserting on
		// `transports.forget` detaches the method from its receiver, which is what
		// `unbound-method` is warning about.
		const forget = vi.fn();
		const transports = {
			forAccount: vi.fn(() => Promise.resolve(() => Promise.resolve({ status: 500, text: '' }))),
			forget
		} as unknown as SteamTransportFactory;

		const clock = new SteamClock({ codes, vault, transports, now: () => NOW });
		await clock.ensureSynced();

		expect(setTimeOffset).not.toHaveBeenCalled();
		// Synthetic partition cleaned up when no account was borrowed.
		expect(forget).toHaveBeenCalledWith('steam-clock-sync');
	});

	it('is a no-op while the offset is still fresh', async () => {
		const forAccount = vi.fn();
		const clock = new SteamClock({
			codes: {
				clockUnverified: () => false,
				clockStale: () => false,
				setTimeOffset: vi.fn()
			} as unknown as CodeService,
			vault: { isUnlocked: () => true, read: () => ({ accounts: [] }) } as unknown as VaultService,
			transports: { forAccount, forget: vi.fn() } as unknown as SteamTransportFactory,
			now: () => NOW
		});

		await clock.ensureSynced();
		expect(forAccount).not.toHaveBeenCalled();
	});

	it('coalesces concurrent ensureSynced calls into one QueryTime', async () => {
		const setTimeOffset = vi.fn();
		const codes = {
			clockUnverified: () => true,
			clockStale: () => true,
			setTimeOffset
		} as unknown as CodeService;
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts: [{ steamId64: '76561198000000001' }] })
		} as unknown as VaultService;

		let resolveTransport!: (value: SteamResponse) => void;
		const pending = new Promise<SteamResponse>((resolve) => {
			resolveTransport = resolve;
		});
		const transport = vi.fn(() => pending);
		const forAccount = vi.fn(() => Promise.resolve(transport));
		const transports = { forAccount, forget: vi.fn() } as unknown as SteamTransportFactory;

		const clock = new SteamClock({ codes, vault, transports, now: () => NOW });
		const a = clock.ensureSynced();
		const b = clock.ensureSynced();
		expect(forAccount).toHaveBeenCalledTimes(1);

		const localSeconds = Math.floor(NOW / 1000);
		resolveTransport({
			status: 200,
			text: JSON.stringify({ response: { server_time: localSeconds } })
		});
		await Promise.all([a, b]);
		expect(setTimeOffset).toHaveBeenCalledTimes(1);
	});
});

/*
 * *When* local time is read, which is the whole correctness of the offset.
 *
 * `steam-totp` calls `exports.time()` inside its `res.on('end')` handler — after
 * the body has arrived. This module used to take a `nowMs: number`, and an
 * argument is evaluated before the call, so local time was captured before the
 * request even went out and the offset absorbed the entire round trip. Steam
 * time then ran *ahead* by however long the request took, worst on exactly the
 * slow proxies this application encourages people to route through.
 */
describe('the offset is measured against the clock at the moment the reply is read', () => {
	it('does not count the round trip as skew', async () => {
		const localSeconds = 1_700_000_000;
		// Identical clocks, and a slow route. Steam stamps its reply 4s after the
		// request left; this machine reads it 8s after sending.
		const { transport } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { server_time: String(localSeconds + 4) } })
		});

		// Sampled with the reply in hand, Steam is 4s behind this machine: -4.
		// Sampled before the request went out, the same exchange reads as +4. The 8
		// seconds between those answers is a quarter of a code window, handed over
		// for nothing but a slow connection.
		await expect(queryTimeOffset(transport, () => (localSeconds + 8) * 1000)).resolves.toBe(-4);
	});

	it('reads the clock after the request, never before it', async () => {
		// The ordering *is* the fix, so it is asserted directly rather than inferred
		// from an arithmetic result that a stopped clock would also produce.
		const order: string[] = [];
		const { transport } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { server_time: String(Math.floor(NOW / 1000)) } })
		});
		const logged = async (request: SteamRequest): Promise<SteamResponse> => {
			order.push('request');
			return transport(request);
		};

		await queryTimeOffset(logged, () => {
			order.push('clock');
			return NOW;
		});

		expect(order).toEqual(['request', 'clock']);
	});

	it('reads the clock exactly once, after the request', async () => {
		const clock = vi.fn(() => NOW);
		const { transport } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { server_time: String(Math.floor(NOW / 1000)) } })
		});

		await queryTimeOffset(transport, clock);

		expect(clock).toHaveBeenCalledTimes(1);
	});

	it('never reads the clock when the request fails', async () => {
		// Nothing to measure against, so nothing should be measured.
		const clock = vi.fn(() => NOW);
		const { transport } = transportReturning({ status: 500, text: '' });

		await expect(queryTimeOffset(transport, clock)).rejects.toBeInstanceOf(SteamTimeError);
		expect(clock).not.toHaveBeenCalled();
	});
});

/*
 * That one good reading is not trusted forever.
 *
 * `offsetVerified` is only ever set true, and `ensureSynced` used to gate on it
 * — so the first success was the last measurement the process would ever take.
 * This app lives in a tray for days. An NTP correction, a resume from sleep, a
 * VM clock jump or somebody fixing their time zone all move the local clock
 * afterwards, and the offset measured against the old one kept being added to
 * the new one. A user who corrected their clock *to fix their codes* made them
 * wrong by exactly the amount they corrected.
 */
describe('a stale offset is measured again', () => {
	const codesWith = (
		stale: boolean
	): { codes: CodeService; setTimeOffset: ReturnType<typeof vi.fn> } => {
		const setTimeOffset = vi.fn();
		return {
			setTimeOffset,
			codes: {
				clockUnverified: () => false,
				clockStale: () => stale,
				setTimeOffset
			} as unknown as CodeService
		};
	};

	const clockFor = (codes: CodeService, forAccount: ReturnType<typeof vi.fn>): SteamClock =>
		new SteamClock({
			codes,
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts: [{ steamId64: '76561198000000001' }] })
			} as unknown as VaultService,
			transports: { forAccount, forget: vi.fn() } as unknown as SteamTransportFactory,
			now: () => NOW
		});

	it('asks Steam again once the offset has gone stale', async () => {
		const { transport } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { server_time: String(Math.floor(NOW / 1000) + 3) } })
		});
		const forAccount = vi.fn(() => Promise.resolve(transport));
		const { codes, setTimeOffset } = codesWith(true);

		await clockFor(codes, forAccount).ensureSynced();

		// Verified but stale is exactly the state the old gate could not express.
		expect(forAccount).toHaveBeenCalledTimes(1);
		expect(setTimeOffset).toHaveBeenCalledWith(3);
	});

	it('does not ask while the offset is still fresh', async () => {
		const forAccount = vi.fn();
		const { codes } = codesWith(false);

		await clockFor(codes, forAccount).ensureSynced();

		expect(forAccount).not.toHaveBeenCalled();
	});
});

/*
 * A failed sync must not retry once per second.
 *
 * The renderer polls `listCodes` every second, and every poll calls
 * `ensureSynced`. `inFlight` was cleared the moment an attempt settled, so a
 * fast failure — a dead proxy, a 503 — was retried on every tick: sixty
 * identical requests a minute, indefinitely, from an application whose posture
 * is not drawing attention to its accounts.
 */
describe('failure cooldown', () => {
	function failingHarness(
		now: () => number,
		monotonic: () => number = now
	): {
		clock: SteamClock;
		attempts: () => number;
	} {
		let attempts = 0;
		const codes = {
			clockUnverified: () => true,
			clockStale: () => true,
			setTimeOffset: vi.fn()
		} as unknown as CodeService;
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts: [] })
		} as unknown as VaultService;
		const transports = {
			forAccount: () =>
				Promise.resolve(() => {
					attempts += 1;
					return Promise.resolve({ status: 503, text: '' });
				}),
			forget: vi.fn()
		} as unknown as SteamTransportFactory;
		return {
			clock: new SteamClock({ codes, vault, transports, now, monotonic }),
			attempts: () => attempts
		};
	}

	it('does not ask again within the cooldown', async () => {
		let at = 0;
		const { clock, attempts } = failingHarness(() => at);

		await clock.ensureSynced();
		expect(attempts()).toBe(1);

		// The next three seconds of polling.
		for (at = 1000; at <= 3000; at += 1000) {
			await clock.ensureSynced();
		}
		expect(attempts()).toBe(1);
	});

	it('tries again once the cooldown has passed', async () => {
		let at = 0;
		const { clock, attempts } = failingHarness(() => at);

		await clock.ensureSynced();
		at = 61_000;
		await clock.ensureSynced();
		expect(attempts()).toBe(2);
	});

	it('retries by elapsed time when the wall clock moves backward', async () => {
		let wall = 10_000_000;
		let elapsed = 0;
		const { clock, attempts } = failingHarness(
			() => wall,
			() => elapsed
		);

		await clock.ensureSynced();
		expect(attempts()).toBe(1);

		wall -= 60 * 60_000;
		elapsed = 59_999;
		await clock.ensureSynced();
		expect(attempts()).toBe(1);

		elapsed = 60_001;
		await clock.ensureSynced();
		expect(attempts()).toBe(2);
	});
});

/*
 * One dead proxy must not monopolise the clock sync.
 *
 * The borrowed route was always `.find()`'s first routed account, so a dead
 * proxy there meant the second — perfectly healthy — route was never tried,
 * and every account stayed clock-unverified behind a proxy that was not even
 * theirs.
 */
describe('route rotation on failure', () => {
	it('borrows a different routed account after a failure', async () => {
		let at = 0;
		const calls: string[] = [];
		const setTimeOffset = vi.fn();
		const codes = {
			clockUnverified: () => true,
			clockStale: () => !setTimeOffset.mock.calls.length,
			setTimeOffset
		} as unknown as CodeService;
		const vault = {
			isUnlocked: () => true,
			read: () => ({
				accounts: [
					{ steamId64: '76561198000000001', proxyUrl: 'socks5://dead:1080' },
					{ steamId64: '76561198000000002', proxyUrl: 'socks5://alive:1080' }
				]
			})
		} as unknown as VaultService;
		const transports = {
			forAccount: (account: { steamId64: string }) => {
				calls.push(account.steamId64);
				if (account.steamId64 === '76561198000000001') {
					return Promise.reject(new Error('proxy is dead'));
				}
				return Promise.resolve(() =>
					Promise.resolve({
						status: 200,
						text: JSON.stringify({ response: { server_time: 1_700_000_000 } })
					})
				);
			},
			forget: vi.fn()
		} as unknown as SteamTransportFactory;

		const clock = new SteamClock({
			codes,
			vault,
			transports,
			now: () => at,
			monotonic: () => at
		});

		await clock.ensureSynced();
		expect(calls).toEqual(['76561198000000001']);

		at = 61_000;
		await clock.ensureSynced();
		expect(calls).toEqual(['76561198000000001', '76561198000000002']);
		expect(setTimeOffset).toHaveBeenCalled();
	});
});
