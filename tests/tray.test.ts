import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTray, type TrayHost } from '../src/main/tray';
import { branding } from '../src/shared/branding';

/**
 * **The tray menu has to describe the application as it is now, not as it was at
 * startup.**
 *
 * Both faults this file guards against came from one menu, built once, shown for
 * the rest of the session:
 *
 *  - It was built while the window was visible, so its first item read
 *    "Hide ODA". Closing the window hides it and tells the tray nothing, and the
 *    item still labelled "Hide ODA" then *showed* the window. Note what did and
 *    did not go wrong: the click handler re-reads `isVisible()`, so the action
 *    was right and only the label lied. That is why the test below does not ask
 *    "does clicking show the window" — it asks whether the label and the effect
 *    agree, which is the thing that was actually broken.
 *  - "Lock now" is built disabled while the vault is locked, which is how the
 *    app starts. Unlocking happens in the renderer, so the item stayed greyed
 *    for the whole session — dead in precisely the emergency it exists for.
 *
 * Everything here is driven through the real `createTray` against a fake
 * Electron, so what is asserted is the menu Electron was actually handed at the
 * moment a user opened it, not the shape of the source that produced it.
 *
 * ## Both delivery paths, on purpose
 *
 * Windows and macOS are handed a menu at the instant of the click
 * (`popUpContextMenu`); Linux can only be given one to keep (`setContextMenu`),
 * because Electron documents the `right-click` event and `popUpContextMenu` as
 * `darwin,win32`. Those are different code paths with different guarantees, and
 * a suite that only ever ran on the developer's platform would test one of them.
 * `process.platform` is stubbed per case so both run everywhere.
 */

/** As much of a menu item as anything here has an opinion about. */
interface Item {
	label?: string;
	enabled?: boolean;
	type?: string;
	click?: () => void;
}

/** What the fake `Menu.buildFromTemplate` returns, shaped like Electron's `menu.items`. */
interface FakeMenu {
	items: Item[];
}

/**
 * What the tray did to Electron, collected as it happens.
 *
 * Recorded rather than asserted inside the fakes so that a failure below reads
 * as the broken property rather than as a throw from inside a constructor.
 */
const record = vi.hoisted(() => ({
	/** Tray event listeners, by event name, in registration order. */
	listeners: new Map<string, (() => void)[]>(),
	/** Menus handed to `setContextMenu` — the ones the icon keeps. */
	assigned: [] as FakeMenu[],
	/** Menus handed to `popUpContextMenu` — the ones built for one showing. */
	poppedUp: [] as FakeMenu[],
	/** Whether `destroy()` has been called, which `isDestroyed` reports back. */
	destroyed: false,
	clear(): void {
		this.listeners.clear();
		this.assigned.length = 0;
		this.poppedUp.length = 0;
		this.destroyed = false;
	}
}));

/*
 * Enough of Electron to build a tray for real. Deliberately dumb: it answers and
 * it records, and it decides nothing, because anything this file judges is a
 * judgement the test is no longer making about `tray.ts`.
 */
vi.mock('electron', () => ({
	Menu: {
		buildFromTemplate: (template: Item[]): FakeMenu => ({ items: template })
	},
	Tray: class {
		setToolTip(): void {}
		setContextMenu(menu: FakeMenu): void {
			record.assigned.push(menu);
		}
		popUpContextMenu(menu: FakeMenu): void {
			record.poppedUp.push(menu);
		}
		on(event: string, listener: () => void): this {
			const existing = record.listeners.get(event) ?? [];
			existing.push(listener);
			record.listeners.set(event, existing);
			return this;
		}
		destroy(): void {
			record.destroyed = true;
		}
		isDestroyed(): boolean {
			return record.destroyed;
		}
	}
}));

/* The icon is drawn from geometry that has nothing to do with the menu. */
vi.mock('../src/main/logo-image', () => ({
	trayImage: () => ({})
}));

/**
 * Run a case as if on a given platform.
 *
 * `createTray` reads `process.platform` once, when it is called, so this has to
 * be in place before the harness builds the tray — and put back afterwards, or
 * every later file in the run believes it is on Linux.
 */
function usePlatform(platform: NodeJS.Platform): void {
	const original = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	onTestFinished(() => {
		if (original) {
			Object.defineProperty(process, 'platform', original);
		}
	});
}

/** The application state the tray describes, mutable from outside the tray. */
interface World {
	visible: boolean;
	unlocked: boolean;
	quits: number;
}

