/**
 * Hammer the in-app browser until something gives.
 *
 *     npm run stress:browser
 *
 * `smoke-browser-window.mjs` proves each behaviour once. This does each of them
 * many times, in the orders a person actually produces — open, close, reopen,
 * flood with tabs, close mid-load, type nonsense into the address bar — and
 * watches what the process is holding afterwards.
 *
 * **The thing being measured is what does not go back down.** A leak, a handle,
 * a renderer that outlives its window: none of those fail a single-pass check,
 * because one of anything looks like nothing. They show up as a number that
 * climbs across cycles and never returns.
 *
 * ## What this cannot reach
 *
 * Everything from unlocking the vault through minting a Steam token, and so any
 * window signed in to a real account. That path needs a passphrase typed into a
 * field, which this process does not do. Every window here is anonymous: real
 * Electron, real sessions, real navigation, no account.
 */
import { app, webContents } from 'electron';
import { createServer } from 'node:http';

import { electronBrowserHost } from '../src/main/browser/electron-host.ts';

/* --------------------------------------------------------------- report -- */

const results = [];
const problems = [];

const check = (name, pass, detail = '') => {
	results.push(pass);
	process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};
const note = (text) => process.stdout.write(`      ${text}\n`);
const phase = (text) => process.stdout.write(`\n== ${text}\n`);

/**
 * Every renderer that goes away, by reason.
 *
 * A renderer that dies is a fact worth having by name. Without it, the only
 * evidence was a toolbar that stopped answering — which is also what a wait
 * that was too short looks like.
 */
const rendererExits = [];

app.on('render-process-gone', (_event, contents, details) => {
	rendererExits.push(details.reason);
	/*
	 * **Only a real failure fails the run.**
	 *
	 * This run closes about sixty windows on purpose, and tearing a renderer
	 * down is what `clean-exit` and `killed` mean. Counting those as problems
	 * would make five `problems.length === 0` checks report a crash for the
	 * harness doing exactly what it was written to do — a new flake in the gate
	 * that was hardened to remove one. The reasons left are the ones that mean
	 * something broke.
	 */
	if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
		problems.push(`render-process-gone: ${details.reason} (${contents.id})`);
	}
});

