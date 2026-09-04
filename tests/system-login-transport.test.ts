import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient, type HttpRequestOptions } from '@doctormckay/stdlib/http';
import type { ApiRequest } from 'steam-session';
import WebApiTransport from 'steam-session/dist/transports/WebApiTransport';
import type { ElectronNetworking, ProxyCapableSession } from '../src/main/net/transport';
import { createSystemAwareLoginSessionFactory, signIn } from '../src/main/steam/login';
import {
	createSystemLoginTransportFactory,
	ORIGIN_AUTH_REFUSED,
	SYSTEM_PROXY_AUTH_REQUIRED,
	SystemLoginTransport
} from '../src/main/steam/system-login-transport';

type RequestOptions = Parameters<ElectronNetworking['request']>[0];
type BeforeSendHeaders = Parameters<
	NonNullable<ProxyCapableSession['webRequest']>['onBeforeSendHeaders']
>[0];

class FakeResponse {
	readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

	constructor(
		readonly statusCode = 200,
		readonly headers: Record<string, string | string[] | undefined> = {}
	) {}

	on(event: string, listener: (...args: never[]) => void): void {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}

	emitData(chunk: Buffer | string): void {
		for (const listener of this.listeners.get('data') ?? []) listener(chunk as never);
	}

	emitEnd(): void {
		for (const listener of this.listeners.get('end') ?? []) listener();
	}
}

class FakeRequest {
	readonly headers = new Map<string, string>();
	readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
	body = '';
	aborts = 0;
	throwAt: 'setHeader' | 'write' | 'end' | undefined;

	setHeader(name: string, value: string): void {
		if (this.throwAt === 'setHeader') throw new Error('setHeader failed');
		this.headers.set(name, value);
	}

	write(chunk: string): void {
		if (this.throwAt === 'write') throw new Error('write failed');
		this.body += chunk;
	}

	end(): void {
		if (this.throwAt === 'end') throw new Error('end failed');
		// Electron owns Content-Length and derives it from the completed upload.
		if (this.body !== '') this.headers.set('content-length', String(Buffer.byteLength(this.body)));
	}

	abort(): void {
		this.aborts += 1;
	}

	on(event: string, listener: (...args: never[]) => void): void {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}

	respond(response: FakeResponse): void {
		for (const listener of this.listeners.get('response') ?? [])
			listener(response as unknown as never);
	}

	emitError(error: Error): void {
		for (const listener of this.listeners.get('error') ?? []) listener(error as never);
	}

	emitLogin(
		authInfo: { isProxy: boolean; host?: string; realm?: string },
		callback: (username?: string, password?: string) => void
	): void {
		for (const listener of this.listeners.get('login') ?? []) {
			listener(authInfo as never, callback as never);
		}
	}
}

function harness(setProxy: () => Promise<void> = () => Promise.resolve()): {
	networking: ElectronNetworking;
	session: ProxyCapableSession;
	handle: FakeRequest;
	handles: FakeRequest[];
	requests: RequestOptions[];
	partitions: string[];
	applyProxy: ReturnType<typeof vi.fn<() => Promise<void>>>;
	clearStorageData: ReturnType<typeof vi.fn<() => Promise<void>>>;
	closeAllConnections: ReturnType<typeof vi.fn<() => Promise<void>>>;
	applySessionHeaders(input: Record<string, string>): Record<string, string>;
} {
	const requests: RequestOptions[] = [];
	const partitions: string[] = [];
	const handle = new FakeRequest();
	const handles: FakeRequest[] = [];
	const clearStorageData = vi.fn(() => Promise.resolve());
	const closeAllConnections = vi.fn(() => Promise.resolve());
	const applyProxy = vi.fn(setProxy);
	let beforeSendHeaders: BeforeSendHeaders | undefined;
	const session: ProxyCapableSession = {
		setProxy: applyProxy,
		resolveProxy: vi.fn(() => Promise.resolve('DIRECT')),
		clearStorageData,
		closeAllConnections,
		webRequest: {
			onBeforeSendHeaders: (listener) => {
				beforeSendHeaders = listener;
			}
		}
	};
	return {
		handle,
		handles,
		requests,
		partitions,
		applyProxy,
		session,
		clearStorageData,
		closeAllConnections,
		applySessionHeaders: (input) => {
			if (beforeSendHeaders === undefined) throw new Error('the session hook was not installed');
			let output: Record<string, string> | undefined;
			beforeSendHeaders({ requestHeaders: input }, (result) => {
				output = result.requestHeaders;
			});
			if (output === undefined) throw new Error('the session hook did not answer');
			return output;
		},
		networking: {
			sessionFromPartition: vi.fn((partition: string) => {
				partitions.push(partition);
				return session;
			}),
			request: vi.fn((options: RequestOptions) => {
				requests.push(options);
				const next = handles.length === 0 ? handle : new FakeRequest();
				handles.push(next);
				return next;
			})
		}
	};
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	return {
		promise: new Promise<void>((done, fail) => {
			resolve = done;
			reject = fail;
		}),
		resolve,
		reject
	};
}

