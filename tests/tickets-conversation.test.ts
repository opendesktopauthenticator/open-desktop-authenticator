import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A report as a conversation rather than a receipt.
 *
 * The reporter could previously only read. That is the wrong shape for what
 * this is actually for: somebody who has just lost an inventory writes in a
 * hurry, remembers the important detail ten minutes later, and has nowhere to
 * put it but a second report. These cover the two halves that fixes — the
 * reporter can add to their own thread, and the thread says who said what.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });
let files: string;

beforeAll(async () => {
	files = mkdtempSync(join(tmpdir(), 'oda-convo-'));
	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	process.env.TICKETS_FILES = files;
	service = await import('../tickets/server.mjs');
});

afterAll(() => {
	service.server?.close?.();
	rmSync(files, { recursive: true, force: true });
});

let nth = 0;
const someAddress = () => {
	nth += 1;
	return `172.${(nth >> 16) & 255}.${(nth >> 8) & 255}.${nth & 255}`;
};

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
			out.body = typeof body === 'string' ? body : '';
		}
	};
	return { out, response };
}

const at = (p: string) => new URL(`https://opendesktopauthenticator.com${p}`);

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
	const request = Readable.from([
		Buffer.from(new URLSearchParams(fields).toString())
	]) as unknown as Record<string, unknown>;
	request.method = 'POST';
	request.headers = { origin: 'https://opendesktopauthenticator.com', ...headers };
	request.socket = { remoteAddress: someAddress() };
	return request;
}

const get = (headers: Record<string, string> = {}) => ({
	method: 'GET',
	headers,
	socket: { remoteAddress: someAddress() }
});

async function fileReport(over: Record<string, string> = {}) {
	const { out, response } = capture();
	await service.handle(
		post({
			kind: 'bug',
			summary: 'Something went wrong while importing',
			detail: 'The import finished but every code it produced afterwards was refused by Steam.',
			...over
		}),
		response,
		at('/support/submit')
	);
	return /ODA-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(out.body)?.[0] as string;
}

/** Split a rendered thread into its messages, each with the side that sent it. */
function page(out: { body: string }) {
	return [
		...out.body.matchAll(/<li class="message (message-us|message-reporter)">([\s\S]*?)<\/li>/g)
	].map((m) => ({ side: m[1] === 'message-us' ? 'us' : 'reporter', text: m[2] }));
}

/**
 * The access key for a report, read the way the reporter's saved link carries it.
 *
 * The reference alone stopped opening a report when the capability was split out
 * of it — that is the change, not a regression — so the tests have to follow the
 * real link rather than guess at half of it.
 */
function keyFor(reference: string): string {
	const row = service.db
		.prepare('SELECT access_key FROM tickets WHERE reference = ?')
		.get(reference) as { access_key: string } | undefined;
	return row?.access_key ?? '';
}

const linkTo = (reference: string, suffix = '') =>
	`/support/ticket/${reference}${suffix}?k=${encodeURIComponent(keyFor(reference))}`;

async function view(reference: string) {
	const { out, response } = capture();
	await service.handle(get(), response, at(linkTo(reference)));
	// The link spends its key and answers 303; follow it as a browser would.
	if (out.status !== 303) return out;
	const cookie = String(out.headers['set-cookie'] ?? '').split(';')[0] ?? '';
	const next = capture();
	await service.handle(get({ cookie }), next.response, at(String(out.headers.location)));
	return next.out;
}

async function reply(reference: string, body: string, headers = {}) {
	const { out, response } = capture();
	await service.handle(post({ body }, headers), response, at(linkTo(reference, '/reply')));
	return out;
}

/** Act as the maintainer, without going through the sign-in flow. */
function asUs(reference: string, note: string, status: string) {
	const ticket = service.db.prepare('SELECT * FROM tickets WHERE reference = ?').get(reference) as {
		id: number;
	};
	service.db
		.prepare('INSERT INTO notes (ticket_id, body, author, created_at) VALUES (?, ?, ?, ?)')
		.run(ticket.id, note, 'us', new Date().toISOString());
	service.db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, ticket.id);
}

