import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Resource limits, and the two ways this service could quietly ruin its own box.
 *
 * Everything else in these suites asks whether a request is answered correctly.
 * These ask what happens after ten thousand of them: whether the disk fills,
 * whether files outlive the rows that describe them, and whether rendering a
 * page does more work than rendering a page needs to.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });
let files: string;
let publicDir: string;

beforeAll(async () => {
	files = mkdtempSync(join(tmpdir(), 'oda-res-'));
	publicDir = mkdtempSync(join(tmpdir(), 'oda-pub-'));
	// A stand-in for the deployed site, so the asset lookups have something real.
	writeFileSync(
		join(publicDir, 'index.html'),
		'<link rel="stylesheet" href="/assets/site.aaaaaaaaaa.css"><img src="/assets/mark.bbbbbbbbbb.svg">'
	);
	writeFileSync(join(publicDir, 'owners.html'), '"/assets/projects/masterspanel.cccccccccc.svg"');
	writeFileSync(join(publicDir, 'support.html'), '<script src="/assets/support.dddddddddd.js">');

	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	process.env.TICKETS_FILES = files;
	process.env.TICKETS_PUBLIC = publicDir;
	service = await import('../tickets/server.mjs');
});

afterAll(() => {
	service.server?.close?.();
	rmSync(files, { recursive: true, force: true });
	rmSync(publicDir, { recursive: true, force: true });
});

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(56)
]);

let nth = 0;
const someAddress = () => {
	nth += 1;
	return `192.168.${(nth >> 8) & 255}.${nth & 255}`;
};

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

const at = (p: string) => new URL(`https://opendesktopauthenticator.com${p}`);

function upload(payload: Buffer) {
	const request = Readable.from([payload]) as unknown as Record<string, unknown>;
	request.method = 'POST';
	request.headers = { origin: 'https://opendesktopauthenticator.com' };
	request.socket = { remoteAddress: someAddress() };
	return request;
}

describe('total storage is bounded', () => {
	it('refuses an upload that would take the store past its limit', async () => {
		// **The gap this closes.** Every other limit is per-file or per-address, and
		// none of them bounds the total. Four files a report, five reports every ten
		// minutes, twenty megabytes each, and a claimed attachment is never deleted:
		// that is a disk filled in under a day, taking SQLite's writes and nginx's
		// logging down with it — a failure well outside the part being abused.
		const rows = service.db.prepare(
			'INSERT INTO attachments (id, ticket_id, media_type, bytes, created_at) VALUES (?, NULL, ?, ?, ?)'
		);
		// Claim almost the whole budget with rows that describe large files.
		// 210 x 10 MiB is 2100 MiB, past the 2048 MiB budget. 200 was not.
		for (let i = 0; i < 210; i++) {
			rows.run(
				i.toString(16).padStart(32, '0'),
				'image/png',
				10 * 1024 * 1024,
				new Date().toISOString()
			);
		}

		const { out, response } = capture();
		await service.handle(upload(PNG), response, at('/support/attach'));
		expect(out.status).toBe(415);
		expect(out.body).toMatch(/out of room/i);

		// Clean up so the later tests start from an empty store.
		service.db.prepare('DELETE FROM attachments').run();
	});

	it('accepts uploads again once there is room', async () => {
		const { out, response } = capture();
		await service.handle(upload(PNG), response, at('/support/attach'));
		expect(out.status).toBe(200);
	});

	it('reports the text-only path as the way through', async () => {
		// Refusing an attachment must not read as "your report was refused". The
		// report is the thing that matters; the picture is attached to it.
		const rows = service.db.prepare(
			'INSERT INTO attachments (id, ticket_id, media_type, bytes, created_at) VALUES (?, NULL, ?, ?, ?)'
		);
		for (let i = 0; i < 210; i++) {
			rows.run(
				('f' + i.toString(16)).padStart(32, '0'),
				'image/png',
				10 * 1024 * 1024,
				new Date().toISOString()
			);
		}
		const { out, response } = capture();
		await service.handle(upload(PNG), response, at('/support/attach'));
		expect(out.body).toMatch(/without one/i);
		service.db.prepare('DELETE FROM attachments').run();
	});
});

