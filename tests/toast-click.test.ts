import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToastClickRouter } from '../src/main/confirmations/toast-click';
import { ConfirmationNotifier, type ToastHost } from '../src/main/confirmations/notify';
import type { ConfirmationSummary } from '../src/shared/ipc';

/**
 * **Where a clicked notification goes, and why a push alone cannot do it.**
 *
 * The failure this guards against is not the obvious one. Closing the window to
 * the tray destroys nothing — that path is `preventDefault()` plus `hide()`, so
 * the `webContents` and its listeners survive and a push is delivered normally.
 * What is not stable is the document: locking the vault **reloads** the window,
 * so a click arriving in that window lands on a renderer with no subscriber and
 * the intent disappears with nothing reporting that it did.
 */

const ID = '76561198000000001';

function summary(overrides: Partial<ConfirmationSummary> = {}): ConfirmationSummary {
	return {
		id: '1',
		type: 2,
		typeName: 'Trade',
		hasIcon: false,
		securityCritical: false,
		autoConfirmable: true,
		...overrides
	};
}

describe('the click source', () => {
	function harness(onActivate?: (steamId64: string) => void) {
		const toasts: { title: string; body: string; onClick?: () => void }[] = [];
		const host: ToastHost = {
			show: (options) => {
				toasts.push(options);
			}
		};
		return {
			notifier: new ConfirmationNotifier(onActivate ? { host, onActivate } : { host }),
			toasts
		};
	}

	it('gives every toast something to do when clicked', () => {
		const h = harness();
		h.notifier.pending(ID, 'trader', [], 0, 'full');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts[0]?.onClick, 'a toast was raised with no click behaviour').toBeTypeOf(
			'function'
		);
	});

	it('reports which account the clicked toast was about', () => {
		const activated: string[] = [];
		const h = harness((steamId64) => activated.push(steamId64));
		h.notifier.pending(ID, 'trader', [], 0, 'full');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.toasts[0]?.onClick?.();
		expect(activated).toEqual([ID]);
	});

	/*
	 * Every toast goes through one place, so every toast is clickable. The
	 * alternative — adding the callback at each `show` — is three places to
	 * remember and one to forget, and the forgotten one looks identical.
	 */
	it('carries it on the sign-in toast too', () => {
		const activated: string[] = [];
		const h = harness((steamId64) => activated.push(steamId64));
		h.notifier.signInNeeded(ID, 'trader');
		h.toasts[0]?.onClick?.();
		expect(activated).toEqual([ID]);
	});

	it('carries it on the halt toast too', () => {
		const activated: string[] = [];
		const h = harness((steamId64) => activated.push(steamId64));
		h.notifier.halted(ID, 'trader', 'confirm');
		h.toasts[0]?.onClick?.();
		expect(activated).toEqual([ID]);
	});

	it('carries it on the first-poll security-critical toast too', () => {
		const activated: string[] = [];
		const h = harness((steamId64) => activated.push(steamId64));
		h.notifier.pending(ID, 'trader', [summary({ securityCritical: true })], 0, 'full');
		h.toasts[0]?.onClick?.();
		expect(activated).toEqual([ID]);
	});

	it('names the right account when several are notifying', () => {
		const activated: string[] = [];
		const other = '76561198000000002';
		const h = harness((steamId64) => activated.push(steamId64));
		h.notifier.halted(ID, 'trader', 'confirm');
		h.notifier.halted(other, 'second', 'notify');
		h.toasts[1]?.onClick?.();
		expect(activated).toEqual([other]);
	});

	/*
	 * A host that cannot deliver clicks is still a valid host — which is what
	 * let the toasts ship one phase before the routing behind them.
	 */
	it('still shows toasts when nothing is listening for clicks', () => {
		const h = harness();
		h.notifier.halted(ID, 'trader', 'confirm');
		expect(h.toasts).toHaveLength(1);
		expect(() => h.toasts[0]?.onClick?.()).not.toThrow();
	});
});

