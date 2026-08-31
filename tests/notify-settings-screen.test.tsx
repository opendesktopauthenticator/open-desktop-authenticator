import { describe, expect, it } from 'vitest';
import {
	isPolled,
	pollLoad,
	RATE_WARNING_BELOW_SECONDS
} from '../src/renderer/screens/AutoConfirm';
import { describeAutoConfirm } from '../src/renderer/screens/VaultHome';
import type { AccountSummary } from '../src/shared/ipc';

/**
 * **The notification settings, and the sentence that pays for the default.**
 *
 * The arithmetic and the copy are asserted directly rather than through a DOM,
 * the same way `updateAnswerIsCurrent` is: this project has no DOM runner, and
 * both are the kind of thing that can be wrong for months without anybody
 * noticing by looking.
 */

function account(overrides: Partial<AccountSummary['autoConfirm']> = {}): AccountSummary {
	return {
		steamId64: '76561198000000001',
		accountName: 'trader',
		status: 'active',
		hasRevocationCode: true,
		hasProxy: false,
		routing: 'off',
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: { enabled: false, detail: 'full' },
			...overrides
		}
	};
}

describe('which accounts count toward the rate warning', () => {
	it('counts an account that auto-confirms', () => {
		expect(isPolled(account({ trades: true }))).toBe(true);
		expect(isPolled(account({ marketListings: true }))).toBe(true);
	});

	/*
	 * The point of counting these separately. An account that only watches still
	 * costs a request per interval — it is polled exactly as hard as one that
	 * approves.
	 */
	it('counts an account that only watches', () => {
		expect(isPolled(account({ notify: { enabled: true, detail: 'full' } }))).toBe(true);
	});

	it('does not count an idle account', () => {
		expect(isPolled(account())).toBe(false);
	});
});

/**
 * **The formula, and the direction it runs in.**
 *
 * An earlier draft of this test asserted `interval × accounts`, which is the
 * reciprocal of what the screen prints: it would have expected 30 requests a
 * minute where the real answer is 8, and passed against a screen showing
 * either number.
 */
describe('what the rate warning says', () => {
	it('is requests per minute, not seconds times accounts', () => {
		const accounts = [account({ trades: true }), account({ trades: true })];
		// 60 / 15 = 4 polls a minute, twice = 8. Not 15 × 2 = 30.
		expect(pollLoad(15, accounts)).toEqual({ requestsPerMinute: 8, polled: 2 });
	});

	it('falls as the interval grows', () => {
		const accounts = [account({ trades: true })];
		expect(pollLoad(60, accounts).requestsPerMinute).toBe(1);
		expect(pollLoad(30, accounts).requestsPerMinute).toBe(2);
		expect(pollLoad(10, accounts).requestsPerMinute).toBe(6);
	});

	/*
	 * Counting every account rather than the polled ones inflates the number for
	 * a vault where most are idle, and a warning that overstates its case is one
	 * people learn to dismiss.
	 */
	it('counts only the accounts actually polled', () => {
		const accounts = [account({ trades: true }), account(), account(), account()];
		expect(pollLoad(15, accounts), 'idle accounts were counted as load').toEqual({
			requestsPerMinute: 4,
			polled: 1
		});
	});

	it('counts a watching account alongside a confirming one', () => {
		const accounts = [
			account({ trades: true }),
			account({ notify: { enabled: true, detail: 'count' } })
		];
		expect(pollLoad(15, accounts).polled).toBe(2);
	});

	it('says nothing about a vault with nothing switched on', () => {
		expect(pollLoad(15, [account(), account()])).toEqual({ requestsPerMinute: 0, polled: 0 });
	});

	/*
	 * The default interval is 15, which is below the threshold — so the warning
	 * shows at the value most people never change. That is honest and is
	 * deliberately not special-cased away.
	 */
	it('has a threshold the default sits below', () => {
		expect(RATE_WARNING_BELOW_SECONDS).toBe(30);
		expect(15).toBeLessThan(RATE_WARNING_BELOW_SECONDS);
		expect(30).not.toBeLessThan(RATE_WARNING_BELOW_SECONDS);
	});
});

/**
 * **An account that watches is not an account that does nothing.**
 *
 * The row printed `auto-confirm: off` for an account being polled every fifteen
 * seconds and raising toasts — true about auto-confirm, wrong about the
 * account, and the reading that makes somebody switch a feature on twice.
 */
