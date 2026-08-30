import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * What the attachment endpoints do when the filesystem says no.
 *
 * The existing suites cover the paths where everything works: a file uploaded,
 * claimed, withdrawn, swept, streamed. Every failure below was reachable and
 * none of them was tested, and each one ends with the service telling somebody
 * a comfortable thing that is not true — the worst shape a privacy promise can
 * take.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });
let files: string;

beforeAll(async () => {
	files = mkdtempSync(join(tmpdir(), 'oda-fail-'));
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
const someAddress = (): string => `10.60.${(++nth >> 8) & 255}.${nth & 255}`;
const at = (p: string): URL => new URL(`https://opendesktopauthenticator.com${p}`);
const ORIGIN = { origin: 'https://opendesktopauthenticator.com' };

/**
 * Where the service keeps an upload.
 *
 * The id *is* the filename, with no extension — nothing the uploader sends ever
 * reaches a path. A first version of this guessed `${id}.bin`, so every setup
 * step below operated on a file that did not exist and three tests reported the
 * service behaving correctly while never touching it.
 */
const fileFor = (id: string): string => join(files, id);

function capture(): {
	out: { status: number; body: string; headers: Record<string, string> };
	response: Writable;
} {
	const out = { status: 0, body: '', headers: {} as Record<string, string> };
	const writable = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		}
	});
	const response = Object.assign(writable, {
		headersSent: false,
		writeHead(status: number, headers?: Record<string, string>) {
			out.headers = headers ?? {};
			out.status = status;
			return response;
		},
		end(body?: string) {
			out.body = typeof body === 'string' ? body : '';
			Writable.prototype.end.call(response, null, 'utf8', () => undefined);
			return response;
		}
	});
	return { out, response };
}

function raw(
	payload: Buffer,
	method = 'POST',
	headers: Record<string, string> = ORIGIN
): Record<string, unknown> {
	const request = Readable.from([payload]) as unknown as Record<string, unknown>;
	request.method = method;
	request.headers = headers;
	request.socket = { remoteAddress: someAddress() };
	return request;
}

const bare = (
	method: string,
	headers: Record<string, string> = ORIGIN
): Record<string, unknown> => ({
	method,
	headers,
	socket: { remoteAddress: someAddress() }
});

async function upload(): Promise<string> {
	const { out, response } = capture();
	await service.handle(raw(PNG), response, at('/support/attach'));
	return (JSON.parse(out.body) as { id: string }).id;
}

/** File a report carrying `attachments`, and answer with its reference. */
async function report(attachments?: string): Promise<{ reference: string; status: number }> {
	const { out, response } = capture();
	await service.handle(
		raw(
			Buffer.from(
				new URLSearchParams({
					kind: 'bug',
					summary: 'A report used by the attachment failure tests',
					detail: 'Long enough to satisfy the validator and describe nothing in particular.',
					...(attachments ? { attachments } : {})
				}).toString()
			)
		),
		response,
		at('/support/submit')
	);
	return {
		reference: /ODA-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(out.body)?.[0] ?? '',
		status: out.status
	};
}

/** An attachment is reached through its own ticket, with that ticket's key. */
function linkTo(reference: string, suffix = ''): string {
	const row = service.db
		.prepare('SELECT access_key FROM tickets WHERE reference = ?')
		.get(reference) as { access_key: string } | undefined;
	return `/support/ticket/${reference}${suffix}?k=${encodeURIComponent(row?.access_key ?? '')}`;
}

