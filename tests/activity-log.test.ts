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
		const activity = log();
		activity.recordFailure(
			'76561198000000001',
			'Automatic confirmation stopped for this account after 10 failures in a row.'
		);

		expect(activity.for('76561198000000001')[0]?.kind).toBe('halted');
		expect(activity.hasUrgent()).toBe(true);
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
