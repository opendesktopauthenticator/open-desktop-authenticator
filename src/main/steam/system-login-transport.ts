import { randomBytes } from 'node:crypto';
import type { ApiRequest, ApiResponse, ITransport } from 'steam-session';
import type {
	ElectronNetworking,
	NetRequestHandle,
	NetResponseHandle,
	ProxyCapableSession
} from '../net/transport';

/** The only production authority this transport is allowed to contact. */
export const STEAM_WEB_API_ORIGIN = 'https://api.steampowered.com';

const RSA_PATH = 'IAuthenticationService/GetPasswordRSAPublicKey/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FETCH_HEADERS: Record<string, string> = {
	'sec-fetch-site': 'cross-site',
	'sec-fetch-mode': 'cors',
	'sec-fetch-dest': 'empty'
};
const API_HEADERS: Record<string, string> = {
	accept: 'application/json, text/plain, */*',
	...FETCH_HEADERS
};
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const SYSTEM_LOGIN_PARTITION = 'steam-login-system';

export const SYSTEM_PROXY_AUTH_REQUIRED =
	"The machine's system proxy requested authentication. Add that HTTP(S) proxy, including " +
	'its username and password, in the Proxy field for this account or operation, then use the proxied route.';

export const ORIGIN_AUTH_REFUSED =
	'Steam unexpectedly requested HTTP authentication. No account or proxy password was sent, and the sign-in was stopped.';

export type SystemLoginTransportFactory = () => ITransport;

interface ActiveRequest {
	handle: NetRequestHandle;
	cancel(): void;
}

function abortQuietly(handle: NetRequestHandle): void {
	try {
		handle.abort?.();
	} catch {
		// Settlement is the security boundary. A broken Electron cleanup hook must
		// not prevent the caller from being released or the shared lease retiring.
	}
}

export interface SystemLoginTransportOptions {
	/** Loopback-only trust root for the packaged Electron smoke exercise. */
	loopbackOriginForSmoke?: string;
	/** Test seams for deterministic protocol and timeout assertions. */
	boundary?: () => string;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

export interface SystemLoginTransportFactoryOptions extends SystemLoginTransportOptions {
	/** Test-only override; production deliberately has one stable in-memory partition. */
	partition?: string;
}

function normalizedOrigin(raw: string, loopback: boolean): URL {
	const url = new URL(raw);
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:') ||
		url.username !== '' ||
		url.password !== '' ||
		url.pathname !== '/' ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw new Error('The Steam login transport endpoint is not an exact HTTP(S) origin.');
	}
	if (loopback && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
		throw new Error('The Steam login smoke endpoint is not loopback.');
	}
	if (!loopback && url.origin !== STEAM_WEB_API_ORIGIN) {
		throw new Error('The Steam login transport endpoint is not the Steam WebAPI.');
	}
	return url;
}

function normalizeHeaders(input: Record<string, unknown>): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [name, value] of Object.entries(input)) {
		const lower = name.toLowerCase();
		if (Object.hasOwn(output, lower)) {
			throw new Error(`Header "${lower}" appears more than once.`);
		}
		if (typeof value !== 'string') {
			throw new Error(`Header "${lower}" is not a string.`);
		}
		output[lower] = value;
	}
	return output;
}

function oneHeader(
	headers: Record<string, string | string[] | undefined> | undefined,
	name: string
): string | undefined {
	if (headers === undefined) {
		return undefined;
	}
	for (const [candidate, value] of Object.entries(headers)) {
		if (candidate.toLowerCase() === name) {
			if (typeof value === 'string') return value;
			if (Array.isArray(value)) return value[0];
		}
	}
	return undefined;
}

function multipartBody(value: string, boundary: string): string {
	return (
		`--${boundary}\r\n` +
		'Content-Disposition: form-data; name="input_protobuf_encoded"\r\n\r\n' +
		`${value}\r\n` +
		`--${boundary}--\r\n`
	);
}

