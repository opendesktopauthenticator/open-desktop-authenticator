import type { ConfirmationSummary } from '../../shared/ipc';

/**
 * What automatic confirmation did while nobody was watching (§3, THREAT_MODEL).
 *
 * The engine was computing all of this and dropping it: outcomes went to a
 * callback wired to nothing, so a held-back **account-recovery** confirmation —
 * which the threat model calls the strongest warning this application can give —
 * was calculated and discarded. That is the hole this closes.
 *
 * ## In memory, not on disk
 *
 * A persisted log of approved trades is a record of somebody's trading activity
 * sitting next to their authenticator, and it would need its own answer to
 * "where is it, who can read it, what happens at backup time". The question this
 * log exists to answer is *"what happened while I was away"*, and away means
 * hours, not months — so it lives in memory, survives a lock so it is still
 * there when the user comes back, and dies with the process.
 *
 * Nothing in here is a secret: confirmation summaries are the same shape the
 * renderer already receives, with no nonce.
 */

/** Per account. Old entries fall off rather than growing without bound. */
const MAX_ENTRIES_PER_ACCOUNT = 100;

export type ActivityEntry =
	| { kind: 'approved'; at: string; confirmations: ConfirmationSummary[] }
	/** Refused by S16. The reason is the policy's own words. */
	| { kind: 'held'; at: string; confirmation: ConfirmationSummary; reason: string }
	| { kind: 'failed'; at: string; reason: string }
	/** Too many failures in a row; this account is no longer being polled. */
	| { kind: 'halted'; at: string; reason: string }
	/**
	 * Steam sent entries this build could not parse, and the pass skipped them.
	 *
	 * A count, because there is nothing else to say: an entry that failed to parse
	 * has no type and no summary. That is precisely why it is recorded — the pass
	 * cannot rule out that what it skipped was an account-recovery confirmation.
	 */
	| { kind: 'unreadable'; at: string; count: number };

export class ActivityLog {
	private readonly entries = new Map<string, ActivityEntry[]>();

	/**
	 * A counter, not a timestamp, deciding what counts as unseen.
	 *
	 * `Date.parse(entry.at) > acknowledgedAtMs` looked equivalent and was not: two
	 * events in the same millisecond compare equal, so a security-critical hold
	 * recorded in the *same millisecond* as an acknowledgement was treated as
	 * already seen. `hasUrgent` returned false for an entry sitting right there in
	 * the log — and an automatic pass finishing as the user closes the Activity
	 * screen is exactly when those two land together.
	 *
	 * A sequence has no granularity to fall through. It also stops depending on
	 * `at` being parseable, which is a display string.
	 */
	private sequence = 0;
	/**
	 * How far the user has looked. Zero means never, so a fresh process treats
	 * every entry as unseen — right, because the log survives a lock and an unlock
	 * is exactly when an unread warning should be shown again.
	 */
	private acknowledgedSeq = 0;
	/** Each entry's position in that sequence. Weak so trimming drops them too. */
	private readonly order = new WeakMap<object, number>();

	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** Record one automatic pass. Approvals and refusals are separate entries. */
	recordPass(
		steamId64: string,
		approved: ConfirmationSummary[],
		held: { confirmation: ConfirmationSummary; reason: string }[],
		/** Entries Steam sent that this build could not read. */
		unreadable = 0
	): void {
		const at = new Date(this.now()).toISOString();

		if (unreadable > 0) {
			// Recorded first, above whatever the pass did manage to do. It is the entry
			// that says this record is incomplete, and a caveat printed under the
			// findings it qualifies has already let the reader draw a conclusion.
			this.push(steamId64, { kind: 'unreadable', at, count: unreadable });
		}

		if (approved.length > 0) {
			this.push(steamId64, { kind: 'approved', at, confirmations: approved });
		}
		for (const entry of held) {
			// One entry each, not a summary count. A held account-recovery
			// confirmation is not a statistic.
			this.push(steamId64, {
				kind: 'held',
				at,
				confirmation: entry.confirmation,
				reason: entry.reason
			});
		}
	}

