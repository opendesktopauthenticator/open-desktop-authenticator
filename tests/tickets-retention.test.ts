import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Deletion, and the page that promises it.
 *
 * Nothing here deleted anything before this: reports accumulated for ever and so
 * did the screenshots on them, while "Remove" on an upload dropped the thumbnail
 * and left our copy on disk. A delete control that does not delete is the one
 * kind of lie a privacy page cannot survive.
 *
 * The last case compares the published retention periods against the constants
 * that implement them, because a privacy policy describing what the code used to
 * do is worse than no policy at all.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });
let files: string;

beforeAll(async () => {
	files = mkdtempSync(join(tmpdir(), 'oda-ret-'));
	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	process.env.TICKETS_FILES = files;
	service = await import('../tickets/server.mjs');
});

afterAll(() => {
	service.server?.close?.();
	rmSync(files, { recursive: true, force: true });
});

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(56)
]);

let nth = 0;
const someAddress = () => `10.40.${(++nth >> 8) & 255}.${nth & 255}`;
const at = (p: string) => new URL(`https://opendesktopauthenticator.com${p}`);
const ORIGIN = { origin: 'https://opendesktopauthenticator.com' };

function capture() {
	const out = { status: 0, body: '' };
	const response = {
		headersSent: false,
		writeHead(status: number) {
			out.status = status;
			return this;
		},
		end(body: string) {
			out.body = typeof body === 'string' ? body : '';
		}
	};
	return { out, response };
}

function raw(payload: Buffer, method = 'POST', headers: Record<string, string> = ORIGIN) {
	const request = Readable.from([payload]) as unknown as Record<string, unknown>;
	request.method = method;
	request.headers = headers;
	request.socket = { remoteAddress: someAddress() };
	return request;
}

const bare = (method: string, headers: Record<string, string> = ORIGIN) => ({
	method,
	headers,
	socket: { remoteAddress: someAddress() }
});

async function upload(): Promise<string> {
	const { out, response } = capture();
	await service.handle(raw(PNG), response, at('/support/attach'));
	return (JSON.parse(out.body) as { id: string }).id;
}

async function report(attachments?: string) {
	const { out, response } = capture();
	await service.handle(
		raw(
			Buffer.from(
				new URLSearchParams({
					kind: 'bug',
					summary: 'A report used by the retention tests',
					detail: 'Long enough to satisfy the validator and describe nothing in particular.',
					...(attachments ? { attachments } : {})
				}).toString()
			)
		),
		response,
		at('/support/submit')
	);
	return /ODA-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(out.body)?.[0] as string;
}

function linkTo(reference: string, suffix = '') {
	const row = service.db
		.prepare('SELECT access_key FROM tickets WHERE reference = ?')
		.get(reference) as { access_key: string } | undefined;
	return `/support/ticket/${reference}${suffix}?k=${encodeURIComponent(row?.access_key ?? '')}`;
}

describe('withdrawing an upload actually withdraws it', () => {
	it('deletes the file and the row', async () => {
		const id = await upload();
		expect(readdirSync(files)).toContain(id);

		const { out, response } = capture();
		await service.handle(bare('DELETE'), response, at(`/support/attach/${id}`));
		expect(out.status).toBe(204);

		expect(readdirSync(files), 'the file must be gone from disk').not.toContain(id);
		expect(
			service.db.prepare('SELECT id FROM attachments WHERE id = ?').get(id),
			'and the row with it'
		).toBeUndefined();
	});

	it('refuses to strip an attachment off a submitted report', async () => {
		// Once an id belongs to a report it is part of somebody's evidence. The id
		// is unguessable, but that is the wrong thing to be leaning on for a
		// destructive operation reachable without any authentication.
		const id = await upload();
		const reference = await report(id);

		const { out, response } = capture();
		await service.handle(bare('DELETE'), response, at(`/support/attach/${id}`));
		expect(out.status).toBe(204); // Says nothing either way, deliberately.

		expect(readdirSync(files), 'the claimed file must survive').toContain(id);
		const still = capture();
		await service.handle(bare('GET'), still.response, at(linkTo(reference, `/file/${id}`)));
		expect(still.out.status).toBe(200);
	});

	it('refuses a withdrawal from another site', async () => {
		const id = await upload();
		const { out, response } = capture();
		await service.handle(
			bare('DELETE', { origin: 'https://evil.example' }),
			response,
			at(`/support/attach/${id}`)
		);
		expect(out.status).toBe(403);
		expect(readdirSync(files)).toContain(id);
	});

	it('says the same thing about an id that never existed', async () => {
		// Distinguishing "gone" from "never yours" would tell an unauthenticated
		// caller which ids are real.
		const { out, response } = capture();
		await service.handle(bare('DELETE'), response, at(`/support/attach/${'b'.repeat(32)}`));
		expect(out.status).toBe(204);
	});
});

