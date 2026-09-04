import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToastClickRouter } from '../src/main/confirmations/toast-click';
import type { ToastClick } from '../src/shared/ipc';
import {
	claimConfirmationClick,
	notificationRefreshMayStart,
	runAcceptedNotificationRefresh,
	settleConfirmationRefreshClick,
	type ConfirmationClickClaims
} from '../src/shared/notification-click';

const ID = '76561198000000001';

function clickHarness() {
	const router = new ToastClickRouter({ reveal: vi.fn(), push: vi.fn() });
	const claims: ConfirmationClickClaims = {
		newestObserved: undefined,
		handled: undefined,
		acknowledged: undefined
	};
	let current: ToastClick | undefined;

	const activate = (): ToastClick => {
		router.activate(ID);
		const click = router.peek() as ToastClick;
		claimConfirmationClick(claims, click.token, () => false);
		current = click;
		return click;
	};
	const settle = (token: number): boolean => {
		const result = settleConfirmationRefreshClick(claims, current, token);
		if (!result) return false;
		if (result.acknowledge) router.acknowledge(result.click);
		current = undefined;
		return true;
	};

	return { router, claims, activate, settle, current: () => current };
}

describe('a notification for the Confirmations screen already open', () => {
	it('wires the accepted-refresh runner and exact-token settlement into the components', () => {
		const screen = readFileSync(
			join(__dirname, '..', 'src', 'renderer', 'screens', 'Confirmations.tsx'),
			'utf8'
		);
		const app = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
		const start = screen.indexOf('const attemptedNotificationRefresh');
		const end = screen.indexOf('\n\tconst act =', start);
		const effect = screen.slice(start, end);

		expect(start, 'the same-screen refresh effect is gone').toBeGreaterThan(-1);
		expect(end, 'the same-screen refresh effect cannot be isolated').toBeGreaterThan(start);
		expect(effect).toContain('notificationRefreshMayStart(');
		expect(effect).toContain('runAcceptedNotificationRefresh(');
		expect(effect).toContain('notificationRefreshDoneRef.current?.(settledToken)');
		expect(app).toContain('settleConfirmationRefreshClick(');
	});

	it('settles one successful refresh and cannot reopen after Back', async () => {
		const h = clickHarness();
		const click = h.activate();
		const load = vi.fn(() => Promise.resolve());
		const showFailure = vi.fn();
		const settle = vi.fn(h.settle);

		expect(notificationRefreshMayStart(click.token, undefined, false, 0)).toBe(true);
		await runAcceptedNotificationRefresh(click.token, load, showFailure, settle);

		expect(load).toHaveBeenCalledOnce();
		expect(showFailure).not.toHaveBeenCalled();
		expect(settle).toHaveBeenCalledOnce();
		expect(settle).toHaveBeenCalledWith(click.token);
		expect(h.router.peek()).toEqual({});
		const reopen = vi.fn(() => true);
		expect(claimConfirmationClick(h.claims, click.token, reopen)).toBe(false);
		expect(reopen).not.toHaveBeenCalled();
	});

	it('renders a failed refresh, settles it, and does not reinterpret Back as navigation', async () => {
		const h = clickHarness();
		const click = h.activate();
		const failure = new Error('Steam is unavailable');
		const load = vi.fn(() => Promise.reject(failure));
		const rendered: unknown[] = [];

		await runAcceptedNotificationRefresh(
			click.token,
			load,
			(cause) => rendered.push(cause),
			h.settle
		);

		expect(load).toHaveBeenCalledOnce();
		expect(rendered).toEqual([failure]);
		expect(h.router.peek(), 'the failed refresh left its click for Back to collect').toEqual({});
		const reopen = vi.fn(() => true);
		expect(claimConfirmationClick(h.claims, click.token, reopen)).toBe(false);
		expect(reopen, 'Back was undone by the already-rendered click').not.toHaveBeenCalled();
	});

	it('does not accept or settle the click while another screen operation is busy', () => {
		const h = clickHarness();
		const click = h.activate();

		expect(notificationRefreshMayStart(click.token, undefined, true, 0)).toBe(false);
		expect(notificationRefreshMayStart(click.token, undefined, false, 1)).toBe(false);
		expect(h.router.peek()).toEqual(click);
		expect(h.claims.handled).toBeUndefined();
		expect(notificationRefreshMayStart(click.token, undefined, false, 0)).toBe(true);
	});

	it('cannot let an older refresh completion clear a newer click', () => {
		const h = clickHarness();
		const older = h.activate();
		const newer = h.activate();

		expect(h.settle(older.token)).toBe(false);
		expect(h.current()).toEqual(newer);
		expect(h.router.peek()).toEqual(newer);
		expect(h.claims.handled).toBeUndefined();

		expect(h.settle(newer.token)).toBe(true);
		expect(h.router.peek()).toEqual({});
		expect(h.claims.handled).toBe(newer.token);
	});

	it('retries a failed acknowledgement without repeating the settled refresh or navigation', () => {
		const h = clickHarness();
		const click = h.activate();
		const settlement = settleConfirmationRefreshClick(h.claims, click, click.token);

		expect(settlement?.acknowledge).toBe(true);
		// Model all bounded IPC acknowledgement attempts failing: main still holds
		// the exact click, while this document remembers that its result was shown.
		expect(h.router.peek()).toEqual(click);
		const reopen = vi.fn(() => true);
		expect(claimConfirmationClick(h.claims, click.token, reopen)).toBe(false);
		expect(reopen).not.toHaveBeenCalled();
	});
});
