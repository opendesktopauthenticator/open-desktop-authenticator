import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Expired attachments must be reported missing, not silently dropped.
 *
 * Uploads become unclaimable two hours after they are added. Both submission
 * paths ignored `claimAttachments`' return value and reported plain success, so
 * a reporter who spent longer than that composing was told "Report received"
 * while every screenshot they attached was absent — and nothing anywhere ever
 * said so.
 *
 * And the report page must not tell reporters the reference is "the only way
 * back": the reference alone cannot reopen a report, deliberately. The page now
 * shows the full secret link — its viewer already holds the key, so re-showing
 * it adds nothing to what they have and saves the person who lost the original
 * confirmation page.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });
let files: string;

beforeAll(async () => {
	files = mkdtempSync(join(tmpdir(), 'oda-expiry-'));
	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	process.env.TICKETS_FILES = files;
	service = await import('../tickets/server.mjs');
});

afterAll(() => {
	service.server?.close?.();
	rmSync(files, { recursive: true, force: true });
});

let nextAddress = 0;
const someAddress = () => `10.9.${Math.floor(nextAddress / 250)}.${(nextAddress++ % 250) + 1}`;

function capture() {
	const out = { status: 0, body: '', headers: {} as Record<string, string> };
	const response = {
		headersSent: false,
		writeHead(status: number, headers: Record<string, string>) {
			out.status = status;
			out.headers = headers ?? {};
			return this;
		},
		end(body: string | Buffer) {
			out.body = String(body ?? '');
		}
	};
	return { out, response };
}

function post(fields: Record<string, string>) {
	const request = Readable.from([
		Buffer.from(new URLSearchParams(fields).toString())
	]) as unknown as Record<string, unknown>;
	request.method = 'POST';
	request.headers = { origin: 'https://opendesktopauthenticator.com' };
	request.socket = { remoteAddress: someAddress() };
	return request;
}

const get = () => ({
	method: 'GET',
	headers: {},
	socket: { remoteAddress: someAddress() }
});

const at = (p: string) => new URL(`https://opendesktopauthenticator.com${p}`);

