import { describe, expect, it } from 'vitest';
import { ConfirmationNotifier, type ToastHost } from '../src/main/confirmations/notify';
import type { ConfirmationSummary } from '../src/shared/ipc';

/**
 * **A toast that failed slowly, undoing a later toast's work.**
 *
 * Delivery is asynchronous — Electron's `Notification.show()` returns before the
 * OS has created anything, and a failure arrives later on the `failed` event —
 * and the poller is not paused for it. So the callback that runs when a
 * notification fails can arrive after any number of later polls have run.
 *
 * It undid its own poll's bookkeeping unconditionally: delete the ids that poll
 * added to `seen`, restore the unreadable high-water mark to what it was before.
 * Both of those are "nothing was announced, so nothing may be marked announced",
 * which is right about its own poll and wrong about everybody else's.
 *
 * Two things came out of that, and they point in opposite directions, which is
 * what makes a single blanket rule impossible:
 *
 *   - **A confirmation shown twice.** A later poll re-announced an id
 *     successfully; the earlier failure then deleted it from `seen`, and the
 *     poll after that treated it as new.
 *   - **An unreadable alert never shown.** A later poll recorded a higher
 *     count; the earlier failure put back a number from before it, and the rise
 *     the user should have been told about had already been consumed.
 *
 * The fix is ownership, not ordering: every attempt takes a number, and a
 * rollback only touches state still carrying its own.
 */

const ID = '76561198000000001';
const NAME = 'trader';

function confirmation(id: string, securityCritical = false): ConfirmationSummary {
	return {
		id,
		type: 2,
		typeName: 'Trade',
		hasIcon: false,
		securityCritical
	} as ConfirmationSummary;
}

/**
 * A host whose deliveries are settled by hand, so the interleaving under test is
 * chosen rather than hoped for.
 */
function harness(): {
	notifier: ConfirmationNotifier;
	toasts: { title: string; body: string }[];
	settle: (index: number, delivered: boolean) => Promise<void>;
} {
	const toasts: { title: string; body: string }[] = [];
	const settlers: ((delivered: boolean) => void)[] = [];

	const host: ToastHost = {
		show: (options) => {
			toasts.push(options);
			return new Promise<boolean>((resolve) => {
				settlers.push(resolve);
			});
		}
	};

	return {
		notifier: new ConfirmationNotifier({ host }),
		toasts,
		settle: async (index, delivered) => {
			settlers[index]?.(delivered);
			// The notifier reacts on a microtask; asserting before it has run would
			// pass whatever the code does.
			await Promise.resolve();
			await Promise.resolve();
		}
	};
}