describe('routing a click', () => {
	function router() {
		const reveal = vi.fn();
		const push = vi.fn();
		return { router: new ToastClickRouter({ reveal, push }), reveal, push };
	}

	it('puts the window in front of the person', () => {
		const r = router();
		r.router.activate(ID);
		expect(r.reveal).toHaveBeenCalledTimes(1);
	});

	it('pushes the id as the fast path', () => {
		const r = router();
		r.router.activate(ID);
		expect(r.push).toHaveBeenCalledWith(ID);
	});

	/*
	 * **No "was it hidden?" branch.** A window can be hidden *and* have been
	 * reloaded by a lock, so the remembered intent and the push have to be able
	 * to run together — a router that chose between them would drop the click in
	 * exactly the combined case.
	 */
	it('remembers it as well as pushing it', () => {
		const r = router();
		r.router.activate(ID);
		expect(r.push).toHaveBeenCalled();
		expect(r.router.peek()).toEqual({ steamId64: ID });
	});

	it('answers nothing when no click is waiting', () => {
		expect(router().router.peek()).toEqual({});
	});

	/*
	 * The renderer asks on every unlock. A click already acted on must not
	 * navigate somebody a second time.
	 */
	it('gives a click away only once, once it has been acted on', () => {
		const r = router();
		r.router.activate(ID);
		expect(r.router.peek()).toEqual({ steamId64: ID });
		r.router.acknowledge(ID);
		expect(r.router.peek(), 'an acted-on click navigated somebody twice').toEqual({});
	});

	/**
	 * **And it survives a renderer that could not act on it.**
	 *
	 * Reading used to clear it. The renderer navigates by looking the account up
	 * in the list it currently holds, and that lookup fails when the click lands
	 * after unlock and before `listAccounts` has answered — which is the case this
	 * whole slow path exists for. The intent was gone from main by then, so a
	 * security notification opened the application, went nowhere, and left nothing
	 * to try again with.
	 */
	it('keeps a click the renderer could not navigate to', () => {
		const r = router();
		r.router.activate(ID);

		// The renderer looked, found no such account yet, and acknowledged nothing.
		expect(r.router.peek()).toEqual({ steamId64: ID });

		expect(
			r.router.peek(),
			'the click was consumed by a renderer that never navigated anywhere'
		).toEqual({ steamId64: ID });
	});

	/**
	 * An acknowledgement names what it acted on, so a click that arrived in
	 * between is not swallowed by it. Two clicks a second apart, the second one
	 * the newer intention: acknowledging the first must leave the second waiting.
	 */
	it('is not cleared by an acknowledgement of an older click', () => {
		const r = router();
		const other = '76561198000000002';
		r.router.activate(ID);
		r.router.activate(other);

		r.router.acknowledge(ID);

		expect(
			r.router.peek(),
			'acknowledging the click that was superseded threw away the one that superseded it'
		).toEqual({ steamId64: other });
	});

	it('keeps only the most recent of two clicks', () => {
		const r = router();
		const other = '76561198000000002';
		r.router.activate(ID);
		r.router.activate(other);
		expect(r.router.peek()).toEqual({ steamId64: other });
		r.router.acknowledge(other);
		expect(r.router.peek()).toEqual({});
	});

	/*
	 * Somebody who comes back and types a passphrase has a new intention.
	 * Navigating them to a toast they clicked an hour ago is not honouring the
	 * old one.
	 */
	it('drops an uncollected click when the vault locks', () => {
		const r = router();
		r.router.activate(ID);
		r.router.forget();
		expect(r.router.peek(), 'a click from before a lock navigated after it').toEqual({});
	});
});

