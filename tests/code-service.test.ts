import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeService } from '../src/main/codes/service';
import { ClipboardCourier, type Clipboard } from '../src/main/codes/clipboard';
import { generateGuardCode } from '../src/main/codes/totp';
import { VaultLockedError, VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

/**
 * Codes as the application serves them, and the clipboard rules around them.
 *
 * Stubbed to the accepted scrypt floor like the other vault suites; the shipping
 * parameters are asserted in `vault-crypto.test.ts`.
 */
vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const PASS = 'a sufficiently long passphrase';
const SECRET = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
/** 1 700 000 010 is a multiple of 30 — the start of a window. */
const NOW_MS = 1_700_000_010_000;

let dir: string;
let clock: number;
let vault: VaultService;
let codes: CodeService;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'code-service-'));
	clock = NOW_MS;
	vault = new VaultService({ file: join(dir, 'vault.json'), now: () => clock });
	await vault.create(PASS);
	codes = new CodeService(vault, { now: () => clock });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: '76561198000000001',
		accountName: 'trader',
		sharedSecret: SECRET,
		identitySecret: 'aWRlbnRpdHk=',
		status: 'active',
		addedAt: '2026-08-01T00:00:00.000Z',
		autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
		...overrides
	};
}

async function store(...accounts: Account[]): Promise<void> {
	await vault.mutate((draft) => {
		draft.accounts.push(...accounts);
	});
}

describe('CodeService', () => {
	it('requires an unlocked vault', () => {
		vault.lock();
		expect(() => codes.all()).toThrow(VaultLockedError);
	});

	it('generates a code for every account', async () => {
		await store(
			account(),
			account({ steamId64: '76561198000000002', accountName: 'second', sharedSecret: SECRET })
		);

		const { codes: generated, failures } = codes.all();

		expect(failures).toEqual([]);
		expect(generated).toHaveLength(2);
		expect(generated[0]?.code).toBe(generateGuardCode(SECRET, NOW_MS / 1000));
		expect(generated[0]?.secondsRemaining).toBe(30);
		expect(generated[0]?.accountName).toBe('trader');
	});

	it('reports a damaged secret without hiding every other account', async () => {
		await store(
			account({ steamId64: '76561198000000001', sharedSecret: 'not base64 at all!!' }),
			account({ steamId64: '76561198000000002', accountName: 'fine' })
		);

		const { codes: generated, failures } = codes.all();

		expect(generated).toHaveLength(1);
		expect(generated[0]?.accountName).toBe('fine');
		expect(failures).toHaveLength(1);
		expect(failures[0]?.steamId64).toBe('76561198000000001');
	});

	it('returns one account by id and refuses an unknown one', async () => {
		await store(account());

		expect(codes.for('76561198000000001').code).toBe(generateGuardCode(SECRET, NOW_MS / 1000));
		expect(() => codes.for('76561198000000009')).toThrow(/no such account/);
	});

	it('never returns the shared secret alongside the code', async () => {
		await store(account());
		expect(JSON.stringify(codes.all())).not.toContain(SECRET);
		expect(JSON.stringify(codes.for('76561198000000001'))).not.toContain(SECRET);
	});

	describe('the clock', () => {
		it('starts unverified, because nothing has asked Steam', () => {
			expect(codes.clockUnverified()).toBe(true);
		});

		it('applies a measured offset', async () => {
			await store(account());
			const local = codes.for('76561198000000001').code;

			// A machine one minute slow: two windows behind.
			codes.setTimeOffset(60);

			expect(codes.clockUnverified()).toBe(false);
			expect(codes.for('76561198000000001').code).toBe(
				generateGuardCode(SECRET, NOW_MS / 1000 + 60)
			);
			expect(codes.for('76561198000000001').code).not.toBe(local);
		});

		it('rejects a nonsense offset rather than silently skewing every code', () => {
			expect(() => codes.setTimeOffset(Number.NaN)).toThrow(RangeError);
			expect(() => codes.setTimeOffset(Number.POSITIVE_INFINITY)).toThrow(RangeError);
			expect(codes.clockUnverified()).toBe(true);
		});

		it('rejects an offset too large to be a clock skew', () => {
			// Finite was not enough: a huge negative offset drives Steam-corrected
			// time below zero, which nothing downstream can turn back into a sensible
			// code or countdown. Real offsets are seconds.
			expect(() => codes.setTimeOffset(-2_000_000_000)).toThrow(RangeError);
			expect(() => codes.setTimeOffset(86_401)).toThrow(RangeError);
			expect(codes.clockUnverified()).toBe(true);

			// A plausible skew is still accepted.
			codes.setTimeOffset(-45);
			expect(codes.clockUnverified()).toBe(false);
		});

		it('counts the window down as the clock advances', async () => {
			await store(account());
			expect(codes.clockUnverified()).toBe(true);
			clock += 11_000;
			// Derived from the same corrected time the code was, so the two cannot
			// disagree about which window they are in.
			expect(codes.for('76561198000000001').secondsRemaining).toBe(19);
		});
	});
});

