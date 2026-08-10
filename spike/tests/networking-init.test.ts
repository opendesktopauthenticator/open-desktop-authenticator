import { afterEach, describe, expect, it } from 'vitest';
import { initNetworking, activeProxyConfig } from '../src/steam/session';

/**
 * Regression test for cross-account proxy bleed.
 *
 * `installEgressGuard` installs once per process and stays pinned to the agents
 * it was first given. Re-initialising with different routing used to leave the
 * guard pointing at the FIRST account's proxy while the transports used the
 * second's. The dangerous case is a second account with NO proxy: its transports
 * would be unproxied, but the guard would still inject the first account's agent
 * into every bare request — silently routing account B through account A's exit
 * IP and linking them, which is the precise outcome per-account routing exists to
 * prevent.
 *
 * Own file: initNetworking patches http/https globals, and vitest isolates test
 * files into separate workers.
 */

afterEach(() => {
	delete process.env.SPIKE_PROXY;
	delete process.env.SPIKE_PROXY_ACCTA;
	delete process.env.SPIKE_PROXY_ACCTB;
});

describe('initNetworking', () => {
	it('initialises once and reports the routing it locked onto', () => {
		const proxy = initNetworking('acctA', 'socks5h://first.example:1080');
		expect(proxy?.host).toBe('first.example');
		expect(activeProxyConfig()?.host).toBe('first.example');
	});

	it('is idempotent for identical routing', () => {
		expect(() => initNetworking('acctA', 'socks5h://first.example:1080')).not.toThrow();
		expect(activeProxyConfig()?.host).toBe('first.example');
	});

	it('refuses a different proxy rather than leaving the guard mispointed', () => {
		expect(() => initNetworking('acctB', 'socks5h://second.example:1080')).toThrow(
			/already initialised for different routing/
		);
	});

	it('refuses an unproxied account, which would otherwise inherit the first proxy', () => {
		// The worst case: no proxy configured, so the transports are direct, but the
		// installed guard would still force account A's agent onto every request.
		expect(() => initNetworking('acctB', undefined)).toThrow(
			/already initialised for different routing/
		);
	});

	it('leaves the original routing untouched after a refused call', () => {
		expect(activeProxyConfig()?.host).toBe('first.example');
	});
});
