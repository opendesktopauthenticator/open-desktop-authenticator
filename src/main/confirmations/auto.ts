import { redactCredentials } from '../net/egress';
import { ConfirmationsError } from './service';
import type { ConfirmationsService, AutoConfirmOutcome } from './service';
import type { VaultService } from '../vault/service';
import type { ConfirmationSummary } from '../../shared/ipc';
import type { NotifyDetail } from '../../shared/vault-schema';

/**
 * The automatic confirmation loop (§12 F6, milestone 0.3).
 *
 * This is the most dangerous feature in the product and it is deliberately the
 * dumbest module in it. Every decision about *what* may be approved lives in
 * `policy.ts` and is enforced in `client.ts`; all this does is decide *when* to
 * ask. If that separation ever blurs, the thing at risk is somebody's account.
 *
 * Four rules shape it:
 *
 *  - **It does nothing until a user switches something on.** An account with
 *    nothing enabled is never polled at all, so the default costs no requests
 *    and takes no risk. There are three switches, not two: notifications alone
 *    are enough to poll an account, and that arm issues a real request to Steam
 *    — this bullet said "neither type" while `dueAccounts` was already reading
 *    `notify.enabled` beside them.
 *  - **It stops dead when the vault locks.** A locked vault means the user is
 *    not present, and approving trades on behalf of somebody who is not there is
 *    exactly what this must not do unattended.
 *  - **A failure never speeds anything up.** Errors back off instead of
 *    retrying, because the common cause is Steam rate-limiting and the common
 *    reflex — try again immediately — is what turns a slow minute into a blocked
 *    hour.
 *  - **What it holds back is reported, not swallowed.** An account-recovery
 *    confirmation the policy refused is the strongest warning this app can give,
 *    and a poller that quietly moved on would waste it.
 */

/** Never poll faster than this, whatever the account says. */
const MIN_INTERVAL_MS = 10_000;

/**
 * How often the scheduler *looks* for due work.
 *
 * Deliberately much finer than `MIN_INTERVAL_MS`, which is a floor on how often
 * one account may be polled — a different quantity that used to share the same
 * constant. Sampling on a ten-second beat quantised the jitter away: with a
 * fifteen-second interval the spread is at most `interval / 4`, under four
 * seconds, so every account's next due time landed inside the same beat and
 * they polled in lockstep regardless. THREAT_MODEL claims the opposite, and the
 * claim is the point — accounts on separate proxies that tick together are
 * correlated by their timing whatever their exit addresses are.
 *
 * A one-second beat costs nothing: `tick` returns immediately, without reading
 * the vault, on every beat where nothing is due.
 */
const SCHEDULER_TICK_MS = 1_000;

/** After a failure, wait at least this long before trying that account again. */
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Consecutive failures after which the account stops being polled entirely.
 *
 * Backoff alone is not enough. If a session has genuinely died, backing off
 * means failing forever at fifteen-minute intervals — quietly, while the user
 * believes automatic confirmation is working. Ten in a row is not a blip; it is
 * a thing that needs a person, so the engine says so and stops.
 */
const HALT_AFTER_FAILURES = 10;

/**
 * Why this account is being polled.
 *
 * `confirm` acts on what it finds; `notify` only looks. `runAutoConfirm` is the
 * approve path and it returns an empty outcome when neither auto type is on —
 * so sending a notify-only account through it produces a feature that polls
 * forever and never tells anybody anything. It never lists, so it never
 * notifies.
 */
export type PollMode = 'confirm' | 'notify';

/**
 * Wrap a caller-supplied listener so a throw in it cannot be mistaken for a
 * Steam failure.
 *
 * **Every listener runs inside `runOne`, and four of the six run inside its
 * `try`.** A notification that threw therefore landed in the catch, where the
 * code cannot tell it from Steam refusing: the successful pass was overwritten
 * with a backoff, logged as `failed` with the *listener's* message, and on an
 * hourly account the next poll was pulled from 3600s to 30s — the module's own
 * rule that a failure never speeds anything up, inverted. The two that run
 * inside the catch were worse: a throw there escaped `runOne` entirely and
 * surfaced as an unhandled rejection with no handler anywhere in the app.
 *
 * Guarding here rather than at the six call sites means a listener added later
 * is covered without anybody remembering. The `try` encloses exactly one
 * expression — the listener — so a real Steam error still reaches the catch
 * that is supposed to see it.
 */
function guarded<A extends unknown[]>(fn?: (...args: A) => void): (...args: A) => void {
	return (...args: A): void => {
		try {
			fn?.(...args);
		} catch (err) {
			// Never reported through `onFailure`: that path calls the notifier too,
			// so a broken notifier would recurse through its own failure report.
			console.error('an auto-confirm listener threw', err);
		}
	};
}

