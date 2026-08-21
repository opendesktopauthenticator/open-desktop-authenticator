import { describe, expect, it, vi } from 'vitest';
import { AutoConfirmEngine } from '../src/main/confirmations/auto';
import type { AutoConfirmOutcome, ConfirmationsService } from '../src/main/confirmations/service';
import type { VaultService } from '../src/main/vault/service';

/**
 * The automatic confirmation loop (§12 F6).
 *
 * This is the most dangerous feature in the product, so nearly every test here
 * is about the engine **not** doing something: not polling an account nobody
 * switched on, not running while the vault is locked, not retrying into a rate
 * limit, and not quietly discarding what the policy refused.
 *
 * What may be approved is decided in `policy.ts` and enforced in `client.ts`,
 * and is tested there. This is only about *when* to ask.
 */

const NOW = Date.parse('2026-08-10T12:00:00Z');
/** Longer than the largest backoff, so each tick in a loop is always due. */
const BACKOFF_ENOUGH = 20 * 60_000;

function account(overrides: Partial<{ marketListings: boolean; trades: boolean }> = {}): {
	steamId64: string;
	autoConfirm: { marketListings: boolean; trades: boolean; pollIntervalSeconds: number };
} {
	return {
		steamId64: '76561198000000001',
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			...overrides
		}
	};
}

function harness(options: {
	accounts?: ReturnType<typeof account>[];
	unlocked?: boolean;
	run?: (steamId64: string) => Promise<AutoConfirmOutcome>;
}): {
	engine: AutoConfirmEngine;
	runAutoConfirm: ReturnType<typeof vi.fn>;
	outcomes: { steamId64: string; outcome: AutoConfirmOutcome }[];
	failures: { steamId64: string; reason: string }[];
	advance: (ms: number) => void;
	/** When each account is next scheduled to run. Reaches into engine state. */
	dueTimes: () => number[];
} {
	let clock = NOW;
	const outcomes: { steamId64: string; outcome: AutoConfirmOutcome }[] = [];
	const failures: { steamId64: string; reason: string }[] = [];

	const runAutoConfirm = vi.fn(
		options.run ??
			((): Promise<AutoConfirmOutcome> =>
				Promise.resolve({ approved: [], held: [], unreadable: 0 }))
	);

	const vault = {
		isUnlocked: () => options.unlocked ?? true,
		read: () => ({ accounts: options.accounts ?? [] })
	} as unknown as VaultService;

	const confirmations = { runAutoConfirm } as unknown as ConfirmationsService;

	const engine = new AutoConfirmEngine({
		vault,
		confirmations,
		now: () => clock,
		onOutcome: (steamId64, outcome) => outcomes.push({ steamId64, outcome }),
		onFailure: (steamId64, reason) => failures.push({ steamId64, reason }),
		// Timers are never used: `tick` is driven directly so nothing here waits.
		setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
		clearTimer: () => undefined
	});

	return {
		engine,
		runAutoConfirm,
		outcomes,
		failures,
		// Read rather than inferred from timing: the schedule is the thing under
		// test, and reconstructing it from tick behaviour would test the harness.
		dueTimes: () =>
			[...(engine as unknown as { state: Map<string, { nextDueAt: number }> }).state.values()].map(
				(entry) => entry.nextDueAt
			),
		advance: (ms: number) => {
			clock += ms;
		}
	};
}

describe('what it refuses to do', () => {
	it('never polls an account with nothing switched on', async () => {
		// The default. An account nobody has opted in gets no requests at all, so
		// the feature costs nothing until it is asked for.
		const { engine, runAutoConfirm } = harness({ accounts: [account()] });

		await engine.tick();

		expect(runAutoConfirm).not.toHaveBeenCalled();
	});

	it('does nothing at all while the vault is locked', async () => {
		// A locked vault is the clearest statement available that nobody is
		// present, and approving trades for an absent user is the thing this must
		// never do.
		const { engine, runAutoConfirm } = harness({
			accounts: [account({ trades: true })],
			unlocked: false
		});

		await engine.tick();

		expect(runAutoConfirm).not.toHaveBeenCalled();
	});

	it('stops and forgets every schedule when told to', async () => {
		const { engine, runAutoConfirm } = harness({ accounts: [account({ trades: true })] });
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(1);

		engine.stop();
		// After a stop the backoff state is gone, so the next tick starts clean
		// rather than resuming a schedule from a session that has ended.
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(2);
	});
});

