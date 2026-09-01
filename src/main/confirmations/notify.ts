import type { ConfirmationSummary } from '../../shared/ipc';
import type { NotifyDetail } from '../../shared/vault-schema';
import type { PollMode } from './auto';

/**
 * Desktop notifications for confirmations that need a person (§12 F6).
 *
 * The engine decides *when* to look; this decides *whether what it found is
 * worth interrupting somebody for*, and how much to say. It holds no secrets
 * and talks to nothing — the one Electron call it needs is injected, so the
 * rules below are testable without a running app.
 *
 * Two things shape it:
 *
 *  - **A toast is not a private surface.** Windows shows it on the lock screen
 *    and keeps it in notification history. `full` names the trade partner and
 *    the items, which is what makes it useful and what makes it a disclosure.
 *    That is the account owner's choice to make, and the disclosure sits beside
 *    the switch that turns notifications on.
 *  - **The same thing is announced once.** A poll runs every fifteen seconds by
 *    default. Anything that re-announces an unchanged state per poll is not a
 *    notification, it is an alarm nobody will leave switched on.
 */

/**
 * The slice of Electron this needs. Injected so it is testable headless.
 *
 * Deliberately not a `Notification` — an interface with one method is the whole
 * dependency, and it keeps the composition rules in a file that never has to
 * boot a browser process to run.
 */
export interface ToastHost {
	/**
	 * `onClick` is optional so a host that cannot deliver clicks is still a valid
	 * host — which is what keeps this testable headless, and what let the toasts
	 * ship one phase before the routing behind them.
	 *
	 * @returns nothing when the host can answer synchronously, or whether the
	 * toast was actually delivered when it cannot.
	 *
	 * **Electron cannot answer synchronously, and pretending it could lost
	 * alerts.** `Notification.show()` returns before the OS has created
	 * anything; a native creation or display failure arrives later, on the
	 * `failed` event. So a toast that never appeared was recorded as announced
	 * and the confirmation it was about was never mentioned again for the
	 * session — measured with a delayed failure against the same critical
	 * confirmation: one delivery attempt, then silence.
	 *
	 * `void` still means delivered, so a test host that pushes to an array stays
	 * a valid host and a throwing one is still caught.
	 */
	show(options: { title: string; body: string; onClick?: () => void }): void | Promise<boolean>;
}

export interface ConfirmationNotifierOptions {
	host: ToastHost;
	/**
	 * Told which account a clicked toast was about.
	 *
	 * **Supplied here rather than threaded through `ToastHost`**, because the
	 * notifier already holds the id at every call site — it is the key of the
	 * state map. One option covers the pending, sign-in and halt toasts; putting
	 * the id in `ToastHost` instead would mean four wirings and a way to get one
	 * of them wrong.
	 */
	onActivate?: (steamId64: string) => void;
}

interface AccountNotifyState {
	/**
	 * Whether a poll has established what was already pending for this account.
	 *
	 * **Separate from the existence of this record, and it has to be.** A
	 * sign-in toast can arrive before any successful poll, and it needs somewhere
	 * to remember that it has spoken — so it creates this record. Treating
	 * "record exists" as "already seeded" then made the *first* real poll behave
	 * like a second one, announcing everything already pending: the twenty-toasts
	 * -on-unlock problem, reached by the one path that looked unrelated to it.
	 */
	seeded: boolean;
	/**
	 * Ids already announced, each against the delivery attempt that announced it.
	 *
	 * A Set until a failed toast was found undoing a *later* toast's work. The
	 * callback that runs when a notification fails deletes the ids its own poll
	 * added, and it used to delete them whoever had put them there — so a poll
	 * whose toast failed slowly, after a subsequent poll had re-announced the same
	 * confirmation successfully, un-marked a confirmation the user had already been
	 * shown. The next poll announced it a second time.
	 *
	 * The attempt number is what makes "still mine" answerable. See `attempts`.
	 */
	seen: Map<string, number>;