export interface AutoConfirmEngineOptions {
	vault: VaultService;
	confirmations: ConfirmationsService;
	/** Told what happened, so the UI or a notification can surface it. */
	onOutcome?: (steamId64: string, outcome: AutoConfirmOutcome) => void;
	/** Told when a pass failed, with the reason already made presentable. */
	/**
	 * @param halted true when the engine has given up on this account entirely.
	 * @param context the account's display name and why it was being polled.
	 *
	 * `context` is optional so the activity log, which wants neither, keeps its
	 * existing three-argument call. A halt notification needs both: the title is
	 * the account name, and an account that was only ever watching never had
	 * automatic confirmation to stop, so the sentence differs.
	 */
	onFailure?: (
		steamId64: string,
		reason: string,
		halted: boolean,
		context?: { accountName: string; mode: PollMode }
	) => void;
	/** Confirmations now awaiting a person, after a poll of either kind. */
	onPending?: (
		steamId64: string,
		accountName: string,
		awaiting: ConfirmationSummary[],
		unreadable: number,
		detail: NotifyDetail
	) => void;
	/** A poll that found the saved session needs a password again. */
	onSignInNeeded?: (steamId64: string, accountName: string) => void;
	/**
	 * Whether the vault refuses to talk to Steam without a proxy.
	 *
	 * Wired to the **existing** reader the transports already use, not a second
	 * one — two readers of one rule is how they come to disagree.
	 */
	requireProxies?: () => boolean;
	/**
	 * Makes sure Steam's clock has been checked before a pass signs anything.
	 *
	 * Every interactive path already awaits this in its IPC handler. The engine
	 * does not go through those handlers — it calls `runAutoConfirm` directly — so
	 * it was the one caller signing confirmations without ever waiting for the
	 * offset. Unlock starts the sync without awaiting it and the first tick lands
	 * ten seconds later, well inside a thirty-second transport timeout, so on a
	 * skewed machine that pass signed with an offset of zero and Steam refused it.
	 *
	 * Cheap to call every pass: it returns immediately unless the reading is stale,
	 * which is also what keeps a long-running tray session from drifting.
	 */
	ensureClock?: () => Promise<void>;
	/** Injected for testability. */
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (handle: NodeJS.Timeout) => void;
}

/** One account this beat decided to poll, and everything the poll needs. */
interface DueAccount {
	steamId64: string;
	accountName: string;
	pollIntervalSeconds: number;
	mode: PollMode;
	/** Whether a toast is wanted, independent of `mode`. */
	notify: boolean;
	detail: NotifyDetail;
}

interface AccountState {
	/** Epoch ms of the next permitted attempt. */
	nextDueAt: number;
	/**
	 * The wait currently being served after a failure, doubling each consecutive
	 * one. **Absent while healthy** — carrying a value through a success made the
	 * first failure after it wait twice as long as `BACKOFF_START_MS`, so the
	 * constant never described any real delay.
	 */
	backoffMs?: number;
	/** Consecutive failures. Reset by a success, or by `reset`. */
	failures?: number;
	/** Set once the account has failed too often to keep trying unattended. */
	halted?: boolean;
}

export class AutoConfirmEngine {
	private readonly vault: VaultService;
	private readonly confirmations: ConfirmationsService;
	private readonly onOutcome: (steamId64: string, outcome: AutoConfirmOutcome) => void;
	private readonly onFailure: (
		steamId64: string,
		reason: string,
		halted: boolean,
		context?: { accountName: string; mode: PollMode }
	) => void;
	private readonly onPending: (
		steamId64: string,
		accountName: string,
		awaiting: ConfirmationSummary[],
		unreadable: number,
		detail: NotifyDetail
	) => void;
	private readonly onSignInNeeded: (steamId64: string, accountName: string) => void;
	private readonly requireProxies: () => boolean;
	private readonly ensureClock: () => Promise<void>;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
	private readonly clearTimer: (handle: NodeJS.Timeout) => void;

	private readonly state = new Map<string, AccountState>();

	/**
	 * The soonest `nextDueAt` across every scheduled account, or 0 when the
	 * schedule may have changed and has to be rebuilt from the vault.
	 *
	 * This is what makes a one-second beat cheap: without it every beat called
	 * `dueAccounts`, which deep-clones the whole secret-bearing vault to answer
	 * "not yet". Reset to 0 by anything that can add or change a schedule, so a
	 * new or re-enabled account is never held back by it.
	 */
	/**
	 * Bumped per account whenever its route or its settings change.
	 *
	 * **Separate from `generation`, which means "the vault locked".** Bumping the
	 * global counter to disown one account's in-flight poll would disown every
	 * other account's too, which is the mistake `confirmations/service.ts`
	 * documents having made and replaced with per-account epochs.
	 *
	 * Without this, saving a proxy aborted the request in flight and the abort
	 * came back as an ordinary error: the user's own save was recorded as a
	 * failure, pushed the next poll out by up to fifteen minutes, and counted
	 * toward the ten-strike halt.
	 */
	private readonly epochs = new Map<string, number>();

