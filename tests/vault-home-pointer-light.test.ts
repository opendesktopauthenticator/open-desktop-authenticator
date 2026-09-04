import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The list is not there on the render that first shows this screen.**
 *
 * `App`'s refresh sets `status` and only then awaits `listAccounts` before
 * setting `accounts`, so there is always a committed render where the vault is
 * unlocked and `accounts` is still `[]`. The `<ul className="accounts">` is on
 * the other branch of that check, so `list.current` is null on it — and an
 * effect with `[]` deps bailed there and never ran again. The pointer light
 * stayed at each row's centre, on the `50% 50%` fallback in `app.css`, until
 * something else unmounted and remounted the screen.
 *
 * Asserted on the source, and in a `.ts` file rather than beside the rendering
 * tests, because effects do not run under `renderToStaticMarkup`, this project
 * has no DOM runner, and a `.tsx` test compiles under the web config where
 * `node:fs` does not exist. What is pinned is that the effect is not bound to an
 * empty dependency list — not where any line sits.
 */
describe('the pointer-follow light on the account list', () => {
	const SOURCE = readFileSync(
		join(__dirname, '..', 'src', 'renderer', 'screens', 'VaultHome.tsx'),
		'utf8'
	);

	/** From the ref that the effect needs to the end of the effect. */
	const effect = (() => {
		const at = SOURCE.indexOf('const list = useRef<HTMLUListElement>(null);');
		expect(at, 'the list ref is gone; this test needs rewriting').toBeGreaterThan(-1);
		const end = SOURCE.indexOf('const byAccount', at);
		expect(end, 'VaultHome changed shape; this test needs rewriting').toBeGreaterThan(at);
		return SOURCE.slice(at, end);
	})();

	it('does not attach once and never look again', () => {
		expect(
			effect,
			'the pointer listener is attached with empty deps, so it never runs on the render that ' +
				'actually mounts the list and the light never follows the pointer'
		).not.toMatch(/\}, \[\]\);/);
	});

	it('re-runs when the list of accounts appears', () => {
		expect(effect).toContain('accounts.length > 0');
		expect(effect).toMatch(/\}, \[hasRows\]\);/);
	});
});
