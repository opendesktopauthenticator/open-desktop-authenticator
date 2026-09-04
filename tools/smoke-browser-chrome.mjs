/**
 * Load the in-app browser's chrome for real, in Electron, and press its buttons.
 *
 *     npx electron tools/smoke-browser-chrome.mjs
 *
 * **Written because a whole toolbar shipped inert.** The preload exposed its
 * bridge as `window.chrome`, which Chromium already defines, so
 * `exposeInMainWorld` threw and every control silently did nothing. Nothing in
 * the unit suite could see it: those tests read source text and inject fakes,
 * and the failure only exists inside a real renderer.
 *
 * This needs no vault, no passphrase and no Steam account. It is the part of
 * the browser that can be tested without any of them, which is most of it.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CHROME_HTML } from '../src/main/browser/chrome-html.ts';

const here = dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, pass, detail = '') => {
	results.push({ name, pass, detail });
	process.stdout.write(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

/** What the chrome sent us, so the assertions can look at real messages. */
const heard = [];
for (const verb of ['back', 'forward', 'reload', 'go', 'new-tab', 'select-tab', 'close-tab']) {
	ipcMain.on(`browser-chrome:${verb}`, (_event, payload) => heard.push([verb, payload]));
}

/*
 * A hung smoke test is a failed smoke test that nobody sees.
 *
 * The first run against a broken bridge did not fail — it stopped, because
 * `executeJavaScript` on a missing object never settles. A check that can hang
 * is a check you learn to skip.
 */
const deadline = setTimeout(() => {
	process.stdout.write('FAIL  the smoke test did not finish within 60s' + String.fromCharCode(10));
	app.exit(1);
}, 60_000);

