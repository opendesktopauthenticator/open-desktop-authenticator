import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Attacking the ticket service through its own front door.
 *
 * Reading the code and seeing `escape()` in the right places is not proof. This
 * drives the real handlers: a payload goes in through the public form exactly as
 * a browser would send it, comes back out through the page that renders it, and
 * the assertion is on the bytes a victim's browser would receive.
 *
 * The victim here is the maintainer. Every one of these payloads is stored by a
 * stranger and rendered later in the admin view, which is the classic shape of
 * a stored cross-site scripting attack — the attacker never needs the admin
 * session, they only need the admin to read their report.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });

beforeAll(async () => {
	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	service = await import('../tickets/server.mjs');
});

afterAll(() => service.server?.close?.());

/** A request the handlers cannot tell from a browser's. */
function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
	const body = new URLSearchParams(fields).toString();
	const request = Readable.from([Buffer.from(body)]) as unknown as Record<string, unknown>;
	request.method = 'POST';
	request.headers = { origin: 'https://opendesktopauthenticator.com', ...headers };
	request.socket = { remoteAddress: `10.0.0.${Math.floor(Math.random() * 250)}` };
	return { request, url: new URL(`https://opendesktopauthenticator.com${path}`) };
}

function get(path: string) {
	const request = { method: 'GET', headers: {}, socket: { remoteAddress: '10.0.0.9' } };
	return { request, url: new URL(`https://opendesktopauthenticator.com${path}`) };
}

/** Collects what the handler would actually send to a browser. */
function capture() {
	const out = { status: 0, body: '', headers: {} as Record<string, string> };
	const response = {
		headersSent: false,
		writeHead(status: number, headers: Record<string, string>) {
			out.status = status;
			out.headers = headers ?? {};
			return this;
		},
		end(body: string) {
			out.body = body ?? '';
		}
	};
	return { out, response };
}

const PAYLOADS: [string, string][] = [
	['a script tag', '<script>alert(1)</script>'],
	['an image error handler', '<img src=x onerror=alert(1)>'],
	['an attribute break-out', '"><script>alert(1)</script>'],
	['a single-quote break-out', "'><svg onload=alert(1)>"],
	['a javascript: URL', '<a href="javascript:alert(1)">click</a>'],
	['an svg payload', '<svg><script>alert(1)</script></svg>'],
	['a style expression', '<style>@import "http://evil.example"</style>'],
	['an iframe', '<iframe src="https://evil.example"></iframe>'],
	['a closing tag for our own markup', '</p></article><script>alert(1)</script>']
];

describe('stored cross-site scripting', () => {
	it.each(PAYLOADS)('renders %s inert', async (_name, payload) => {
		// Submit it the way a browser would.
		const submit = post('/support/submit', {
			kind: 'bug',
			summary: `Payload test ${payload}`.slice(0, 140),
			detail: `Something went wrong and here is the detail: ${payload} and some trailing words.`
		});
		const first = capture();
		await service.handle(submit.request, first.response, submit.url);
		expect(first.out.status, `submission rejected: ${first.out.body.slice(0, 200)}`).toBe(200);

		const reference = /ODA-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(first.out.body)?.[0];
		expect(reference).toBeTruthy();

		// Read it back through the page that renders it.
		const view = get(`/support/ticket/${reference}`);
		const second = capture();
		await service.handle(view.request, second.response, view.url);
		expect(second.out.status).toBe(200);

		const html = second.out.body;
		// The payload must be present as text — it should not be silently dropped,
		// because the maintainer needs to see what was reported.
		expect(html).toContain('Payload test');

		// And it must be inert. Nothing that could execute may survive.
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).not.toContain('<img src=x onerror');
		expect(html).not.toContain('<svg onload');
		expect(html).not.toContain('<iframe');
		expect(html).not.toMatch(/<a href="javascript:/);
		// The one <style> in the document is ours; a submitted one must be escaped.
		expect(html).not.toContain('<style>@import');
		// Our own markup must not be closable from inside a field.
		expect(html).not.toContain('</p></article><script>');
	});

	it('escapes the reference before putting it in the page title', async () => {
		// The title takes a different path from the body — it is interpolated into
		// page() rather than escaped at the call site — so it is worth its own check.
		const view = get('/support/ticket/ODA-AAAA-BBBB');
		const { out, response } = capture();
		await service.handle(view.request, response, view.url);
		expect(out.status).toBe(404);

		// The layout carries exactly one script: our own attachment helper, by its
		// hashed name. Anything else in the document is something that got in.
		const scripts = out.body.match(/<script[^>]*>/gi) ?? [];
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/src="\/assets\/support\.[^"]*js"/);
		// And no inline script body anywhere, which the CSP would refuse anyway.
		expect(out.body).not.toMatch(/<script[^>]*>[^<]/i);
	});
});

describe('what the public ticket page discloses', () => {
	it('never shows the reporter’s contact address', async () => {
		const submit = post('/support/submit', {
			kind: 'bug',
			summary: 'A report that carries a contact address',
			detail: 'The reporter left an address so we could ask a follow-up question later.',
			contact: 'reporter@example.com'
		});
		const first = capture();
		await service.handle(submit.request, first.response, submit.url);
		const reference = /ODA-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(first.out.body)?.[0];

		const view = get(`/support/ticket/${reference}`);
		const second = capture();
		await service.handle(view.request, second.response, view.url);

		// Anyone holding the reference can read the report. The address must not be
		// part of that — it is for us to reply with, not for the page to publish.
		expect(second.out.body).not.toContain('reporter@example.com');
	});

	it('does not leak whether a reference exists through the status code alone', async () => {
		const view = get('/support/ticket/ODA-2222-3333');
		const { out, response } = capture();
		await service.handle(view.request, response, view.url);
		expect(out.status).toBe(404);
		// A 404 body that echoed the reference back would make enumeration cheaper
		// to script against.
		expect(out.body).not.toContain('ODA-2222-3333');
	});
});

describe('responses cannot be cached or framed', () => {
	it('marks ticket pages no-store', async () => {
		const view = get('/support/ticket/ODA-4444-5555');
		const { out, response } = capture();
		await service.handle(view.request, response, view.url);
		expect(out.headers['cache-control']).toBe('no-store');
		expect(out.headers['x-content-type-options']).toBe('nosniff');
	});
});
