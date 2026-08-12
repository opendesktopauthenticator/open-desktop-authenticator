import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The ticket service.
 *
 * It is the only thing on the domain that executes anything, so it is the only
 * thing on the domain that can be attacked. These tests cover the decisions
 * that make it safe rather than the plumbing that makes it work: what it
 * refuses to store, who it will accept a form from, and whether an
 * administrator can be reached without the passphrase.
 */

// Typed through tickets/server.d.mts rather than imported as `any`: a test
// suite that cannot be type-checked is the wrong place to be relaxed about it.
let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });

beforeAll(async () => {
	process.env.TICKETS_DB = ':memory:';
	// The module starts a listener on import; tests exercise the handlers.
	process.env.TICKETS_NO_LISTEN = '1';
	service = await import('../tickets/server.mjs');
});

afterAll(() => {
	service?.server?.close?.();
});

describe('what a report may contain', () => {
	const good = {
		kind: 'clone-site',
		summary: 'Found a fake SDA download in an advert',
		detail:
			'A sponsored result for a Steam authenticator download served an installer that was not on the project repository.'
	};

	it('accepts an ordinary report', () => {
		expect(service.validate(good).errors).toEqual([]);
	});

	it('rejects a kind it does not offer', () => {
		// The kind reaches a database column and a rendered label, so it is an
		// allowlist rather than a suggestion.
		expect(service.validate({ ...good, kind: 'anything' }).errors[0]).toMatch(/kind/i);
	});

	it.each([
		['a shared secret', '"shared_secret": "abc123deadbeef=="'],
		['an identity secret', 'identity_secret = wOkX2Lm9'],
		['a revocation code', 'my revocation code is R12345 if that helps'],
		['a private key', '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'],
		['a whole maFile', '{"steamid":"76561190000000001","account_name":"someone"}']
	])('refuses a report containing %s', (_what, poison) => {
		// **The most important behaviour in this service.** People paste secrets
		// into support forms in a panic, believing it helps. Storing one would
		// make this database worth stealing, and would mean collecting the exact
		// thing the product exists to stop people handing over. It is refused
		// before anything is written, and the error says so.
		const { errors } = service.validate({ ...good, detail: `${good.detail} ${poison}` });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.join(' ')).toMatch(/has not been saved/i);
	});

	it('enforces length bounds at both ends', () => {
		expect(service.validate({ ...good, summary: 'short' }).errors[0]).toMatch(/at least/);
		expect(service.validate({ ...good, detail: 'x'.repeat(4001) }).errors[0]).toMatch(/under/);
	});
});

describe('where a submission may come from', () => {
	const from = (headers: Record<string, string>) => service.originOk({ headers });

	it('accepts a form posted from the site', () => {
		expect(from({ origin: 'https://opendesktopauthenticator.com' })).toBe(true);
	});

	it('refuses another site posting to us', () => {
		expect(from({ origin: 'https://evil.example' })).toBe(false);
	});

	it('refuses a request with no origin at all', () => {
		// A browser always sends one on a form post. Its absence is a script.
		expect(from({})).toBe(false);
	});

	it('is not fooled by a lookalike hostname', () => {
		expect(from({ origin: 'https://opendesktopauthenticator.com.evil.example' })).toBe(false);
		expect(from({ origin: 'https://notopendesktopauthenticator.com' })).toBe(false);
	});
});

describe('references', () => {
	it('avoids characters that are ambiguous when read aloud', () => {
		// Somebody reads this down a phone or copies it off a screenshot. No O/0,
		// no I/1/l, no S/5 — the same reasoning Steam applies to its own codes.
		for (let i = 0; i < 200; i++) {
			expect(service.makeReference()).toMatch(
				/^ODA-[23456789BCDFGHJKMNPQRTVWXY]{4}-[23456789BCDFGHJKMNPQRTVWXY]{4}$/
			);
		}
	});

	it('does not repeat', () => {
		const seen = new Set(Array.from({ length: 500 }, () => service.makeReference()));
		expect(seen.size).toBe(500);
	});
});

describe('rate limiting', () => {
	it('allows a burst then refuses', () => {
		const key = `test-${Math.random()}`;
		const results = Array.from({ length: 7 }, () => service.tooMany(key, 5, 60_000));
		expect(results.slice(0, 5)).toEqual([false, false, false, false, false]);
		expect(results.slice(5)).toEqual([true, true]);
	});

	it('counts each address separately', () => {
		const a = `a-${Math.random()}`;
		const b = `b-${Math.random()}`;
		for (let i = 0; i < 6; i++) service.tooMany(a, 5, 60_000);
		expect(service.tooMany(a, 5, 60_000)).toBe(true);
		expect(service.tooMany(b, 5, 60_000)).toBe(false);
	});
});

describe('the admin view', () => {
	const request = (over = {}) => ({ method: 'GET', headers: {}, socket: {}, ...over });

	it('shows a sign-in form rather than tickets when there is no session', async () => {
		const chunks: string[] = [];
		const response = {
			headersSent: false,
			writeHead() {
				return this;
			},
			end(body: string) {
				chunks.push(body ?? '');
			}
		};
		await service.handleAdmin(request(), response, new URL('https://x/admin'));
		const html = chunks.join('');
		expect(html).toMatch(/Sign in/);
		// The list must not leak past the sign-in form.
		expect(html).not.toMatch(/Reports<\/h1>/);
	});

	it('refuses bootstrap without the token', async () => {
		let status = 0;
		const response = {
			headersSent: false,
			writeHead(code: number) {
				status = code;
				return this;
			},
			end() {}
		};
		await service.handleAdmin(request(), response, new URL('https://x/admin/bootstrap'));
		expect(status).toBe(403);
	});
});
