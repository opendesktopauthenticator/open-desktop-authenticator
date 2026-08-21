import { generateGuardCode, GuardCodeError, secondsRemaining } from './totp';
import type { VaultService } from '../vault/service';

/**
 * Steam Guard codes for the accounts in the vault (§12 F4).
 *
 * Deliberately free of any `electron` import and of any network access. A code
 * is a pure function of the shared secret and the time, and keeping it that way
 * means the one computation users depend on cannot fail because something was
 * unreachable.
 *
 * ## The clock
 *
 * Steam validates a code against **its** clock. A machine more than half a
 * window out produces codes Steam rejects, and the user sees "invalid code" with
 * nothing to suggest their clock is the problem. SDA solves this by asking Steam
 * for the offset.
 *
 * That request is network I/O and lives in `steam/time.ts`, called through
 * `SteamClock` so it rides the same per-account transport as everything else.
 * `setTimeOffset` is the seam that records a successful check. A failed sync must
 * **not** call it with zero: that would record "checked, and we are correct" for
 * a clock nobody checked, and permanently silence the warning the user needs.
 * `clockUnverified` is reported to the renderer so the UI can say plainly that
 * the time has not been checked against Steam, rather than letting a skewed
 * machine look like a broken authenticator.
 */

export interface GuardCode {
	steamId64: string;
	accountName: string;
	code: string;
	secondsRemaining: number;
}

export interface CodeServiceOptions {
	/** Injected for testability. Defaults to the wall clock. */
	now?: () => number;
	/**
	 * A clock that only ever counts forward and that nothing can set.
	 *
	 * Separate from `now` because the whole point is that the two can disagree:
	 * comparing them is how a system-clock correction is detected. Injected for
	 * the same reason `now` is — a test cannot wait fifteen real minutes, and it
	 * certainly cannot change the machine's time.
	 */
	monotonic?: () => number;
}

/** One day. Generous for a clock skew; anything beyond it is not a sync result. */
const MAX_TIME_OFFSET_SECONDS = 86_400;

/**
 * How long a measured offset is trusted before it is worth taking again.
 *
 * Fifteen minutes. Short enough that a clock corrected mid-session is picked up
 * long before somebody gives up on their codes, long enough that this costs one
 * request an hour rather than becoming traffic Steam would notice. The check
 * itself is free — `clockStale` is arithmetic, and a request only follows when
 * it answers true.
 */
const OFFSET_TTL_MS = 15 * 60_000;

/**
 * How far the wall clock may drift from the monotonic clock before the offset is
 * treated as measured against a machine that no longer exists.
 *
 * Two seconds. `Date.now()` and a monotonic reading advance together while
 * nothing touches the system clock; the moment somebody corrects it, an NTP step
 * lands, or a VM resumes with a new time, they diverge by exactly the size of
 * the correction. The tolerance only has to clear ordinary scheduling jitter,
 * and a Steam Guard window is thirty seconds — so anything worth calling a
 * correction is far outside it.
 */
const CLOCK_JUMP_TOLERANCE_MS = 2_000;

export class CodeService {
	private readonly vault: VaultService;
	private readonly now: () => number;
	private readonly monotonic: () => number;
	/** Seconds to add to the local clock to match Steam's. */
	private offsetSeconds = 0;
	private offsetVerified = false;
	/** When the offset was last measured, by the local clock. */
	private offsetMeasuredAt: number | undefined;
	/**
	 * The same instant on a clock nothing can set.
	 *
	 * Kept beside the wall-clock reading so the two can be compared later. A TTL
	 * alone could not see a correction *smaller* than itself: a user five minutes
	 * fast, synced, then corrected, had a five-minute-wrong offset applied to a
	 * now-correct clock for the next twenty minutes — while the thing that made it
	 * wrong was the very event a staleness check exists to notice.
	 */
	private offsetMeasuredAtMonotonic: number | undefined;

	constructor(vault: VaultService, options: CodeServiceOptions = {}) {
		this.vault = vault;
		this.now = options.now ?? (() => Date.now());
		// `performance.now()` is monotonic and unaffected by anything that sets the
		// system clock, which is exactly the property being relied on here.
		this.monotonic = options.monotonic ?? ((): number => performance.now());
	}

	/**
	 * Record the measured difference between this machine and Steam.
	 *
	 * Called by the Steam module once it exists. A failed sync must **not** call
	 * this with zero: that would record "checked, and we are correct" for a clock
	 * nobody checked, and permanently silence the warning the user needs (the
	 * same trap the spike hit and documented).
	 */
	setTimeOffset(seconds: number): void {
		if (!Number.isFinite(seconds)) {
			throw new RangeError('time offset must be a finite number of seconds');
		}
		// Bounded, not merely finite. Real offsets are seconds — a machine a whole
		// day out has a clock problem, not a sync problem — and an unbounded value
		// could drive Steam-corrected time negative, which no amount of care further
		// down can turn back into a sensible code or countdown.
		if (Math.abs(seconds) > MAX_TIME_OFFSET_SECONDS) {
			throw new RangeError(
				`a time offset of ${Math.round(seconds)}s is not credible; refusing to apply it`
			);
		}
		this.offsetSeconds = Math.round(seconds);
		this.offsetVerified = true;
		this.offsetMeasuredAt = this.now();
		this.offsetMeasuredAtMonotonic = this.monotonic();
	}

