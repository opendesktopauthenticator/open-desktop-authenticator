import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * That the confirmations screen actually draws its incomplete-list warning.
 *
 * `IncompleteListNotice` is asserted on directly in
 * `confirmations-incomplete-notice.test.tsx`, which renders it and reads the
 * markup. What that cannot show is whether anything on the real screen renders
 * it at all — the screen builds `unreadable` inside an effect, and the renderer
 * tests in this project render statically, so there is no output to inspect.
 *
 * That gap has cost this project before: a Move Authenticator harness wrapped
 * the screen in the very element whose absence was the bug, and the isolated
 * test passed while the shipped UI was visibly broken. So the wiring is asserted
 * against the source, in the same spirit as `infra-caching.test.ts` asserting
 * against the nginx config — a guarantee nobody re-reads is not a guarantee.
 *
 * A `.ts` file rather than `.tsx` on purpose: `tsconfig.web.json` covers the
 * `.tsx` tests and has no Node types, so `node:fs` cannot be read from one.
 */

const SOURCE = readFileSync(
	join(__dirname, '..', 'src', 'renderer', 'screens', 'Confirmations.tsx'),
	'utf8'
);

describe('the confirmations screen wires up its incomplete-list warning', () => {
	it('renders the notice', () => {
		expect(SOURCE).toContain('<IncompleteListNotice count={unreadable} />');
	});

	it('gates the "Nothing pending" empty state on there being nothing unread', () => {
		// The half that is easiest to lose in a later edit, and the most damaging to
		// lose: without it the screen can say "Nothing pending — this was checked
		// just now" directly beneath a warning that the list is incomplete. That is
		// a contradiction on the screen a user consults to find out whether somebody
		// is taking their account.
		expect(SOURCE).toMatch(/confirmations\.length === 0 &&[^?]*unreadable === 0/);
	});

	it('records the count on the first fetch as well as on every refresh', () => {
		// Two call sites, and these two have already drifted apart once: the
		// sign-in guard was added to `load` and left off the mount effect, so the
		// first fetch stored the empty array a sign-in response carries.
		expect(SOURCE.match(/setUnreadable\(/g) ?? []).toHaveLength(2);
	});

	it('guards both fetch paths against storing a sign-in response as a list', () => {
		// The bug the line above describes, asserted directly rather than implied.
		expect(
			SOURCE.match(/result\.signInRequired \? undefined : result\.confirmations/g) ?? []
		).toHaveLength(2);
	});
});

/**
 * The sign-in channel refuses a direct route on a vault that forbids one.
 *
 * Source-level rather than through the handler: this channel is registered
 * against a live `ConfirmationsService` and a live vault, and the point being
 * checked is that the guard exists at all and reads the setting rather than the
 * request. It is not reachable from the UI — the browser refuses first, so the
 * sign-in screen is never reached with a direct route — which is exactly why it
 * would rot unnoticed without this.
 */
describe('signing in under Require proxies', () => {
	const source = readFileSync(join(__dirname, '../src/main/confirmations/ipc.ts'), 'utf8');

	it('refuses a direct sign-in', () => {
		expect(source).toMatch(/route === 'direct' && vault\.settings\(\)\.requireProxies/);
	});

	it('refuses before the password is used', () => {
		// The throw sits above the `confirmations.signIn` call, not in its catch:
		// a sign-in sent and then reported would already have put the password on
		// the connection this setting exists to keep it off.
		const guard = source.indexOf('requireProxies');
		const call = source.indexOf('confirmations.signIn(');
		expect(guard, 'the guard runs after the sign-in').toBeLessThan(call);
	});

	it('says the same thing the browser says', () => {
		// One message for one setting. Two sentences for one cause reads as two
		// different problems.
		expect(source).toContain('DIRECT_REFUSED');
	});
});
