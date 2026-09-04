import { maxHeaderSize, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { lookup as dnsLookup } from 'node:dns';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { SocksClient, type SocksProxy } from 'socks';

/** The deadline the previous Steam proxy agent enforced while opening a tunnel. */
export const PROXY_CONNECT_TIMEOUT_MS = 5_000;

type AgentConnectOptions = Parameters<HttpsProxyAgent<string>['connect']>[1];
type SocksConnectParameters = Parameters<SocksProxyAgent['callback']>;

interface SocksAgentInternals {
	readonly shouldLookup: boolean;
	readonly proxy: SocksProxy;
	readonly tlsConnectionOptions: tls.ConnectionOptions;
}

/** Marks a failure that happened inside an app-owned proxy handshake. */
export class ProxyConnectionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ProxyConnectionError';
	}
}

interface ConnectResponse {
	statusCode: number;
	statusText: string;
	headers: IncomingHttpHeaders;
}

/**
 * `https-proxy-agent` with two missing resource bounds restored.
 *
 * Version 7 correctly handles percent-encoded proxy credentials, but waits
 * forever for the proxy's CONNECT response and buffers an unterminated response
 * without a limit. The request does not own the socket during that wait, so
 * destroying the request (which is what `steam-session` cancellation reaches)
 * cannot close it. This subclass owns that short phase and destroys the exact
 * socket it created on either bound.
 *
 * The timeout is per connection. Putting one AbortSignal on the agent itself
 * would reuse an already-aborted signal on every later request.
 */
export class BoundedHttpsProxyAgent extends HttpsProxyAgent<string> {
	constructor(
		proxy: string,
		private readonly connectResponseTimeoutMs = PROXY_CONNECT_TIMEOUT_MS,
		private readonly connectResponseHeaderLimit = maxHeaderSize
	) {
		super(proxy);
		if (!Number.isSafeInteger(connectResponseTimeoutMs) || connectResponseTimeoutMs <= 0) {
			throw new RangeError('proxy CONNECT timeout must be a positive integer');
		}
		if (!Number.isSafeInteger(connectResponseHeaderLimit) || connectResponseHeaderLimit <= 0) {
			throw new RangeError('proxy CONNECT header limit must be a positive integer');
		}
	}

