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
	it.each([
		['sandbox', /sandbox:\s*true/],
		['contextIsolation', /contextIsolation:\s*true/],
		['nodeIntegration off', /nodeIntegration:\s*false/],
		['webviewTag off', /webviewTag:\s*false/]
	])('hardens %s', (_name, pattern) => {
		expect(ADAPTER).toMatch(pattern);
	});

	/*
	 * A preload is the difference between a browser and a browser holding a
	 * pointer at the vault. There is no legitimate reason for this window to have
	 * one, and adding it would be a one-line change nothing else would notice.
	 */
	it('gives the window no preload script', () => {
		expect(ADAPTER).not.toMatch(/preload/i);
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

	it('sets the window-open handler on webContents, where it lives', () => {
		expect(ADAPTER).toMatch(/window\.webContents\.setWindowOpenHandler/);
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
	it('refuses to let the page rewrite the window title', () => {
		expect(ADAPTER).toMatch(/page-title-updated/);
		expect(ADAPTER).toMatch(/preventDefault\(\)/);
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

	it('sets the user agent on the contents, not only the session', () => {
		// The session's agent covers subresources; navigation uses the contents'.
		// Without this the first page load announces Electron.
		expect(ADAPTER).toMatch(/window\.webContents\.setUserAgent/);
	});
});