describe('the reporter can add to their own report', () => {
	it('accepts a reply and shows it in the thread', async () => {
		const reference = await fileReport();
		expect(
			(await reply(reference, 'I forgot to say: this only happens after a reboot.')).status
		).toBe(303);

		const page = await view(reference);
		expect(page.body).toContain('only happens after a reboot');
	});

	it('marks who said what', async () => {
		// The whole point of the thread. "Has a human seen this" is the question,
		// and a page where every message looks the same cannot answer it.
		const reference = await fileReport();
		await reply(reference, 'Adding a detail I left out of the first message.');
		asUs(reference, 'Thanks — that narrows it down. Which version are you on?', 'assigned');

		// Each message is checked against its own text, not merely counted. Simply
		// asserting that both classes appear somewhere on the page passes even when
		// every message is attributed to the wrong side, which is the exact bug
		// worth catching here.
		const [opening, followUp, ours, ...rest] = page(await view(reference));
		expect(rest).toHaveLength(0);
		expect(opening).toBeDefined();
		expect(followUp).toBeDefined();
		expect(ours).toBeDefined();

		// The opening report is from the person who filed it.
		expect(opening?.side).toBe('reporter');
		expect(opening?.text).toContain('every code it produced');
		// Then their follow-up.
		expect(followUp?.side).toBe('reporter');
		expect(followUp?.text).toContain('Adding a detail');
		// Then ours, named.
		expect(ours?.side).toBe('us');
		expect(ours?.text).toContain('Which version are you on');
		expect(ours?.text).toContain('Open Desktop Authenticator');
	});

	it('refuses a reply posted from another site', async () => {
		const reference = await fileReport();
		const out = await reply(reference, 'A reply that did not come from here.', {
			origin: 'https://evil.example'
		});
		expect(out.status).toBe(403);
	});

	it('refuses a reply to a reference that does not exist', async () => {
		const out = await reply('ODA-2222-3333', 'Talking to nobody.');
		expect(out.status).toBe(404);
	});

	it.each([
		['too short', 'ok'],
		['too long', 'x'.repeat(4001)]
	])('refuses a reply that is %s', async (_what, body) => {
		const reference = await fileReport();
		expect((await reply(reference, body)).status).toBe(400);
	});

	it('refuses a reply containing a secret', async () => {
		// **The check that most needed to exist here.** Somebody answering "which
		// account is it?" is the single most likely person to paste the wrong
		// thing, and a guard that only covered the first message would have missed
		// exactly that moment.
		const reference = await fileReport();
		const out = await reply(reference, 'Here it is: "shared_secret": "abcdefgh12345678=="');
		expect(out.status).toBe(400);
		expect(out.body).toMatch(/has not been saved/i);

		// And nothing was written.
		const page = await view(reference);
		expect(page.body).not.toContain('abcdefgh12345678');
	});

	it('escapes a reply before rendering it', async () => {
		const reference = await fileReport();
		await reply(reference, 'Try this: <img src=x onerror=alert(1)> and <script>alert(2)</script>');
		const page = await view(reference);
		expect(page.body).not.toContain('<img src=x onerror');
		expect(page.body).not.toContain('<script>alert(2)</script>');
		expect(page.body).toContain('&lt;img');
	});
});

describe('routing', () => {
	it('sends a GET of the reply endpoint to the report itself', async () => {
		// The form's action URL used to answer 200 with a second copy of the whole
		// report — the same page at a URL that is not its canonical one, reachable
		// by a prefetch, a bookmark saved after a failed post, or a shared link.
		const reference = await fileReport();
		const { out, response } = capture();
		await service.handle(get(), response, at(linkTo(reference, '/reply')));
		expect(out.status).toBe(303);
		// The redirect no longer carries the key. It does not need to: the same
		// request that spent the key was answered with the cookie that replaces it,
		// so the reader arrives authenticated at a URL with no secret in it.
		expect(out.headers.location).toBe(`/support/ticket/${reference}`);
		expect(out.headers.location).not.toContain('k=');
		expect(String(out.headers['set-cookie'] ?? '')).toContain('HttpOnly');
		expect(out.body).not.toMatch(/<article/);
	});

	it('reports whether it handled a request', async () => {
		// The router's contract: undefined means "not mine, try the next handler".
		// Every answered route returned undefined too, so the only thing preventing
		// a second response was a `headersSent` check further down.
		const reference = await fileReport();

		const answered = capture();
		const handled = await service.handle(
			get(),
			answered.response,
			at(`/support/ticket/${reference}`)
		);
		expect(handled, 'an answered request must not look unanswered').toBeDefined();

		const ignored = capture();
		const notMine = await service.handle(get(), ignored.response, at('/somewhere-else'));
		expect(notMine, 'an unclaimed path must fall through').toBeUndefined();
		expect(ignored.out.status).toBe(0);
	});
});