/** An upload whose two hours ran out, made honestly then aged in the database. */
function expiredUpload(): string {
	const id = 'a'.repeat(31) + String(nextAddress % 10);
	service.db
		.prepare('INSERT INTO attachments (id, media_type, bytes, created_at) VALUES (?, ?, ?, ?)')
		.run(id, 'image/png', 64, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
	return id;
}

async function fileReport(over: Record<string, string> = {}): Promise<{
	body: string;
	reference: string;
	key: string;
}> {
	const { out, response } = capture();
	await service.handle(
		post({
			kind: 'bug',
			summary: 'Codes are refused after import',
			detail: 'The import finished but every code it produced afterwards was refused by Steam.',
			...over
		}),
		response,
		at('/support/submit')
	);
	const reference = /ODA-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(out.body)?.[0] ?? '';
	const key = /\?k=([A-Za-z0-9_-]+)/.exec(out.body)?.[1] ?? '';
	return { body: out.body, reference, key };
}

describe('a report whose uploads had expired', () => {
	it('says so on the confirmation page instead of claiming clean success', async () => {
		const id = expiredUpload();
		const { body } = await fileReport({ attachments: id });

		expect(body).toContain('Report received');
		expect(body).toMatch(/could not be included/);
		expect(body).toMatch(/expire/);
	});

	it('says nothing extra when every upload claimed', async () => {
		const { body } = await fileReport();
		expect(body).not.toMatch(/could not be included/);
	});
});

describe('a reply whose uploads had expired', () => {
	it('lands back on the page with the shortfall named', async () => {
		const { reference, key } = await fileReport();
		const id = expiredUpload();

		const { out, response } = capture();
		await service.handle(
			post({ body: 'Here is the screenshot you asked for.', attachments: id, k: key }),
			response,
			at(`/support/ticket/${reference}/reply?k=${key}`)
		);
		expect(out.status).toBe(303);
		expect(out.headers.location).toContain('missing=1');

		// The browser that posted the reply already holds the report cookie — the
		// page that offered the form set it. Follow the redirect the way it does.
		const spend = capture();
		await service.handle(get(), spend.response, at(`/support/ticket/${reference}?k=${key}`));
		const cookie = spend.out.headers['set-cookie'] ?? '';

		const view = capture();
		await service.handle(
			{ ...get(), headers: { cookie } },
			view.response,
			at(out.headers.location ?? '')
		);
		expect(view.out.body).toMatch(/could not be included/);
	});
});

describe('the way back to a report', () => {
	it('shows the full link and never claims the reference alone reopens it', async () => {
		const { reference, key } = await fileReport();

		const { out, response } = capture();
		await service.handle(get(), response, at(`/support/ticket/${reference}?k=${key}#body`));
		// The ?k= redirect spends the query key into a cookie; follow it.
		const target = (out.status === 303 && out.headers.location) || `/support/ticket/${reference}`;
		const view = capture();
		await service.handle(
			{ ...get(), headers: { cookie: out.headers['set-cookie'] ?? '' } },
			view.response,
			at(target)
		);

		expect(view.out.body).not.toContain('it is the only way back to this page');
		expect(view.out.body).toContain(`?k=${encodeURIComponent(key)}`);
		expect(view.out.body).toMatch(/reference .*on its own[\s\S]*will not reopen/);
	});
});

/*
 * Legacy rows without an access key were a permanent lockout.
 *
 * The migration added the column nullable "so an existing database opens
 * without a migration step" — and the ticket view requires a string key
 * compared in constant time, so NULL matched nothing, ever: every
 * pre-migration conversation 404'd for everyone, admin links included. The
 * startup backfill mints a key per legacy row so each report is reachable
 * again, and the admin can send its holder a working link.
 */
describe('legacy tickets without an access key', () => {
	it('are given one at startup, and open with it', async () => {
		service.db
			.prepare(
				`INSERT INTO tickets (reference, access_key, kind, summary, detail, contact, created_at, updated_at)
				 VALUES ('ODA-OLDR-OWXX', NULL, 'bug', 'A legacy report', 'Filed before keys existed.', '', ?, ?)`
			)
			.run(new Date().toISOString(), new Date().toISOString());

		// The function itself, and the wiring: the backfill only helps if the
		// server actually runs it at startup, before any request is answered.
		const source = readFileSync(join(__dirname, '../tickets/server.mjs'), 'utf8');
		expect(source).toMatch(/^backfillAccessKeys\(\);/m);

		expect(service.backfillAccessKeys()).toBe(1);

		const row = service.db
			.prepare("SELECT access_key FROM tickets WHERE reference = 'ODA-OLDR-OWXX'")
			.get() as { access_key: string | null };
		expect(typeof row.access_key).toBe('string');

		const { out, response } = capture();
		await service.handle(get(), response, at(`/support/ticket/ODA-OLDR-OWXX?k=${row.access_key}`));
		// The key spends into a cookie via a 303 — that redirect is the proof the
		// gate accepted it; a wrong key answers 404.
		expect(out.status).toBe(303);
	});
});

/*
 * A submission is one transaction.
 *
 * node:sqlite autocommits per statement, so a claim failure after the ticket
 * INSERT left half a report stored behind a 500 reading "Nothing was saved" —
 * inviting a duplicate whose first copy nobody can ever open. Sabotaging the
 * claim now proves the INSERT rolls back with it.
 */
describe('a submission whose attachment claim fails', () => {
	it('stores nothing at all', async () => {
		const before = (service.db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number })
			.n;

		service.db.exec('ALTER TABLE attachments RENAME TO attachments_sabotaged');
		try {
			const { response } = capture();
			// The throw escapes `handle` here because the 500 wrapper lives a layer
			// above it in the real server; what matters is what the database holds
			// once the dust settles.
			await expect(
				service.handle(
					post({
						kind: 'bug',
						summary: 'This submission is doomed',
						detail: 'The attachments table is gone, so the claim throws mid-submission.',
						attachments: 'a'.repeat(32)
					}),
					response,
					at('/support/submit')
				)
			).rejects.toThrow(/no such table/);
		} finally {
			service.db.exec('ALTER TABLE attachments_sabotaged RENAME TO attachments');
		}

		const after = (service.db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number })
			.n;
		// "Nothing was saved" is now the truth.
		expect(after).toBe(before);
	});
});

/*
 * An admin action is one transaction, and an oversized reply is 413.
 */
describe('an admin action whose note fails', () => {
	it('runs the status change and the note in one transaction', () => {
		// `transactionally` itself is proved to roll back by the submission
		// sabotage test above; what this asserts is that the admin route uses it.
		// Un-wrapped, a notes INSERT failing after the status UPDATE left the
		// queue moved and the explanation missing — while the catch-all answered
		// "Nothing was saved", so a retry looked like a second transition after
		// the operator had been told the first had not happened.
		const source = readFileSync(join(__dirname, '../tickets/server.mjs'), 'utf8');
		const start = source.indexOf('const act = ');
		const route = source.slice(start, source.indexOf("location: '/admin'", start));
		expect(route).toBeDefined();
		expect(route).toContain('transactionally(() => {');
		expect(route).toMatch(
			/transactionally\(\(\) => \{[\s\S]*UPDATE tickets SET status[\s\S]*INSERT INTO notes[\s\S]*\}\);/
		);
	});
});

describe('an oversized reply', () => {
	it('is refused as too large, not as a length problem', async () => {
		const { reference, key } = await fileReport();
		const { out, response } = capture();
		await service.handle(
			post({ body: 'x'.repeat(20 * 1024), k: key }),
			response,
			at(`/support/ticket/${reference}/reply?k=${key}`)
		);
		expect(out.status).toBe(413);
		expect(out.body).toMatch(/too large/i);
	});
});
