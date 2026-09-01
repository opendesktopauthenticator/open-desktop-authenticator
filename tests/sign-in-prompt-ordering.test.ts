import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Where the prompt sits among the other screens.**
 *
 * `mayShowSignInPrompt` answers "is the user on the account list", and the first
 * version of this fix asked it in the wrong place. `routingFor` and `backupFor`
 * are overlays rendered while the view is still `accounts` — Account routing,
 * and Revocation backup, which is a passphrase screen — and both were checked
 * *after* the prompt. So a stale answer still took the window from them, which is
 * the erasure the whole fix is about, one screen along.
 *
 * The prompt is now the last thing tried before the account list itself, so
 * every screen above it wins by existing rather than by being listed somewhere.
 *
 * Asserted on the source because effects and overlay state need a DOM runner
 * this project does not have — and asserted as an *ordering* rather than a line
 * number, because a position is the thing this repository keeps getting caught
 * by. What it pins is: every `if (<something>)` that returns a screen comes
 * before the prompt, and the prompt comes before the account list.
 */
describe('the sign-in prompt among the other screens', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	const at = (needle: string): number => {
		const index = source.indexOf(needle);
		expect(index, `App.tsx no longer contains ${needle}`).toBeGreaterThan(-1);
		return index;
	};

	const prompt = () => at('if (mayShowSignInPrompt(browserSignIn, view))');

	it.each([
		['the auto-confirm screen', 'if (autoConfirmFor)'],
		['the remove-account screen', 'if (removingFor)'],
		['the confirmations screen', 'if (confirmingFor)'],
		['the routing screen', 'if (routingFor)'],
		['the revocation-backup screen', 'if (backupFor)']
	])('does not outrank %s', (what, needle) => {
		expect(
			at(needle),
			`the sign-in prompt is decided before ${what}, so a browser answer that arrives while ` +
				'that screen is open replaces it and erases whatever was typed into it'
		).toBeLessThan(prompt());
	});

	it('is still tried before the account list itself', () => {
		expect(prompt()).toBeLessThan(at('<VaultHome'));
	});

	/*
	 * And nothing else may claim the screen between the prompt and the list: a
	 * screen added there would be one the prompt outranks, which is the defect
	 * coming back.
	 */
	it('has nothing between it and the account list', () => {
		const between = source.slice(prompt(), at('<VaultHome'));
		// Built from codepoints rather than written as a regex: an escape in this
		// file has twice reached disk as the byte itself, and a newline inside a
		// regex literal is a parse error rather than a wrong answer.
		const marker =
			String.fromCharCode(10) + String.fromCharCode(9) + String.fromCharCode(9) + 'if (';
		expect(
			between.split(marker).length - 1,
			'a screen was added between the sign-in prompt and the account list, so the prompt now ' +
				'outranks it'
		).toBe(0);
	});
});
