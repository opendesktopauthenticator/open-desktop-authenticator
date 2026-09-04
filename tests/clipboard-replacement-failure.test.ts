import { describe, expect, it } from 'vitest';
import { ClipboardCourier, type Clipboard } from '../src/main/codes/clipboard';

/**
 * **A Guard code this app put on the clipboard and then stopped watching.**
 *
 * `copy` cancelled the previous code's clearing timer and then wrote. Electron's
 * clipboard write can fail — another process holding it open is the ordinary
 * cause — and when it did, the code from the *previous* copy was left sitting
 * there with nothing scheduled to remove it, for the rest of the session.
 *
 * Which is the exact thing the timer exists to prevent, reached through the one
 * path that turned it off first.
 */

/** A clipboard whose write refuses for one particular value. */
function flakyClipboard(refuses: string): Clipboard & { text: string } {
	const state = {
		text: '',
		readText: () => state.text,
		writeText: (value: string) => {
			if (value === refuses) {
				throw new Error('the clipboard is held by another process');
			}
			state.text = value;
		},
		clear: () => {
			state.text = '';
		}
	};
	return state;
}

/** A courier whose timers are fired by hand. */
function courierOver(clipboard: Clipboard) {
	const scheduled: (() => void)[] = [];
	const courier = new ClipboardCourier({
		clipboard,
		setTimer: (callback) => {
			scheduled.push(callback);
			return { unref: () => undefined } as unknown as NodeJS.Timeout;
		},
		clearTimer: () => {
			scheduled.length = 0;
		}
	});
	return { courier, fireTimers: () => scheduled.slice().forEach((run) => run()) };
}

describe('a copy whose write fails', () => {
	it('leaves the previous code still scheduled for removal', () => {
		const clipboard = flakyClipboard('SECOND');
		const { courier, fireTimers } = courierOver(clipboard);

		courier.copy('FIRST', 30_000);
		expect(clipboard.text).toBe('FIRST');

		expect(() => courier.copy('SECOND', 30_000)).toThrow();

		fireTimers();

		expect(
			clipboard.text,
			'the replacement write failed after the first code’s timer had already been cancelled, so ' +
				'a Steam Guard code this app put on the clipboard stayed there with nothing left to ' +
				'remove it'
		).toBe('');
	});

	it('does not claim to have written what it did not', () => {
		const clipboard = flakyClipboard('SECOND');
		const { courier } = courierOver(clipboard);

		courier.copy('FIRST', 30_000);
		expect(() => courier.copy('SECOND', 30_000)).toThrow();

		// `clearIfOurs` compares against what was last written. If the failed write
		// had been recorded, this would decline to clear a code that is genuinely
		// ours and genuinely still there.
		expect(courier.clearIfOurs()).toBe(true);
		expect(clipboard.text).toBe('');
	});
});

/*
 * And the ordinary path is unchanged: a successful replacement takes over, and
 * only one timer is left holding the clipboard.
 */
describe('a copy that succeeds', () => {
	it('replaces the previous code and its timer', () => {
		const clipboard = flakyClipboard('never');
		const { courier, fireTimers } = courierOver(clipboard);

		courier.copy('FIRST', 30_000);
		courier.copy('SECOND', 30_000);
		expect(clipboard.text).toBe('SECOND');

		fireTimers();
		expect(clipboard.text).toBe('');
	});
});