describe('files do not outlive their rows', () => {
	it('removes a file whose row has gone', async () => {
		// `ticket_id` cascades on delete, so removing a report takes the attachment
		// rows with it and leaves the files — SQLite has no idea the filesystem
		// exists. Nothing deletes reports today, which is why this is worth having
		// before something does: the leak would be silent and permanent.
		const orphan = 'a'.repeat(32);
		mkdirSync(files, { recursive: true });
		writeFileSync(join(files, orphan), PNG);
		expect(readdirSync(files)).toContain(orphan);

		// Any upload triggers the sweep.
		const { response } = capture();
		await service.handle(upload(PNG), response, at('/support/attach'));

		expect(readdirSync(files)).not.toContain(orphan);
	});

	it('leaves files that still have a row', async () => {
		const { out, response } = capture();
		await service.handle(upload(PNG), response, at('/support/attach'));
		const id = (JSON.parse(out.body) as { id: string }).id;
		expect(readdirSync(files)).toContain(id);

		// A second upload sweeps again; the first must survive it.
		const again = capture();
		await service.handle(upload(PNG), again.response, at('/support/attach'));
		expect(readdirSync(files)).toContain(id);
	});

	it('does not delete anything it cannot account for by name', async () => {
		// A stray file that is not shaped like one of ours is somebody else's
		// problem and not ours to remove.
		const stray = 'not-one-of-ours.txt';
		writeFileSync(join(files, stray), 'left here by something else');
		const { response } = capture();
		await service.handle(upload(PNG), response, at('/support/attach'));
		expect(readdirSync(files)).toContain(stray);
		rmSync(join(files, stray), { force: true });
	});
});

describe('rendering a page does not re-read the site every time', () => {
	it('serves the hashed asset paths out of the built pages', async () => {
		const { out, response } = capture();
		await service.handle(
			{ method: 'GET', headers: {}, socket: {} },
			response,
			at('/support/ticket/ODA-2222-2222')
		);
		expect(out.body).toContain('/assets/site.aaaaaaaaaa.css');
		expect(out.body).toContain('/assets/mark.bbbbbbbbbb.svg');
		expect(out.body).toContain('/assets/support.dddddddddd.js');
		expect(out.body).toContain('/assets/projects/masterspanel.cccccccccc.svg');
	});

	it('picks up a deploy rather than serving a stale path forever', async () => {
		// **The risk a cache introduces.** Caching these forever would mean the
		// first deploy after a restart left every service page pointing at a
		// stylesheet that no longer exists — styled correctly right up until it
		// silently was not. Keyed on the file's modification time, so a deploy is
		// visible on the very next request with nothing to remember to clear.
		writeFileSync(
			join(publicDir, 'index.html'),
			'<link rel="stylesheet" href="/assets/site.9999999999.css"><img src="/assets/mark.8888888888.svg">'
		);
		// Ensure the mtime actually differs on a coarse-grained filesystem.
		await new Promise((r) => setTimeout(r, 15));
		writeFileSync(
			join(publicDir, 'index.html'),
			'<link rel="stylesheet" href="/assets/site.9999999999.css"><img src="/assets/mark.8888888888.svg">'
		);

		const { out, response } = capture();
		await service.handle(
			{ method: 'GET', headers: {}, socket: {} },
			response,
			at('/support/ticket/ODA-3333-3333')
		);
		expect(out.body).toContain('/assets/site.9999999999.css');
		expect(out.body).toContain('/assets/mark.8888888888.svg');
		expect(out.body).not.toContain('/assets/site.aaaaaaaaaa.css');
	});

	it('falls back to an unhashed path when the built site is missing', async () => {
		// Rendering must not fail because the site is mid-deploy.
		rmSync(join(publicDir, 'owners.html'), { force: true });
		const { out, response } = capture();
		await service.handle(
			{ method: 'GET', headers: {}, socket: {} },
			response,
			at('/support/ticket/ODA-4444-4444')
		);
		expect(out.status).toBe(404);
		expect(out.body).toContain('/assets/projects/masterspanel.svg');
	});
});
