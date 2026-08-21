import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
