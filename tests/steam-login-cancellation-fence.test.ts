import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest, ApiResponse, ITransport } from 'steam-session';
import { getProtoForMethod } from 'steam-session/dist/protobufs';
import {
	createLoginSession,
	fenceLoginCancellation,
	SteamLoginError,
	type LoginSessionLike
} from '../src/main/steam/login';

/**
 * Contract test at the installed `steam-session` boundary.
 *
 * The library's `cancelLoginAttempt()` does not fence its own asynchronous
 * steps: a late RSA-key response used to start BeginAuthSession after the app
 * had reported the sign-in stopped. These tests drive the real LoginSession and
 * AuthenticationClient while replacing only the innermost network call with a
 * deterministic transport.
 */

interface InspectableTransport extends ITransport {
	readonly delegate: ITransport;
}

interface InspectableSession extends LoginSessionLike {
	_handler: {
		_transport: InspectableTransport;
		_webClient: unknown;
	};
	_webClient: unknown;
	_startSessionResponse?: unknown;
}

function inspect(proxyUrl?: string): {
	session: InspectableSession;
	fence: InspectableTransport;
	delegate: ITransport;
} {
	const systemTransport: ITransport = {
		sendRequest: () => Promise.reject(new Error('not used by this inspection')),
		close: vi.fn()
	};
	const session = createLoginSession(
		proxyUrl,
		proxyUrl === undefined ? () => systemTransport : undefined
	) as InspectableSession;
	const fence = session._handler._transport;
	if (fence?.delegate === undefined) {
		throw new Error('the production session did not install its cancellation fence');
	}
	return { session, fence, delegate: fence.delegate };
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let release!: (value: T) => void;
	return {
		promise: new Promise<T>((resolve) => {
			release = resolve;
		}),
		resolve: release
	};
}

function encoded(apiMethod: string, value: object): ApiResponse {
	const response = getProtoForMethod('Authentication', apiMethod).response as {
		encode(input: object): { finish(): Uint8Array };
	};
	return {
		result: 1,
		responseData: Buffer.from(response.encode(value).finish())
	};
}

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
const publicJwk = publicKey.export({ format: 'jwk' });
if (publicJwk.n === undefined || publicJwk.e === undefined) {
	throw new Error('Node did not export an RSA public key');
}
const RSA_RESPONSE = encoded('GetPasswordRSAPublicKey', {
	publickey_mod: Buffer.from(publicJwk.n, 'base64url').toString('hex'),
	publickey_exp: Buffer.from(publicJwk.e, 'base64url').toString('hex'),
	timestamp: '1'
});
const BEGIN_RESPONSE = encoded('BeginAuthSessionViaCredentials', {
	client_id: '123',
	request_id: Buffer.from('request'),
	interval: 30,
	allowed_confirmations: [{ confirmation_type: 2, associated_message: 'example.com' }],
	steamid: '76561198000000001'
});

const CREDENTIALS = {
	accountName: 'trader',
	password: 'a long test password',
	persistence: 1
};

afterEach(() => {
	vi.useRealTimers();
});

