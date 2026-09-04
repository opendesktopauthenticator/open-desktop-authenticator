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

	/*
	 * **Asserted against a summary carrying one, or it asserts nothing.**
	 *
	 * This used to hand `recordPass` the local `confirmation()` fixture, which
	 * has no `nonce` key — so it was a statement about the fixture, not about
	 * `ActivityLog`, and no change to activity.ts could turn it red. The log
	 * stores what it is given, by reference, and filters nothing; the stripping
	 * genuinely happens in `toSummary` in service.ts, and that is where it is
	 * covered (tests/confirmation-service.test.ts).
	 *
	 * Kept, but pointed at the true statement: **whatever reaches this class is
	 * what leaves it**, so nothing may hand it anything but a summary. Feed it a
	 * leaky object and it comes straight back out — which is the thing a reader
	 * needs to know before adding a caller.
	 */
	it('stores what it is handed, so only summaries may be handed to it', () => {
		const activity = log();
		const leaky = { ...confirmation(), nonce: 'a-secret-nonce' } as ConfirmationSummary;
		activity.recordPass('76561198000000001', [leaky], []);

		expect(
			JSON.stringify(activity.all()),
			'the log now filters its input, so this test should assert what it filters'
		).toContain('a-secret-nonce');
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

/**
 * **"Sign in again" is the one condition no amount of retrying resolves.**
 *
 * It used to reach the log as a `failed` entry, and `failed` is not urgent — so
 * the only condition that genuinely needs a person was the one the badge stayed
 * quiet about. It surfaced after ten strikes as a `halted` entry phrased
 * "failures in a row", which is not what happened.
 */
describe('a session that needs signing in again', () => {
	const ID = '76561198000000001';

	it('is its own kind, not a failure', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		expect(log.for(ID)[0]?.kind).toBe('signInRequired');
	});

	it('is urgent', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		expect(log.hasUrgent(), 'the one condition only the user can fix was not urgent').toBe(true);
	});

	/*
	 * A poll runs every fifteen seconds and this condition persists until
	 * somebody signs in. A plain append would write hundreds of identical entries
	 * and push everything else out of a hundred-entry log.
	 */
	it('writes one entry per run, not one per poll', () => {
		const log = new ActivityLog(() => NOW);
		for (let i = 0; i < 50; i += 1) {
			log.recordSignInRequired(ID);
		}
		expect(log.for(ID), 'a persistent condition was appended once per poll').toHaveLength(1);
	});

	/*
	 * The run ends when something else happens. A second expiry after a working
	 * poll is a new event and has to be visible as one.
	 */
	it('appends again after a successful poll in between', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.recordPass(ID, [confirmation()], [], 0);
		log.recordSignInRequired(ID);
		expect(log.for(ID).filter((entry) => entry.kind === 'signInRequired')).toHaveLength(2);
	});

	it('appends again after a failure in between', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.recordFailure(ID, 'steam said no');
		log.recordSignInRequired(ID);
		expect(log.for(ID).filter((entry) => entry.kind === 'signInRequired')).toHaveLength(2);
	});

	it('keeps accounts apart', () => {
		const log = new ActivityLog(() => NOW);
		const other = '76561198000000002';
		log.recordSignInRequired(ID);
		log.recordSignInRequired(other);
		log.recordSignInRequired(ID);
		expect(log.for(ID)).toHaveLength(1);
		expect(log.for(other)).toHaveLength(1);
	});

	/*
	 * **Keyed on the kind, never on the text.** Classification by message text
	 * was removed from `recordFailure` once already, because the wording is
	 * composed in another file — reword it and the classification silently
	 * changes with nothing failing to show it.
	 */
	it('carries no reason string to be classified by', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		expect(Object.keys(log.for(ID)[0] ?? {}).sort()).toEqual(['at', 'kind']);
	});

	/*
	 * Deduplicating by state rather than by transition. Acknowledging advances a
	 * high-water mark, so a transition-only entry would make a still-broken
	 * account read as clear until it flipped and flipped back.
	 */
	it('stays acknowledgeable without going silent about a live problem', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		expect(log.hasUrgent()).toBe(true);
		log.acknowledge();
		expect(log.hasUrgent()).toBe(false);

		// The condition is still live, and the next distinct event re-raises it.
		log.recordFailure(ID, 'steam said no');
		log.recordSignInRequired(ID);
		expect(log.hasUrgent(), 'a second expiry after an acknowledgement said nothing').toBe(true);
	});
});

