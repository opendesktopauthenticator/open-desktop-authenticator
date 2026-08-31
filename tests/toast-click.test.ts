import { describe, expect, it, vi } from 'vitest';
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
		expect(r.router.take()).toEqual({ steamId64: ID });
	});

	it('answers nothing when no click is waiting', () => {
		expect(router().router.take()).toEqual({});
	});

	/*
	 * The renderer asks on every unlock. A click already acted on must not
	 * navigate somebody a second time.
	 */
	it('gives a click away only once', () => {
		const r = router();
		r.router.activate(ID);
		expect(r.router.take()).toEqual({ steamId64: ID });
		expect(r.router.take(), 'a collected click navigated somebody twice').toEqual({});
	});

	it('keeps only the most recent of two clicks', () => {
		const r = router();
		const other = '76561198000000002';
		r.router.activate(ID);
		r.router.activate(other);
		expect(r.router.take()).toEqual({ steamId64: other });
		expect(r.router.take()).toEqual({});
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
		expect(r.router.take(), 'a click from before a lock navigated after it').toEqual({});
	});
});
