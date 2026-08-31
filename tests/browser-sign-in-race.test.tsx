import { describe, expect, it } from 'vitest';
import { abandonPendingSignIns, claimSignInScreen, mayShowSignInPrompt } from '../src/renderer/App';
import { accountSummary, type AccountSummary, type OpenBrowserResult } from '../src/shared/ipc';

/**
 * **An older browser-open response replaced the user's newer sign-in screen.**
 *
 * Reproduced in a real Electron build: open accounts A and B — different rows
 * open concurrently, `VaultHome` only serialises a row against itself — let B's
 * answer arrive first and type a password into the sign-in screen it asked for,
 * then let A's older answer settle. The screen switched back to A and **erased
 * what had been typed**. A password half-entered for one Steam account,
 * replaced by a prompt about another, with nothing saying it had happened.
 *
 * The cause was that every response wrote one unsequenced `browserSignIn`
 * state, so whichever settled last won — and the order responses settle in has
 * nothing to do with which one the user is looking at.
 *
 * This is the sequencing rule itself, exercised for real: `claimSignInScreen`
 * holds the generation, so overlapping two claims here is the same overlap the
 * auditor produced by pressing two rows, and not a reading of the source.
 *
 * The other half — that the handler in `App.tsx` actually routes an open
 * through the rule, and claims *before* it asks rather than after it hears back
 * — fails separately and lives in `browser-sign-in-wiring.test.ts`. That half
 * has to be read from the source: a click handler passed to `VaultHome` never
 * runs under `renderToStaticMarkup`, which is the only rendering this project
 * has.
 */

/** Built through the real schema, so the fixture cannot drift from the type. */
function account(steamId64: string, accountName: string): AccountSummary {
	return accountSummary.parse({
		steamId64,
		accountName,
		status: 'active',
		hasRevocationCode: true,
		hasProxy: false,
		routing: 'off',
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 30,
			notify: { enabled: false, detail: 'full' }
		}
	});
}

const A = account('76561198000000001', 'account-a');
const B = account('76561198000000002', 'account-b');

const NEEDS_SIGN_IN: OpenBrowserResult = {
	signInRequired: true,
	reason: 'The saved session has expired.'
};
const OPENED: OpenBrowserResult = { signInRequired: false };

describe('two browser opens in flight at once', () => {
	/*
	 * The reproduction, in the order the auditor found it. A is pressed first, B
	 * second; B answers first and puts a sign-in screen up that the user starts
	 * typing into; A answers afterwards.
	 */
	it('discards an older answer that settles after a newer one', () => {
		const settleA = claimSignInScreen();
		const settleB = claimSignInScreen();

		expect(
			settleB(B, 'direct', NEEDS_SIGN_IN),
			'the open the user is actually waiting on could not put its screen up'
		).toEqual({ account: B, route: 'direct', reason: NEEDS_SIGN_IN.reason });

		expect(
			settleA(A, 'direct', NEEDS_SIGN_IN),
			'an older open replaced the sign-in screen the user was typing into, erasing the ' +
				'password entered for a different Steam account'
		).toBeUndefined();
	});

	/*
	 * And the same pair in the other settlement order, which was never the bug
	 * and must stay decided the same way: the claim is what orders these, not the
	 * answer. Pressing B is the user moving on from A, whether or not B has
	 * replied yet — so A's answer is stale the moment B is pressed, and letting
	 * it through would put A's screen up in front of somebody waiting for B.
	 */
	it('discards the older answer whichever of the two settles first', () => {
		const settleA = claimSignInScreen();
		const settleB = claimSignInScreen();

		expect(settleA(A, 'direct', NEEDS_SIGN_IN)).toBeUndefined();
		expect(settleB(B, 'direct', NEEDS_SIGN_IN)).toEqual({
			account: B,
			route: 'direct',
			reason: NEEDS_SIGN_IN.reason
		});
	});

	it('lets a lone open put its screen up', () => {
		const settle = claimSignInScreen();
		expect(
			settle(A, 'steam-only', NEEDS_SIGN_IN),
			'nothing had superseded this open, and it still could not ask for a password'
		).toEqual({ account: A, route: 'steam-only', reason: NEEDS_SIGN_IN.reason });
	});

	/*
	 * The generation is global rather than per account, which is the point: the
	 * screen it guards is a single one. Two opens of the *same* account order
	 * against each other for the same reason two of different accounts do.
	 */
	it('supersedes an earlier open of the same account', () => {
		const first = claimSignInScreen();
		const second = claimSignInScreen();
		expect(second(A, 'direct', NEEDS_SIGN_IN)).toBeDefined();
		expect(first(A, 'direct', NEEDS_SIGN_IN)).toBeUndefined();
	});

	it('asks for nothing when the browser opened', () => {
		const settle = claimSignInScreen();
		expect(
			settle(A, 'direct', OPENED),
			'a browser that opened still demanded a password'
		).toBeUndefined();
	});

	/*
	 * The reason travels with the prompt, and an absent one stays absent — the
	 * screen takes `reason` as optional and a present `undefined` is a different
	 * thing from a missing key to anything that checks.
	 */
	it('carries the reason, and omits it when there is none', () => {
		expect(claimSignInScreen()(A, 'direct', NEEDS_SIGN_IN)).toEqual({
			account: A,
			route: 'direct',
			reason: 'The saved session has expired.'
		});

		const bare = claimSignInScreen()(A, 'direct', { signInRequired: true });
		expect(bare).toEqual({ account: A, route: 'direct' });
		expect(
			Object.hasOwn(bare as object, 'reason'),
			'an absent reason became a present undefined'
		).toBe(false);
	});
});