/** A clipboard that records what happened to it. */
function fakeClipboard(initial = ''): Clipboard & { contents: string; cleared: number } {
	return {
		contents: initial,
		cleared: 0,
		readText(): string {
			return this.contents;
		},
		writeText(text: string): void {
			this.contents = text;
		},
		clear(): void {
			this.contents = '';
			this.cleared++;
		}
	};
}

describe('ClipboardCourier', () => {
	/** Captures the scheduled callback instead of waiting for a real timer. */
	function courier(clipboard: Clipboard): {
		courier: ClipboardCourier;
		fire: () => void;
		cancelled: number;
	} {
		let scheduled: (() => void) | undefined;
		const state = { cancelled: 0 };
		const instance = new ClipboardCourier({
			clipboard,
			setTimer: (callback) => {
				scheduled = callback;
				return { unref: () => undefined } as unknown as NodeJS.Timeout;
			},
			clearTimer: () => {
				state.cancelled++;
				scheduled = undefined;
			}
		});
		return {
			courier: instance,
			fire: () => scheduled?.(),
			get cancelled(): number {
				return state.cancelled;
			}
		};
	}

	it('writes the code and clears it when the timer fires', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		expect(clipboard.contents).toBe('X45RP');
		expect(c.hasPendingClear()).toBe(true);

		fire();
		expect(clipboard.contents).toBe('');
		expect(clipboard.cleared).toBe(1);
	});

	it('does NOT clear something the user copied afterwards', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		// The user copies a paragraph. Wiping it would be data loss caused by a
		// security feature.
		clipboard.writeText('a long message the user is about to paste');

		fire();
		expect(clipboard.contents).toBe('a long message the user is about to paste');
		expect(clipboard.cleared).toBe(0);
	});

	it('supersedes a pending clear rather than stacking timers', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		c.copy('Q9JC4', 30_000);
		expect(clipboard.contents).toBe('Q9JC4');

		fire();
		expect(clipboard.contents).toBe('');
		expect(clipboard.cleared).toBe(1);
	});

	it('clears on demand, for lock and quit', () => {
		const clipboard = fakeClipboard();
		const { courier: c } = courier(clipboard);

		c.copy('X45RP', 30_000);
		expect(c.clearIfOurs()).toBe(true);
		expect(clipboard.contents).toBe('');
		expect(c.hasPendingClear()).toBe(false);
	});

	it('does nothing on demand when nothing of ours is there', () => {
		const clipboard = fakeClipboard('someone else was here');
		const { courier: c } = courier(clipboard);

		expect(c.clearIfOurs()).toBe(false);
		expect(clipboard.contents).toBe('someone else was here');
	});

	it('does not clear twice for one copy', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		expect(c.clearIfOurs()).toBe(true);

		// The lock cleared it; a late timer must not then wipe whatever the user
		// copied next.
		clipboard.writeText('something new');
		fire();
		expect(clipboard.contents).toBe('something new');
	});

	it('cancels without touching the clipboard', () => {
		const clipboard = fakeClipboard();
		const { courier: c } = courier(clipboard);

		c.copy('X45RP', 30_000);
		c.cancel();
		expect(clipboard.contents).toBe('X45RP');
		expect(c.hasPendingClear()).toBe(false);
	});
});

/*
 * When a measured offset stops being worth trusting.
 *
 * Kept apart from `clockUnverified`, which drives a warning the user reads.
 * "Never measured" and "measured a while ago" are different claims, and flipping
 * that warning on every quarter hour — for a reading almost certainly still
 * correct — is how a warning people need gets tuned out.
 */
describe('the offset going stale', () => {
	it('is stale before anything has ever measured it', () => {
		expect(codes.clockStale()).toBe(true);
	});

	it('is fresh the moment it is measured', () => {
		codes.setTimeOffset(3);
		expect(codes.clockStale()).toBe(false);
	});

	it('goes stale once the TTL has passed', () => {
		// Both clocks advance together: this is ordinary time passing, not a
		// correction. The outer harness only drives the wall clock, so this one
		// builds its own pair — moving `now` alone would be a *jump*, which is a
		// different thing entirely and is covered below.
		let wall = NOW_MS;
		let mono = 1_000;
		const aged = new CodeService(vault, { now: () => wall, monotonic: () => mono });
		aged.setTimeOffset(3);
		wall += 15 * 60_000;
		mono += 15 * 60_000;

		expect(aged.clockStale()).toBe(true);
		// Still verified: the reading happened, it is only old. Conflating the two
		// is what would put a warning in front of the user for no reason.
		expect(aged.clockUnverified()).toBe(false);
	});

	it('goes stale when the local clock jumps backwards', () => {
		// The event most worth catching, and the one a forward-only comparison
		// misses entirely: somebody corrects a clock that was running fast, and
		// every code afterwards is wrong by exactly what they corrected.
		codes.setTimeOffset(3);
		clock = NOW_MS - 60 * 60_000;

		expect(codes.clockStale()).toBe(true);
	});

	it('is fresh again after re-measuring', () => {
		codes.setTimeOffset(3);
		clock = NOW_MS + 15 * 60_000;
		codes.setTimeOffset(4);

		expect(codes.clockStale()).toBe(false);
	});
});

