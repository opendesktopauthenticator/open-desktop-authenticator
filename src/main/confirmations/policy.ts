/**
 * Which confirmations may be acted on automatically — invariant S16 (§11).
 *
 * This module exists because of F-12, the most dangerous thing Phase 0 found.
 *
 * Mobile confirmations are not only trades and market listings. The same
 * endpoint serves **account-recovery confirmations**, which is how someone who
 * has started taking your account away asks you to approve it. In live testing a
 * password-change confirmation arrived as **type 6**.
 *
 * Now look at what the ecosystem believes. `steamcommunity`'s own
 * `EConfirmationType` lists exactly two values — Trade (2) and MarketListing (3)
 * — with source comments reading "1 is unknown, possibly Invalid" and "4 is
 * opt-out or other". Type 6 is not in it at all. Any auto-confirm built on that
 * enum, or on the library's `acceptAllConfirmations()`, would approve an account
 * takeover and report success.
 *
 * So the rule here is **positive and closed**:
 *
 *  - a confirmation is auto-acted on only if its type is explicitly enabled by
 *    the user, for that account;
 *  - a type we do not recognise is never auto-acted on, no matter what;
 *  - there is no "confirm everything" path, and `acceptAllConfirmations` is
 *    banned by a test in `tests/invariants.test.ts`.
 *
 * Unknown types are surfaced to the user to approve by hand. That is the correct
 * failure mode: Valve adding a new confirmation type must make this app *more*
 * cautious, never less.
 */

/**
 * Confirmation types, as observed rather than as documented.
 *
 * Valve publishes no list. 2 and 3 are long-established; 6 was seen directly in
 * Phase 0 (F-12) on an account-recovery flow. The others are named because
 * naming them is how they become refusable — an entry here is a type we can
 * *describe*, never a type we may act on.
 */
export const CONFIRMATION_TYPES = {
	1: 'Unknown',
	2: 'Trade',
	3: 'Market listing',
	4: 'Feature opt-out',
	5: 'Phone number change',
	6: 'Account recovery'
} as const satisfies Record<number, string>;

export type ConfirmationTypeId = keyof typeof CONFIRMATION_TYPES;

/**
 * The only two types a user may ever put on automatic.
 *
 * Deliberately a hard-coded pair rather than "whatever the settings contain".
 * The settings are a persisted structure; a future migration bug, or a vault
 * written by a newer build, could put another number in there. This makes the
 * blast radius of that a rejected setting rather than an approved takeover.
 */
export const AUTO_CONFIRMABLE = [2, 3] as const;

/** Types that must always be a deliberate human act. */
export const NEVER_AUTO_CONFIRMABLE = [1, 4, 5, 6] as const;

/** What the user has switched on for one account. Mirrors `autoConfirm` in the vault. */
export interface AutoConfirmSettings {
	marketListings: boolean;
	trades: boolean;
}

/** A confirmation, reduced to what the decision actually depends on. */
export interface ConfirmationSubject {
	id: string;
	type: number;
}

export type AutoConfirmDecision =
	{ act: true; type: ConfirmationTypeId } | { act: false; reason: string };

/** Human-readable type name. Never claims to know one it does not. */
export function describeType(type: number): string {
	return (CONFIRMATION_TYPES as Record<number, string>)[type] ?? `Unrecognised (type ${type})`;
}

/** Whether this type is one the app will ever put on automatic. */
export function isAutoConfirmable(type: number): boolean {
	return (AUTO_CONFIRMABLE as readonly number[]).includes(type);
}

/**
 * The S16 decision for a single confirmation.
 *
 * Every branch that returns `act: false` carries a reason, because "why was this
 * not confirmed automatically?" is a question the user will ask, and silence
 * would push them toward switching auto-confirm on for everything.
 */
export function mayAutoConfirm(
	subject: ConfirmationSubject,
	settings: AutoConfirmSettings
): AutoConfirmDecision {
	// The closed part of the rule, and the whole reason this module exists. A type
	// we do not recognise is not a type we can reason about, so it is never ours
	// to approve — Valve introducing something new must make us more cautious.
	if (!isAutoConfirmable(subject.type)) {
		return {
			act: false,
			reason: `${describeType(subject.type)} confirmations are never approved automatically. Review it yourself.`
		};
	}

	if (subject.type === 2) {
		return settings.trades
			? { act: true, type: 2 }
			: { act: false, reason: 'automatic trade confirmation is switched off for this account.' };
	}

	if (subject.type === 3) {
		return settings.marketListings
			? { act: true, type: 3 }
			: {
					act: false,
					reason: 'automatic market-listing confirmation is switched off for this account.'
				};
	}

	// Unreachable while AUTO_CONFIRMABLE is [2, 3], and deliberately not written
	// as a `default: return {act: true}`. If a third type is ever added to that
	// list, the compiler will not catch the missing branch — so the fallback has
	// to be the safe answer rather than the convenient one.
	return {
		act: false,
		reason: `${describeType(subject.type)} confirmations have no automatic handling.`
	};
}

/**
 * Split a batch into what may be acted on and what the user must see.
 *
 * Returned as two lists rather than a filter, because the ones held back are the
 * important half: an account-recovery confirmation sitting unapproved is the
 * single most urgent thing this application can show anybody.
 */
export function partitionForAutoConfirm<T extends ConfirmationSubject>(
	confirmations: readonly T[],
	settings: AutoConfirmSettings
): { automatic: T[]; manual: { confirmation: T; reason: string }[] } {
	const automatic: T[] = [];
	const manual: { confirmation: T; reason: string }[] = [];

	for (const confirmation of confirmations) {
		const decision = mayAutoConfirm(confirmation, settings);
		if (decision.act) {
			automatic.push(confirmation);
		} else {
			manual.push({ confirmation, reason: decision.reason });
		}
	}

	return { automatic, manual };
}

/**
 * Whether a confirmation demands the user's attention rather than merely their
 * eventual review.
 *
 * Account recovery means someone is trying to take the account. Phone-number
 * changes are the usual second step. Neither is a notification to batch.
 */
export function isSecurityCritical(type: number): boolean {
	return type === 5 || type === 6;
}
