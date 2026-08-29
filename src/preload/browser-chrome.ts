import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge for the in-app browser's toolbar, and nothing else.
 *
 * **Deliberately not `preload/index.ts`.** That one exposes the vault, the
 * accounts, the codes and the confirmations to the application's own renderer.
 * This one faces a strip of buttons above a page nobody here wrote, and it can
 * do a handful of things to one window: move through history, reload, navigate,
 * and open, select or close a tab.
 *
 * It cannot read the page. The toolbar and the page are separate `WebContents`
 * with separate origins — the toolbar has this bridge and no access to the
 * site, the page has the site and no bridge at all. That separation is the
 * whole reason the browser is built from two views rather than one window with
 * something injected into it: a chrome bar drawn inside the page would be a
 * chrome bar the page could read, move and forge.
 *
 * Channel names are prefixed and fixed here. The toolbar cannot name a channel
 * of its own, so nothing that reaches it can reach the rest of the IPC table.
 */

/** One tab, as the strip needs to draw it. */
export interface ChromeTab {
	id: number;
	/** The page's own title. A page chooses this, so it is a label, not evidence. */
	title: string;
	url: string;
	active: boolean;
	/** True when this tab's host is not one of Valve's. */
	offSteam: boolean;
}

/** What the chrome needs to draw itself. Pushed by the main process. */
export interface ChromeState {
	url: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
	/** True when the active tab's host is not one of Valve's. */
	offSteam: boolean;
	tabs: ChromeTab[];
}

/**
 * The global this bridge is exposed as.
 *
 * **Not `chrome`.** Chromium already defines `window.chrome` in every renderer,
 * and `exposeInMainWorld` refuses to bind over an existing property — it throws
 * "Cannot bind an API on top of an existing property on the window object". A
 * preload that throws fails silently as far as the page is concerned: the
 * toolbar rendered, and every button on it did nothing, because the object it
 * was calling into was Chromium's and had none of these methods.
 *
 * Named here rather than written inline so the name is a thing that can be
 * checked, and `tests/browser-bridge.test.ts` checks it against the globals a
 * renderer already has.
 */
export const BRIDGE = 'odaBrowser';

contextBridge.exposeInMainWorld(BRIDGE, {
	back: () => ipcRenderer.send('browser-chrome:back'),
	forward: () => ipcRenderer.send('browser-chrome:forward'),
	reload: () => ipcRenderer.send('browser-chrome:reload'),
	/** The address the user typed. The main process decides what it means. */
	go: (address: string) => ipcRenderer.send('browser-chrome:go', address),
	newTab: () => ipcRenderer.send('browser-chrome:new-tab'),
	/** Ids come from the state the main process pushed; the chrome invents none. */
	selectTab: (id: number) => ipcRenderer.send('browser-chrome:select-tab', id),
	closeTab: (id: number) => ipcRenderer.send('browser-chrome:close-tab', id),
	onState: (listener: (state: ChromeState) => void) => {
		ipcRenderer.on('browser-chrome:state', (_event, state: ChromeState) => listener(state));
	},
	/** A new empty tab was opened; the cursor belongs in the address field. */
	onFocusAddress: (listener: () => void) => {
		ipcRenderer.on('browser-chrome:focus-address', () => listener());
	}
});
