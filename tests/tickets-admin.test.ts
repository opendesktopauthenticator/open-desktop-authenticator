import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The administrator side of the ticket service.
 *
 * Everything here guards a single account that can read every report anybody
 * has ever filed. There is no password reset and no second factor, so the
 * interesting questions are narrow: can the setup token be obtained by anyone
 * who should not have it, can a session be ended, and does the passphrase
 * actually gate the list.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });

beforeAll(async () => {
	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	service = await import('../tickets/server.mjs');
});

afterAll(() => service.server?.close?.());

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

function req(
	method: string,
	fields?: Record<string, string>,
	headers: Record<string, string> = {}
) {
	const base = { origin: 'https://opendesktopauthenticator.com', ...headers };
	if (!fields) {
		return { method, headers: base, socket: { remoteAddress: '10.1.0.1' } };
	}
	const body = new URLSearchParams(fields).toString();
	const request = Readable.from([Buffer.from(body)]) as unknown as Record<string, unknown>;
	request.method = method;
	request.headers = base;
	request.socket = { remoteAddress: '10.1.0.1' };
	return request;
}

const at = (p: string) => new URL(`https://opendesktopauthenticator.com${p}`);

/**
 * The setup token, read the way an operator reads it.
 *
 * It is deliberately not exported — the module keeps it private — so this
 * regenerates it and captures the line the service prints. Tests that need the
 * real secret have to obtain it honestly or they are not testing the real path.
 */
function currentToken(): string {
	const written: string[] = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	(process.stdout as unknown as Record<string, unknown>).write = (chunk: string) => {
		written.push(String(chunk));
		return true;
	};
	try {
		service.refreshBootstrap();
	} finally {
		(process.stdout as unknown as Record<string, unknown>).write = realWrite;
	}
	const token = /setup token: (\S+)/.exec(written.join(''))?.[1];
	if (!token) {
		throw new Error('no setup token was printed — is an administrator already configured?');
	}
	return token;
}

describe('the setup token never travels in a URL', () => {
	it('ignores the genuine token when it arrives as a query parameter', async () => {
		// **The point of the change.** A secret in a query string is written to the
		// access log as part of `$request`, repeated in the `$http_referer` of
		// every subresource the page loads, and kept in browser history. Accepting
		// one here would mean the safe path and the leaky path both work, and the
		// leaky one is the one that gets used because it is a single click.
		//
		// This has to use the *real* token. Sending a bogus one proves nothing —
		// it would be refused whether or not query parameters are honoured.
		const token = currentToken();
		const { out, response } = capture();
		await service.handleAdmin(
			req('POST', { passphrase: 'a-perfectly-long-passphrase' }),
			response,
			at(`/admin/bootstrap?token=${token}`)
		);
		expect(out.status).toBe(403);

		// And no administrator was created by that attempt.
		const after = capture();
		await service.handleAdmin(req('GET'), after.response, at('/admin/bootstrap'));
		expect(after.out.status, 'bootstrap should still be open').toBe(200);
	});

	it('does not put the token in the page it renders', async () => {
		const { out, response } = capture();
		await service.handleAdmin(req('GET'), response, at('/admin/bootstrap'));
		expect(out.status).toBe(200);
		// The form posts to a bare path — no token echoed into the action.
		expect(out.body).toContain('action="/admin/bootstrap"');
		expect(out.body).not.toMatch(/action="[^"]*token=/);
		// And it asks for the token as a field the browser will not remember.
		expect(out.body).toMatch(/name="token"[^>]*type="password"|type="password"[^>]*name="token"/);
	});

	it('refuses a wrong token in the body', async () => {
		const { out, response } = capture();
		await service.handleAdmin(
			req('POST', { token: 'wrong', passphrase: 'a-perfectly-long-passphrase' }),
			response,
			at('/admin/bootstrap')
		);
		expect(out.status).toBe(403);
	});

	it('rate-limits token guessing', async () => {
		// 192 bits is not guessable, but an unmetered guess endpoint is still a
		// free amplifier pointed at scrypt.
		let last = 0;
		for (let i = 0; i < 8; i++) {
			const { out, response } = capture();
			await service.handleAdmin(
				req('POST', { token: `guess-${i}`, passphrase: 'a-perfectly-long-passphrase' }),
				response,
				at('/admin/bootstrap')
			);
			last = out.status;
		}
		expect(last).toBe(429);
	});
});