/**
 * **An intention that nobody collected, held until the process exits.**
 *
 * The slot was cleared on lock, which covers the machine somebody walked away
 * from. A session that never locks is the ordinary case for a running
 * application, and on that path nothing cleared it at all - and a click that
 * could not be collected once cannot be collected later either. The renderer
 * refuses to navigate to an account that is not in its list, so a click for an
 * account since removed sat in the slot, and the next renderer to ask was sent
 * somewhere for a reason nobody remembers.
 */
describe('a click nobody came to collect', () => {
	function at(clock: { ms: number }) {
		return new ToastClickRouter({
			reveal: vi.fn(),
			push: vi.fn(),
			now: () => clock.ms
		});
	}

	it('is still there a minute later', () => {
		const clock = { ms: 1_000_000 };
		const router = at(clock);
		router.activate(ID);

		clock.ms += 60_000;
		expect(router.peek(), 'an ordinary unlock takes longer than this').toEqual({
			steamId64: ID
		});
	});

	it('is gone an hour later', () => {
		const clock = { ms: 1_000_000 };
		const router = at(clock);
		router.activate(ID);

		clock.ms += 60 * 60_000;
		expect(
			router.peek(),
			'a click from an hour ago was handed to a renderer as a live intention, on a session ' +
				'that had simply never locked'
		).toEqual({});
	});

	/**
	 * **And it does not come back when the clock does.**
	 *
	 * The expiry is a comparison against wall-clock time, and wall-clock time
	 * moves backwards: an NTP correction, a timezone change, somebody setting it
	 * by hand. If the expired intent is only *hidden* by that comparison rather
	 * than dropped, the clock going back resurrects it, and a click from before
	 * the correction navigates somebody who has long since moved on.
	 *
	 * Dropping it on the way out costs one assignment and makes the expiry a
	 * decision rather than a filter.
	 */
	it('does not come back when the clock moves backwards', () => {
		const clock = { ms: 1_000_000 };
		const router = at(clock);
		router.activate(ID);

		clock.ms += 60 * 60_000;
		expect(router.peek()).toEqual({});

		// The correction: back to a moment when the click was still fresh.
		clock.ms -= 59 * 60_000;

		expect(
			router.peek(),
			'an expired click was handed out after the system clock moved back, because expiry hid ' +
				'it rather than dropping it'
		).toEqual({});
	});

	/* And a fresh click after an expiry is an ordinary live one. */
	it('does not stop a later click being collected', () => {
		const clock = { ms: 1_000_000 };
		const router = at(clock);
		router.activate(ID);
		clock.ms += 60 * 60_000;
		router.peek();

		router.activate(ID);
		expect(router.peek()).toEqual({ steamId64: ID });
	});
});

/**
 * **And a click for an account that is no longer there.**
 *
 * Every other per-account cache is dropped when an account is removed - the
 * poller's schedule, the notifier's seen-set, the activity runs. This one was
 * not in that row. The click cannot be collected, because the renderer will not
 * navigate to an account missing from its list, so it stayed until the vault
 * locked. Worse if the account comes back: a re-import restores the SteamID and
 * the intent from before the removal is live again.
 */
describe('a click for an account that has been removed', () => {
	function plain() {
		return new ToastClickRouter({ reveal: vi.fn(), push: vi.fn() });
	}

	it('is forgotten with the account', () => {
		const router = plain();
		router.activate(ID);
		router.forgetAccount(ID);

		expect(
			router.peek(),
			'the click outlived the account it was for, and a re-import would make it live again'
		).toEqual({});
	});

	it('does not disturb a click for a different account', () => {
		const router = plain();
		const other = '76561198000000002';
		router.activate(other);
		router.forgetAccount(ID);

		expect(router.peek(), 'removing one account threw away another account/s click').toEqual({
			steamId64: other
		});
	});
});