	/**
	 * Whether this account's expired session has already been reported.
	 *
	 * A sign-in failure repeats on every poll until the user acts, and telling
	 * them every fifteen seconds is how the feature gets switched off. Cleared by
	 * the next successful poll, which is the only evidence that the session works
	 * again.
	 */
	toldSignInNeeded: boolean;
	/**
	 * How many entries were unreadable on the last poll.
	 *
	 * **Without this the count has no memory and an unchanged one re-announces
	 * itself every fifteen seconds, forever** — an unparseable entry that stays
	 * pending on Steam is not an event, it is a state. That is precisely what the
	 * note at the top of this file forbids, and the first version of this class
	 * did it anyway: `unreadable > 0` was checked against nothing.
	 */
	lastUnreadable: number;

	/**
	 * Which delivery attempt last moved `lastUnreadable`, and which last set
	 * `toldSignInNeeded`.
	 *
	 * Both were rolled back by comparing the *value* — "is it still the number I
	 * wrote" — or by not checking at all. A later poll that happens to record the
	 * same count reads as this attempt's own work and gets undone; a later
	 * sign-in notice that was delivered has its flag cleared by an earlier one
	 * that was not, and the user is told twice. `seen` is keyed by attempt for
	 * exactly this reason and these two were not.
	 */
	unreadableBy: number;
	signInBy: number;
}

/**
 * The longest a Steam-authored string may be inside a toast body.
 *
 * `headline` and `summary` are **Steam's** strings, and `full` is the default
 * detail, so this is the one path on which text this application did not write
 * reaches an OS-level surface. A long one would push the rest of the body out
 * of a notification that has limited room; a crafted one is a reason to bound
 * it whatever the room.
 */
const MAX_STEAM_TEXT = 60;

/**
 * Control characters, including the bidirectional overrides.
 *
 * Left in, these can reorder how a body renders — so the visible text of a
 * toast would not be the text this code composed.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Cap and strip a string this application did not author.
 *
 * **Applies to the account name as well as to Steam's strings**, which is not
 * where this started. The name is typed by the user — or, far more often,
 * copied verbatim out of an imported maFile, where nothing bounds it: the
 * import schema asks only for a non-empty string. A 50KB name, or one carrying
 * a bidirectional override, reached the toast **title** unmodified while the
 * body beside it was carefully capped.
 */
function safeSteamText(value: string): string {
	const stripped = value.replace(CONTROL_CHARACTERS, '').trim();
	return stripped.length > MAX_STEAM_TEXT ? `${stripped.slice(0, MAX_STEAM_TEXT - 1)}…` : stripped;
}

/** `2 confirmations`, `1 confirmation`. */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * `1 trade, 1 market listing` — counted by our own type names, never Steam's.
 *
 * `typeName` comes from the S16 table in `policy.ts`. `steamTypeName` is a
 * label the server chooses, which is a label an attacker chooses.
 */
function byType(awaiting: readonly ConfirmationSummary[]): string {
	const counts = new Map<string, number>();
	for (const entry of awaiting) {
		counts.set(entry.typeName, (counts.get(entry.typeName) ?? 0) + 1);
	}
	return [...counts]
		.map(
			([name, count]) => `${count} ${count === 1 ? name.toLowerCase() : `${name.toLowerCase()}s`}`
		)
		.join(', ');
}

/** The body for one poll's worth of news. */
export function composeBody(
	detail: NotifyDetail,
	awaiting: readonly ConfirmationSummary[],
	unreadable: number
): string {
	// Steam sent something this build could not parse. That is the case a person
	// must look at, and there is nothing to describe beyond the count.
	if (awaiting.length === 0) {
		return `${plural(unreadable, 'confirmation')} could not be read`;
	}

	// `plural` appends an "s", so it cannot be used on a phrase. Spelled out.
	const extra = unreadable > 0 ? ` · ${unreadable} more could not be read` : '';

	if (detail === 'count') {
		return `${plural(awaiting.length, 'confirmation')} need${awaiting.length === 1 ? 's' : ''} you${extra}`;
	}

	if (detail === 'type') {
		return `${byType(awaiting)}${extra}`;
	}

	// `full`. The first entry is described; the rest are counted, because a toast
	// that lists eleven items is a toast nobody reads.
	const first = awaiting[0];
	if (!first) {
		return `${plural(awaiting.length, 'confirmation')} need you${extra}`;
	}
	const headline = first.headline ? safeSteamText(first.headline) : '';
	const detailLine = first.summary?.[0] ? safeSteamText(first.summary[0]) : '';
	const described = [headline || first.typeName, detailLine].filter(Boolean).join(' — ');
	const more = awaiting.length > 1 ? ` · +${awaiting.length - 1} more` : '';
	return `${described}${more}${extra}`;
}

