import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Uploads.
 *
 * Until now this service had no way to receive a file, and that was a security
 * property worth stating plainly: there was nothing to attack. Adding one gives
 * back the whole class of problems that come with accepting bytes from strangers
 * and handing them to a browser afterwards — so these tests are mostly about
 * what must *not* work.
 *
 * The one that matters most is the last: a file must never come back out of this
 * origin as something a browser will execute.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });
let files: string;

beforeAll(async () => {
	files = mkdtempSync(join(tmpdir(), 'oda-attach-'));
	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	process.env.TICKETS_FILES = files;
	service = await import('../tickets/server.mjs');
});

afterAll(() => {
	service.server?.close?.();
	rmSync(files, { recursive: true, force: true });
});

const pad = (bytes: number[], size = 64) =>
	Buffer.concat([Buffer.from(bytes), Buffer.alloc(Math.max(0, size - bytes.length))]);

const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff]);
const GIF = pad([0x47, 0x49, 0x46, 0x38]);
const WEBP = Buffer.concat([
	Buffer.from('RIFF'),
	Buffer.alloc(4),
	Buffer.from('WEBP'),
	Buffer.alloc(52)
]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(56)]);
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3]);

function capture() {
	const out = { status: 0, body: '', raw: Buffer.alloc(0), headers: {} as Record<string, string> };
	const response = {
		headersSent: false,
		writeHead(status: number, headers: Record<string, string>) {
			out.status = status;
			out.headers = headers ?? {};
			return this;
		},
		end(body: string | Buffer) {
			if (Buffer.isBuffer(body)) {
				out.raw = body;
				out.body = body.toString('binary');
			} else {
				out.body = body ?? '';
			}
		}
	};
	return { out, response };
}

const at = (p: string) => new URL(`https://opendesktopauthenticator.com${p}`);
const ORIGIN = { origin: 'https://opendesktopauthenticator.com' };

/*
 * A fresh address per request.
 *
 * The service rate-limits uploads and submissions per client, correctly. A test
 * file that reused one address would exhaust that budget partway through and
 * then report failures that are really the limiter doing its job — which is
 * exactly what the first run of this file did.
 */
let nth = 0;
const someAddress = () => {
	nth += 1;
	return `10.${(nth >> 16) & 255}.${(nth >> 8) & 255}.${nth & 255}`;
};

function bodyRequest(payload: Buffer, headers: Record<string, string> = {}, ip = someAddress()) {
	const request = Readable.from([payload]) as unknown as Record<string, unknown>;
	request.method = 'POST';
	request.headers = { ...ORIGIN, ...headers };
	request.socket = { remoteAddress: ip };
	return request;
}

function formRequest(fields: Record<string, string>, ip = someAddress()) {
	const request = Readable.from([
		Buffer.from(new URLSearchParams(fields).toString())
	]) as unknown as Record<string, unknown>;
	request.method = 'POST';
	request.headers = { ...ORIGIN };
	request.socket = { remoteAddress: ip };
	return request;
}

const getRequest = (ip = someAddress()) => ({
	method: 'GET',
	headers: {},
	socket: { remoteAddress: ip }
});

/** Upload one file and return its id. */
async function upload(payload: Buffer, headers = {}, ip?: string) {
	const { out, response } = capture();
	await service.handle(bodyRequest(payload, headers, ip), response, at('/support/attach'));
	const parsed = out.status === 200 ? (JSON.parse(out.body) as { id: string }) : undefined;
	return { out, id: parsed?.id };
}

/** File a report, optionally claiming uploads, and return its reference. */
async function report(attachments?: string, ip?: string) {
	const { out, response } = capture();
	await service.handle(
		formRequest(
			{
				kind: 'bug',
				summary: 'A report used by the attachment tests',
				detail: 'Long enough to pass validation, and describing nothing in particular at all.',
				...(attachments ? { attachments } : {})
			},
			ip
		),
		response,
		at('/support/submit')
	);
	return /ODA-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(out.body)?.[0] as string;
}