	/**
	 * The schedule was invalidated and has not been rebuilt from the vault yet.
	 *
	 * **`earliestDueAt = 0` is not enough on its own**, and assuming it was is a
	 * defect this class shipped with. Any other account's `runOne` finishing
	 * later in the same sweep calls `rememberEarliest`, which recomputes the
	 * cache from the state map — a map the forgotten account is no longer in — so
	 * the invalidation is silently undone by a sibling.
	 *
	 * With one account it is harmless: the map goes empty and the ternary yields
	 * 0 anyway, which is why every test of `reset` and `forgetAccount` missed it.
	 * With two it is not. A halted sibling holds `nextDueAt: Infinity`, so the
	 * recompute pins `earliestDueAt` at Infinity and the beat's early-out stops
	 * the engine reading the vault at all — for **every** account, until a lock
	 * or another settings save. The account whose proxy was just repaired is
	 * never re-seeded, which is precisely the freeze `forgetAccount` was written
	 * to prevent.
	 *
	 * Cleared by `tick` once `dueAccounts` has actually re-read the vault.
	 */
	private scheduleDirty = false;

	private earliestDueAt = 0;
	private ticker: NodeJS.Timeout | undefined;
	/** Guards against a slow pass overlapping the next tick. */
	/**
	 * Accounts with a poll in the air.
	 *
	 * **This replaced a single `running` flag, and the flag was the reason the
	 * stagger did not hold.** A sweep that took longer than one beat suppressed
	 * every beat inside it, so the slots of every account seeded into that
	 * window elapsed unobserved and the next sweep found them all due at once —
	 * `Promise.all` then started them in a single microtask. Twelve accounts on
	 * twelve proxies, polling in lockstep: exactly the timing correlation the
	 * seeding block and THREAT_MODEL say is prevented. Measured before the fix at
	 * a 2.5s round trip: three accounts collapsed to two simultaneous starts on
	 * the first sweep after unlock, and twelve produced more than one start on 26
	 * of 40 beats.
	 *
	 * The flag also made one dead proxy's thirty-second timeout suppress every
	 * beat for thirty seconds — the same stall `Promise.all` was introduced to
	 * prevent, reintroduced one level up.
	 *
	 * Per account, so the property that actually matters is the one enforced: no
	 * account is polled twice at once, and beats go on sampling while any number
	 * of them are in flight.
	 */
	private readonly inFlight = new Set<string>();

	/**
	 * The clock sync shared by every sweep overlapping it.
	 *
	 * `running` used to make this impossible, and now that beats overlap, one
	 * `ensureClock` per beat would be a Steam round trip per second.
	 */
	private clockSync: Promise<void> | undefined;

	/**
	 * Bumped by `stop`, so work started before a lock cannot write state after it.
	 *
	 * The same shape as the epoch the transport uses to refuse a request that
	 * outlived its unlock, applied one layer up to the bookkeeping rather than to
	 * the request.
	 */
	private generation = 0;

	/**
	 * Identifies the scheduler chain, so a fired timer can tell whether it is
	 * still the current one.
	 *
	 * `schedule` used to decide whether to continue by testing `if (this.ticker)`
	 * — truthiness, not identity. A sweep parked on the network during a lock and
	 * unlock therefore saw the *new* chain's handle, judged itself current, and
	 * scheduled a second chain alongside it. `this.ticker` can only track one, so
	 * `stop` could then clear only one and the other kept firing.
	 */
	private chain = 0;

	constructor(options: AutoConfirmEngineOptions) {
		this.vault = options.vault;
		this.confirmations = options.confirmations;
		this.onOutcome = guarded(options.onOutcome);
		this.onFailure = guarded(options.onFailure);
		this.onPending = guarded(options.onPending);
		this.onSignInNeeded = guarded(options.onSignInNeeded);
		this.requireProxies = options.requireProxies ?? ((): boolean => false);
		this.ensureClock = options.ensureClock ?? ((): Promise<void> => Promise.resolve());
		this.now = options.now ?? ((): number => Date.now());
		this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
	}

	/** Begin checking. Safe to call when nothing is enabled — it simply idles. */
	start(): void {
		if (this.ticker) {
			return;
		}
		this.schedule(this.chain);
	}

