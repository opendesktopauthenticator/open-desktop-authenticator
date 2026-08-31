import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The window this application opens onto the open web, and how it is locked down.
 *
 * `browser-window.test.ts` covers the decisions; this covers the translation to
 * Electron, which is where the decisions can be quietly undone. It reads the
 * adapter as text rather than importing it, because importing pulls in
 * `electron` and there is no app running — the same reason the rest of the
 * main process is tested through injected ports.
 *
 * The properties asserted here are the ones with no visible symptom when wrong.
 * A window with `nodeIntegration` on browses Steam exactly as well as one
 * without, right up until a page it loaded is not Steam.
 */

const SOURCE = readFileSync(
	join(__dirname, '..', 'src', 'main', 'browser', 'electron-host.ts'),
	'utf8'
);

/**
 * The file with its comments removed.
 *
 * Written after two of these assertions failed against correct code: the
 * adapter explains *why* it has no preload and *why* it casts nothing, so a
 * plain text search for "preload" or "as unknown as" matched the reasoning and
 * called it a violation. A check that punishes a file for documenting itself
 * teaches people to stop documenting.
 */
const ADAPTER = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

describe('the Electron adapter for the in-app browser', () => {
	/**
	 * **This used to check the wrong thing, and passed while the posture was
	 * weaker than the main window's.**
	 *
	 * It asserted four literal fields — `sandbox`, `contextIsolation`,
	 * `nodeIntegration`, `webviewTag` — were written out in this file. They were,
	 * with the right values, under a comment claiming the object was "identical
	 * to the main window's posture". It was not: the canonical constant has
	 * eleven fields, and the seven this file did not name fell through to
	 * Electron's defaults. Two of those are wrong, `devTools` and `spellcheck`,
	 * so every Steam tab in a packaged build had DevTools available.
	 *
	 * A test that enumerates fields can only ever catch the fields somebody
	 * thought to enumerate. Asserting the **composition** catches the next one
	 * too, which is the whole point: the failure was an omission, not a
	 * disagreement.
	 */
	it('composes its preferences from the canonical posture rather than restating them', () => {
		expect(ADAPTER, 'the browser declares its own posture instead of inheriting one').toMatch(
			/const HARDENED = \{\s*\.\.\.SECURE_WEB_PREFERENCES/
		);
		expect(ADAPTER).toMatch(/import \{[^}]*SECURE_WEB_PREFERENCES[^}]*\} from '\.\.\/security'/);
	});

	/*
	 * The one field restated on purpose, because it is this window's reason for
	 * existing separately from the main one.
	 */
	it('still fixes webviewTag off itself', () => {
		expect(ADAPTER).toMatch(/webviewTag:\s*false/);
	});

	/**
	 * **Nothing may quietly relax a canonical field back.**
	 *
	 * Composing is only worth having if a later `devTools: true` after the spread
	 * is caught. The main window relaxes exactly one field, deliberately and only
	 * when unpackaged; this window relaxes none.
	 */
	it.each([
		['devTools', /devTools:/],
		['spellcheck', /spellcheck:/],
		['sandbox', /sandbox:/],
		['contextIsolation', /contextIsolation:/],
		['nodeIntegration', /nodeIntegration:\s*true/],
		['webSecurity', /webSecurity:/]
	])('does not override %s after the spread', (_name, pattern) => {
		const hardened = ADAPTER.slice(
			ADAPTER.indexOf('const HARDENED ='),
			ADAPTER.indexOf('} as const;', ADAPTER.indexOf('const HARDENED ='))
		);
		expect(hardened, 'a canonical field was relaxed in the browser').not.toMatch(pattern);
	});

	/*
	 * A preload is the difference between a browser and a browser holding a
	 * pointer at the vault. There is no legitimate reason for this window to have
	 * one, and adding it would be a one-line change nothing else would notice.
	 */
	/*
	 * **The page has no preload. The toolbar does, and that is the point.**
	 *
	 * This used to assert the word "preload" appeared nowhere in the file, which
	 * was true while the window was a single `BrowserWindow`. The address bar
	 * made it two views: a toolbar that needs a bridge to drive navigation, and
	 * a page that must never have one.
	 *
	 * Drawing the toolbar inside the page instead would have kept the old
	 * assertion passing and been far worse — a bar the page could read, restyle
	 * and forge, drawn by the application that exists to warn people about
	 * exactly that.
	 */
	it('gives the page no preload, and the toolbar only its own', () => {
		const pageView = ADAPTER.slice(ADAPTER.indexOf('const page = new WebContentsView'));
		const pageOptions = pageView.slice(0, pageView.indexOf('});'));
		expect(pageOptions, 'the page view was given a bridge').not.toMatch(/preload/i);

		const chromeView = ADAPTER.slice(ADAPTER.indexOf('const chrome = new WebContentsView'));
		expect(chromeView.slice(0, chromeView.indexOf('});'))).toMatch(/preload:.*browser-chrome\.js/);
	});

	it('keeps the toolbar out of the account’s session', () => {
		// The toolbar shares no cookies with Steam, and because its partition is
		// not one the browser registers, it keeps the application-wide navigation
		// lock the page view is exempt from.
		const chromeView = ADAPTER.slice(ADAPTER.indexOf('const chrome = new WebContentsView'));
		expect(chromeView.slice(0, chromeView.indexOf('});'))).toMatch(/partition: 'browser-chrome'/);
	});

	/*
	 * The bug this file exists because of.
	 *
	 * `ProxyCapableSession` once declared a `login` event Electron has never had,
	 * and `as unknown as` was what stopped the compiler saying so — proxy
	 * credentials went to an event that never fired. The port for this browser was
	 * drafted with three of its own mistakes (`setWindowOpenHandler` on the wrong
	 * type, `partition` and `userAgent` as window options, `cache` optional when
	 * Electron requires it), and the compiler caught all three only because
	 * nothing here casts them away.
	 */
	it('translates without casting, so the compiler checks the claim', () => {
		expect(ADAPTER).not.toMatch(/as unknown as/);
		expect(ADAPTER).not.toMatch(/\bas any\b/);
	});

	it('puts the partition where Electron actually reads it', () => {
		// `webPreferences.partition`, not a top-level option — a top-level
		// `partition` is silently ignored, and the window would quietly share the
		// default session instead of the account's.
		const webPreferences = ADAPTER.slice(ADAPTER.indexOf('webPreferences'));
		expect(webPreferences).toMatch(/partition:\s*options\.partition/);
	});

	/*
	 * **A page asking for a window gets a tab, not a window.**
	 *
	 * Allowing it would open a real popup: same session, same signed-in account,
	 * but no address bar and no tab strip — a window with none of the things
	 * added so somebody can tell where they are. The request is denied and a tab
	 * is opened in its place, hardened by the same function as every other.
	 */
	it('turns a page’s window.open into a tab in this window', () => {
		const handler = ADAPTER.slice(ADAPTER.indexOf('setWindowOpenHandler((details)'));
		// To the end of the handler, not to its first `return`: the scheme check
		// and the ceiling each return a `deny` before the interesting part.
		const body = handler.slice(0, handler.indexOf("view.webContents.on('login'"));
		// Chromium performs the navigation now; the adapter only supplies the tab.
		expect(body).toMatch(/action: 'allow'/);
		expect(handler).toMatch(/createWindow:/);
		// Still refused for a scheme the address bar would not take, and at the
		// ceiling.
		expect(handler).toMatch(/action: 'deny'/);
	});

	/*
	 * **This test used to require the bug.**
	 *
	 * It asserted `openTab(details.url)` — the page's own string handed straight
	 * to `loadURL` in the main process, where none of the renderer's navigation
	 * restrictions apply. So a trading page could `window.open` a `file:` or
	 * `data:` URL and have this application open it: the two schemes
	 * `addressToUrl` refuses *by name* for anything typed in the address bar,
	 * reachable by getting a page to ask instead of typing.
	 *
	 * The assertion was not merely missing the hole; it was holding it open.
	 */
	it('puts a page’s chosen address through the same gate the address bar uses', () => {
		const handler = ADAPTER.slice(ADAPTER.indexOf('setWindowOpenHandler((details)'));
		// To the end of the handler, not to its first `return`: the scheme check
		// and the ceiling each return a `deny` before the interesting part.
		const body = handler.slice(0, handler.indexOf("view.webContents.on('login'"));
		expect(body).toMatch(/addressToUrl\(details\.url\)/);
		expect(body, 'the raw page-supplied URL still reaches openTab').not.toMatch(
			/openTab\(details\.url\)/
		);
	});

	it('refuses to let a caller replace that handler', () => {
		// The port still has `setWindowOpenHandler`, and honouring it would let a
		// page's request escape into a chromeless window.
		const exposed = ADAPTER.slice(ADAPTER.indexOf('setWindowOpenHandler: ()'));
		expect(exposed.slice(0, 400)).not.toMatch(/webContents\.setWindowOpenHandler/);
	});

	/*
	 * A page must not be able to rename the window it is displayed in.
	 *
	 * The `title` constructor option only picks the *initial* title; Electron
	 * updates it from the document unless `page-title-updated` is prevented. A
	 * comment here once claimed the option was enough, which meant a page could
	 * have titled itself "Steam — Sign In" inside the user's own authenticator,
	 * wearing this application's window chrome.
	 */
	/*
	 * **A page must not be able to rename the window it is shown in.**
	 *
	 * This was a `page-title-updated` listener, and it spent a while registered
	 * on `webContents` where preventing it stops nothing — only `BrowserWindow`
	 * sets the native title from the document. The window wore "Steam Community
	 * :: Trade Offers" while a test that searched the file for the event name
	 * passed.
	 *
	 * `BaseWindow` has no such behaviour at all: its title is only ever what
	 * `setTitle` is given. The protection is now structural rather than a
	 * listener somebody has to remember, which is why this asserts the base
	 * class instead of the handler.
	 */
	it('uses a window whose title a page cannot touch', () => {
		expect(ADAPTER).toMatch(/new BaseWindow\(/);
		expect(ADAPTER, 'a BrowserWindow takes its title from the document').not.toMatch(
			/new BrowserWindow\(/
		);
	});

	/*
	 * **Two navigation events, because one leaves the title lying.**
	 *
	 * `did-navigate` fires for a real page load. `did-navigate-in-page` fires for
	 * `history.pushState`, which changes the address without a load and is how a
	 * single-page application moves. With only the first, the title goes on
	 * naming where the window used to be — and a stale address in the one
	 * control that says whether you are still on Steam is worse than no address
	 * at all, because it is confidently wrong.
	 *
	 * Asserted here because removing the second listener breaks nothing that any
	 * other test can see: the window still opens, still loads, still renames
	 * itself on the first navigation.
	 */
	it('follows in-page navigation as well as real page loads', () => {
		expect(ADAPTER).toMatch(/'did-navigate'/);
		expect(ADAPTER).toMatch(/'did-navigate-in-page'/);
	});

	it('reads the address from the contents rather than from the event', () => {
		// A page that could name its own location could lie about it, and this
		// address is what tells somebody they have left Steam.
		expect(ADAPTER).toMatch(/webContents\.getURL\(\)/);
	});

	/*
	 * **One function builds every tab, and it is the only thing that may.**
	 *
	 * The dangerous version of tabs is one where the first is hardened and the
	 * ones a website opens are not. So the user agent, the WebRTC policy and the
	 * window-open handler are all applied in `openTab`, and nothing else
	 * constructs a tab view.
	 */
	it('hardens every tab in one place', () => {
		// `newTab` is that one place: `openTab` wraps it to load a URL, and the
		// window-open handler wraps it to adopt the contents Chromium made.
		const open = ADAPTER.slice(ADAPTER.indexOf('const newTab ='));
		const body = open.slice(0, open.indexOf('const closeTab'));
		expect(ADAPTER).toMatch(/\.\.\.HARDENED/);
		expect(ADAPTER).toMatch(/partition: options\.partition/);
		expect(ADAPTER).toMatch(/setUserAgent\(options\.userAgent\)/);
		expect(body).toMatch(/setWebRTCIPHandlingPolicy\(webRtcPolicy\)/);
		expect(body).toMatch(/setWindowOpenHandler/);
	});

	/*
	 * **A new tab is empty; the first tab is not.**
	 *
	 * The window opens on the account's trade offers, which is what it is for.
	 * Every tab after that used to land there too — so somebody who opened a tab
	 * to go somewhere else was taken back to the page they were already on, and
	 * had to clear the address bar before they could type.
	 */
	it('opens a new tab blank, and puts the cursor in the address bar', () => {
		// The call now carries the request a popup was making — its POST body and
		// referrer — so the assertion is on the fallback, not the whole call.
		expect(ADAPTER).toMatch(/loadURL\(url \?\? 'about:blank'/);

		const handler = ADAPTER.slice(ADAPTER.indexOf('const onNewTab ='));
		const body = handler.slice(0, handler.indexOf('const onSelectTab'));
		expect(body, 'a new tab was given a destination').toMatch(/openTab\(\)/);
		expect(body).toMatch(/browser-chrome:focus-address/);
	});

	it('shows nothing in the address bar for a blank tab', () => {
		// `about:blank` is a real URL Chromium reports, and putting it in the
		// field tells the user nothing while getting in the way of typing.
		expect(ADAPTER).toMatch(/at === 'about:blank' \? '' : at/);
	});

	it('builds tab views nowhere else', () => {
		/*
		 * Three constructions in the file: the chrome, and the two branches of
		 * `newTab` — one that makes fresh contents, one that adopts the contents
		 * Chromium already built for a popup. Both are inside `newTab`, which is
		 * what "one place" means here.
		 */
		const constructions = ADAPTER.match(/new WebContentsView\(/g) ?? [];
		expect(constructions).toHaveLength(3);
		const outside = ADAPTER.slice(0, ADAPTER.indexOf('const newTab ='));
		expect(
			(outside.match(/new WebContentsView\(/g) ?? []).length,
			'a tab view is built outside newTab'
		).toBe(1);
	});

	/*
	 * A tab opened after the proxy was settled must not start on the default
	 * policy — a tab that ran even briefly with it could have answered a peer
	 * connection and given away the address the proxy exists to hide.
	 */
	it('gives a later tab the WebRTC policy the window already had', () => {
		expect(ADAPTER).toMatch(/webRtcPolicy = policy/);
		const open = ADAPTER.slice(ADAPTER.indexOf('const newTab ='));
		expect(open.slice(0, open.indexOf('const closeTab'))).toMatch(
			/setWebRTCIPHandlingPolicy\(webRtcPolicy\)/
		);
	});

	/*
	 * Every browser window has a toolbar and `ipcMain.on` is process-wide, so
	 * without a sender check one window's toolbar would steer all of them —
	 * including one signed in as a different account.
	 */
	it('answers only its own toolbar', () => {
		expect(ADAPTER).toMatch(/event\.sender === chrome\.webContents/);
	});

	it('stops listening when the window closes', () => {
		// `ipcMain` listeners outlive the window that added them; four windows
		// opened and closed would otherwise leave four dead handlers behind.
		expect(ADAPTER).toMatch(/removeListener\('browser-chrome:back'/);
		expect(ADAPTER).toMatch(/removeListener\('browser-chrome:go'/);
	});

	it('lays the views out again when the window changes size', () => {
		// `BaseWindow` does not resize its children, so without this the page
		// keeps the size it had when it opened — which is what "the proportions
		// are bad in fullscreen" looked like.
		expect(ADAPTER).toMatch(/window\.on\('resize', layout\)/);
		expect(ADAPTER).toMatch(/enter-full-screen/);
	});
});

/*
 * **A tab is a renderer process, and nothing was counting them.**
 *
 * `window.open` from a page went straight to the `WebContentsView` constructor
 * with no ceiling and no rate limit, in a window signed in to somebody's Steam
 * account. A page in a loop — or merely a broken one — could accumulate
 * renderer processes until the machine gave up.
 */
describe('the number of tabs one window will hold', () => {
	it('has a ceiling at all', () => {
		expect(ADAPTER).toMatch(/const MAX_TABS = \d+;/);
	});

	it('checks it before building anything', () => {
		const open = ADAPTER.slice(ADAPTER.indexOf('const newTab ='));
		const guard = open.indexOf('tabs.size >= MAX_TABS');
		const construct = open.indexOf('new WebContentsView');
		expect(guard).toBeGreaterThan(-1);
		expect(guard, 'the view is built before the ceiling is consulted').toBeLessThan(construct);
	});

	/*
	 * The same ceiling for a page and for the user's own `+`. A limit a page can
	 * reach and a person cannot is a limit that gets reported as a bug — so the
	 * button is disabled at it rather than left to do nothing, which is the one
	 * answer this codebase says a button must never give.
	 */
	it('tells the toolbar when it has been reached', () => {
		expect(ADAPTER).toMatch(/atTabLimit: tabs\.size >= MAX_TABS/);
	});
});

/*
 * **A popup carries a request, not just an address.**
 *
 * Only `details.url` used to survive the conversion, so a form submitted with
 * `target="_blank"` reached the server as a bare `GET` with no body — the user
 * pressed a button, a tab opened, and the thing they asked for never happened.
 * Proved on the wire in `smoke-browser-window.mjs` against a real local server;
 * these guard the two fields that carry it.
 */
describe('what a page’s window.open carries into its tab', () => {
	const handler = ADAPTER.slice(ADAPTER.indexOf('setWindowOpenHandler((details)'));
	// The whole handler: the scheme check and the ceiling each return a `deny`
	// before the part that decides how the request is made.
	const body = handler.slice(0, handler.indexOf("view.webContents.on('login'"));

	/*
	 * **Not by transcription any more.** Carrying the method, body, content type
	 * and boundary across by hand produced a request that was faithful enough to
	 * be dangerous: rebuilt with `loadURL` it had no initiator, so Chromium
	 * attached `SameSite=Strict` cookies a real cross-site post never carries.
	 *
	 * Letting Chromium navigate a tab we supply makes every one of those correct
	 * by construction. The wire evidence is in `smoke-browser-window.mjs`, which
	 * posts across sites and compares against a plain navigation.
	 */
	it('lets Chromium make the request rather than rebuilding it', () => {
		expect(body).toMatch(/createWindow:/);
		expect(body, 'the request is being transcribed again').not.toMatch(/postData/);
		expect(body).not.toMatch(/httpReferrer/);
	});

	it('adopts the contents Chromium already created', () => {
		expect(body).toMatch(/webContents/);
		expect(ADAPTER).toMatch(/new WebContentsView\(\{ webContents: adopt \}\)/);
	});

	/*
	 * `window.opener` is deliberately **not** carried, and cannot be: honouring
	 * the popup would mean a real window with no address bar and no tab strip,
	 * which a page could then dress up as anything it liked. A missing opener
	 * breaks a callback; a chromeless window signed in to Steam is what this
	 * application exists to warn people about.
	 *
	 * Asserted as "the popup is still refused" rather than by looking for the
	 * word — `ADAPTER` has its comments stripped, deliberately, so that these
	 * tests read code and not prose.
	 */
	/*
	 * **The popup is allowed now, and that is the fix — but into a tab.**
	 *
	 * Denying it and rebuilding the request was what broke SameSite. What must
	 * never happen is a separate *window*: chromeless, no address bar, no strip,
	 * and a page free to draw its own. `createWindow` returning one of our own
	 * views is what keeps the navigation Chromium's and the frame ours.
	 */
	it('never lets the popup become a window of its own', () => {
		expect(body).toMatch(/createWindow:/);
		expect(body, 'a real popup window is being created').not.toMatch(/new BrowserWindow/);
		expect(body).not.toMatch(/overrideBrowserWindowOptions/);
		// And a scheme the address bar refuses, or a full window, still gets one.
		expect(handler).toMatch(/action: 'deny'/);
	});
});
