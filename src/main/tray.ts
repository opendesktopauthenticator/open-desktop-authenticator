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
 * The tray mark, drawn in code rather than shipped as a binary.
 *
 * **The shape is the countdown ring**, which is the one element the interface is
 * built around: a Steam Guard code is a secret with a thirty-second life, and
 * the account list renders that as a ring draining beneath the code. The tray
 * icon is that ring with a quarter gone — the same idea at 32 pixels, so the
 * thing in the system tray and the thing on screen are recognisably one product.
 *
 * Mint (`#42f29a`) is MASTERPANEL LLC's accent, and it holds up against both a
 * light and a dark taskbar, which a mid-grey does not.
 *
 * It is drawn here instead of committed as a PNG so that nothing in this
 * repository is a binary blob a reader has to take on trust — the same argument
 * the rest of the project makes about its build. Supersampled 4×4 per pixel,
 * because an aliased ring at this size reads as a smudge.
 *
 * **Installer and window icons are still outstanding**: those need a real `.ico`
 * and multi-resolution PNGs in `build/`, which is a packaging task (§10.2).
 */
function trayIcon(): NativeImage {
	// Drawn at 2× and tagged as such, so it stays crisp on a HiDPI taskbar and
	// Electron downsamples for standard DPI rather than the reverse.
	const size = 32;
	const channels = 4;
	const samples = 4;
	const pixels = Buffer.alloc(size * size * channels);

	const centre = (size - 1) / 2;
	const outer = size / 2 - 2.5;
	const inner = outer - size / 8;

	// Mint, as BGRA — the byte order `createFromBuffer` expects.
	const [b, g, r] = [0x9a, 0xf2, 0x42];

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let covered = 0;

			for (let sy = 0; sy < samples; sy++) {
				for (let sx = 0; sx < samples; sx++) {
					const px = x + (sx + 0.5) / samples - 0.5;
					const py = y + (sy + 0.5) / samples - 0.5;
					const dx = px - centre;
					const dy = py - centre;
					const distance = Math.hypot(dx, dy);

					if (distance > outer || distance < inner) {
						continue;
					}

					// The gap: a quarter of the ring removed, starting at twelve
					// o'clock and running clockwise. `atan2` puts 0 at three o'clock,
					// so this rotates a quarter turn back to the top.
					const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
					if (angle < Math.PI / 2) {
						continue;
					}

					covered += 1;
				}
			}

			const offset = (y * size + x) * channels;
			pixels[offset] = b;
			pixels[offset + 1] = g;
			pixels[offset + 2] = r;
			pixels[offset + 3] = Math.round((covered / (samples * samples)) * 255);
		}
	}

	return nativeImage.createFromBuffer(pixels, {
		width: size,
		height: size,
		scaleFactor: 2
	});
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