	/** Stop, and forget every account's schedule. Called on lock and on quit. */
	stop(): void {
		if (this.ticker) {
			this.clearTimer(this.ticker);
			this.ticker = undefined;
		}
		// **Bumped before the clear, so anything already running is disowned.**
		//
		// Clearing alone did not stop a sweep that was mid-flight: `runOne` was
		// inside an await, and when its request came back — aborted by the same
		// lock, and therefore a failure — it wrote a backoff or a failure count into
		// the map that had just been emptied. The next unlock inherited it.
		//
		// The compounding version is the one that bites: every lock during polling
		// scored a failure against the account, and ten of those produce
		// "automatic confirmation stopped after 10 failures in a row" — a permanent
		// halt caused entirely by locking the vault normally.
		this.generation += 1;
		// Disowns any chain already scheduled or mid-sweep, including one this call
		// cannot reach because its timer has already fired.
		this.chain += 1;
		this.state.clear();
		this.earliestDueAt = 0;
		// **`inFlight` is deliberately not cleared.** Those requests are still in
		// the air; each removes itself when it settles. Clearing here would let the
		// next unlock start a second request for an account whose first is still
		// running — the exact overlap the set exists to prevent — and the disowning
		// the generation bump above provides is what makes the stale one harmless.
	}

	/**
	 * Drop one account's backoff and timing.
	 *
	 * Called when its settings change: someone who just switched auto-confirm on
	 * should not wait out a backoff earned before they did.
	 */
	reset(steamId64: string): void {
		/*
		 * **The epoch too, not only the schedule.**
		 *
		 * A poll captures `notify` and the disclosure detail before its request
		 * and uses them after it. Clearing the schedule alone left a request in
		 * flight holding the settings the user had just replaced — so switching
		 * notifications to Off, or `full` down to `count`, still produced one last
		 * `full` toast naming the trade partner and the headline. The one toast
		 * somebody switched the feature off to stop.
		 *
		 * Disowning it costs nothing that matters: `runOne` still reports an
		 * outcome it really achieved, because approving a trade is a fact about
		 * the world whatever the settings now say. What it stops is a schedule
		 * written from replaced settings, and a notification composed under a
		 * policy that no longer holds.
		 */
		this.epochs.set(steamId64, this.epochOf(steamId64) + 1);
		this.state.delete(steamId64);
		this.scheduleDirty = true;
		// The schedule just changed; the cached soonest time may no longer be it.
		this.earliestDueAt = 0;
	}

	/**
	 * One sweep. Exposed so a test can drive it directly rather than through a
	 * timer, and so nothing here depends on real time passing.
	 */
	async tick(): Promise<void> {
		// **No global re-entrance gate.** See `inFlight`: one flag here made the
		// heartbeat serial, which collapsed the stagger it exists to keep and let
		// a single dead proxy suppress every beat for its whole timeout. Overlap
		// is prevented per account instead, where it means something.
		//
		// Cheap early-out, before the vault is read. See `earliestDueAt`.
		if (this.earliestDueAt > this.now()) {
			return;
		}
		const generation = this.generation;
		// A locked vault is the clearest possible statement that nobody is present.
		if (!this.vault.isUnlocked()) {
			this.state.clear();
			this.earliestDueAt = 0;
			return;
		}

		// Before the first request of the pass, not after it. A confirmation is
		// signed with an HMAC over Steam-corrected time, so a pass that runs
		// before the offset is known signs with zero — and on a skewed machine
		// every one of those is refused, counted as a failure, and backed off
		// from. Shared across overlapping beats, so a slow sync costs one round
		// trip rather than one per second.
		await this.syncClock();

		// Re-checked: the sync above is network I/O, and the vault can lock while
		// it is in flight.
		if (this.generation !== generation || !this.vault.isUnlocked()) {
			return;
		}

		// In parallel, not in sequence. Accounts are independent — the service
		// serialises per account precisely because of that — and awaiting each
		// in turn meant one dead proxy's thirty-second timeout stalled every
		// account behind it in the list, every sweep. A lock partway through is
		// still caught: `runOne` checks the generation around its own await, and
		// the service refuses work for a locked vault.
		//
		// **Ordinarily one account**, because the slots are a beat apart and beats
		// no longer wait for the previous sweep. Where it is more than one, they
		// share a slot rather than having been bunched by a stall.
		const due = this.dueAccounts();
		// The vault has now been re-read and the schedule rebuilt from it, so
		// the invalidation has been honoured and a later `rememberEarliest` may
		// trust the map again.
		//
		// **Clearing it one line earlier is an equivalent mutant, not an
		// untested one.** Nothing between the two positions reads the flag
		// except the seeded-accounts `rememberEarliest` inside `dueAccounts`,
		// and recomputing there is correct: those slots were just assigned from
		// the vault this call read. Recorded so the next person to notice does
		// not go looking for the missing test.
		this.scheduleDirty = false;
		/*
		 * **And recompute now that it may be trusted again.**
		 *
		 * `rememberEarliest` returns 0 while the flag is set, and the halt path
		 * calls it immediately after writing `nextDueAt: Infinity`. So a halt that
		 * landed while a sibling's `forgetAccount` had the flag up pinned
		 * `earliestDueAt` at 0 for the life of the process: `tick` cleared the
		 * flag but nothing recomputed, because a halted account is skipped by
		 * `dueAccounts` without seeding, so no later `rememberEarliest` ever ran.
		 * Every beat then re-read the vault to rediscover there was nothing to do
		 * — the exact property tests/auto-confirm-engine.test.ts:920 pins.
		 *
		 * Free here: the accounts about to be polled rewrite their own entries and
		 * recompute again as they finish.
		 */
		this.rememberEarliest();
		// **No third generation check here.** There was one, and it could never be
		// true: only synchronous statements separate it from the check above, so
		// neither value can have changed. Unreachable code that reads as a live
		// guard is worse than no guard — no test can cover it, and deleting it is
		// an undetectable mutation.
		await Promise.all(due.map((account, index) => this.runOne(account, generation, index)));
	}

