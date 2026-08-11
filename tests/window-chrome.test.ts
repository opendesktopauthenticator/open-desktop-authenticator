import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The window frame, which is the one part of the UI the stylesheet cannot reach.
 *
 * On Windows the title bar is removed and the real minimise/maximise/close
 * buttons are drawn back over the page as a Window Controls Overlay, in colours
 * the main process supplies. That buys an unbroken dark window, and costs two
 * things a stylesheet normally guarantees:
 *
 *  - the colours are literals in `index.ts`, so they can drift from `app.css`
 *    silently — nothing imports anything, so nothing breaks loudly;
 *  - the page now owns the top strip, so it must leave room for the controls and
 *    provide somewhere to drag from.
 *
 * Both are asserted here rather than trusted to a comment.
 */

const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const main = read('src/main/index.ts');
const css = read('src/renderer/app.css');

/** The value of a custom property as declared in the stylesheet. */
function token(name: string): string {
	const found = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css);
	if (!found?.[1]) {
		throw new Error(`app.css no longer declares --${name}`);
	}
	return found[1];
}

describe('window chrome', () => {
	it('paints the frame in the same colours the stylesheet uses', () => {
		// The drift this catches: someone retunes the palette in app.css, every
		// pixel the renderer draws follows, and the title bar alone stays on the
		// old colour — which is exactly the mismatched-strip look this replaced.
		const chrome =
			/const WINDOW_CHROME = \{ background: '(#[0-9a-f]{6})', symbol: '(#[0-9a-f]{6})' \}/i;
		const found = chrome.exec(main);
		expect(found, 'WINDOW_CHROME is no longer a pair of colour literals').not.toBeNull();
		expect(found?.[1]).toBe(token('bg'));
		expect(found?.[2]).toBe(token('muted'));
	});

	it('removes the title bar on Windows only', () => {
		// **The reason this test exists.** `titleBarStyle: 'hidden'` is honoured on
		// Linux; `titleBarOverlay` is not. Ungating this would ship a Linux window
		// with no title bar and no buttons drawn in its place — no close, no
		// minimise, nothing but the keyboard. A frame that does not match the theme
		// is a blemish; a window that cannot be closed is a defect.
		expect(main.match(/titleBarStyle/g)).toHaveLength(1);
		const gate = main.indexOf("process.platform === 'win32'");
		expect(gate, 'the platform gate is gone').toBeGreaterThan(-1);
		const style = main.indexOf('titleBarStyle');
		expect(style).toBeGreaterThan(gate);
		// Inside the same ternary, not merely somewhere after it.
		expect(style - gate).toBeLessThan(200);
	});

	it('keeps content clear of the overlaid buttons', () => {
		// Without this the header's own buttons — which sit top-right, where the
		// window controls now are — would be underneath them.
		expect(css).toMatch(/padding:\s*calc\(32px \+ env\(titlebar-area-height,\s*0px\)\)/);
	});

	it('offers somewhere to drag the window by', () => {
		// A frameless window is not draggable unless the page says so.
		expect(css).toMatch(/\.titlebar-drag\s*\{[^}]*-webkit-app-region:\s*drag/);
		expect(read('src/renderer/main.tsx')).toContain('titlebar-drag');
	});

	it('collapses that drag strip to nothing when there is no overlay', () => {
		// Every platform keeping its title bar still renders this element. Its
		// `env()` fallbacks are what stop it becoming an invisible fixed band
		// swallowing clicks on the top of every screen.
		const rule = /\.titlebar-drag\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
		expect(rule).toMatch(/width:\s*env\(titlebar-area-width,\s*0px\)/);
		expect(rule).toMatch(/height:\s*env\(titlebar-area-height,\s*0px\)/);
	});

	it('has a colour to paint before the renderer draws', () => {
		// Otherwise a resize or a slow first paint flashes white.
		expect(main).toMatch(/backgroundColor:\s*WINDOW_CHROME\.background/);
	});

	it('asks the OS for dark chrome, which is what the file pickers follow', () => {
		// The import, export and recovery dialogs are drawn by the OS, not by us.
		expect(main).toMatch(/nativeTheme\.themeSource = 'dark'/);
	});
});