function harness(platform: NodeJS.Platform, initial: { visible: boolean; unlocked: boolean }) {
	usePlatform(platform);
	const world: World = { ...initial, quits: 0 };
	const host: TrayHost = {
		show: () => {
			world.visible = true;
		},
		hide: () => {
			world.visible = false;
		},
		isVisible: () => world.visible,
		lock: () => {
			world.unlocked = false;
		},
		isUnlocked: () => world.unlocked,
		quit: () => {
			world.quits += 1;
		}
	};
	createTray(host);
	return { world };
}

/** Fire a tray event the way Electron would. */
function fire(event: string): void {
	for (const listener of record.listeners.get(event) ?? []) {
		listener();
	}
}

/**
 * The menu a user opening the tray right now would be looking at.
 *
 * Asks for it the way the platform delivers it, without needing to know which
 * platform that is: a right-click is offered, and whichever of the two Electron
 * calls happened most recently is what is on screen. On Linux nothing listens
 * for the right-click and the kept menu is the answer; on Windows and macOS
 * nothing is ever kept and the popped-up one is.
 */
function openMenu(): FakeMenu {
	fire('right-click');
	const shown = record.poppedUp.at(-1) ?? record.assigned.at(-1);
	if (!shown) {
		throw new Error('opening the tray produced no menu at all — nothing was shown to the user');
	}
	return shown;
}

/**
 * The show/hide item, found by what it says rather than by where it sits.
 *
 * It was `items[0]`. That is a position, and this repo's recurring failure is
 * guards that assert on a position instead of the property — prepending any
 * item silently re-points the helper at the wrong one. Matched on the verb
 * instead, and derived from `branding` rather than hard-coded, so renaming the
 * product does not turn a passing guard red for a reason unrelated to the
 * defect.
 */
function windowItem(menu: FakeMenu): Item {
	const item = menu.items.find(
		(entry) =>
			entry.label === `Hide ${branding.shortName}` || entry.label === `Show ${branding.shortName}`
	);
	if (!item) {
		throw new Error(
			`the tray menu has no show/hide item for ${branding.shortName} — ` +
				`it offers ${menu.items.map((entry) => entry.label).join(', ')}`
		);
	}
	return item;
}

function lockItem(menu: FakeMenu): Item {
	const item = menu.items.find((entry) => entry.label === 'Lock now');
	if (!item) {
		throw new Error('the tray menu has no "Lock now" item');
	}
	return item;
}

beforeEach(() => {
	record.clear();
});

describe('the tray menu, on a platform that is handed one per click', () => {
	it('labels the window item for the window as it is now, not as it was at startup', () => {
		const { world } = harness('win32', { visible: true, unlocked: false });

		// The user pressed the window's own close button, which hides to the tray.
		// Nothing goes through the tray on that path, which is the whole problem.
		world.visible = false;

		expect(
			windowItem(openMenu()).label,
			'the tray offered to hide a window that is already hidden'
		).toBe(`Show ${branding.shortName}`);
	});

	/*
	 * The property, stated without deciding which half is right: whatever the item
	 * says it will do is what happens. A stale menu fails this because the label
	 * froze at startup while the click handler kept reading live state, so the two
	 * disagreed — the item said "Hide" and showed the window.
	 */
	it('does what the item it is showing says it will do', () => {
		const { world } = harness('win32', { visible: true, unlocked: false });
		world.visible = false;

		const item = windowItem(openMenu());
		item.click?.();

		expect(
			world.visible,
			`the item labelled "${String(item.label)}" did the opposite of its own label`
		).toBe(item.label === `Show ${branding.shortName}`);
	});

	it('enables Lock now as soon as the vault is unlocked, with no tray interaction in between', () => {
		const { world } = harness('win32', { visible: true, unlocked: false });

		// Unlocking happens in the renderer. The tray is not told and cannot ask to
		// be told; it can only look, and it has to look at the right moment.
		world.unlocked = true;

		expect(
			lockItem(openMenu()).enabled,
			'Lock now was still greyed out on an unlocked vault — the one case it exists for'
		).toBe(true);
	});

	/*
	 * The other direction, so that "enable it always" is not a way to pass the
	 * test above. Greying it out on a locked vault is deliberate: see `tray.ts`.
	 */
	it('greys Lock now again once the vault is locked', () => {
		const { world } = harness('win32', { visible: true, unlocked: false });
		world.unlocked = true;

		lockItem(openMenu()).click?.();

		expect(world.unlocked, 'clicking Lock now did not lock the vault').toBe(false);
		expect(
			lockItem(openMenu()).enabled,
			'Lock now stayed clickable on a vault that is already locked'
		).toBe(false);
	});

	/*
	 * Windows pops up an *assigned* menu by itself on right-click, before this
	 * file gets a say. Keeping one there would put the stale copy back on screen
	 * and open the freshly built one underneath it.
	 */
	it('keeps no menu on the icon for Windows to pop up behind its back', () => {
		const { world } = harness('win32', { visible: true, unlocked: false });
		world.visible = false;
		openMenu();
		fire('click');

		expect(
			record.assigned,
			'a menu was left assigned to the tray icon, which is the copy that goes stale'
		).toEqual([]);
	});
});