	/**
	 * The Steam clock offset, fetched at most once however many beats want it.
	 *
	 * Beats overlap now (see `inFlight`), so an unshared `ensureClock` would put
	 * a Steam round trip on every beat — one per second — the moment a sync
	 * became slow enough to outlast one.
	 */
	private syncClock(): Promise<void> {
		if (!this.clockSync) {
			const sync = Promise.resolve(this.ensureClock()).finally(() => {
				// Only if it is still ours: a later sweep may already have started
				// the next one.
				if (this.clockSync === sync) {
					this.clockSync = undefined;
				}
			});
			this.clockSync = sync;
		}
		return this.clockSync;
	}

	/** Accounts with something enabled, whose next attempt is due. */
	private epochOf(steamId64: string): number {
		return this.epochs.get(steamId64) ?? 0;
	}

	/**
	 * This account's route or settings changed. Disown whatever is in the air.
	 *
	 * Also clears its schedule, so the next beat rebuilds it from the vault —
	 * which is what lets replacing a dead proxy lift the halt that dead proxy
	 * caused. Nothing else did: a halted account was pinned until a settings
	 * save, a lock, or a restart.
	 */
	forgetAccount(steamId64: string): void {
		this.epochs.set(steamId64, this.epochOf(steamId64) + 1);
		this.state.delete(steamId64);
		this.scheduleDirty = true;
		// A removed account never appears in the projection again, so nothing else
		// could ever clear its entry — and a halted one left behind pins
		// `earliestDueAt` at infinity, which stops the engine reading the vault at
		// all.
		this.earliestDueAt = 0;
	}

