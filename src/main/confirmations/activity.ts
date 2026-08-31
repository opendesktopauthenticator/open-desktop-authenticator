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
	| { kind: 'unreadable'; at: string; count: number }
	/**
	 * The saved session expired. Only the user can fix it.
	 *
	 * Its own kind rather than a `failed` entry, because `failed` is not urgent
	 * — so the one condition no amount of retrying resolves was the one the log
	 * stayed quiet about. It surfaced only after ten strikes, as a `halted` entry
	 * phrased "failures in a row", which is not what happened.
	 *
	 * No reason string: there is one cause and the entry names it.
	 */
	| { kind: 'signInRequired'; at: string };

export class ActivityLog {
	private readonly entries = new Map<string, ActivityEntry[]>();

	/**
	 * Accounts whose session is currently known to be expired.
	 *
	 * **The run is tracked here rather than inferred from the newest entry**,
	 * and that distinction is the whole fix. Keying on "is the last entry
	 * `signInRequired`?" assumed every successful poll writes something. Most do
	 * not: a notify-only poll writes nothing by design, and a confirm pass that
	 * approved nothing and held nothing back writes nothing either. So the
	 * newest entry stayed `signInRequired` for ever, and an account that expired,
	 * was acknowledged, recovered and expired **again** produced no second entry
	 * and no badge — silence on exactly the condition only the user can clear.
	 *
	 * A Set keyed by account is also unaffected by the hundred-entry trim, which
	 * the last-entry check was not.
	 */
	private readonly signInOpen = new Set<string>();

	/**
	 * The unreadable count and the held ids already recorded, per account.
	 *
	 * **A pass reports state, and this log records events.** `runAutoConfirm`
	 * returns what is *currently* pending, so a confirmation the policy holds
	 * back comes round again on every poll, and an entry Steam sent that this
	 * build cannot parse stays unparseable until somebody looks. Appending both
	 * unconditionally wrote four entries a minute at the default interval.
	 *
	 * That is not merely noisy. `MAX_ENTRIES_PER_ACCOUNT` is 100, so within half
	 * an hour the flood evicts everything before it — including the held
	 * account-recovery confirmation this class exists to preserve, the loudest
	 * warning the application can raise. And every appended entry outranks
	 * `acknowledgedSeq`, so the badge could never be discharged: it went dark on
	 * acknowledge and lit again on the next poll, for ever.
	 *
	 * `signInRequired` was given run-dedup for exactly this reason. These two
	 * are the same shape and were left out of it.
	 */
	private readonly reported = new Map<string, { unreadable: number; held: Set<string> }>();

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
		// **Before the guards below, not after them.** A pass that approved
		// nothing and held nothing back writes no entry at all — and it is still
		// proof that the session works.
		this.signInOpen.delete(steamId64);
		const at = new Date(this.now()).toISOString();

		const seen = this.reported.get(steamId64) ?? { unreadable: 0, held: new Set<string>() };
		this.reported.set(steamId64, seen);

		// **A rise, not a presence** — the same rule the notifier applies, and for
		// the same reason. Recorded before the guard so a return to zero is
		// written down and a later reappearance is news again.
		const roseUnreadable = unreadable > seen.unreadable;
		seen.unreadable = unreadable;
		if (roseUnreadable) {
			// Recorded first, above whatever the pass did manage to do. It is the entry
			// that says this record is incomplete, and a caveat printed under the
			// findings it qualifies has already let the reader draw a conclusion.
			this.push(steamId64, { kind: 'unreadable', at, count: unreadable });
		}

		if (approved.length > 0) {
			this.push(steamId64, { kind: 'approved', at, confirmations: approved });
		}
		// Anything no longer held has been dealt with; if it comes back it is a new
		// event and deserves saying again.
		const stillHeld = new Set(held.map((entry) => entry.confirmation.id));
		for (const id of seen.held) {
			if (!stillHeld.has(id)) {
				seen.held.delete(id);
			}
		}

		for (const entry of held) {
			// **Once per confirmation, not once per poll.** The same one is held on
			// every pass until a person deals with it, and re-recording it four
			// times a minute buries everything else in a hundred-entry log.
			if (seen.held.has(entry.confirmation.id)) {
				continue;
			}
			seen.held.add(entry.confirmation.id);
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
		// A failure that is not an expiry still proves the request went out and
		// came back, so it ends any run in progress.
		this.signInOpen.delete(steamId64);
		const at = new Date(this.now()).toISOString();
		this.push(steamId64, { kind: halted ? 'halted' : 'failed', at, reason });
	}

	/**
	 * The saved session expired, and only the user can fix it.
	 *
	 * **Deduplicated by state, not by transition.** A poll runs every fifteen
	 * seconds and this condition persists until somebody signs in, so a plain
	 * append would write hundreds of identical entries and push everything else
	 * out of a hundred-entry log.
	 *
	 * Recording *only* the transition would be worse in a subtler way: `hasUrgent`
	 * compares against `acknowledgedSeq`, so acknowledging a one-off entry would
	 * make a still-broken account read as clear until it happened to flip and flip
	 * back. Appending while the newest entry is not already this kind keeps one
	 * entry per run, and the next successful poll's own entry ends the run.
	 *
	 * Keyed on the **kind**, never on the reason text. Classification by message
	 * text was removed from `recordFailure` once already, because the wording is
	 * composed in another file.
	 */
	recordSignInRequired(steamId64: string): void {
		if (this.signInOpen.has(steamId64)) {
			return;
		}
		this.signInOpen.add(steamId64);
		this.push(steamId64, { kind: 'signInRequired', at: new Date(this.now()).toISOString() });
	}

	/**
	 * A poll reached Steam and got an answer. The session works.
	 *
	 * Called for **every** success, including the quiet ones that write no entry
	 * — which is why it exists at all. It deliberately records nothing: a poll
	 * that found nothing is not something to read about later, but it is proof
	 * that an earlier expiry is over.
	 */
	notePollSucceeded(steamId64: string): void {
		this.signInOpen.delete(steamId64);
	}

	/**
	 * Drop everything held for one account. Called when it is removed.
	 *
	 * **An open run outlived the account it belonged to.** Nothing cleared
	 * `signInOpen` per account, so removing an account and adding it back — which
	 * arrives with no saved session, and therefore expires on its first poll —
	 * found the run still open and wrote no entry and lit no badge. Silence on
	 * exactly the condition this class exists to stop being silent about.
	 *
	 * The entries go too. They described an account the vault no longer holds,
	 * and the Activity screen went on listing its trades.
	 */
	forgetAccount(steamId64: string): void {
		this.signInOpen.delete(steamId64);
		this.reported.delete(steamId64);
		this.entries.delete(steamId64);
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
		// The sequence breaks timestamp ties. `at` has millisecond resolution and
		// two accounts routinely record inside the same millisecond — the automatic
		// sweep runs them back to back — so sorting on the string alone left those
		// pairs in Map insertion order, which is "whichever account was seen first
		// this session", not "newest first" as promised.
		return combined.sort(
			(a, b) =>
				b.entry.at.localeCompare(a.entry.at) ||
				(this.order.get(b.entry) ?? 0) - (this.order.get(a.entry) ?? 0)
		);
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
					entry.kind === 'unreadable' ||
					// Nothing this application does will fix an expired session, so it
					// is exactly the case that has to reach a person.
					entry.kind === 'signInRequired')
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
		this.signInOpen.clear();
		this.reported.clear();
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
