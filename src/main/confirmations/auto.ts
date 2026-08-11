import { redactCredentials } from '../net/egress';
import type { ConfirmationsService, AutoConfirmOutcome } from './service';
import type { VaultService } from '../vault/service';

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
 *    neither type enabled is never polled at all, so the default costs no
 *    requests and takes no risk.
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

export interface AutoConfirmEngineOptions {
	vault: VaultService;
	confirmations: ConfirmationsService;
	/** Told what happened, so the UI or a notification can surface it. */
	onOutcome?: (steamId64: string, outcome: AutoConfirmOutcome) => void;
	/** Told when a pass failed, with the reason already made presentable. */
	/** @param halted true when the engine has given up on this account entirely. */
	onFailure?: (steamId64: string, reason: string, halted: boolean) => void;
	/** Injected for testability. */
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (handle: NodeJS.Timeout) => void;
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
	private readonly onFailure: (steamId64: string, reason: string, halted: boolean) => void;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
	private readonly clearTimer: (handle: NodeJS.Timeout) => void;

	private readonly state = new Map<string, AccountState>();
	private ticker: NodeJS.Timeout | undefined;
	/** Guards against a slow pass overlapping the next tick. */
	private running = false;

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
		this.onOutcome = options.onOutcome ?? ((): void => undefined);
		this.onFailure = options.onFailure ?? ((): void => undefined);
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
	}

	/**
	 * Drop one account's backoff and timing.
	 *
	 * Called when its settings change: someone who just switched auto-confirm on
	 * should not wait out a backoff earned before they did.
	 */
	reset(steamId64: string): void {
		this.state.delete(steamId64);
	}

	/**
	 * One sweep. Exposed so a test can drive it directly rather than through a
	 * timer, and so nothing here depends on real time passing.
	 */
	async tick(): Promise<void> {
		if (this.running) {
			return;
		}
		const generation = this.generation;
		// A locked vault is the clearest possible statement that nobody is present.
		if (!this.vault.isUnlocked()) {
			this.state.clear();
			return;
		}

		this.running = true;
		try {
			for (const account of this.dueAccounts()) {
				// Re-checked between accounts as well as inside `runOne`: a lock partway
				// through a sweep must not mean the rest of the list is still visited.
				if (this.generation !== generation || !this.vault.isUnlocked()) {
					return;
				}
				await this.runOne(account.steamId64, account.pollIntervalSeconds, generation);
			}
		} finally {
			this.running = false;
		}
	}

	/** Accounts with something enabled, whose next attempt is due. */
	private dueAccounts(): { steamId64: string; pollIntervalSeconds: number }[] {
		const now = this.now();
		const due: { steamId64: string; pollIntervalSeconds: number }[] = [];

		for (const account of this.vault.read().accounts) {
			// The switch the user set is what decides whether this account is polled
			// at all. Nothing enabled means no request is ever made for it.
			if (!account.autoConfirm.marketListings && !account.autoConfirm.trades) {
				this.state.delete(account.steamId64);
				continue;
			}
			const state = this.state.get(account.steamId64);
			// A halted account is left alone until something changes — settings, a
			// lock, or a restart. Continuing to poke a dead session forever, quietly,
			// is exactly what the halt exists to stop.
			if (state?.halted) {
				continue;
			}
			if (state && state.nextDueAt > now) {
				continue;
			}
			due.push({
				steamId64: account.steamId64,
				pollIntervalSeconds: account.autoConfirm.pollIntervalSeconds
			});
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
	 * Derived from the SteamID rather than random so it survives a restart. An
	 * offset that reshuffles on every launch would produce a *different* kind of
	 * correlation — a whole set of accounts changing phase at the same moment.
	 *
	 * Cheap and non-cryptographic on purpose: this decides when to poll, not
	 * anything a secret depends on.
	 */
	private jitterFor(steamId64: string, intervalMs: number): number {
		let hash = 0;
		for (let i = 0; i < steamId64.length; i += 1) {
			hash = (hash * 31 + steamId64.charCodeAt(i)) % 1_000_003;
		}
		// Up to a quarter of the interval. Enough to break simultaneity without
		// meaningfully delaying a confirmation anyone is waiting on.
		return hash % Math.max(1, Math.floor(intervalMs / 4));
	}

	/**
	 * @param generation the sweep this belongs to. Any write is skipped if `stop`
	 * has been called since — see the note there.
	 */
	private async runOne(
		steamId64: string,
		pollIntervalSeconds: number,
		generation = this.generation
	): Promise<void> {
		const interval = Math.max(MIN_INTERVAL_MS, pollIntervalSeconds * 1000);
		const jitter = this.jitterFor(steamId64, interval);

		try {
			const outcome = await this.confirmations.runAutoConfirm(steamId64);

			// Disowned by a `stop` that happened while this was in the air. Reporting
			// the outcome is still right — it describes something that really did
			// occur — but nothing may be scheduled on a cleared map.
			if (this.generation !== generation) {
				this.onOutcome(steamId64, outcome);
				return;
			}

			// No `backoffMs` and no `failures`: a success clears both penalties.
			this.state.set(steamId64, { nextDueAt: this.now() + interval + jitter });
			this.onOutcome(steamId64, outcome);
		} catch (err) {
			// **The failure is not recorded at all if a lock caused it.**
			//
			// Nothing here can distinguish "Steam refused us" from "our own abort on
			// lock", and counting the second toward the ten-strike halt means normal
			// locking eventually stops automatic confirmation for good — a fault the
			// user never caused and cannot see the cause of.
			if (this.generation !== generation) {
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
				// The flag, not the wording. The activity log used to decide whether
				// this was a halt by running `/stopped/i` over the sentence below.
				this.onFailure(
					steamId64,
					`Automatic confirmation stopped for this account after ${failures} failures in a row. ` +
						`The last one was: ${reason}`,
					true
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

			this.onFailure(steamId64, reason, false);
		}
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
			void this.tick().finally(() => {
				if (chain === this.chain) {
					this.schedule(chain);
				}
			});
		}, MIN_INTERVAL_MS);
		handle.unref?.();
		this.ticker = handle;
	}
}
