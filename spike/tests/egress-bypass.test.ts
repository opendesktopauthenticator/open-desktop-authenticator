import http from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { egressRecords, installEgressGuard } from '../src/egress';

/**
 * Regression test for the HTTP-proxy recursion bug.
 *
 * An HTTP proxy agent establishes its tunnel by issuing its own request to the
 * proxy host. Before the bypass existed, the guard handed that request the proxy
 * agent again, which issued another request, until the stack overflowed —
 * `Maximum call stack size exceeded` on every HTTP-proxy login. SOCKS never hit
 * it because SocksProxyAgent opens a raw socket instead.
 *
 * Own file: the guard installs once per process and needs bypassHosts set.
 */

const proxyAgent = new http.Agent();

describe('proxy-leg bypass', () => {
	beforeAll(() => {
		installEgressGuard(
			{ http: proxyAgent, https: proxyAgent },
			{ bypassHosts: ['127.0.0.30'], strict: true }
		);
	});

	it('does NOT hand the proxy agent to a request aimed at the proxy itself', () => {
		const options: http.RequestOptions = { hostname: '127.0.0.30', port: 1, path: '/' };
		const req = http.request(options);
		req.on('error', () => {});
		req.destroy();

		// The whole bug: if this were proxyAgent, the agent would be connecting
		// through itself.
		expect(options.agent).not.toBe(proxyAgent);
		expect(options.agent).toBeInstanceOf(http.Agent);
	});

	it('marks the tunnel as a proxy leg, not as ordinary proxied traffic', () => {
		const record = egressRecords().find((r) => r.host === '127.0.0.30');
		expect(record?.proxyLeg).toBe(true);
		// Still counts as covered — it IS the proxy connection, so the audit must
		// not report it as a leak.
		expect(record?.proxied).toBe(true);
	});

	it('matches the bypass host case-insensitively', () => {
		// Hostnames are case-insensitive. `bypassHosts` comes from `URL.hostname`
		// (always lower-case) but a caller can pass `options.hostname` in any case —
		// a missed bypass means the proxy agent connects through itself, which is
		// the recursion this whole mechanism exists to prevent.
		const options: http.RequestOptions = {
			hostname: '127.0.0.30'.toUpperCase(),
			port: 1,
			path: '/'
		};
		expect(() => {
			const req = http.request(options);
			req.on('error', () => {});
			req.destroy();
		}).not.toThrow();
		expect(options.agent).not.toBe(proxyAgent);
	});

	it('still routes ordinary traffic through the proxy agent', () => {
		const options: http.RequestOptions = { hostname: 'api.steampowered.com', path: '/' };
		const req = http.request(options);
		req.on('error', () => {});
		req.destroy();

		expect(options.agent).toBe(proxyAgent);
		const record = egressRecords().find((r) => r.host === 'api.steampowered.com');
		expect(record?.proxied).toBe(true);
		expect(record?.proxyLeg).toBe(false);
	});
});
