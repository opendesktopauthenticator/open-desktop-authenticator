import http from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { EgressViolation, egressRecords, egressTotals, installEgressGuard } from '../src/egress';

/**
 * This file patches http/https globals, so it lives on its own — vitest isolates
 * test files into separate workers, which keeps the patching from leaking into
 * the other suites.
 *
 * Requests here target 127.0.0.1:1 (nothing listens there). We only care that
 * the guard saw and rewrote the request, not that it connected.
 */

// A real agent, so identity comparisons are meaningful, but it never reaches a
// network we care about.
const agent = new http.Agent();

function fireAndForget(options: http.RequestOptions): void {
	const req = http.request(options);
	req.on('error', () => {
		/* connection refused is expected and irrelevant */
	});
	req.destroy();
}

describe('egress guard', () => {
	beforeAll(() => {
		installEgressGuard({ http: agent, https: agent }, { strict: false });
	});

	it('injects our agent into a bare request that specified none', () => {
		// This is exactly the shape steam-totp.getTimeOffset() uses: an options
		// object with no `agent` key. There is no library API to proxy it.
		const options: http.RequestOptions = {
			hostname: '127.0.0.1',
			port: 1,
			path: '/ITwoFactorService/QueryTime/v1/',
			method: 'POST'
		};
		fireAndForget(options);

		expect(options.agent).toBe(agent);

		const record = egressRecords().find((r) => r.host === '127.0.0.1');
		expect(record).toBeDefined();
		expect(record?.proxied).toBe(true);
	});

	it('records a request that insisted on a different agent as unproxied', () => {
		const foreign = new http.Agent();
		fireAndForget({ hostname: '127.0.0.2', port: 1, path: '/', agent: foreign });

		const record = egressRecords().find((r) => r.host === '127.0.0.2');
		expect(record?.proxied).toBe(false);
		expect(record?.foreignAgent).toBe(true);
	});

	it('handles the request(url, callback) signature without losing the callback', () => {
		const req = http.request('http://127.0.0.3:1/path', () => {
			/* never called */
		});
		req.on('error', () => {});
		req.destroy();

		expect(egressRecords().some((r) => r.host === '127.0.0.3')).toBe(true);
	});

	it('files a host under one key regardless of call signature', () => {
		// `new URL(...).host` carries the port, `options.hostname` does not. If
		// these disagree the audit splits one server across two rows and can show
		// it as both proxied and direct.
		const a = http.request('http://127.0.0.9:1/x');
		a.on('error', () => {});
		a.destroy();
		const b = http.request({ hostname: '127.0.0.9', port: 1, path: '/x' });
		b.on('error', () => {});
		b.destroy();
		const c = http.request({ host: '127.0.0.9:1', path: '/x' });
		c.on('error', () => {});
		c.destroy();

		const keys = new Set(
			egressRecords()
				.filter((r) => r.host.startsWith('127.0.0.9'))
				.map((r) => r.host)
		);
		expect([...keys]).toEqual(['127.0.0.9']);
	});

	it('caps detail records but keeps exact totals', () => {
		// A Phase 1 auto-confirm poller runs for days at ~1 request per 15s.
		// Unbounded detail would be a slow leak; the totals must stay exact anyway.
		const before = egressTotals().get('127.0.0.50')?.total ?? 0;
		for (let i = 0; i < 1500; i++) {
			const req = http.request({ hostname: '127.0.0.50', port: 1, path: '/' });
			req.on('error', () => {});
			req.destroy();
		}
		expect(egressTotals().get('127.0.0.50')?.total).toBe(before + 1500);
		expect(egressRecords().length).toBeLessThanOrEqual(1000);
	});

	it('is idempotent — installing twice does not double-wrap', () => {
		// Counted via totals, not the capped detail list: once the cap is reached
		// records.length stops growing, which would make this order-dependent.
		const before = egressTotals().get('127.0.0.4')?.total ?? 0;
		installEgressGuard({ http: agent, https: agent }, { strict: false });
		fireAndForget({ hostname: '127.0.0.4', port: 1, path: '/' });
		// One request, one count. Double-wrapping would record it twice.
		expect(egressTotals().get('127.0.0.4')?.total).toBe(before + 1);
	});
});

describe('EgressViolation', () => {
	it('is thrown by name so callers can distinguish it', () => {
		const err = new EgressViolation('test');
		expect(err.name).toBe('EgressViolation');
		expect(err).toBeInstanceOf(Error);
	});
});
