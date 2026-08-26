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
			autoHideMenuBar: true,
			webPreferences: {
				...HARDENED,
				partition: options.partition
			}
		});

		/*
		 * **The page is not allowed to rename the window.**
		 *
		 * Setting `title` above only chooses the *initial* one: Electron updates
		 * the native title from the document unless `page-title-updated` is
		 * prevented, which an earlier comment here claimed it did not. So a page
		 * could have titled itself "Steam — Sign In" inside the user's own
		 * authenticator, which is precisely the deception this application exists
		 * to warn people about, wearing our window chrome.
		 *
		 * The title stays as the account name. That is also the more useful thing
		 * to show: when several are open, the only question worth answering at a
		 * glance is which account you are about to trade as.
		 */
		window.webContents.on('page-title-updated', (event) => {
			event.preventDefault();
		});

		// Chromium sends the session's user agent for subresources, but the
		// contents keep their own for navigation — so it is set here as well as
		// on the session, or the first page load announces Electron.
		window.webContents.setUserAgent(options.userAgent);

		return {
			loadURL: (url) => window.loadURL(url),
			// The contents' URL, not the one that was requested: after Steam's
			// redirects these are different, and the difference is the only way to
			// tell a signed-in landing from a login page.
			currentUrl: () => window.webContents.getURL(),
			focus: () => {
				// `focus()` alone does nothing to a minimised window — it is restored
				// first, or the second press on an account whose browser is minimised
				// is still a press that does nothing.
				if (window.isMinimized()) {
					window.restore();
				}
				window.focus();
			},
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
