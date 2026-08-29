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

		/*
		 * The chrome runs in its own partition, deliberately not the account's.
		 *
		 * It shares no cookies with Steam, and because its partition is not one
		 * `isAccountBrowserContents` knows about, it keeps the application-wide
		 * navigation lock the tabs are exempt from. The chrome never navigates; if
		 * it ever tried, it would be stopped.
		 */
		const chrome = new WebContentsView({
			webPreferences: {
				...HARDENED,
				partition: 'browser-chrome',
				preload: join(__dirname, '../preload/browser-chrome.js')
			}
		});
		window.contentView.addChildView(chrome);

		/** Set once `openAccountBrowser` subscribes; called as the active tab moves. */
		let navigated: () => void = () => undefined;
		/** The address last announced, so the same one is not announced twice. */
		let lastAnnounced: string | undefined;

		/*
		 * **Every tab is built the same way, or it is not built.**
		 *
		 * A tab opened by the user and a tab opened by a page are the same object
		 * here on purpose. The dangerous version of this feature is one where the
		 * first tab is hardened and the ones a website opens are not — so there is
		 * one function, and nothing else creates a view.
		 */
		const tabs = new Map<number, WebContentsView>();
		let nextId = 1;
		let activeId = 0;

		const bodyBounds = (): Electron.Rectangle => {
			const bounds = window.getContentBounds();
			return {
				x: 0,
				y: CHROME_HEIGHT,
				width: bounds.width,
				height: Math.max(0, bounds.height - CHROME_HEIGHT)
			};
		};

		/**
		 * The address to show for a view, which is nothing for a blank one.
		 *
		 * `about:blank` is a real URL and Chromium reports it, but putting it in
		 * an address bar tells the user nothing and cannot be typed over without
		 * clearing it first. An empty tab shows an empty field.
		 */
		const shown = (view: WebContentsView | undefined): string => {
			if (!view || view.webContents.isDestroyed()) {
				return '';
			}
			const at = view.webContents.getURL();
			return at === 'about:blank' ? '' : at;
		};

		const publish = (): void => {
			if (chrome.webContents.isDestroyed()) {
				return;
			}
			const active = tabs.get(activeId);
			const url = shown(active);
			/*
			 * Only when the address actually changed.
			 *
			 * `publish` runs on loading and title changes too, so this fired seven
			 * times for one page load — seven `setTitle` calls describing the same
			 * address. Harmless, and wrong about what the event means: a caller
			 * subscribing to "navigated" is told the window moved.
			 */
			if (url !== lastAnnounced) {
				lastAnnounced = url;
				navigated();
			}
			chrome.webContents.send('browser-chrome:state', {
				url,
				canGoBack: active ? active.webContents.navigationHistory.canGoBack() : false,
				canGoForward: active ? active.webContents.navigationHistory.canGoForward() : false,
				loading: active ? active.webContents.isLoading() : false,
				offSteam: url !== '' && !isSteamHost(url),
				tabs: [...tabs.entries()].map(([id, view]) => {
					const at = shown(view);
					return {
						id,
						/*
						 * A blank tab has no title, whatever Chromium says.
						 *
						 * `getTitle()` on `about:blank` returns "about:blank", so a new
						 * tab was labelled with the URL it was deliberately not showing
						 * in the address bar. Empty here lets the strip fall back to
						 * "New tab", which is what it is.
						 */
						title: at === '' || view.webContents.isDestroyed() ? '' : view.webContents.getTitle(),
						url: at,
						active: id === activeId,
						offSteam: at !== '' && !isSteamHost(at)
					};
				})
			});
		};

		const show = (id: number): void => {
			const chosen = tabs.get(id);
			if (!chosen) {
				return;
			}
			activeId = id;
			for (const [at, view] of tabs) {
				view.setVisible(at === id);
			}
			chosen.setBounds(bodyBounds());
			chosen.webContents.focus();
			publish();
		};

		const openTab = (url?: string): number => {
			const view = new WebContentsView({
				webPreferences: {
					...HARDENED,
					partition: options.partition
				}
			});
			const id = nextId++;
			tabs.set(id, view);

			// The same three things every tab gets, in the same order, because a
			// tab that missed one would be a hole shaped exactly like a new tab.
			view.webContents.setUserAgent(options.userAgent);
			view.webContents.setWebRTCIPHandlingPolicy(webRtcPolicy);
			view.webContents.setWindowOpenHandler((details) => {
				// A page asking for a window gets a tab in this window instead —
				// hardened the same way, and visible in the same strip.
				openTab(details.url);
				return { action: 'deny' };
			});

			// Listed rather than looped: TypeScript types each of these separately,
			// and a loop over the names loses the overload that checks the listener.
			view.webContents.on('did-navigate', publish);
			view.webContents.on('did-navigate-in-page', publish);
			view.webContents.on('did-start-loading', publish);
			view.webContents.on('did-stop-loading', publish);
			view.webContents.on('page-title-updated', publish);

			// Matches the chrome, so a blank tab does not flash white in a dark
			// window before anything loads.
			view.setBackgroundColor('#101216');
			window.contentView.addChildView(view);
			view.setBounds(bodyBounds());
			// `about:blank` rather than nothing at all: a view with no document
			// reports no title and no URL, which the strip and the address bar both
			// read as an empty tab — which is exactly what it is.
			void view.webContents.loadURL(url ?? 'about:blank').catch(publish);
			show(id);
			return id;
		};

		const closeTab = (id: number): void => {
			const view = tabs.get(id);
			if (!view) {
				return;
			}
			const order = [...tabs.keys()];
			tabs.delete(id);
			window.contentView.removeChildView(view);
			if (!view.webContents.isDestroyed()) {
				view.webContents.close();
			}
			if (tabs.size === 0) {
				// Closing the last tab closes the window, as it does everywhere else.
				window.close();
				return;
			}
			if (activeId === id) {
				const at = order.indexOf(id);
				show([...tabs.keys()][Math.max(0, at - 1)] ?? [...tabs.keys()][0] ?? 0);
			} else {
				publish();
			}
		};

		/*
		 * WebRTC is decided before the first tab exists, so every tab is opened
		 * with it rather than having it applied afterwards. A tab that ran even
		 * briefly with the default policy could have answered a peer connection
		 * and given away the address the proxy exists to hide.
		 */
		let webRtcPolicy: 'disable_non_proxied_udp' | 'default' = 'default';

		const layout = (): void => {
			const bounds = window.getContentBounds();
			chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: CHROME_HEIGHT });
			const active = tabs.get(activeId);
			if (active) {
				active.setBounds(bodyBounds());
			}
		};
		layout();
		// Explicit, because `BaseWindow` does not resize its children. This is also
		// what keeps the proportions right when the window is maximised rather than
		// merely correct at the size it opened.
		window.on('resize', layout);
		window.on('enter-full-screen', layout);
		window.on('leave-full-screen', layout);

		void chrome.webContents.loadURL(
			'data:text/html;charset=utf-8,' + encodeURIComponent(CHROME_HTML)
		);

		/*
		 * The chrome's verbs, and nothing else.
		 *
		 * Scoped by comparing the sender: `ipcMain.on` is process-wide and every
		 * browser window has chrome, so without the check one window's toolbar
		 * would steer all of them — including one signed in as another account.
		 */
		const mine = (event: IpcMainEvent): boolean => event.sender === chrome.webContents;
		const active = (): WebContentsView | undefined => tabs.get(activeId);

		const onBack = (event: IpcMainEvent): void => {
			if (mine(event)) active()?.webContents.navigationHistory.goBack();
		};
		const onForward = (event: IpcMainEvent): void => {
			if (mine(event)) active()?.webContents.navigationHistory.goForward();
		};
		const onReload = (event: IpcMainEvent): void => {
			if (!mine(event)) return;
			const view = active();
			if (!view) return;
			if (view.webContents.isLoading()) {
				view.webContents.stop();
			} else {
				view.webContents.reload();
			}
		};
		const onGo = (event: IpcMainEvent, typed: unknown): void => {
			if (!mine(event) || typeof typed !== 'string') return;
			const target = addressToUrl(typed);
			if (target !== undefined) {
				void active()?.webContents.loadURL(target).catch(publish);
			}
		};
		const onNewTab = (event: IpcMainEvent): void => {
			/*
			 * A new tab is empty, the way every browser's is.
			 *
			 * It used to land on the account's trade offers, which is right for the
			 * *first* tab — that is what the window is for — and wrong for every one
			 * after it: somebody who opens a tab has somewhere else in mind, and
			 * being taken back to the page they are already on is a step to undo.
			 */
			if (mine(event)) {
				openTab();
				if (!chrome.webContents.isDestroyed()) {
					chrome.webContents.send('browser-chrome:focus-address');
					chrome.webContents.focus();
				}
			}
		};
		const onSelectTab = (event: IpcMainEvent, id: unknown): void => {
			if (mine(event) && typeof id === 'number') show(id);
		};
		const onCloseTab = (event: IpcMainEvent, id: unknown): void => {
			if (mine(event) && typeof id === 'number') closeTab(id);
		};

		ipcMain.on('browser-chrome:back', onBack);
		ipcMain.on('browser-chrome:forward', onForward);
		ipcMain.on('browser-chrome:reload', onReload);
		ipcMain.on('browser-chrome:go', onGo);
		ipcMain.on('browser-chrome:new-tab', onNewTab);
		ipcMain.on('browser-chrome:select-tab', onSelectTab);
		ipcMain.on('browser-chrome:close-tab', onCloseTab);

		window.on('closed', () => {
			// Removed by reference, so closing one window does not deafen the rest.
			ipcMain.removeListener('browser-chrome:back', onBack);
			ipcMain.removeListener('browser-chrome:forward', onForward);
			ipcMain.removeListener('browser-chrome:reload', onReload);
			ipcMain.removeListener('browser-chrome:go', onGo);
			ipcMain.removeListener('browser-chrome:new-tab', onNewTab);
			ipcMain.removeListener('browser-chrome:select-tab', onSelectTab);
			ipcMain.removeListener('browser-chrome:close-tab', onCloseTab);
		});

		return {
			// The first tab. Everything after it is opened by the strip or by a page.
			loadURL: (url) => {
				const id = tabs.size === 0 ? openTab() : activeId;
				const view = tabs.get(id);
				if (!view) {
					return Promise.reject(new Error('the browser window has no tab to load into'));
				}
				return view.webContents.loadURL(url);
			},
			// The contents' URL, not the one requested: after Steam's redirects
			// these differ, and the difference is the only way to tell a signed-in
			// landing from a login page.
			currentUrl: () => active()?.webContents.getURL() ?? '',
			focus: () => {
				// `focus()` alone does nothing to a minimised window.
				if (window.isMinimized()) {
					window.restore();
				}
				window.focus();
			},
			setTitle: (title) => window.setTitle(title),
			setWebRtcPolicy: (policy) => {
				// Kept, so tabs opened later start with it rather than having it
				// applied after their first request.
				webRtcPolicy = policy;
				for (const view of tabs.values()) {
					view.webContents.setWebRTCIPHandlingPolicy(policy);
				}
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
				 * Bound to the window rather than to one tab: the address the title
				 * shows is the active tab's, and that changes when tabs do.
				 */
				const report = (): void => {
					listener(active()?.webContents.getURL() ?? '');
				};
				navigated = report;
			},
			setWindowOpenHandler: () => {
				/*
				 * Accepted and ignored, deliberately.
				 *
				 * Every tab already has a handler that turns a page's `window.open`
				 * into another tab in this window — hardened identically and listed in
				 * the same strip. Letting a caller replace that would let a page's
				 * request escape into a window with no address bar and no tab strip,
				 * which is the shape this feature exists to avoid.
				 */
			}
		};
	}
};