export class ConfirmationNotifier {
	private readonly host: ToastHost;
	private readonly onActivate: (steamId64: string) => void;
	private readonly state = new Map<string, AccountNotifyState>();

	/**
	 * Halt notices the OS refused, kept so they can be tried again.
	 *
	 * **This is the one toast with no natural second chance.** The engine sets
	 * `nextDueAt` to infinity on a halt, so `halted()` is called exactly once and
	 * never again — which is why it needed no "already said this" flag, and
	 * equally why a delivery failure simply lost it. The activity log still
	 * records the halt, so the badge is right; what went was the interruption
	 * telling somebody an account had stopped being checked at all.
	 *
	 * Retried from `stillHalted`, which the scheduler calls on the beat for the
	 * accounts it is skipping — the only recurring event a halted account has.
	 */
	private readonly undeliveredHalts = new Map<
		string,
		{ accountName: string; body: string; generation: number }
	>();

	/**
	 * A number every recorded halt carries, so a slow delivery failure can tell
	 * whether the halt it is putting back is still the current one.
	 *
	 * Global and monotonic rather than per account: a per-account counter reset by
	 * `forget` hands the same number out twice, and the second one matches a stale
	 * callback still holding the first.
	 */
	private halts = 0;

	/** The newest halt issued per account. Gone when the account is. */
	private readonly latestHalt = new Map<string, number>();

	/**
	 * How many toasts have been attempted, across every account, ever.
	 *
	 * Delivery is asynchronous and the poller is not paused for it, so a failure
	 * callback can arrive after any number of later polls have rewritten what it
	 * is about to undo. Each attempt takes the next number and every rollback
	 * checks it before touching anything.
	 *
	 * **Global, and that is the whole point of it being here rather than on the
	 * per-account state.** It was a counter on the state object, reset to zero
	 * every time `forget` or `forgetAccount` replaced it — so a lock, or an
	 * account removed and re-added, handed the same number out a second time and a
	 * stale callback matched a fresh attempt. Measured: seed an account with a
	 * security-critical confirmation, forget it, seed it again and deliver that
	 * one, then let the first delivery report failure — the confirmation is
	 * announced a **third** time, because the stale rollback un-announced work it
	 * did not own.
	 *
	 * The halt generation beside it is global for exactly this reason and this
	 * counter was not, which is the same defect written twice in one file.
	 */
	private deliveries = 0;

	constructor(options: ConfirmationNotifierOptions) {
		this.host = options.host;
		this.onActivate = options.onActivate ?? ((): void => undefined);
	}