describe('what the bytes actually are', () => {
	it.each([
		['PNG', PNG, 'image/png'],
		['JPEG', JPEG, 'image/jpeg'],
		['GIF', GIF, 'image/gif'],
		['WebP', WEBP, 'image/webp'],
		['MP4', MP4, 'video/mp4'],
		['WebM', WEBM, 'video/webm']
	])('accepts a %s', (_name, payload, type) => {
		expect(service.sniff(payload)?.type).toBe(type);
	});

	it.each([
		['HTML', Buffer.from('<html><body><script>alert(1)</script></body></html>')],
		[
			'an SVG carrying script',
			Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
		],
		['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n')],
		['a PHP file', Buffer.from('<?php system($_GET["c"]); ?>\n\n\n\n\n\n')],
		['plain text', Buffer.from('just some words, at least sixteen of them here')],
		['a zip', pad([0x50, 0x4b, 0x03, 0x04])],
		['an ELF binary', pad([0x7f, 0x45, 0x4c, 0x46])],
		['nothing at all', Buffer.alloc(0)],
		['too few bytes to identify', Buffer.from([0x89, 0x50])]
	])('refuses %s', (_name, payload) => {
		expect(service.sniff(payload)).toBeUndefined();
	});

	it('refuses an SVG even though it is an image everywhere else', () => {
		// Called out on its own because it is the one exclusion that looks like an
		// oversight. An SVG can carry script and event handlers, so serving one
		// from this origin would hand back the execution everything else denies.
		expect(
			service.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10"></svg>'))
		).toBeUndefined();
	});
});

describe('the declared type is never believed', () => {
	it('refuses HTML no matter what the request calls it', async () => {
		// A content type is a string the uploader picks. If it were trusted, this
		// would be a stored-XSS delivery service.
		const { out } = await upload(
			Buffer.from('<html><script>alert(document.domain)</script></html>'),
			{
				'content-type': 'image/png'
			}
		);
		expect(out.status).toBe(415);
	});

	it('records the sniffed type, not the sent one', async () => {
		const { out, id } = await upload(PNG, { 'content-type': 'video/mp4' });
		expect(out.status).toBe(200);
		expect((JSON.parse(out.body) as { type: string }).type).toBe('image/png');
		expect(id).toMatch(/^[0-9a-f]{32}$/);
	});

	it('accepts a real PNG with an HTML payload glued to the end, and still calls it a PNG', async () => {
		// A polyglot passes the signature check by being a genuine PNG. That is
		// fine as long as it is only ever served as image/png with nosniff, which
		// is what the serving test below pins down.
		const { out } = await upload(Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]));
		expect(out.status).toBe(200);
		expect((JSON.parse(out.body) as { type: string }).type).toBe('image/png');
	});
});

describe('size', () => {
	it('refuses an image over six megabytes', async () => {
		const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
		const { out } = await upload(big);
		expect(out.status).toBe(415);
		expect(out.body).toMatch(/limit/i);
	});

	it('refuses a body past the largest thing we take at all', async () => {
		const huge = Buffer.concat([MP4, Buffer.alloc(21 * 1024 * 1024)]);
		const { out } = await upload(huge);
		expect(out.status).toBe(413);
	});

	it('allows a video larger than the image limit', async () => {
		const clip = Buffer.concat([MP4, Buffer.alloc(8 * 1024 * 1024)]);
		const { out } = await upload(clip);
		expect(out.status).toBe(200);
	});
});