describe('pacing', () => {
	it('waits out the account interval before asking again', async () => {
		const { engine, runAutoConfirm, advance } = harness({
			accounts: [account({ trades: true })]
		});

		await engine.tick();
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(1);

		// Interval plus the account's jitter, which is up to a quarter of it. The
		// jitter is why this advances past the bare interval rather than to it.
		advance(15_000 + 15_000 / 4);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(2);
	});

	/**
	 * Accounts used to tick in lockstep: every account on the same interval fired
	 * in the same pass, so their requests reached Steam within milliseconds of
	 * each other, repeatedly. Separate exit addresses do not hide that —
	 * synchronised arrival times across a set of proxies is itself a signal that
	 * one operator is behind them, and routing cannot touch it.
	 */
	it('staggers accounts rather than polling them in lockstep', async () => {
		const a = account({ trades: true });
		const b = account({ trades: true });
		b.steamId64 = '76561198000000002';
		const c = account({ trades: true });
		c.steamId64 = '76561198000000003';

		const { engine, dueTimes, advance } = harness({ accounts: [a, b, c] });

		await engine.tick();
		// Everything is due at once on the first pass; the spread appears in when
		// each is scheduled to run *next*.
		advance(1);
		await engine.tick();

		const scheduled = dueTimes();
		expect(new Set(scheduled).size, 'accounts share a next-due time').toBeGreaterThan(1);
	});

	it('gives each account the same offset every time, so a restart does not reshuffle', async () => {
		// A jitter that changed on every launch would produce a different kind of
		// correlation: a whole set of accounts changing phase at the same moment.
		const first = harness({ accounts: [account({ trades: true })] });
		await first.engine.tick();
		const before = first.dueTimes()[0];

		const second = harness({ accounts: [account({ trades: true })] });
		await second.engine.tick();

		expect(second.dueTimes()[0]).toBe(before);
	});

	it('never polls faster than the floor, whatever the account asks for', async () => {
		// A vault written by another tool, or a migration bug, could carry a
		// smaller number than the schema allows. The floor is applied here too.
		const fast = account({ trades: true });
		fast.autoConfirm.pollIntervalSeconds = 1;
		const { engine, runAutoConfirm, advance } = harness({ accounts: [fast] });

		await engine.tick();
		advance(5_000);
		await engine.tick();

		expect(runAutoConfirm).toHaveBeenCalledTimes(1);
	});
});

describe('when Steam says no', () => {
	it('backs off rather than retrying, because the usual cause is a rate limit', async () => {
		const { engine, runAutoConfirm, failures, advance } = harness({
			accounts: [account({ trades: true })],
			run: () => Promise.reject(new Error('Steam refused the request'))
		});

		await engine.tick();
		expect(failures).toHaveLength(1);

		// The normal interval has passed, but the backoff has not.
		advance(15_000);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(1);

		advance(30_000);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(2);
	});

	it('lengthens the wait on each consecutive failure', async () => {
		const { engine, runAutoConfirm, advance } = harness({
			accounts: [account({ trades: true })],
			run: () => Promise.reject(new Error('nope'))
		});

		await engine.tick();
		advance(30_000);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(2);

		// The second failure doubled it, so the same wait is no longer enough.
		advance(30_000);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(2);

		advance(30_000);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(3);
	});

	it('reports the failure rather than swallowing it', async () => {
		const { engine, failures } = harness({
			accounts: [account({ trades: true })],
			run: () => Promise.reject(new Error('the saved session expired'))
		});

		await engine.tick();

		expect(failures[0]?.reason).toContain('expired');
		expect(failures[0]?.steamId64).toBe('76561198000000001');
	});

	it('clears the backoff when settings change, so a new opt-in is not punished', async () => {
		const { engine, runAutoConfirm, advance } = harness({
			accounts: [account({ trades: true })],
			run: () => Promise.reject(new Error('nope'))
		});

		await engine.tick();
		engine.reset('76561198000000001');

		advance(1);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(2);
	});
});