	/**
	 * True while the offset cannot be trusted — never measured, or measured
	 * against a system clock that has since been changed.
	 *
	 * **The second half is not cosmetic.** A detected jump makes `clockStale`
	 * true, but a re-sync that then *fails* is swallowed: the old offset stays
	 * applied and `offsetVerified` stays true. Codes went on being generated from
	 * a correction measured against a clock that no longer exists, while the
	 * screen said the time had been checked against Steam. Reporting it unverified
	 * is what puts that in front of the user instead.
	 */
	clockUnverified(): boolean {
		return !this.offsetVerified || this.clockJumped();
	}

	/** Whether the system clock has moved under a measured offset. */
	private clockJumped(): boolean {
		if (this.offsetMeasuredAt === undefined || this.offsetMeasuredAtMonotonic === undefined) {
			return false;
		}
		const wall = this.now() - this.offsetMeasuredAt;
		const monotonic = this.monotonic() - this.offsetMeasuredAtMonotonic;
		return Math.abs(wall - monotonic) >= CLOCK_JUMP_TOLERANCE_MS;
	}

	/**
	 * True when the offset is old enough to be worth measuring again.
	 *
	 * **Deliberately separate from `clockUnverified`.** That one drives a warning
	 * the user reads, and an offset going stale is not the same thing as one that
	 * was never taken — flipping the warning on every few hours, for a reading
	 * that is almost certainly still correct, is how a real warning gets ignored.
	 * This one only decides whether to ask Steam again.
	 *
	 * It exists because an offset used to be measured once and then trusted for
	 * the life of the process. This app lives in a tray for days: an NTP
	 * correction, a resume from sleep, a VM clock jump or somebody fixing their
	 * time zone all move the local clock afterwards, and the offset measured
	 * against the *old* clock kept being added to the new one. A user who repaired
	 * their clock to fix their codes would have made them wrong by exactly the
	 * amount they corrected, until they restarted the app.
	 *
	 * A backwards jump counts too, hence the absolute value: `measuredAt` is a
	 * local timestamp, so the clock moving under it is precisely the event worth
	 * detecting rather than an anomaly to ignore.
	 */
	clockStale(): boolean {
		if (
			!this.offsetVerified ||
			this.offsetMeasuredAt === undefined ||
			this.offsetMeasuredAtMonotonic === undefined
		) {
			return true;
		}

		// **The jump check first, because it catches what the TTL cannot.**
		//
		// Both clocks advance together until something sets the system clock. When
		// that happens they disagree by the size of the correction, immediately —
		// so a five-minute fix is visible at once rather than after the fifteen
		// minutes a TTL would make the user wait, generating wrong codes throughout.
		if (this.clockJumped()) {
			return true;
		}

		// And the ordinary ageing, for drift too gradual to look like a jump.
		return Math.abs(this.now() - this.offsetMeasuredAt) >= OFFSET_TTL_MS;
	}

	/**
	 * The correction currently being applied.
	 *
	 * Exposed so confirmations sign against the **same** clock the codes are
	 * generated from. Two independently-drifting notions of "now" in one app is
	 * the kind of thing that works until it does not, at a moment nobody can
	 * reproduce.
	 */
	timeOffsetSeconds(): number {
		return this.offsetSeconds;
	}

	/** Steam-corrected time, in whole seconds. */
	private steamTime(): number {
		return Math.floor(this.now() / 1000) + this.offsetSeconds;
	}

	/**
	 * A code for every account in the vault.
	 *
	 * All of them at once, unlike the revocation-code reveal which is deliberately
	 * singular. The difference is lifetime: a revocation code on screen is a
	 * permanent credential, while these expire in under thirty seconds, and making
	 * someone click each account in turn to read a number that changes twice a
	 * minute would be a cost with no matching benefit.
	 *
	 * An account whose secret will not decode yields no code rather than failing
	 * the whole list — one damaged record must not hide every other account.
	 */
	all(): { codes: GuardCode[]; failures: { steamId64: string; reason: string }[] } {
		const time = this.steamTime();
		const codes: GuardCode[] = [];
		const failures: { steamId64: string; reason: string }[] = [];

		for (const account of this.vault.read().accounts) {
			try {
				codes.push({
					steamId64: account.steamId64,
					accountName: account.accountName,
					code: generateGuardCode(account.sharedSecret, time),
					secondsRemaining: secondsRemaining(time)
				});
			} catch (err) {
				failures.push({
					steamId64: account.steamId64,
					reason: err instanceof GuardCodeError ? err.message : 'this code could not be generated'
				});
			}
		}

		return { codes, failures };
	}

	/** One account's code. Throws when the account is unknown or its secret is not usable. */
	for(steamId64: string): GuardCode {
		const account = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!account) {
			throw new GuardCodeError('no such account in this vault');
		}
		const time = this.steamTime();
		return {
			steamId64: account.steamId64,
			accountName: account.accountName,
			code: generateGuardCode(account.sharedSecret, time),
			secondsRemaining: secondsRemaining(time)
		};
	}
}
