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
}

/** One day. Generous for a clock skew; anything beyond it is not a sync result. */
const MAX_TIME_OFFSET_SECONDS = 86_400;

export class CodeService {
	private readonly vault: VaultService;
	private readonly now: () => number;
	/** Seconds to add to the local clock to match Steam's. */
	private offsetSeconds = 0;
	private offsetVerified = false;

	constructor(vault: VaultService, options: CodeServiceOptions = {}) {
		this.vault = vault;
		this.now = options.now ?? (() => Date.now());
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
	}

	/** True while the local clock has never been checked against Steam's. */
	clockUnverified(): boolean {
		return !this.offsetVerified;
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