/**
 * **A second expiry, after the first was acknowledged, must speak again.**
 *
 * The dedup used to ask "is the newest entry `signInRequired`?", which assumed
 * every successful poll writes something. Most write nothing: a notify-only
 * poll writes nothing by design, and a confirm pass that approved nothing and
 * held nothing back writes nothing either. So the newest entry stayed
 * `signInRequired` for ever, and the account that expired, was acknowledged,
 * recovered and expired **again** produced no entry and no badge.
 *
 * The old test for this passed `recordPass` a non-empty `approved` array, which
 * does write an entry — so it exercised the one path the bug was not on.
 */
describe('an expiry after a recovery', () => {
	const ID = '76561198000000001';

	it('speaks again after a poll that succeeded and wrote nothing', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.acknowledge();
		// A quiet confirm pass: nothing approved, nothing held, nothing unreadable.
		log.recordPass(ID, [], [], 0);
		expect(log.for(ID), 'the quiet pass should have written nothing').toHaveLength(1);

		log.recordSignInRequired(ID);
		expect(
			log.for(ID).filter((entry) => entry.kind === 'signInRequired'),
			'the second expiry was swallowed'
		).toHaveLength(2);
		expect(log.hasUrgent(), 'the badge stayed silent on a live expired session').toBe(true);
	});

	/*
	 * The notify arm writes no activity entry at all, so this is its only
	 * success signal.
	 */
	it('speaks again after a notify-only poll succeeded', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.acknowledge();
		log.notePollSucceeded(ID);
		log.recordSignInRequired(ID);
		expect(log.for(ID).filter((entry) => entry.kind === 'signInRequired')).toHaveLength(2);
		expect(log.hasUrgent()).toBe(true);
	});

	it('still writes one entry per run, not one per poll', () => {
		const log = new ActivityLog(() => NOW);
		for (let i = 0; i < 40; i += 1) {
			log.recordSignInRequired(ID);
		}
		expect(log.for(ID)).toHaveLength(1);
	});

	it('keeps runs per account', () => {
		const log = new ActivityLog(() => NOW);
		const other = '76561198000000002';
		log.recordSignInRequired(ID);
		log.recordSignInRequired(other);
		log.notePollSucceeded(ID);
		log.recordSignInRequired(ID);
		// The other account's run was never ended, so it stays deduplicated.
		log.recordSignInRequired(other);
		expect(log.for(ID)).toHaveLength(2);
		expect(log.for(other)).toHaveLength(1);
	});

	/*
	 * Acknowledging is the user saying "I have read this", not "this is fixed".
	 * Re-arming the run on acknowledge would write a duplicate on the next poll.
	 */
	it('does not re-arm on acknowledge alone', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.acknowledge();
		log.recordSignInRequired(ID);
		expect(log.for(ID)).toHaveLength(1);
	});

	it('forgets open runs when the log is cleared', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.clear();
		log.recordSignInRequired(ID);
		expect(log.for(ID)).toHaveLength(1);
	});
});

/**
 * **An open run outlived the account it belonged to.**
 *
 * Nothing cleared `signInOpen` per account, so removing an account and adding
 * it back — which arrives with no saved session and therefore expires on its
 * first poll — found the run still open, wrote no entry and lit no badge.
 * Silence on exactly the condition this class exists to stop being silent
 * about, at the moment the user is most likely to be watching.
 */
