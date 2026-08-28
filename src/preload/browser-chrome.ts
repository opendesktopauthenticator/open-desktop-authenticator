import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge for the in-app browser's toolbar, and nothing else.
 *
 * **Deliberately not `preload/index.ts`.** That one exposes the vault, the
 * accounts, the codes and the confirmations to the application's own renderer.
 * This one faces a strip of buttons above a page nobody here wrote, and it can
 * do four things to one window: go back, go forward, reload, and navigate.
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

/** What the toolbar needs to draw itself. Pushed by the main process. */
export interface ChromeState {
	url: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
	/** True when the host is not one of Valve's. */
	offSteam: boolean;
}

contextBridge.exposeInMainWorld('chrome', {
	back: () => ipcRenderer.send('browser-chrome:back'),
	forward: () => ipcRenderer.send('browser-chrome:forward'),
	reload: () => ipcRenderer.send('browser-chrome:reload'),
	/** The address the user typed. The main process decides what it means. */
	go: (address: string) => ipcRenderer.send('browser-chrome:go', address),
	onState: (listener: (state: ChromeState) => void) => {
		ipcRenderer.on('browser-chrome:state', (_event, state: ChromeState) => listener(state));
	}
});