describe('the installed steam-session cancellation fence', () => {
	it('refuses before the inner transport when an already-cancelled session is invoked', async () => {
		vi.useFakeTimers();
		const { session, delegate } = inspect();
		const sendRequest = vi.fn(() => Promise.resolve(RSA_RESPONSE));
		delegate.sendRequest = sendRequest;

		session.cancelLoginAttempt();

		await expect(session.startWithCredentials(CREDENTIALS)).rejects.toThrow(/cancelled/i);
		expect(sendRequest, 'a cancelled session reached its network transport').not.toHaveBeenCalled();
		vi.runAllTimers();
	});

	it('prevents BeginAuthSession when cancellation lands during password encryption', async () => {
		vi.useFakeTimers();
		const { session, delegate } = inspect();
		const heldRsa = deferred<ApiResponse>();
		const methods: string[] = [];
		delegate.sendRequest = (request: ApiRequest) => {
			methods.push(request.apiMethod);
			return request.apiMethod === 'GetPasswordRSAPublicKey'
				? heldRsa.promise
				: Promise.resolve(BEGIN_RESPONSE);
		};

		const attempt = session.startWithCredentials(CREDENTIALS);
		await vi.waitFor(() => expect(methods).toEqual(['GetPasswordRSAPublicKey']));

		session.cancelLoginAttempt();
		heldRsa.resolve(RSA_RESPONSE);

		await expect(attempt).rejects.toThrow(/cancelled/i);
		expect(methods, 'a password-bearing request started after cancellation').toEqual([
			'GetPasswordRSAPublicKey'
		]);
		vi.runAllTimers();
	});

	it('refuses a late BeginAuthSession answer before it advances the workflow', async () => {
		vi.useFakeTimers();
		const { session, delegate } = inspect();
		const heldBegin = deferred<ApiResponse>();
		const methods: string[] = [];
		delegate.sendRequest = (request: ApiRequest) => {
			methods.push(request.apiMethod);
			return request.apiMethod === 'GetPasswordRSAPublicKey'
				? Promise.resolve(RSA_RESPONSE)
				: heldBegin.promise;
		};

		const attempt = session.startWithCredentials(CREDENTIALS);
		await vi.waitFor(() =>
			expect(methods).toEqual(['GetPasswordRSAPublicKey', 'BeginAuthSessionViaCredentials'])
		);

		session.cancelLoginAttempt();
		heldBegin.resolve(BEGIN_RESPONSE);

		await expect(attempt).rejects.toThrow(/cancelled/i);
		expect(methods).toEqual(['GetPasswordRSAPublicKey', 'BeginAuthSessionViaCredentials']);
		expect(
			session._startSessionResponse,
			'the cancelled response became live login state'
		).toBeUndefined();
		vi.runAllTimers();
	});

	it('leaves the ordinary no-cancel library flow unchanged', async () => {
		vi.useFakeTimers();
		const { session, delegate } = inspect();
		const methods: string[] = [];
		delegate.sendRequest = (request: ApiRequest) => {
			methods.push(request.apiMethod);
			return Promise.resolve(
				request.apiMethod === 'GetPasswordRSAPublicKey' ? RSA_RESPONSE : BEGIN_RESPONSE
			);
		};

		await expect(session.startWithCredentials(CREDENTIALS)).resolves.toEqual({
			actionRequired: true,
			validActions: [{ type: 2, detail: 'example.com' }]
		});
		expect(methods).toEqual(['GetPasswordRSAPublicKey', 'BeginAuthSessionViaCredentials']);

		session.cancelLoginAttempt();
		vi.runAllTimers();
	});

	it.each([
		['HTTP proxy', 'http://alice:secret@127.0.0.1:8080'],
		['SOCKS proxy', 'socks5://127.0.0.1:1080']
	])('retains the library transport and client for %s construction', (_name, proxyUrl) => {
		vi.useFakeTimers();
		const { session, fence, delegate } = inspect(proxyUrl);

		expect(fence.constructor.name).toBe('CancellationFencedTransport');
		expect(delegate.constructor.name).toBe('WebApiTransport');
		expect((delegate as ITransport & { _client?: unknown })._client).toBe(session._webClient);
		expect(session._handler._webClient).toBe(session._webClient);

		session.cancelLoginAttempt();
		vi.runAllTimers();
	});

	it('uses the application transport for no-proxy construction', () => {
		vi.useFakeTimers();
		const { session, delegate } = inspect();

		expect(delegate.constructor.name).not.toBe('WebApiTransport');
		expect(delegate).not.toHaveProperty('_client');

		session.cancelLoginAttempt();
		vi.runAllTimers();
	});

	it('closes the application transport before cancelLoginAttempt returns', () => {
		vi.useFakeTimers();
		const close = vi.fn();
		const session = createLoginSession(undefined, () => ({
			sendRequest: () => Promise.reject(new Error('not used')),
			close
		}));

		session.cancelLoginAttempt();
		expect(close).toHaveBeenCalledOnce();
		vi.runAllTimers();
	});

	it('does not construct the system transport for an explicit account proxy', () => {
		vi.useFakeTimers();
		const systemTransport = vi.fn(() => ({
			sendRequest: () => Promise.reject(new Error('not used')),
			close: vi.fn()
		}));
		const session = createLoginSession('socks5://127.0.0.1:1080', systemTransport);

		expect(systemTransport).not.toHaveBeenCalled();
		session.cancelLoginAttempt();
		vi.runAllTimers();
	});

	it('refuses no-proxy construction when application wiring omitted the system route', () => {
		expect(() => createLoginSession(undefined)).toThrow(/system proxy route is unavailable/i);
	});

	it('fails closed when the pinned dependency transport hook is absent', () => {
		const cancelLoginAttempt = vi.fn();
		const incompatible = {
			startWithCredentials: vi.fn(),
			submitSteamGuardCode: vi.fn(),
			on: vi.fn(),
			cancelLoginAttempt,
			refreshToken: '',
			accessToken: ''
		} as unknown as LoginSessionLike;

		let failure: unknown;
		try {
			fenceLoginCancellation(incompatible);
		} catch (err) {
			failure = err;
		}

		expect(failure).toBeInstanceOf(SteamLoginError);
		expect((failure as Error).message).toMatch(/cannot be cancelled safely/i);
		expect(cancelLoginAttempt).toHaveBeenCalledOnce();
	});
});
