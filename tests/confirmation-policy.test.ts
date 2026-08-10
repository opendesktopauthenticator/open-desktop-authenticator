import { describe, expect, it } from 'vitest';
import {
	AUTO_CONFIRMABLE,
	CONFIRMATION_TYPES,
	describeType,
	isAutoConfirmable,
	isSecurityCritical,
	mayAutoConfirm,
	NEVER_AUTO_CONFIRMABLE,
	partitionForAutoConfirm
} from '../src/main/confirmations/policy';

/**
 * Invariant S16 (§11), the one finding from Phase 0 that could cost someone
 * their account.
 *
 * Mobile confirmations are not only trades and market listings. Account-recovery
 * confirmations — how an attacker taking your account asks you to approve it —
 * arrive on the same endpoint, as **type 6** in live testing (F-12).
 *
 * `steamcommunity`'s own `EConfirmationType` lists only 2 and 3. Type 6 is not
 * in it. So the tests that matter most here are the ones about types nobody has
 * named yet: the rule has to be positive and closed, or a new Valve type becomes
 * an approved takeover.
 */

const BOTH_ON = { marketListings: true, trades: true };
const BOTH_OFF = { marketListings: false, trades: false };

describe('the closed rule', () => {
	it('never auto-confirms account recovery, even with everything switched on', () => {
		// The finding. If this test ever passes an `act: true`, someone loses an
		// account.
		const decision = mayAutoConfirm({ id: '1', type: 6 }, BOTH_ON);

		expect(decision.act).toBe(false);
		expect(decision.act === false && decision.reason).toContain('Account recovery');
	});

	it('never auto-confirms a phone number change', () => {
		expect(mayAutoConfirm({ id: '1', type: 5 }, BOTH_ON).act).toBe(false);
	});

	it('never auto-confirms a type nobody has seen yet', () => {
		// Valve adding a type must make this app more cautious, not less. A default
		// of "allow" here is how an unknown becomes an approval.
		for (const type of [0, 7, 8, 42, 999, -1, 1.5]) {
			const decision = mayAutoConfirm({ id: '1', type }, BOTH_ON);
			expect(decision.act, `type ${type}`).toBe(false);
			expect(decision.act === false && decision.reason).toContain('Unrecognised');
		}
	});

	it('refuses every type outside the pair, exhaustively', () => {
		for (let type = -5; type <= 50; type++) {
			if ((AUTO_CONFIRMABLE as readonly number[]).includes(type)) {
				continue;
			}
			expect(mayAutoConfirm({ id: '1', type }, BOTH_ON).act, `type ${type}`).toBe(false);
		}
	});

	it('keeps the two lists disjoint', () => {
		for (const type of NEVER_AUTO_CONFIRMABLE) {
			expect(isAutoConfirmable(type), `type ${type}`).toBe(false);
		}
		for (const type of AUTO_CONFIRMABLE) {
			expect((NEVER_AUTO_CONFIRMABLE as readonly number[]).includes(type)).toBe(false);
		}
	});

	it('allows exactly two types, and no more', () => {
		// A guard on the constant itself. Widening this list is a decision that
		// should require editing a test that says so.
		expect([...AUTO_CONFIRMABLE]).toEqual([2, 3]);
	});
});

describe('the user is still in charge', () => {
	it('confirms a trade only when trades are switched on', () => {
		expect(mayAutoConfirm({ id: '1', type: 2 }, BOTH_ON).act).toBe(true);
		expect(mayAutoConfirm({ id: '1', type: 2 }, { ...BOTH_OFF, marketListings: true }).act).toBe(
			false
		);
	});

	it('confirms a market listing only when market listings are switched on', () => {
		expect(mayAutoConfirm({ id: '1', type: 3 }, BOTH_ON).act).toBe(true);
		expect(mayAutoConfirm({ id: '1', type: 3 }, { ...BOTH_OFF, trades: true }).act).toBe(false);
	});

	it('does nothing automatically when everything is off, which is the default', () => {
		for (const type of [2, 3]) {
			expect(mayAutoConfirm({ id: '1', type }, BOTH_OFF).act).toBe(false);
		}
	});

	it('does not let one switch enable the other type', () => {
		// Trades are the sterner consent (§12 F6). Enabling market listings must not
		// quietly bring trades with it.
		expect(mayAutoConfirm({ id: '1', type: 2 }, { marketListings: true, trades: false }).act).toBe(
			false
		);
	});

	it('always explains a refusal', () => {
		// Silence pushes people toward switching everything on to make the mystery
		// stop.
		for (const type of [1, 2, 3, 4, 5, 6, 99]) {
			const decision = mayAutoConfirm({ id: '1', type }, BOTH_OFF);
			if (!decision.act) {
				expect(decision.reason.length, `type ${type}`).toBeGreaterThan(10);
			}
		}
	});
});

describe('partitioning a batch', () => {
	const batch = [
		{ id: 'a', type: 2 },
		{ id: 'b', type: 3 },
		{ id: 'c', type: 6 },
		{ id: 'd', type: 77 }
	];

	it('holds back everything that is not explicitly allowed', () => {
		const { automatic, manual } = partitionForAutoConfirm(batch, BOTH_ON);

		expect(automatic.map((c) => c.id)).toEqual(['a', 'b']);
		expect(manual.map((m) => m.confirmation.id)).toEqual(['c', 'd']);
	});

	it('holds back everything when nothing is enabled', () => {
		const { automatic, manual } = partitionForAutoConfirm(batch, BOTH_OFF);

		expect(automatic).toEqual([]);
		expect(manual).toHaveLength(4);
	});

	it('gives a reason for every held-back confirmation', () => {
		const { manual } = partitionForAutoConfirm(batch, BOTH_ON);
		for (const held of manual) {
			expect(held.reason, `id ${held.confirmation.id}`).toBeTruthy();
		}
	});

	it('handles an empty batch', () => {
		expect(partitionForAutoConfirm([], BOTH_ON)).toEqual({ automatic: [], manual: [] });
	});

	it('preserves the fields the caller carried in', () => {
		const rich = [{ id: 'a', type: 2, creator: '12345', headline: 'A trade' }];
		const { automatic } = partitionForAutoConfirm(rich, BOTH_ON);
		expect(automatic[0]?.headline).toBe('A trade');
	});
});

describe('describing a type', () => {
	it('names the ones we know', () => {
		expect(describeType(2)).toBe('Trade');
		expect(describeType(3)).toBe('Market listing');
		expect(describeType(6)).toBe('Account recovery');
	});

	it('never pretends to recognise one it does not', () => {
		expect(describeType(77)).toBe('Unrecognised (type 77)');
	});

	it('has a name for every type in the constant', () => {
		for (const [type, name] of Object.entries(CONFIRMATION_TYPES)) {
			expect(describeType(Number(type))).toBe(name);
		}
	});
});

describe('security-critical confirmations', () => {
	it('flags the two that mean someone is taking the account', () => {
		expect(isSecurityCritical(6)).toBe(true);
		expect(isSecurityCritical(5)).toBe(true);
	});

	it('does not cry wolf on ordinary ones', () => {
		expect(isSecurityCritical(2)).toBe(false);
		expect(isSecurityCritical(3)).toBe(false);
	});
});