/**
 * **The clock the expiry measures against must not be adjustable.**
 *
 * It was `Date.now()`. A wall clock moves backwards - an NTP correction, a
 * timezone change, somebody setting it by hand - and the subtraction was then
 * measuring an adjustment rather than a duration: move the clock back ten
 * minutes and a click stayed collectable through ten real minutes of elapsed
 * time.
 *
 * Dropping the value on the way out, which is what the case above covers, only
 * helps once an expiry has been *observed*. A clock that moves back before the
 * lifetime elapses is never observed at all, so that fix could not reach this.
 *
 * `performance.now()` cannot be adjusted, which is why `VaultService` already
 * measures its idle timeout with it. This drives the default clock rather than
 * an injected one, because the defect was the choice of default.
 */
describe('the clock a pending click is aged against', () => {
	it('is not the one a user can change', () => {
		const router = new ToastClickRouter({ reveal: vi.fn(), push: vi.fn() });
		router.activate(ID);

		/*
		 * The wall clock jumps forward past the lifetime while no real time passes.
		 * A router reading `Date.now()` calls the click expired; one reading a
		 * monotonic source is unmoved - and the same insensitivity is what stops a
		 * backwards jump extending it.
		 */
		const real = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(real + 60 * 60_000);
		try {
			expect(
				router.peek(),
				'the expiry is measured against the system clock, so moving that clock moves the ' +
					'deadline - forwards here, and backwards is the case that keeps a click alive ' +
					'past ten real minutes'
			).toEqual({ steamId64: ID });
		} finally {
			clock.mockRestore();
		}
	});

	/* And it still expires on elapsed time, which is the point of having one. */
	it('still expires once the monotonic clock has moved', () => {
		let ticks = 0;
		const router = new ToastClickRouter({
			reveal: vi.fn(),
			push: vi.fn(),
			now: () => ticks
		});
		router.activate(ID);
		ticks += 60 * 60_000;

		expect(router.peek()).toEqual({});
	});
});

/**
 * **A toast stays reachable while its click can still arrive.**
 *
 * `liveToasts` exists only to keep the `Notification` wrapper — and therefore
 * its click listener — from being collected while the notification is still in
 * Windows' Action Center. Releasing it on `close` did not implement that:
 * Electron's own typings say the `close` event fires for a system timeout as
 * well as a real dismissal, and that a notification already in the Action Center
 * stays there afterwards. So the default five seconds of screen time ended the
 * retention while the user had not looked yet, and the click did nothing.
 *
 * Asserted on the source because this is a wiring block in `index.ts` and there
 * is no way to boot the main process here — and asserted as "nothing releases it
 * on close", which is the property, rather than on where any line sits.
 */
describe('how long a shown toast is kept', () => {
	const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

	/** The `host.show` block that builds and wires one toast. */
	const wiring = (() => {
		const start = MAIN.indexOf('const liveToasts = new Set<Notification>();');
		expect(start, 'liveToasts is gone; this test needs rewriting').toBeGreaterThan(-1);
		const end = MAIN.indexOf('onActivate:', start);
		expect(end, 'the notifier host block changed shape').toBeGreaterThan(start);
		return MAIN.slice(start, end);
	})();

	it('does not release the toast when the OS says it closed', () => {
		const close = /toast\.on\('close'[\s\S]{0,200}?\)/.exec(wiring)?.[0] ?? '';
		expect(
			close,
			'the toast is dropped on `close`, which Windows emits on timeout while the notification ' +
				'is still sitting clickable in the Action Center'
		).not.toContain('liveToasts.delete');
	});

	it('releases it once the click has been delivered', () => {
		const click = /toast\.on\('click'[\s\S]{0,300}?\}\);/.exec(wiring)?.[0] ?? '';
		expect(click, 'nothing releases a toast that has been clicked').toContain(
			'liveToasts.delete(toast)'
		);
	});

	it('bounds how many are held at once', () => {
		expect(
			wiring,
			'nothing releases a toast that is never clicked, so the set grows for the life of the ' +
				'session'
		).toContain('MAX_LIVE_TOASTS');
	});
});