describe('status', () => {
	it('says a person has it, not just that it is open', async () => {
		const reference = await fileReport();
		let page = await view(reference);
		expect(page.body).toContain('Received');

		asUs(reference, 'Picked this up.', 'assigned');
		page = await view(reference);
		expect(page.body).toContain('Being looked at');
		expect(page.body).toContain('status-assigned');
	});

	it('puts a resolved report back in the queue when the reporter replies', async () => {
		// Closing something the reporter disagrees with should not force them to
		// file a second report, which would arrive with none of the context.
		const reference = await fileReport();
		asUs(reference, 'Closing this as fixed in 1.2.', 'resolved');
		expect((await view(reference)).body).toContain('Resolved');

		await reply(reference, 'It is still happening on 1.2, unfortunately.');
		const page = await view(reference);
		expect(page.body).toContain('Received');
		expect(page.body).not.toContain('status-resolved');
	});

	it('leaves an assigned report assigned when the reporter answers', async () => {
		// Somebody is already working on it; a reply is the answer they asked for,
		// not a reason to drop it back into the unclaimed pile.
		const reference = await fileReport();
		asUs(reference, 'Which version are you on?', 'assigned');
		await reply(reference, 'Version 1.2.0 on Windows 11.');
		expect((await view(reference)).body).toContain('Being looked at');
	});

	it('offers to reopen rather than to add, once closed', async () => {
		const reference = await fileReport();
		asUs(reference, 'Not something we will change.', 'declined');
		const page = await view(reference);
		expect(page.body).toContain('Reopen this');
		expect(page.body).toContain('Declined');
	});
});

describe('what the thread still does not show', () => {
	it('keeps the reporter’s contact address off the page', async () => {
		const reference = await fileReport({ contact: 'someone@example.com' });
		await reply(reference, 'A follow-up message on this report.');
		const page = await view(reference);
		expect(page.body).not.toContain('someone@example.com');
	});
});

