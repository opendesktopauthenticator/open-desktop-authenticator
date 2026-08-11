import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Three rules in the stylesheet that look like polish and are not.
 *
 * Each was found by measuring the rendered page rather than by reading the CSS,
 * and each fails in a way that is invisible in review: the markup reads fine,
 * the rule reads fine, and the damage only appears on screen. They are asserted
 * here because the obvious "tidying" edit to each one reintroduces the bug.
 *
 * Everything else about the visual work is taste and belongs in a screenshot,
 * not a test.
 */

const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'app.css'), 'utf8');
const unlock = readFileSync(
	join(__dirname, '..', 'src', 'renderer', 'screens', 'UnlockVault.tsx'),
	'utf8'
);
const create = readFileSync(
	join(__dirname, '..', 'src', 'renderer', 'screens', 'CreateVault.tsx'),
	'utf8'
);

/** The body of a rule, whitespace-normalised. */
function rule(selector: string): string {
	const at = css.indexOf(selector);
	if (at === -1) {
		throw new Error(`${selector} is gone from app.css`);
	}
	return css.slice(at, css.indexOf('}', at)).replace(/\s+/g, ' ');
}

describe('reduced motion', () => {
	it('zeroes animation delay, not only duration', () => {
		// The staggered entrances hold their first frame through their delay
		// (`animation-fill-mode: backwards`). Killing the duration but leaving the
		// delay makes the account list sit invisible for a quarter of a second and
		// then flash in — worse than the animation it is meant to spare people.
		const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
		expect(block).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
		expect(block, 'delays must be zeroed too — see the comment there').toMatch(
			/animation-delay:\s*0ms\s*!important/
		);
	});

	it('stops the ambient wash rather than seeking it to the end', () => {
		// It has no meaningful end state; it exists only as movement.
		expect(css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))).toMatch(
			/body::before\s*\{\s*animation:\s*none\s*!important/
		);
	});
});

describe('the code glyphs', () => {
	it('cancel the tracking inside each glyph box', () => {
		// Splitting the code into per-character `inline-block`s makes the parent's
		// `letter-spacing` apply *inside* every box as well as between them: five
		// characters silently bought five extra gaps, 27px at this size, which was
		// enough to wrap the account row onto a third line. Zeroing it here leaves
		// the tracking to the gaps between the boxes, matching the plain text it
		// replaced to within a rounding error.
		expect(rule('.code .glyph {')).toMatch(/letter-spacing:\s*0\s*;/);
	});

	it('never turns a glyph away from the reader', () => {
		// An earlier version flipped each glyph in through `rotateX(-75deg)`, which
		// left the code showing one or two readable characters for about half a
		// second on every rotation. Five characters, legibly, is the entire job.
		const land = css.slice(css.indexOf('@keyframes land'));
		expect(land.slice(0, land.indexOf('}') + 2)).not.toMatch(/rotate/);
	});
});

describe('the gate screens', () => {
	it('only hides the field label when there is genuinely one field', () => {
		// Two ways a gate screen stops having a single field: creating a vault asks
		// for the passphrase twice, and the unlock screen grows a second box the
		// moment the backup panel opens. Scoping to `.solo` alone covers the first
		// and not the second — measured in a browser, that left two password fields
		// on screen with both labels hidden.
		expect(css, 'must be scoped to a single form — see the comment in app.css').toMatch(
			/\.gate\.solo:not\(:has\(form ~ form\)\) form > label \{/
		);
		// Both unguarded spellings are the regressions, so both are named.
		expect(css, 'a bare .gate rule also hits the create screen').not.toContain(
			'.gate form > label {'
		);
		expect(css, '.solo alone misses the open backup panel').not.toContain(
			'.gate.solo form > label {'
		);
	});

	it('marks the single-field screen and only that one', () => {
		expect(unlock).toMatch(/className="shell gate solo"/);
		expect(create).toMatch(/className="shell gate"/);
		expect(create, 'the create screen has two password fields').not.toMatch(/gate solo/);
	});

	it('still has two labelled fields on the create screen', () => {
		// Guards the premise of the test above rather than the styling: if this
		// screen ever became single-field, the scoping would stop mattering and
		// somebody should notice deliberately rather than by breaking it.
		expect(create.match(/<label htmlFor=/g) ?? []).toHaveLength(2);
	});
});