describe('an account that is removed and added back', () => {
	const ID = '76561198000000001';

	it('reports its expired session as a new run', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.acknowledge();

		log.forgetAccount(ID);

		log.recordSignInRequired(ID);
		expect(log.for(ID), 'the re-added account inherited the old open run').toHaveLength(1);
		expect(log.hasUrgent(), 'the badge stayed dark on a live expired session').toBe(true);
	});

	/*
	 * And its old entries go. They described an account the vault no longer
	 * holds, and the Activity screen went on listing its trades.
	 */
	it('drops the entries that described the account that left', () => {
		const log = new ActivityLog(() => NOW);
		log.recordPass(ID, [confirmation()], [], 0);
		expect(log.for(ID)).toHaveLength(1);

		log.forgetAccount(ID);
		expect(log.for(ID), 'a removed account kept its history').toEqual([]);
	});

	it('leaves other accounts alone', () => {
		const log = new ActivityLog(() => NOW);
		const other = '76561198000000002';
		log.recordPass(ID, [confirmation()], [], 0);
		log.recordPass(other, [confirmation()], [], 0);

		log.forgetAccount(ID);
		expect(log.for(other), "removing one account cleared another's history").toHaveLength(1);
	});
});

/**
 * **An account that is re-routed has not left.**
 *
 * One call served both, and the seam that calls it — `dropAccountRouting` —
 * runs on a proxy save and on re-import as well as on removal. So the ordinary
 * repair for a dead proxy, pasting a replacement, deleted the account's entire
 * activity history: an unacknowledged held account-recovery confirmation gone,
 * the badge dark, the screen empty, and nothing anywhere saying that something
 * had been discarded. The strongest warning this application can raise,
 * destroyed by a settings save.
 */
describe('an account whose routing changed', () => {
	const ID = '76561198000000001';

	it('keeps the history, because the account is still here', () => {
		const log = new ActivityLog(() => NOW);
		log.recordPass(ID, [], [{ confirmation: recovery, reason: 'needs a person' }], 0);
		expect(log.hasUrgent()).toBe(true);

		log.forgetRuns(ID);

		expect(log.for(ID), 'a routing change threw away the account history').toHaveLength(1);
		expect(log.hasUrgent(), 'a routing change discharged an unread urgent warning').toBe(true);
	});

	/*
	 * The runs still go: a session held open over the old proxy says nothing
	 * about the new one, so the first expiry after the change must be reported.
	 */
	it('still reports an expiry after it as a new run', () => {
		const log = new ActivityLog(() => NOW);
		log.recordSignInRequired(ID);
		log.acknowledge();

		log.forgetRuns(ID);

		log.recordSignInRequired(ID);
		expect(log.for(ID), 'the re-routed account inherited the old open run').toHaveLength(2);
		expect(log.hasUrgent(), 'the badge stayed dark on a live expired session').toBe(true);
	});

	/*
	 * And the per-run dedup, for the same reason. A confirmation held over the
	 * old route is news again over the new one — the route is the likeliest
	 * cause of the hold.
	 */
	it('says a still-held confirmation again after it', () => {
		const log = new ActivityLog(() => NOW);
		const held = [{ confirmation: recovery, reason: 'needs a person' }];
		log.recordPass(ID, [], held, 0);
		log.recordPass(ID, [], held, 0);
		expect(log.for(ID), 'the dedup is not working at all').toHaveLength(1);

		log.forgetRuns(ID);
		log.recordPass(ID, [], held, 0);

		expect(log.for(ID), 'the hold was not re-reported after the route changed').toHaveLength(2);
	});
});