describe('reporting', () => {
	it('passes on what the policy held back', async () => {
		// The point of surfacing this: an account-recovery confirmation the policy
		// refused is the strongest warning this app can give, and a poller that
		// moved on quietly would waste it.
		const { engine, outcomes } = harness({
			accounts: [account({ trades: true })],
			run: () =>
				Promise.resolve({
					approved: [
						{
							id: '1',
							type: 2,
							typeName: 'Trade',
							securityCritical: false,
							autoConfirmable: true,
							hasIcon: false
						}
					],
					held: [
						{
							confirmation: {
								id: '9',
								type: 6,
								typeName: 'Account recovery',
								securityCritical: true,
								autoConfirmable: false,
								hasIcon: false
							},
							reason: 'Account recovery confirmations are never approved automatically.'
						}
					],
					unreadable: 0
				})
		});

		await engine.tick();

		expect(outcomes[0]?.outcome.approved).toHaveLength(1);
		expect(outcomes[0]?.outcome.held[0]?.confirmation.typeName).toBe('Account recovery');
	});

	it('polls each enabled account, and only those', async () => {
		const enabled = account({ marketListings: true });
		const disabled = { ...account(), steamId64: '76561198000000002' };
		const { engine, runAutoConfirm } = harness({ accounts: [enabled, disabled] });

		await engine.tick();

		expect(runAutoConfirm).toHaveBeenCalledTimes(1);
		expect(runAutoConfirm).toHaveBeenCalledWith('76561198000000001');
	});
});

describe('halting after repeated failure', () => {
	it('stops polling an account entirely after ten failures in a row', async () => {
		// Backoff alone is not enough: a genuinely dead session would otherwise fail
		// forever at fifteen-minute intervals, quietly, while the user believes
		// automatic confirmation is working.
		const { engine, runAutoConfirm, advance } = harness({
			accounts: [account({ trades: true })],
			run: () => Promise.reject(new Error('the saved session expired'))
		});

		for (let attempt = 0; attempt < 10; attempt++) {
			advance(BACKOFF_ENOUGH);
			await engine.tick();
		}
		expect(runAutoConfirm).toHaveBeenCalledTimes(10);

		// However long passes now, it is not tried again.
		advance(24 * 60 * 60_000);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(10);
	});

	it('says plainly that it has stopped, rather than going quiet', async () => {
		const { engine, failures, advance } = harness({
			accounts: [account({ trades: true })],
			run: () => Promise.reject(new Error('the saved session expired'))
		});

		for (let attempt = 0; attempt < 10; attempt++) {
			advance(BACKOFF_ENOUGH);
			await engine.tick();
		}

		const last = failures[failures.length - 1];
		expect(last?.reason).toMatch(/stopped/i);
		expect(last?.reason).toContain('expired');
	});

	it('resumes when the user changes the settings', async () => {
		// `reset` is what the settings handler calls. Someone who has just fixed the
		// cause should not have to restart the app.
		const { engine, runAutoConfirm, advance } = harness({
			accounts: [account({ trades: true })],
			run: () => Promise.reject(new Error('nope'))
		});

		for (let attempt = 0; attempt < 10; attempt++) {
			advance(BACKOFF_ENOUGH);
			await engine.tick();
		}
		engine.reset('76561198000000001');

		advance(1);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(11);
	});

	it('forgets the failure count after a success', async () => {
		let shouldFail = true;
		const { engine, runAutoConfirm, advance } = harness({
			accounts: [account({ trades: true })],
			run: () =>
				shouldFail
					? Promise.reject(new Error('nope'))
					: Promise.resolve({ approved: [], held: [], unreadable: 0 })
		});

		// Nine failures, then one success, then nine more must not reach the halt.
		for (let attempt = 0; attempt < 9; attempt++) {
			advance(BACKOFF_ENOUGH);
			await engine.tick();
		}
		shouldFail = false;
		advance(BACKOFF_ENOUGH);
		await engine.tick();

		shouldFail = true;
		for (let attempt = 0; attempt < 9; attempt++) {
			advance(BACKOFF_ENOUGH);
			await engine.tick();
		}

		expect(runAutoConfirm).toHaveBeenCalledTimes(19);
	});
});