interface SystemLoginLease {
	readonly session: ProxyCapableSession;
	applySystemRoute(): Promise<void>;
	release(): void;
}

function installHeaderPolicy(session: ProxyCapableSession): void {
	if (session.webRequest === undefined) {
		throw new Error('The Electron session cannot preserve Steam login request headers.');
	}
	session.webRequest.onBeforeSendHeaders((details, callback) => {
		const requestHeaders = { ...details.requestHeaders };
		for (const name of Object.keys(requestHeaders)) {
			if (Object.hasOwn(FETCH_HEADERS, name.toLowerCase())) delete requestHeaders[name];
		}
		callback({ requestHeaders: { ...requestHeaders, ...FETCH_HEADERS } });
	});
}

/**
 * One bounded Electron network context shared by all system-routed sign-ins.
 *
 * Electron retains every named partition for the process lifetime, even after
 * its storage and connections have been cleared. Attempts therefore lease one
 * context rather than inventing an unbounded sequence of names. Requests and
 * cancellation remain owned by the individual transport below.
 */
class SystemLoginSessionOwner {
	private sessionValue: ProxyCapableSession | undefined;
	private leases = 0;
	private operations: Promise<void> = Promise.resolve();
	private cleanupFailed = false;

	constructor(
		private readonly networking: ElectronNetworking,
		private readonly partition: string
	) {}

	acquire(): SystemLoginLease {
		const session = this.session();
		this.leases += 1;
		let released = false;
		return {
			session,
			applySystemRoute: () => {
				if (released) return Promise.reject(new Error('The Steam sign-in was cancelled.'));
				return this.enqueue(async () => {
					if (released) throw new Error('The Steam sign-in was cancelled.');
					if (this.cleanupFailed) {
						await this.retireIdleSession();
						if (this.cleanupFailed) {
							throw new Error(
								'The previous Steam sign-in network state could not be cleared. Refusing to reuse it.'
							);
						}
					}
					await session.setProxy({ mode: 'system' });
					if (released) throw new Error('The Steam sign-in was cancelled.');
				});
			},
			release: () => {
				if (released) return;
				released = true;
				this.leases -= 1;
				if (this.leases === 0) {
					/*
					 * Queued behind every route application and ahead of any later
					 * lease's application. A new transport may be constructed while
					 * this is running, but it cannot send until both operations settle.
					 */
					void this.enqueue(() => this.retireIdleSession());
				}
			}
		};
	}

	private session(): ProxyCapableSession {
		if (this.sessionValue !== undefined) return this.sessionValue;
		// Lazy by necessity: application wiring is built before Electron's ready
		// event, while the first user-initiated sign-in can only happen afterwards.
		const session = this.networking.sessionFromPartition(this.partition, { cache: false });
		installHeaderPolicy(session);
		this.sessionValue = session;
		return session;
	}

	private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.operations.then(operation);
		// A failed attempt must not poison the serialization boundary for every
		// later attempt. The caller still receives the original rejection.
		this.operations = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	private async retireIdleSession(): Promise<void> {
		let failed = false;
		try {
			await this.sessionValue?.closeAllConnections?.();
		} catch {
			failed = true;
		}
		try {
			await this.sessionValue?.clearStorageData?.();
		} catch {
			failed = true;
		}
		/*
		 * A later lease retries both operations before applying a route. Reuse is
		 * refused while either still fails: no attempt can inherit cookies, cache,
		 * connections or authentication state merely because cleanup was best-effort.
		 */
		this.cleanupFailed = failed;
	}
}

/**
 * `steam-session`'s MobileApp WebAPI protocol over one Electron system-routed
 * session. The endpoint is an injected trust root only so the real Electron
 * smoke test can use a loopback server; the production factory below pins it.
 */
export class SystemLoginTransport implements ITransport {
	private readonly session: ProxyCapableSession;
	private readonly lease: SystemLoginLease;
	private readonly origin: URL;
	private readonly boundary: () => string;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;
	private readonly active = new Set<ActiveRequest>();
	private initializing: Promise<void> | undefined;
	private stopInitialization: (() => void) | undefined;
	private closed = false;

