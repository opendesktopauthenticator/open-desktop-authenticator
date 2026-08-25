import { BrowserWindow, session } from 'electron';

import type {
	BrowserHost,
	BrowserSessionHandle,
	BrowserWindowHandle,
	BrowserWindowOptions
} from './window';

/**
 * The only place `window.ts` meets Electron.
 *
 * Written as a separate file for the same reason `ElectronNetworking` exists in
 * `index.ts`: the module holding the decisions stays free of `electron` and can
 * be tested without launching an app, and the translation lives somewhere a
 * compiler can check it.
 *
 * **And it needed checking.** The port was drafted against a plausible-looking
 * Electron API and two parts of it were wrong:
 *
 *  - `setWindowOpenHandler` is on `WebContents`, not on `BrowserWindow`.
 *  - `partition` and `userAgent` are not `BrowserWindow` constructor options.
 *    `partition` belongs to `webPreferences`; a user agent is set on the
 *    contents or passed to `loadURL`.
 *
 * Neither would have been caught by the unit tests, because the tests implement
 * the port rather than Electron — which is the same trap that let a `login`
 * event Electron has never had survive in `ProxyCapableSession` until a cast
 * was removed. So this file takes no `as unknown as`: if it compiles, the port
 * describes something Electron actually offers.
 */

/** The window options this application fixes rather than exposes. */
const HARDENED = {
	// Identical to the main window's posture. The pages here are Valve's rather
	// than ours, which makes it matter more, not less: a renderer with Node
	// access browsing the open web is the shape of the problem this whole
	// project exists to warn people about.
	sandbox: true,
	contextIsolation: true,
	nodeIntegration: false,
	// No preload. The window is a browser and must not be able to reach the
	// vault, the IPC table, or anything else this process holds.
	webviewTag: false
} as const;

export const electronBrowserHost: BrowserHost = {
	sessionFromPartition(partition, options): BrowserSessionHandle {
		return session.fromPartition(partition, options);
	},

	createWindow(options: BrowserWindowOptions): BrowserWindowHandle {
		const window = new BrowserWindow({
			width: options.width,
			height: options.height,
			title: options.title,
			// Set explicitly: without it the page can rewrite the title bar to
			// anything, and a window that says "Steam Login" while showing
			// somebody else's page is the exact deception being guarded against.
			autoHideMenuBar: true,
			webPreferences: {
				...HARDENED,
				partition: options.partition
			}
		});

		// Chromium sends the session's user agent for subresources, but the
		// contents keep their own for navigation — so it is set here as well as
		// on the session, or the first page load announces Electron.
		window.webContents.setUserAgent(options.userAgent);

		return {
			loadURL: (url) => window.loadURL(url),
			close: () => window.close(),
			isDestroyed: () => window.isDestroyed(),
			on: (event, listener) => {
				window.on(event, listener);
			},
			setWindowOpenHandler: (handler) => {
				// On `webContents`, not on the window. The port names it at the
				// window because that is the thing a caller has.
				window.webContents.setWindowOpenHandler((details) => handler({ url: details.url }));
			}
		};
	}
};