/**
 * **The door the generation did not cover.**
 *
 * It is claimed by a newer *open*, which is why two rows racing each other work.
 * Ordinary navigation left it alone, and the sign-in prompt is rendered ahead of
 * the view switch — so pressing Trade, going to Settings, typing into both
 * passphrase fields, and then letting the Trade request settle as
 * `signInRequired` unmounted Settings and erased what had been typed.
 *
 * The same erasure the generation exists to prevent, through the one path it did
 * not watch. Leaving the screen now abandons what that screen started.
 */
describe('a browser open the user has navigated away from', () => {
	it('cannot put its sign-in screen up afterwards', () => {
		const settle = claimSignInScreen();

		// The user goes to Settings and starts typing.
		abandonPendingSignIns();

		expect(
			settle(A, 'direct', NEEDS_SIGN_IN),
			'a request the user had walked away from replaced the screen they were on, erasing what ' +
				'they had typed into it'
		).toBeUndefined();
	});

	it('still cannot once they have come back', () => {
		const settle = claimSignInScreen();
		abandonPendingSignIns();
		// Back to the account list. The open still belongs to a screen that has
		// been and gone; returning to the list is not the same as never leaving.
		abandonPendingSignIns();

		expect(settle(A, 'proxy', NEEDS_SIGN_IN)).toBeUndefined();
	});

	/*
	 * And an open begun after the navigation is the current one, so its answer
	 * must still land.
	 */
	it('does not block an open begun from the screen the user is on', () => {
		claimSignInScreen();
		abandonPendingSignIns();
		const settle = claimSignInScreen();

		expect(settle(B, 'direct', NEEDS_SIGN_IN)).toEqual({
			account: B,
			route: 'direct',
			reason: NEEDS_SIGN_IN.reason
		});
	});

	/*
	 * A successful open is not a screen change and must stay silent either way.
	 */
	it('says nothing for an open that succeeded', () => {
		const settle = claimSignInScreen();
		abandonPendingSignIns();
		expect(settle(A, 'direct', OPENED)).toBeUndefined();
	});
});

/**
 * **The barrier that survives the bookkeeping being deleted.**
 *
 * The generation and the effect that advances it on navigation are both things
 * somebody has to remember to keep. Effects do not run under
 * `renderToStaticMarkup` and this project has no DOM runner, so removing that
 * effect breaks nothing any test can see — which is the shape of defect this
 * repository keeps shipping.
 *
 * So the rule is stated again in the render, as a function of what is on screen
 * and nothing else. An open can only be started from the account list, so its
 * answer has no claim on any other screen whatever the counter says.
 */
describe('whether a sign-in prompt may take the window', () => {
	const PROMPT = { account: A, route: 'direct' as const };

	it('may, on the screen the open was started from', () => {
		expect(mayShowSignInPrompt(PROMPT, 'accounts')).toBe(true);
	});

	it.each(['settings', 'import', 'activity', 'enroll', 'move', 'recover', 'about'])(
		'may not, over %s',
		(view) => {
			expect(
				mayShowSignInPrompt(PROMPT, view),
				`a browser answer replaced ${view}, and any half-typed field on it went with the screen`
			).toBe(false);
		}
	);

	it('may not when there is no prompt at all', () => {
		expect(mayShowSignInPrompt(undefined, 'accounts')).toBe(false);
	});
});
