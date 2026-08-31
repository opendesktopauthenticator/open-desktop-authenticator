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
