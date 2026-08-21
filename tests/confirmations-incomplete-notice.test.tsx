import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IncompleteListNotice } from '../src/renderer/screens/Confirmations';

/**
 * The warning that the confirmation list is incomplete.
 *
 * `parseListResponse` no longer refuses a whole list because one entry inside it
 * was unreadable — that behaviour hid the account-recovery confirmation sitting
 * beside the bad entry, which `policy.ts` calls the most urgent thing this
 * application can show anybody.
 *
 * Keeping the readable entries is only safe while the gap is visible. A silent
 * drop would be worse than the refusal it replaced: the user would be looking at
 * a list that appears complete, on the screen they use to decide whether
 * somebody is taking their account. So the count reaches the screen, and this is
 * the test that it is actually drawn.
 */

const html = (count: number): string =>
	renderToStaticMarkup(<IncompleteListNotice count={count} />);

describe('the incomplete-list warning', () => {
	it('says nothing at all when every entry was readable', () => {
		// The common case by far. A warning that appears when nothing is wrong is a
		// warning people learn to skip past.
		expect(html(0)).toBe('');
	});

	it('never renders an empty box for a negative count', () => {
		expect(html(-1)).toBe('');
	});

	it('tells the user the list is incomplete rather than merely that something failed', () => {
		// The actionable half. "Something went wrong" invites a retry; "this list is
		// incomplete" is what stops somebody reading the screen as an all-clear.
		expect(html(2)).toContain('treat this list as incomplete');
	});

	it('counts what could not be read', () => {
		expect(html(3)).toContain('3 confirmations could not be read');
	});

	it('reads correctly for a single entry', () => {
		// Not cosmetic: "1 confirmations" is the kind of detail that makes a user
		// distrust the rest of the message, on a message they need to act on.
		const single = html(1);
		expect(single).toContain('One confirmation could not be read');
		expect(single).not.toContain('1 confirmations');
		expect(single).toContain('it is');
	});

	it('points at the thing that actually fixes it', () => {
		// An update. Not a retry — refetching gets the same unreadable entry back.
		expect(html(1)).toContain('needs an update');
	});
});