/*
 * Linux gets neither the event nor `popUpContextMenu`, so the assigned menu is
 * the only menu, and it cannot be refreshed at the moment of opening. State that
 * changes with no tray involvement at all is therefore still stale there — that
 * is a platform limit, not something this file can assert away. What it can
 * assert is that every signal the tray *does* receive refreshes the menu, which
 * is what the old code failed to do even when it had the chance.
 */
describe('the tray menu, on a platform that can only be given one to keep', () => {
	it('is on the icon from the start, or Linux has no tray menu at all', () => {
		harness('linux', { visible: true, unlocked: false });

		expect(
			record.assigned.length,
			'no menu was assigned, so a Linux user has nothing to open'
		).toBeGreaterThan(0);
	});

	it('is refreshed on the one signal the tray gets, rather than kept from startup', () => {
		const { world } = harness('linux', { visible: false, unlocked: false });

		world.unlocked = true;
		// Clicking the icon shows the window: an activation the tray does see, and
		// after which both the window label and Lock now should have moved on.
		fire('click');

		const menu = openMenu();
		expect(
			windowItem(menu).label,
			'the window item still described the state from before the tray was clicked'
		).toBe(`Hide ${branding.shortName}`);
		expect(
			lockItem(menu).enabled,
			'Lock now was still greyed out after the tray had been clicked on an unlocked vault'
		).toBe(true);
	});
});

/**
 * **The menu the icon keeps has to be replaced by the click that invalidated it.**
 *
 * On Linux the tray is handed one menu to hold; nothing asks for a fresh one at
 * the moment of opening. So every item's click handler has to put a rebuilt
 * menu back, or the next right-click shows a menu describing the world as it
 * was *before* the click — the item reading "Hide" over a window it hid a
 * moment ago, and doing the opposite of what it says.
 *
 * A verifier proved this unguarded: deleting the `reassign()` calls from inside
 * the two click handlers left the shipped suite green while both halves of the
 * defect came back. The cases above cover the *external* signals — a window
 * hidden by its own close button, a vault unlocked elsewhere — and none of them
 * covers the tray invalidating its own menu.
 */
describe('a menu the tray keeps, after its own items are used', () => {
	it('reflects the window it just hid, rather than the state before the click', () => {
		const { world } = harness('linux', { visible: true, unlocked: true });

		const before = windowItem(openMenu());
		expect(before.label, 'the menu did not start out offering to hide').toBe(
			`Hide ${branding.shortName}`
		);

		// The user takes the action the menu offered.
		before.click?.();
		expect(world.visible, 'the click did not actually hide the window').toBe(false);

		expect(
			windowItem(openMenu()).label,
			'the kept menu still offers to hide a window it has already hidden, so the next click ' +
				'shows it — the item does the opposite of what it says'
		).toBe(`Show ${branding.shortName}`);
	});

	it('reflects the vault it just locked', () => {
		const { world } = harness('linux', { visible: true, unlocked: true });

		const lock = lockItem(openMenu());
		expect(lock.enabled, 'Lock now started out disabled on an unlocked vault').toBe(true);

		lock.click?.();
		expect(world.unlocked, 'the click did not actually lock the vault').toBe(false);

		expect(
			lockItem(openMenu()).enabled,
			'the kept menu still offers Lock now for a vault it has already locked'
		).toBe(false);
	});
});

/**
 * **Changes the tray does not cause, which is most of them.**
 *
 * `reassign` runs from the menu's own items and from a click on the icon: every
 * path where the tray is the thing that changed something. The changes that
 * matter most come from somewhere else — the window hidden by its close button,
 * the vault locked by the idle timer or a suspend, and the vault *unlocked*,
 * which happens in the renderer and this process only learns about indirectly.
 *
 * On Windows and macOS none of that matters: the menu is built at the instant of
 * the click. On Linux the assigned menu is the only menu there will ever be, so
 * after any of those the tray went on saying `Hide` for a hidden window and kept
 * `Lock now` greyed for a vault that was open — dead in exactly the emergency it
 * exists for.
 *
 * Driven through the real interval with fake timers, so what is asserted is the
 * menu Electron was handed rather than the shape of the code that handed it over.
 */
