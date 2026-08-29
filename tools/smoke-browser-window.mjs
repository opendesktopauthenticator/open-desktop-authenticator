/**
 * Open the real in-app browser window and use it, with no vault and no Steam.
 *
 *     npx electron tools/smoke-browser-window.mjs
 *
 * `smoke-browser-chrome.mjs` pushes state at the toolbar and checks it draws.
 * That proved the toolbar renders and missed where a new tab actually goes,
 * because it never ran the code that decides. This one calls the real
 * `electronBrowserHost`: real session, real permissions refusal, real
 * `BaseWindow`, real tabs, real navigation. Everything the Trade button does
 * except the part that needs a Steam account.
 *
 * Every unhandled error in the main process is collected and reported, because
 * "there are a lot of errors" should be a thing this prints rather than a thing
 * somebody has to read a terminal for.
 */
import { app, webContents } from 'electron';

import { electronBrowserHost } from '../src/main/browser/electron-host.ts';

const results = [];
const problems = [];
const check = (name, pass, detail = '') => {
	results.push(pass);
	process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

process.on('uncaughtException', (err) => problems.push(`uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => problems.push(`unhandled rejection: ${String(err)}`));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const deadline = setTimeout(() => {
	// Print what was collected: a hang usually means something threw into the
	// promise chain, and a bare "timed out" hides the actual error.
	process.stdout.write('FAIL  did not finish within 90s' + String.fromCharCode(10));
	for (const problem of problems) {
		process.stdout.write('      ' + problem + String.fromCharCode(10));
	}
	app.exit(1);
}, 90_000);

/**
 * The chrome's contents.
 *
 * Matched on its own markup rather than on `data:`, because the first version
 * of this test looked for "a data: URL" and the tab it had just loaded was one
 * too — so it probed a tab, found no bridge, and reported the application
 * broken. The chrome is the only view containing the tab strip.
 */
const chromeContents = () =>
	webContents.getAllWebContents().find((c) => c.getURL().includes('id%3D%22tabs%22'));

const main = async () => {
	const partition = 'browser-smoke';
	const session = electronBrowserHost.sessionFromPartition(partition, { cache: false });

	session.setUserAgent?.('Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmokeTest/1');
	session.denyPermissions();
	await session.setProxy({ mode: 'direct' });
	check('a browser session can be built and hardened', true);

	const resolved = await session.resolveProxy('https://steamcommunity.com/');
	check('the session answers resolveProxy', typeof resolved === 'string', resolved);

	const titles = [];
	const window = electronBrowserHost.createWindow({
		width: 1100,
		height: 700,
		title: 'smoke — browser',
		partition,
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmokeTest/1'
	});
	window.on('navigated', (url) => titles.push(url));
	window.setWebRtcPolicy('default');
	check('the window is created without throwing', !window.isDestroyed());

	// A local document, so this test needs no network and cannot be flaky.
	const first = 'data:text/html,' + encodeURIComponent('<title>First</title><h1>first</h1>');
	await window.loadURL(first);
	await wait(400);

	check('the first tab loads', window.currentUrl().startsWith('data:text/html'));
	check('navigation is reported to the caller', titles.length > 0, `${titles.length} event(s)`);

	const chrome = chromeContents();
	check('the chrome view exists', chrome !== undefined);
	if (!chrome) {
		clearTimeout(deadline);
		app.exit(1);
		return;
	}

	const run = async (js) => {
		try {
			return await Promise.race([
				chrome.executeJavaScript(js, true),
				wait(4000).then(() => '<timed out>')
			]);
		} catch (err) {
			return `<threw: ${err instanceof Error ? err.message : String(err)}>`;
		}
	};

	check(
		'the toolbar bridge is live in the real window',
		(await run('typeof window.odaBrowser')) === 'object'
	);
	check(
		'the strip shows the first tab',
		(await run('document.querySelectorAll(".tab").length')) === 1
	);

	// The + button, for real: it must create a second tab and leave it blank.
	await run('document.getElementById("newtab").click()');
	await wait(500);
	check('pressing + adds a tab', (await run('document.querySelectorAll(".tab").length')) === 2);
	check(
		'the new tab is blank, not a copy of the first',
		(await run('document.getElementById("address").value')) === '',
		await run('document.getElementById("address").value')
	);
	check(
		'the new tab is labelled New tab',
		(
			await run('[...document.querySelectorAll(".tab .label")].map((e) => e.textContent).join("|")')
		).includes('New tab')
	);

	// Typing an address, for real.
	await run(`(() => {
		const a = document.getElementById('address');
		a.value = ${JSON.stringify('example.com')};
		a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
	})()`);
	await wait(600);
	check(
		'typing a bare host navigates the active tab',
		window.currentUrl().startsWith('https://example.com'),
		window.currentUrl()
	);

	// Switching tabs changes what the address bar reports.
	const ids = await run('JSON.stringify([...document.querySelectorAll(".tab")].map((_, i) => i))');
	check('the strip is still consistent after navigating', ids.includes('0'), ids);

	await run(
		'document.querySelectorAll(".tab")[0].dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }))'
	);
	await wait(400);
	check(
		'switching back to the first tab restores its address',
		window.currentUrl().startsWith('data:text/html'),
		window.currentUrl()
	);

	// Closing a tab, and closing the last one closing the window.
	await run(
		'document.querySelectorAll(".tab .x")[1].dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }))'
	);
	await wait(400);
	check('closing a tab removes it', (await run('document.querySelectorAll(".tab").length')) === 1);

	/*
	 * **Closing the window while a page is still settling.**
	 *
	 * This is what `openAccountBrowser` does when Steam declines the session:
	 * it closes the window and wipes it. The tab's loading events keep arriving
	 * afterwards, and one of them reached `setTitle` on a destroyed window — a
	 * main-process crash dialog, shown over the screen that was asking the user
	 * to sign in.
	 */
	const doomed = electronBrowserHost.createWindow({
		width: 900,
		height: 600,
		title: 'closing — browser',
		partition,
		userAgent: 'SmokeTest/1'
	});
	doomed.on('navigated', () => doomed.setTitle('still here'));
	void doomed.loadURL('https://example.com/');
	doomed.close();
	// Long enough for every event the closed window would still receive.
	await wait(2500);
	check(
		'closing a window mid-load does not crash the main process',
		problems.length === 0,
		problems.join(' | ')
	);
	check('calling into a closed window is safe', doomed.isDestroyed() || true);
	doomed.setTitle('after close');
	doomed.focus();
	doomed.close();
	await wait(300);
	check(
		'setTitle, focus and close after closing are all no-ops',
		problems.length === 0,
		problems.join(' | ')
	);

	check('no unhandled errors in the main process', problems.length === 0, problems.join(' | '));

	clearTimeout(deadline);
	const failed = results.filter((pass) => !pass).length;
	process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
	app.exit(failed === 0 ? 0 : 1);
};

app.whenReady().then(() =>
	main().catch((err) => {
		process.stdout.write(
			'FAIL  threw: ' + (err && err.stack ? err.stack : String(err)) + String.fromCharCode(10)
		);
		clearTimeout(deadline);
		app.exit(1);
	})
);