	private dueAccounts(): DueAccount[] {
		const now = this.now();
		const due: DueAccount[] = [];
		/** How many accounts this beat is meeting for the first time. */
		let seeded = 0;

		/*
		 * The projection, not the whole vault.
		 *
		 * `read()` deep-clones every secret the vault holds, and this runs on
		 * every beat that the `earliestDueAt` early-out does not cover — which,
		 * for a vault where nobody has switched auto-confirm on, is all of them,
		 * forever. Nothing scheduled means nothing cached means the early-out
		 * never fires. What is actually needed is an id, a name, three switches,
		 * an interval and whether a proxy exists.
		 */
		for (const account of this.vault.autoConfirmSchedule()) {
			const wantsConfirm = account.marketListings || account.trades;
			const wantsNotify = account.notify.enabled;

			// The switches the user set are what decide whether this account is
			// polled at all. Nothing enabled means no request is ever made for it.
			if (!wantsConfirm && !wantsNotify) {
				this.state.delete(account.steamId64);
				continue;
			}

			// **Under `Require proxies`, an account with none cannot build a
			// transport at all** — `transports.forAccount` throws before any request
			// is made. Polling it anyway spends ten failures reaching a halt caused
			// by a policy refusal rather than a fault, and then hides the account
			// until something unrelated changes.
			if (this.requireProxies() && !account.hasProxy) {
				this.state.delete(account.steamId64);
				continue;
			}

			// **Already in the air.** Beats no longer wait for the previous sweep,
			// so a poll that outlasts one is still running when the next beat
			// samples — and its `nextDueAt` is not rewritten until it finishes, so
			// it still reads as due. Without this an account behind a slow proxy
			// would be polled again every second until the first one returned.
			if (this.inFlight.has(account.steamId64)) {
				continue;
			}

			const state = this.state.get(account.steamId64);
			// A halted account is left alone until something changes — settings, a
			// route, a lock, or a restart. Continuing to poke a dead session
			// forever, quietly, is exactly what the halt exists to stop.
			if (state?.halted) {
				continue;
			}

			// **An account nothing has scheduled yet gets a slot, not a request.**
			//
			// "No state" used to mean "due now", so every enabled account polled on
			// the same beat after an unlock — twelve accounts, twelve concurrent
			// requests, on twelve different proxies, at the one moment the vault is
			// most obviously in use. The stagger existed but only ever applied to
			// the *next* due time, so the first sweep of every session, and of every
			// lock/unlock cycle, went out in lockstep.
			//
			// Seeding costs one beat before the first poll and keeps the spacing
			// afterwards, because the accounts keep the offsets assigned here.
			if (!state) {
				const intervalMs = Math.max(MIN_INTERVAL_MS, account.pollIntervalSeconds * 1000);
				// Spread over the **whole** interval, not the quarter `staggerFor`
				// uses. That cap keeps a long list from walking into the next cycle,
				// which matters when the offsets are already established; here there
				// is nothing to walk into, and a quarter of fifteen seconds is three
				// slots for however many accounts the vault holds.
				const beats = Math.max(1, Math.floor(intervalMs / SCHEDULER_TICK_MS));
				const offset = (seeded % beats) * SCHEDULER_TICK_MS;
				seeded += 1;
				if (offset > 0) {
					this.state.set(account.steamId64, { nextDueAt: now + offset });
					continue;
				}
				// Offset zero: this one goes now, and `runOne` writes its schedule.
				// Holding even the first account back would make every unlock feel
				// like the app had not started.
			}

			// `state` is still undefined on the offset-zero fall-through above, which
			// is the one path that reaches here without one.
			if (state && state.nextDueAt > now) {
				continue;
			}
			due.push({
				steamId64: account.steamId64,
				accountName: account.accountName,
				pollIntervalSeconds: account.pollIntervalSeconds,
				// An account with an auto type on takes the confirm arm even if it
				// also wants notifications: one poll serves both, and `runAutoConfirm`
				// reports what it held back.
				mode: wantsConfirm ? 'confirm' : 'notify',
				notify: wantsNotify,
				detail: account.notify.detail
			});
		}

		// The seeded entries are new deadlines, so the cheap early-out has to learn
		// about them — otherwise it keeps the stale one and the beat that was
		// supposed to poll them never reads the vault.
		if (seeded > 0) {
			this.rememberEarliest();
		}

		return due;
	}

	/**
	 * A stable offset, unique per account, within its own poll interval.
	 *
	 * **Accounts used to tick in lockstep.** Every account on the same interval
	 * fired in the same pass, so their requests arrived at Steam within
	 * milliseconds of each other — repeatedly, forever. Separate exit addresses do
	 * not hide that: synchronised arrival times across a set of proxies is itself
	 * a signal that one operator is behind them, and it is one the routing feature
	 * cannot touch.
	 *
	 * **Derived from the position in the sweep, not from the SteamID.** This said
	 * "derived from the SteamID" for a long time after it had stopped being true —
	 * contradicted eight lines below by its own inline comment and by a body that
	 * mentions no account id at all. The rationale it gave still holds under the
	 * real mechanism, which is why nobody noticed: index order is stable across a
	 * restart, so the offsets do not reshuffle on every launch, and a whole set of
	 * accounts changing phase at once is the correlation that would replace the
	 * one this prevents.
	 *
	 * Cheap and non-cryptographic on purpose: this decides when to poll, not
	 * anything a secret depends on.
	 */
	private staggerFor(index: number, intervalMs: number): number {
		// **Whole beats, and distinct per account.** The old jitter was a hash of
		// the SteamID over `interval / 4` — under four seconds at the default
		// interval — and the scheduler only samples work on a beat, so every
		// account's next due time landed inside the same beat and they polled
		// together anyway. Randomness finer than the sampling interval is not
		// jitter; it is rounding error.
		//
		// The index within one sweep is what separates them: account 0 comes due
		// on its beat, account 1 one beat later, and because they share an
		// interval they keep that separation for good. Capped at a quarter of the
		// interval so a long account list cannot walk itself into the next cycle.
		const beats = Math.max(1, Math.floor(intervalMs / 4 / SCHEDULER_TICK_MS));
		return (index % beats) * SCHEDULER_TICK_MS;
	}

