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

/**
 * **The two lists of overlays, held to each other.**
 *
 * `openConfirmationsFor` clears every screen that can be covering the account
 * list, so that a clicked notification lands on the list rather than behind
 * something. `overlayOpen` asks the same question the other way round — is
 * anything covering it — to decide whether a browser answer may be kept.
 *
 * They are the same set and there is nothing making them stay the same set. A
 * sixth overlay added to one and forgotten in the other is a sign-in prompt that
 * waits behind a screen and takes the window when the user presses Back, which is
 * the defect `overlayOpen` was added to remove.
 */
describe('the screens that count as covering the account list', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	/*
	 * Both helpers scan by hand rather than by regular expression. Every attempt
	 * to write one in this file has been mangled on the way to disk — a word
	 * boundary arrived as a literal backspace byte, which matches nothing and
	 * makes the helper quietly return an empty list.
	 */

	/** The `setX(undefined)` calls inside `openConfirmationsFor`. */
	function clearedByNavigation(): string[] {
		const start = source.indexOf('const openConfirmationsFor = useCallback(');
		expect(start, 'openConfirmationsFor is gone').toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf('setConfirmingFor(account);', start));
		return body
			.split(String.fromCharCode(10))
			.map((line) => line.trim())
			.filter((line) => line.startsWith('set') && line.includes('(undefined)'))
			.map((line) => line.slice(3, line.indexOf('(')))
			.map((name) => name.charAt(0).toLowerCase() + name.slice(1))
			.sort();
	}

	/** The state names inside the `overlayOpen` expression. */
	function countedAsCovering(): string[] {
		const start = source.indexOf('const overlayOpen = Boolean(');
		expect(start, 'overlayOpen is gone').toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf(');', start));
		return body
			.split(/[^A-Za-z]+/)
			.filter((token) => token.endsWith('For') && token !== 'For')
			.sort();
	}
	it('finds both lists, or this asserts nothing', () => {
		expect(clearedByNavigation().length).toBeGreaterThan(3);
		expect(countedAsCovering().length).toBeGreaterThan(3);
	});

	it('are the same set', () => {
		/*
		 * `confirmingFor` is the one that differs, and legitimately: navigating to a
		 * confirmation *sets* it rather than clearing it, so it cannot appear among
		 * the things that get cleared. It certainly covers the account list.
		 */
		const cleared = [...clearedByNavigation(), 'confirmingFor'].sort();
		const covering = countedAsCovering();
		expect(
			covering.filter((name) => !cleared.includes(name)),
			'overlayOpen counts a screen that navigating neither sets nor clears'
		).toEqual([]);
		expect(
			cleared.filter((name) => !covering.includes(name)),
			'a screen that covers the account list is not counted by overlayOpen, so a browser answer ' +
				'arriving behind it waits and takes the window when the user presses Back'
		).toEqual([]);
	});

	/*
	 * And `confirmingFor` belongs to both: navigation sets it rather than clearing
	 * it, so it does not appear in the clear list, and it certainly covers the
	 * account list.
	 */
	it('counts the confirmations screen as covering', () => {
		expect(countedAsCovering()).toContain('confirmingFor');
	});
});

/**
 * And the answer is discarded rather than held, which is the half moving the
 * check down the render could not do.
 */
describe('an answer arriving behind an overlay', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	it('is not installed at all', () => {
		const install = source.indexOf('setBrowserSignIn(prompt);');
		expect(install, 'nothing installs the prompt any more').toBeGreaterThan(-1);

		// The guard immediately above it, whatever its exact spelling.
		const guard = source.slice(source.lastIndexOf('if (', install), install);
		expect(
			guard,
			'the prompt is installed without asking whether a screen is already covering the account ' +
				'list, so it waits behind that screen and takes the window when the user presses Back'
		).toContain('overlayOpenRef.current');
	});

	it('reads the overlay state through a ref, not a closure', () => {
		// The installing callback belongs to the account list and is rebuilt when
		// its props change, so closing over the boolean would capture whatever was
		// true when it was last built rather than when the answer arrived.
		expect(source).toContain('const overlayOpenRef = useRef(overlayOpen);');
	});
});

/**
 * **Leaving the account list has to discard the prompt, not just stop new ones.**
 *
 * `abandonPendingSignIns` bumps a counter, which stops a *late* answer from
 * installing itself. A prompt that had already arrived stayed in state — so a
 * notification opening Confirmations over it left it sitting there, and pressing
 * Back re-rendered it: a sign-in with a password field, for a request the user
 * began earlier and has since navigated away from twice.
 *
 * `mayShowSignInPrompt` hides it while the user is elsewhere, which is what made
 * this survivable rather than obvious, and also what let it come back.
 *
 * Asserted on the source because effects and render-time resets both need a DOM
 * runner this project does not have — and asserted as the *pairing* of the view
 * comparison with the clear, rather than as a line or a position, because a
 * position is the thing this repository keeps being caught by.
 */
describe('navigating away from a held sign-in prompt', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	/** The block that resets the prompt when the view has changed under it. */
	const reset = (() => {
		const start = source.indexOf('if (signInBelongsTo !== view) {');
		expect(
			start,
			'nothing notices the view changing under a held prompt any more, so it is only hidden ' +
				'and comes back the moment the user returns to the account list'
		).toBeGreaterThan(-1);
		const end = source.indexOf(
			`
	}`,
			start
		);
		expect(end, 'the reset changed shape; this test needs rewriting').toBeGreaterThan(start);
		return source.slice(start, end);
	})();

	it('discards the prompt already held, as well as the ones still coming', () => {
		expect(
			reset,
			'the view change is noticed but the prompt in state is left alone, so it takes the ' +
				'window again the moment the user comes back to the account list'
		).toContain('setBrowserSignIn(undefined)');
	});

	it('still advances the counter that stops late answers', () => {
		expect(
			source,
			'without this a sign-in answered after the user navigated away installs itself on ' +
				'whatever screen they are looking at now'
		).toContain('abandonPendingSignIns();');
	});
});
