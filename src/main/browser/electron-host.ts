import {
	app,
	BrowserWindow,
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

import { denyAllPermissions, SECURE_WEB_PREFERENCES } from '../security';
import { windowImage } from '../logo-image';
import { applyWindowsTaskbarIdentity } from '../windows-taskbar-identity';
import { markAccountBrowserWindow } from '../window-role';

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
 *  - `partition` is not a `BrowserWindow` constructor option. It belongs to
 *    `webPreferences` on each tab.
 *
 * Neither would have been caught by the unit tests, because the tests implement
 * the port rather than Electron — which is the same trap that let a `login`
 * event Electron has never had survive in `ProxyCapableSession` until a cast
 * was removed. So this file takes no `as unknown as`: if it compiles, the port
 * describes something Electron actually offers.
 */

/**
 * The window options this application fixes rather than exposes.
 *
 * **Composed from the canonical posture, not restated beside it.** This object
 * used to list four of its eleven fields under a comment claiming it was
 * "identical to the main window's posture" — and that sentence is the reason
 * nobody looked again. No value disagreed; the seven it did not name simply
 * fell through to Electron's defaults, and two of those defaults are wrong:
 *
 *  - `devTools` defaults to **on**. Every Steam tab in a packaged build had
 *    DevTools available, which is the "open the console and paste this to fix
 *    your codes" vector the constant exists to close. These tabs carry no
 *    preload, so the vault was never reachable that way — what was reachable is
 *    the account's authenticated Steam session, in a window that is signed in.
 *    For an application whose only job is protecting that account, that is the
 *    scam it exists to defend against, running inside it.
 *  - `spellcheck` defaults to **on**, and an active spellchecker fetches
 *    dictionaries from a Google-run CDN — an unproxied request from the one
 *    window whose entire reason for existing is that its traffic leaves through
 *    the account's proxy.
 *
 * It compounds: these tabs are marked `isAccountBrowserContents` so
 * `hardenAllWebContents` deliberately skips the navigation lock for them, which
 * a browser needs. They were therefore the one place in the process carrying
 * both the navigation exemption and the weakened preference set.
 *
 * Adopted popup contents receive no preferences of their own — they inherit
 * transitively from the opener, which is always one of these tabs, so fixing
 * this object fixes them too. Do not "fix" that by passing preferences there.
 */
const HARDENED = {
	...SECURE_WEB_PREFERENCES,
	// Restated rather than inherited, because it is this window's reason for
	// existing separately: the pages here are Valve's rather than ours, and a
	// browser that could reach the vault, the IPC table or anything else this
	// process holds is the shape of the problem the project exists to warn
	// people about. There is no preload on these views for the same reason.
	webviewTag: false
} as const;

/** Reveal a judged account window without relying on an API Wayland does not support. */
export function revealAccountBrowserWindow(
	window: Pick<BrowserWindow, 'show' | 'showInactive' | 'focus'>,
	platform: NodeJS.Platform
): void {
	if (platform === 'win32') {
		/*
		 * A hidden BrowserWindow whose child page already owns focus can report
		 * itself focused before it is visible. On Electron 43 for Windows,
		 * `show()` then emits `show` but leaves `isVisible()` false. Reveal it
		 * without changing activation first, then explicitly focus it.
		 */
		window.showInactive();
	} else {
		// showInactive is explicitly unsupported on Wayland. Ordinary show is the
		// supported reveal path on Linux and macOS and does not hit the Windows bug.
		window.show();
	}
	window.focus();
}

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
 * How many tabs one browser window will hold.
 *
 * **Because a page can ask for one, and nothing counted.** Every tab is a real
 * `WebContentsView` with its own renderer process, and `window.open` from a
 * trading page went straight to the constructor — no ceiling, no rate limit, in
 * a window that is signed in to somebody's Steam account. A page in a loop, or
 * merely a broken one, could take the machine down with renderer processes
 * until the application stopped responding.
 *
 * Twenty is far past what a trade needs and far short of what hurts. The
 * ceiling is the same for the user's own `+`, because a limit that a page can
 * reach and a person cannot is a limit that would be reported as a bug.
 */
const MAX_TABS = 20;

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
		 * **Two contents, not one page with a bar drawn inside it.**
		 *
		 * The toolbar and the site are separate `WebContents`. The toolbar has a
		 * preload and no access to Steam; the site has Steam and no preload at all.
		 * A chrome bar rendered inside the page would be a bar the page could read,
		 * restyle, move and forge — the exact trick /scam-clones documents, and it
		 * would be this application drawing it.
		 *
		 * The shell is a `BrowserWindow` because Explorer renders a `BaseWindow`
		 * taskbar button with its generic window icon on Windows even when its native
		 * HICON and AppUserModel properties contain the product art. Its owned
		 * contents are the trusted toolbar; open-web pages remain separate child
		 * views and never gain this preload.
		 */
		const window = new BrowserWindow({
			width,
			height,
			title: options.title,
			// Account windows are born hidden and revealed only after their first
			// landing passes the main-process sign-in check. Direct host users such as
			// the smoke harness keep Electron's existing visible default.
			show: options.show ?? true,
			// The native mark for the title bar and Alt-Tab. Complete Windows taskbar
			// group details are applied below before this window is revealed.
			icon: windowImage(),
			autoHideMenuBar: true,
			webPreferences: {
				...HARDENED,
				partition: 'browser-chrome',
				preload: join(__dirname, '../preload/browser-chrome.js')
			}
		});
		markAccountBrowserWindow(window);
		window.setMenu(null);
		// BrowserWindow normally adopts its document title. Only the trusted toolbar
		// lives there, but the account/address title is a security control and has one
		// writer below, so even the toolbar cannot replace it accidentally.
		window.on('page-title-updated', (event) => event.preventDefault());
		applyWindowsTaskbarIdentity(window, {
			platform: process.platform,
			packaged: app.isPackaged,
			windowsStore: (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true,
			portable: process.env.PORTABLE_EXECUTABLE_DIR !== undefined,
			portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE,
			applicationPath: app.getAppPath(),
			executablePath: process.execPath
		});

		/*
		 * The chrome runs in its own partition, deliberately not the account's.
		 *
		 * It shares no cookies with Steam, and because its partition is not one
		 * `isAccountBrowserContents` knows about, it keeps the application-wide
		 * navigation lock the tabs are exempt from. The chrome never navigates; if
		 * it ever tried, it would be stopped.
		 */
		const chrome = window.webContents;
		/*
		 * **The toolbar's own session, hardened like the tabs'.**
		 *
		 * It is a separate partition, so the `denyAllPermissions` applied to the
		 * account's session does not reach it — and a smoke check measuring the
		 * live sessions is what showed that: DevTools was correctly off on both
		 * views while the spellchecker was still enabled on this one. Its partition
		 * had simply never been through the hardening the others get.
		 */
		denyAllPermissions(chrome.session);

		/*
		 * **Closed windows still receive events.**
		 *
		 * When the landing check refuses a page, `openAccountBrowser` closes this
		 * window — and the tab's own loading events keep arriving afterwards.
		 * `publish` guarded the contents but not the window, so the next one
		 * reached `setTitle` on a destroyed native window and took the main process
		 * down with "Object has been destroyed", in front of the user, on the
		 * screen that was telling them to sign in.
		 *
		 * `isDestroyed()` alone is not enough: there is a window between `close()`
		 * and destruction where it still answers false. The flag closes that.
		 */
		let gone = false;
		window.on('closed', () => {
			gone = true;
		});
		const alive = (): boolean => !gone && !window.isDestroyed();

		/** Set once `openAccountBrowser` subscribes; called as the active tab moves. */
		let navigated: () => void = () => undefined;
		/**
		 * Set once `openAccountBrowser` subscribes; called with the tab that actually
		 * committed a navigation, whether or not that tab is active.
		 */
		let tabNavigated: (url: string) => boolean = () => true;
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
		let lastFocusedSurface: 'page' | 'toolbar' = 'page';
		let restorePageOnWindowFocus = true;
		let windowOpenPolicy: (details: { url: string }) => { action: 'allow' | 'deny' } = () => ({
			action: 'allow'
		});

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
			if (!alive() || chrome.isDestroyed()) {
				return;
			}
			const active = living(activeId);
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
			chrome.send('browser-chrome:state', {
				url,
				canGoBack: active ? active.webContents.navigationHistory.canGoBack() : false,
				canGoForward: active ? active.webContents.navigationHistory.canGoForward() : false,
				loading: active ? active.webContents.isLoading() : false,
				offSteam: url !== '' && !isSteamHost(url),
				// So the strip can disable `+` rather than let it do nothing, which is
				// the one answer a button must never give.
				atTabLimit: tabs.size >= MAX_TABS,
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

		/**
		 * A tab whose contents are still alive, or nothing.
		 *
		 * **`tabs` can hold a corpse.** A popup that closes itself — which is what
		 * an authentication or payment callback does the moment it is finished —
		 * destroys its `WebContents` without going anywhere near `closeTab`. The
		 * entry stayed, the strip drew a tab for it, and selecting that tab reached
		 * `focus()` on undefined and took the main process down.
		 *
		 * **A second line, not the fix.** The `destroyed` listener retires the entry
		 * and is what actually closes that hole; removing this check alone changes
		 * nothing observable, because by the time anything selects a tab the entry
		 * is already gone. It covers the gap between the contents dying and the
		 * event arriving, which is real but not reachable from a test — so it is
		 * here on the argument, not on the evidence.
		 */
		const living = (id: number): WebContentsView | undefined => {
			const view = tabs.get(id);
			return view && !view.webContents.isDestroyed() ? view : undefined;
		};

		// BrowserWindow gives its owned toolbar contents focus whenever Windows
		// reactivates it. Remember what the user had focused before deactivation and
		// restore the page only when the page was that surface; an address bar the
		// user deliberately left focused must remain focused.
		chrome.on('focus', () => {
			lastFocusedSurface = 'toolbar';
		});
		window.on('blur', () => {
			restorePageOnWindowFocus = lastFocusedSurface === 'page';
		});
		window.on('focus', () => {
			if (restorePageOnWindowFocus) {
				living(activeId)?.webContents.focus();
			}
		});

		const show = (id: number): void => {
			const chosen = living(id);
			if (!chosen || !alive()) {
				return;
			}
			/*
			 * Validate the tab while it is still hidden.
			 *
			 * Its committed navigation normally reported this URL already, but a
			 * selection can race the event delivery and an adopted popup can already
			 * carry a document. The lifetime login-page guard must get the last word
			 * before either visibility or focus. A forbidden URL is rejected immediately
			 * while its callback starts closing the whole window; the native-object check
			 * is a second guard for a close that has already settled.
			 */
			const accepted = tabNavigated(shown(chosen));
			if (!accepted || !alive() || chosen.webContents.isDestroyed()) {
				return;
			}
			activeId = id;
			for (const [at, view] of tabs) {
				if (!view.webContents.isDestroyed()) {
					view.setVisible(at === id);
				}
			}
			chosen.setBounds(bodyBounds());
			chosen.webContents.focus();
			publish();
		};

		/**
		 * How a page asked for the window it did not get.
		 *
		 * Carried so the tab that replaces it makes the *same request*. See the
		 * window-open handler.
		 */
		/**
		 * Build a tab and register it, without deciding what goes in it.
		 *
		 * Split out because there are now two ways a tab is filled: this process
		 * loads a URL into it, or **Chromium navigates it itself** for a popup. The
		 * second is the reason the split exists — see the window-open handler.
		 */
		const newTab = (
			/**
			 * Electron's own preferences for a pending popup navigation.
			 *
			 * **Not optional decoration.** When `createWindow` supplies the contents
			 * for a `window.open`, Electron passes preferences carrying an internal
			 * handle for the navigation it is about to perform, and rejects any
			 * `WebContents` not built from them — "Created window should be connected
			 * to webContents passed with options object". A view made ahead of time
			 * and handed back is refused, once per popup, as an uncaught error.
			 *
			 * **It has already been created.** Electron builds the contents for a
			 * pending `window.open`, hands them to `createWindow` as
			 * `options.webContents`, and refuses anything else that comes back —
			 * "Created window should be connected to webContents passed with options
			 * object", once per popup. Two earlier attempts here missed that and
			 * built a fresh view: spreading the preferences, then mutating them.
			 * Both produced a `WebContents` that was simply not the one Electron was
			 * waiting for.
			 *
			 * `WebContentsView` adopts an existing one, which is what makes this
			 * work: Chromium keeps the navigation, with its initiator and its cookie
			 * rules, and the contents land in our strip hardened by the preferences
			 * Chromium inherited from the opener — itself one of these tabs.
			 */
			adopt?: WebContents
		): { id: number; view: WebContentsView } | undefined => {
			// The ceiling, checked before anything is built. See `MAX_TABS`.
			if (tabs.size >= MAX_TABS) {
				return undefined;
			}
			const view = adopt
				? new WebContentsView({ webContents: adopt })
				: new WebContentsView({
						webPreferences: {
							...HARDENED,
							partition: options.partition
						}
					});
			const id = nextId++;
			tabs.set(id, view);

			// The same two things every tab gets, in the same order, because a
			// tab that missed one would be a hole shaped exactly like a new tab.
			//
			// The user agent is deliberately absent. The running Chromium owns its
			// HTTP and JavaScript-visible identity; replacing it produces the modified
			// browser profile challenge systems warn about, even though this window is
			// not automated.
			view.webContents.setWebRTCIPHandlingPolicy(webRtcPolicy);
			view.webContents.setWindowOpenHandler((details) => {
				/*
				 * **Chromium performs the navigation; we only supply the tab.**
				 *
				 * This used to deny the popup and re-issue the request from the main
				 * process with `loadURL`, carrying the method, body, content type and
				 * boundary across by hand. Every one of those was right, and the
				 * request was still not the one the page had made: a `loadURL` is a
				 * fresh top-level navigation with no initiator, so Chromium attached
				 * `SameSite=Strict` and `Lax` cookies it withholds from a real
				 * cross-site form post, and sent `Origin: null` with
				 * `Sec-Fetch-Site: none`.
				 *
				 * That is a security boundary, not a fidelity detail. A page opened in
				 * this window — which is signed in to somebody's Steam account — could
				 * cross-site POST anywhere with cookies the browser exists to withhold.
				 * Reconstructing a request faithfully enough to be dangerous and not
				 * faithfully enough to be honest is the worst of both.
				 *
				 * `createWindow` hands Chromium a `WebContents` of our making and lets
				 * it do the navigation. The initiator, the cookies, `Origin` and every
				 * `Sec-Fetch-*` header are then the browser's own — correct by
				 * construction rather than by transcription — and the tab is still
				 * ours: hardened identically, in this window, listed in the same
				 * strip, with no chromeless popup anywhere.
				 *
				 * `details.url` is still checked first. Chromium refuses `file:` and
				 * `data:` from web content on its own; this refuses them a step
				 * earlier, and is the same gate the address bar uses.
				 */
				if (
					windowOpenPolicy({ url: details.url }).action !== 'allow' ||
					addressToUrl(details.url) === undefined
				) {
					return { action: 'deny' };
				}
				// The ceiling is decided here, because `createWindow` below has no way
				// to decline: a page in a loop gets nothing rather than a process.
				if (tabs.size >= MAX_TABS) {
					return { action: 'deny' };
				}
				return {
					action: 'allow',
					// A tab does not vanish because the tab that opened it was closed.
					// That is popup behaviour, and these are tabs.
					outlivesOpener: true,
					createWindow: (opened) => {
						/*
						 * `webContents` is on the options object Electron passes and is
						 * not in the public typings, so it is read rather than declared.
						 * Returning anything else is refused outright — see `newTab`.
						 */
						const pending = (opened as { webContents?: WebContents }).webContents;
						const built = newTab(pending);
						if (!built || !pending) {
							// Unreachable given the ceiling check above, and `createWindow`
							// cannot refuse — so this is the honest failure rather than a
							// silent one.
							throw new Error('the browser window could not take another tab');
						}
						show(built.id);
						return pending;
					}
				};
			});

			/*
			 * **Only ever the proxy.**
			 *
			 * `authInfo.isProxy` separates "the proxy wants its password" from "this
			 * website wants a password", and the two must never be confused: a site
			 * that returns 401 would otherwise be handed the proxy operator's
			 * credentials by a browser the user is signed in to Steam on. Anything
			 * that is not the proxy is left alone, so Electron's default applies and
			 * the challenge is cancelled — a page needing site credentials is the
			 * user's business, not this window's.
			 *
			 * The same rule and the same shape as `transport.ts`, deliberately: two
			 * places answer proxy challenges in this application and they should not
			 * be able to drift apart.
			 */
			view.webContents.on('login', (event, _request, authInfo, callback) => {
				if (!authInfo.isProxy || proxyCredentials === undefined) {
					return;
				}
				event.preventDefault();
				callback(proxyCredentials.username, proxyCredentials.password);
			});

			/*
			 * **The page can end this tab, and nothing was listening.**
			 *
			 * `window.close()` on a popup is ordinary — an authentication or payment
			 * callback does it the moment it is done — and now that Chromium performs
			 * those navigations for real, it reaches us. The contents were destroyed
			 * and the entry stayed: the strip drew a tab backed by nothing, selecting
			 * it crashed the main process, and a page could open and close children
			 * until the ceiling was full of corpses and no real tab could be made.
			 *
			 * Retiring by identity, not by id: `closeTab` may already have removed
			 * this entry and put another there, and taking that one out would close a
			 * tab the user is looking at. Idempotent for the same reason — this fires
			 * for the app's own closes too.
			 */
			view.webContents.once('destroyed', () => {
				if (tabs.get(id) !== view) {
					return;
				}
				retire(id, view);
			});

			// Listed rather than looped: TypeScript types each of these separately,
			// and a loop over the names loses the overload that checks the listener.
			/*
			 * Security follows the tab that moved; chrome follows the active tab.
			 *
			 * Sending every event through `publish` lost that distinction because
			 * `publish` deliberately reads `activeId`. A background tab could therefore
			 * commit a Steam login page without the whole-window guard ever seeing it.
			 */
			const reportCommittedNavigation = (): void => {
				if (!alive() || view.webContents.isDestroyed()) {
					return;
				}
				if (!tabNavigated(shown(view))) {
					return;
				}
				// The security callback may have closed the window and every view.
				if (!alive() || chrome.isDestroyed()) {
					return;
				}
				publish();
			};
			view.webContents.on('did-navigate', reportCommittedNavigation);
			view.webContents.on('did-navigate-in-page', reportCommittedNavigation);
			view.webContents.on('did-start-loading', publish);
			view.webContents.on('did-stop-loading', publish);
			view.webContents.on('page-title-updated', publish);
			view.webContents.on('focus', () => {
				lastFocusedSurface = 'page';
			});

			// Matches the chrome, so a blank tab does not flash white in a dark
			// window before anything loads.
			view.setBackgroundColor('#101216');
			window.contentView.addChildView(view);
			view.setBounds(bodyBounds());
			return { id, view };
		};

		/**
		 * @param navigate whether to start a navigation at all.
		 *
		 * **`false` exists because firing one here breaks the caller's promise.**
		 * Electron's `loadURL` resolves on the contents' next `did-finish-load`,
		 * and it does not care which navigation produced it. So a caller that
		 * created the tab here and then issued its own `loadURL` had its promise
		 * resolved by *this* function's `about:blank` — measured at ~40ms, against
		 * a real page that had not begun to arrive.
		 *
		 * That is not a cosmetic race. `openAccountBrowser` awaits its load and
		 * then reads `currentUrl()` to decide whether Steam accepted the session;
		 * it read `about:blank`, which `looksSignedOut` correctly calls signed
		 * out, so **every** attempt to open the in-app browser was refused with
		 * "Steam did not accept the saved session" after wiping the partition.
		 */
		const openTab = (url?: string, navigate = true): number | undefined => {
			const opened = newTab();
			if (!opened) {
				return undefined;
			}
			if (navigate) {
				// `about:blank` rather than nothing at all: a view with no document
				// reports no title and no URL, which the strip and the address bar
				// both read as an empty tab — which is exactly what it is.
				void opened.view.webContents.loadURL(url ?? 'about:blank').catch(publish);
			}
			show(opened.id);
			return opened.id;
		};

		/**
		 * Take one tab out of the strip and settle what the window shows next.
		 *
		 * Shared by `closeTab` and by the `destroyed` listener, because a tab
		 * ending is one thing whether the user closed it or the page did — and two
		 * copies of "pick a neighbour, or close the window" is how the two paths
		 * would drift apart.
		 */
		const retire = (id: number, view: WebContentsView): void => {
			if (!alive()) {
				return;
			}
			const order = [...tabs.keys()];
			tabs.delete(id);
			window.contentView.removeChildView(view);

			if (tabs.size === 0) {
				// The last tab going takes the window with it, as it does everywhere
				// else — including when the page itself was the one to end it.
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

		const closeTab = (id: number): void => {
			const view = tabs.get(id);
			if (!view || !alive()) {
				return;
			}
			if (!view.webContents.isDestroyed()) {
				// Fires `destroyed`, which finds the entry already gone and does
				// nothing — the two paths meet here rather than racing.
				view.webContents.close();
			}
			retire(id, view);
		};

		/*
		 * WebRTC is decided before the first tab exists, so every tab is opened
		 * with it rather than having it applied afterwards. A tab that ran even
		 * briefly with the default policy could have answered a peer connection
		 * and given away the address the proxy exists to hide.
		 */
		let webRtcPolicy: 'disable_non_proxied_udp' | 'default' = 'default';

		/**
		 * The proxy's credentials, kept for the same reason `webRtcPolicy` is: a
		 * tab has to be born with it rather than have it applied afterwards.
		 */
		let proxyCredentials: { username: string; password: string } | undefined;

		const layout = (): void => {
			if (!alive()) {
				return;
			}
			const active = tabs.get(activeId);
			if (active) {
				active.setBounds(bodyBounds());
			}
		};
		layout();
		// BrowserWindow resizes its owned toolbar. The child site view still needs an
		// explicit content-region bound when the shell is resized or maximised.
		window.on('resize', layout);
		window.on('enter-full-screen', layout);
		window.on('leave-full-screen', layout);

		void chrome.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(CHROME_HTML));

		/*
		 * The chrome's verbs, and nothing else.
		 *
		 * Scoped by comparing the sender: `ipcMain.on` is process-wide and every
		 * browser window has chrome, so without the check one window's toolbar
		 * would steer all of them — including one signed in as another account.
		 */
		const mine = (event: IpcMainEvent): boolean => event.sender === chrome;
		// A dead tab answers nothing: every verb below would otherwise reach into
		// destroyed contents the moment a popup closed itself.
		const active = (): WebContentsView | undefined => living(activeId);

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
				if (!chrome.isDestroyed()) {
					chrome.send('browser-chrome:focus-address');
					chrome.focus();
				}
			}
		};
		const onSelectTab = (event: IpcMainEvent, id: unknown, keepChromeFocus: unknown): void => {
			if (!mine(event) || typeof id !== 'number') return;
			show(id);
			// ARIA tab activation by Enter/Space keeps keyboard focus in the
			// tablist. Pointer selection omits this flag and keeps the ordinary
			// browser behavior: the selected page receives focus.
			if (keepChromeFocus === true && alive() && !chrome.isDestroyed()) {
				chrome.focus();
			}
		};
		const onCloseTab = (event: IpcMainEvent, id: unknown, keepChromeFocus: unknown): void => {
			if (!mine(event) || typeof id !== 'number') return;
			closeTab(id);
			/*
			 * Keep a keyboard close in the keyboard surface that issued it.
			 *
			 * Closing the active tab calls `show` for its neighbour, and `show`
			 * correctly focuses that page for every pointer-driven selection. For
			 * Delete (or the tab's keyboard close control), however, that transfers
			 * native focus out of the chrome WebContents before `drawTabs` can put
			 * DOM focus on the neighbouring tab. A DOM element can be focused inside
			 * a background WebContents without Chromium sending it the next key.
			 * Return native focus only for this chrome-originated close; selecting a
			 * tab still focuses the page as normal. The last tab may already have
			 * closed the whole window, so both native objects are checked first.
			 */
			if (keepChromeFocus === true && alive() && !chrome.isDestroyed()) {
				chrome.focus();
			}
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

			/*
			 * **A top-level window does not take added child views with it.**
			 *
			 * A `BrowserWindow` destroys the toolbar `WebContents` it owns, but an
			 * added `WebContentsView` can outlive the window. Measured in a real
			 * Electron 43 run rather than reasoned about: after closing the old shell,
			 * `window.isDestroyed()` was true, the tab's
			 * `webContents.isDestroyed()` was false, and script in it still ran.
			 *
			 * So the close handler that removed the IPC listeners was tidying the
			 * small half of the leak. The large half is a live renderer, still
			 * holding the account's partition, that:
			 *
			 *  - keeps a signed-in Steam session running with no window to show it,
			 *  - is not reachable by anything — `AccountBrowsers` has already
			 *    forgotten the account, so the next vault lock cannot find it to
			 *    wipe the partition it is using,
			 *  - and accumulates, one native `WebContents` per open/close cycle,
			 *    for as long as the process runs.
			 *
			 * The toolbar is now the `BrowserWindow`'s owned contents and is destroyed
			 * by Electron; closing it here as if it were a child would race ownership.
			 */
			for (const view of tabs.values()) {
				if (!view.webContents.isDestroyed()) {
					view.webContents.close();
				}
			}
			tabs.clear();
		});

		return {
			// The first tab. Everything after it is opened by the strip or by a page.
			loadURL: (url) => {
				if (!alive()) {
					return Promise.reject(new Error('the browser window has already closed'));
				}
				// **Created without navigating**, so the `loadURL` below is the only
				// navigation on these contents and the promise returned describes it.
				// Creating the tab with its usual `about:blank` meant this method
				// resolved on that instead, handing the caller a window whose page had
				// not loaded.
				const id = tabs.size === 0 ? openTab(undefined, false) : activeId;
				const view = id === undefined ? undefined : tabs.get(id);
				if (!view) {
					return Promise.reject(new Error('the browser window has no tab to load into'));
				}
				return view.webContents.loadURL(url).then(() => view.webContents.getURL());
			},
			// The contents' URL, not the one requested: after Steam's redirects
			// these differ, and the difference is the only way to tell a signed-in
			// landing from a login page.
			currentUrl: () => active()?.webContents.getURL() ?? '',
			focus: () => {
				if (!alive()) {
					return;
				}
				// `focus()` alone does nothing to a minimised window.
				if (window.isMinimized()) {
					window.restore();
				}
				window.focus();
			},
			show: () => {
				if (alive()) {
					// The window-level focus handler restores whichever page/toolbar surface
					// the user last held after this activates the native shell.
					revealAccountBrowserWindow(window, process.platform);
				}
			},
			// Guarded like the rest: the lock sweep and the landing check both close
			// this window while pages are still settling, and a title set afterwards
			// is not worth a crash.
			setTitle: (title) => {
				if (alive()) {
					window.setTitle(title);
				}
			},
			setProxyCredentials: (credentials) => {
				proxyCredentials = credentials;
			},
			setWebRtcPolicy: (policy) => {
				// Kept, so tabs opened later start with it rather than having it
				// applied after their first request.
				webRtcPolicy = policy;
				for (const view of tabs.values()) {
					if (!view.webContents.isDestroyed()) {
						view.webContents.setWebRTCIPHandlingPolicy(policy);
					}
				}
			},
			// `close()` on a destroyed window throws, and the lock sweep calls this
			// on every window it knows about — including one the user just closed.
			close: () => {
				if (alive()) {
					window.close();
				}
			},
			isDestroyed: () => window.isDestroyed(),
			on: (event, listener) => {
				if (event === 'closed') {
					window.on('closed', listener as () => void);
					return;
				}
				if (event === 'tab-navigated') {
					tabNavigated = listener as (url: string) => boolean;
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
			setWindowOpenHandler: (handler) => {
				/*
				 * The caller may refuse a popup, but may never replace the machinery
				 * that keeps an accepted one inside this tab strip.
				 *
				 * Every tab already has a handler that turns a page's `window.open`
				 * into another tab in this window — hardened identically and listed in
				 * the same strip. Letting a caller replace that would let a page's
				 * request escape into a window with no address bar and no tab strip.
				 */
				windowOpenPolicy = handler;
			}
		};
	}
};