	override async connect(req: ClientRequest, opts: AgentConnectOptions): Promise<net.Socket> {
		if (!opts.host) {
			throw new TypeError('No "host" provided');
		}

		const socket =
			this.proxy.protocol === 'https:'
				? tls.connect(setServernameFromNonIpHost(this.connectOpts))
				: net.connect(this.connectOpts);

		const headers =
			typeof this.proxyHeaders === 'function' ? this.proxyHeaders() : { ...this.proxyHeaders };
		const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
		let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r\n`;

		// `steamSessionProxy` gives the base class one canonical encoded URL.
		// Decode that userinfo exactly once, matching https-proxy-agent v7.
		if (this.proxy.username || this.proxy.password) {
			const auth = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
			headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
		}
		headers.Host = `${host}:${opts.port}`;
		if (!headers['Proxy-Connection']) {
			headers['Proxy-Connection'] = this.keepAlive ? 'Keep-Alive' : 'close';
		}
		for (const name of Object.keys(headers)) {
			const value = headers[name];
			if (value !== undefined) payload += `${name}: ${String(value)}\r\n`;
		}

		const response = parseConnectResponse(socket, this.connectResponseHeaderLimit);
		let timer: NodeJS.Timeout;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				// The ClientRequest has not received this socket yet. Destroying the
				// request cannot reach it, so the deadline must close it here.
				socket.destroy();
				reject(
					new ProxyConnectionError('Proxy connection timed out while waiting for CONNECT response')
				);
			}, this.connectResponseTimeoutMs);
			timer.unref?.();
		});

		let connect: ConnectResponse;
		try {
			socket.write(`${payload}\r\n`);
			connect = await Promise.race([response, deadline]);
		} catch (error) {
			socket.destroy();
			const failure = error instanceof Error ? error : new Error(String(error));
			if (failure instanceof ProxyConnectionError) throw failure;
			throw new ProxyConnectionError(`Proxy CONNECT failed: ${failure.message}`, {
				cause: error
			});
		} finally {
			clearTimeout(timer!);
		}

		req.emit('proxyConnect', connect);
		this.emit('proxyConnect', connect, req);

		if (connect.statusCode !== 200) {
			// Do not replay the proxy response as though it came from Steam. Apart
			// from misreporting a 407 as a Steam WebAPI error, that hands Node a
			// socket on which it might try to send the origin request.
			socket.destroy();
			throw new ProxyConnectionError(
				`Proxy CONNECT ${connect.statusCode}${connect.statusText ? ` ${connect.statusText}` : ''}`
			);
		}

		req.once('socket', resume);
		if (!opts.secureEndpoint) {
			return socket;
		}

		return tls.connect({
			...omit(setServernameFromNonIpHost(opts), 'host', 'path', 'port'),
			socket
		});
	}
}

/**
 * A prebuilt SOCKS agent with the same per-handshake deadline as HTTP CONNECT.
 *
 * Returning a URL lets steam-session construct its own agent with the library's
 * thirty-second default. More importantly, the caller cannot reach the socket
 * during that wait. Supplying the agent makes the deadline explicit, while this
 * wrapper gives every non-timeout handshake rejection an owned error type so it
 * cannot be mistaken for an answer from Steam.
 */
export class BoundedSocksProxyAgent extends SocksProxyAgent {
	constructor(
		proxy: string,
		private readonly handshakeTimeoutMs = PROXY_CONNECT_TIMEOUT_MS
	) {
		/*
		 * Deliberately do not pass `{ timeout }` to socks-proxy-agent@7. That
		 * option bounds SocksClient correctly, but the agent then reuses it as a
		 * lifetime `socket.setTimeout()` after negotiation succeeds. A quiet Steam
		 * response is traffic, not a failed proxy handshake.
		 */
		super(proxy);
		if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
			throw new RangeError('SOCKS proxy handshake timeout must be a positive integer');
		}
	}

	override async callback(
		req: SocksConnectParameters[0],
		opts: SocksConnectParameters[1]
	): Promise<net.Socket> {
		let socket: net.Socket | undefined;
		try {
			const internals = this as unknown as SocksAgentInternals;
			let host = opts.host;
			if (host === undefined || host === null || host === '') {
				throw new TypeError('No `host` defined');
			}
			if (internals.shouldLookup) {
				host = await lookupAddress(host, opts.lookup ?? dnsLookup);
			}

			const connected = await SocksClient.createConnection({
				proxy: internals.proxy,
				destination: { host, port: Number(opts.port) },
				command: 'connect',
				timeout: this.handshakeTimeoutMs
			});
			socket = connected.socket;

			if (!opts.secureEndpoint) {
				return socket;
			}

			const destinationTlsOptions = omit(
				setServernameFromNonIpHost(opts),
				'host',
				'path',
				'port'
			) as unknown as tls.ConnectionOptions;
			const tlsSocket = tls.connect({
				...destinationTlsOptions,
				...internals.tlsConnectionOptions,
				socket
			});
			tlsSocket.once('error', () => {
				req.destroy();
				socket?.destroy();
				tlsSocket.destroy();
			});
			return tlsSocket;
		} catch (error) {
			socket?.destroy();
			const message = error instanceof Error ? error.message : String(error);
			throw new ProxyConnectionError(`SOCKS proxy handshake failed: ${message}`, {
				cause: error
			});
		}
	}
}

function lookupAddress(host: string, lookup: net.LookupFunction): Promise<string> {
	return new Promise((resolve, reject) => {
		lookup(host, {}, (error, address) => {
			if (error) {
				reject(error);
				return;
			}
			if (typeof address === 'string') {
				resolve(address);
				return;
			}
			const first = address[0];
			if (!first) {
				reject(new Error(`DNS returned no address for ${host}`));
				return;
			}
			resolve(first.address);
		});
	});
}

function parseConnectResponse(socket: net.Socket, limit: number): Promise<ConnectResponse> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let headerLength = 0;
		let terminatorMatched = 0;
		let settled = false;
		const terminator = Buffer.from('\r\n\r\n');

		const cleanup = (): void => {
			socket.removeListener('end', onEnd);
			socket.removeListener('error', onError);
			socket.removeListener('readable', read);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onEnd = (): void => {
			fail(new Error('Proxy connection ended before receiving CONNECT response'));
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const read = (): void => {
			let raw: Buffer | string | null;
			while ((raw = socket.read() as Buffer | string | null) !== null) {
				const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
				for (let index = 0; index < chunk.length; index += 1) {
					headerLength += 1;
					if (headerLength > limit) {
						fail(new Error(`Proxy CONNECT response headers exceeded ${limit} bytes`));
						return;
					}

					const byte = chunk[index] as number;
					if (byte === terminator[terminatorMatched]) terminatorMatched += 1;
					else terminatorMatched = byte === terminator[0] ? 1 : 0;
					if (terminatorMatched !== terminator.length) continue;

					const endInChunk = index + 1;
					chunks.push(chunk.subarray(0, endInChunk));
					const buffered = Buffer.concat(chunks, headerLength);
					const remainder = chunk.subarray(endInChunk);
					if (remainder.length > 0) socket.unshift(remainder);

					let connect: ConnectResponse;
					try {
						connect = parseConnectHeaders(buffered.subarray(0, -terminator.length));
					} catch (error) {
						fail(error instanceof Error ? error : new Error(String(error)));
						return;
					}
					settled = true;
					cleanup();
					resolve(connect);
					return;
				}
				chunks.push(chunk);
			}
			socket.once('readable', read);
		};

		socket.on('error', onError);
		socket.on('end', onEnd);
		read();
	});
}

function parseConnectHeaders(header: Buffer): ConnectResponse {
	const lines = header.toString('latin1').split('\r\n');
	const statusLine = lines.shift();
	const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine ?? '');
	if (match === null) {
		throw new Error('Invalid response from proxy CONNECT request');
	}

	const statusCode = Number(match[1]);
	const headers: IncomingHttpHeaders = {};
	for (const line of lines) {
		if (line === '') continue;
		const colon = line.indexOf(':');
		if (colon === -1) {
			throw new Error('Invalid header in proxy CONNECT response');
		}
		const name = line.slice(0, colon).toLowerCase();
		const value = line.slice(colon + 1).trimStart();
		const current = headers[name];
		if (current === undefined) headers[name] = value;
		else if (Array.isArray(current)) current.push(value);
		else headers[name] = [current, value];
	}

	return { statusCode, statusText: match[2] ?? '', headers };
}

function setServernameFromNonIpHost<T extends { host?: string; servername?: string }>(
	options: T
): T {
	if (options.servername === undefined && options.host && !net.isIP(options.host)) {
		return { ...options, servername: options.host };
	}
	return options;
}

function omit<T extends object, K extends keyof T>(object: T, ...keys: K[]): Omit<T, K> {
	const result = { ...object };
	for (const key of keys) delete result[key];
	return result;
}

function resume(socket: net.Socket): void {
	socket.resume();
}