/*
 * A clock correction smaller than the staleness window.
 *
 * The TTL alone could only notice an offset that had aged fifteen minutes. It
 * could not notice the event that actually invalidates one: somebody setting the
 * system clock. A user five minutes fast, synced, then corrected, kept a
 * five-minute-wrong offset applied to a now-correct clock for another twenty
 * minutes — with every Steam Guard code and every confirmation signature wrong
 * throughout, because they had fixed their clock.
 *
 * The wall clock and a monotonic clock advance together until something sets the
 * former. Comparing the two sees a correction of any size, immediately.
 */
describe('a system-clock correction is noticed at once', () => {
	/** Wall and monotonic clocks that can be moved independently. */
	function clocks(): {
		service: CodeService;
		tick: (ms: number) => void;
		setSystemClock: (ms: number) => void;
	} {
		let wall = NOW_MS;
		let mono = 1_000;
		const service = new CodeService(vault, { now: () => wall, monotonic: () => mono });
		return {
			service,
			// Ordinary time passing: both advance.
			tick: (ms) => {
				wall += ms;
				mono += ms;
			},
			// Somebody sets the clock: only the wall clock moves.
			setSystemClock: (ms) => {
				wall += ms;
			}
		};
	}

	it('is fresh while time merely passes', () => {
		const { service, tick } = clocks();
		service.setTimeOffset(-300);
		tick(60_000);

		expect(service.clockStale()).toBe(false);
	});

	it('notices a five-minute correction backwards', () => {
		// The reported case: local clock five minutes fast, offset -300, then the
		// user fixes it. The TTL is nowhere near expiry.
		const { service, setSystemClock } = clocks();
		service.setTimeOffset(-300);
		setSystemClock(-5 * 60_000);

		expect(service.clockStale()).toBe(true);
	});

	it('notices a correction forwards too', () => {
		const { service, setSystemClock } = clocks();
		service.setTimeOffset(300);
		setSystemClock(5 * 60_000);

		expect(service.clockStale()).toBe(true);
	});

	it('notices a correction far smaller than the TTL', () => {
		// Ten seconds is a third of a Steam Guard window — enough to matter, and
		// nowhere near fifteen minutes.
		const { service, setSystemClock } = clocks();
		service.setTimeOffset(0);
		setSystemClock(10_000);

		expect(service.clockStale()).toBe(true);
	});

	it('tolerates ordinary scheduling jitter between the two clocks', () => {
		// The two are read a moment apart and neither is exact. A tolerance that
		// tripped on milliseconds would re-sync on every poll.
		const { service, setSystemClock } = clocks();
		service.setTimeOffset(0);
		setSystemClock(50);

		expect(service.clockStale()).toBe(false);
	});
});

/*
 * A re-sync that fails after a detected correction.
 *
 * The jump makes `clockStale()` true, but `SteamClock` swallows a failed
 * QueryTime — so the old offset stayed applied and `offsetVerified` stayed true.
 * Codes went on being generated from a correction measured against a clock that
 * no longer exists, while the screen reported the time as checked against Steam.
 */
describe('a clock correction that could not be re-measured', () => {
	function clocks(): { service: CodeService; setSystemClock: (ms: number) => void } {
		let wall = NOW_MS;
		const mono = 1_000;
		const service = new CodeService(vault, { now: () => wall, monotonic: () => mono });
		return {
			service,
			setSystemClock: (ms) => {
				wall += ms;
			}
		};
	}

	it('stops calling the offset verified', () => {
		const { service, setSystemClock } = clocks();
		service.setTimeOffset(-300);
		expect(service.clockUnverified()).toBe(false);

		setSystemClock(-5 * 60_000);

		// The re-sync has not happened, or failed. Either way the user needs to know
		// the time is no longer known to be right.
		expect(service.clockUnverified()).toBe(true);
	});

	it('still asks for a re-sync', () => {
		const { service, setSystemClock } = clocks();
		service.setTimeOffset(-300);
		setSystemClock(-5 * 60_000);

		expect(service.clockStale()).toBe(true);
	});

	it('is verified again once a measurement succeeds', () => {
		const { service, setSystemClock } = clocks();
		service.setTimeOffset(-300);
		setSystemClock(-5 * 60_000);
		service.setTimeOffset(0);

		expect(service.clockUnverified()).toBe(false);
		expect(service.clockStale()).toBe(false);
	});

	it('does not report unverified merely because the offset is old', () => {
		// Ageing and a correction are different claims. Only one of them means the
		// number currently being applied is wrong.
		let wall = NOW_MS;
		let mono = 1_000;
		const aged = new CodeService(vault, { now: () => wall, monotonic: () => mono });
		aged.setTimeOffset(3);
		wall += 60 * 60_000;
		mono += 60 * 60_000;

		expect(aged.clockStale()).toBe(true);
		expect(aged.clockUnverified()).toBe(false);
	});
});