	/**
	 * @param generation the sweep this belongs to. Any write is skipped if `stop`
	 * has been called since — see the note there.
	 */
	private async runOne(
		account: DueAccount,
		generation = this.generation,
		/** This account's position in the sweep. See `staggerFor`. */
		index = 0
	): Promise<void> {
		const { steamId64, accountName, mode, notify, detail } = account;
		const interval = Math.max(MIN_INTERVAL_MS, account.pollIntervalSeconds * 1000);
		const jitter = this.staggerFor(index, interval);
		/**
		 * The route this poll was started on.
		 *
		 * Checked beside `generation` at every write. A proxy change aborts the
		 * request in flight, and that abort arrives as an ordinary error — so
		 * without this the user's own save was scored as a Steam failure, backed
		 * the account off by up to fifteen minutes, and counted toward the halt.
		 */
		const epoch = this.epochOf(steamId64);
		/** True while this poll still owns the account it was started for. */
		const current = (): boolean =>
			this.generation === generation && this.epochOf(steamId64) === epoch;

		// **Claimed before the first await**, so a beat that lands while this one
		// is talking to Steam sees the account as busy rather than as due. There
		// is no await between `dueAccounts` deciding and this line, so no beat can
		// slip between the decision and the claim.
		this.inFlight.add(steamId64);
		try {
			if (mode === 'confirm') {
				const outcome = await this.confirmations.runAutoConfirm(steamId64);

				// Disowned by a `stop` that happened while this was in the air.
				// Reporting the outcome is still right — it describes something that
				// really did occur — but nothing may be scheduled on a cleared map,
				// and **no `onPending`**: a lock happened, and a toast raised after
				// the vault closed is precisely what `stop()` exists to prevent.
				if (!current()) {
					this.onOutcome(steamId64, outcome);
					return;
				}

				// No `backoffMs` and no `failures`: a success clears both penalties.
				this.state.set(steamId64, { nextDueAt: this.now() + interval + jitter });
				this.rememberEarliest();
				this.onOutcome(steamId64, outcome);

				if (notify) {
					// `held` is the set that still needs a person: anything Steam listed
					// that the policy refused to approve.
					this.onPending(
						steamId64,
						accountName,
						outcome.held.map((entry) => entry.confirmation),
						outcome.unreadable,
						detail
					);
				}
				return;
			}

			// Notify-only. `list()`, never `runAutoConfirm` — which approves nothing
			// with both switches off and returns an empty outcome, so an account
			// routed through it would poll forever and never tell anybody anything.
			const listing = await this.confirmations.list(steamId64);
			if (!current()) {
				return;
			}
			this.state.set(steamId64, { nextDueAt: this.now() + interval + jitter });
			this.rememberEarliest();
			this.onPending(steamId64, accountName, listing.confirmations, listing.unreadable, detail);
		} catch (err) {
			// **The failure is not recorded at all if a lock caused it.**
			//
			// Nothing here can distinguish "Steam refused us" from "our own abort on
			// lock", and counting the second toward the ten-strike halt means normal
			// locking eventually stops automatic confirmation for good — a fault the
			// user never caused and cannot see the cause of.
			// A lock, or this account's route changing under the request. Neither is
			// a Steam failure and neither may write to a schedule that has moved on.
			if (!current()) {
				return;
			}

			// **Before the failure counter, and on both arms.**
			//
			// An expired session is not a fault that backing off fixes, and it is
			// the same condition whichever arm found it. Counting it would spend ten
			// strikes reaching a halt phrased "failures in a row" — for the one
			// condition only the user can clear, and which the activity log's
			// `failed` kind is not urgent enough to surface.
			//
			// Catching this on the notify arm alone would be exactly backwards:
			// every account with an auto type on takes the confirm arm, so the
			// accounts that have this problem are the ones the fix would miss.
			if (err instanceof ConfirmationsError && err.needsSignIn) {
				/*
				 * **Not counted, and not erased either.**
				 *
				 * Writing a fresh record here discarded whatever the account had
				 * already accumulated. An account alternating 403s with ordinary
				 * errors — a flaky proxy in front of Steam is exactly that — reset
				 * its counter on every other poll, so it never reached the halt and
				 * never accumulated backoff: failing forever at a fifteen-second
				 * cadence while the user believes it is working, which is the
				 * outcome the halt exists to prevent. It also turned a failure into
				 * a speed-up, from a maxed backoff back to the plain interval.
				 *
				 * So the schedule moves and the tally stays.
				 */
				const carried = this.state.get(steamId64);
				this.state.set(steamId64, {
					nextDueAt: this.now() + interval + jitter,
					...(carried?.failures === undefined ? {} : { failures: carried.failures }),
					...(carried?.backoffMs === undefined ? {} : { backoffMs: carried.backoffMs })
				});
				this.rememberEarliest();
				this.onSignInNeeded(steamId64, accountName);
				return;
			}

			const previous = this.state.get(steamId64);
			const failures = (previous?.failures ?? 0) + 1;
			// Redacted: this reaches the activity log and the renderer, and a routing
			// failure quotes the proxy URL it failed on, credentials included.
			const reason = redactCredentials(err instanceof Error ? err.message : String(err));

			if (failures >= HALT_AFTER_FAILURES) {
				// Ten in a row is not a blip. Stop, and say so — the alternative is
				// failing forever at fifteen-minute intervals while the user believes
				// this is working.
				this.state.set(steamId64, { nextDueAt: Number.POSITIVE_INFINITY, failures, halted: true });
				// **The cheap early-out depends on this.** Without it `earliestDueAt`
				// stayed at the halted account's old due time, so every one-second beat
				// went on deep-cloning the whole secret-bearing vault to rediscover
				// that there was nothing to do — for as long as the process ran.
				this.rememberEarliest();
				// The flag, not the wording. The activity log used to decide whether
				// this was a halt by running `/stopped/i` over the sentence below —
				// and **both** sentences below now contain "stopped", so that would be
				// ambiguous as well as fragile.
				const what =
					mode === 'confirm'
						? 'Automatic confirmation stopped for this account'
						: // An account that was only ever watching never had automatic
							// confirmation to stop.
							'Checking stopped for this account';
				this.onFailure(
					steamId64,
					`${what} after ${failures} failures in a row. The last one was: ${reason}`,
					true,
					{ accountName, mode }
				);
				return;
			}

			// Backoff, never a retry. The likeliest cause is Steam rate-limiting, and
			// hammering it is how a slow minute becomes a blocked hour.
			const backoffMs =
				previous?.backoffMs === undefined
					? BACKOFF_START_MS
					: Math.min(BACKOFF_MAX_MS, previous.backoffMs * 2);
			this.state.set(steamId64, { nextDueAt: this.now() + backoffMs, backoffMs, failures });
			this.rememberEarliest();

			this.onFailure(steamId64, reason, false, { accountName, mode });
		} finally {
			// Released whatever happened, including a disowned poll: leaving the
			// claim behind would make the account permanently unpollable.
			this.inFlight.delete(steamId64);
		}
	}

