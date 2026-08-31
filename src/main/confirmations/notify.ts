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
	/** Ids already announced, so the same confirmation is not re-announced. */
	seen: Set<string>;
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
			this.state.set(steamId64, {
				seeded: true,
				seen: ids,
				toldSignInNeeded: false,
				// What was already there is the baseline, not news — the same
				// reasoning as seeding `seen`. Recording 0 here instead would make
				// the very next poll re-announce what this one just said.
				lastUnreadable: unreadable
			});
			// **One toast, not two — on the first poll as well.** An earlier version
			// returned after the critical toast, so an account whose first poll
			// carried both a takeover attempt and an unparseable entry was told
			// about the takeover and not about the entry that could not be read —
			// which might have been a second one.
			if (critical.length > 0 || unreadable > 0) {
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
					if (seeded) {
						for (const entry of critical) {
							seeded.seen.delete(entry.id);
						}
						seeded.lastUnreadable = 0;
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
		for (const id of existing.seen) {
			if (!ids.has(id)) {
				existing.seen.delete(id);
			}
		}

		// 4. What is actually new.
		const fresh = awaiting.filter((entry) => !existing.seen.has(entry.id));
		for (const entry of fresh) {
			existing.seen.add(entry.id);
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
				existing.seen.delete(entry.id);
			}
			existing.lastUnreadable = previouslyUnreadable;
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
		if (existing) {
			existing.toldSignInNeeded = true;
		} else {
			// `seeded: false` on purpose — no poll has succeeded, so the next one
			// that does is still this account's first and must seed silently.
			this.state.set(steamId64, {
				seeded: false,
				seen: new Set(),
				toldSignInNeeded: true,
				lastUnreadable: 0
			});
		}
		this.toast(steamId64, accountName, 'Sign in again to keep checking this account.', () => {
			// Same rule: the flag means "we told them", and we did not. Cleared so
			// the next poll — which will find the same expired session — says it.
			const current = this.stateFor(steamId64);
			if (current) {
				current.toldSignInNeeded = false;
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
		this.toast(
			steamId64,
			accountName,
			mode === 'confirm'
				? 'Automatic confirmation stopped after 10 failures.'
				: // An account that was only ever watching never had automatic
					// confirmation to stop.
					'Stopped checking after 10 failures.'
		);
	}

	/** On lock. Everything is re-seeded on the next unlock. */
	forget(): void {
		this.state.clear();
	}

	/** When an account is removed, beside the other per-account `forget`s. */
	forgetAccount(steamId64: string): void {
		this.state.delete(steamId64);
	}
}