describe('what the account row says', () => {
	const watching = { enabled: true, detail: 'full' } as const;
	const quiet = { enabled: false, detail: 'full' } as const;

	/*
	 * The cases below are meant to be exhaustive over the branches of
	 * describeAutoConfirm, not a sample of them. It approves one of four shapes —
	 * nothing, trades, market, both — and is either watching or quiet, so there
	 * are eight strings it can return and there is a case here for each one.
	 *
	 * It is written that way because sampling is what let the real bug through.
	 * The one shape nobody had asserted was trades + market + watching, the
	 * most-enabled an account gets; dropping its ", notifying" suffix made that
	 * row read identically to an account with notifications switched off, and the
	 * whole suite stayed green. A branch added to the function later without a
	 * case added here should look conspicuously missing against this list.
	 *
	 * **Exhaustive over approve-shape × `enabled`, and that is two of the three
	 * axes.** Every case below fixes `detail` at `full`, so a branch keyed on
	 * `detail` would not look missing at all — it would look covered. That axis
	 * gets its own case immediately below rather than multiplying these eight by
	 * three, because the property there is the opposite one: `detail` decides how
	 * much a *toast* says and must make no difference to this row.
	 */

	/*
	 * A `count`-detail account is watching just as much as a `full`-detail one.
	 * Gating the suffix on `detail === 'full'` leaves every case below green
	 * while an enabled-at-count account prints `auto-confirm: off` — the same
	 * understatement, reached by the one axis the eight cases hold fixed.
	 */
	it.each(['count', 'type', 'full'] as const)(
		'says an account is notifying whatever its detail is set to (%s)',
		(detail) => {
			expect(
				describeAutoConfirm({
					marketListings: true,
					trades: true,
					pollIntervalSeconds: 15,
					notify: { enabled: true, detail }
				}),
				`a watching account set to ${detail} detail read as quieter than it is`
			).toBe('auto-confirm: trades + market, notifying');
		}
	);

	it('says off only when nothing at all is on', () => {
		expect(
			describeAutoConfirm({
				marketListings: false,
				trades: false,
				pollIntervalSeconds: 15,
				notify: quiet
			})
		).toBe('auto-confirm: off');
	});

	it('does not say off for an account that is watching', () => {
		const said = describeAutoConfirm({
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: watching
		});
		expect(said, 'a watching account read as doing nothing').not.toContain('off');
		expect(said).toContain('notifying');
	});

	/*
	 * And it must not claim to approve anything, because it does not.
	 */
	it('says plainly that a watching account approves nothing', () => {
		expect(
			describeAutoConfirm({
				marketListings: false,
				trades: false,
				pollIntervalSeconds: 15,
				notify: watching
			})
		).toBe('notifying, approving nothing');
	});

	it('leads with what is approved when both apply', () => {
		expect(
			describeAutoConfirm({
				marketListings: false,
				trades: true,
				pollIntervalSeconds: 15,
				notify: watching
			})
		).toBe('auto-confirm: trades, notifying');
	});

	it('is unchanged for an account that only auto-confirms', () => {
		expect(
			describeAutoConfirm({
				marketListings: true,
				trades: true,
				pollIntervalSeconds: 15,
				notify: quiet
			})
		).toBe('auto-confirm: trades + market');
	});

	/*
	 * The branch that had no case. Everything switched on is the account with the
	 * most going on behind it, and it is the one whose ", notifying" suffix can go
	 * missing without any other case noticing: the row then says exactly what a
	 * quiet trades + market account says, so the loudest account in the vault is
	 * indistinguishable from a silent one and reads as doing less than it does.
	 */
	it('still says it is notifying when both auto types are on', () => {
		expect(
			describeAutoConfirm({
				marketListings: true,
				trades: true,
				pollIntervalSeconds: 15,
				notify: watching
			}),
			'the most-enabled account read exactly like one with notifications off'
		).toBe('auto-confirm: trades + market, notifying');
	});

	it('says trades alone for a quiet account that approves only trades', () => {
		expect(
			describeAutoConfirm({
				marketListings: false,
				trades: true,
				pollIntervalSeconds: 15,
				notify: quiet
			}),
			'a silent trades-only account was described as notifying, or as approving market listings'
		).toBe('auto-confirm: trades');
	});

	/*
	 * Market on its own is the shape that reaches the third branch. Nothing else
	 * in this describe does, so without these two an edit there — the wrong noun,
	 * a lost suffix — would land in the account row unchallenged.
	 */
	it('names market on its own, and still says it is notifying', () => {
		expect(
			describeAutoConfirm({
				marketListings: true,
				trades: false,
				pollIntervalSeconds: 15,
				notify: watching
			}),
			'a watching market-only account lost either the market listings or the notifications'
		).toBe('auto-confirm: market, notifying');
	});

	it('names market on its own for a quiet account', () => {
		expect(
			describeAutoConfirm({
				marketListings: true,
				trades: false,
				pollIntervalSeconds: 15,
				notify: quiet
			}),
			'a silent market-only account was described as notifying, or as approving trades'
		).toBe('auto-confirm: market');
	});
});