describe('closed reports do not live for ever', () => {
	it('deletes a resolved report and its attachments once it is old enough', async () => {
		const id = await upload();
		const reference = await report(id);
		const row = service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference) as {
			id: number;
		};

		// Close it, and backdate the closure past the retention window.
		service.db
			.prepare("UPDATE tickets SET status = 'resolved', updated_at = ? WHERE id = ?")
			.run('2020-01-01T00:00:00.000Z', row.id);

		// Any upload triggers the sweeps.
		await upload();

		expect(
			service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference)
		).toBeUndefined();
		expect(readdirSync(files), 'its attachment goes with it').not.toContain(id);
	});

	it('never deletes an open report on a timer', async () => {
		// An open report is somebody's live problem. Age is not a reason to bin it.
		const reference = await report();
		const row = service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference) as {
			id: number;
		};
		service.db
			.prepare("UPDATE tickets SET status = 'open', updated_at = ? WHERE id = ?")
			.run('2019-01-01T00:00:00.000Z', row.id);

		await upload();
		expect(
			service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference)
		).toBeDefined();
	});

	it('keeps a recently closed report', async () => {
		const reference = await report();
		const row = service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference) as {
			id: number;
		};
		service.db
			.prepare("UPDATE tickets SET status = 'resolved', updated_at = ? WHERE id = ?")
			.run(new Date().toISOString(), row.id);

		await upload();
		expect(
			service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference)
		).toBeDefined();
	});
});

describe('the privacy page describes the code', () => {
	it('publishes the same retention periods the service implements', () => {
		// A privacy policy describing what the code used to do is worse than none.
		// These are the two durations the page states in words.
		const source = readFileSync('tickets/server.mjs', 'utf8');

		const unclaimedHours = /UNCLAIMED_LIFETIME_MS = (\d+) \* 60 \* 60 \* 1000/.exec(source)?.[1];
		expect(unclaimedHours, 'the unclaimed-upload window must be findable').toBeDefined();

		const closedDays = /CLOSED_RETENTION_MS = (\d+) \* 24 \* 60 \* 60 \* 1000/.exec(source)?.[1];
		expect(closedDays, 'the closed-report window must be findable').toBeDefined();

		const page = readFileSync('site/pages/privacy.mjs', 'utf8');
		expect(page, `page must state the ${unclaimedHours}-hour unclaimed window`).toContain(
			`${unclaimedHours} hours`
		);
		expect(page, `page must state the ${closedDays}-day closed window`).toContain(
			`${closedDays} days`
		);
	});
});

describe('the reference names a report; the key opens it', () => {
	/**
	 * Why these are separate now.
	 *
	 * `ODA-XXXX-XXXX` is eight characters of a 26-letter alphabet — about 37.6
	 * bits — and it was the only thing standing between a stranger and somebody
	 * else's support thread, including any screenshots on it. That is a fine
	 * identifier and an inadequate credential, and rate limiting does not make a
	 * short secret long.
	 */
	it('refuses a report when the link has no key', async () => {
		const reference = await report();
		const { out, response } = capture();
		await service.handle(bare('GET'), response, at(`/support/ticket/${reference}`));
		expect(out.status).toBe(404);
	});

	it('refuses a wrong key', async () => {
		const reference = await report();
		const { out, response } = capture();
		await service.handle(bare('GET'), response, at(`/support/ticket/${reference}?k=not-the-key`));
		expect(out.status).toBe(404);
	});

	it('answers a wrong key exactly as it answers a reference that does not exist', async () => {
		// Otherwise the short, guessable half becomes an oracle for which reports
		// are real, and the whole point of splitting them is lost.
		const reference = await report();

		const wrongKey = capture();
		await service.handle(
			bare('GET'),
			wrongKey.response,
			at(`/support/ticket/${reference}?k=wrong`)
		);

		const noSuchReport = capture();
		await service.handle(
			bare('GET'),
			noSuchReport.response,
			at('/support/ticket/ODA-2222-3333?k=wrong')
		);

		expect(wrongKey.out.status).toBe(noSuchReport.out.status);
		expect(wrongKey.out.body).toBe(noSuchReport.out.body);
	});

	it('opens with the real key', async () => {
		const reference = await report();
		const { out, response } = capture();
		await service.handle(bare('GET'), response, at(linkTo(reference)));
		expect(out.status).toBe(200);
		expect(out.body).toContain(reference);
	});

	it('issues a key with enough room in it to be a credential', async () => {
		const reference = await report();
		const row = service.db
			.prepare('SELECT access_key FROM tickets WHERE reference = ?')
			.get(reference) as { access_key: string };
		// 32 bytes, base64url — 43 characters and 256 bits, against the reference's
		// 37.6. The assertion is on the length rather than the alphabet because the
		// encoding could reasonably change and the entropy must not.
		expect(row.access_key.length).toBeGreaterThanOrEqual(43);
		expect(row.access_key).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('gives every report a different key', async () => {
		const keys = new Set<string>();
		for (let i = 0; i < 5; i++) {
			const reference = await report();
			keys.add(
				(
					service.db
						.prepare('SELECT access_key FROM tickets WHERE reference = ?')
						.get(reference) as { access_key: string }
				).access_key
			);
		}
		expect(keys.size).toBe(5);
	});

	it('hands the whole link over once, and says to keep it', async () => {
		// The key is shown exactly once. If the confirmation page did not make that
		// plain, somebody saves the reference and loses their own report.
		const { out, response } = capture();
		await service.handle(
			raw(
				Buffer.from(
					new URLSearchParams({
						kind: 'bug',
						summary: 'A report used to check the confirmation page',
						detail: 'Long enough to satisfy the validator and describe nothing at all.'
					}).toString()
				)
			),
			response,
			at('/support/submit')
		);
		expect(out.body).toMatch(/Save this link/i);
		expect(out.body).toMatch(/\?k=/);
		expect(out.body).toMatch(/cannot send\s+it to you again|shown once/i);
	});
});