	/**
	 * Every toast goes through here, so every toast is clickable.
	 *
	 * The alternative — adding `onClick` at each `this.host.show` call — is
	 * three places to remember and one to forget, and the one forgotten would be
	 * a toast that looks identical and does nothing when clicked.
	 */
	/**
	 * @returns whether the toast was actually delivered.
	 *
	 * **Because every caller records "we have said this" before calling here.**
	 * `seen`, `lastUnreadable` and `toldSignInNeeded` all exist to stop the same
	 * thing being announced on every poll, and they were written first — so a
	 * `host.show` that threw left the entry marked as announced and it was never
	 * announced again for the life of the session. Silently, and worst for
	 * exactly the confirmation that matters most: a security-critical one is
	 * added to `seen` by the seeding branch whether or not its toast survived.
	 *
	 * `guarded()` in the engine stops such a throw from being scored as a Steam
	 * failure. It cannot un-suppress the notification, because by then the
	 * bookkeeping has already happened.
	 *
	 * Caught rather than propagated: `Notification` is an OS surface, and the
	 * useful response to it failing is to try again on the next poll, not to
	 * abandon the pass that found something.
	 */
	private toast(
		steamId64: string,
		title: string,
		body: string,
		/**
		 * Undo whatever this toast's caller recorded as "we said this".
		 *
		 * Called synchronously when `show` throws, and **later** when the host
		 * reports the OS refused it — which is the only way Electron can report
		 * it. A caller that committed optimistically has it undone the moment the
		 * failure is known, and the next poll says the thing again.
		 */
		onUndelivered: () => void = () => undefined
	): void {
		// The title is sanitised here rather than at each call site, for the same
		// reason the click is attached here: four call sites is three chances to
		// forget, and the one forgotten looks identical.
		let outcome: void | Promise<boolean>;
		try {
			outcome = this.host.show({
				title: safeSteamText(title),
				body,
				onClick: () => this.onActivate(steamId64)
			});
		} catch {
			onUndelivered();
			return;
		}
		/*
		 * **A thenable, not merely "not undefined".**
		 *
		 * TypeScript lets a function declared to return `void` return anything, so
		 * a host written as `show: (o) => toasts.push(o)` type-checks and hands
		 * back a number. Testing for `undefined` then called `.then` on it. Asking
		 * whether the answer is actually a promise is the only check that matches
		 * what the type permits.
		 */
		const settled = outcome as Promise<boolean> | undefined;
		if (typeof settled?.then !== 'function') {
			return;
		}
		void settled.then(
			(delivered) => {
				if (!delivered) {
					onUndelivered();
				}
			},
			() => onUndelivered()
		);
	}

	private stateFor(steamId64: string): AccountNotifyState | undefined {
		return this.state.get(steamId64);
	}

