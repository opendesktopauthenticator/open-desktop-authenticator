import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const ORIGIN = 'https://opendesktopauthenticator.com';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TOTAL = 1024;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (predicate()) return;
		await wait(20);
	}
	if (!predicate()) throw new Error('the expected ticket-service state did not arrive');
}

function beginUpload(
	port: number,
	address: string
): {
	request: ClientRequest;
	answer: Promise<number>;
} {
	let request: ClientRequest;
	const answer = new Promise<number>((resolve, reject) => {
		let answered = false;
		request = httpRequest(
			{
				host: '127.0.0.1',
				port,
				path: '/support/attach',
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'x-real-ip': address,
					'content-type': 'application/octet-stream',
					'content-length': String(TOTAL)
				}
			},
			(response) => {
				answered = true;
				response.resume();
				response.once('end', () => resolve(response.statusCode ?? 0));
			}
		);
		request.once('error', (error) => {
			if (!answered) reject(error);
		});
	});
	request!.flushHeaders();
	request!.write(PNG);
	return { request: request!, answer };
}

function finish(request: ClientRequest): void {
	request.end(Buffer.alloc(TOTAL - PNG.length, 0x41));
}

function portOf(server: { address(): string | null | { port: number } }): number {
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the ticket service did not bind a loopback port');
	}
	return address.port;
}

describe('ticket-service backup quiescing', () => {
	let root = '';
	let files = '';
	let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), 'oda-ticket-drain-'));
		files = join(root, 'attachments');
		mkdirSync(files);
		process.env.TICKETS_DB = ':memory:';
		process.env.TICKETS_FILES = files;
		process.env.TICKETS_NO_LISTEN = '1';
		service = await import('../tickets/server.mjs');
		service.server.listen(0, '127.0.0.1');
		await once(service.server, 'listening');
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it('drains a finishing upload and cleans a stalled one before shutdown completes', async () => {
		const port = portOf(service.server);
		const finishing = beginUpload(port, '10.81.0.1');
		const stalled = beginUpload(port, '10.81.0.2');
		await waitFor(
			() => readdirSync(files).filter((name) => name.startsWith('incoming-')).length === 2
		);

		let closed = false;
		const shutdown = service.shutdownTicketServer({ forceAfterMs: 500 }).then(() => {
			closed = true;
		});
		await wait(50);
		expect(closed, 'shutdown returned while accepted uploads were still active').toBe(false);

		finish(finishing.request);
		expect(await finishing.answer).toBe(200);
		// The second client never finishes. The bounded fallback must close it and
		// let receiveUpload run its own partial-file cleanup.
		await stalled.answer.catch(() => 0);
		await shutdown;

		const names = readdirSync(files);
		expect(names.some((name) => name.startsWith('incoming-'))).toBe(false);
		expect(names.filter((name) => /^[0-9a-f]{32}$/.test(name))).toHaveLength(1);
	}, 10_000);
});

async function childReady(child: ChildProcess): Promise<number> {
	let output = '';
	return await Promise.race([
		new Promise<number>((resolve, reject) => {
			child.stdout?.on('data', (chunk: Buffer) => {
				output += chunk.toString('utf8');
				const match = /READY:(\d+)/.exec(output);
				if (match) resolve(Number(match[1]));
			});
			child.once('exit', () => reject(new Error('ticket-service child exited before listening')));
		}),
		wait(5000).then(() => {
			throw new Error('ticket-service child did not start within five seconds');
		})
	]);
}

describe.skipIf(process.platform === 'win32')('the installed SIGTERM path', () => {
	it('keeps an accepted upload alive until it finishes, then exits cleanly', async () => {
		const root = mkdtempSync(join(tmpdir(), 'oda-ticket-signal-'));
		const files = join(root, 'attachments');
		mkdirSync(files);
		const moduleUrl = pathToFileURL(join(ROOT, 'tickets', 'server.mjs')).href;
		const program = `
			const service = await import(${JSON.stringify(moduleUrl)});
			const ready = () => console.log('READY:' + service.server.address().port);
			if (service.server.listening) ready(); else service.server.once('listening', ready);
		`;
		const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				PORT: '0',
				TICKETS_DB: join(root, 'tickets.db'),
				TICKETS_FILES: files,
				TICKETS_NO_LISTEN: ''
			}
		});
		try {
			const port = await childReady(child);
			const upload = beginUpload(port, '10.82.0.1');
			await waitFor(() => readdirSync(files).some((name) => name.startsWith('incoming-')));
			expect(child.kill('SIGTERM')).toBe(true);
			await wait(50);
			finish(upload.request);
			expect(await upload.answer).toBe(200);
			const [code, signal] = (await Promise.race([
				once(child, 'exit'),
				wait(5000).then(() => {
					throw new Error('ticket-service child did not exit after draining its upload');
				})
			])) as [number | null, NodeJS.Signals | null];
			expect(signal).toBeNull();
			expect(code).toBe(0);
			expect(readdirSync(files).some((name) => name.startsWith('incoming-'))).toBe(false);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);
});
