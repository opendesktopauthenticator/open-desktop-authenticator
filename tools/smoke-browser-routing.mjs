/**
 * Real Electron network proof for changing routes on one browser Session.
 *
 * No Steam account and no internet are used. A direct allowlisted hostname is
 * mapped to a local keep-alive server, while the configured account proxy is a
 * second local server. The production `openAccountBrowser` setup runs twice on
 * one deterministic partition: Steam-only first, fully proxied second.
 */
import { app, net } from 'electron';
import { createServer } from 'node:http';

import { electronBrowserHost } from '../src/main/browser/electron-host.ts';
import { browserPartitionFor, openAccountBrowser, START_URL } from '../src/main/browser/window.ts';
import { DIRECT_CALLBACK_HOSTS, DIRECT_CONTENT_DOMAINS } from '../src/main/net/egress.ts';

const DIRECT_CANDIDATES = [...DIRECT_CONTENT_DOMAINS, ...DIRECT_CALLBACK_HOSTS];

// This harness exercises the network service, not graphics. Keeping the GPU in
// process avoids a separate graphics helper on headless Windows build hosts.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch(
	'host-resolver-rules',
	DIRECT_CANDIDATES.map((host) => `MAP ${host} 127.0.0.1`).join(', ')
);

const checks = [];
const deadline = setTimeout(() => {
	process.stderr.write('FAIL  browser route-switch smoke timed out\n');
	app.exit(1);
}, 30_000);
const check = (name, pass, detail = '') => {
	checks.push(pass);
	process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const listen = (server) =>
	new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const close = async (server) => {
	server.closeAllConnections?.();
	await new Promise((resolve) => server.close(resolve));
};

const request = (session, url) =>
	new Promise((resolve, reject) => {
		const outgoing = net.request({ session, url });
		outgoing.once('response', (response) => {
			response.on('data', () => undefined);
			response.once('end', resolve);
		});
		outgoing.once('error', reject);
		outgoing.end();
	});

/** A successful, hidden stand-in for the window; routing remains real Electron. */
const setupWindow = () => {
	let current = START_URL;
	let destroyed = false;
	return {
		loadURL: async (url) => {
			current = url;
			return url;
		},
		currentUrl: () => current,
		setTitle: () => undefined,
		setWebRtcPolicy: () => undefined,
		setProxyCredentials: () => undefined,
		setWindowOpenHandler: () => undefined,
		on: () => undefined,
		focus: () => undefined,
		show: () => undefined,
		close: () => {
			destroyed = true;
		},
		isDestroyed: () => destroyed
	};
};

const main = async () => {
	const proxyHits = [];
	const proxy = createServer((incoming, response) => {
		proxyHits.push(incoming.url ?? '');
		const body = 'proxied';
		response.writeHead(200, {
			'Content-Type': 'text/plain',
			'Content-Length': Buffer.byteLength(body),
			Connection: 'close'
		});
		response.end(body);
	});
	const proxyPort = await listen(proxy);

	const directHits = [];
	const direct = createServer((incoming, response) => {
		directHits.push({ host: incoming.headers.host ?? '', url: incoming.url ?? '' });
		const body = 'direct';
		response.writeHead(200, {
			'Content-Type': 'text/plain',
			'Content-Length': Buffer.byteLength(body),
			Connection: 'keep-alive',
			'Keep-Alive': 'timeout=60'
		});
		response.end(body);
	});
	direct.keepAliveTimeout = 60_000;
	// HSTS-preloaded candidates speak TLS to this intentionally plain fixture.
	// Reject them and select the first allowlisted host that really made HTTP.
	direct.on('clientError', (_error, socket) => socket.destroy());
	const directPort = await listen(direct);

	const account = {
		steamId64: '76561198000000999',
		accountName: 'route-switch-smoke',
		proxyUrl: `http://127.0.0.1:${proxyPort}`,
		accessToken: 'offline-smoke-token'
	};
	const host = {
		sessionFromPartition: (partition, options) =>
			electronBrowserHost.sessionFromPartition(partition, options),
		createWindow: setupWindow
	};

	await openAccountBrowser(host, { ...account, route: 'steam-only' });
	const partition = browserPartitionFor(account.steamId64);
	const browserSession = electronBrowserHost.sessionFromPartition(partition, { cache: false });
	let selectedHost;
	for (const [at, candidate] of DIRECT_CANDIDATES.entries()) {
		const path = `/pool-seed-${at}`;
		await request(browserSession, `http://${candidate}:${directPort}${path}`).catch(
			() => undefined
		);
		if (directHits.some((hit) => hit.url === path)) {
			selectedHost = candidate;
			break;
		}
	}
	check(
		'Steam-only establishes a reusable direct connection on its promised route',
		selectedHost !== undefined && proxyHits.length === 0,
		`selected=${selectedHost ?? '(none)'} direct=${directHits.length} proxy=${proxyHits.length}`
	);

	/*
	 * This second production setup performs setProxy + closeAllConnections on the
	 * same Session. Without the close, Chromium is allowed to reuse the pooled
	 * direct socket despite resolveProxy reporting the new account proxy.
	 */
	await openAccountBrowser(host, { ...account, route: 'proxy' });
	const directBefore = directHits.length;
	const proxyBefore = proxyHits.length;
	if (selectedHost !== undefined) {
		await request(browserSession, `http://${selectedHost}:${directPort}/after-switch`).catch(
			() => undefined
		);
	}
	const newProxyHits = proxyHits.slice(proxyBefore);
	check(
		'the fully proxied replacement cannot reuse the old direct connection pool',
		selectedHost !== undefined &&
			directHits.length === directBefore &&
			newProxyHits.some((url) => url.includes(selectedHost)),
		`direct=${
			directHits
				.slice(directBefore)
				.map(({ host: seenHost, url }) => `${seenHost}${url}`)
				.join(', ') || '(none)'
		} proxy=${newProxyHits.join(', ') || '(none)'}`
	);

	await browserSession.closeAllConnections();
	await browserSession.clearStorageData?.();
	await Promise.all([close(direct), close(proxy)]);

	const failed = checks.filter((passed) => !passed).length;
	process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`);
	clearTimeout(deadline);
	app.exit(failed === 0 ? 0 : 1);
};

app.whenReady().then(() =>
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		app.exit(1);
	})
);