/**
 * **A pass reports state; this log records events.**
 *
 * `runAutoConfirm` returns what is *currently* pending, so a confirmation the
 * policy holds back comes round on every poll, and an entry Steam sent that
 * this build cannot parse stays unparseable until somebody looks. Appending
 * both unconditionally wrote four entries a minute at the default interval.
 *
 * The noise is the smaller half. `MAX_ENTRIES_PER_ACCOUNT` is 100, so within
 * half an hour the flood evicts everything before it — including the held
 * account-recovery confirmation this class exists to preserve. And every
 * appended entry outranks `acknowledgedSeq`, so the badge went dark on
 * acknowledge and lit again on the next poll, for ever.
 */
describe('a pass that keeps finding the same thing', () => {
	const ID = '76561198000000001';
	const critical = confirmation({ id: '9', type: 6, securityCritical: true });

	it('records a held confirmation once, not once per poll', () => {
		const log = new ActivityLog(() => NOW);
		for (let i = 0; i < 50; i += 1) {
			log.recordPass(ID, [], [{ confirmation: critical, reason: 'never automatic' }], 0);
		}
		expect(log.for(ID), 'one held confirmation wrote fifty entries').toHaveLength(1);
	});

	it('records an unreadable count once, not once per poll', () => {
		const log = new ActivityLog(() => NOW);
		for (let i = 0; i < 50; i += 1) {
			log.recordPass(ID, [], [], 2);
		}
		expect(log.for(ID)).toHaveLength(1);
	});

	/*
	 * The consequence that matters: the loudest warning the app can raise must
	 * survive a long-running session.
	 */
	it('keeps the account-recovery warning through a long session', () => {
		const log = new ActivityLog(() => NOW);
		log.recordPass(ID, [], [{ confirmation: critical, reason: 'never automatic' }], 0);
		for (let i = 0; i < 200; i += 1) {
			log.recordPass(ID, [], [{ confirmation: critical, reason: 'never automatic' }], 1);
		}

		const held = log
			.for(ID)
			.filter((entry) => entry.kind === 'held' && entry.confirmation.securityCritical);
		expect(held, 'the takeover warning was evicted by its own repetitions').toHaveLength(1);
	});

	/*
	 * And the badge must be dischargeable. Every appended entry outranks the
	 * acknowledgement watermark, so a per-poll append made "I have read this"
	 * impossible to express.
	 */
	it('stays acknowledged while nothing new happens', () => {
		const log = new ActivityLog(() => NOW);
		log.recordPass(ID, [], [{ confirmation: critical, reason: 'never automatic' }], 0);
		expect(log.hasUrgent()).toBe(true);
		log.acknowledge();
		expect(log.hasUrgent()).toBe(false);

		for (let i = 0; i < 20; i += 1) {
			log.recordPass(ID, [], [{ confirmation: critical, reason: 'never automatic' }], 0);
		}
		expect(log.hasUrgent(), 'the badge relit itself on an unchanged state').toBe(false);
	});

	/*
	 * Resolved and returning is a genuinely new event, on both counts.
	 */
	it('says it again when a held confirmation is resolved and comes back', () => {
		const log = new ActivityLog(() => NOW);
		const held = [{ confirmation: critical, reason: 'never automatic' }];
		log.recordPass(ID, [], held, 0);
		log.recordPass(ID, [], [], 0);
		log.recordPass(ID, [], held, 0);
		expect(log.for(ID).filter((entry) => entry.kind === 'held')).toHaveLength(2);
	});

	it('says it again when the unreadable count rises', () => {
		const log = new ActivityLog(() => NOW);
		log.recordPass(ID, [], [], 1);
		log.recordPass(ID, [], [], 1);
		log.recordPass(ID, [], [], 3);
		expect(log.for(ID).filter((entry) => entry.kind === 'unreadable')).toHaveLength(2);
	});

	it('says it again after the unreadable count returns to zero', () => {
		const log = new ActivityLog(() => NOW);
		log.recordPass(ID, [], [], 2);
		log.recordPass(ID, [], [], 0);
		log.recordPass(ID, [], [], 2);
		expect(log.for(ID).filter((entry) => entry.kind === 'unreadable')).toHaveLength(2);
	});

	it('still records an approval every time, because each is its own event', () => {
		const log = new ActivityLog(() => NOW);
		for (let i = 0; i < 3; i += 1) {
			log.recordPass(ID, [confirmation({ id: String(i) })], [], 0);
		}
		expect(log.for(ID).filter((entry) => entry.kind === 'approved')).toHaveLength(3);
	});
});

