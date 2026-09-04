import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **A modifier class that the cascade never let reach the element.**
 *
 * `.button-quiet` is specificity 0,1,0. `button.button`, declared later in the
 * same stylesheet, is 0,1,1 and sets the mint gradient. So on a real `<button>`
 * the quiet modifier lost every time: the markup said `class="button
 * button-quiet"`, spelled correctly, and the control rendered as a full primary
 * call to action.
 *
 * The one place on the site that uses that combination is the download page's
 * "Do not ask again", which therefore sat beside "Continue to the Store build"
 * with identical weight — two primary buttons, one of which permanently turns
 * something off. It was found by rendering the page in a browser, because
 * nothing about the source looked wrong.
 *
 * This project has no DOM runner, so the cascade is resolved here instead:
 * every rule in the real stylesheet that could match that element is collected,
 * ordered the way a browser orders them, and the winner is asked what it paints.
 * That is a test of the property rather than of the text — a later rule with
 * higher specificity anywhere in the file will fail it, which is exactly how
 * this happened in the first place.
 */

const CSS = readFileSync(join(__dirname, '..', 'site', 'assets', 'site.css'), 'utf8');

/** Specificity as [ids, classes, elements], per the cascade rules. */
function specificity(selector: string): [number, number, number] {
	const ids = (selector.match(/#[\w-]+/g) ?? []).length;
	const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?!\()/g) ?? []).length;
	const elements = (selector.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
	return [ids, classes, elements];
}

function beats(a: [number, number, number], b: [number, number, number]): boolean {
	for (let i = 0; i < 3; i += 1) {
		const left = a[i] as number;
		const right = b[i] as number;
		if (left !== right) return left > right;
	}
	// Equal specificity: the later rule wins, and callers iterate in source order.
	return true;
}

/**
 * Would this selector match `<button class="button button-quiet">` standing on
 * its own?
 *
 * Deliberately narrow: only a bare `button` element and the two classes, with
 * no combinator, no id and no other class. Anything more complex is a selector
 * this element does not match, and treating it as a match would make the test
 * fail for rules that have nothing to do with it.
 */
function matchesQuietButton(selector: string, pseudo: '' | ':hover'): boolean {
	const trimmed = selector.trim();
	if (trimmed === '') return false;
	const withoutPseudo = pseudo === '' ? trimmed : trimmed.replace(/:hover$/, '');
	if (pseudo === ':hover' && withoutPseudo === trimmed) return false;
	if (pseudo === '' && /:/.test(trimmed)) return false;
	if (/[\s>+~#[]/.test(withoutPseudo)) return false;

	const element = /^[a-z][\w-]*/.exec(withoutPseudo)?.[0];
	if (element !== undefined && element !== 'button') return false;
	const rest = element === undefined ? withoutPseudo : withoutPseudo.slice(element.length);
	const classes = rest.split('.').filter(Boolean);
	if (classes.length === 0) return false;
	return classes.every((c) => c === 'button' || c === 'button-quiet');
}

/** The declaration that actually wins for `property` on that element. */
function winningDeclaration(property: string, pseudo: '' | ':hover'): string | undefined {
	let bestSpec: [number, number, number] | undefined;
	let bestValue: string | undefined;

	// Comments are stripped first: they contain braces and prose that would
	// otherwise be parsed as rules.
	const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
	const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
	let rule: RegExpExecArray | null;
	while ((rule = rulePattern.exec(withoutComments)) !== null) {
		const selectors = (rule[1] ?? '').split(',');
		const body = rule[2] ?? '';
		const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`).exec(body);
		if (!declaration) continue;

		for (const selector of selectors) {
			if (!matchesQuietButton(selector, pseudo)) continue;
			const spec = specificity(selector.trim());
			if (bestSpec === undefined || beats(spec, bestSpec)) {
				bestSpec = spec;
				bestValue = (declaration[1] ?? '').trim();
			}
		}
	}
	return bestValue;
}

describe('a quiet button', () => {
	it('is matched by rules in the stylesheet at all', () => {
		// If the parser stops finding anything, every assertion below passes
		// vacuously — which is the failure mode a test like this invites.
		expect(
			winningDeclaration('background', ''),
			'no rule in site.css was found to paint a quiet button, so this file asserts nothing'
		).toBeDefined();
	});

	it('does not paint itself as a primary call to action', () => {
		expect(
			winningDeclaration('background', ''),
			'the quiet modifier loses the cascade on a <button>, so "Do not ask again" renders as a ' +
				'full mint call to action beside the download link it is meant to be quieter than'
		).not.toMatch(/gradient|var\(--mint\)/);
	});

	it('paints nothing at all', () => {
		expect(winningDeclaration('background', '')).toMatch(/transparent|none/);
	});

	it('keeps the site text colour rather than the on-mint colour', () => {
		expect(
			winningDeclaration('color', ''),
			'the quiet button uses the dark text colour meant for a mint background, which on a ' +
				'transparent one is nearly invisible'
		).toMatch(/var\(--text\)/);
	});

	/*
	 * Hover matters as much as rest: `button.button:hover` brightens, lifts and
	 * casts a mint shadow. A control that does all three on hover is not quiet,
	 * whatever it looks like standing still.
	 */
	it('does not lift on hover', () => {
		expect(winningDeclaration('transform', ':hover')).toBe('none');
	});

	it('does not brighten on hover', () => {
		expect(winningDeclaration('filter', ':hover')).toBe('none');
	});

	it('does not cast a mint shadow on hover', () => {
		expect(winningDeclaration('box-shadow', ':hover')).toBe('none');
	});
});