describe('the Linux menu after a change the tray was not told about', () => {
	it('follows a window hidden by something other than the menu', () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const { world } = harness('linux', { visible: true, unlocked: true });
		expect(windowItem(openMenu()).label).toBe(`Hide ${branding.shortName}`);

		// The user presses the window's own close button.
		world.visible = false;
		vi.advanceTimersByTime(1000);

		expect(
			windowItem(openMenu()).label,
			'the tray offered to hide a window that was already hidden, and hiding it showed it'
		).toBe(`Show ${branding.shortName}`);
	});

	it('follows a vault unlocked in the renderer', () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		// How the application starts: locked, so `Lock now` is built greyed.
		const { world } = harness('linux', { visible: true, unlocked: false });
		expect(lockItem(openMenu()).enabled).toBe(false);

		world.unlocked = true;
		vi.advanceTimersByTime(1000);

		expect(
			lockItem(openMenu()).enabled,
			'Lock now stayed greyed for an unlocked vault, which is the one state it is for'
		).toBe(true);
	});

	it('follows a vault locked by the idle timer', () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const { world } = harness('linux', { visible: true, unlocked: true });
		expect(lockItem(openMenu()).enabled).toBe(true);

		world.unlocked = false;
		vi.advanceTimersByTime(1000);

		expect(lockItem(openMenu()).enabled).toBe(false);
	});

	/*
	 * A beat that reassigns every second would have the desktop rebuilding the
	 * menu forever for nothing. Only a change may cost anything.
	 */
	it('leaves the menu alone while nothing changes', () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		harness('linux', { visible: true, unlocked: true });
		const assignedAfterStartup = record.assigned.length;

		vi.advanceTimersByTime(10_000);

		expect(
			record.assigned.length,
			'the tray rebuilt its menu on a beat with nothing to report'
		).toBe(assignedAfterStartup);
	});

	/*
	 * And the platforms that build on demand must not grow a timer at all: there
	 * is no kept menu for it to refresh, and reassigning on Windows is the defect
	 * this module was written to remove.
	 */
	it.each<NodeJS.Platform>(['win32', 'darwin'])('assigns nothing on %s, ever', (platform) => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const { world } = harness(platform, { visible: true, unlocked: true });
		world.visible = false;
		world.unlocked = false;
		vi.advanceTimersByTime(10_000);

		expect(
			record.assigned,
			'a menu was assigned on a platform that pops one up, so the stale copy is what opens'
		).toEqual([]);
	});
});

/**
 * **A label the action agrees with, even when the label is a beat old.**
 *
 * The handler used to re-read `isVisible()` and toggle. On Windows and macOS the
 * menu is built at the instant of the click, so the two always agreed. On Linux
 * the kept menu can be up to one beat behind — and a stale "Hide" clicked on a
 * window that had already been closed then *showed* it, which is the opposite of
 * what the user asked for.
 *
 * Deciding once, when the item is built, makes the worst case a click that does
 * nothing instead of one that does the reverse.
 */
describe('the show/hide item when the menu is behind the world', () => {
	it('does not show a window when it says Hide', () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const { world } = harness('linux', { visible: true, unlocked: true });
		const item = windowItem(openMenu());
		expect(item.label).toBe(`Hide ${branding.shortName}`);

		// Closed by its own button, before the beat has come round.
		world.visible = false;

		item.click?.();

		expect(
			world.visible,
			'the tray offered to hide a window that was already hidden, and hiding it showed it'
		).toBe(false);
	});

	it('does not hide a window when it says Show', () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const { world } = harness('linux', { visible: false, unlocked: true });
		const item = windowItem(openMenu());
		expect(item.label).toBe(`Show ${branding.shortName}`);

		world.visible = true;
		item.click?.();

		expect(world.visible).toBe(true);
	});

	/* And it still does the thing when the label is current. */
	it('hides when it says Hide and the window is there', () => {
		const { world } = harness('linux', { visible: true, unlocked: true });
		windowItem(openMenu()).click?.();
		expect(world.visible).toBe(false);
	});

	it('shows when it says Show and the window is not', () => {
		const { world } = harness('linux', { visible: false, unlocked: true });
		windowItem(openMenu()).click?.();
		expect(world.visible).toBe(true);
	});
});
