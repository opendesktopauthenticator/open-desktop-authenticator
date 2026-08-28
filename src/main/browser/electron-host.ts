import {
	BaseWindow,
	ipcMain,
	screen,
	session,
	WebContentsView,
	type IpcMainEvent,
	type Session,
	type WebContents
} from 'electron';
import { join } from 'node:path';

import { CHROME_HEIGHT, CHROME_HTML } from './chrome-html';
import { addressToUrl, isSteamHost } from './window';

import { denyAllPermissions } from '../security';
import { windowImage } from '../logo-image';

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

/**
 * Sessions this module created, so the process-wide navigation lock can tell
 * this window from every other one.
 *
 * A `WeakSet` rather than a list of partition names: identity is the question
 * being asked, and `session.fromPartition` returns the same object for the same
 * partition, so this answers it exactly. Nothing is kept alive by being in here.
 */
const browserSessions = new WeakSet<Session>();

/**
 * Is this `WebContents` part of the in-app browser?
 *
 * Passed to `hardenAllWebContents`. Registration happens in
 * `sessionFromPartition`, which `openAccountBrowser` calls before it creates the
 * window — so the session is known by the time `web-contents-created` fires.
 */
export function isAccountBrowserContents(contents: WebContents): boolean {
	return browserSessions.has(contents.session);
}