/**
 * **A held account-recovery confirmation must not be evicted by ordinary
 * traffic.**
 *
 * It is recorded exactly once — `reported.held` suppresses every later pass
 * while it is still held, because re-recording it four times a minute would
 * bury everything else. The trim then took the oldest hundred entries whatever
 * they were, so a busy account pushed the held entry out and could never write
 * it again: `hasUrgent()` went back to false and the badge went dark while the
 * confirmation was still sitting on Steam waiting for somebody to look.
 *
 * The class docblock names that exact outcome as the thing this log exists to
 * prevent. Fixing the self-inflicted flood is what turned the eviction from
 * self-healing into permanent.
 */
describe('a held confirmation under a flood of ordinary ones', () => {
	const ID = '76561198000000001';
	const holding = [{ confirmation: recovery, reason: 'account recovery' }];

	it('is still urgent after far more approvals than the log can hold', () => {
		const activity = log();

		activity.recordPass(ID, [], holding);
		expect(activity.hasUrgent(), 'the hold was never recorded, so this asserts nothing').toBe(true);

		// Every later pass approves a market listing and re-reports the same hold.
		for (let i = 0; i < 150; i += 1) {
			activity.recordPass(ID, [confirmation({ id: `listing-${i}` })], holding);
		}

		expect(
			activity.hasUrgent(),
			'the account-recovery hold was evicted by routine approvals and can never be recorded ' +
				'again, so the badge goes dark while the confirmation is still held on Steam'
		).toBe(true);
	});

	it('still bounds the log', () => {
		const activity = log();
		activity.recordPass(ID, [], holding);
		for (let i = 0; i < 300; i += 1) {
			activity.recordPass(ID, [confirmation({ id: `listing-${i}` })], holding);
		}

		expect(
			activity.for(ID).length,
			'protecting the hold let the log grow without limit'
		).toBeLessThanOrEqual(100);
	});

	/*
	 * And an account with nothing but holds is still bounded — the last resort
	 * drops the oldest hold and releases its id, so the next pass records it
	 * again rather than going quiet about a confirmation that is still held.
	 */
	it('stays urgent even when every entry is a hold', () => {
		const activity = log();
		for (let i = 0; i < 150; i += 1) {
			activity.recordPass(
				ID,
				[],
				[{ confirmation: confirmation({ id: `hold-${i}` }), reason: 'x' }]
			);
		}
		activity.recordPass(ID, [], holding);

		expect(activity.for(ID).length).toBeLessThanOrEqual(100);
		expect(activity.hasUrgent()).toBe(true);
	});
});

/**
 * **Protecting the held entries must not make them re-record themselves.**
 *
 * `recordPass` holds `reported.get(id)` as `seen` and tests `seen.held` for each
 * confirmation in the batch; `push` reaches `trim` synchronously inside that
 * loop. So a trim that deletes from `seen.held` is mutating the very set the
 * loop is still consulting — and once every entry in the list is a hold, the
 * preference pass finds nothing to drop and the last resort evicts an older
 * hold, releasing an id the batch has not reached yet. That one is recorded
 * again in the same pass, which evicts the next, and the cascade runs to the end
 * of the batch.
 *
 * The result is a log that rewrites itself on every unchanged poll, and a badge
 * that relights the moment it is acknowledged — which is precisely what the
 * `reported` docblock says the dedup exists to prevent.
 */
