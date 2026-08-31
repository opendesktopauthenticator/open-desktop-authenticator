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
 * Three rules it must not break:
 *
 *  - **Hiding is not unlocking.** The vault's idle timer keeps running while the
 *    window is hidden, and locking still reloads the renderer. A hidden window
 *    is not a reason to stay unlocked, and nothing here touches that.
 *  - **Quit must be reachable and unambiguous.** An app that traps itself in the
 *    tray with no way out is one people kill from Task Manager, which skips
 *    every shutdown path — including clearing a copied code off the clipboard.
 *  - **The menu must never lie about the state it describes.** Every label and
 *    every greyed-out item here is a claim about something that changes without
 *    the tray being told: the window is hidden by its own close button, and the
 *    vault is unlocked and re-locked from the renderer.
 *
 * ## What "build the menu once, at startup" actually did
 *
 * Two reproduced faults, one cause. The menu was built while the window was
 * visible, so its first item read "Hide ODA"; closing the window hid it without
 * rebuilding anything, and the item still labelled "Hide ODA" then *showed* the
 * window — a control performing the opposite of its own label. Note which half
 * was wrong: the click handler re-read `isVisible()` and did the right thing, so
 * only the label lied, which is exactly the sort of fault nobody files a bug
 * about and everybody stops trusting.
 *
 * The worse one: "Lock now" is built disabled while the vault is locked, which
 * is the state the app starts in. Unlocking happens in the renderer and never
 * reached this file, so the item stayed greyed for the whole session unless some
 * unrelated tray action happened to rebuild the menu. The one control whose
 * entire purpose is locking an unlocked vault in a hurry was dead in precisely
 * the case it exists for.
 *
 * The fix is not more places that remember to rebuild — that is the same bug
 * with a longer list of exceptions, and the next state to arrive is the one
 * nobody adds a call for. The menu is built from the host's state at the moment
 * it is asked for, and nothing here holds on to one.
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

	/*
	 * Whether this platform will let the tray be handed a menu at the instant of
	 * the click.
	 *
	 * Windows and macOS will: `right-click` fires and `popUpContextMenu(menu)`
	 * shows whatever it is given, so the menu can be built from live state and
	 * thrown away again. Linux will not — Electron documents both that event and
	 * `popUpContextMenu` as `darwin,win32` — so there the assigned menu is the
	 * only menu a user can ever open, and reassigning a fresh one after every
	 * signal this file does receive is as close as that platform gets.
	 *
	 * Decided once, here, because the two halves of it have to agree: a platform
	 * that both keeps a menu and pops one up shows the stale copy with the fresh
	 * one opening underneath it, and a platform that does neither shows nothing.
	 */
	const buildsOnDemand = process.platform === 'darwin' || process.platform === 'win32';

	/**
	 * The menu as it should read *right now*.
	 *
	 * Every label and every `enabled` below is a question put to the host as the
	 * menu is being built. Nothing caches the answers, and nothing caches the
	 * menu: what this returns is a snapshot of one moment, and the only moment
	 * worth showing is the one the user is opening it in.
	 */
	const menu = (): Menu =>
		Menu.buildFromTemplate([
			{
				label: host.isVisible() ? `Hide ${branding.shortName}` : `Show ${branding.shortName}`,
				click: () => {
					if (host.isVisible()) {
						host.hide();
					} else {
						host.show();
					}
					reassign();
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
					reassign();
				}
			},
			{ type: 'separator' },
			{
				// Spelled out. "Close" hides; this is the one that ends the process,
				// and the difference has to be obvious from the menu alone.
				label: `Quit ${branding.shortName}`,
				click: () => host.quit()
			}
		]);

	/**
	 * Hand the icon a menu to keep, on the platform that has no other option.
	 *
	 * A no-op on Windows and macOS, and deliberately so: an assigned menu is the
	 * one Windows pops up by itself on right-click, before this file gets a say,
	 * so keeping one there would put the stale copy back on screen — the exact
	 * behaviour this module exists to stop — and open the freshly built menu
	 * underneath it.
	 */
	const reassign = (): void => {
		if (!buildsOnDemand) {
			tray.setContextMenu(menu());
		}
	};

	if (buildsOnDemand) {
		tray.on('right-click', () => tray.popUpContextMenu(menu()));
	} else {
		reassign();
	}

	// Clicking the icon is the fastest path back to the window, which is what
	// most people will try first. The reassign matters on Linux alone, where the
	// window having just become visible changes what the first menu item should
	// say and this is the one moment the tray hears about it.
	tray.on('click', () => {
		host.show();
		reassign();
	});

	return tray;
}
