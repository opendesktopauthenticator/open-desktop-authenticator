import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every class a screen asks for must exist in the stylesheet.
 *
 * ## Why this is a test and not a review note
 *
 * A class name that no rule matches fails silently. React renders it, the
 * browser ignores it, and the screen comes out as unstyled HTML in roughly the
 * right order — which looks close enough to working that it survives a glance
 * at a diff. Nothing throws, no test fails, and the first person to notice is
 * whoever opens the app.
 *
 * It has already happened twice here. `ImportAccounts.tsx` carries a comment
 * about a `className="stack"` that existed in no stylesheet, fixed by hand. It
 * then happened again when the transfer screen was written against the
 * *website's* class names — `callout`, `callout-warn`, `field-error`, `screen`
 * — none of which the application's CSS has ever defined. Two occurrences of
 * the same silent failure is the argument for checking it mechanically rather
 * than remembering harder.
 *
 * ## What it does not check
 *
 * That a class is defined, not that it looks right. Deliberately: whether
 * `.notice` is the correct container for a given warning is a judgement, and a
 * test that tried to have opinions about that would be wrong more often than
 * the code.
 */

const RENDERER = join(__dirname, '..', 'src', 'renderer');

/** Class names the stylesheet defines, as selectors rather than as prose. */
function definedClasses(): Set<string> {
	const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
	return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string));
}

/** Every `.tsx` under the renderer, at any depth. */
function screens(dir = RENDERER): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return screens(full);
		return entry.name.endsWith('.tsx') ? [full] : [];
	});
}

/**
 * Class names in real markup.
 *
 * Comments are stripped first. One of the two mistakes this test exists for is
 * *described* in a comment, and a check that flagged the description of a bug
 * as the bug would be worse than no check — it would have to be suppressed, and
 * a suppressed check is one nobody reads.
 */
function usedClasses(file: string): Set<string> {
	const source = readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
	const used = new Set<string>();
	for (const match of source.matchAll(/className="([^"]+)"/g)) {
		for (const name of (match[1] as string).split(/\s+/)) {
			if (name) used.add(name);
		}
	}
	return used;
}

describe('class names', () => {
	const defined = definedClasses();

	it('are all defined in app.css', () => {
		const missing: string[] = [];
		for (const file of screens()) {
			for (const name of usedClasses(file)) {
				if (!defined.has(name)) {
					missing.push(`${file.split(/[\\/]/).pop() ?? file}: .${name}`);
				}
			}
		}
		expect(missing, 'these class names match no rule and render unstyled').toEqual([]);
	});

	/*
	 * The same failure, one layer down.
	 *
	 * `var(--accent)` where no `--accent` exists resolves to nothing and the
	 * property is dropped — so an element renders with no colour at all and
	 * nothing anywhere reports it. That happened while writing the link-styled
	 * button on the add screen: the class existed, the class check passed, and
	 * the colour silently did not.
	 *
	 * Properties set from a component's inline style are legitimate and are read
	 * out of the TSX rather than assumed.
	 */
	it('use only custom properties that are defined somewhere', () => {
		const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
		const defined = new Set(
			[...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1] as string)
		);
		for (const file of screens()) {
			const source = readFileSync(file, 'utf8');
			// Two ways a component sets one: an inline style object, and an
			// imperative setProperty on a ref. Both are legitimate; only the first
			// was recognised at first, which flagged the pointer-tracking variables
			// the accounts screen writes on mouse move.
			for (const match of source.matchAll(/'(--[a-z0-9-]+)'\s*[,:]/g)) {
				defined.add(match[1] as string);
			}
		}

		const missing = [...css.matchAll(/var\((--[a-z0-9-]+)/g)]
			.map((m) => m[1] as string)
			.filter((name) => !defined.has(name));

		expect([...new Set(missing)], 'these resolve to nothing and drop the property').toEqual([]);
	});

	it('would notice a class that does not exist', () => {
		// The check above is only worth having if it fails when it should.
		expect(defined.has('callout-warn')).toBe(false);
		expect(defined.has('notice')).toBe(true);
	});
});
