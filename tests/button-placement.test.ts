import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where a button is allowed to sit in the markup.
 *
 * Spacing above a button is not set on the button. It comes from one group of
 * rules in `app.css` — `input + .controls`, `p + .controls` and friends — which
 * gives every button row the same 20px of clearance from whatever is above it.
 * A button written bare, without that wrapper, matches none of them and inherits
 * nothing, so it lands hard against the thing above: measured at 4px under the
 * passphrase input on the unlock screen and 0px under the hint on two others.
 *
 * It looks like a mistake because it is one, and it survives review because the
 * markup reads perfectly well — nothing in the JSX hints that the wrapper is
 * load-bearing. So the containers are enumerated here instead, positively: a
 * button goes in one of four places, and anywhere else is the bug.
 *
 * This is a source check rather than a rendered one; there is no DOM test runner
 * in this project and asserting the real gap needs one. Measured separately in a
 * browser at the window's own size: every stacked button block across all
 * fourteen screens now clears the element above it by exactly 20px, bar one
 * deliberate 24px under the account list.
 */

const screensDir = join(__dirname, '..', 'src', 'renderer', 'screens');

/**
 * The containers a button may sit in, each with a spacing rule behind it.
 *
 * `app-foot` joined the list when the publisher mark was added under the account
 * list. It qualifies on the same terms as the rest — it is a flex container with
 * its own padding and top margin — and the rule below checks that spacing still
 * exists, so admitting it here does not weaken what this file is asserting.
 */
const ALLOWED =
	/^<(div|header|form|section|footer) className="(controls|row|flags|empty|app-foot)"/;

const indentOf = (line: string) => line.length - line.replace(/^\t+/, '').length;

/**
 * The opening tag of the element containing line `index`.
 *
 * Found by indentation, which Prettier makes reliable. The parent is the nearest
 * line above that is indented less and is an opening tag still waiting to close;
 * self-closing tags and tags closed on their own line are siblings. Two cases
 * need saying explicitly:
 *
 *  - a fragment is transparent. `<>` groups siblings without being a container,
 *    so the search continues past it from the fragment's own indentation.
 *  - a button never contains a button. A second button nested inside a `{cond &&
 *    (` wrapper is indented past the first one, which would otherwise look like
 *    its parent.
 */
function parentTag(lines: string[], index: number): string | undefined {
	let depth = indentOf(lines[index] ?? '');
	for (let i = index - 1; i >= 0; i--) {
		const line = lines[i] ?? '';
		const text = line.trim();
		if (text === '' || indentOf(line) >= depth) {
			continue;
		}
		if (!text.startsWith('<') || text.startsWith('</') || text.endsWith('/>')) {
			continue;
		}
		if (/<\/\w+>$/.test(text) || text.startsWith('<button')) {
			continue;
		}
		if (text === '<>') {
			depth = indentOf(line);
			continue;
		}
		return text;
	}
	return undefined;
}

describe('button placement', () => {
	const files = readdirSync(screensDir).filter((name) => name.endsWith('.tsx'));

	it('has screens to check', () => {
		// A move or rename that emptied this list would make the rest vacuous.
		expect(files.length).toBeGreaterThan(10);
	});

	it('puts every button in a container that carries spacing', () => {
		const stray: string[] = [];
		let counted = 0;
		for (const name of files) {
			const lines = readFileSync(join(screensDir, name), 'utf8').split('\n');
			lines.forEach((line, index) => {
				if (!line.trimStart().startsWith('<button')) {
					return;
				}
				counted++;
				/*
				 * A button styled as a link belongs in the sentence, not beside it.
				 *
				 * The rule below exists because a bare button next to prose gets no
				 * spacing and looks wrong. `button.link` is the deliberate opposite: it
				 * is set inline, carries no box, and reads as part of the paragraph it
				 * sits in — wrapping it in `.controls` is what would break it.
				 */
				if (/className="link"/.test(line)) {
					return;
				}
				const parent = parentTag(lines, index) ?? '(nothing)';
				if (!ALLOWED.test(parent.replace(/\s+/g, ' '))) {
					stray.push(`${name}:${index + 1} sits in ${parent.slice(0, 40)}`);
				}
			});
		}
		// Named rather than counted, so a failure says which button to wrap.
		expect(stray, 'wrap these in <div className="controls">').toEqual([]);
		// Guards the parser itself: if it stopped recognising buttons, the loop
		// above would find no offenders and pass while checking nothing.
		expect(counted).toBeGreaterThan(50);
	});

	it('still relies on the rules that do the spacing', () => {
		// Rename these selectors and wrapping a button stops meaning anything,
		// leaving the check above passing for no reason at all.
		const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'app.css'), 'utf8');
		expect(css).toMatch(/input \+ \.controls[\s\S]{0,200}margin-top: 20px/);
		expect(css).toMatch(/p \+ \.controls/);
		expect(css).toMatch(/\.checkbox \+ \.controls/);
		// The foot is only an allowed home for a button while it carries spacing of
		// its own; without this the entry above would be a hole rather than a rule.
		expect(css).toMatch(/\.app-foot\s*\{[\s\S]{0,200}padding:/);
		expect(css).toMatch(/\.app-foot\s*\{[\s\S]{0,200}margin-top:/);
	});
});
