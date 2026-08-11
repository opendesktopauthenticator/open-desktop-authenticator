import { Menu, Tray, type NativeImage } from 'electron';
import { trayImage } from './logo-image';
import { branding } from '../shared/branding';

/**
 * The tray icon (§12, milestone 0.1).
 *
 * An authenticator is only useful while it is running, and a window is the first
 * thing people close. The tray is what lets the app keep generating codes and
 * answering confirmations after that — so closing the window hides it rather
 * than quitting, and the tray is the only thing that says so.
 *
 * Two rules it must not break:
 *
 *  - **Hiding is not unlocking.** The vault's idle timer keeps running while the
 *    window is hidden, and locking still reloads the renderer. A hidden window
 *    is not a reason to stay unlocked, and nothing here touches that.
 *  - **Quit must be reachable and unambiguous.** An app that traps itself in the
 *    tray with no way out is one people kill from Task Manager, which skips
 *    every shutdown path — including clearing a copied code off the clipboard.
 */

export interface TrayHost {
	/** Bring the window back and focus it. */
	show(): void;
	/** Hide to tray without quitting. */
	hide(): void;
	/** Whether the window is currently visible. */
	isVisible(): boolean;
	/** Lock the vault now. */
	lock(): void;
	/** Whether the vault is currently unlocked, for the menu label. */
	isUnlocked(): boolean;
	/** Really quit, running the normal shutdown path. */
	quit(): void;
}

/**
 * The tray mark.
 *
 * The same shield the taskbar, the installer and the window all use — drawn from
 * `shared/logo.ts` at runtime rather than loaded from a file, so the tray stays
 * what it has always been here: code, not a binary blob a reader has to take on
 * trust. See that module for why the mark is a shield you can see through.
 *
 * **This used to be a different drawing.** The tray showed the countdown ring
 * from the account list, on the reasoning that it tied the tray to the interface.
 * It tied it to the wrong thing: the tray icon sits beside the taskbar button and
 * the shortcut, and a ring next to a shield reads as two applications rather than
 * one. The product now has a mark, and this is it.
 *
 * **Two representations, not one buffer tagged `scaleFactor: 2`.** Supplying only
 * a 32px image declared as 2x leaves a standard-DPI tray downsampling art it was
 * never given at its own size, and the aperture is exactly the detail that loses.
 * A real 16px representation is what Windows asks for, and the 16px rendering is
 * what the aperture's radius was chosen against.
 */
const trayIcon = (): NativeImage => trayImage();

export function createTray(host: TrayHost): Tray {
	const tray = new Tray(trayIcon());
	tray.setToolTip(branding.productName);

	const render = (): void => {
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{
					label: host.isVisible() ? `Hide ${branding.shortName}` : `Show ${branding.shortName}`,
					click: () => {
						if (host.isVisible()) {
							host.hide();
						} else {
							host.show();
						}
						render();
					}
				},
				{ type: 'separator' },
				{
					label: 'Lock now',
					// Greyed rather than hidden: a control that appears and disappears
					// makes people hunt for it, and "already locked" is worth seeing.
					enabled: host.isUnlocked(),
					click: () => {
						host.lock();
						render();
					}
				},
				{ type: 'separator' },
				{
					// Spelled out. "Close" hides; this is the one that ends the process,
					// and the difference has to be obvious from the menu alone.
					label: `Quit ${branding.shortName}`,
					click: () => host.quit()
				}
			])
		);
	};

	render();
	// Clicking the icon is the fastest path back to the window, which is what
	// most people will try first.
	tray.on('click', () => {
		host.show();
		render();
	});

	return tray;
}
