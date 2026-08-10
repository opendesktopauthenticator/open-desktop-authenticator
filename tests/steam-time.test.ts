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

		await expect(queryTimeOffset(transport, NOW)).resolves.toBe(42);
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
		await expect(queryTimeOffset(transport, NOW)).resolves.toBe(-7);
	});

	it('refuses a non-200 without inventing an offset', async () => {
		const { transport } = transportReturning({ status: 503, text: '' });
		await expect(queryTimeOffset(transport, NOW)).rejects.toBeInstanceOf(SteamTimeError);
	});

	it('refuses a malformed body', async () => {
		const { transport } = transportReturning({ status: 200, text: '<html>' });
		await expect(queryTimeOffset(transport, NOW)).rejects.toBeInstanceOf(SteamTimeError);
	});
});

describe('SteamClock', () => {
	it('applies a successful offset and marks the clock verified', async () => {
		const setTimeOffset = vi.fn();
		const codes = {
			clockUnverified: () => true,
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

	it('is a no-op once the clock is already verified', async () => {
		const forAccount = vi.fn();
		const clock = new SteamClock({
			codes: {
				clockUnverified: () => false,
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
