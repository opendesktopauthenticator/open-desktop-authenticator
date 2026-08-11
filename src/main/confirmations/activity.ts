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
	| { kind: 'halted'; at: string; reason: string };

export class ActivityLog {
	private readonly entries = new Map<string, ActivityEntry[]>();

	/**
	 * When the user last looked. Everything at or before this is no longer urgent.
	 *
	 * Zero means never, so a fresh process treats every entry as unseen — which is
	 * right: the log survives a lock, and an unlock is exactly when an unread
	 * warning should be shown again.
	 */
	private acknowledgedAtMs = 0;
	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** Record one automatic pass. Approvals and refusals are separate entries. */
	recordPass(
		steamId64: string,
		approved: ConfirmationSummary[],
		held: { confirmation: ConfirmationSummary; reason: string }[]
	): void {
		const at = new Date(this.now()).toISOString();

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
				Date.parse(entry.at) > this.acknowledgedAtMs &&
				((entry.kind === 'held' && entry.confirmation.securityCritical) || entry.kind === 'halted')
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
	acknowledge(): void {
		this.acknowledgedAtMs = this.now();
	}

	/** Drop everything. Called on quit. */
	clear(): void {
		this.entries.clear();
	}

	private push(steamId64: string, entry: ActivityEntry): void {
		const list = this.entries.get(steamId64) ?? [];
		list.push(entry);
		if (list.length > MAX_ENTRIES_PER_ACCOUNT) {
			list.splice(0, list.length - MAX_ENTRIES_PER_ACCOUNT);
		}
		this.entries.set(steamId64, list);
	}
}