describe('sessions', () => {
	const PASSPHRASE = 'correct-horse-battery-staple';
	let cookie = '';
	let csrf = '';

	/**
	 * Sign in for real.
	 *
	 * The token is deliberately not exported, so this reads it the way an operator
	 * does — off the service's own output — and then walks the whole flow. Asserting
	 * against a cookie string written in the test file would pass whatever the code
	 * did, which is worse than having no test.
	 */
	it('signs in through the real bootstrap flow', async () => {
		const token = currentToken();

		// A fresh address: the guessing test above deliberately exhausted 10.1.0.1.
		const from = { origin: 'https://opendesktopauthenticator.com' };
		const bootstrap = Readable.from([
			Buffer.from(new URLSearchParams({ token, passphrase: PASSPHRASE }).toString())
		]) as unknown as Record<string, unknown>;
		bootstrap.method = 'POST';
		bootstrap.headers = from;
		bootstrap.socket = { remoteAddress: '10.2.0.1' };

		const made = capture();
		await service.handleAdmin(bootstrap, made.response, at('/admin/bootstrap'));
		expect(made.out.status, made.out.body.slice(0, 300)).toBe(200);

		const login = Readable.from([
			Buffer.from(new URLSearchParams({ passphrase: PASSPHRASE }).toString())
		]) as unknown as Record<string, unknown>;
		login.method = 'POST';
		login.headers = from;
		login.socket = { remoteAddress: '10.2.0.1' };

		const signedIn = capture();
		await service.handleAdmin(login, signedIn.response, at('/admin/login'));
		expect(signedIn.out.status).toBe(303);

		const setCookie = signedIn.out.headers['set-cookie'] ?? '';
		// Scoped to /admin: nothing else reads it, so nothing else should carry it.
		expect(setCookie).toContain('Path=/admin');
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
		expect(setCookie).toContain('SameSite=Strict');
		const value = /admin=([^;]+)/.exec(setCookie)?.[1];
		expect(value).toBeTruthy();
		cookie = value ?? '';

		// And the session actually opens the list.
		const list = capture();
		await service.handleAdmin(
			req('GET', undefined, { cookie: `admin=${cookie}` }),
			list.response,
			at('/admin')
		);
		expect(list.out.body).toMatch(/Reports<\/h1>/);
		csrf = /name="csrf" value="([^"]+)"/.exec(list.out.body)?.[1] ?? '';
		expect(csrf).toBeTruthy();
	});

	it('refuses the wrong passphrase', async () => {
		const login = Readable.from([
			Buffer.from(new URLSearchParams({ passphrase: 'not the passphrase' }).toString())
		]) as unknown as Record<string, unknown>;
		login.method = 'POST';
		login.headers = { origin: 'https://opendesktopauthenticator.com' };
		login.socket = { remoteAddress: '10.3.0.1' };
		const { out, response } = capture();
		await service.handleAdmin(login, response, at('/admin/login'));
		expect(out.status).toBe(403);
		expect(out.body).not.toMatch(/Reports<\/h1>/);
	});

	it('ends the session when signing out, for real', async () => {
		const bye = Readable.from([
			Buffer.from(new URLSearchParams({ csrf }).toString())
		]) as unknown as Record<string, unknown>;
		bye.method = 'POST';
		bye.headers = { origin: 'https://opendesktopauthenticator.com', cookie: `admin=${cookie}` };
		bye.socket = { remoteAddress: '10.2.0.1' };

		const out1 = capture();
		await service.handleAdmin(bye, out1.response, at('/admin/logout'));
		expect(out1.out.status).toBe(303);

		// The cookie value is now worthless even if somebody kept a copy of it —
		// which is the whole point, and is what a cookie-clearing-only sign-out
		// would fail to achieve.
		const after = capture();
		await service.handleAdmin(
			req('GET', undefined, { cookie: `admin=${cookie}` }),
			after.response,
			at('/admin')
		);
		expect(after.out.body).toMatch(/Sign in/);
		expect(after.out.body).not.toMatch(/Reports<\/h1>/);
	});

	it('clears the cookie even with no session', async () => {
		// Without this the only way to end a session is to wait eight hours or
		// restart the service.
		const { out, response } = capture();
		await service.handleAdmin(req('POST', { csrf: 'irrelevant' }), response, at('/admin/logout'));
		expect(out.status).toBe(303);
		// The cookie is cleared even when there was no session to clear, so the
		// browser never keeps one the server has forgotten.
		expect(out.headers['set-cookie']).toMatch(/admin=;/);
		expect(out.headers['set-cookie']).toMatch(/Max-Age=0/);
	});

	it('will not sign an administrator out from another site', async () => {
		// A bare link that ends someone's session is a nuisance rather than a
		// breach, but it is still an action taken without their intent.
		const { out, response } = capture();
		await service.handleAdmin(req('GET'), response, at('/admin/logout'));
		// GET is not a route at all — only POST with the session's token is.
		expect(out.status).not.toBe(303);
	});
});

describe('the report list stays behind the passphrase', () => {
	it('shows the sign-in form to an unauthenticated visitor', async () => {
		const { out, response } = capture();
		await service.handleAdmin(req('GET'), response, at('/admin'));
		expect(out.body).toMatch(/Sign in/);
		expect(out.body).not.toMatch(/Reports<\/h1>/);
	});

	it('ignores a forged session cookie', async () => {
		const { out, response } = capture();
		await service.handleAdmin(
			req('GET', undefined, { cookie: 'admin=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
			response,
			at('/admin')
		);
		expect(out.body).toMatch(/Sign in/);
		expect(out.body).not.toMatch(/Reports<\/h1>/);
	});
});