describe('a notification failure that arrives after later polls have run', () => {
	/**
	 * The seeding poll is silent, so every test starts by getting past it.
	 */
	const seed = (notifier: ConfirmationNotifier): void => notifier.pending(ID, NAME, [], 0, 'full');

	it('does not un-announce a confirmation a later poll delivered', async () => {
		const h = harness();
		seed(h.notifier);

		// Poll 1 announces A. Its toast is in flight.
		h.notifier.pending(ID, NAME, [confirmation('A')], 0, 'full');
		expect(h.toasts).toHaveLength(1);

		// A is resolved and then comes back, so a later poll announces it again —
		// and that one is delivered.
		h.notifier.pending(ID, NAME, [], 0, 'full');
		h.notifier.pending(ID, NAME, [confirmation('A')], 0, 'full');
		expect(h.toasts).toHaveLength(2);
		await h.settle(1, true);

		// Only now does the first toast report that it never appeared.
		await h.settle(0, false);

		// A is still pending, and has already been shown.
		h.notifier.pending(ID, NAME, [confirmation('A')], 0, 'full');
		expect(
			h.toasts,
			'the stale failure deleted an id a later poll had already announced, so the next poll ' +
				'showed the same confirmation to the user again'
		).toHaveLength(2);
	});

	it('does not swallow an unreadable rise a later poll recorded', async () => {
		const h = harness();
		seed(h.notifier);

		// Poll 1: the count rises to 2 and the toast is in flight.
		h.notifier.pending(ID, NAME, [], 2, 'full');
		expect(h.toasts).toHaveLength(1);

		// Poll 2: it rises again, to 5, and that toast is delivered.
		h.notifier.pending(ID, NAME, [], 5, 'full');
		expect(h.toasts).toHaveLength(2);
		await h.settle(1, true);

		// Poll 1 now reports failure, and used to put the mark back to 0.
		await h.settle(0, false);

		// The count has not moved, so there is nothing new to say.
		h.notifier.pending(ID, NAME, [], 5, 'full');
		expect(
			h.toasts,
			'the stale failure reset the high-water mark below what a later poll had announced, so an ' +
				'unchanged count looked like a fresh rise'
		).toHaveLength(2);
	});

	/**
	 * And the behaviour the rollback exists for, which must survive the fix: when
	 * no later poll has touched anything, a failed toast still un-announces its
	 * own work so the next poll tries again.
	 */
	it('still retries its own work when nothing else has run', async () => {
		const h = harness();
		seed(h.notifier);

		h.notifier.pending(ID, NAME, [confirmation('A')], 0, 'full');
		expect(h.toasts).toHaveLength(1);
		await h.settle(0, false);

		h.notifier.pending(ID, NAME, [confirmation('A')], 0, 'full');
		expect(
			h.toasts,
			'a toast that never appeared was recorded as announced, so the confirmation was never ' +
				'mentioned again'
		).toHaveLength(2);
	});

	it('still retries an unreadable rise that was never delivered', async () => {
		const h = harness();
		seed(h.notifier);

		h.notifier.pending(ID, NAME, [], 3, 'full');
		expect(h.toasts).toHaveLength(1);
		await h.settle(0, false);

		h.notifier.pending(ID, NAME, [], 3, 'full');
		expect(h.toasts, 'the rise was marked as announced by a toast nobody saw').toHaveLength(2);
	});
});

/**
 * **The attempt number itself, and why it is global.**
 *
 * It was a counter on the per-account state, reset to zero every time `forget`
 * or `forgetAccount` replaced that state. So a lock, or an account removed and
 * re-added, handed the same number out a second time — and a stale callback then
 * matched a fresh attempt and un-announced work it did not own.
 *
 * The seeding branch is where it bites, because its rollback looks the state up
 * again by SteamID rather than closing over the object it started with: after a
 * forget it finds the *new* state and edits that one. The main poll rollback
 * closes over the old object, which is orphaned and harmless to touch.
 *
 * The halt generation in the same file is global for exactly this reason. This
 * counter was not, which is the same defect written twice.
 */
describe('a delivery attempt that outlives the account state it belonged to', () => {
	it('does not un-announce a confirmation seeded after a forget', async () => {
		const h = harness();

		// Seeded with a security-critical confirmation, which is announced despite
		// the seeding. Its toast is in flight.
		h.notifier.pending(ID, NAME, [confirmation('X', true)], 0, 'full');
		expect(h.toasts).toHaveLength(1);

		// The account is removed, then comes back — a re-enrolment, a re-import, or
		// simply a lock and unlock.
		h.notifier.forgetAccount(ID);

		// It seeds again with the same confirmation still pending, and that toast
		// is delivered.
		h.notifier.pending(ID, NAME, [confirmation('X', true)], 0, 'full');
		expect(h.toasts).toHaveLength(2);
		await h.settle(1, true);

		// Only now does the first toast report that it never appeared.
		await h.settle(0, false);

		// X is still pending and has already been shown.
		h.notifier.pending(ID, NAME, [confirmation('X', true)], 0, 'full');
		expect(
			h.toasts,
			'the stale rollback matched a fresh attempt number, deleted an id it did not own, and ' +
				'the account takeover warning was shown a third time'
		).toHaveLength(2);
	});

	/*
	 * And across `forget`, which is what a lock does.
	 */
	it('does not un-announce one seeded after a lock', async () => {
		const h = harness();
		h.notifier.pending(ID, NAME, [confirmation('X', true)], 0, 'full');
		h.notifier.forget();
		h.notifier.pending(ID, NAME, [confirmation('X', true)], 0, 'full');
		await h.settle(1, true);
		await h.settle(0, false);

		h.notifier.pending(ID, NAME, [confirmation('X', true)], 0, 'full');
		expect(h.toasts).toHaveLength(2);
	});
});

