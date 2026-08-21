import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../src/main/confirmations/activity';
import type { ConfirmationSummary } from '../src/shared/ipc';

/**
 * What automatic confirmation did while nobody was watching.
 *
 * This exists because the engine was computing held-back confirmations and
 * dropping them — the callbacks were wired to nothing, so a refused
 * account-recovery confirmation was calculated and discarded. The tests that
 * matter are about that entry surviving and being marked urgent.
 */

const NOW = Date.parse('2026-08-10T12:00:00Z');

function confirmation(overrides: Partial<ConfirmationSummary> = {}): ConfirmationSummary {
	return {
		id: '1',
		type: 2,
		typeName: 'Trade',
		securityCritical: false,
		autoConfirmable: true,
		hasIcon: false,
		...overrides
	};
}

const recovery = confirmation({
	id: '9',
	type: 6,
	typeName: 'Account recovery',
	securityCritical: true,
	autoConfirmable: false
});

function log(): ActivityLog {
	return new ActivityLog(() => NOW);
}

describe('recording a pass', () => {
	it('keeps what was approved, not just how many', () => {
		const activity = log();
		activity.recordPass('76561198000000001', [confirmation({ headline: 'A knife' })], []);

		const [entry] = activity.for('76561198000000001');
		expect(entry?.kind).toBe('approved');
		expect(entry?.kind === 'approved' && entry.confirmations[0]?.headline).toBe('A knife');
	});

	it('records each held confirmation separately, not as a count', () => {
		// A held account-recovery confirmation is not a statistic.
		const activity = log();
		activity.recordPass(
			'76561198000000001',
			[],
			[{ confirmation: recovery, reason: 'never automatic' }]
		);

		const entries = activity.for('76561198000000001');
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe('held');
	});

	it('writes nothing when a pass did nothing', () => {
		const activity = log();
		activity.recordPass('76561198000000001', [], []);

		expect(activity.for('76561198000000001')).toEqual([]);
	});

	it('keeps accounts apart', () => {
		const activity = log();
		activity.recordPass('76561198000000001', [confirmation()], []);
		activity.recordPass('76561198000000002', [], [{ confirmation: recovery, reason: 'no' }]);

		expect(activity.for('76561198000000001')).toHaveLength(1);
		expect(activity.for('76561198000000002')[0]?.kind).toBe('held');
	});
});

describe('what counts as urgent', () => {
	it('flags a held security-critical confirmation', () => {
		// The whole reason this class exists.
		const activity = log();
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);

		expect(activity.hasUrgent()).toBe(true);
	});

	it('does NOT flag an ordinary held confirmation', () => {
		// A trade held back because trades are switched off is normal, and treating
		// it as urgent would drown the signal that is not.
		const activity = log();
		activity.recordPass(
			'76561198000000001',
			[],
			[{ confirmation: confirmation(), reason: 'trades are switched off' }]
		);

		expect(activity.hasUrgent()).toBe(false);
	});

	it('does not flag ordinary approvals or a passing failure', () => {
		const activity = log();
		activity.recordPass('76561198000000001', [confirmation()], []);
		activity.recordFailure('76561198000000001', 'Steam did not answer in time');

		expect(activity.hasUrgent()).toBe(false);
	});

	it('flags an account that has been given up on', () => {
		// A halted account is silently no longer being checked, which the user has
		// to be told or the feature has quietly stopped working.
		//
		// The flag is what decides, not the wording. This test used to pass the
		// sentence alone and rely on `/stopped/i` matching it — so the distinction
		// between "gave up entirely" and "failed once" hung on a single word in
		// prose composed in a different file.
		const activity = log();
		activity.recordFailure(
			'76561198000000001',
			'Automatic confirmation stopped for this account after 10 failures in a row.',
			true
		);

		expect(activity.for('76561198000000001')[0]?.kind).toBe('halted');
		expect(activity.hasUrgent()).toBe(true);
	});

	it('does not treat the word "stopped" in a passing error as giving up', () => {
		// The old rule would have called this a halt: Steam's own wording is not a
		// statement about whether this application has given up on the account.
		const activity = log();
		activity.recordFailure('76561198000000001', 'The Steam service stopped responding.');

		expect(activity.for('76561198000000001')[0]?.kind).toBe('failed');
	});
});

describe('bounds and ordering', () => {
	it('reports newest first, which is what someone returning wants', () => {
		const activity = new ActivityLog(
			(() => {
				let tick = NOW;
				return () => (tick += 1000);
			})()
		);

		activity.recordFailure('76561198000000001', 'first');
		activity.recordFailure('76561198000000001', 'second');

		const entries = activity.for('76561198000000001');
		expect(entries[0]?.kind === 'failed' && entries[0].reason).toBe('second');
	});

	it('does not grow without bound', () => {
		const activity = log();
		for (let index = 0; index < 250; index++) {
			activity.recordFailure('76561198000000001', `failure ${index}`);
		}

		expect(activity.for('76561198000000001').length).toBeLessThanOrEqual(100);
	});

	it('clears everything on request', () => {
		const activity = log();
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'no' }]);

		activity.clear();

		expect(activity.all()).toEqual([]);
		expect(activity.hasUrgent()).toBe(false);
	});

	it('never carries a nonce, because it only ever holds summaries', () => {
		const activity = log();
		activity.recordPass('76561198000000001', [confirmation()], []);

		expect(JSON.stringify(activity.all())).not.toContain('nonce');
	});
});