describe('a rejected report keeps what was written', () => {
	/** Submit something invalid and get the page back. */
	async function reject(fields: Record<string, string>) {
		const { out, response } = capture();
		await service.handle(post(fields), response, at('/support/submit'));
		return out;
	}

	it('returns every field with its value still in it', async () => {
		// **The worst thing this service can do short of leaking a report is lose
		// one.** Somebody writes five hundred words about how their inventory was
		// taken, picks the wrong kind from a dropdown, and used to get three red
		// lines and a link to an empty form. Most people do not type it again.
		const detail =
			'The top result for the download was not the real repository, and after I ran it ' +
			'my confirmations started approving themselves within about a quarter of an hour.';
		const out = await reject({
			kind: 'not-a-real-kind',
			summary: 'x',
			detail,
			contact: 'someone@example.com'
		});

		expect(out.status).toBe(400);
		expect(out.body, 'the long answer must survive').toContain('approving themselves');
		expect(out.body, 'the address must survive').toContain('someone@example.com');
		expect(out.body, 'the summary must survive').toMatch(/value="x"/);
		// And it is a page rather than an error fragment.
		expect(out.body).toMatch(/<h1>/);
		expect(out.body).toMatch(/<form[^>]+action="\/support\/submit"/);
	});

	it('keeps a valid choice selected and does not invent one', async () => {
		const chosen = await reject({ kind: 'clone-site', summary: 'x', detail: 'too short' });
		expect(chosen.body).toMatch(/<option value="clone-site" selected>/);

		const nonsense = await reject({ kind: 'not-a-real-kind', summary: 'x', detail: 'too short' });
		expect(nonsense.body).not.toMatch(/selected/);
	});

	it('escapes what it gives back', async () => {
		// The values go straight back into markup, so this is the moment a rejected
		// submission could become a way to put script on the page.
		const out = await reject({
			kind: 'bug',
			summary: '"><script>alert(1)</script>',
			detail: 'short',
			contact: '"><img src=x onerror=alert(1)>'
		});
		expect(out.body).not.toContain('<script>alert(1)</script>');
		expect(out.body).not.toContain('<img src=x onerror');
		expect(out.body).toContain('&lt;script&gt;');
	});

	it('does not store anything it rejected', async () => {
		const before = service.db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
		await reject({ kind: 'bug', summary: 'x', detail: 'short' });
		const after = service.db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
		expect(after.n).toBe(before.n);
	});

	it('offers the same fields as the published form', async () => {
		// This form is a second copy of the one in site/pages/guides.mjs. The copies
		// drifting apart is the cost of having two; this is what stops it happening
		// silently — a field added to one and not the other fails here.
		/*
		 * **Rendered here rather than read from `site/dist`.**
		 *
		 * This read the built page and returned silently when it was absent, which
		 * on a clean checkout is always: both workflows run `npm test` before
		 * `node site/build.mjs`, so the one assertion that stops the two copies
		 * drifting has never run in CI. It passed on developer machines with a
		 * stale build lying about, which is the worst place for a guard to work.
		 */
		const pages = await import('../site/pages/index.mjs');
		const support = (pages.PAGES as { slug: string; body?: (s: unknown) => string }[]).find(
			(page) => page.slug === 'support'
		);
		if (support?.body === undefined) {
			expect.fail('the support page is no longer in PAGES, so this compares nothing');
		}
		const names = (html: string) =>
			new Set(
				[...html.matchAll(/<(?:input|textarea|select)[^>]*\sname="([^"]+)"/g)]
					.map((m) => m[1])
					.filter((n) => n !== 'attachments')
			);
		/*
		 * A stub, not the real `SITE` — importing `site/build.mjs` writes the whole
		 * site as a side effect, thirty-two files on every test run, which is the
		 * other half of the mistake this test was making. The support page's body
		 * reads nothing off the site object, so an empty one renders it exactly.
		 */
		const published = names(support.body({}));
		const retry = names((await reject({ kind: 'bug', summary: 'x', detail: 'short' })).body);
		expect([...retry].sort()).toEqual([...published].sort());
	});
});

describe('the review request is earned, not broadcast', () => {
	/** Put a report into a given state and render it. */
	async function inState(status: string) {
		const reference = await fileReport();
		const row = service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference) as {
			id: number;
		};
		service.db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, row.id);
		return (await view(reference)).body;
	}

	it.each(['open', 'assigned', 'waiting', 'declined'])(
		'does not ask somebody whose report is %s',
		async (status) => {
			// Asking a person still waiting on help to go and vouch for the help is
			// the exact behaviour that makes review requests feel like spam — and it
			// would collect opinions from people who have not yet received anything.
			expect(await inState(status)).not.toMatch(/class="ask"/);
		}
	);

	it('asks only once the report is resolved', async () => {
		const body = await inState('resolved');
		expect(body).toMatch(/class="ask"/);
		expect(body).toContain('Did we sort this out for you?');
	});

	it('promises nothing in return and hides nothing', async () => {
		// Offering an incentive breaks Trustpilot's rules and, more to the point,
		// makes every resulting review worthless as the third-party signal this is
		// being collected for.
		const body = await inState('resolved');
		expect(body).toMatch(/Nothing is offered in return/i);
		expect(body).toMatch(/negative reviews stay up/i);
		expect(body).toContain('trustpilot.com/evaluate/opendesktopauthenticator.com');
		// *Every* outbound review link carries nofollow, not merely one of them —
		// asserting that the attribute appears somewhere passes while half the
		// links are missing it, which is exactly what the first version of this
		// check did.
		const links = [...body.matchAll(/<a ([^>]*trustpilot\.com[^>]*)>/g)].map((m) => m[1]);
		expect(links.length).toBeGreaterThan(1);
		for (const attrs of links) {
			expect(attrs, attrs).toContain('nofollow');
		}
	});
});