process.on('uncaughtException', (err) => problems.push(`uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => problems.push(`unhandled rejection: ${String(err)}`));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Live renderer processes this host is responsible for. */
const liveContents = () => webContents.getAllWebContents().filter((c) => !c.isDestroyed()).length;

/** Resident memory in MB, after giving the collector a chance. */
const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

const deadline = setTimeout(() => {
	process.stdout.write('FAIL  the stress run did not finish within 8 minutes\n');
	for (const problem of problems) note(problem);
	app.exit(1);
}, 8 * 60_000);

/* ---------------------------------------------------------------- harness -- */

const PARTITION = 'browser-stress';
const BLANK = 'data:text/html,' + encodeURIComponent('<title>Stress</title><h1>stress</h1>');

function makeWindow(title) {
	return electronBrowserHost.createWindow({
		width: 900,
		height: 620,
		title,
		partition: PARTITION,
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StressTest/1'
	});
}

/** The chrome view belonging to the newest window, by identity. */
function chromeAmong(before) {
	return webContents
		.getAllWebContents()
		.filter((c) => !before.has(c.id))
		.find((c) => c.getURL().includes('id%3D%22tabs%22'));
}

/**
 * Wait for the newest window's toolbar to exist, rather than assuming it does.
 *
 * **A fixed 220 ms was the gate's last coin toss.** The toolbar is a
 * `WebContentsView` loading a data: URL, and on a loaded machine it is
 * occasionally not there yet — so `chromeAmong` returned nothing, every
 * `run()` against it answered `<gone>`, and the round scored zero tabs. One
 * run reported 18/19 and the next 19/19 with nothing changed.
 *
 * Polling to a deadline keeps the assertion honest: a toolbar that genuinely
 * never appears still fails, and one that needed another 100 ms no longer
 * reports a defect that is not there.
 */
async function toolbarAmong(before, deadlineMs = 8000) {
	const until = Date.now() + deadlineMs;
	while (Date.now() < until) {
		const chrome = chromeAmong(before);
		if (chrome && !chrome.isDestroyed()) {
			return chrome;
		}
		await wait(50);
	}
	return undefined;
}

const run = async (contents, js) => {
	// Distinguished, because they mean different things: one is a harness that
	// sampled too early, the other is a renderer that died. Reported as one
	// string, a flaky wait looked exactly like a crash.
	if (!contents) return '<no toolbar>';
	if (contents.isDestroyed()) return '<destroyed>';
	try {
		return await Promise.race([
			contents.executeJavaScript(js, true),
			wait(4000).then(() => '<timed out>')
		]);
	} catch (err) {
		return `<threw: ${err instanceof Error ? err.message : String(err)}>`;
	}
};

/* ------------------------------------------------------------------ main -- */

const main = async () => {
	const session = electronBrowserHost.sessionFromPartition(PARTITION, { cache: false });
	session.denyPermissions();
	await session.setProxy({ mode: 'direct' });

	const baseContents = liveContents();
	const baseRss = rssMb();
	note(`baseline: ${baseContents} live WebContents, ${baseRss} MB RSS`);

	/* ---- 1. open and close, over and over ---------------------------------- */

	phase('1. Thirty open/close cycles');
	const CYCLES = 30;
	const perCycle = [];
	for (let i = 0; i < CYCLES; i += 1) {
		const window = makeWindow(`stress ${i}`);
		await window.loadURL(BLANK);
		await wait(60);
		window.close();
		await wait(90);
		perCycle.push(liveContents());
	}
	await wait(1200);

	const afterCycles = liveContents();
	check(
		'thirty windows leave nothing behind',
		afterCycles <= baseContents,
		`${baseContents} before, ${afterCycles} after, peak ${Math.max(...perCycle)}`
	);
	check('no errors across thirty cycles', problems.length === 0, problems.join(' | '));
	// Measured here so the plateau below compares two readings from this run,
	// rather than one reading against a number written down when it was first
	// written. See 6c.
	const afterFirstCycles = rssMb();
	note(`RSS ${baseRss} MB -> ${afterFirstCycles} MB`);

	/* ---- 2. tabs to the ceiling, repeatedly -------------------------------- */

	phase('2. Ten rounds of flooding tabs to the ceiling');
	let stripCounts = [];
	for (let round = 0; round < 10; round += 1) {
		const before = new Set(webContents.getAllWebContents().map((c) => c.id));
		const window = makeWindow(`flood ${round}`);
		await window.loadURL(BLANK);
		await wait(220);
		const chrome = await toolbarAmong(before);
		check(`round ${round}: the toolbar is there to press`, chrome !== undefined);

		// Press + far past the ceiling.
		for (let i = 0; i < 30; i += 1) {
			await run(chrome, 'document.getElementById("newtab")?.click()');
		}
		await wait(320);
		stripCounts.push(await run(chrome, 'document.querySelectorAll(".tab").length'));

		window.close();
		await wait(140);
	}
	await wait(1200);

	check(
		'the ceiling holds on every round',
		stripCounts.every((n) => typeof n === 'number' && n > 0 && n <= 20),
		`tabs per round: ${stripCounts.join(', ')}`
	);
	check(
		'ten flooded windows leave nothing behind',
		liveContents() <= baseContents,
		`${liveContents()} live, baseline ${baseContents}`
	);
	check('no errors across the floods', problems.length === 0, problems.join(' | '));
	note(`RSS ${rssMb()} MB`);

	/* ---- 3. real pages, including Steam's public market -------------------- */

	phase('3. Real navigation, anonymous — no account, no cookie');
	const before3 = new Set(webContents.getAllWebContents().map((c) => c.id));
	const browsing = makeWindow('browsing');
	await browsing.loadURL(BLANK);
	await wait(220);
	const chrome3 = await toolbarAmong(before3);

	const visited = [];
	/**
	 * Wait until the window is somewhere new, or give up.
	 *
	 * **Fixed sleeps made this gate a coin toss.** Navigating to public sites and
	 * then sampling the URL after a flat 2600 ms meant a slow response scored as
	 * a failure to navigate: one run reported 17/19 because `example.com` had not
	 * finished, and the next reported 19/19 with nothing changed. A gate that
	 * reports differently on identical input is not measuring the software.
	 *
	 * Polling with a deadline keeps the assertion — it still fails when the page
	 * genuinely never arrives — while removing the part that depended on how the
	 * network felt that second.
	 */
	const settleAt = async (window, from, deadlineMs = 12_000) => {
		const until = Date.now() + deadlineMs;
		while (Date.now() < until) {
			const now = window.currentUrl();
			if (now !== from) {
				// One more beat so a redirect lands before the URL is read.
				await wait(250);
				return window.currentUrl();
			}
			await wait(100);
		}
		return window.currentUrl();
	};

	/*
	 * The last leg is served from this machine, so one assertion in this section
	 * does not depend on a third party being reachable. The Steam legs stay real
	 * — reaching Steam is the thing worth knowing — but they are checked as "at
	 * least two of these arrived" rather than each individually.
	 */
	const fixture = createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'text/html' });
		response.end('<title>Stress fixture</title><h1>fixture</h1>');
	});
	await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
	const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

	for (const typed of [
		'steamcommunity.com/market/',
		'store.steampowered.com/app/730/',
		'steamcommunity.com/market/search?appid=730',
		fixtureUrl
	]) {
		const before = browsing.currentUrl();
		await run(
			chrome3,
			`(() => { const a = document.getElementById('address'); a.value = ${JSON.stringify(typed)};
			  a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`
		);
		visited.push(await settleAt(browsing, before));
	}

	check(
		'the address bar reaches Steam’s public pages',
		visited.filter((u) => u.includes('steamcommunity.com') || u.includes('steampowered.com'))
			.length >= 2,
		visited.map((u) => u.slice(0, 46)).join(' | ')
	);
	/*
	 * **Renamed, because it never read a title.**
	 *
	 * It was called "the window title tracks where it actually is" and asserted
	 * on `visited.at(-1)` — a URL. Nothing in it could fail for the reason its
	 * name gave, which is the shape of check this suite exists to avoid.
	 *
	 * The window's real title is not readable from here: `BrowserWindowHandle`
	 * offers `setTitle` and no getter, and adding one to a production port to
	 * satisfy a stress harness is the wrong trade. So the check now says what it
	 * does — the bar ends up where it was last sent — against a local fixture
	 * that is always reachable.
	 */
	check(
		'the address bar ends where it was last sent',
		visited.at(-1)?.startsWith(fixtureUrl),
		String(visited.at(-1))
	);
	fixture.close();

	/* ---- 4. addresses that must be refused --------------------------------- */

	phase('4. Addresses the bar must refuse');
	const parked = browsing.currentUrl();
	for (const hostile of [
		'javascript:alert(1)',
		'file:///C:/Windows/win.ini',
		'data:text/html,<h1>no</h1>',
		'about:config',
		'notaurl',
		''
	]) {
		await run(
			chrome3,
			`(() => { const a = document.getElementById('address'); a.value = ${JSON.stringify(hostile)};
			  a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`
		);
		await wait(220);
	}
	check(
		'six hostile addresses move the tab nowhere',
		browsing.currentUrl() === parked,
		`still at ${browsing.currentUrl().slice(0, 46)}`
	);

	/* ---- 5. tab switching under load --------------------------------------- */

	phase('5. Rapid tab switching');
	for (let i = 0; i < 6; i += 1) {
		await run(chrome3, 'document.getElementById("newtab")?.click()');
	}
	await wait(400);
	for (let sweep = 0; sweep < 40; sweep += 1) {
		await run(
			chrome3,
			`document.querySelectorAll('.tab')[${sweep % 6}]?.dispatchEvent(
				new MouseEvent('mousedown', { button: 0, bubbles: true }))`
		);
	}
	await wait(500);
	check(
		'forty switches leave the strip intact',
		(await run(chrome3, 'document.querySelectorAll(".tab").length')) === 7,
		String(await run(chrome3, 'document.querySelectorAll(".tab").length'))
	);
	check('no errors from switching', problems.length === 0, problems.join(' | '));

	browsing.close();
	await wait(600);

	/* ---- 6. closed mid-load, many times ------------------------------------ */

	phase('6. Twenty windows closed while still loading');
	for (let i = 0; i < 20; i += 1) {
		const doomed = makeWindow(`doomed ${i}`);
		doomed.on('navigated', () => doomed.setTitle('still here'));
		void doomed.loadURL('https://steamcommunity.com/market/').catch(() => undefined);
		// Closed at a different point in the load each time.
		await wait(i * 12);
		doomed.close();
		doomed.setTitle('after close');
		doomed.focus();
		doomed.close();
	}
	await wait(2500);
	check(
		'closing mid-load never reaches a destroyed window',
		problems.length === 0,
		problems.join(' | ')
	);

	/* ---- 6b. back and forward, and middle-click ---------------------------- */

	phase('6b. History and middle-click');
	const before6 = new Set(webContents.getAllWebContents().map((c) => c.id));
	const history = makeWindow('history');
	await history.loadURL('https://steamcommunity.com/market/');
	await wait(2200);
	const chrome6 = await toolbarAmong(before6);

	await run(
		chrome6,
		`(() => { const a = document.getElementById('address'); a.value = 'example.com';
		  a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`
	);
	await wait(2000);
	const atExample = history.currentUrl();

	await run(chrome6, 'document.getElementById("back").click()');
	await wait(1800);
	const wentBack = history.currentUrl();

	await run(chrome6, 'document.getElementById("forward").click()');
	await wait(1800);
	const wentForward = history.currentUrl();

	check(
		'back returns to the previous page',
		atExample.includes('example.com') && wentBack.includes('steamcommunity.com'),
		`${atExample.slice(0, 34)} -> back -> ${wentBack.slice(0, 34)}`
	);
	check('forward returns again', wentForward.includes('example.com'), wentForward.slice(0, 40));

	// Middle-click closes a tab, as it does everywhere else.
	await run(chrome6, 'document.getElementById("newtab")?.click()');
	await wait(300);
	const beforeMiddle = await run(chrome6, 'document.querySelectorAll(".tab").length');
	await run(
		chrome6,
		`document.querySelectorAll('.tab')[1]?.dispatchEvent(
			new MouseEvent('mousedown', { button: 1, bubbles: true }))`
	);
	await wait(400);
	check(
		'middle-click closes a tab',
		(await run(chrome6, 'document.querySelectorAll(".tab").length')) === beforeMiddle - 1,
		`${beforeMiddle} -> ${await run(chrome6, 'document.querySelectorAll(".tab").length')}`
	);
	history.close();
	await wait(600);

	/* ---- 6c. does memory plateau, or climb? -------------------------------- */

	/*
	 * **One pass cannot tell warm-up from a leak.** The first thirty cycles grew
	 * RSS by tens of megabytes, which is exactly what a fresh Chromium does and
	 * exactly what a leak does. The difference is the *second* thirty: warm-up
	 * costs almost nothing the second time, a leak costs the same again.
	 */
	phase('6c. A second thirty cycles, to tell warm-up from a leak');
	const beforeSecond = rssMb();
	for (let i = 0; i < CYCLES; i += 1) {
		const window = makeWindow(`again ${i}`);
		await window.loadURL(BLANK);
		await wait(60);
		window.close();
		await wait(90);
	}
	await wait(1500);
	const afterSecond = rssMb();

	/*
	 * **Both passes measured, which this used not to do.**
	 *
	 * `firstPass` was `154 - baseRss` — a constant recorded on some earlier run
	 * on some earlier machine — and the assertion was `secondPass < 30`, an
	 * absolute bound that never looked at the first pass at all. So the check
	 * named a comparison it did not make, and its number described a machine
	 * that may not be this one.
	 */
	const firstPass = afterFirstCycles - baseRss;
	const secondPass = afterSecond - beforeSecond;
	/** `+3` / `-1`, so a fall does not print as `+-1`. */
	const signed = (mb) => `${mb < 0 ? '' : '+'}${mb}`;
	note(`first thirty: ${signed(firstPass)} MB · second thirty: ${signed(secondPass)} MB`);
	check(
		'a second thirty cycles costs far less than the first',
		/*
		 * A leak repeats the first pass, so the second landing near it is the
		 * failure; warm-up lands far below.
		 *
		 * **Two thirds, not a half.** A half looked like the obvious line and is
		 * too close to the noise: a clean run measured +38 then +18, which passed
		 * by one megabyte. A gate that a legitimate run clears by one megabyte
		 * fails a legitimate run eventually, which is the reliability problem
		 * this section was rewritten to remove rather than to relocate. Two
		 * thirds still fails a leak by a wide margin, because a leak is ~100%.
		 *
		 * When the first pass grew too little to compare against — a warm
		 * machine, a small heap — there is no plateau to demonstrate, so bound
		 * the second directly rather than pass on a ratio computed from noise.
		 */
		firstPass >= 20 ? secondPass < (firstPass * 2) / 3 : secondPass < 20,
		`first ${signed(firstPass)} MB, second ${signed(secondPass)} MB` +
			` (${firstPass > 0 ? Math.round((secondPass / firstPass) * 100) : 0}% of the first;` +
			' a leak would be near 100%)'
	);
	check(
		'and leaves no renderers behind either',
		liveContents() <= baseContents,
		`${liveContents()} live`
	);

	/* ---- 7. what is left --------------------------------------------------- */

	phase('7. What the process is still holding');
	await wait(1500);
	const finalContents = liveContents();
	const finalRss = rssMb();

	check(
		'every renderer this run created is gone',
		finalContents <= baseContents,
		`${baseContents} at baseline, ${finalContents} now`
	);
	check(
		'memory did not run away',
		finalRss < baseRss + 250,
		`${baseRss} MB -> ${finalRss} MB across ~60 windows`
	);
	note(
		rendererExits.length === 0
			? 'no renderer went away unexpectedly'
			: `renderer exits: ${rendererExits.join(', ')}`
	);
	check('nothing was thrown anywhere in the run', problems.length === 0, problems.join(' | '));

	clearTimeout(deadline);
	const failed = results.filter((pass) => !pass).length;
	process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
	app.exit(failed === 0 ? 0 : 1);
};

/*
 * **Electron quits when the last window closes**, and this run deliberately
 * spends most of its time with none open. Without this the process exited
 * cleanly during the first close cycle, printed nothing further, and reported
 * success — a stress test that stopped at cycle one and said it passed.
 *
 * The application itself never meets this: it keeps a main window, and its own
 * handler decides what a closed window means. Here there is nothing but the
 * browsers being tested.
 */
app.on('window-all-closed', () => undefined);

app.whenReady().then(() =>
	main().catch((err) => {
		process.stdout.write(`FAIL  threw: ${err && err.stack ? err.stack : String(err)}\n`);
		clearTimeout(deadline);
		app.exit(1);
	})
);