describe('an account holding back more confirmations than the log can keep', () => {
	const ID = '76561198000000001';
	const many = Array.from({ length: 101 }, (_, i) => ({
		confirmation: confirmation({ id: `held-${i}` }),
		reason: 'trades are switched off'
	}));

	it('writes nothing new when the same ones are still held', () => {
		const activity = log();

		activity.recordPass(ID, [], many);
		const afterFirst = activity.watermark();
		expect(afterFirst, 'nothing was recorded at all, so this asserts nothing').toBeGreaterThan(0);

		activity.recordPass(ID, [], many);
		activity.recordPass(ID, [], many);

		expect(
			activity.watermark() - afterFirst,
			'the same unchanged poll rewrote the whole held set, so the log churns a hundred entries ' +
				'every fifteen seconds for the life of the process'
		).toBe(0);
	});

	it('lets an acknowledged badge stay discharged', () => {
		const activity = log();
		const critical = { confirmation: recovery, reason: 'account recovery' };

		activity.recordPass(ID, [], [...many, critical]);
		expect(activity.hasUrgent(), 'nothing was urgent, so this asserts nothing').toBe(true);

		activity.acknowledge(activity.watermark());
		expect(activity.hasUrgent()).toBe(false);

		// The same confirmations are still held. Nothing new has happened.
		activity.recordPass(ID, [], [...many, critical]);

		expect(
			activity.hasUrgent(),
			'the badge relit on an unchanged poll, so it can never be discharged'
		).toBe(false);
	});

	/*
	 * And the guarantee this trim exists for still holds: the security-critical
	 * hold is the one entry that must survive the crowd.
	 */
	it('still keeps the security-critical hold', () => {
		const activity = log();
		const critical = { confirmation: recovery, reason: 'account recovery' };

		activity.recordPass(ID, [], [critical, ...many]);

		expect(
			activity.for(ID).some((e) => e.kind === 'held' && e.confirmation.id === recovery.id),
			'the account-recovery hold was crowded out by ordinary ones'
		).toBe(true);
	});
});

/**
 * An eviction is not a resolution.
 *
 * The bounded log can eventually contain a hundred later urgent events. When
 * that happens even the oldest urgent entry has to make room, but a live Steam
 * confirmation must become eligible to be recorded again. Keeping its id in
 * `reported.held` after its only row is gone makes the loss permanent.
 */
describe('a live critical hold that is evicted by later urgent history', () => {
	const ID = '76561198000000001';
	const holding = [{ confirmation: recovery, reason: 'account recovery' }];

	it('records the still-pending hold again on the next poll', () => {
		const activity = log();
		activity.recordPass(ID, [], holding);

		// Urgent history is retained ahead of ordinary entries, but the cap still
		// applies. A long-running account can reach this across repeated incidents.
		for (let i = 0; i < 100; i += 1) {
			activity.recordFailure(ID, `halted run ${i}`, true);
		}

		expect(
			activity
				.for(ID)
				.some((entry) => entry.kind === 'held' && entry.confirmation.id === recovery.id),
			'the premise did not evict the original row'
		).toBe(false);
		activity.acknowledge(activity.watermark());
		expect(activity.hasUrgent()).toBe(false);

		activity.recordPass(ID, [], holding);

		expect(
			activity
				.for(ID)
				.filter((entry) => entry.kind === 'held' && entry.confirmation.id === recovery.id)
		).toHaveLength(1);
		expect(activity.hasUrgent(), 'the live recovery confirmation stayed permanently hidden').toBe(
			true
		);
		expect(activity.for(ID)).toHaveLength(100);
	});

	it('does not re-add an evicted hold inside the same batch', () => {
		const activity = log();
		const critical = Array.from({ length: 101 }, (_, i) => ({
			confirmation: confirmation({ id: `recovery-${i}`, securityCritical: true }),
			reason: 'account recovery'
		}));

		activity.recordPass(ID, [], critical);

		expect(activity.for(ID)).toHaveLength(100);
		expect(
			activity.watermark(),
			'releasing ids synchronously made the first batch rewrite itself while it was still iterating'
		).toBe(101);
	});

	it('does not confuse an evicted historical row with the live row for the same id', () => {
		const activity = log();
		activity.recordPass(ID, [], holding);
		activity.recordPass(ID, [], []);
		activity.recordPass(ID, [], holding);

		// Evict the first occurrence while the newer occurrence remains in the log.
		for (let i = 0; i < 99; i += 1) {
			activity.recordFailure(ID, `later urgent event ${i}`, true);
		}
		expect(
			activity
				.for(ID)
				.filter((entry) => entry.kind === 'held' && entry.confirmation.id === recovery.id)
		).toHaveLength(1);

		activity.acknowledge(activity.watermark());
		const before = activity.watermark();
		activity.recordPass(ID, [], holding);

		expect(activity.watermark()).toBe(before);
		expect(activity.hasUrgent(), 'an unchanged live row was mistaken for a new warning').toBe(
			false
		);
	});
});