	/**
	 * What one poll found, for an account with notifications on.
	 *
	 * **The order of these steps is the whole behaviour**, and an earlier draft
	 * had it wrong in a way that made two of its own requirements unreachable:
	 * an early return for "nothing new" sat above the pruning and above the
	 * `unreadable` check, so the poll on which a confirmation is *resolved* —
	 * which by definition brings nothing new — never pruned, and an unreadable
	 * entry arriving on a quiet poll never announced itself.
	 */
	pending(
		steamId64: string,
		accountName: string,
		awaiting: readonly ConfirmationSummary[],
		unreadable: number,
		detail: NotifyDetail
	): void {
		const existing = this.stateFor(steamId64);
		const ids = new Set(awaiting.map((entry) => entry.id));

		// 1. First poll for this account. Seed silently, so unlocking to twenty
		//    pending confirmations does not fire twenty toasts — **except** for
		//    the two things nobody would want held back. A notify-only poll writes
		//    no activity entry, so without these carve-outs unlocking to a pending
		//    account takeover would show nothing at all.
		if (!existing?.seeded) {
			const critical = awaiting.filter((entry) => entry.securityCritical);
			const seedState = {
				seeded: true,
				seen: new Map<string, number>([...ids].map((id) => [id, 0])),
				toldSignInNeeded: false,
				unreadableBy: 0,
				signInBy: 0,
				// What was already there is the baseline, not news — the same
				// reasoning as seeding `seen`. Recording 0 here instead would make
				// the very next poll re-announce what this one just said.
				lastUnreadable: unreadable
			};
			this.state.set(steamId64, seedState);
			// **One toast, not two — on the first poll as well.** An earlier version
			// returned after the critical toast, so an account whose first poll
			// carried both a takeover attempt and an unparseable entry was told
			// about the takeover and not about the entry that could not be read —
			// which might have been a second one.
			if (critical.length > 0 || unreadable > 0) {
				// Attributed to this attempt so the rollback below can tell whether it
				// is still undoing its own work.
				const attempt = ++this.deliveries;
				for (const entry of critical) {
					seedState.seen.set(entry.id, attempt);
				}
				seedState.unreadableBy = attempt;
				this.toast(steamId64, accountName, composeBody(detail, critical, unreadable), () => {
					/*
					 * **The seed stands; the announcement does not.**
					 *
					 * Staying seeded is right — the baseline was established, and
					 * re-seeding would announce the whole backlog next time. But a
					 * critical confirmation only reached `seen` as part of that
					 * baseline, and it was supposed to be announced *despite* the
					 * seeding. Left in, it would never be mentioned again: an account
					 * takeover attempt, silently swallowed by a failed toast.
					 */
					const seeded = this.stateFor(steamId64);
					if (!seeded) {
						return;
					}
					for (const entry of critical) {
						// Only if this attempt is still the one that marked it. A later
						// poll re-announcing the same confirmation successfully owns it
						// now, and deleting it here would show it to the user twice.
						if (seeded.seen.get(entry.id) === attempt) {
							seeded.seen.delete(entry.id);
						}
					}
					/*
					 * And the count only if nothing has moved it since. Setting 0
					 * unconditionally overwrote whatever a later poll had recorded,
					 * which is how a rise this poll knew nothing about stopped being a
					 * rise and was never announced.
					 */
					if (seeded.unreadableBy === attempt) {
						seeded.lastUnreadable = 0;
						seeded.unreadableBy = 0;
					}
				});
			}
			return;
		}

		// 2. Reaching here at all means the session worked, so an earlier
		//    "sign in again" is over. Nothing else clears this.
		existing.toldSignInNeeded = false;

		// 3. Prune **before** deciding anything, and on every poll including the
		//    quiet ones. This is what bounds the set, and what lets a confirmation
		//    that was resolved and then reappears announce itself again.
		for (const id of [...existing.seen.keys()]) {
			if (!ids.has(id)) {
				existing.seen.delete(id);
			}
		}

		// 4. What is actually new.
		const fresh = awaiting.filter((entry) => !existing.seen.has(entry.id));
		const attempt = ++this.deliveries;
		for (const entry of fresh) {
			existing.seen.set(entry.id, attempt);
		}

		// 5. **A rise, not a presence.** `unreadable > 0` describes a state that
		//    persists until somebody looks; announcing it per poll is an alarm,
		//    not a notification. A drop is deliberately not announced — one of
		//    them being resolved is not worth interrupting anybody for.
		//
		//    The assignment sits **above** the early return on purpose. Below it,
		//    a poll that returns to zero would never be recorded, so a later
		//    reappearance would compare against the old high-water mark and be
		//    swallowed for good.
		const newlyUnreadable = unreadable > existing.lastUnreadable;
		/** What was announced before this poll, so a failed toast can restore it. */
		const previouslyUnreadable = existing.lastUnreadable;
		existing.lastUnreadable = unreadable;

		// 6. One toast, not two. A poll bringing both a new confirmation and an
		//    unparseable one is still one thing happening.
		if (fresh.length === 0 && !newlyUnreadable) {
			return;
		}

		/*
		 * **Claimed only by a poll that is about to say something.**
		 *
		 * This was stamped above, beside the assignment, so every quiet poll took
		 * ownership of the marker — and a quiet poll is the common case, one every
		 * fifteen seconds. An attempt whose toast was still in flight then found the
		 * marker owned by a poll that had announced nothing, could not roll it back,
		 * and the rise it had failed to report was recorded as reported. Permanently:
		 * nothing lowers the mark again.
		 *
		 * The value still moves on every poll, which is what stops an unchanged
		 * count re-announcing itself. Only the claim is reserved for the attempt
		 * that actually tries to deliver.
		 */
		existing.unreadableBy = attempt;
		this.toast(steamId64, accountName, composeBody(detail, fresh, unreadable), () => {
			/*
			 * **Nothing was said, so nothing may be marked as said.**
			 *
			 * Step 4 put these ids in `seen` and step 5 raised the unreadable
			 * high-water mark, both meaning "announced". Leaving them after a toast
			 * that never appeared suppresses those confirmations for the rest of
			 * the session; undoing them makes the next poll try again, which is the
			 * only useful response to an OS notification failing.
			 */
			for (const entry of fresh) {
				/*
				 * Only what this attempt marked, and only while it is still marked by
				 * this attempt. Deleting unconditionally undid a *later* poll's
				 * successful announcement of the same confirmation, and the poll after
				 * that showed it to the user a second time.
				 */
				if (existing.seen.get(entry.id) === attempt) {
					existing.seen.delete(entry.id);
				}
			}
			/*
			 * The high-water mark likewise, and only if this attempt's value is
			 * still the one standing. Restoring it blind put back a number from
			 * before a later poll had run, so a rise that poll had already announced
			 * looked new again — or one it recorded looked already-said and was
			 * swallowed.
			 */
			/*
			 * **By ownership, not by value.** Comparing the number matched whenever a
			 * later poll happened to record the same count — a count that has not
			 * moved is the ordinary case, not a rare one — and this then rolled that
			 * poll's work back to a figure from before it ran. Where the earlier
			 * figure was the higher of the two, that *raised* the mark, so the next
			 * genuine rise looked like something already said and was never
			 * announced.
			 */
			if (existing.unreadableBy === attempt) {
				existing.lastUnreadable = previouslyUnreadable;
				existing.unreadableBy = 0;
			}
		});
	}