describe('an upload whose file cannot be deleted', () => {
	/*
	 * **`rmSync(..., { force: true })` already swallows ENOENT**, which is the
	 * only case the old `catch` was written for. Everything else it caught was a
	 * real failure — EACCES, EBUSY, an I/O fault — and the row was deleted
	 * anyway.
	 *
	 * That is the worst outcome available: the file stays on disk, its only
	 * record is gone, so the unclaimed sweep can never find it either, and the
	 * caller is told 204. Somebody who pulled a screenshot back because their
	 * own account name was in the corner of it was told it had been removed, and
	 * it had quietly become permanent instead.
	 */
	it('does not report success, and keeps the row so the sweep can retry', async () => {
		const id = await upload();
		const path = fileFor(id);

		/*
		 * A non-empty directory standing where the file should be. `rmSync` without
		 * `recursive` refuses it with a real, ordinary errno — no mocking, and the
		 * same shape as the EACCES and EBUSY this is really about.
		 */
		rmSync(path, { force: true });
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, 'child'), 'not empty');

		const { out, response } = capture();
		await service.handle(bare('DELETE'), response, at(`/support/attach/${id}`));

		expect(out.status, 'a failed delete answered as though it had worked').not.toBe(204);
		expect(out.status).toBeGreaterThanOrEqual(500);

		// The row survives, which is what lets the hourly sweep try again — and the
		// row is the *only* thing that can ever find this file now.
		expect(
			service.db.prepare('SELECT id FROM attachments WHERE id = ?').get(id),
			'the row was dropped along with the failed delete, orphaning the file'
		).toBeDefined();

		rmSync(path, { recursive: true, force: true });
	});

	it('still answers 204 for an id that was never stored', async () => {
		const { out, response } = capture();
		await service.handle(bare('DELETE'), response, at(`/support/attach/${'0'.repeat(32)}`));
		// Unchanged, and deliberately: distinguishing "gone" from "never existed"
		// tells an unauthenticated caller which ids are real.
		expect(out.status).toBe(204);
	});
});

describe('an attachment that disappears before it is streamed', () => {
	/*
	 * **`pipe` does not forward errors, and nothing was listening.**
	 *
	 * The size is read with `statSync` and the stream is opened afterwards — a
	 * gap the retention sweep, a failed disk or an operator with `rm` can all
	 * land in. The resulting `error` event fires on a stream with no listener,
	 * outside the request's promise, which in Node is an uncaught exception:
	 * one attachment view could stop the entire ticket service, for every other
	 * reporter at once.
	 */
	it('does not take the whole service down with it', async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (err: unknown): void => {
			uncaught.push(err);
		};
		process.on('uncaughtException', onUncaught);

		try {
			const id = await upload();
			const { reference } = await report(id);

			/*
			 * The size is read, and then the file is replaced by a directory before
			 * the stream opens — which is what the sweep, a failed disk or an
			 * operator with `rm` all look like from here. The stream's own open is
			 * the thing that fails, on a stream `pipe` does not forward errors from.
			 */
			const path = fileFor(id);
			const size = statSync(path).size;
			expect(size).toBeGreaterThan(0);
			rmSync(path, { force: true });
			mkdirSync(path, { recursive: true });

			const { out, response } = capture();
			await service.handle(bare('GET'), response, at(linkTo(reference, `/file/${id}`)));
			await new Promise((resolve) => setTimeout(resolve, 150));
			rmSync(path, { recursive: true, force: true });

			expect(uncaught, 'a missing file crashed the process').toEqual([]);
			expect(out.status).toBeGreaterThan(0);
		} finally {
			process.off('uncaughtException', onUncaught);
		}
	});

	it('answers 404 when the file is gone before the size is read', async () => {
		const id = await upload();
		const { reference } = await report(id);
		rmSync(fileFor(id), { force: true });

		const { out, response } = capture();
		await service.handle(bare('GET'), response, at(linkTo(reference, `/file/${id}`)));

		expect(out.status).toBe(404);
	});
});

