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
	/**
	 * Register to be told when the answers above change.
	 *
	 * Optional, and the beat below is the reason it can be: a signal somebody has
	 * to remember to send is a signal somebody forgets, so the poll stays as the
	 * backstop and this only closes the gap it leaves. Unused where the menu is
	 * built at the instant of the click, which is every platform but Linux.
	 */
	watch?(listener: () => void): void;
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

/**
 * How often Linux re-reads the state its kept menu describes.
 *
 * A quarter second rather than one, because the gap is the whole of what is
 * wrong on that platform: for its length the menu can offer to lock a vault that
 * is already locked, and the label can disagree with the window. Four boolean
 * reads a second is not a cost — the menu is only rebuilt when one of them has
 * actually moved, which is a handful of times in a session.
 */
const TRAY_BEAT_MS = 250;

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

	/** What the menu Linux is currently holding was built from. See the beat below. */
	let shown = { visible: false, unlocked: false };

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
			(() => {
				/*
				 * **The item does what its label says, not what the live state implies.**
				 *
				 * The handler used to re-read `isVisible()` and toggle. On Windows and
				 * macOS the menu is built at the instant of the click, so the two always
				 * agreed. On Linux the assigned menu can be up to one beat old — and a
				 * stale "Hide" clicked on a window that had already been closed then
				 * *showed* it. The label was wrong for a moment; the action turned that
				 * into the opposite of what the user asked for.
				 *
				 * Deciding once, here, makes the worst case a click that does nothing
				 * — hiding a hidden window — instead of one that does the reverse.
				 */
				const hiding = host.isVisible();
				return {
					label: hiding ? `Hide ${branding.shortName}` : `Show ${branding.shortName}`,
					click: () => {
						if (hiding) {
							host.hide();
						} else {
							host.show();
						}
						reassign();
					}
				};
			})(),
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
			/*
			 * **Shutdown destroys the tray and then locks the vault.**
			 *
			 * The lock is announced now, and the announcement reaches this - so on
			 * Linux the quit path called `setContextMenu` on a `Tray` that had been
			 * destroyed three lines earlier and threw on the way out. The beat below
			 * has always checked this; the path that was added to make the menu
			 * fresher did not, which is the whole shape of that regression.
			 *
			 * Checked here rather than at the call sites because every path into a
			 * reassign has the same problem, including the ones added next.
			 */
			if (tray.isDestroyed()) {
				return;
			}
			tray.setContextMenu(menu());
			// So the beat below agrees about what is on screen. Without this a
			// reassign from a menu click leaves the recorded state behind and the
			// next tick rebuilds an identical menu for no reason.
			shown = { visible: host.isVisible(), unlocked: host.isUnlocked() };
		}
	};

	if (buildsOnDemand) {
		tray.on('right-click', () => tray.popUpContextMenu(menu()));
	} else {
		reassign();

		/*
		 * **Told rather than asked, where anything bothers to tell us.**
		 *
		 * The beat below is a quarter second, and for its length the assigned menu
		 * describes the state before last: `Lock now` greyed for a vault that has
		 * just opened is a dead control in precisely the emergency it exists for.
		 * A lock and an unlock are both announced now, so that particular gap
		 * closes to nothing.
		 *
		 * It does not replace the poll. The window hidden by its own close button
		 * announces nothing, and neither does whatever gets added next.
		 */
		host.watch?.(() => reassign());

		/*
		 * **And whenever the answers change, which is mostly not because of this
		 * file.**
		 *
		 * `reassign` is called from the menu's own items and from a click on the
		 * icon — every path where the tray is the thing that caused the change. The
		 * changes that matter most come from somewhere else entirely: the window
		 * hidden by its close button, the vault locked by the idle timer or a
		 * suspend, the vault *unlocked*, which happens in the renderer and this
		 * process only learns about indirectly.
		 *
		 * After any of those the assigned menu still read `Hide` for a hidden
		 * window, and still had `Lock now` greyed for a vault that was open — dead
		 * in precisely the emergency it exists for.
		 *
		 * Polled here rather than pushed from `index.ts` for the reason the label
		 * bug had in the first place: a signal somebody has to remember to send is
		 * a signal somebody forgets. Two boolean reads a second, and a menu rebuilt
		 * only when one of them has actually moved, so the common case costs
		 * nothing and there is no per-second churn for the desktop to notice.
		 */
		const beat = setInterval(() => {
			// A destroyed tray throws on `setContextMenu`, and the beat outlives it
			// on quit. `Tray` has no `destroyed` event to hang this on.
			if (tray.isDestroyed()) {
				clearInterval(beat);
				return;
			}
			const now = { visible: host.isVisible(), unlocked: host.isUnlocked() };
			if (now.visible === shown.visible && now.unlocked === shown.unlocked) {
				return;
			}
			shown = now;
			reassign();
		}, TRAY_BEAT_MS);
		// Never a reason to hold the process open: if this is the only thing left
		// running, there is nothing for the menu to describe.
		beat.unref?.();
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