/**
 * Work that outlives the lock that stopped it.
 *
 * `stop` clears the schedule, but a sweep already inside an await is not
 * stopped by clearing a map — it is stopped by refusing to let it write when it
 * comes back. Without that refusal the lock's own aborts were counted as Steam
 * failures, and ten locks during polling produced a permanent halt the user
 * never caused.
 */
describe('the scheduler chain', () => {
	/** A harness that records every timer and whether it was ever cleared. */
	function chainHarness(): {
		engine: AutoConfirmEngine;
		timers: { id: number; cleared: boolean; fire: () => void }[];
		release: () => void;
	} {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const timers: { id: number; cleared: boolean; fire: () => void }[] = [];
		let nextId = 0;

		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts: [account({ trades: true })] })
			} as unknown as VaultService,
			confirmations: {
				runAutoConfirm: async (): Promise<AutoConfirmOutcome> => {
					await gate;
					return { approved: [], held: [], unreadable: 0 };
				}
			} as unknown as ConfirmationsService,
			now: () => NOW,
			setTimer: (callback: () => void) => {
				const entry = { id: nextId++, cleared: false, fire: callback };
				timers.push(entry);
				return entry as unknown as NodeJS.Timeout;
			},
			clearTimer: (handle: NodeJS.Timeout) => {
				(handle as unknown as { cleared: boolean }).cleared = true;
			}
		});

		return { engine, timers, release: () => release?.() };
	}

	it('leaves nothing armed that stop() cannot reach', async () => {
		// Locking and unlocking while a sweep is parked on the network used to fork
		// the heartbeat: the parked sweep saw the *new* chain's handle, judged itself
		// current, and scheduled a second chain beside it. `this.ticker` tracks one,
		// so `stop` could clear only one and the other kept firing.
		const { engine, timers, release } = chainHarness();

		engine.start();
		timers[0]?.fire();
		await Promise.resolve();

		engine.stop();
		engine.start();

		release();
		await new Promise((resolve) => setTimeout(resolve, 10));

		engine.stop();

		expect(timers.filter((timer) => !timer.cleared)).toHaveLength(0);
	});

	it('does not run a sweep for a chain that has been disowned', async () => {
		// The fired timer of a stopped chain must do nothing at all — not merely
		// decline to reschedule.
		const { engine, timers } = chainHarness();
		engine.start();

		engine.stop();
		// The handle fires anyway; a cleared timer is not necessarily an uncalled one.
		timers[0]?.fire();
		await Promise.resolve();

		expect(timers).toHaveLength(1);
	});
});

describe('stopping while a sweep is in the air', () => {
	function parked(): {
		harness: ReturnType<typeof harness>;
		release: (fail?: boolean) => void;
	} {
		let settle: ((fail: boolean) => void) | undefined;
		const gate = new Promise<boolean>((resolve) => {
			settle = resolve;
		});
		const parkedHarness = harness({
			accounts: [account({ trades: true })],
			run: async () => {
				const shouldFail = await gate;
				if (shouldFail) {
					throw new Error('the request was aborted');
				}
				return { approved: [], held: [], unreadable: 0 };
			}
		});
		return { harness: parkedHarness, release: (fail = false) => settle?.(fail) };
	}

	/**
	 * Let a sweep actually reach the parked request.
	 *
	 * `tick` awaits the Steam clock before it does anything, so the first turn of
	 * the loop yields before a single account is visited. Calling `stop` right
	 * after `tick()` therefore disowns a sweep that had not started — which makes
	 * "stopped while a request was in the air" tests pass without ever putting a
	 * request in the air, and two of them below assert an absence.
	 */
	const inFlight = async (): Promise<void> => {
		for (let i = 0; i < 5; i += 1) {
			await Promise.resolve();
		}
	};

	it('does not score a failure against an account when the lock caused it', async () => {
		// The compounding one. Nothing here can tell "Steam refused us" from "we
		// aborted our own request on lock", so a lock must not count at all.
		const { harness, release } = parked();
		const sweep = harness.engine.tick();
		await inFlight();

		harness.engine.stop();
		release(true);
		await sweep;

		expect(harness.failures).toHaveLength(0);
		expect(harness.dueTimes()).toHaveLength(0);
	});

	it('does not reschedule an account after the schedule was cleared', async () => {
		// A success landing after the clear would put the account back on the map,
		// so the next unlock inherits a schedule from a session that has ended.
		const { harness, release } = parked();
		const sweep = harness.engine.tick();
		await inFlight();

		harness.engine.stop();
		release(false);
		await sweep;

		expect(harness.dueTimes()).toHaveLength(0);
	});

	it('still reports an outcome that really happened', async () => {
		// Being disowned by a lock does not make the approval imaginary. Steam acted
		// on it, so the activity log has to say so.
		const { harness, release } = parked();
		const sweep = harness.engine.tick();
		await inFlight();

		harness.engine.stop();
		release(false);
		await sweep;

		expect(harness.outcomes).toHaveLength(1);
	});
});