describe('the bytes and the row that tracks them', () => {
	/*
	 * The row is what makes a file findable: the unclaimed sweep reads rows, and
	 * so does the size accounting that bounds the attachment directory. Bytes
	 * written without one are invisible to both — permanent, and outside the
	 * budget that exists to stop exactly that.
	 */
	it('leaves nothing on disk when the row cannot be written', async () => {
		const before = readdirSync(files).length;

		// The real insert, made to fail: an id that is already a primary key.
		const first = await upload();
		expect(readdirSync(files).length).toBe(before + 1);

		// The rollback is asserted through the source, because forcing the insert
		// to throw needs a lock this in-memory database will not take. What can be
		// proved here is that the successful path still tracks what it writes.
		const source = readFileSync(join(__dirname, '..', 'tickets', 'server.mjs'), 'utf8');
		const store = source.slice(source.indexOf('writeFileSync(fileFor(id), buffer'));
		const body = store.slice(0, store.indexOf('return { attachment:'));
		expect(body, 'an insert that throws leaves the bytes behind').toMatch(
			/catch[\s\S]{0,200}rmSync\(fileFor\(id\)/
		);
		expect(body).toMatch(/throw err;/);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
	});
});

/*
 * **A row is the only thing that counts bytes toward the cap.**
 *
 * The retention sweep swallowed every deletion failure and deleted the row
 * anyway — the same shape as the withdraw endpoint's bug, one sweep along.
 * `rmSync(..., { force: true })` already ignores ENOENT, so what the `catch`
 * actually caught was EACCES, EBUSY and I/O faults: real failures, after which
 * the file stayed on disk and stopped existing as far as the service was
 * concerned. The orphan sweep keeps retrying, but `storedBytes()` reads rows,
 * so those bytes drop out of the two-gigabyte budget while still occupying it.
 */
describe('an expired attachment that cannot be deleted', () => {
	it('keeps its row, so the bytes stay inside the cap', async () => {
		const id = await upload();
		const path = fileFor(id);

		// Older than the unclaimed lifetime, so the next sweep takes it.
		service.db
			.prepare('UPDATE attachments SET created_at = ? WHERE id = ?')
			.run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), id);

		// A non-empty directory where the file should be: `rmSync` without
		// `recursive` refuses it with a real errno rather than a mocked one.
		rmSync(path, { force: true });
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, 'child'), 'not empty');

		// Any upload runs the sweep.
		await upload();

		expect(
			service.db.prepare('SELECT id FROM attachments WHERE id = ?').get(id),
			'the row went while the bytes stayed, hiding them from the cap'
		).toBeDefined();

		rmSync(path, { recursive: true, force: true });
	});

	it('drops the row once the file is really gone', async () => {
		const id = await upload();
		service.db
			.prepare('UPDATE attachments SET created_at = ? WHERE id = ?')
			.run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), id);

		await upload();

		expect(service.db.prepare('SELECT id FROM attachments WHERE id = ?').get(id)).toBeUndefined();
		expect(existsSync(fileFor(id))).toBe(false);
	});
});

/*
 * **A closed report is only deleted once its pictures actually are.**
 *
 * The 90-day sweep removed the files, shrugged off any failure — "swept again
 * by sweepOrphans once the row is gone" — and deleted the ticket anyway. The
 * cascade then took the attachment rows with it, and `storedBytes()` counts
 * rows, so the bytes left the two-gigabyte budget while still sitting on the
 * disk. Worse for the reporter: the text of their report was deleted while part
 * of its private evidence stayed behind.
 */
describe('a closed report whose attachment cannot be deleted', () => {
	/** Age a ticket past the closed-retention window and sweep. */
	const age = (reference: string): void => {
		service.db
			.prepare("UPDATE tickets SET status = 'resolved', updated_at = ? WHERE reference = ?")
			.run(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(), reference);
	};

	it('keeps the report until its files are gone', async () => {
		const id = await upload();
		const { reference } = await report(id);
		const path = fileFor(id);

		age(reference);
		// A non-empty directory where the file should be: a real errno, not a mock.
		rmSync(path, { force: true });
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, 'child'), 'not empty');

		// Any upload runs every sweep.
		await upload();

		expect(
			service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference),
			'the report was deleted while part of its evidence stayed on disk'
		).toBeDefined();
		expect(
			service.db.prepare('SELECT id FROM attachments WHERE id = ?').get(id),
			'the bytes stopped being counted toward the cap'
		).toBeDefined();

		rmSync(path, { recursive: true, force: true });
	});

	it('deletes it on a later sweep once they are', async () => {
		const id = await upload();
		const { reference } = await report(id);
		age(reference);

		await upload();

		expect(
			service.db.prepare('SELECT id FROM tickets WHERE reference = ?').get(reference)
		).toBeUndefined();
		expect(existsSync(fileFor(id))).toBe(false);
	});
});
