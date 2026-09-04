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
import { app, BaseWindow, webContents } from 'electron';
import { createServer } from 'node:http';

import { electronBrowserHost } from '../src/main/browser/electron-host.ts';
import { loadInitialBrowserPage } from '../src/main/browser/window.ts';
import { DIRECT_CONTENT_DOMAINS, planProxy, steamOnlyBypass } from '../src/main/net/egress.ts';

const results = [];
const problems = [];
const check = (name, pass, detail = '') => {
	results.push(pass);
	process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

process.on('uncaughtException', (err) => problems.push(`uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => problems.push(`unhandled rejection: ${String(err)}`));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a real Chromium transition without treating one machine's DNS latency as failure. */
const waitFor = async (predicate, timeoutMs = 8000) => {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (predicate()) return true;
		await wait(50);
	}
	return predicate();
};

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

/** `run`, but against whichever contents is passed rather than the first chrome. */
const run2 = async (contents, js) => {
	if (!contents || contents.isDestroyed()) return '<gone>';
	try {
		return await Promise.race([
			contents.executeJavaScript(js, true),
			wait(4000).then(() => '<timed out>')
		]);
	} catch (err) {
		return `<threw: ${err instanceof Error ? err.message : String(err)}>`;
	}
};

const main = async () => {
	const partition = 'browser-smoke';
	const session = electronBrowserHost.sessionFromPartition(partition, { cache: false });

	session.setUserAgent?.('Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmokeTest/1');
	session.denyPermissions();
	await session.setProxy({ mode: 'direct' });
	check('a browser session can be built and hardened', true);

	const resolved = await session.resolveProxy('https://steamcommunity.com/');
	check('the session answers resolveProxy', typeof resolved === 'string', resolved);

	/*
	 * The account opener uses this mode while it judges Steam's first landing.
	 * A dead session lands on a real password form, so it is not enough to close
	 * the window after the load: that page must never have become visible.
	 */
	const beforeHidden = new Set(BaseWindow.getAllWindows().map((candidate) => candidate.id));
	const beforeHiddenContents = new Set(
		webContents.getAllWebContents().map((candidate) => candidate.id)
	);
	const hiddenLanding = createServer((request, response) => {
		response.setHeader('content-type', 'text/html');
		if (request.url === '/partial') {
			// Headers and useful-looking body bytes arrive, but the response never
			// finishes. This is the real Chromium case in which loadURL stayed pending.
			response.writeHead(200, { 'content-length': '1000000' });
			response.write('<title>Partial Steam-shaped page</title><h1>still loading');
			return;
		}
		if (request.url === '/popup') {
			response.end('<title>Accepted-looking popup</title><h1>popup</h1>');
			return;
		}
		response.end(
			'<title>Sign in</title><input type="password"><script>window.open("/popup")</script>'
		);
	});
	await new Promise((resolve) => hiddenLanding.listen(0, '127.0.0.1', resolve));
	const hiddenAddress = hiddenLanding.address();
	const passwordPage = `http://127.0.0.1:${hiddenAddress.port}/landing`;
	const hidden = electronBrowserHost.createWindow({
		width: 700,
		height: 500,
		title: 'unjudged landing',
		partition: 'browser-smoke-hidden',
		userAgent: 'SmokeTest/1',
		show: false
	});
	hidden.setWindowOpenHandler(() => ({ action: 'deny' }));
	const hiddenNative = BaseWindow.getAllWindows().find(
		(candidate) => !beforeHidden.has(candidate.id)
	);
	check(
		'a first landing can be created without exposing a native window',
		hiddenNative !== undefined && !hiddenNative.isVisible()
	);
	const exactLanding = await hidden.loadURL(passwordPage);
	await wait(300);
	check(
		'a parsed password page remains hidden until the caller accepts the landing',
		hidden.currentUrl() === passwordPage && hiddenNative !== undefined && !hiddenNative.isVisible()
	);
	check(
		'the first-load result names that exact tab, not a mutable active tab',
		exactLanding === passwordPage,
		String(exactLanding)
	);
	check(
		'a popup cannot replace or survive beside an unjudged first landing',
		!webContents
			.getAllWebContents()
			.filter((candidate) => !beforeHiddenContents.has(candidate.id))
			.some((candidate) => candidate.getURL().endsWith('/popup'))
	);
	hidden.show();
	check('an accepted landing can then be revealed', hiddenNative?.isVisible() === true);

	/*
	 * A response can be alive enough to deliver headers and a body prefix while
	 * never completing. Drive the production deadline helper against that exact
	 * socket state, then prove a new real Electron window can load immediately.
	 */
	const beforeStallContents = new Set(
		webContents.getAllWebContents().map((candidate) => candidate.id)
	);
	const stalled = electronBrowserHost.createWindow({
		width: 700,
		height: 500,
		title: 'bounded partial landing',
		partition: 'browser-smoke-partial',
		userAgent: 'SmokeTest/1',
		show: false
	});
	const partialOutcome = await loadInitialBrowserPage(
		stalled,
		`http://127.0.0.1:${hiddenAddress.port}/partial`,
		{
			timeoutMs: 300,
			schedule: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
			cancel: (handle) => clearTimeout(handle)
		}
	).then(
		() => 'resolved',
		(error) => `rejected: ${error instanceof Error ? error.message : String(error)}`
	);
	check(
		'a partial response which never ends reaches the first-page deadline',
		partialOutcome.includes('timed out'),
		partialOutcome
	);
	stalled.close();
	await electronBrowserHost
		.sessionFromPartition('browser-smoke-partial', { cache: false })
		.clearStorageData?.();
	const retiredStall = await waitFor(
		() =>
			stalled.isDestroyed() &&
			!webContents
				.getAllWebContents()
				.filter((candidate) => !beforeStallContents.has(candidate.id))
				.some((candidate) => !candidate.isDestroyed())
	);
	check('the timed-out hidden window leaves no live WebContents behind', retiredStall);

	const retry = electronBrowserHost.createWindow({
		width: 700,
		height: 500,
		title: 'retry after partial landing',
		partition: 'browser-smoke-partial',
		userAgent: 'SmokeTest/1',
		show: false
	});
	const retryLanding = await loadInitialBrowserPage(
		retry,
		`http://127.0.0.1:${hiddenAddress.port}/popup`,
		{
			timeoutMs: 2_000,
			schedule: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
			cancel: (handle) => clearTimeout(handle)
		}
	);
	check(
		'a fresh real Electron window loads after the timed-out attempt',
		retryLanding.endsWith('/popup')
	);
	retry.close();
	await electronBrowserHost
		.sessionFromPartition('browser-smoke-partial', { cache: false })
		.clearStorageData?.();

	const titles = [];
	const window = electronBrowserHost.createWindow({
		width: 1100,
		height: 700,
		title: 'smoke — browser',
		partition,
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmokeTest/1'
	});
	// Keep one native window alive before retiring the probe: Electron exits when
	// its last window closes, which would turn the rest of this run into a false
	// successful no-op.
	hidden.close();
	hiddenLanding.close();
	await wait(200);
	window.on('navigated', (url) => titles.push(url));
	window.setWebRtcPolicy('default');
	check('the window is created without throwing', !window.isDestroyed());

	// A local document, so this test needs no network and cannot be flaky.
	const first = 'data:text/html,' + encodeURIComponent('<title>First</title><h1>first</h1>');
	await window.loadURL(first);

	/*
	 * **Read on the microtask after the load resolves, with nothing slept off.**
	 *
	 * This check used to sit behind `await wait(400)`, and 400ms is precisely the
	 * gap in which an `about:blank` that had settled this promise early is
	 * replaced by the real page — so the assertion observed a state production
	 * never sees, and would have gone on passing through the whole of the bug the
	 * first-load probe below was written for. `openAccountBrowser` reads
	 * `currentUrl()` the moment its own `loadURL` resolves and decides from it
	 * whether Steam accepted the session; anything this run only learns after a
	 * sleep is not what that caller reads.
	 *
	 * The probe further down proves the same property on a window of its own.
	 * This one must not be quietly weaker than it, so it reads at the same
	 * instant and compares against the exact URL that was asked for rather than
	 * against a prefix that `about:blank` merely happens not to match.
	 */
	check(
		'the first tab loads, and holds the page asked for the instant loadURL resolves',
		window.currentUrl() === first,
		`currentUrl on resolve = ${JSON.stringify(window.currentUrl())}`
	);
	/*
	 * No wait here either: `did-navigate` is what publishes this, and it fires
	 * before the `did-finish-load` that resolves `loadURL`, so the event has
	 * already been delivered by the time the await above returns. The waits kept
	 * further down are the ones covering things that genuinely arrive later — a
	 * click travelling to the main process, a closed window's trailing events.
	 */
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
	await waitFor(() => window.currentUrl().startsWith('https://example.com'));
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
	check(
		'pointer tab selection gives native focus to the selected page',
		!chrome.isFocused(),
		`chrome focused = ${chrome.isFocused()}`
	);

	/*
	 * Delete crosses both focus systems in the real window. The isolated chrome
	 * smoke can prove DOM focus, but not that Chromium still sends keys to that
	 * WebContents after the host focuses the replacement page.
	 */
	await run('document.getElementById("newtab").click()');
	await wait(300);
	check(
		'a third tab is available for keyboard focus traversal',
		(await run('document.querySelectorAll("[role=tab]").length')) === 3
	);
	// Make the first tab active again; deleting it exercises `show(neighbour)`,
	// the path that temporarily gives native focus to the page.
	await run(
		'document.querySelectorAll("[role=tab]")[0].dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }))'
	);
	await wait(300);
	chrome.focus();
	await run(`(() => {
		const tab = document.querySelectorAll('[role=tab]')[0];
		tab.focus();
		tab.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Delete', bubbles: true, cancelable: true
		}));
	})()`);
	await wait(400);
	check(
		'Delete closes the active tab in the real browser window',
		(await run('document.querySelectorAll("[role=tab]").length')) === 2
	);
	check(
		'Delete returns native focus to the tab strip',
		chrome.isFocused(),
		`chrome focused = ${chrome.isFocused()}`
	);
	const focusedAfterDelete = await run(`JSON.stringify({
		role: document.activeElement?.getAttribute('role'),
		id: document.activeElement?.getAttribute('data-tab-id')
	})`);
	check(
		'Delete gives DOM focus to the neighbouring tab',
		JSON.parse(focusedAfterDelete).role === 'tab',
		focusedAfterDelete
	);
	const beforeArrow = JSON.parse(focusedAfterDelete).id;
	await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
		key: 'ArrowRight', bubbles: true, cancelable: true
	}))`);
	const afterArrow = await run("document.activeElement?.getAttribute('data-tab-id')");
	check(
		'the next keyboard command still reaches the tab strip',
		typeof afterArrow === 'string' && afterArrow !== beforeArrow,
		`${beforeArrow} -> ${afterArrow}`
	);
	await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
		key: 'Enter', bubbles: true, cancelable: true
	}))`);
	await wait(300);
	const focusedAfterEnter = await run("document.activeElement?.getAttribute('role')");
	check(
		'Enter activates the keyboard-focused tab without leaving the strip',
		window.currentUrl() === 'about:blank' && chrome.isFocused() && focusedAfterEnter === 'tab',
		`url = ${JSON.stringify(window.currentUrl())}; chrome focused = ${chrome.isFocused()}; DOM role = ${String(focusedAfterEnter)}`
	);
	await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
		key: 'ArrowLeft', bubbles: true, cancelable: true
	}))`);
	await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
		key: ' ', bubbles: true, cancelable: true
	}))`);
	await wait(300);
	const focusedAfterSpace = await run("document.activeElement?.getAttribute('role')");
	check(
		'Space activates another tab without leaving the strip',
		window.currentUrl().startsWith('https://example.com') &&
			chrome.isFocused() &&
			focusedAfterSpace === 'tab',
		`url = ${JSON.stringify(window.currentUrl())}; chrome focused = ${chrome.isFocused()}; DOM role = ${String(focusedAfterSpace)}`
	);

	// A pointer close still works after the keyboard path.
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
	/*
	 * **The load is kept, not thrown away.**
	 *
	 * This was `void doomed.loadURL(...)`, so nothing in this run could say what
	 * closing does to a navigation that is still in flight — and that is the half
	 * of this case with teeth. `openAccountBrowser` awaits exactly this promise
	 * and decides nothing until it settles, so a close that leaves it pending is
	 * a caller that never returns and a sign-in screen that never comes back.
	 *
	 * Both handlers are attached in the same expression as the call, and that is
	 * not tidiness. Closing really does settle this one — `ERR_FAILED (-2)`,
	 * measured here, though it resolves instead when the page wins the race — and
	 * a bare `void` on a rejecting promise fires `unhandledRejection`, which this
	 * file collects into `problems`, which the very next check reports as a
	 * main-process crash that never happened. Handled here, the outcome is
	 * named in the detail below instead of being either swallowed or miscounted.
	 */
	let loadOutcome = 'never settled';
	const doomedLoad = doomed.loadURL('https://example.com/').then(
		() => {
			loadOutcome = 'resolved';
		},
		(err) => {
			loadOutcome = `rejected with ${err instanceof Error ? err.message : String(err)}`;
		}
	);
	doomed.close();
	// Long enough for every event the closed window would still receive.
	await wait(2500);
	// Bounded on purpose. "It never settles" is an outcome to name in the detail
	// below, not a reason for this run to sit here until the 90s deadline kills
	// it and prints a timeout instead of everything after this point.
	await Promise.race([doomedLoad, wait(1000)]);
	check(
		'closing a window mid-load does not crash the main process',
		problems.length === 0,
		problems.join(' | ')
	);
	/*
	 * Asserted, rather than `doomed.isDestroyed() || true`.
	 *
	 * That was the only assertion covering this whole case, and `X || true` is
	 * always true: a window still live and still signed in after `close()` printed
	 * `ok` exactly as loudly as a destroyed one, and the checks either side of it
	 * read only `problems`, so nothing here noticed whether the close had happened
	 * at all. Proved by making the `close()` above a no-op — the run stayed
	 * 55/55 green with a live window sitting in it.
	 */
	check(
		'closing a window mid-load really destroys it',
		doomed.isDestroyed(),
		doomed.isDestroyed()
			? `destroyed, and the load in flight ${loadOutcome}`
			: `STILL LIVE after close() — the account's session keeps running with no window to show it, and no later vault lock can reach it; the load in flight ${loadOutcome}`
	);
	/*
	 * **And the load settles, which is a claim the main process depends on.**
	 *
	 * `AccountBrowsers.open` awaits its own attempt rather than the joiners'
	 * `done`, so the person who pressed the button is released only when the load
	 * finishes — and a sweep that closes the window out from under it is the case
	 * where that has to happen without anyone waiting for the page. The comment
	 * there says Electron rejects with ERR_ABORTED when the contents are
	 * destroyed mid-load. Nothing established that: `loadOutcome` was computed and
	 * printed in a detail string, so `never settled` read exactly as `ok`.
	 *
	 * If this ever fails, the fix is in window.ts, not here: `open` would have to
	 * await `done` instead, and take the ordering consequences.
	 */
	check(
		'closing a window mid-load settles the load, so nobody waits on it for ever',
		loadOutcome !== 'never settled',
		loadOutcome === 'never settled'
			? 'the load neither resolved nor rejected within 1s of the close — a caller awaiting it is parked with no bound'
			: loadOutcome
	);
	doomed.setTitle('after close');
	doomed.focus();
	doomed.close();
	await wait(300);
	check(
		'setTitle, focus and close after closing are all no-ops',
		problems.length === 0,
		problems.join(' | ')
	);

	/*
	 * **A `BaseWindow` does not take its views with it.**
	 *
	 * The one guarantee the move off `BrowserWindow` quietly changed, and the one
	 * no unit test can reach: a `BrowserWindow` destroys the `WebContents` it
	 * owns, a `BaseWindow` owns views, and a `WebContentsView` outlives the window
	 * it was added to. What that left behind was a live renderer still holding the
	 * account's partition, with no window to show it, unreachable by the next
	 * vault lock because `AccountBrowsers` had already forgotten the account — one
	 * more per open-and-close, for as long as the process ran.
	 */
	/*
	 * A set of ids, not a count and a `slice`.
	 *
	 * The first version of this check took the length before and sliced the list
	 * after — and reported a leak that was not there, because by then the
	 * `doomed` window's contents had been destroyed and dropped out of the list,
	 * so the slice landed on the *first* smoke window's chrome, which is
	 * legitimately still open. It named a real live `WebContents` and was
	 * completely wrong about whose. Identity answers the question that was
	 * actually being asked.
	 */
	/**
	 * **The preferences the views actually got, measured rather than read.**
	 *
	 * This check exists because a source assertion was trusted to prove a runtime
	 * property and could not. `tests/browser-host.test.ts` grepped this repository
	 * for `sandbox: true` and friends; it found them, passed, and said nothing
	 * while the object listed four of the canonical eleven fields and let
	 * `devTools` and `spellcheck` fall through to Electron's defaults — both of
	 * which default **on**. Every Steam tab in a packaged build could open
	 * DevTools, in a window signed in to the user's account.
	 *
	 * So this asks the live `WebContents` rather than the file. `openDevTools()`
	 * on a view built with `devTools: false` is inert, and that is the only
	 * evidence that settles it. Both kinds of view are checked — the tab and the
	 * toolbar — because they are built from the same object and the toolbar is
	 * the one carrying a preload.
	 */
	/*
	 * **The first `loadURL` must resolve on the page it was given.**
	 *
	 * Electron's `loadURL` resolves on the contents' next `did-finish-load` and
	 * does not care which navigation caused it. `openTab` used to fire an
	 * un-awaited `about:blank` on the same contents, so this promise resolved on
	 * that — measured at ~40ms, against a page that had not begun to arrive.
	 *
	 * `openAccountBrowser` awaits this load and then reads `currentUrl()` to
	 * decide whether Steam accepted the session. It read `about:blank`, which
	 * `looksSignedOut` correctly calls signed out, so **every** attempt to open
	 * the in-app browser was refused with "Steam did not accept the saved
	 * session" — after wiping the partition. The feature did not work at all, and
	 * no unit test could see it: the fake host resolves `loadURL` itself, so only
	 * a real Electron navigation exposes which one settled the promise.
	 */
	{
		const probe = electronBrowserHost.createWindow({
			width: 600,
			height: 400,
			title: 'first-load probe',
			partition,
			userAgent: 'SmokeTest/1'
		});
		const target = 'data:text/html,' + encodeURIComponent('<title>Landed</title>');
		await probe.loadURL(target);
		const seen = probe.currentUrl();
		check(
			'the first loadURL resolves on the page it was given',
			seen !== 'about:blank' && seen !== '',
			`currentUrl after first load = ${JSON.stringify(seen)}`
		);
		probe.close();
		await wait(400);
	}

	const beforePosture = new Set(webContents.getAllWebContents().map((c) => c.id));
	const posture = electronBrowserHost.createWindow({
		width: 800,
		height: 600,
		title: 'posture — browser',
		partition,
		userAgent: 'SmokeTest/1'
	});
	await posture.loadURL('data:text/html,' + encodeURIComponent('<title>Posture</title>'));
	await wait(400);

	const postureViews = webContents
		.getAllWebContents()
		.filter((c) => !beforePosture.has(c.id) && !c.isDestroyed());
	check('the posture window brought its views', postureViews.length >= 2, `${postureViews.length}`);

	for (const contents of postureViews) {
		contents.openDevTools({ mode: 'detach' });
	}
	await wait(700);

	const opened = postureViews.filter((c) => !c.isDestroyed() && c.isDevToolsOpened());
	check(
		'no browser view can open DevTools',
		opened.length === 0,
		`${opened.length} of ${postureViews.length} view(s) opened DevTools`
	);

	const spellSessions = postureViews.filter(
		(c) => !c.isDestroyed() && c.session.isSpellCheckerEnabled()
	);
	check(
		'no browser session runs a spellchecker',
		spellSessions.length === 0,
		`enabled on ${spellSessions.length} of ${postureViews.length} view session(s)`
	);

	posture.close();
	await wait(800);

	const before = new Set(webContents.getAllWebContents().map((contents) => contents.id));
	const leaky = electronBrowserHost.createWindow({
		width: 800,
		height: 600,
		title: 'leak — browser',
		partition,
		userAgent: 'SmokeTest/1'
	});
	await leaky.loadURL('data:text/html,' + encodeURIComponent('<title>Leak</title>'));
	await wait(400);

	// Its own views: the chrome and the one tab.
	const fresh = webContents.getAllWebContents().filter((contents) => !before.has(contents.id));
	const mine = fresh.map((contents) => contents.id);
	check('the window brought its own views', mine.length >= 2, `${mine.length} view(s)`);

	leaky.close();
	await wait(1200);

	const survivors = mine
		.map((id) => webContents.fromId(id))
		.filter((found) => found !== undefined && !found.isDestroyed());
	check(
		'closing the window destroys its tabs and its chrome',
		survivors.length === 0,
		// Named, not counted: "one left behind" does not say whether the chrome or
		// a signed-in Steam tab is the one still running.
		survivors.map((found) => found.getURL().slice(0, 60)).join(' | ')
	);
	check(
		'and leaves the process holding no more than it did before',
		webContents.getAllWebContents().filter((contents) => !before.has(contents.id)).length === 0,
		`${webContents.getAllWebContents().length} total`
	);

	/*
	 * **A page asking for a window it should not get.**
	 *
	 * `window.open` used to hand the page's own string straight to `loadURL` in
	 * the main process, where none of the renderer's navigation restrictions
	 * apply — so a trading page could ask for `file:` or `data:` and have this
	 * application open it. Those are the two schemes the address bar refuses by
	 * name, reachable by getting a page to ask instead of typing.
	 *
	 * Driven for real rather than asserted against source: whether Chromium even
	 * routes these through the handler is a fact about Electron, not about our
	 * text.
	 */
	/*
	 * Identity, not a URL match. The first smoke window already has a tab on
	 * example.com, so finding "the contents whose URL contains example.com"
	 * found *that* one — and the popups were opened in the wrong window while
	 * this counted tabs in the right one. Both checks then reported a gate that
	 * was never exercised.
	 */
	const beforeOpener = new Set(webContents.getAllWebContents().map((c) => c.id));
	const opener = electronBrowserHost.createWindow({
		width: 900,
		height: 600,
		title: 'popups — browser',
		partition,
		userAgent: 'SmokeTest/1'
	});
	/*
	 * A real origin, not a `data:` URL. Chromium refuses `window.open` from an
	 * opaque origin outright, so the first version of this check passed the
	 * scheme test for the wrong reason — nothing reached the handler at all — and
	 * would have kept passing with the gate removed.
	 */
	await opener.loadURL('https://example.com/');
	await wait(1200);

	const openerViews = () => webContents.getAllWebContents().filter((c) => !beforeOpener.has(c.id));
	const openerChrome = openerViews().find((c) => c.getURL().includes('id%3D%22tabs%22'));
	const tabCount = async () =>
		openerChrome === undefined
			? -1
			: await openerChrome.executeJavaScript('document.querySelectorAll(".tab").length', true);

	const tabsBefore = await tabCount();
	const page = openerViews().find((c) => c.getURL().includes('example.com'));
	if (page) {
		for (const url of [
			'file:///C:/Windows/win.ini',
			'data:text/html,<h1>no</h1>',
			'about:config'
		]) {
			await page.executeJavaScript(`window.open(${JSON.stringify(url)});`, true).catch(() => {});
		}
	}
	await wait(900);
	check('the opener page is reachable to drive', page !== undefined && tabsBefore === 1);
	check(
		'a page cannot open file:, data: or other schemes as tabs',
		page !== undefined && (await tabCount()) === tabsBefore,
		`${tabsBefore} tab(s) before, ${await tabCount()} after`
	);

	if (page) {
		await page
			.executeJavaScript(`window.open('https://example.com/opened-by-page');`, true)
			.catch(() => {});
	}
	await wait(900);
	check(
		'and an ordinary https popup still becomes a tab',
		(await tabCount()) === tabsBefore + 1,
		`${await tabCount()} tab(s)`
	);

	/*
	 * **A tab is a renderer process, and nothing was counting them.** A page in
	 * a loop could accumulate them until the machine gave up.
	 */
	if (page) {
		for (let i = 0; i < 40; i += 1) {
			await page
				.executeJavaScript(`window.open('https://oda-smoke.invalid/flood/${i}');`, true)
				.catch(() => {});
		}
	}
	await wait(2500);
	const flooded = await tabCount();
	check(
		'a page cannot open tabs without limit',
		flooded > 0 && flooded <= 20,
		`${flooded} tab(s) after asking for 40 more`
	);
	check(
		'and the toolbar disables its own + at the ceiling',
		openerChrome === undefined
			? false
			: (await openerChrome.executeJavaScript(
					'document.getElementById("newtab").disabled',
					true
				)) === true
	);
	opener.close();
	await wait(300);

	/*
	 * **A popup carries a request — and must carry no more than one.**
	 *
	 * Two things have gone wrong here in turn. First the conversion took only
	 * `details.url`, so a form posted to a new tab arrived as a bare `GET`. Then
	 * it carried method, body and content type by hand — and that was worse: a
	 * request rebuilt with `loadURL` has no initiator, so Chromium attached
	 * `SameSite=Strict` cookies it withholds from a real cross-site post, and
	 * sent `Origin: null`. Faithful enough to be dangerous, not faithful enough
	 * to be honest.
	 *
	 * Chromium now performs the navigation into a tab we supply, so all of this
	 * is the browser's own behaviour. These checks are the evidence for that, and
	 * the last one compares against a control: the same submission made in a tab
	 * directly, which is what a normal browser does.
	 */
	const arrived = [];

	/** The destination: sets SameSite cookies, then records what it is sent. */
	const target = createServer((request, response) => {
		let body = '';
		request.on('data', (chunk) => {
			body += chunk;
		});
		request.on('end', () => {
			arrived.push({
				method: request.method,
				body,
				url: request.url,
				// **The header, not only the bytes.** A multipart body with no
				// `Content-Type` is a pile of boundaries the server cannot parse.
				contentType: request.headers['content-type'],
				cookie: request.headers.cookie ?? '',
				origin: request.headers.origin ?? '',
				fetchSite: request.headers['sec-fetch-site'] ?? ''
			});
			response.writeHead(200, {
				'Content-Type': 'text/html',
				'Set-Cookie': [
					'strict_session=s1; SameSite=Strict; Path=/',
					'lax_session=l1; SameSite=Lax; Path=/'
				]
			});
			response.end('<title>Posted</title>ok');
		});
	});
	await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
	const targetPort = target.address().port;

	/** The opener, on a different site. `localhost` and `127.0.0.1` are not the same site. */
	const openerSite = createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'text/html' });
		response.end('<title>Opener</title><body></body>');
	});
	await new Promise((resolve) => openerSite.listen(0, '127.0.0.1', resolve));
	const openerPort = openerSite.address().port;

	const poster = electronBrowserHost.createWindow({
		width: 800,
		height: 600,
		title: 'posting — browser',
		partition,
		userAgent: 'SmokeTest/1'
	});
	await poster.loadURL(`http://localhost:${openerPort}/opener`);
	await wait(900);

	const posterPage = webContents
		.getAllWebContents()
		.filter((c) => !c.isDestroyed())
		.find((c) => c.getURL().includes(`${openerPort}/opener`));

	/** Submit a form from the opener page to the destination. */
	const submit = async (path, enctype, targetAttr) => {
		if (!posterPage) return;
		await posterPage
			.executeJavaScript(
				`(() => {
					const f = document.createElement('form');
					f.method = 'POST';
					f.action = 'http://127.0.0.1:${targetPort}${path}';
					f.enctype = ${JSON.stringify(enctype)};
					${targetAttr ? `f.target = ${JSON.stringify(targetAttr)};` : ''}
					const i = document.createElement('input');
					i.name = 'trade';
					i.value = 'accept-12345';
					f.appendChild(i);
					document.body.appendChild(f);
					f.submit();
				})()`,
				true
			)
			.catch(() => undefined);
		await wait(1800);
	};

	// A plain visit first, so the destination gets to set its cookies.
	await submit('/warm', 'application/x-www-form-urlencoded', '_blank');
	await submit('/posted', 'application/x-www-form-urlencoded', '_blank');

	const posted = arrived.find((r) => r.url === '/posted');
	check(
		'a form posted to a new tab arrives as a POST',
		posted?.method === 'POST',
		posted ? `${posted.method} ${posted.url}` : 'nothing reached the server'
	);
	check(
		'and carries the body the user submitted',
		posted?.body.includes('trade=accept-12345') === true,
		posted ? JSON.stringify(posted.body).slice(0, 60) : 'no body'
	);
	check(
		'and the content type the form meant',
		posted?.contentType?.startsWith('application/x-www-form-urlencoded') === true,
		String(posted?.contentType)
	);

	await submit('/multipart', 'multipart/form-data', '_blank');
	const multipart = arrived.find((r) => r.url === '/multipart');
	check(
		'a multipart form arrives as multipart',
		multipart?.contentType?.startsWith('multipart/form-data') === true,
		String(multipart?.contentType)
	);
	check(
		'with the boundary the body actually uses',
		(() => {
			const boundary = /boundary=(.+)$/.exec(multipart?.contentType ?? '')?.[1];
			return boundary !== undefined && multipart?.body.includes(boundary) === true;
		})(),
		multipart ? String(multipart.contentType) : 'nothing reached the server'
	);

	/*
	 * **The boundary that matters.** A cross-site POST must not carry a
	 * `SameSite=Strict` cookie. Rebuilt with `loadURL` it did — Chromium saw a
	 * fresh top-level navigation with no initiator and attached everything.
	 */
	check(
		'a cross-site popup POST withholds SameSite=Strict, as a browser would',
		posted !== undefined && !posted.cookie.includes('strict_session'),
		`cookie: ${posted?.cookie || '(none)'}`
	);
	check(
		'and reports a real cross-site origin rather than null',
		posted?.origin.includes(`localhost:${openerPort}`) === true,
		`Origin: ${posted?.origin || '(absent)'} · Sec-Fetch-Site: ${posted?.fetchSite || '(absent)'}`
	);
	check(
		'and Sec-Fetch-Site says cross-site, not none',
		posted?.fetchSite === 'cross-site',
		`Sec-Fetch-Site: ${posted?.fetchSite || '(absent)'}`
	);

	/*
	 * The control: the *same* submission in the current tab rather than a new
	 * one, which is a navigation Chromium handles start to finish. Whatever it
	 * sends is the definition of correct, and the popup path must match it.
	 */
	await submit('/control', 'application/x-www-form-urlencoded', undefined);
	const control = arrived.find((r) => r.url === '/control');
	check(
		'the popup path sends what a plain navigation sends',
		control !== undefined &&
			posted !== undefined &&
			control.cookie.includes('strict_session') === posted.cookie.includes('strict_session') &&
			control.fetchSite === posted.fetchSite,
		`control: ${control?.fetchSite} / ${control?.cookie || '(none)'} · popup: ${posted?.fetchSite} / ${posted?.cookie || '(none)'}`
	);

	poster.close();
	target.close();
	openerSite.close();
	await wait(400);

	/*
	 * **A popup that closes itself.**
	 *
	 * `window.close()` is what an authentication or payment callback does the
	 * moment it is finished, and letting Chromium perform those navigations for
	 * real is exactly what brought the behaviour within reach. The contents were
	 * destroyed and the strip entry stayed: a tab drawn over nothing, which
	 * crashed the main process on `focus()` when selected — and a page could open
	 * and close children until twenty corpses filled the ceiling and no real tab
	 * could be opened at all.
	 *
	 * Neither existing suite could see it: both close tabs through the toolbar or
	 * the window API, and neither lets a page end its own.
	 */
	const beforeGhost = new Set(webContents.getAllWebContents().map((c) => c.id));
	const selfClose = electronBrowserHost.createWindow({
		width: 800,
		height: 600,
		title: 'self-closing — browser',
		partition,
		userAgent: 'SmokeTest/1'
	});
	await selfClose.loadURL('data:text/html,' + encodeURIComponent('<title>Host</title>'));
	await wait(500);

	const ghostChrome = webContents
		.getAllWebContents()
		.filter((c) => !beforeGhost.has(c.id))
		.find((c) => c.getURL().includes('id%3D%22tabs%22'));
	const strip = async () =>
		ghostChrome === undefined
			? -1
			: await ghostChrome.executeJavaScript('document.querySelectorAll(".tab").length', true);

	// A second tab, opened the ordinary way, so there is something to fall back to.
	await run2(ghostChrome, 'document.getElementById("newtab")?.click()');
	await wait(400);
	const twoTabs = await strip();
	check('two tabs before the page closes one', twoTabs === 2, `${twoTabs} tab(s)`);

	// The active tab ends itself, exactly as a callback popup does.
	const doomedTab = webContents
		.getAllWebContents()
		.filter((c) => !beforeGhost.has(c.id) && !c.getURL().includes('id%3D%22tabs%22'))
		.at(-1);
	if (doomedTab) {
		await doomedTab.executeJavaScript('window.close()', true).catch(() => undefined);
	}
	await wait(900);

	const afterGhost = await strip();
	check(
		'a page closing itself removes its tab from the strip',
		afterGhost === twoTabs - 1,
		`${twoTabs} -> ${afterGhost}`
	);

	// Selecting whatever is left must not reach into destroyed contents.
	await run2(
		ghostChrome,
		`document.querySelectorAll('.tab')[0]?.dispatchEvent(
			new MouseEvent('mousedown', { button: 0, bubbles: true }))`
	);
	await wait(400);
	check(
		'selecting a tab after that does not crash the main process',
		problems.length === 0,
		problems.join(' | ')
	);

	// And the window still works: another tab can be opened.
	await run2(ghostChrome, 'document.getElementById("newtab")?.click()');
	await wait(400);
	const reopened = await strip();
	check(
		'the window still opens new tabs afterwards',
		reopened === afterGhost + 1,
		`${afterGhost} -> ${reopened}`
	);

	selfClose.close();
	await wait(400);

	/*
	 * **A proxy that demands a password, answered for real.**
	 *
	 * `planProxy` strips credentials out of the Chromium rule on purpose — a
	 * password in `proxyRules` turns up in `resolveProxy` output and in every
	 * message quoting it — and hands them back separately for whoever
	 * authenticates. `transport.ts` has answered its own `login` event since
	 * routing existed. This window never did, and Electron cancels an unanswered
	 * `login`, so an `http://user:pass@proxy` that this application accepts,
	 * stores, and successfully mints Steam tokens through met a 407 on every
	 * single page load in the browser and failed closed with no explanation.
	 *
	 * Proved against a real proxy rather than by counting listeners. The first
	 * version of this check asked whether the tab had a `login` listener at all;
	 * it passed with the handler deleted, because Electron attaches one of its
	 * own to every `WebContents`. A check that cannot fail is not a check.
	 */
	const seen = [];
	const proxy = createServer((request, response) => {
		const offered = request.headers['proxy-authorization'];
		seen.push(offered ?? null);
		if (offered === undefined) {
			response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="oda-smoke"' });
			response.end();
			return;
		}
		response.writeHead(200, { 'Content-Type': 'text/html' });
		response.end('<title>Through the proxy</title><h1>through</h1>');
	});
	await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
	const proxyPort = proxy.address().port;

	const routed = electronBrowserHost.sessionFromPartition('browser-proxy-smoke', { cache: false });
	routed.denyPermissions();
	await routed.setProxy({
		mode: 'fixed_servers',
		proxyRules: `http://127.0.0.1:${proxyPort}`,
		// Exactly what `openAccountBrowser` applies: nothing skips the proxy.
		proxyBypassRules: '<-loopback>'
	});

	const authed = electronBrowserHost.createWindow({
		width: 800,
		height: 600,
		title: 'proxy — browser',
		partition: 'browser-proxy-smoke',
		userAgent: 'SmokeTest/1'
	});
	authed.setProxyCredentials({ username: 'proxyuser', password: 'proxypass' });
	await authed.loadURL('http://oda-smoke.invalid/').catch(() => undefined);
	await wait(1500);

	const answered = seen.find((header) => typeof header === 'string' && header.startsWith('Basic '));
	check(
		'the proxy is challenged and then answered',
		seen.includes(null) && answered !== undefined,
		`${seen.length} request(s): ${seen.map((h) => (h === null ? '407' : 'authorized')).join(', ')}`
	);
	check(
		'with the credentials the window was given, and no others',
		answered !== undefined &&
			Buffer.from(answered.slice('Basic '.length), 'base64').toString() === 'proxyuser:proxypass',
		answered === undefined ? 'nothing was offered' : 'offered'
	);
	authed.close();
	proxy.close();

	/*
	 * **"Steam only", asked of Chromium rather than of a fake.**
	 *
	 * The unit tests assert the configuration this code hands to `setProxy`.
	 * They cannot assert what Chromium does with it, and the gap between those
	 * two is where this mode's worst bug lived: built as a PAC script, it looked
	 * correct in every test — the tests evaluated the script — while real
	 * Chromium bypassed loopback and link-local addresses *before* consulting
	 * the script at all. `<-loopback>` does not switch that off in `pac_script`
	 * mode. A window sold as routed could reach `169.254.169.254`, the cloud
	 * metadata service, off-proxy.
	 *
	 * So the whole resolution table is printed from a real session, and the
	 * addresses that were wrong are named individually.
	 *
	 * **Nothing leaves this machine.** The bypass list names a proxy on
	 * 127.0.0.1, so a request for a routed host is handed to that local server
	 * as an absolute URL and answered there — Steam is never resolved, let alone
	 * contacted. `resolveProxy` connects to nothing at all.
	 */
	const routedThrough = [];
	const pacProxy = createServer((request, response) => {
		routedThrough.push(request.url);
		response.writeHead(200, { 'Content-Type': 'text/html' });
		response.end('<title>routed</title>');
	});
	await new Promise((resolve) => pacProxy.listen(0, '127.0.0.1', resolve));
	const pacPort = pacProxy.address().port;

	const steamOnly = electronBrowserHost.sessionFromPartition('browser-pac-smoke', {
		cache: false
	});
	steamOnly.denyPermissions();
	// The application's own builders, from the account's own proxy URL. Literal
	// rules written here would test rules this app does not ship.
	const pacPlan = planProxy(`http://127.0.0.1:${pacPort}`);
	await steamOnly.setProxy({
		mode: 'fixed_servers',
		proxyRules: pacPlan.proxyRules,
		proxyBypassRules: steamOnlyBypass()
	});

	const toProxy = `PROXY 127.0.0.1:${pacPort}`;
	const listedDirect = DIRECT_CONTENT_DOMAINS[0];
	const ask = async (url) => steamOnly.resolveProxy(url);

	/*
	 * The addresses that were wrong. Each one is a request a page can make: a
	 * link, an image, an XHR — and `169.254.169.254` on a cloud host answers
	 * unauthenticated requests with credentials.
	 */
	const implicit = {
		localhost: await ask('http://localhost:7777/'),
		loopback4: await ask('http://127.0.0.1:7777/'),
		loopback6: await ask('http://[::1]:7777/'),
		linkLocal: await ask('http://169.254.169.254/latest/meta-data/')
	};
	check(
		'loopback and link-local go through the proxy, not around it',
		Object.values(implicit).every((r) => r === toProxy),
		Object.entries(implicit)
			.map(([k, v]) => `${k}=${v}`)
			.join(' ')
	);

	const asked = {
		store: await ask('https://store.steampowered.com/'),
		community: await ask('https://steamcommunity.com/my/tradeoffers/'),
		cdn: await ask('https://community.cloudflare.steamstatic.com/x.png'),
		listedApex: await ask(`https://${listedDirect}/`),
		listedSub: await ask(`https://www.${listedDirect}/x`),
		unknown: await ask('https://example.com/'),
		lookalike: await ask(`https://evil-${listedDirect}/`),
		suffixed: await ask(`https://${listedDirect}.attacker.net/`)
	};
	check(
		'Chromium routes Steam through the proxy',
		asked.store === toProxy && asked.community === toProxy && asked.cdn === toProxy,
		`store=${asked.store} community=${asked.community} cdn=${asked.cdn}`
	);
	/*
	 * Both spellings, because Chromium treats them as different rules: a bypass
	 * entry of `csfloat.com` does not cover `www.csfloat.com`, and
	 * `*.csfloat.com` does not cover the apex.
	 */
	check(
		`and lets a listed third-party site out directly, apex and subdomain (${listedDirect})`,
		asked.listedApex === 'DIRECT' && asked.listedSub === 'DIRECT',
		`apex=${asked.listedApex} www=${asked.listedSub}`
	);
	check(
		'and sends an unrecognised host through the proxy rather than around it',
		asked.unknown === toProxy,
		asked.unknown
	);
	check(
		'without letting a lookalike of a listed site inherit the direct route',
		asked.lookalike === toProxy && asked.suffixed === toProxy,
		`evil-=${asked.lookalike} .attacker.net=${asked.suffixed}`
	);

	/*
	 * And the fully routed window, whose `<-loopback>` had never been proved
	 * either — it was set from the day routing existed and asserted nowhere.
	 */
	const fully = electronBrowserHost.sessionFromPartition('browser-full-smoke', { cache: false });
	await fully.setProxy({
		mode: 'fixed_servers',
		proxyRules: pacPlan.proxyRules,
		proxyBypassRules: '<-loopback>'
	});
	const fullyAsked = [
		await fully.resolveProxy('https://steamcommunity.com/'),
		await fully.resolveProxy(`https://${listedDirect}/`),
		await fully.resolveProxy('http://127.0.0.1:7777/'),
		await fully.resolveProxy('http://169.254.169.254/')
	];
	check(
		'the fully routed window sends everything through the proxy, loopback included',
		fullyAsked.every((r) => r === toProxy),
		fullyAsked.join(' ')
	);

	/*
	 * And the same again as traffic rather than as an answer, because a proxy
	 * Chromium names and then does not use is the failure `assertRouted` exists
	 * for one layer up.
	 */
	const pacWindow = electronBrowserHost.createWindow({
		width: 800,
		height: 600,
		title: 'steam-only — browser',
		partition: 'browser-pac-smoke',
		userAgent: 'SmokeTest/1'
	});
	await pacWindow.loadURL('http://store.steampowered.com/oda-smoke').catch(() => undefined);
	await wait(800);
	await pacWindow.loadURL('http://oda-smoke.invalid/not-steam').catch(() => undefined);
	await wait(800);
	// The address that used to slip past. It is answered by the local proxy
	// here, so nothing reaches a real metadata service — the point is that the
	// request was handed to the proxy at all.
	await pacWindow.loadURL('http://169.254.169.254/latest/meta-data/').catch(() => undefined);
	await wait(800);

	check(
		'a Steam page really is fetched through the proxy',
		routedThrough.some((url) => String(url).includes('store.steampowered.com')),
		routedThrough.join(', ') || 'the proxy saw nothing at all'
	);
	check(
		'and an unrecognised host is handed to the proxy too, not resolved here',
		routedThrough.some((url) => String(url).includes('oda-smoke.invalid')),
		routedThrough.join(', ')
	);
	check(
		'and the cloud-metadata address is handed to the proxy, not fetched locally',
		routedThrough.some((url) => String(url).includes('169.254.169.254')),
		routedThrough.join(', ')
	);
	pacWindow.close();
	pacProxy.close();

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
