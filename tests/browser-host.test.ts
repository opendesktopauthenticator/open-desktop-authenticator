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

	it('sets the user agent on the contents, not only the session', () => {
		// The session's agent covers subresources; navigation uses the contents'.
		// Without this the first page load announces Electron.
		expect(ADAPTER).toMatch(/window\.webContents\.setUserAgent/);
	});
});
