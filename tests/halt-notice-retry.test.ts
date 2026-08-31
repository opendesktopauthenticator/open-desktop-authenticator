import { describe, expect, it } from 'vitest';
import { ConfirmationNotifier, type ToastHost } from '../src/main/confirmations/notify';

/**
 * **The one toast with no natural second chance.**
 *
 * The engine sets `nextDueAt` to infinity on a halt, so `halted()` is called
 * exactly once and never again. That is why it needed no "already said this"
 * flag — and equally why a delivery the OS refused was simply lost. The
 * activity log still records the halt, so the badge is right and the
 * information survives; what went was the interruption telling somebody an
 * account had stopped being checked at all, which is the whole reason a halt
 * raises a toast rather than only writing a line.
 *
 * `stillHalted` is the retry, and the scheduler calls it on the beat for
 * exactly the accounts it is skipping — the only recurring event a halted
 * account has left.
 *
 * In its own file because `confirmation-notify.test.ts` is large and this is a
 * different question: not what a toast says, but what happens when one does not
 * arrive.
 */

const ID = '76561198000000001';

function harness(): {
	notifier: ConfirmationNotifier;
	toasts: { title: string; body: string }[];
	attempts: () => number;
	recover: () => void;
} {
	const toasts: { title: string; body: string }[] = [];
	let attempts = 0;
	let failing = true;
	const host: ToastHost = {
		show: (options) => {
			attempts += 1;
			if (failing) {
				throw new Error('no notification service on this machine');
			}
			toasts.push(options);
		}
	};
	return {
		notifier: new ConfirmationNotifier({ host }),
		toasts,
		attempts: () => attempts,
		recover: () => {
			failing = false;
		}
	};
}

describe('a halt notice the notification service refused', () => {
	it('is sent again when the beat comes round and it works', () => {
		const h = harness();
		h.notifier.halted(ID, 'trader', 'confirm');
		expect(h.attempts(), 'the halt was never announced at all').toBe(1);
		expect(h.toasts, 'this tests nothing unless the first attempt failed').toEqual([]);

		h.recover();
		h.notifier.stillHalted(ID);

		expect(
			h.toasts,
			'a user was never told their account had stopped being checked, because the one toast ' +
				'that would have said so failed and nothing tried again'
		).toHaveLength(1);
		expect(h.toasts[0]?.body).toMatch(/stopped/i);
	});

	/*
	 * Once per beat, not accumulating. The scheduler calls this for every halted
	 * account on every beat, so a run of failures must cost one attempt each time
	 * rather than one per beat per earlier failure.
	 */
	it('retries once per beat while it keeps failing', () => {
		const h = harness();
		h.notifier.halted(ID, 'trader', 'confirm');
		h.notifier.stillHalted(ID);
		h.notifier.stillHalted(ID);

		expect(h.attempts(), 'the retries multiplied instead of repeating').toBe(3);
	});

	/* And stops once it has landed, rather than announcing it on every beat. */
	it('stops retrying once it lands', () => {
		const h = harness();
		h.notifier.halted(ID, 'trader', 'confirm');
		h.recover();
		h.notifier.stillHalted(ID);
		expect(h.toasts).toHaveLength(1);

		h.notifier.stillHalted(ID);
		h.notifier.stillHalted(ID);
		expect(
			h.toasts,
			'a delivered halt notice was announced again on every beat, which is an alarm'
		).toHaveLength(1);
	});

	/*
	 * The ordinary case, and it has to stay free: this runs per halted account per
	 * beat, so an account whose notice was delivered must cost a lookup that
	 * misses and nothing else.
	 */
	it('does nothing for an account whose notice was delivered first time', () => {
		const h = harness();
		h.recover();
		h.notifier.halted(ID, 'trader', 'notify');
		expect(h.attempts()).toBe(1);

		h.notifier.stillHalted(ID);
		expect(h.attempts(), 'a delivered notice was re-attempted').toBe(1);
	});

	it('does nothing for an account that never halted', () => {
		const h = harness();
		h.notifier.stillHalted(ID);
		expect(h.attempts()).toBe(0);
	});

	/*
	 * A lock clears it with everything else. The vault closing means nobody is
	 * there to be interrupted, and the next unlock re-establishes state from
	 * scratch.
	 */
	it('is forgotten when the vault locks', () => {
		const h = harness();
		h.notifier.halted(ID, 'trader', 'confirm');
		h.notifier.forget();

		h.recover();
		h.notifier.stillHalted(ID);
		expect(h.toasts, 'a halt notice survived the lock that should have cleared it').toEqual([]);
	});
});