	/**
	 * A poll reached Steam and got an answer, whether or not it found anything.
	 *
	 * **The only success signal that does not depend on notifications being on.**
	 * `pending()` cleared the "already said this" flag, and the engine calls
	 * `pending()` only when `notify` is set — so an account with auto-confirm on
	 * and notifications off never reached it. Its first expiry toasted, and every
	 * later one for the life of the session was swallowed, because the flag it
	 * checks had nothing left that could clear it.
	 *
	 * That is the account shape the schema defaults to, and the toast is the only
	 * surface it has: `signInNeeded` is called for it, `pending` is not.
	 */
	pollSucceeded(steamId64: string): void {
		const existing = this.stateFor(steamId64);
		if (existing) {
			existing.toldSignInNeeded = false;
		}
	}

	/**
	 * The saved session expired. Only the user can fix this, so it is said once.
	 *
	 * Not counted as a failure by the engine either — backing off cannot help,
	 * and ten strikes would arrive at a halt phrased "failures in a row" for a
	 * condition that is nothing of the sort.
	 */
	signInNeeded(steamId64: string, accountName: string): void {
		const existing = this.stateFor(steamId64);
		if (existing?.toldSignInNeeded) {
			return;
		}
		const attempt = ++this.deliveries;
		if (existing) {
			existing.toldSignInNeeded = true;
			existing.signInBy = attempt;
		} else {
			// `seeded: false` on purpose — no poll has succeeded, so the next one
			// that does is still this account's first and must seed silently.
			this.state.set(steamId64, {
				seeded: false,
				seen: new Map(),
				unreadableBy: 0,
				signInBy: attempt,
				toldSignInNeeded: true,
				lastUnreadable: 0
			});
		}
		this.toast(steamId64, accountName, 'Sign in again to keep checking this account.', () => {
			/*
			 * Same rule as the rest, and this was the one place with no rule at all:
			 * the flag means "we told them", and we did not, so it is cleared — but
			 * only if this attempt is the one that set it. Clearing it unconditionally
			 * let an earlier notice that failed slowly undo a later one that had been
			 * delivered, and the user was told to sign in again twice.
			 */
			const current = this.stateFor(steamId64);
			if (current?.signInBy === attempt) {
				current.toldSignInNeeded = false;
				current.signInBy = 0;
			}
		});
	}

