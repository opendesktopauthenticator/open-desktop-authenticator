import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
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
 * The icon, generated rather than shipped as a binary.
 *
 * A placeholder, and deliberately a legible one: a filled rounded square in a
 * neutral grey, which reads on both light and dark trays. It is drawn here
 * instead of committed as a PNG so that nothing in this repository is a binary
 * blob a reader has to take on trust — which is the same argument the rest of
 * the project makes about its build.
 *
 * **A designed icon is a founder task before release.** This one is honest about
 * being a placeholder rather than pretending to be branding.
 */
function trayIcon(): NativeImage {
	const size = 16;
	const channels = 4;
	const pixels = Buffer.alloc(size * size * channels);

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const offset = (y * size + x) * channels;
			// A rounded square: inset by two, with the corners knocked off.
			const inset = x >= 2 && x <= 13 && y >= 2 && y <= 13;
			const corner =
				(x <= 3 && y <= 3) || (x >= 12 && y <= 3) || (x <= 3 && y >= 12) || (x >= 12 && y >= 12);
			const on = inset && !corner;

			// BGRA is what `createFromBuffer` expects.
			pixels[offset] = 0x9a;
			pixels[offset + 1] = 0x9a;
			pixels[offset + 2] = 0x9a;
			pixels[offset + 3] = on ? 0xff : 0x00;
		}
	}

	return nativeImage.createFromBuffer(pixels, { width: size, height: size });
}

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