/*
 * The Steam clock, before anything is signed.
 *
 * A confirmation is authorised by an HMAC over Steam-corrected time. Every
 * interactive path awaits the clock in its IPC handler, but the engine calls
 * `runAutoConfirm` directly and so awaited nothing — and unlock starts the sync
 * without waiting for it, then the first pass fires ten seconds later, inside a
 * thirty-second transport timeout. On a skewed machine that pass signed with an
 * offset of zero, and every confirmation in it was refused.
 */
describe('the clock is checked before a pass signs anything', () => {
	it('waits for the clock before asking Steam', async () => {
		const order: string[] = [];
		let releaseClock: (() => void) | undefined;
		const clockDone = new Promise<void>((resolve) => {
			releaseClock = resolve;
		});

		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts: [account({ trades: true })] })
			} as unknown as VaultService,
			confirmations: {
				runAutoConfirm: () => {
					order.push('steam');
					return Promise.resolve({ approved: [], held: [], unreadable: 0 });
				}
			} as unknown as ConfirmationsService,
			ensureClock: async () => {
				order.push('clock');
				await clockDone;
			},
			now: () => NOW,
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});

		const sweep = engine.tick();
		// Steam has not been asked while the clock is still outstanding.
		expect(order).toEqual(['clock']);

		releaseClock?.();
		await sweep;

		expect(order).toEqual(['clock', 'steam']);
	});

	it('abandons the pass if the vault locked while the clock was being checked', async () => {
		// The sync is network I/O and can take a transport timeout. A lock during it
		// means the user left, and nothing may be approved on their behalf after
		// that — the same rule the rest of the sweep already follows.
		const runAutoConfirm = vi.fn(() => Promise.resolve({ approved: [], held: [], unreadable: 0 }));
		let releaseClock: (() => void) | undefined;
		const clockDone = new Promise<void>((resolve) => {
			releaseClock = resolve;
		});

		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts: [account({ trades: true })] })
			} as unknown as VaultService,
			confirmations: { runAutoConfirm } as unknown as ConfirmationsService,
			ensureClock: () => clockDone,
			now: () => NOW,
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});

		const sweep = engine.tick();
		engine.stop();
		releaseClock?.();
		await sweep;

		expect(runAutoConfirm).not.toHaveBeenCalled();
	});
});

/*
 * Accounts are independent, and the sweep must treat them that way.
 *
 * Awaiting each in sequence meant one dead proxy's thirty-second timeout
 * stalled every account behind it in the list, every sweep — delays
 * accumulated instead of overlapping.
 */
describe('one slow account does not block the others', () => {
	it('runs the second account while the first is still in the air', async () => {
		let releaseA: (() => void) | undefined;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const ran: string[] = [];
		const vault = {
			isUnlocked: () => true,
			read: () => ({
				accounts: [
					{
						steamId64: '76561198000000001',
						autoConfirm: { marketListings: true, trades: false, pollIntervalSeconds: 15 }
					},
					{
						steamId64: '76561198000000002',
						autoConfirm: { marketListings: true, trades: false, pollIntervalSeconds: 15 }
					}
				]
			})
		} as unknown as VaultService;
		const confirmations = {
			runAutoConfirm: async (steamId64: string) => {
				ran.push(steamId64);
				if (steamId64 === '76561198000000001') {
					await gateA;
				}
				return { approved: [], held: [], unreadable: 0 };
			}
		} as unknown as ConfirmationsService;

		const engine = new AutoConfirmEngine({ vault, confirmations, now: () => 0 });
		const sweep = engine.tick();

		// Both must have been *started* while A is still gated.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ran).toContain('76561198000000002');

		releaseA?.();
		await sweep;
	});
});