app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		webPreferences: {
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			preload: join(here, '..', 'out', 'preload', 'browser-chrome.js')
		}
	});

	const errors = [];
	window.webContents.on('console-message', (_e, level, message) => {
		if (level >= 2) errors.push(message);
	});
	window.webContents.on('preload-error', (_e, path, error) => {
		errors.push(`preload ${path}: ${error.message}`);
	});

	await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CHROME_HTML)}`);

	const run = async (js) => {
		// Guarded: with the bridge missing, an unguarded call rejects or never
		// settles, and either way the run stops instead of reporting.
		try {
			return await Promise.race([
				window.webContents.executeJavaScript(js, true),
				new Promise((resolve) => setTimeout(() => resolve('<timed out>'), 4000))
			]);
		} catch (err) {
			return `<threw: ${err instanceof Error ? err.message : String(err)}>`;
		}
	};

	// 1. The bridge exists at all. This is the one that was false.
	const bridge = await run('typeof window.odaBrowser');
	check('the bridge is exposed', bridge === 'object', `typeof window.odaBrowser = ${bridge}`);

	const verbs = await run('JSON.stringify(Object.keys(window.odaBrowser || {}).sort())');
	check(
		'it carries every verb the chrome calls',
		['back', 'closeTab', 'forward', 'go', 'newTab', 'onState', 'reload', 'selectTab'].every((v) =>
			verbs.includes(`"${v}"`)
		),
		verbs
	);

	// 2. The controls are wired to it.
	await run('document.getElementById("back").click()');
	await run('document.getElementById("reload").click()');
	check(
		'the navigation buttons reach the main process',
		heard.some(([v]) => v === 'back') && heard.some(([v]) => v === 'reload'),
		heard.map(([v]) => v).join(', ')
	);

	// 3. The address bar sends what was typed.
	await run(`(() => {
		const address = document.getElementById('address');
		address.value = 'csgoempire.com';
		address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
	})()`);
	const typed = heard.find(([v]) => v === 'go');
	check(
		'the address bar sends the typed address',
		typed?.[1] === 'csgoempire.com',
		String(typed?.[1])
	);

	// 4. The tab strip draws from pushed state, and the + button appears with it.
	window.webContents.send('browser-chrome:state', {
		url: 'https://steamcommunity.com/my/tradeoffers/',
		canGoBack: true,
		canGoForward: false,
		loading: false,
		offSteam: false,
		tabs: [
			{
				id: 1,
				title: 'Trade Offers',
				url: 'https://steamcommunity.com/x',
				active: true,
				offSteam: false
			},
			{ id: 2, title: 'Somewhere else', url: 'https://example.org/', active: false, offSteam: true }
		]
	});
	await new Promise((resolve) => setTimeout(resolve, 150));

	check(
		'the strip draws one element per tab',
		(await run('document.querySelectorAll(".tab").length')) === 2
	);
	check(
		'the new-tab button is present',
		(await run('!!document.getElementById("newtab")')) === true
	);
	check(
		'an off-Steam tab is marked in the strip',
		(await run('document.querySelectorAll(".tab .off").length')) === 1
	);
	check(
		'the address field shows the active tab',
		(await run('document.getElementById("address").value')) ===
			'https://steamcommunity.com/my/tradeoffers/'
	);
	check(
		'back is enabled when history allows it',
		(await run('!document.getElementById("back").disabled')) === true
	);
	check(
		'the strip exposes a tablist with one selected semantic tab',
		(await run(`JSON.stringify({
			list: document.getElementById('tabs').getAttribute('role'),
			tabs: document.querySelectorAll('[role="tab"]').length,
			selected: document.querySelectorAll('[role="tab"][aria-selected="true"]').length,
			activeTabStop: document.querySelector('[role="tab"][aria-selected="true"]').tabIndex
		})`)) === JSON.stringify({ list: 'tablist', tabs: 2, selected: 1, activeTabStop: 0 })
	);
	check(
		'every tab and close control has an accessible name',
		(await run(`[...document.querySelectorAll('[role="tab"], .tab .x')]
			.every((control) => control.tagName === 'BUTTON' && !!control.getAttribute('aria-label'))`)) ===
			true
	);

	const keyboardResult = await run(`(() => {
		const key = (target, value) => target.dispatchEvent(
			new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
		);
		const tabs = [...document.querySelectorAll('[role="tab"]')];
		tabs[0].focus();
		key(tabs[0], 'ArrowRight');
		const right = document.activeElement.getAttribute('data-tab-id');
		key(document.activeElement, 'Home');
		const home = document.activeElement.getAttribute('data-tab-id');
		key(document.activeElement, 'End');
		const end = document.activeElement.getAttribute('data-tab-id');
		key(document.activeElement, 'Enter');
		key(document.activeElement, 'ArrowLeft');
		const left = document.activeElement.getAttribute('data-tab-id');
		key(document.activeElement, ' ');
		return JSON.stringify({ right, home, end, left });
	})()`);
	check(
		'arrow, Home and End move focus among tabs',
		keyboardResult === JSON.stringify({ right: '2', home: '1', end: '2', left: '1' }),
		keyboardResult
	);
	check(
		'Enter and Space select the focused tab',
		heard.some(([verb, id]) => verb === 'select-tab' && id === 2) &&
			heard.some(([verb, id]) => verb === 'select-tab' && id === 1),
		heard.map(([verb, id]) => `${verb}:${String(id)}`).join(', ')
	);

	// 5. Clicking a tab and its close control reaches the main process.
	await run(
		'document.querySelectorAll(".tab")[1].dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }))'
	);
	await run(
		'document.querySelectorAll(".tab .x")[0].dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }))'
	);
	await run('document.getElementById("newtab").click()');
	check(
		'selecting, closing and adding tabs all reach the main process',
		heard.some(([v, id]) => v === 'select-tab' && id === 2) &&
			heard.some(([v, id]) => v === 'close-tab' && id === 1) &&
			heard.some(([v]) => v === 'new-tab'),
		heard.map(([v, p]) => `${v}${p === undefined ? '' : `(${p})`}`).join(', ')
	);

	await run(`(() => {
		const second = document.querySelectorAll('[role="tab"]')[1];
		second.focus();
		second.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Delete', bubbles: true, cancelable: true
		}));
	})()`);
	check(
		'Delete closes the focused tab',
		heard.some(([verb, id]) => verb === 'close-tab' && id === 2),
		heard.map(([verb, id]) => `${verb}:${String(id)}`).join(', ')
	);
	window.webContents.send('browser-chrome:state', {
		url: 'https://steamcommunity.com/my/tradeoffers/',
		canGoBack: true,
		canGoForward: false,
		loading: false,
		offSteam: false,
		tabs: [
			{
				id: 1,
				title: 'Trade Offers',
				url: 'https://steamcommunity.com/x',
				active: true,
				offSteam: false
			}
		]
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	check(
		'closing a focused tab moves focus to its neighbour',
		(await run(`document.activeElement?.getAttribute('data-tab-id')`)) === '1'
	);

	// 6. A page title is text, never markup.
	window.webContents.send('browser-chrome:state', {
		url: 'https://example.org/',
		canGoBack: false,
		canGoForward: false,
		loading: false,
		offSteam: true,
		tabs: [
			{
				id: 9,
				title: '<img src=x onerror=alert(1)>',
				url: 'https://example.org/',
				active: true,
				offSteam: true
			}
		]
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	check(
		'a page title is rendered as text, not markup',
		(await run('document.querySelectorAll(".tab img").length')) === 0 &&
			(await run('document.querySelector(".tab .label").textContent')).includes('<img')
	);
	check(
		'the off-Steam warning shows in the bar',
		(await run('document.getElementById("warn").className')) === 'on'
	);

	// 7. A blank tab reads as blank: empty field, "New tab" label, no warning.
	window.webContents.send('browser-chrome:state', {
		url: '',
		canGoBack: false,
		canGoForward: false,
		loading: false,
		offSteam: false,
		tabs: [{ id: 3, title: '', url: '', active: true, offSteam: false }]
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	check(
		'a blank tab shows an empty address field',
		(await run('document.getElementById("address").value')) === ''
	);
	check(
		'a blank tab is labelled rather than left nameless',
		(await run('document.querySelector(".tab .label").textContent')) === 'New tab'
	);
	check(
		'a blank tab raises no off-Steam warning',
		(await run('document.getElementById("warn").className')) !== 'on'
	);

	// 8. Opening one puts the cursor where the user is about to type.
	window.webContents.send('browser-chrome:focus-address');
	await new Promise((resolve) => setTimeout(resolve, 150));
	check(
		'a new tab puts the cursor in the address field',
		(await run('document.activeElement === document.getElementById("address")')) === true
	);

	check('nothing errored in the renderer', errors.length === 0, errors.join(' | '));

	clearTimeout(deadline);
	const failed = results.filter((r) => !r.pass).length;
	process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
	app.exit(failed === 0 ? 0 : 1);
});