/*
 * Entries the pass could not read.
 *
 * Its own kind because there is nothing else to say about it: an entry that
 * failed to parse has no type and no summary. That is exactly why it is
 * recorded — the pass cannot rule out that what it skipped was the
 * account-recovery confirmation, and automatic confirmation is the path where
 * nobody is watching.
 */
describe('confirmations that could not be read', () => {
	it('records nothing when everything parsed', () => {
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [confirmation()], [], 0);

		expect(activity.for('76561198000000001').some((e) => e.kind === 'unreadable')).toBe(false);
	});

	it('records the count when entries were skipped', () => {
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [], [], 2);

		const entry = activity.for('76561198000000001').find((e) => e.kind === 'unreadable');
		expect(entry).toBeDefined();
		expect(entry?.kind === 'unreadable' && entry.count).toBe(2);
	});

	it('counts as urgent, because what it skipped cannot be classified', () => {
		// The whole point. Treating "we could not read it" as ordinary would be
		// assuming the best about the one case this application exists to assume the
		// worst about.
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [], [], 1);

		expect(activity.hasUrgent()).toBe(true);
	});

	it('is recorded even when the pass did nothing else', () => {
		// The silent case before this existed: the only entry Steam sent was one
		// this build could not parse, so the pass approved nothing, held nothing,
		// and wrote nothing at all.
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [], [], 1);

		expect(activity.for('76561198000000001')).toHaveLength(1);
	});

	it('can be acknowledged like any other alert', () => {
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [], [], 1);
		activity.acknowledge();

		expect(activity.hasUrgent()).toBe(false);
	});
});

/*
 * Two events in the same millisecond.
 *
 * Urgency compared `Date.parse(entry.at) > acknowledgedAtMs`. Equal timestamps
 * fail a strict comparison, so a security-critical hold recorded in the *same
 * millisecond* as an acknowledgement was treated as already seen — and an
 * automatic pass finishing as the user closes the Activity screen is exactly
 * when those two land together.
 *
 * A sequence has no granularity to fall through.
 */
describe('an alert raised in the same millisecond as an acknowledgement', () => {
	/** A clock that never advances, so every entry shares one timestamp. */
	const frozen = (): ActivityLog => new ActivityLog(() => NOW);

	it('is still urgent', () => {
		const activity = frozen();
		activity.acknowledge();
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);

		expect(activity.hasUrgent()).toBe(true);
	});

	it('is still urgent when it is an unreadable entry', () => {
		const activity = frozen();
		activity.acknowledge();
		activity.recordPass('76561198000000001', [], [], 1);

		expect(activity.hasUrgent()).toBe(true);
	});

	it('still clears when the acknowledgement genuinely comes last', () => {
		// The other half. Ordering by sequence must not make an alert undismissable.
		const activity = frozen();
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		activity.acknowledge();

		expect(activity.hasUrgent()).toBe(false);
	});

	it('does not depend on the timestamp being parseable at all', () => {
		// `at` is a display string. Urgency should not be decided by parsing it.
		const activity = frozen();
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		activity.acknowledge();
		activity.recordPass('76561198000000002', [], [{ confirmation: recovery, reason: 'never' }]);

		expect(activity.hasUrgent()).toBe(true);
	});
});

/*
 * Acknowledging only what was actually shown.
 *
 * Listing and acknowledging are two IPC round trips. `acknowledge()` advanced to
 * the latest global sequence, so an automatic pass finishing *between* them was
 * marked seen by a user who was never shown it — and what it marks seen may be a
 * held account-recovery confirmation.
 */
describe('acknowledging a snapshot rather than the present', () => {
	it('leaves an entry recorded after the snapshot urgent', () => {
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [confirmation()], []);
		// What the renderer received and drew.
		const shown = activity.watermark();

		// The pass that lands while the user is reading.
		activity.recordPass('76561198000000002', [], [{ confirmation: recovery, reason: 'never' }]);
		activity.acknowledge(shown);

		expect(activity.hasUrgent()).toBe(true);
	});

	it('still clears everything the snapshot did contain', () => {
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		activity.acknowledge(activity.watermark());

		expect(activity.hasUrgent()).toBe(false);
	});

	it('never moves backwards', () => {
		// The value arrives from the renderer. Replaying an old one must not
		// resurrect an alert the user has already discharged.
		const activity = new ActivityLog(() => NOW);
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		activity.acknowledge(activity.watermark());
		activity.acknowledge(0);

		expect(activity.hasUrgent()).toBe(false);
	});

	it('never runs ahead of what has happened', () => {
		// Likewise: a renderer claiming a future watermark must not silence entries
		// that have not been recorded yet.
		const activity = new ActivityLog(() => NOW);
		activity.acknowledge(Number.MAX_SAFE_INTEGER);
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);

		expect(activity.hasUrgent()).toBe(true);
	});
});