	/**
	 * Ten failures in a row; this account is no longer polled.
	 *
	 * No reason string. That is redacted error text composed for the activity
	 * log, which is where the detail belongs; a toast says the thing stopped.
	 *
	 * Fires once because the engine sets `nextDueAt` to infinity on a halt, so
	 * there is no second call to guard against — and a flag for one would be
	 * state that can only ever go stale.
	 *
	 */
	halted(steamId64: string, accountName: string, mode: PollMode): void {
		const body =
			mode === 'confirm'
				? 'Automatic confirmation stopped after 10 failures.'
				: // An account that was only ever watching never had automatic
					// confirmation to stop.
					'Stopped checking after 10 failures.';
		const generation = ++this.halts;
		this.latestHalt.set(steamId64, generation);
		/*
		 * **Any halt still waiting to be delivered is superseded by this one.**
		 *
		 * The guards below stop a *late* failure from recording over a newer halt,
		 * and do nothing about a record that was already there. So an earlier halt
		 * whose toast failed, followed by a second halt that was delivered, left the
		 * first one sitting in the queue — and the beat then delivered it, an
		 * obsolete duplicate of something the user had just been told.
		 */
		this.undeliveredHalts.delete(steamId64);
		this.toast(steamId64, accountName, body, () => {
			/*
			 * **Kept, because nothing will call this again.**
			 *
			 * The engine sets `nextDueAt` to infinity on a halt, so there is no
			 * second poll and no second call — which is why this needed no dedup
			 * flag, and equally why a failed delivery was simply lost. The activity
			 * log still carries the halt, so the badge is right and the information
			 * survives; what went was the one interruption telling somebody their
			 * account had stopped being checked at all.
			 *
			 * Retried from `stillHalted`, which the scheduler calls on the beat for
			 * exactly the accounts it is skipping.
			 *
			 * **But only while this is still the account's halt.** Delivery is
			 * asynchronous and nothing waits for it, so this can arrive after the
			 * account has been removed — and recording it then revived a halt for an
			 * account that no longer exists. Give that SteamID to another one, by a
			 * re-enrolment or a re-import, and the retry delivers an alert carrying
			 * the deleted account's name, which is the whole of what a user reads.
			 */
			if (this.latestHalt.get(steamId64) !== generation) {
				return;
			}
			this.undeliveredHalts.set(steamId64, { accountName, body, generation });
		});
	}

	/**
	 * This account is still halted, and the beat has come round again.
	 *
	 * Does nothing at all unless its halt notice failed to reach the screen — the
	 * ordinary case is a map lookup that misses. Called per skipped account per
	 * beat, so it must stay that cheap.
	 */
	stillHalted(steamId64: string): void {
		const pending = this.undeliveredHalts.get(steamId64);
		if (!pending) {
			return;
		}
		// Removed before the attempt, and put back by the failure path, so a run of
		// failures re-attempts once per beat rather than accumulating.
		this.undeliveredHalts.delete(steamId64);
		this.toast(steamId64, pending.accountName, pending.body, () => {
			/*
			 * **Only if this halt is still the account's halt.**
			 *
			 * Delivery is asynchronous and nothing waits for it. Putting the record
			 * back unconditionally revived a halt for an account that had since been
			 * removed — and a SteamID that is reused, by a re-enrolment or a
			 * re-import, then received an alert naming the *previous* account. The
			 * name in that toast is the whole of what the user reads.
			 */
			if (this.latestHalt.get(steamId64) === pending.generation) {
				this.undeliveredHalts.set(steamId64, pending);
			}
		});
	}

	/** On lock. Everything is re-seeded on the next unlock. */
	forget(): void {
		this.undeliveredHalts.clear();
		this.latestHalt.clear();
		this.state.clear();
	}

	/**
	 * When an account is removed, beside the other per-account `forget`s.
	 *
	 * **The undelivered halt goes with it.** It did not, and a halt whose toast
	 * had failed outlived the account entirely: the retry fires on the scheduler's
	 * beat, so removing the account and giving the SteamID to another one — a
	 * re-enrolment, a re-import — produced an alert carrying the name of the
	 * account that was deleted.
	 */
	forgetAccount(steamId64: string): void {
		this.state.delete(steamId64);
		this.undeliveredHalts.delete(steamId64);
		// And the generation, so a delivery still in flight cannot put it back.
		this.latestHalt.delete(steamId64);
	}
}