function beginRequest(): ApiRequest {
	return {
		apiInterface: 'Authentication',
		apiMethod: 'BeginAuthSessionViaCredentials',
		apiVersion: 1,
		requestData: Buffer.from([0xfb, 0xff]),
		headers: { 'x-client': 'mobile' }
	};
}

async function dependencyMultipart(request: ApiRequest): Promise<{
	body: string;
	contentType: string;
	contentLength: string;
}> {
	let captured: { body: string; contentType: string; contentLength: string } | undefined;
	const server = createServer((incoming, response) => {
		const chunks: Buffer[] = [];
		incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
		incoming.on('end', () => {
			captured = {
				body: Buffer.concat(chunks).toString('utf8'),
				contentType: String(incoming.headers['content-type']),
				contentLength: String(incoming.headers['content-length'])
			};
			response.writeHead(200);
			response.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	try {
		const address = server.address() as AddressInfo;
		const client = new HttpClient();
		const original = client.request.bind(client);
		client.request = (options: HttpRequestOptions) => {
			const intended = new URL(options.url);
			return original({
				...options,
				url: `http://127.0.0.1:${address.port}${intended.pathname}${intended.search}`
			});
		};
		await new WebApiTransport(client).sendRequest(request);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	if (captured === undefined) throw new Error('the installed dependency did not emit a request');
	return captured;
}

describe('system-routed steam-session transport', () => {
	it('bounds every login attempt to one non-persistent session', async () => {
		const h = harness();
		const factory = createSystemLoginTransportFactory(h.networking);
		const first = factory();
		const second = factory();

		expect(h.partitions).toEqual(['steam-login-system']);
		expect(h.partitions.every((partition) => !partition.startsWith('persist:'))).toBe(true);
		first.close();
		second.close();
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledOnce());
	});

	it('does not lease the shared session until Guard-code preconditions pass', async () => {
		const h = harness();
		const systemFactory = createSystemLoginTransportFactory(h.networking);
		const loginFactory = createSystemAwareLoginSessionFactory(systemFactory);
		const base = {
			accountName: 'account',
			password: 'password',
			unixSeconds: 1_700_000_000
		};

		await expect(signIn(base, undefined, loginFactory)).rejects.toThrow(/Guard code/i);
		await expect(
			signIn({ ...base, sharedSecret: 'not-valid-base64!' }, undefined, loginFactory)
		).rejects.toThrow(/not valid base64/i);
		expect(h.partitions, 'a refused precondition acquired an Electron session').toEqual([]);

		// A valid request reaches the real steam-session/SystemLoginTransport seam.
		// Its forced transport failure must release the only lease and retire the
		// owner, proving the earlier refusals left no hidden reference behind.
		const valid = signIn({ ...base, steamGuardCode: 'QK4TX' }, undefined, loginFactory);
		const rejected = expect(valid).rejects.toThrow(/offline after route setup/i);
		await vi.waitFor(() => expect(h.handles).toHaveLength(1));
		h.handle.emitError(new Error('offline after route setup'));
		await rejected;
		await vi.waitFor(() => expect(h.closeAllConnections).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledOnce());
	});

	it('keeps concurrent attempts request-scoped and retires only the final lease', async () => {
		const h = harness();
		const factory = createSystemLoginTransportFactory(h.networking);
		const first = factory();
		const second = factory();
		const firstPending = first.sendRequest(beginRequest());
		const firstRejected = expect(firstPending).rejects.toThrow(/cancelled/i);
		const secondPending = second.sendRequest(beginRequest());
		await vi.waitFor(() => expect(h.handles).toHaveLength(2));

		first.close();
		await firstRejected;
		expect(h.handles[0]?.aborts).toBe(1);
		expect(h.handles[1]?.aborts).toBe(0);
		expect(h.closeAllConnections).not.toHaveBeenCalled();
		expect(h.clearStorageData).not.toHaveBeenCalled();

		const response = new FakeResponse();
		h.handles[1]?.respond(response);
		response.emitEnd();
		await expect(secondPending).resolves.toEqual({});
		second.close();
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledOnce());
	});

	it('finishes idle cleanup before a later lease can send on the reused session', async () => {
		const closeGate = deferred();
		const clearGate = deferred();
		const h = harness();
		h.closeAllConnections.mockImplementation(() => closeGate.promise);
		h.clearStorageData.mockImplementation(() => clearGate.promise);
		const factory = createSystemLoginTransportFactory(h.networking);

		const first = factory();
		const firstPending = first.sendRequest(beginRequest());
		await vi.waitFor(() => expect(h.handles).toHaveLength(1));
		const firstResponse = new FakeResponse();
		h.handles[0]?.respond(firstResponse);
		firstResponse.emitEnd();
		await firstPending;
		first.close();
		await vi.waitFor(() => expect(h.closeAllConnections).toHaveBeenCalledOnce());

		const second = factory();
		const secondPending = second.sendRequest(beginRequest());
		await Promise.resolve();
		expect(h.handles).toHaveLength(1);
		closeGate.resolve();
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledOnce());
		expect(h.handles).toHaveLength(1);
		clearGate.resolve();
		await vi.waitFor(() => expect(h.handles).toHaveLength(2));

		const secondResponse = new FakeResponse();
		h.handles[1]?.respond(secondResponse);
		secondResponse.emitEnd();
		await secondPending;
		second.close();
	});

	it('retries a late failed cleanup and refuses to reuse the session until it succeeds', async () => {
		const failedClear = deferred();
		const h = harness();
		h.clearStorageData
			.mockImplementationOnce(() => failedClear.promise)
			.mockImplementationOnce(() => Promise.resolve());
		const factory = createSystemLoginTransportFactory(h.networking);

		const first = factory();
		const firstPending = first.sendRequest(beginRequest());
		await vi.waitFor(() => expect(h.handles).toHaveLength(1));
		const firstResponse = new FakeResponse();
		h.handles[0]?.respond(firstResponse);
		firstResponse.emitEnd();
		await firstPending;
		first.close();
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledOnce());

		const second = factory();
		const secondPending = second.sendRequest(beginRequest());
		failedClear.reject(new Error('the first clear failed late'));
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(h.handles).toHaveLength(2));
		expect(h.closeAllConnections).toHaveBeenCalledTimes(2);

		const secondResponse = new FakeResponse();
		h.handles[1]?.respond(secondResponse);
		secondResponse.emitEnd();
		await secondPending;
		second.close();
	});

	it('fails closed when an idle session still cannot be cleared for reuse', async () => {
		const h = harness();
		h.clearStorageData.mockRejectedValue(new Error('storage remains'));
		const factory = createSystemLoginTransportFactory(h.networking);
		const first = factory();
		const firstPending = first.sendRequest(beginRequest());
		await vi.waitFor(() => expect(h.handles).toHaveLength(1));
		const response = new FakeResponse();
		h.handle.respond(response);
		response.emitEnd();
		await firstPending;
		first.close();
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledOnce());

		const second = factory();
		await expect(second.sendRequest(beginRequest())).rejects.toThrow(/refusing to sign in/i);
		expect(h.handles).toHaveLength(1);
		expect(h.applyProxy).toHaveBeenCalledOnce();
		second.close();
	});

	it('serializes system-route applications so a late settle cannot overtake another attempt', async () => {
		const gates = [deferred(), deferred()];
		let route = 0;
		const h = harness(() => gates[route++]!.promise);
		const factory = createSystemLoginTransportFactory(h.networking);
		const first = factory();
		const second = factory();
		const firstPending = first.sendRequest(beginRequest());
		const secondPending = second.sendRequest(beginRequest());

		await vi.waitFor(() => expect(h.applyProxy).toHaveBeenCalledTimes(1));
		expect(h.handles).toHaveLength(0);
		gates[0]!.resolve();
		await vi.waitFor(() => expect(h.applyProxy).toHaveBeenCalledTimes(2));
		gates[1]!.resolve();
		await vi.waitFor(() => expect(h.handles).toHaveLength(2));

		for (const handle of h.handles) {
			const response = new FakeResponse();
			handle.respond(response);
			response.emitEnd();
		}
		await Promise.all([firstPending, secondPending]);
		first.close();
		second.close();
	});

	it('applies the system route before creating any request', async () => {
		const gate = deferred();
		const h = harness(() => gate.promise);
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		const pending = transport.sendRequest({
			apiInterface: 'Authentication',
			apiMethod: 'GetPasswordRSAPublicKey',
			apiVersion: 1
		});

		await Promise.resolve();
		expect(h.applyProxy).toHaveBeenCalledWith({ mode: 'system' });
		expect(h.requests).toHaveLength(0);

		gate.resolve();
		await vi.waitFor(() => expect(h.requests).toHaveLength(1));
		const response = new FakeResponse();
		h.handle.respond(response);
		response.emitEnd();
		await expect(pending).resolves.toEqual({});
	});

	it('encodes the RSA GET query and maps raw response evidence', async () => {
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		const pending = transport.sendRequest({
			apiInterface: 'Authentication',
			apiMethod: 'GetPasswordRSAPublicKey',
			apiVersion: 1,
			accessToken: 'token+/=',
			requestData: Buffer.from([0xfb, 0xff]),
			headers: { cookie: 'mobileClientVersion=777', 'x-client': 'mobile' }
		});

		await vi.waitFor(() => expect(h.requests).toHaveLength(1));
		const sent = h.requests[0]!;
		expect(sent.method).toBe('GET');
		expect(sent.redirect).toBe('error');
		expect(sent.url).toBe(
			'https://api.steampowered.com/IAuthenticationService/GetPasswordRSAPublicKey/v1/' +
				'?access_token=token%2B%2F%3D&input_protobuf_encoded=%2B%2F8%3D&origin=SteamMobile'
		);
		expect(h.handle.headers).toMatchObject(
			new Map([
				['accept', 'application/json, text/plain, */*'],
				['cookie', 'mobileClientVersion=777'],
				['x-client', 'mobile']
			])
		);
		expect(
			h.applySessionHeaders({
				'Sec-Fetch-Site': 'none',
				'sec-fetch-mode': 'navigate',
				'X-Unrelated': 'kept'
			})
		).toEqual({
			'X-Unrelated': 'kept',
			'sec-fetch-site': 'cross-site',
			'sec-fetch-mode': 'cors',
			'sec-fetch-dest': 'empty'
		});
		expect(h.handle.body).toBe('');

		const response = new FakeResponse(200, {
			'X-EResult': ['1'],
			'X-Error_Message': ['detail']
		});
		h.handle.respond(response);
		response.emitData(Buffer.from([0, 255, 1]));
		response.emitEnd();
		await expect(pending).resolves.toEqual({
			result: 1,
			errorMessage: 'detail',
			responseData: Buffer.from([0, 255, 1])
		});
	});

	it('encodes begin/poll data with the pinned multipart bytes and boundary', async () => {
		const h = harness();
		const boundary = '-----------------------------0123456789abcdef';
		const transport = new SystemLoginTransport(h.networking, 'attempt', {
			boundary: () => boundary
		});
		const pending = transport.sendRequest(beginRequest());

		await vi.waitFor(() => expect(h.requests).toHaveLength(1));
		const expected =
			`--${boundary}\r\n` +
			'Content-Disposition: form-data; name="input_protobuf_encoded"\r\n\r\n' +
			'+/8=\r\n' +
			`--${boundary}--\r\n`;
		expect(h.requests[0]).toMatchObject({
			method: 'POST',
			url: 'https://api.steampowered.com/IAuthenticationService/BeginAuthSessionViaCredentials/v1/',
			redirect: 'error'
		});
		expect(h.handle.body).toBe(expected);
		expect(h.handle.headers.get('content-type')).toBe(`multipart/form-data; boundary=${boundary}`);
		expect(h.handle.headers.get('content-length')).toBe(String(Buffer.byteLength(expected)));

		const response = new FakeResponse();
		h.handle.respond(response);
		response.emitEnd();
		await pending;
	});

	it('matches the installed WebApiTransport multipart bytes', async () => {
		const dependency = await dependencyMultipart(beginRequest());
		const boundary = dependency.contentType.slice(dependency.contentType.indexOf('boundary=') + 9);
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt', {
			boundary: () => boundary
		});
		const pending = transport.sendRequest(beginRequest());

		await vi.waitFor(() => expect(h.requests).toHaveLength(1));
		expect(h.handle.body).toBe(dependency.body);
		expect(h.handle.headers.get('content-type')).toBe(dependency.contentType);
		expect(h.handle.headers.get('content-length')).toBe(dependency.contentLength);

		const response = new FakeResponse();
		h.handle.respond(response);
		response.emitEnd();
		await pending;
	});

	it('refuses a malformed endpoint component before Electron receives a URL', async () => {
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		await expect(
			transport.sendRequest({
				apiInterface: 'Authentication/../../example.com',
				apiMethod: 'PollAuthSessionStatus',
				apiVersion: 1
			})
		).rejects.toThrow(/invalid WebAPI endpoint/i);
		expect(h.requests).toHaveLength(0);
	});

	it('does not let the smoke endpoint seam name a non-loopback authority', () => {
		const h = harness();
		expect(
			() =>
				new SystemLoginTransport(h.networking, 'attempt', {
					loopbackOriginForSmoke: 'https://example.com'
				})
		).toThrow(/not loopback/i);
	});

	it('refuses an HTTP redirect response as well as disabling redirect following', async () => {
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		const pending = transport.sendRequest(beginRequest());
		const rejection = expect(pending).rejects.toThrow(/WebAPI error 302/i);
		await vi.waitFor(() => expect(h.requests).toHaveLength(1));
		const response = new FakeResponse(302, { location: 'https://example.com/' });
		h.handle.respond(response);
		response.emitEnd();
		await rejection;
		expect(h.requests[0]?.redirect).toBe('error');
	});

	it('refuses to continue when the system route cannot be applied', async () => {
		const h = harness(() => Promise.reject(new Error('PAC unavailable')));
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		await expect(transport.sendRequest(beginRequest())).rejects.toThrow(/refusing to sign in/i);
		expect(h.requests).toHaveLength(0);
	});

	it('also refuses a synchronous system-route setup failure', async () => {
		const h = harness(() => {
			throw new Error('session was destroyed');
		});
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		await expect(transport.sendRequest(beginRequest())).rejects.toThrow(/refusing to sign in/i);
		expect(h.requests).toHaveLength(0);
	});

	it('answers a system-proxy authentication challenge with no credentials and one stable action', async () => {
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		const pending = transport.sendRequest(beginRequest());
		const rejected = pending.catch((error: unknown) => error);
		await vi.waitFor(() => expect(h.handles).toHaveLength(1));
		const callback = vi.fn<(username?: string, password?: string) => void>();

		h.handle.emitLogin(
			{ isProxy: true, host: 'alice:secret@proxy.internal', realm: 'secret-realm' },
			callback
		);
		const failure = await rejected;
		expect(failure).toEqual(new Error(SYSTEM_PROXY_AUTH_REQUIRED));
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith();
		expect(h.handle.aborts).toBe(1);
		expect(String(failure)).not.toMatch(/alice|secret-realm|proxy\.internal/);

		// Chromium can still deliver the generic HTTP result and request error after
		// the empty callback. Neither may replace or settle the answer a second time.
		const response = new FakeResponse(407);
		h.handle.respond(response);
		response.emitEnd();
		h.handle.emitError(new Error('ERR_PROXY_AUTH_REQUESTED'));
		expect(await rejected).toBe(failure);
		transport.close();
	});

	it('refuses origin HTTP authentication without offering any account or proxy password', async () => {
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		const pending = transport.sendRequest(beginRequest());
		await vi.waitFor(() => expect(h.handles).toHaveLength(1));
		const callback = vi.fn<(username?: string, password?: string) => void>();

		h.handle.emitLogin(
			{ isProxy: false, host: 'attacker.invalid', realm: 'send-hunter2' },
			callback
		);
		await expect(pending).rejects.toThrow(ORIGIN_AUTH_REFUSED);
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith();
		expect(h.handle.aborts).toBe(1);
		expect(ORIGIN_AUTH_REFUSED).not.toMatch(/attacker|hunter2/);
		transport.close();
	});

	it('still answers a late authentication callback after timeout without changing the result', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const transport = new SystemLoginTransport(h.networking, 'attempt', { timeoutMs: 10 });
			const pending = transport.sendRequest(beginRequest());
			const rejected = pending.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(10);
			const timeout = await rejected;
			expect(String(timeout)).toMatch(/in time/i);
			const callback = vi.fn<(username?: string, password?: string) => void>();
			h.handle.emitLogin({ isProxy: true }, callback);
			expect(callback).toHaveBeenCalledWith();
			expect(await rejected).toBe(timeout);
			transport.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it('close settles an attempt still waiting for system proxy discovery', async () => {
		const gate = deferred();
		const h = harness(() => gate.promise);
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		const pending = transport.sendRequest(beginRequest());
		const rejection = expect(pending).rejects.toThrow(/cancelled/i);
		await Promise.resolve();

		transport.close();
		await rejection;
		expect(h.requests).toHaveLength(0);
		gate.resolve();
	});

	it('bounds a response and aborts it instead of buffering the rest', async () => {
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt', {
			maxResponseBytes: 3
		});
		const pending = transport.sendRequest(beginRequest());
		await vi.waitFor(() => expect(h.requests).toHaveLength(1));
		const response = new FakeResponse();
		h.handle.respond(response);
		response.emitData(Buffer.from('four'));
		await expect(pending).rejects.toThrow(/too large/i);
		expect(h.handle.aborts).toBe(1);
	});

	it('close synchronously aborts an active request and retires its session', async () => {
		const h = harness();
		const transport = new SystemLoginTransport(h.networking, 'attempt');
		const pending = transport.sendRequest(beginRequest());
		await vi.waitFor(() => expect(h.requests).toHaveLength(1));

		transport.close();
		expect(h.handle.aborts).toBe(1);
		await expect(pending).rejects.toThrow(/cancelled/i);
		await vi.waitFor(() => expect(h.closeAllConnections).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(h.clearStorageData).toHaveBeenCalledOnce());
	});

	it.each(['setHeader', 'write', 'end'] as const)(
		'cleans up when %s throws synchronously',
		async (throwAt) => {
			const h = harness();
			h.handle.throwAt = throwAt;
			const transport = new SystemLoginTransport(h.networking, 'attempt');
			await expect(transport.sendRequest(beginRequest())).rejects.toThrow(/setup failed/i);
			expect(h.handle.aborts).toBe(1);

			transport.close();
			expect(h.handle.aborts, 'a settled handle remained in the active set').toBe(1);
		}
	);

	it('times out and aborts a request that never settles', async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const transport = new SystemLoginTransport(h.networking, 'attempt', { timeoutMs: 10 });
			const pending = transport.sendRequest(beginRequest());
			const rejection = expect(pending).rejects.toThrow(/in time/i);
			await vi.advanceTimersByTimeAsync(10);
			await rejection;
			expect(h.handle.aborts).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
