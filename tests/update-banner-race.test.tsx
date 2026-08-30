import { describe, expect, it } from 'vitest';
import { updateAnswerIsCurrent } from '../src/renderer/App';

/**
 * **Which update-check answer is allowed to reach the screen.**
 *
 * The effect re-runs when either setting that gates the check moves, so two
 * checks can be in the air at once — and the main process aborts the older one
 * when `Require proxies` turns on. That abort settles as `unknown`, and nothing
 * stopped it writing the banner. Landing after the newer check had succeeded,
 * it replaced a real "update available" with "could not check": the main
 * process cache stayed correct and the screen quietly stopped saying there was
 * a release.
 *
 * Both settlement orders matter, and only one of them was ever the bug — which
 * is why the order is what these test.
 */
describe('which update answer reaches the screen', () => {
	/** The newest check's own number, as the effect assigns it. */
	const NEWEST = 2;

	it('shows the newest answer', () => {
		expect(updateAnswerIsCurrent(NEWEST, NEWEST, false)).toBe(true);
	});

	/*
	 * The bug: an older check settling last. `mine` is 1, the newest is 2, so
	 * this answer belongs to a question that has been replaced.
	 */
	it('refuses an older answer that settles after a newer one', () => {
		expect(
			updateAnswerIsCurrent(NEWEST, 1, false),
			'an aborted check overwrote the release it was replaced by'
		).toBe(false);
	});

	/*
	 * And the other order, which never was the bug and must stay working: the
	 * older check settles first, the newer one settles after and wins.
	 */
	it('accepts the newer answer whichever settled first', () => {
		expect(updateAnswerIsCurrent(NEWEST, 1, false)).toBe(false);
		expect(updateAnswerIsCurrent(NEWEST, NEWEST, false)).toBe(true);
	});

	/*
	 * The separate reason an answer is unwelcome: the user switched update
	 * checks off while it was in the air. Independent of ordering — a current
	 * answer is still refused.
	 */
	it('refuses any answer once the banner is suppressed', () => {
		expect(updateAnswerIsCurrent(NEWEST, NEWEST, true)).toBe(false);
		expect(updateAnswerIsCurrent(NEWEST, 1, true)).toBe(false);
	});

	/*
	 * The first check of a session, where nothing has superseded anything.
	 */
	it('shows the first answer of a session', () => {
		expect(updateAnswerIsCurrent(1, 1, false)).toBe(true);
	});
});
