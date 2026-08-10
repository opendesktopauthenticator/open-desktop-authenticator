import http from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { EgressViolation, installEgressGuard } from '../src/egress';

/**
 * The fail-closed path gets its own file: the guard installs once per process,
 * and the other egress suite installs it non-strict.
 *
 * This is the check that actually prevents a leak — if a library insists on its
 * own agent, we cannot know it is proxied, so the request must not go out.
 */

const ours = new http.Agent();

describe('egress guard, strict mode', () => {
	beforeAll(() => {
		installEgressGuard({ http: ours, https: ours }, { strict: true });
	});

	it('refuses a request that supplied a foreign agent', () => {
		const foreign = new http.Agent();
		expect(() =>
			http.request({ hostname: '127.0.0.20', port: 1, path: '/', agent: foreign })
		).toThrow(EgressViolation);
	});

	it('names the host it refused, so the failure is actionable', () => {
		const foreign = new http.Agent();
		expect(() =>
			http.request({ hostname: 'steamcommunity.com', port: 443, path: '/', agent: foreign })
		).toThrow(/steamcommunity\.com/);
	});

	it('still allows a request carrying our own agent', () => {
		const req = http.request({ hostname: '127.0.0.21', port: 1, path: '/', agent: ours });
		req.on('error', () => {});
		req.destroy();
		// Reaching here without throwing is the assertion.
		expect(true).toBe(true);
	});

	it('adopts a bare request rather than refusing it', () => {
		const options: http.RequestOptions = { hostname: '127.0.0.22', port: 1, path: '/' };
		const req = http.request(options);
		req.on('error', () => {});
		req.destroy();
		expect(options.agent).toBe(ours);
	});
});