export const electronBrowserHost: BrowserHost = {
	sessionFromPartition(partition, options): BrowserSessionHandle {
		const partitioned = session.fromPartition(partition, options);
		browserSessions.add(partitioned);
		/*
		 * `Object.assign` rather than a spread and a cast: an Electron `Session`
		 * already satisfies the rest of the port structurally, and widening it
		 * keeps that true instead of asserting it.
		 *
		 * §P8 denies every permission, but it does so against the default session
		 * and this partition inherits none of it — and Electron with no handler
		 * approves. So the same refusal is applied here, explicitly.
		 */
		return Object.assign(partitioned, {
			denyPermissions: () => denyAllPermissions(partitioned)
		});
	},

	createWindow(options: BrowserWindowOptions): BrowserWindowHandle {
		/*
		 * Sized against the screen it opens on, not against a number typed once.
		 *
		 * 1280x860 is a reasonable window on a 1080p laptop and a postage stamp on
		 * a 4K monitor. The requested size is a preference and a cap: it shrinks to
		 * fit a small display, and grows to a sensible share of a large one.
		 */
		const area = screen.getPrimaryDisplay().workAreaSize;
		const width = Math.min(area.width - 80, Math.max(options.width, Math.round(area.width * 0.8)));
		const height = Math.min(
			area.height - 80,
			Math.max(options.height, Math.round(area.height * 0.85))
		);

		/*
		 * **Two views, not one window with a bar drawn inside it.**
		 *
		 * The toolbar and the site are separate `WebContents`. The toolbar has a
		 * preload and no access to Steam; the site has Steam and no preload at all.
		 * A chrome bar rendered inside the page would be a bar the page could read,
		 * restyle, move and forge — the exact trick /scam-clones documents, and it
		 * would be this application drawing it.
		 *
		 * `BaseWindow` has no `page-title-updated` handling of its own, so the page
		 * cannot rename the window even by accident: the title is only ever what
		 * `setTitle` is given.
		 */
		const window = new BaseWindow({
			width,
			height,
			title: options.title,
			// The same mark the main window carries. Without it this window took
			// Electron's default and announced itself as a generic Electron app in
			// the taskbar, while holding a live Steam session.
			icon: windowImage(),
			autoHideMenuBar: true
		});

		const page = new WebContentsView({
			webPreferences: {
				...HARDENED,
				partition: options.partition
			}
		});

		/*
		 * The toolbar runs in its own partition, deliberately not the browser's.
		 *
		 * It shares no cookies with Steam, and because it is not one of the
		 * sessions `isAccountBrowserContents` knows about, it keeps the
		 * application-wide navigation lock the page view is exempt from. The
		 * toolbar never navigates; if it ever tried, it would be stopped.
		 */
		const chrome = new WebContentsView({
			webPreferences: {
				...HARDENED,
				partition: 'browser-chrome',
				preload: join(__dirname, '../preload/browser-chrome.js')
			}
		});

		window.contentView.addChildView(chrome);
		window.contentView.addChildView(page);

		const layout = (): void => {
			const bounds = window.getContentBounds();
			chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: CHROME_HEIGHT });
			page.setBounds({
				x: 0,
				y: CHROME_HEIGHT,
				width: bounds.width,
				height: Math.max(0, bounds.height - CHROME_HEIGHT)
			});
		};
		layout();
		// Explicit, because `BaseWindow` does not resize its children. This is also
		// what keeps the proportions right when the window is maximised rather than
		// merely correct at the size it opened.
		window.on('resize', layout);
		window.on('enter-full-screen', layout);
		window.on('leave-full-screen', layout);

		// Chromium sends the session's user agent for subresources, but the
		// contents keep their own for navigation — so it is set here as well as on
		// the session, or the first page load announces Electron.
		page.webContents.setUserAgent(options.userAgent);

		void chrome.webContents.loadURL(
			'data:text/html;charset=utf-8,' + encodeURIComponent(CHROME_HTML)
		);

		/** Push the page's state to the toolbar so it can draw itself. */
		const publish = (): void => {
			if (chrome.webContents.isDestroyed() || page.webContents.isDestroyed()) {
				return;
			}
			const url = page.webContents.getURL();
			chrome.webContents.send('browser-chrome:state', {
				url,
				canGoBack: page.webContents.navigationHistory.canGoBack(),
				canGoForward: page.webContents.navigationHistory.canGoForward(),
				loading: page.webContents.isLoading(),
				offSteam: !isSteamHost(url)
			});
		};
		// Listed rather than looped: TypeScript types each of these events
		// separately, and a loop over the names loses the overload that makes the
		// listener check.
		page.webContents.on('did-navigate', publish);
		page.webContents.on('did-navigate-in-page', publish);
		page.webContents.on('did-start-loading', publish);
		page.webContents.on('did-stop-loading', publish);
		page.webContents.on('did-finish-load', publish);

		/*
		 * The toolbar's four verbs, and nothing else.
		 *
		 * Scoped by comparing the sender: `ipcMain.on` is process-wide and every
		 * browser window has a toolbar, so without the check one window's toolbar
		 * would steer all of them.
		 */
		const mine = (event: IpcMainEvent): boolean => event.sender === chrome.webContents;
		const onBack = (event: IpcMainEvent): void => {
			if (mine(event)) page.webContents.navigationHistory.goBack();
		};
		const onForward = (event: IpcMainEvent): void => {
			if (mine(event)) page.webContents.navigationHistory.goForward();
		};
		const onReload = (event: IpcMainEvent): void => {
			if (!mine(event)) return;
			if (page.webContents.isLoading()) {
				page.webContents.stop();
			} else {
				page.webContents.reload();
			}
		};
		const onGo = (event: IpcMainEvent, typed: unknown): void => {
			if (!mine(event) || typeof typed !== 'string') return;
			const target = addressToUrl(typed);
			if (target !== undefined) {
				void page.webContents.loadURL(target).catch(() => publish());
			}
		};
		ipcMain.on('browser-chrome:back', onBack);
		ipcMain.on('browser-chrome:forward', onForward);
		ipcMain.on('browser-chrome:reload', onReload);
		ipcMain.on('browser-chrome:go', onGo);

		window.on('closed', () => {
			// Removed by reference, so closing one window does not deafen the rest.
			ipcMain.removeListener('browser-chrome:back', onBack);
			ipcMain.removeListener('browser-chrome:forward', onForward);
			ipcMain.removeListener('browser-chrome:reload', onReload);
			ipcMain.removeListener('browser-chrome:go', onGo);
		});

		return {
			loadURL: (url) => page.webContents.loadURL(url),
			// The contents' URL, not the one requested: after Steam's redirects
			// these differ, and the difference is the only way to tell a signed-in
			// landing from a login page.
			currentUrl: () => page.webContents.getURL(),
			focus: () => {
				// `focus()` alone does nothing to a minimised window.
				if (window.isMinimized()) {
					window.restore();
				}
				window.focus();
			},
			setTitle: (title) => window.setTitle(title),
			setWebRtcPolicy: (policy) => {
				// Chromium's own name for "open no UDP that would skip the proxy",
				// which is exactly the leak a proxied browser still has.
				page.webContents.setWebRTCIPHandlingPolicy(policy);
			},
			close: () => window.close(),
			isDestroyed: () => window.isDestroyed(),
			on: (event, listener) => {
				if (event === 'closed') {
					window.on('closed', listener as () => void);
					return;
				}
				/*
				 * Two events, because one is not enough. `did-navigate` covers a real
				 * page load; `did-navigate-in-page` covers history.pushState, which
				 * changes the address without one. Listening only to the first leaves
				 * the title naming where the window used to be — a stale address in a
				 * security control is worse than none, because it is confidently
				 * wrong.
				 *
				 * The URL is Electron's, read off the contents rather than taken from
				 * the event, so nothing the page says reaches the title.
				 */
				const report = (): void => {
					listener(page.webContents.getURL());
				};
				page.webContents.on('did-navigate', report);
				page.webContents.on('did-navigate-in-page', report);
			},
			setWindowOpenHandler: (handler) => {
				// The page's contents, not the toolbar's: popups belong to the site.
				page.webContents.setWindowOpenHandler((details) => handler({ url: details.url }));
			}
		};
	}
};