/** An unreadable entry is just as current as a held id: eviction is not resolution. */
describe('a live unreadable condition that is evicted by later urgent history', () => {
	const ID = '76561198000000001';

	it('records the unchanged unreadable condition again on the next poll', () => {
		const activity = log();
		activity.recordPass(ID, [], [], 1);

		for (let i = 0; i < 100; i += 1) {
			activity.recordFailure(ID, `later urgent event ${i}`, true);
		}
		expect(
			activity.for(ID).some((entry) => entry.kind === 'unreadable'),
			'the premise did not evict the unreadable row'
		).toBe(false);

		activity.acknowledge(activity.watermark());
		expect(activity.hasUrgent()).toBe(false);
		activity.recordPass(ID, [], [], 1);

		expect(activity.for(ID).filter((entry) => entry.kind === 'unreadable')).toHaveLength(1);
		expect(activity.hasUrgent(), 'the unreadable condition stayed permanently hidden').toBe(true);
		expect(activity.for(ID)).toHaveLength(100);
	});
});

/**
 * **An urgent entry arriving into a full log must not be deleted on arrival.**
 *
 * The first version of the trim dropped "anything that is not a hold" before any
 * hold — and `halted`, `unreadable` and `signInRequired` are not holds, though
 * `hasUrgent` counts all three. So with a hundred ordinary holds already
 * recorded, a sign-in expiring wrote an entry that the very same trim spliced
 * straight back out, and the dedup upstream had already marked it reported.
 */
describe('an urgent entry arriving into a full log', () => {
	const ID = '76561198000000001';
	const crowd = Array.from({ length: 100 }, (_, i) => ({
		confirmation: confirmation({ id: `held-${i}` }),
		reason: 'trades are switched off'
	}));

	it('survives a log already full of ordinary holds', () => {
		const activity = log();
		activity.recordPass(ID, [], crowd);
		expect(activity.for(ID)).toHaveLength(100);

		activity.recordSignInRequired(ID);

		expect(
			activity.for(ID).some((entry) => entry.kind === 'signInRequired'),
			'the sign-in notice was spliced out by the same push that added it, and nothing will ' +
				'write it again'
		).toBe(true);
		expect(activity.hasUrgent(), 'and the badge never lit for it').toBe(true);
	});

	it('so does a halt', () => {
		const activity = log();
		activity.recordPass(ID, [], crowd);

		activity.recordFailure(ID, 'ten consecutive failures', true);

		expect(activity.for(ID).some((entry) => entry.kind === 'halted')).toBe(true);
		expect(activity.hasUrgent()).toBe(true);
	});

	it('and the log is still capped', () => {
		const activity = log();
		activity.recordPass(ID, [], crowd);
		activity.recordSignInRequired(ID);
		activity.recordFailure(ID, 'ten consecutive failures', true);

		expect(activity.for(ID).length).toBeLessThanOrEqual(100);
	});
});