describe('who may fetch a file', () => {
	it('serves an attachment through the report that owns it', async () => {
		const { id } = await upload(PNG);
		const reference = await report(id);

		const { out, response } = capture();
		await service.handle(getRequest(), response, at(`/support/ticket/${reference}/file/${id}`));
		expect(out.status).toBe(200);
		expect(out.headers['content-type']).toBe('image/png');
		expect(out.raw.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
	});

	it('refuses the same file under a different report', async () => {
		// **The isolation that matters.** The reference is the capability for the
		// page, so a file on it must be reachable on exactly those terms and no
		// looser. Otherwise a valid id alone would be enough.
		const { id } = await upload(PNG);
		await report(id);
		const other = await report();

		const { out, response } = capture();
		await service.handle(getRequest(), response, at(`/support/ticket/${other}/file/${id}`));
		expect(out.status).toBe(404);
	});

	it('refuses an id that was never claimed', async () => {
		const { id } = await upload(JPEG);
		const reference = await report();
		const { out, response } = capture();
		await service.handle(getRequest(), response, at(`/support/ticket/${reference}/file/${id}`));
		expect(out.status).toBe(404);
	});

	it.each([
		['a traversal', '../../../../etc/passwd'],
		['an absolute path', '/etc/passwd'],
		['a windows path', '..%5C..%5Cwindows%5Cwin.ini'],
		['a null byte', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%00.png'],
		['a wrong-length id', 'abc123']
	])('does not route %s to a file at all', async (_name, evil) => {
		const reference = await report();
		const { out, response } = capture();
		const served = await service.handle(
			getRequest(),
			response,
			at(`/support/ticket/${reference}/file/${evil}`)
		);

		// The route pattern only matches 32 hex characters, so none of these are
		// file requests. `handle` returning undefined means no route claimed it —
		// the real server turns that into a 404 — and the important part is that
		// nothing was read off disk and nothing was sent back as a file.
		expect(served).toBeUndefined();
		expect(out.status).not.toBe(200);
		expect(out.headers['content-type']).toBeUndefined();
		expect(out.raw.length).toBe(0);
	});

	it('refuses to build a path out of an id it did not generate', () => {
		// Belt and braces behind the route pattern: even called directly, the
		// helper will not turn a hostile string into a filesystem path.
		expect(() => service.fileFor('../../etc/passwd')).toThrow();
		expect(() => service.fileFor('')).toThrow();
	});
});

describe('how a file is served back', () => {
	it('pins the headers that keep it from executing', async () => {
		const { id } = await upload(PNG);
		const reference = await report(id);
		const { out, response } = capture();
		await service.handle(getRequest(), response, at(`/support/ticket/${reference}/file/${id}`));

		// nosniff: the browser must not go looking for a second opinion about
		// what this is, which is how a polyglot would get interpreted as markup.
		expect(out.headers['x-content-type-options']).toBe('nosniff');
		// A sandboxed, source-less CSP: even if something were interpreted, it
		// may load nothing and run nothing.
		expect(out.headers['content-security-policy']).toMatch(/default-src 'none'/);
		expect(out.headers['content-security-policy']).toMatch(/sandbox/);
		// Somebody else's screenshot is not for a shared cache.
		expect(out.headers['cache-control']).toBe('private, no-store');
		expect(out.headers['cross-origin-resource-policy']).toBe('same-origin');
		// The filename offered is ours, built from the reference and the id.
		expect(out.headers['content-disposition']).toContain(reference);
		expect(out.headers['content-disposition']).not.toMatch(/\.\.|[/\\]/);
	});

	it('never serves a stored file as html', async () => {
		const { id } = await upload(Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]));
		const reference = await report(id);
		const { out, response } = capture();
		await service.handle(getRequest(), response, at(`/support/ticket/${reference}/file/${id}`));
		expect(out.headers['content-type']).toBe('image/png');
		expect(out.headers['content-type']).not.toMatch(/html|xml|javascript/);
	});
});

describe('claiming', () => {
	it('will not let a claimed file be re-pinned to a second report', async () => {
		const { id } = await upload(GIF);
		const first = await report(id);
		const second = await report(id);

		const a = capture();
		await service.handle(getRequest(), a.response, at(`/support/ticket/${first}/file/${id}`));
		const b = capture();
		await service.handle(getRequest(), b.response, at(`/support/ticket/${second}/file/${id}`));

		expect(a.out.status).toBe(200);
		expect(b.out.status).toBe(404);
	});

	it('ignores ids that are not ours', async () => {
		const reference = await report('../../etc/passwd,not-an-id,' + 'f'.repeat(32));
		expect(reference).toMatch(/^ODA-/);
	});

	it('takes no more than four files', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			const { id } = await upload(PNG);
			if (id) ids.push(id);
		}
		expect(ids.length).toBe(6);
		const reference = await report(ids.join(','));

		let served = 0;
		for (const id of ids) {
			const { out, response } = capture();
			await service.handle(getRequest(), response, at(`/support/ticket/${reference}/file/${id}`));
			if (out.status === 200) served += 1;
		}
		expect(served).toBe(4);
	});
});

describe('storage', () => {
	it('writes with a name it generated, not one it was given', async () => {
		const { id } = await upload(WEBP);
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		// The file on disk is exactly the id — no extension, no original name.
		expect(
			readFileSync(join(files, id ?? ''))
				.subarray(0, 4)
				.toString()
		).toBe('RIFF');
	});

	it('sweeps uploads nobody ever attached to a report', async () => {
		const { id } = await upload(JPEG);
		// Backdate it past the unclaimed lifetime.
		service.db
			.prepare('UPDATE attachments SET created_at = ? WHERE id = ?')
			.run('2020-01-01T00:00:00.000Z', id ?? '');

		await upload(PNG); // any upload triggers the sweep
		const row = service.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id ?? '');
		expect(row).toBeUndefined();
		expect(() => readFileSync(join(files, id ?? ''))).toThrow();
	});
});

describe('where an upload may come from', () => {
	it('refuses an upload posted from another site', async () => {
		const request = Readable.from([PNG]) as unknown as Record<string, unknown>;
		request.method = 'POST';
		request.headers = { origin: 'https://evil.example' };
		request.socket = { remoteAddress: '10.7.0.1' };
		const { out, response } = capture();
		await service.handle(request, response, at('/support/attach'));
		expect(out.status).toBe(403);
	});
});