	/**
	 * @param halted whether the engine has given up on this account, as opposed to
	 * hitting a passing error. The two read very differently to a user, so they are
	 * distinct entry kinds.
	 *
	 * Passed in rather than inferred. This used to run `/stopped/i` over the
	 * message text, which meant the classification depended on one word in a
	 * sentence composed in another file — reword that sentence and every "gave up
	 * entirely" quietly becomes "something went wrong once", with nothing failing
	 * to show it had happened.
	 */
	recordFailure(steamId64: string, reason: string, halted = false): void {
		const at = new Date(this.now()).toISOString();
		this.push(steamId64, { kind: halted ? 'halted' : 'failed', at, reason });
	}

	/** Newest first, because the newest is what someone returning wants. */
	for(steamId64: string): ActivityEntry[] {
		return [...(this.entries.get(steamId64) ?? [])].reverse();
	}

	/** Every account's entries, newest first, tagged with whose they are. */
	all(): { steamId64: string; entry: ActivityEntry }[] {
		const combined: { steamId64: string; entry: ActivityEntry }[] = [];
		for (const [steamId64, list] of this.entries) {
			for (const entry of list) {
				combined.push({ steamId64, entry });
			}
		}
		return combined.sort((a, b) => b.entry.at.localeCompare(a.entry.at));
	}

	/**
	 * Whether anything is waiting that a person genuinely needs to look at.
	 *
	 * Only security-critical holds count. A trade held back because the user has
	 * not enabled trades is normal and would drown the signal that matters.
	 */
	hasUrgent(): boolean {
		return this.all().some(
			({ entry }) =>
				(this.order.get(entry) ?? 0) > this.acknowledgedSeq &&
				((entry.kind === 'held' && entry.confirmation.securityCritical) ||
					entry.kind === 'halted' ||
					// **Counts as urgent, because it cannot be ruled out.** An entry that
					// failed to parse has no type, so there is no way to know it was not
					// the account-recovery confirmation. Treating "we could not read it"
					// as ordinary would be assuming the best about the one case where
					// this application's whole purpose is to assume the worst.
					entry.kind === 'unreadable')
		);
	}

	/**
	 * The user has looked at the log. Stop demanding they look at it.
	 *
	 * `hasUrgent` was "is there a critical hold or a halt anywhere in the log",
	 * with nothing able to answer yes-and-I-dealt-with-it. So the first held
	 * recovery confirmation lit the alert for the rest of the process: the user
	 * read it, acted on it, and the button went on saying "needs you" until they
	 * quit. An alert that cannot be discharged is one people learn to ignore,
	 * which costs exactly the warning it exists to give.
	 *
	 * Entries are kept — this changes what counts as *unseen*, not what happened.
	 */
	acknowledge(upTo: number = this.sequence): void {
		// **Only as far as the caller actually saw.**
		//
		// Listing and acknowledging are two IPC round trips. Advancing to the latest
		// global sequence marked entries recorded *between* them as seen — and an
		// automatic pass finishing in that gap is exactly how a held account-recovery
		// confirmation got acknowledged by somebody who was never shown it. The
		// renderer sends back the high-water mark of the snapshot it rendered.
		//
		// Clamped, because the value arrives from the renderer: never past what has
		// happened, and never backwards, which would resurrect a discharged alert.
		this.acknowledgedSeq = Math.max(this.acknowledgedSeq, Math.min(upTo, this.sequence));
	}

	/** The high-water mark of what `all()` would return right now. */
	watermark(): number {
		return this.sequence;
	}

	/** Drop everything. Called on quit. */
	clear(): void {
		this.entries.clear();
	}

	private push(steamId64: string, entry: ActivityEntry): void {
		this.sequence += 1;
		this.order.set(entry, this.sequence);
		const list = this.entries.get(steamId64) ?? [];
		list.push(entry);
		if (list.length > MAX_ENTRIES_PER_ACCOUNT) {
			list.splice(0, list.length - MAX_ENTRIES_PER_ACCOUNT);
		}
		this.entries.set(steamId64, list);
	}
}
