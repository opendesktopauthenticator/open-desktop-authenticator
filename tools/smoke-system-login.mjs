/**
 * Drive the system-routed steam-session adapter through real Electron net.
 *
 * Both destinations are loopback. `setProxy({ mode: 'system' })` changes only
 * the unique in-memory Electron session; this never edits the host proxy.
 */
import { app, net, session as electronSession } from 'electron';
import { createServer } from 'node:http';
import {
	createSystemLoginTransportFactory,
	SYSTEM_PROXY_AUTH_REQUIRED
} from '../src/main/steam/system-login-transport.ts';

app.disableHardwareAcceleration();

const results = [];
const check = (name, pass, detail = '') => {
	results.push(pass);
	process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 3000) => {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (predicate()) return true;
		await wait(20);
	}
	return predicate();
};

const deadline = setTimeout(() => {
	process.stdout.write('FAIL  system-login smoke timed out\n');
	app.exit(1);
}, 45_000);

app
	.whenReady()
	.then(async () => {
		let target;
		let authProxy;
		let transport;
		let challenged;
		let recovered;
		try {
			const requests = [];
			let hangingSeen = false;
			target = createServer((request, response) => {
				const chunks = [];
				request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
				request.on('end', () => {
					requests.push({
						method: request.method,
						url: request.url,
						headers: request.headers,
						body: Buffer.concat(chunks).toString('utf8')
					});
					if (String(request.url).includes('BeginAuthSessionViaCredentials')) {
						hangingSeen = true;
						return;
					}
					response.writeHead(200, {
						'x-eresult': '1',
						'x-error_message': 'smoke evidence',
						'content-type': 'application/octet-stream'
					});
					response.end(Buffer.from([0, 255, 1]));
				});
			});
			await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
			const address = target.address();
			const partitions = [];
			const networking = {
				sessionFromPartition: (name, options) => {
					partitions.push(name);
					return electronSession.fromPartition(name, options);
				},
				request: ({ url, method, session, redirect }) =>
					net.request({ url, method, session, redirect })
			};
			const factory = createSystemLoginTransportFactory(networking, {
				partition: `steam-login-system-smoke-${Date.now()}`,
				loopbackOriginForSmoke: `http://127.0.0.1:${address.port}`,
				boundary: () => '-----------------------------smokeboundary',
				timeoutMs: 5000
			});
			transport = factory();

			const rsa = await transport.sendRequest({
				apiInterface: 'Authentication',
				apiMethod: 'GetPasswordRSAPublicKey',
				apiVersion: 1,
				requestData: Buffer.from([0xfb, 0xff])
			});
			const first = requests[0];
			check(
				'the real adapter sends the RSA GET and maps raw response evidence',
				first?.method === 'GET' &&
					String(first?.url).includes('input_protobuf_encoded=%2B%2F8%3D') &&
					Buffer.from(rsa.responseData ?? []).equals(Buffer.from([0, 255, 1])) &&
					rsa.result === 1 &&
					rsa.errorMessage === 'smoke evidence'
			);
			check(
				'the pinned fetch headers survive Chromium onto the wire',
				first?.headers['sec-fetch-site'] === 'cross-site' &&
					first?.headers['sec-fetch-mode'] === 'cors' &&
					first?.headers['sec-fetch-dest'] === 'empty',
				JSON.stringify({
					site: first?.headers['sec-fetch-site'],
					mode: first?.headers['sec-fetch-mode'],
					dest: first?.headers['sec-fetch-dest']
				})
			);

			const hanging = transport
				.sendRequest({
					apiInterface: 'Authentication',
					apiMethod: 'BeginAuthSessionViaCredentials',
					apiVersion: 1,
					requestData: Buffer.from([0xfb, 0xff])
				})
				.then(
					() => false,
					() => true
				);
			await waitFor(() => hangingSeen);
			const second = requests[1];
			check(
				'the real adapter sends the pinned multipart bytes and derived length',
				second?.method === 'POST' &&
					String(second?.headers['content-type']).includes(
						'boundary=-----------------------------smokeboundary'
					) &&
					second?.body.includes('name="input_protobuf_encoded"\r\n\r\n+/8=') &&
					Number(second?.headers['content-length']) === Buffer.byteLength(second?.body ?? '')
			);

			transport.close();
			check(
				'close settles the real active Electron request immediately',
				(await Promise.race([hanging, wait(500).then(() => false)])) === true
			);

			/*
			 * Electron retains every named partition for the process lifetime. Exercise
			 * enough complete leases to expose the old one-partition-per-attempt slope,
			 * then prove the production factory used one bounded network context.
			 */
			const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
			const runBatch = async (count) => {
				for (let index = 0; index < count; index += 1) {
					const current = factory();
					try {
						const answer = await current.sendRequest({
							apiInterface: 'Authentication',
							apiMethod: 'GetPasswordRSAPublicKey',
							apiVersion: 1
						});
						if (answer.result !== 1) throw new Error('the repeated login request lost its result');
					} finally {
						current.close();
					}
				}
				await wait(400);
			};
			await wait(300);
			const beforeWarm = rssMb();
			await runBatch(36);
			const afterWarm = rssMb();
			await runBatch(36);
			const afterLater = rssMb();
			const warmGrowth = afterWarm - beforeWarm;
			const laterGrowth = afterLater - afterWarm;
			check(
				'all completed system-login leases reuse one bounded in-memory partition',
				partitions.length === 1 && new Set(partitions).size === 1,
				`${partitions.length} session lookup(s), ${new Set(partitions).size} partition(s)`
			);
			check(
				'the later completed-attempt batch has no retained-session memory slope',
				laterGrowth < 12,
				`first 36 ${warmGrowth < 0 ? '' : '+'}${warmGrowth} MB, later 36 ${
					laterGrowth < 0 ? '' : '+'
				}${laterGrowth} MB`
			);

			/*
			 * Force `mode: system` through a real Basic-authenticating proxy. The app
			 * does not retain machine proxy credentials, so it must answer the Electron
			 * challenge empty, stop after one proxy hit, and tell the user to configure
			 * the existing per-account proxy field. A following unauthenticated request
			 * on the same bounded session must still work.
			 */
			let proxyRequiresAuth = true;
			const proxyRequests = [];
			authProxy = createServer((request, response) => {
				proxyRequests.push({
					url: request.url,
					authorization: request.headers['proxy-authorization']
				});
				if (proxyRequiresAuth) {
					response.writeHead(407, {
						'proxy-authenticate': 'Basic realm="private-system-proxy"'
					});
					response.end();
					return;
				}
				response.writeHead(200, {
					'x-eresult': '1',
					'content-type': 'application/octet-stream'
				});
				response.end(Buffer.from([7, 8, 9]));
			});
			await new Promise((resolve) => authProxy.listen(0, '127.0.0.1', resolve));
			const proxyAddress = authProxy.address();
			const authPartitions = [];
			const rawSessions = new WeakMap();
			const authNetworking = {
				sessionFromPartition: (name, options) => {
					authPartitions.push(name);
					const raw = electronSession.fromPartition(name, options);
					const wrapper = {
						setProxy: () =>
							raw.setProxy({
								mode: 'fixed_servers',
								proxyRules:
									`http=127.0.0.1:${proxyAddress.port};` + `https=127.0.0.1:${proxyAddress.port}`,
								proxyBypassRules: '<-loopback>'
							}),
						resolveProxy: (url) => raw.resolveProxy(url),
						webRequest: raw.webRequest,
						clearStorageData: () => raw.clearStorageData(),
						closeAllConnections: () => raw.closeAllConnections()
					};
					rawSessions.set(wrapper, raw);
					return wrapper;
				},
				request: ({ url, method, session, redirect }) =>
					net.request({
						url,
						method,
						session: rawSessions.get(session),
						redirect
					})
			};
			const authFactory = createSystemLoginTransportFactory(authNetworking, {
				partition: `steam-login-system-auth-smoke-${Date.now()}`,
				loopbackOriginForSmoke: `http://127.0.0.1:${address.port}`,
				timeoutMs: 5000
			});
			const originBeforeAuth = requests.length;
			challenged = authFactory();
			const challengeFailure = await challenged
				.sendRequest({
					apiInterface: 'Authentication',
					apiMethod: 'GetPasswordRSAPublicKey',
					apiVersion: 1
				})
				.then(
					() => undefined,
					(error) => error
				);
			await wait(100);
			check(
				'an authenticated system proxy is refused immediately with one actionable answer',
				challengeFailure instanceof Error &&
					challengeFailure.message === SYSTEM_PROXY_AUTH_REQUIRED &&
					proxyRequests.length === 1,
				challengeFailure instanceof Error
					? `${challengeFailure.message} (${proxyRequests.length} proxy hit(s))`
					: 'the request unexpectedly succeeded'
			);
			check(
				'the refused challenge sends no credentials and makes no origin request',
				proxyRequests[0]?.authorization === undefined && requests.length === originBeforeAuth,
				`${String(proxyRequests[0]?.authorization ?? 'no Proxy-Authorization')}; ${
					requests.length - originBeforeAuth
				} origin hit(s)`
			);
			challenged.close();
			proxyRequiresAuth = false;
			recovered = authFactory();
			const recoveredAnswer = await recovered.sendRequest({
				apiInterface: 'Authentication',
				apiMethod: 'GetPasswordRSAPublicKey',
				apiVersion: 1
			});
			check(
				'the same bounded session can make the next unauthenticated proxy request',
				recoveredAnswer.result === 1 &&
					Buffer.from(recoveredAnswer.responseData ?? []).equals(Buffer.from([7, 8, 9])) &&
					proxyRequests.length === 2 &&
					proxyRequests[1]?.authorization === undefined &&
					requests.length === originBeforeAuth &&
					authPartitions.length === 1,
				`${proxyRequests.length} proxy hit(s), ${requests.length - originBeforeAuth} origin hit(s), ${
					authPartitions.length
				} session lookup(s)`
			);
		} finally {
			transport?.close();
			challenged?.close();
			recovered?.close();
			let closed = true;
			if (authProxy?.listening) {
				authProxy.closeAllConnections?.();
				closed =
					(await new Promise((resolve) =>
						authProxy.close((error) => resolve(error === undefined))
					)) && closed;
			}
			if (target?.listening) {
				target.closeAllConnections?.();
				closed = await new Promise((resolve) =>
					target.close((error) => resolve(error === undefined))
				);
			}
			check(
				'the loopback smoke listeners are closed',
				closed && !target?.listening && !authProxy?.listening
			);
		}
		clearTimeout(deadline);
		const failed = results.filter((result) => !result).length;
		process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
		app.exit(failed === 0 ? 0 : 1);
	})
	.catch((error) => {
		process.stdout.write(`FAIL  ${error instanceof Error ? error.stack : String(error)}\n`);
		clearTimeout(deadline);
		app.exit(1);
	});
