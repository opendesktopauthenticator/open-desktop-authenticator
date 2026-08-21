import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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

	it.each([
		['a shared secret', '"shared_secret": "abc123deadbeef=="'],
		['a revocation code', 'R12345'],
		['a private key', '-----BEGIN PRIVATE KEY-----']
	])('refuses %s pasted into the contact field', (_what, poison) => {
		// `contact` was length-checked and then stored, but never scanned. It is the
		// field that looks like a header rather than a body, which is exactly why
		// somebody in a panic puts the wrong thing in it — and it lands in SQLite
		// beside the rest, defeating the promise this service makes about never
		// collecting an authenticator secret.
		const { errors } = service.validate({ ...good, contact: poison });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.join(' ')).toMatch(/has not been saved/i);
	});

	it('still accepts an ordinary way to get back in touch', () => {
		// The scan must not make the field unusable for what it is for.
		expect(service.validate({ ...good, contact: 'someone@example.com' }).errors).toEqual([]);
		expect(service.validate({ ...good, contact: '@someone on Discord' }).errors).toEqual([]);
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

	it('will not create an administrator without the token', async () => {
		// GET now renders a form that asks for the token, because the token is a
		// form field rather than a query parameter — a secret in a URL ends up in
		// the access log and in browser history. So the refusal moved to the POST.
		let status = 0;
		const chunks: string[] = [];
		const response = {
			headersSent: false,
			writeHead(code: number) {
				status = code;
				return this;
			},
			end(body: string) {
				chunks.push(body ?? '');
			}
		};
		const empty = Readable.from([Buffer.from('')]) as unknown as Record<string, unknown>;
		empty.method = 'POST';
		empty.headers = {};
		empty.socket = { remoteAddress: '10.9.0.1' };
		await service.handleAdmin(empty, response, new URL('https://x/admin/bootstrap'));
		expect(status).toBe(403);
		expect(chunks.join('')).not.toMatch(/Reports<\/h1>/);
	});
});

/*
 * An oversized submission has to be *told* it was oversized.
 *
 * Both body readers destroyed the request the moment the cap was passed, so the
 * 413 the caller then wrote went to a socket that no longer existed and the
 * client saw `ECONNRESET: socket hang up` instead — on the one response whose
 * entire job is to explain why the submission was refused.
 */
describe('refusing an oversized body', () => {
	const SOURCE = readFileSync(join(__dirname, '..', 'tickets', 'server.mjs'), 'utf8');

	it('stops reading without destroying the request', () => {
		expect(SOURCE).not.toMatch(/reject\(new Error\('too large'\)\);\s*request\.destroy\(\)/);
		expect(SOURCE.match(/request\.pause\(\);/g) ?? []).toHaveLength(2);
	});

	it('closes the connection whenever the body was truncated', () => {
		// The rest of the body is still arriving behind an answer written without
		// reading it. Left alive, those bytes would be parsed as the next request on
		// the same connection.
		//
		// Keyed on the marker as well as the status, because several callers catch
		// the oversized rejection, substitute an empty form and answer 400 or 403 —
		// so gating on 413 alone left exactly those responses on a live socket with
		// body bytes outstanding.
		expect(SOURCE).toMatch(/status === 413 \|\| response\.req\?\.oversized/);
		expect(SOURCE.match(/request\.oversized = true;/g) ?? []).toHaveLength(2);
	});
});