	/**
	 * The soonest scheduled attempt, so most beats can skip the vault read.
	 *
	 * An empty map means "ask the vault", not "nothing to do" — an account that
	 * has never run has no entry at all.
	 */
	private rememberEarliest(): void {
		// An invalidation outranks a recomputation: the map cannot describe an
		// account that was just removed from it.
		if (this.scheduleDirty) {
			this.earliestDueAt = 0;
			return;
		}
		let soonest = Number.POSITIVE_INFINITY;
		for (const entry of this.state.values()) {
			if (entry.nextDueAt < soonest) {
				soonest = entry.nextDueAt;
			}
		}
		this.earliestDueAt = this.state.size === 0 ? 0 : soonest;
	}

	private schedule(chain: number): void {
		// A fixed short heartbeat rather than one timer per account: per-account
		// timing is decided by `nextDueAt`, so a settings change takes effect on the
		// next beat instead of needing timers torn down and rebuilt.
		const handle = this.setTimer(() => {
			// Identity, not truthiness. A chain `stop` has disowned must not run a
			// sweep and must not schedule a successor, however healthy the engine
			// looks by the time its timer fires.
			if (chain !== this.chain) {
				return;
			}
			/*
			 * **The next beat is armed before the sweep, not after it.**
			 *
			 * Chaining from the sweep's own `finally` is what made the heartbeat
			 * serial: no beat happened while a sweep was in flight, so a poll that
			 * outlasted a beat swallowed every slot that elapsed during it and the
			 * next sweep found them all due together. The stagger the seeding block
			 * assigns only survives if something is there to observe each slot.
			 *
			 * Re-entrance is not a worry: `tick` polls only accounts that are due
			 * and not already in flight, so a beat during a slow poll does nothing
			 * for that account and everything for the others.
			 */
			this.schedule(chain);
			// Swallowed rather than left to reject: this is a fired timer with no
			// caller, and an unhandled rejection in the main process is a crash on
			// some builds. Every failure a sweep can report has already gone
			// through `onFailure` by the time it gets here.
			void this.tick().catch(() => undefined);
		}, SCHEDULER_TICK_MS);
		handle.unref?.();
		this.ticker = handle;
	}
}