	constructor(
		private readonly networking: ElectronNetworking,
		partition: string,
		options: SystemLoginTransportOptions = {},
		owner?: SystemLoginSessionOwner
	) {
		this.origin = normalizedOrigin(
			options.loopbackOriginForSmoke ?? STEAM_WEB_API_ORIGIN,
			options.loopbackOriginForSmoke !== undefined
		);
		this.boundary =
			options.boundary ?? (() => `-----------------------------${randomBytes(20).toString('hex')}`);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
		if (this.timeoutMs <= 0 || this.maxResponseBytes <= 0) {
			throw new Error('The Steam login transport limits must be positive.');
		}
		this.lease = (owner ?? new SystemLoginSessionOwner(networking, partition)).acquire();
		this.session = this.lease.session;
	}

	private async ready(): Promise<void> {
		if (this.closed) {
			throw new Error('The Steam sign-in was cancelled.');
		}
		this.initializing ??= new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (run: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.stopInitialization = undefined;
				run();
			};
			const timer = setTimeout(
				() =>
					finish(() =>
						reject(new Error("The machine's system proxy settings did not finish loading in time."))
					),
				this.timeoutMs
			);
			this.stopInitialization = () =>
				finish(() => reject(new Error('The Steam sign-in was cancelled.')));
			const refused = (cause: unknown): void =>
				finish(() =>
					reject(
						new Error(
							"The machine's system proxy settings could not be applied. Refusing to sign in without them.",
							{ cause }
						)
					)
				);
			try {
				this.lease.applySystemRoute().then(() => finish(resolve), refused);
			} catch (cause) {
				refused(cause);
			}
		});
		try {
			await this.initializing;
		} catch (cause) {
			throw cause instanceof Error ? cause : new Error('The system proxy route failed.', { cause });
		}
		if (this.closed) {
			throw new Error('The Steam sign-in was cancelled.');
		}
	}

	async sendRequest(request: ApiRequest): Promise<ApiResponse> {
		await this.ready();

		if (
			!API_NAME.test(request.apiInterface) ||
			!API_NAME.test(request.apiMethod) ||
			!Number.isSafeInteger(request.apiVersion) ||
			request.apiVersion < 1
		) {
			throw new Error('The Steam sign-in library requested an invalid WebAPI endpoint.');
		}

		const path = `I${request.apiInterface}Service/${request.apiMethod}/v${request.apiVersion}`;
		const method = path === RSA_PATH ? 'GET' : 'POST';
		const url = new URL(`/${path}/`, this.origin);
		if (url.origin !== this.origin.origin || !url.pathname.startsWith('/I')) {
			throw new Error('The Steam sign-in library requested a non-Steam destination.');
		}

		const headers = normalizeHeaders({
			...API_HEADERS,
			...((request.headers ?? {}) as Record<string, unknown>)
		});
		if (request.accessToken) {
			url.searchParams.set('access_token', request.accessToken);
		}

		const data =
			request.requestData !== undefined && request.requestData !== null
				? Buffer.from(request.requestData as Uint8Array)
				: Buffer.alloc(0);
		let body = '';
		if (data.length > 0) {
			const encoded = data.toString('base64');
			if (method === 'GET') {
				url.searchParams.set('input_protobuf_encoded', encoded);
			} else {
				const boundary = this.boundary();
				body = multipartBody(encoded, boundary);
				headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
				headers['content-length'] = String(Buffer.byteLength(body));
			}
		}
		if (method === 'GET') {
			if ((headers.cookie ?? '').includes('mobileClientVersion=')) {
				url.searchParams.set('origin', 'SteamMobile');
			}
			delete headers['content-type'];
			delete headers['content-length'];
		}

		return new Promise<ApiResponse>((resolve, reject) => {
			let settled = false;
			const active: { current?: ActiveRequest } = {};
			let timer: NodeJS.Timeout | undefined;
			const finish = (run: () => void): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				if (active.current !== undefined) this.active.delete(active.current);
				run();
			};
			const fail = (error: Error): void => finish(() => reject(error));

			let handle: NetRequestHandle;
			try {
				handle = this.networking.request({
					url: url.toString(),
					method,
					session: this.session,
					redirect: 'error'
				});
			} catch (cause) {
				fail(new Error('Steam sign-in request could not be created.', { cause }));
				return;
			}

			active.current = {
				handle,
				cancel: () => {
					abortQuietly(handle);
					fail(new Error('The Steam sign-in was cancelled.'));
				}
			};
			this.active.add(active.current);
			try {
				handle.on('login', (authInfo, callback) => {
					const error = new Error(
						authInfo.isProxy ? SYSTEM_PROXY_AUTH_REQUIRED : ORIGIN_AUTH_REFUSED
					);
					/*
					 * Settle with the stable, redacted explanation first. Electron may emit a
					 * generic request error synchronously after the empty callback; that later
					 * event must not replace the actionable answer.
					 */
					fail(error);
					try {
						callback();
					} catch {
						// The request is already rejected and is aborted below.
					}
					abortQuietly(handle);
				});
				for (const [name, value] of Object.entries(headers)) {
					// Chromium rejects sec-fetch-mode through ClientRequest and rewrites
					// sec-fetch-site. The attempt session's hook above is the only seam
					// that both accepts and preserves these installed-library headers.
					if (Object.hasOwn(FETCH_HEADERS, name)) continue;
					// Electron owns this header and rejects attempts to set it through
					// ClientRequest. It derives the same byte length from write() below.
					if (name === 'content-length') continue;
					handle.setHeader(name, value);
				}

				handle.on('response', (response: NetResponseHandle) => {
					const chunks: Buffer[] = [];
					let length = 0;
					response.on('data', (chunk) => {
						if (settled) return;
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						length += buffer.length;
						if (length > this.maxResponseBytes) {
							abortQuietly(handle);
							fail(new Error('Steam returned a sign-in response that was too large.'));
							return;
						}
						chunks.push(buffer);
					});
					response.on('error', fail);
					response.on('end', () => {
						if (settled) return;
						if (response.statusCode < 200 || response.statusCode >= 300) {
							const error = new Error(`WebAPI error ${response.statusCode}`) as Error & {
								code?: number;
							};
							error.code = response.statusCode;
							fail(error);
							return;
						}
						const responseData = Buffer.concat(chunks);
						const resultHeader = oneHeader(response.headers, 'x-eresult');
						const errorMessage = oneHeader(response.headers, 'x-error_message');
						finish(() =>
							resolve({
								...(resultHeader === undefined
									? {}
									: { result: Number.parseInt(resultHeader, 10) }),
								...(errorMessage === undefined ? {} : { errorMessage }),
								...(responseData.length === 0 ? {} : { responseData })
							})
						);
					});
				});
				handle.on('error', fail);
				timer = setTimeout(() => {
					abortQuietly(handle);
					fail(new Error('Steam did not finish the sign-in request in time.'));
				}, this.timeoutMs);
				if (body !== '') handle.write(body);
				handle.end();
			} catch (cause) {
				abortQuietly(handle);
				fail(new Error('Steam sign-in request setup failed.', { cause }));
			}
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopInitialization?.();
		for (const request of [...this.active]) request.cancel();
		this.active.clear();
		this.lease.release();
	}
}

/** The only factory application wiring should use. Its endpoint cannot vary. */
export function createSystemLoginTransportFactory(
	networking: ElectronNetworking,
	options: SystemLoginTransportFactoryOptions = {}
): SystemLoginTransportFactory {
	const { partition = SYSTEM_LOGIN_PARTITION, ...transportOptions } = options;
	const owner = new SystemLoginSessionOwner(networking, partition);
	return () => new SystemLoginTransport(networking, partition, transportOptions, owner);
}
