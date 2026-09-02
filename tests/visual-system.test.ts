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

/**
 * The body of a top-level rule, whitespace-normalised.
 *
 * Anchored to the start of a line, because a plain substring search for `h1 {`
 * happily finds it inside `.gate h1 {` and then asserts against the wrong rule —
 * which is how this helper first reported the base heading as unstyled.
 */
function rule(selector: string): string {
	const escaped = [...selector].map((ch) => (/[a-z0-9 ]/i.test(ch) ? ch : `\\${ch}`)).join('');
	const at = css.search(new RegExp(`^${escaped}`, 'm'));
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
		/*
		 * **The whole block, not its first step.** `indexOf('}')` finds the brace
		 * closing the inner `from { ... }` step, so the slice ended there and every
		 * later step went unchecked — adding `50% { ... rotateX(-75deg); }` brought
		 * the flip straight back with the test still green.
		 */
		const at = css.indexOf('@keyframes land');
		expect(at, 'the land keyframes are gone; this test needs rewriting').toBeGreaterThan(-1);
		const open = css.indexOf('{', at);
		let depth = 0;
		let close = -1;
		for (let i = open; i < css.length; i += 1) {
			if (css[i] === '{') depth += 1;
			else if (css[i] === '}') {
				depth -= 1;
				if (depth === 0) {
					close = i;
					break;
				}
			}
		}
		expect(close, 'the land keyframes are not a balanced block').toBeGreaterThan(open);
		expect(
			css.slice(open, close),
			'a step in @keyframes land rotates the glyph, so the code shows one or two readable ' +
				'characters for part of every rotation'
		).not.toMatch(/rotate/);
	});
});

describe('the type system', () => {
	/** A custom property's declared value, however many lines it is written over. */
	const token = (name: string) => {
		const at = css.indexOf(`--${name}:`);
		if (at === -1) {
			throw new Error(`--${name} is gone from app.css`);
		}
		return css.slice(at, css.indexOf(';', at)).replace(/\s+/g, ' ');
	};

	it('uses each optical size of Segoe UI Variable for its own job', () => {
		// The family is three faces cut for three size ranges, and this stylesheet
		// used Display — the 24px-and-up cut — for everything, including 15px body
		// copy and 11px labels. Nothing looked broken; it read thin and tight
		// everywhere at once. Collapsing these back to one family is the regression.
		expect(token('font-display')).toContain("'Segoe UI Variable Display'");
		expect(token('font-ui')).toContain("'Segoe UI Variable Text'");
		expect(token('font-small')).toContain("'Segoe UI Variable Small'");
		// The specific mistake being guarded: the body face reverting to Display.
		expect(token('font-ui')).not.toContain('Display');
	});

	it('sets body in the reading face, not the heading face', () => {
		expect(rule('body {')).toContain('font-family: var(--font-ui)');
		expect(rule('h1 {')).toContain('font-family: var(--font-display)');
	});

	it('gives measurements their own face and even-width digits', () => {
		// Durations and counts should not look like prose, and must not change
		// width as they count — the auto-lock line reflowed once a second.
		expect(token('font-numeric')).toContain('Bahnschrift');
		expect(rule('.num {')).toContain('font-family: var(--font-numeric)');
		expect(rule('.num {')).toContain('tabular-nums');
		expect(rule('body {')).toContain('tabular-nums');
	});
});

describe('the countdown ring', () => {
	it('registers --remaining so it can be interpolated', () => {
		// An unregistered custom property is a string to the engine, and a conic
		// gradient built from a string cannot animate — the ring would step round
		// in thirty visible jumps rather than sweeping. Declaring its syntax is the
		// entire reason the motion exists.
		const at = css.indexOf('@property --remaining');
		expect(at, '@property --remaining is gone').toBeGreaterThan(-1);
		const block = css.slice(at, css.indexOf('}', at));
		expect(block).toContain("syntax: '<number>'");
		expect(block).toContain('inherits: true');
	});

	it('drives the ring and the drain from the same value', () => {
		// Two indicators of one fact must not be able to disagree.
		expect(rule('.expiry::before {')).toContain('var(--remaining, 1)');
		expect(rule('.code::after {')).toContain('var(--remaining, 1)');
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