/**
 * **The two rollbacks that were still comparing values, or nothing at all.**
 *
 * `seen` was keyed by attempt. The unreadable high-water mark was rolled back by
 * comparing the number — "is it still what I wrote" — which matches whenever a
 * later poll records the same count, and a count that has not moved is the
 * ordinary case rather than a rare one. The sign-in flag was cleared with no
 * check whatsoever.
 */
describe('the rollbacks that were not keyed by attempt', () => {
	it('does not undo an unreadable count a later poll recorded as its own', async () => {
		const h = harness();
		h.notifier.pending(ID, NAME, [], 0, 'full');

		// Poll 1 raises the count to 4. Its toast is in flight.
		h.notifier.pending(ID, NAME, [], 4, 'full');
		expect(h.toasts).toHaveLength(1);

		// Poll 2 finds the same count, records it as its own, and says nothing —
		// which is right, an unchanged count is not news.
		h.notifier.pending(ID, NAME, [], 4, 'full');
		expect(h.toasts).toHaveLength(1);

		// Poll 1 now reports it never appeared. Comparing values, this matched.
		await h.settle(0, false);

		// The count still has not moved, so there is still nothing to say.
		h.notifier.pending(ID, NAME, [], 4, 'full');
		expect(
			h.toasts,
			'the stale failure matched a later poll by value and rolled the mark back below it, so an ' +
				'unchanged count was announced as a fresh rise'
		).toHaveLength(1);
	});

	/**
	 * And the direction that loses an alert rather than duplicating one: rolling
	 * the mark back to a figure *higher* than the current count means the next
	 * genuine rise is already below the mark and is never announced.
	 */
	it('does not raise the mark past a rise a later poll is waiting to report', async () => {
		const h = harness();
		h.notifier.pending(ID, NAME, [], 0, 'full');

		// Up to 9, toast in flight.
		h.notifier.pending(ID, NAME, [], 9, 'full');
		// Most of them are resolved; the count drops, which is deliberately silent.
		h.notifier.pending(ID, NAME, [], 1, 'full');
		expect(h.toasts).toHaveLength(1);

		// The first toast reports failure. Restoring blind puts the mark back to 0
		// — but comparing by value would have matched nothing here, so this is the
		// case that needs ownership rather than a value check to get right.
		await h.settle(0, false);

		// A genuine rise, well below the old high-water mark of 9.
		h.notifier.pending(ID, NAME, [], 4, 'full');
		expect(
			h.toasts,
			'a rise from 1 to 4 was measured against a mark left over from a poll whose toast nobody ' +
				'saw, so nothing was said about it'
		).toHaveLength(2);
	});

	it('does not clear a sign-in notice a later attempt delivered', async () => {
		const h = harness();
		h.notifier.pending(ID, NAME, [], 0, 'full');

		// The session expires. The first notice is in flight.
		h.notifier.signInNeeded(ID, NAME);
		expect(h.toasts).toHaveLength(1);

		// A poll succeeds, clearing the flag, and it expires again — this one is
		// delivered.
		h.notifier.pollSucceeded(ID);
		h.notifier.signInNeeded(ID, NAME);
		expect(h.toasts).toHaveLength(2);
		await h.settle(1, true);

		// Only now does the first report failure.
		await h.settle(0, false);

		h.notifier.signInNeeded(ID, NAME);
		expect(
			h.toasts,
			'the stale failure cleared a flag a delivered notice owned, so the user was told to sign ' +
				'in again a second time'
		).toHaveLength(2);
	});

	/* And the behaviour the sign-in rollback exists for still works. */
	it('still repeats a sign-in notice that never arrived', async () => {
		const h = harness();
		h.notifier.pending(ID, NAME, [], 0, 'full');
		h.notifier.signInNeeded(ID, NAME);
		await h.settle(0, false);

		h.notifier.signInNeeded(ID, NAME);
		expect(h.toasts, 'a notice nobody saw was recorded as told').toHaveLength(2);
	});
});
