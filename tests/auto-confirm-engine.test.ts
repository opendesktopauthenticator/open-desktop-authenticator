import { describe, expect, it, vi } from 'vitest';
import type { NotifyDetail } from '../src/shared/vault-schema';
import type { ConfirmationSummary } from '../src/shared/ipc';
import { ConfirmationsError } from '../src/main/confirmations/service';
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

function account(
	overrides: Partial<{
		marketListings: boolean;
		trades: boolean;
		pollIntervalSeconds: number;
		notify: { enabled: boolean; detail: NotifyDetail };
	}> = {},
	identity: Partial<{ steamId64: string; accountName: string; proxyUrl: string }> = {}
): VaultAccountLike {
	return {
		steamId64: '76561198000000001',
		accountName: 'trader',
		...identity,
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: { enabled: false, detail: 'full' },
			...overrides
		}
	};
}

/**
 * The projection the scheduler actually reads, derived from the same accounts
 * the fake's `read` returns.
 *
 * Written as a derivation rather than a second literal on purpose. The engine
 * stopped calling `read()` on its hot path because that deep-clones every
 * secret in the vault once a second; a fake that answered the two independently
 * could drift, and then these tests would be asserting against a vault no user
 * has.
 */
function scheduleOf(accounts: readonly VaultAccountLike[] = []): {
	steamId64: string;
	accountName: string;
	marketListings: boolean;
	trades: boolean;
	pollIntervalSeconds: number;
	notify: { enabled: boolean; detail: NotifyDetail };
	hasProxy: boolean;
}[] {
	return accounts.map((account) => ({
		steamId64: account.steamId64,
		accountName: account.accountName,
		marketListings: account.autoConfirm.marketListings,
		trades: account.autoConfirm.trades,
		pollIntervalSeconds: account.autoConfirm.pollIntervalSeconds,
		notify: { ...account.autoConfirm.notify },
		hasProxy: account.proxyUrl !== undefined && account.proxyUrl !== ''
	}));
}

/** Only the fields these fakes actually populate. */
interface VaultAccountLike {
	steamId64: string;
	accountName: string;
	proxyUrl?: string;
	autoConfirm: {
		marketListings: boolean;
		trades: boolean;
		pollIntervalSeconds: number;
		notify: { enabled: boolean; detail: NotifyDetail };
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
		read: () => ({ accounts: options.accounts ?? [] }),
		autoConfirmSchedule: () => scheduleOf(options.accounts)
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
				read: () => ({ accounts: [account({ trades: true })] }),
				autoConfirmSchedule: () => scheduleOf([account({ trades: true })])
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

	/**
	 * **A toast raised after the vault closed is what `stop()` exists to
	 * prevent**, and nothing was asserting it — the mutation that fired
	 * `onPending` on the disowned generation left the whole suite green.
	 *
	 * The outcome is still reported, because Steam really did act. The
	 * notification is not, because the person is gone and the toast would name a
	 * trade partner and an item on a screen they have just walked away from.
	 */
	it('raises no notification for a sweep the lock disowned', async () => {
		let settle: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const accounts = [account({ trades: true, notify: { enabled: true, detail: 'full' } })];
		const pending: string[] = [];
		const outcomes: string[] = [];
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => scheduleOf(accounts)
		} as unknown as VaultService;
		const engine = new AutoConfirmEngine({
			vault,
			confirmations: {
				runAutoConfirm: async () => {
					await gate;
					return {
						approved: [],
						held: [{ confirmation: { id: '1' } as unknown as ConfirmationSummary, reason: 'held' }],
						unreadable: 0
					} as unknown as AutoConfirmOutcome;
				}
			} as unknown as ConfirmationsService,
			now: () => NOW,
			onOutcome: (steamId64) => outcomes.push(steamId64),
			onPending: (steamId64) => pending.push(steamId64),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});

		const sweep = engine.tick();
		await inFlight();
		engine.stop();
		settle?.();
		await sweep;

		expect(pending, 'a toast was raised after the vault locked').toEqual([]);
		// The approval still happened, so the log still hears about it.
		expect(outcomes).toHaveLength(1);
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
				read: () => ({ accounts: [account({ trades: true })] }),
				autoConfirmSchedule: () => scheduleOf([account({ trades: true })])
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
				read: () => ({ accounts: [account({ trades: true })] }),
				autoConfirmSchedule: () => scheduleOf([account({ trades: true })])
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
		const both: VaultAccountLike[] = [
			{
				steamId64: '76561198000000001',
				accountName: 'trader',
				autoConfirm: {
					marketListings: true,
					trades: false,
					pollIntervalSeconds: 15,
					notify: { enabled: false, detail: 'full' }
				}
			},
			{
				steamId64: '76561198000000002',
				accountName: 'trader',
				autoConfirm: {
					marketListings: true,
					trades: false,
					pollIntervalSeconds: 15,
					notify: { enabled: false, detail: 'full' }
				}
			}
		];
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts: both }),
			autoConfirmSchedule: () => scheduleOf(both)
		} as unknown as VaultService;
		// Armed only for the sweep under test: the two seeding ticks below have to
		// complete, and gating the first account would hang them.
		let gated = false;
		const confirmations = {
			runAutoConfirm: async (steamId64: string) => {
				ran.push(steamId64);
				if (gated && steamId64 === '76561198000000001') {
					await gateA;
				}
				return { approved: [], held: [], unreadable: 0 };
			}
		} as unknown as ConfirmationsService;

		/*
		 * **Two accounts have to be due in the SAME sweep for this to mean
		 * anything**, and after the stampede fix they are not on the first one:
		 * accounts are given staggered slots before any of them polls. So the
		 * clock is advanced until both come round together, which is the state
		 * this property is actually about — a sweep that holds two accounts must
		 * not serialise them behind each other's network call.
		 */
		let at = 0;
		const engine = new AutoConfirmEngine({ vault, confirmations, now: () => at });

		// Beat 0 seeds both and polls the first; beat 1 polls the second.
		await engine.tick();
		at = 1000;
		await engine.tick();
		expect(ran, 'both accounts should have had a first poll by now').toHaveLength(2);

		// Far enough ahead that both intervals have elapsed.
		ran.length = 0;
		gated = true;
		at = 60_000;
		const sweep = engine.tick();

		// Both must have been *started* while A is still gated.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ran, 'the sweep serialised two accounts behind one another').toContain(
			'76561198000000002'
		);

		releaseA?.();
		await sweep;
	});
});

/*
 * Accounts must not poll in lockstep.
 *
 * The old jitter hashed the SteamID over `interval / 4` — under four seconds at
 * the default interval — while the scheduler only sampled due work on a
 * ten-second beat. Every account's next due time therefore landed inside the
 * same beat and they polled together anyway, which is precisely what
 * THREAT_MODEL says routing plus jitter prevents.
 */
describe('scheduling two accounts on the same interval', () => {
	it('separates them onto different beats after the first sweep', async () => {
		let at = 0;
		const beats: number[] = [];
		const accounts = ['76561198000000001', '76561198000000002'].map((steamId64) =>
			account({ marketListings: true }, { steamId64 })
		);
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => scheduleOf(accounts)
		} as unknown as VaultService;
		let ranThisBeat = 0;
		const confirmations = {
			runAutoConfirm: () => {
				ranThisBeat += 1;
				return Promise.resolve({ approved: [], held: [], unreadable: 0 });
			}
		} as unknown as ConfirmationsService;

		const engine = new AutoConfirmEngine({ vault, confirmations, now: () => at });
		for (let second = 0; second < 120; second += 1) {
			at = second * 1000;
			ranThisBeat = 0;
			await engine.tick();
			if (ranThisBeat > 0) beats.push(ranThisBeat);
		}

		// **No joint beat at all, including the first — and that is the change.**
		//
		// This used to read "the first sweep is necessarily joint, nothing is
		// scheduled yet", and asserted `beats[0]` was 2. That premise was the
		// defect: an account with no state counted as due, so every unlock sent
		// every enabled account to Steam on one beat, over as many proxies as the
		// vault has. The stagger existed but only ever moved the *next* poll.
		//
		// Accounts are now given a slot before any of them polls, so there is no
		// sweep in which two share a beat.
		expect(
			beats.every((n) => n === 1),
			'two accounts shared a beat'
		).toBe(true);
		expect(beats.length).toBeGreaterThan(4);
	});
});

/*
 * A halted account must stop costing anything.
 *
 * The cheap early-out reads `earliestDueAt`, and halting set `nextDueAt` to
 * Infinity without recomputing it — so the beat kept firing against a stale
 * value and deep-cloned the whole secret-bearing vault, once a second, for as
 * long as the process ran. Steam was never contacted again; the cost was
 * entirely local and entirely invisible.
 */
describe('after auto-confirm halts', () => {
	it('stops reading the vault on every beat', async () => {
		let at = 0;
		let reads = 0;
		const enabled: VaultAccountLike[] = [
			{
				steamId64: '76561198000000001',
				accountName: 'trader',
				autoConfirm: {
					marketListings: false,
					trades: true,
					pollIntervalSeconds: 15,
					notify: { enabled: false, detail: 'full' }
				}
			}
		];
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts: enabled }),
			autoConfirmSchedule: () => {
				reads += 1;
				return scheduleOf(enabled);
			}
		} as unknown as VaultService;
		const confirmations = {
			runAutoConfirm: () => Promise.reject(new Error('the session is dead'))
		} as unknown as ConfirmationsService;

		const engine = new AutoConfirmEngine({
			vault,
			confirmations,
			now: () => at,
			onFailure: () => undefined
		});

		// Ten consecutive failures is the documented halt threshold. Advance past
		// each backoff so every tick actually attempts.
		for (let i = 0; i < 10; i += 1) {
			at += 20 * 60_000;
			await engine.tick();
		}
		const atHalt = reads;

		// Three more beats. Nothing is due — and nothing should be read.
		for (let i = 0; i < 3; i += 1) {
			at += 1000;
			await engine.tick();
		}
		expect(reads).toBe(atHalt);
	});
});

/*
 * **The default vault, which is the one almost everybody has.**
 *
 * The halted case above was fixed and tested; this one was neither. With
 * auto-confirm switched off everywhere, no account is ever scheduled, so
 * `earliestDueAt` never leaves 0, so the cheap early-out never fires — and
 * every single beat, for the whole life of an unlocked session, went to the
 * vault. That read used to be `read()`, which deep-clones every shared secret,
 * identity secret and revocation code the user owns; §11 already admits those
 * strings survive until collection, and this made an acknowledged limit
 * measurably worse once a second in exchange for nothing.
 *
 * It still asks the vault every beat — that is what keeps a switch flipped in
 * settings taking effect within a second — but what it asks for now holds no
 * secrets.
 */
describe('a vault with auto-confirm switched off everywhere', () => {
	it('never deep-clones the vault to discover there is nothing to do', async () => {
		let clones = 0;
		let projections = 0;
		const idle: VaultAccountLike[] = [
			{
				steamId64: '76561198000000001',
				accountName: 'trader',
				autoConfirm: {
					marketListings: false,
					trades: false,
					pollIntervalSeconds: 15,
					notify: { enabled: false, detail: 'full' }
				}
			},
			{
				steamId64: '76561198000000002',
				accountName: 'trader',
				autoConfirm: {
					marketListings: false,
					trades: false,
					pollIntervalSeconds: 15,
					notify: { enabled: false, detail: 'full' }
				}
			}
		];
		const vault = {
			isUnlocked: () => true,
			read: () => {
				clones += 1;
				return { accounts: idle };
			},
			autoConfirmSchedule: () => {
				projections += 1;
				return scheduleOf(idle);
			}
		} as unknown as VaultService;

		const engine = new AutoConfirmEngine({
			vault,
			confirmations: {
				runAutoConfirm: () => Promise.reject(new Error('nothing should be polled'))
			} as unknown as ConfirmationsService,
			now: () => 0,
			onFailure: () => undefined
		});

		for (let i = 0; i < 30; i += 1) {
			await engine.tick();
		}

		expect(clones, 'the whole secret-bearing vault was cloned on a beat').toBe(0);
		// The projection is still consulted, so switching auto-confirm on takes
		// effect on the next beat rather than on the next unlock.
		expect(projections).toBeGreaterThan(0);
	});

	it('carries the same fields the scheduler used to read off the vault', () => {
		expect(
			scheduleOf([
				{
					steamId64: '76561198000000001',
					accountName: 'trader',
					autoConfirm: {
						marketListings: true,
						trades: false,
						pollIntervalSeconds: 45,
						notify: { enabled: false, detail: 'full' }
					}
				}
			])
		).toEqual([
			{
				steamId64: '76561198000000001',
				accountName: 'trader',
				marketListings: true,
				trades: false,
				pollIntervalSeconds: 45,
				notify: { enabled: false, detail: 'full' },
				hasProxy: false
			}
		]);
	});
});

/**
 * **Watching without approving.**
 *
 * An account may have notifications on and both auto-confirm switches off. It
 * is polled, and everything it finds is reported to a person; nothing is ever
 * approved on its behalf. The dangerous mistake here is routing such an account
 * through `runAutoConfirm`, which approves nothing with both switches off and
 * returns an empty outcome — a feature that polls forever and tells nobody
 * anything. So these assert on `list` being called and `runAutoConfirm` not.
 */
describe('notify-only accounts', () => {
	function notifyHarness(options: {
		accounts?: VaultAccountLike[];
		requireProxies?: boolean;
		list?: (steamId64: string) => Promise<{
			confirmations: ConfirmationSummary[];
			unreadable: number;
		}>;
		run?: (steamId64: string) => Promise<AutoConfirmOutcome>;
	}) {
		let clock = NOW;
		const pending: {
			steamId64: string;
			accountName: string;
			awaiting: ConfirmationSummary[];
			unreadable: number;
			detail: NotifyDetail;
		}[] = [];
		const signIns: { steamId64: string; accountName: string }[] = [];
		const failures: {
			steamId64: string;
			reason: string;
			halted: boolean;
			context?: { accountName: string; mode: string };
		}[] = [];

		const runAutoConfirm = vi.fn(
			options.run ??
				((): Promise<AutoConfirmOutcome> =>
					Promise.resolve({ approved: [], held: [], unreadable: 0 }))
		);
		const list = vi.fn(
			options.list ??
				((): Promise<{ confirmations: ConfirmationSummary[]; unreadable: number }> =>
					Promise.resolve({ confirmations: [], unreadable: 0 }))
		);

		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts: options.accounts ?? [] }),
			autoConfirmSchedule: () => scheduleOf(options.accounts)
		} as unknown as VaultService;

		const engine = new AutoConfirmEngine({
			vault,
			confirmations: { runAutoConfirm, list } as unknown as ConfirmationsService,
			now: () => clock,
			requireProxies: () => options.requireProxies ?? false,
			onPending: (steamId64, accountName, awaiting, unreadable, detail) =>
				pending.push({ steamId64, accountName, awaiting, unreadable, detail }),
			onSignInNeeded: (steamId64, accountName) => signIns.push({ steamId64, accountName }),
			onFailure: (steamId64, reason, halted, context) =>
				failures.push({ steamId64, reason, halted, context }),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});

		return {
			engine,
			runAutoConfirm,
			list,
			pending,
			signIns,
			failures,
			advance: (ms: number) => {
				clock += ms;
			}
		};
	}

	const watching = account({ notify: { enabled: true, detail: 'full' } });

	it('is polled with both auto-confirm switches off', async () => {
		const h = notifyHarness({ accounts: [watching] });
		await h.engine.tick();
		expect(h.list).toHaveBeenCalledWith('76561198000000001');
	});

	it('never goes through runAutoConfirm', async () => {
		const h = notifyHarness({ accounts: [watching] });
		await h.engine.tick();
		expect(
			h.runAutoConfirm,
			'a watching account was sent down the approve path, which never lists, so never notifies'
		).not.toHaveBeenCalled();
	});

	it('reports what it found', async () => {
		const h = notifyHarness({
			accounts: [watching],
			list: () =>
				Promise.resolve({
					confirmations: [{ id: '1' } as unknown as ConfirmationSummary],
					unreadable: 2
				})
		});
		await h.engine.tick();
		expect(h.pending).toHaveLength(1);
		expect(h.pending[0]?.accountName).toBe('trader');
		expect(h.pending[0]?.awaiting).toHaveLength(1);
		expect(h.pending[0]?.unreadable).toBe(2);
		expect(h.pending[0]?.detail).toBe('full');
	});

	it('is not polled when neither notifications nor auto-confirm are on', async () => {
		const h = notifyHarness({ accounts: [account()] });
		await h.engine.tick();
		expect(h.list).not.toHaveBeenCalled();
		expect(h.runAutoConfirm).not.toHaveBeenCalled();
	});

	/*
	 * One poll serves both. An account with an auto type on takes the confirm
	 * arm even when it also wants toasts, and what `runAutoConfirm` held back is
	 * what a person still has to look at.
	 */
	it('polls once when both are on, and reports what was held', async () => {
		const both = account({ trades: true, notify: { enabled: true, detail: 'type' } });
		const h = notifyHarness({
			accounts: [both],
			run: () =>
				Promise.resolve({
					approved: [],
					held: [{ confirmation: { id: '9' } as unknown as ConfirmationSummary, reason: 'nope' }],
					unreadable: 0
				} as unknown as AutoConfirmOutcome)
		});
		await h.engine.tick();
		expect(h.runAutoConfirm).toHaveBeenCalledTimes(1);
		expect(h.list).not.toHaveBeenCalled();
		expect(h.pending[0]?.awaiting).toHaveLength(1);
		expect(h.pending[0]?.detail).toBe('type');
	});

	it('does not report pending for an account that only auto-confirms', async () => {
		const h = notifyHarness({ accounts: [account({ trades: true })] });
		await h.engine.tick();
		expect(h.runAutoConfirm).toHaveBeenCalledTimes(1);
		expect(h.pending).toHaveLength(0);
	});
});

/**
 * **`Require proxies` refuses at construction, so polling anyway is wasted.**
 *
 * `transports.forAccount` throws before any request is made. Ten of those in a
 * row reach the halt — an account hidden by a policy refusal rather than a
 * fault, until something unrelated changes.
 */
describe('Require proxies', () => {
	function h(requireProxies: boolean, proxyUrl?: string) {
		const accounts = [account({ trades: true }, proxyUrl === undefined ? {} : { proxyUrl })];
		const runAutoConfirm = vi.fn(() => Promise.resolve({ approved: [], held: [], unreadable: 0 }));
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => scheduleOf(accounts)
		} as unknown as VaultService;
		const engine = new AutoConfirmEngine({
			vault,
			confirmations: { runAutoConfirm } as unknown as ConfirmationsService,
			now: () => NOW,
			requireProxies: () => requireProxies,
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		return { engine, runAutoConfirm };
	}

	it('skips an account with no proxy when the rule is on', async () => {
		const { engine, runAutoConfirm } = h(true);
		await engine.tick();
		expect(runAutoConfirm).not.toHaveBeenCalled();
	});

	it('polls it when the rule is off', async () => {
		const { engine, runAutoConfirm } = h(false);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalled();
	});

	it('polls an account that has a proxy', async () => {
		const { engine, runAutoConfirm } = h(true, 'http://proxy.example:8080');
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalled();
	});

	it('treats an empty proxy string as no proxy', async () => {
		const { engine, runAutoConfirm } = h(true, '');
		await engine.tick();
		expect(runAutoConfirm).not.toHaveBeenCalled();
	});
});

/**
 * **An expired session is not a fault that backing off fixes.**
 *
 * Counting it toward the ten-strike halt spends ten intervals arriving at a
 * message phrased "failures in a row" — for the one condition only the user can
 * clear, and which the activity log's `failed` kind is not urgent enough to
 * surface. So it is caught ahead of the failure counter.
 *
 * **On both arms, and that is the whole point of these tests.** An earlier
 * draft caught it inside the notify branch only. Every account with an auto
 * type on takes the confirm branch, so the accounts that actually have this
 * problem were exactly the ones the fix would have missed.
 */
describe('a session that needs signing in again', () => {
	function h(mode: 'confirm' | 'notify') {
		const accounts = [
			mode === 'confirm'
				? account({ trades: true })
				: account({ notify: { enabled: true, detail: 'full' } })
		];
		const expired = new ConfirmationsError('the saved session expired. Sign in again.', true);
		const reject = (): Promise<never> => Promise.reject(expired);
		const signIns: { steamId64: string; accountName: string }[] = [];
		const failures: { reason: string; halted: boolean }[] = [];
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => scheduleOf(accounts)
		} as unknown as VaultService;
		let clock = NOW;
		const engine = new AutoConfirmEngine({
			vault,
			confirmations: {
				runAutoConfirm: reject,
				list: reject
			} as unknown as ConfirmationsService,
			now: () => clock,
			onSignInNeeded: (steamId64, accountName) => signIns.push({ steamId64, accountName }),
			onFailure: (_id, reason, halted) => failures.push({ reason, halted }),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		return {
			engine,
			signIns,
			failures,
			advance: (ms: number) => {
				clock += ms;
			}
		};
	}

	it('is reported, not counted, on the confirm arm', async () => {
		const { engine, signIns, failures } = h('confirm');
		await engine.tick();
		expect(signIns, 'a confirm-mode account with an expired session said nothing').toEqual([
			{ steamId64: '76561198000000001', accountName: 'trader' }
		]);
		expect(failures, 'an expired session was counted toward the halt').toEqual([]);
	});

	it('is reported, not counted, on the notify arm', async () => {
		const { engine, signIns, failures } = h('notify');
		await engine.tick();
		expect(signIns).toHaveLength(1);
		expect(failures).toEqual([]);
	});

	/*
	 * The clock has to move: a sign-in failure reschedules at the ordinary
	 * interval, so without advancing it every tick after the first early-outs on
	 * `nextDueAt` and the account is polled exactly once — which would make this
	 * pass while proving nothing.
	 */
	it('never halts, however many times it happens', async () => {
		const { engine, signIns, failures, advance } = h('confirm');
		for (let i = 0; i < 12; i += 1) {
			await engine.tick();
			advance(20 * 60_000);
		}
		expect(failures, 'twelve expired-session polls reached the halt').toEqual([]);
		expect(signIns, 'the account stopped being polled').toHaveLength(12);
	});

	/*
	 * The distinction that matters: an ordinary error is still a failure, still
	 * backs off, and still halts at ten. Catching sign-in ahead of the counter
	 * must not have swallowed the counter.
	 */
	it('still counts an ordinary failure', async () => {
		const accounts = [account({ trades: true })];
		const failures: { halted: boolean }[] = [];
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => scheduleOf(accounts)
		} as unknown as VaultService;
		let clock = NOW;
		const engine = new AutoConfirmEngine({
			vault,
			confirmations: {
				runAutoConfirm: () => Promise.reject(new Error('steam said no'))
			} as unknown as ConfirmationsService,
			now: () => clock,
			onFailure: (_id, _reason, halted) => failures.push({ halted }),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		for (let i = 0; i < 10; i += 1) {
			await engine.tick();
			clock += 20 * 60_000;
		}
		expect(failures).toHaveLength(10);
		expect(failures[9]?.halted, 'ten ordinary failures no longer halt').toBe(true);
	});
});

/**
 * **The halt sentence, and who it is about.**
 *
 * An account that was only ever watching never had automatic confirmation to
 * stop, so telling its owner that automatic confirmation has stopped describes
 * a feature they never switched on.
 */
describe('what a halt says', () => {
	async function haltWith(mode: 'confirm' | 'notify') {
		const accounts = [
			mode === 'confirm'
				? account({ trades: true })
				: account({ notify: { enabled: true, detail: 'full' } })
		];
		const reject = (): Promise<never> => Promise.reject(new Error('steam said no'));
		const failures: {
			reason: string;
			halted: boolean;
			context?: { accountName: string; mode: string };
		}[] = [];
		let clock = NOW;
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => scheduleOf(accounts)
		} as unknown as VaultService;
		const engine = new AutoConfirmEngine({
			vault,
			confirmations: {
				runAutoConfirm: reject,
				list: reject
			} as unknown as ConfirmationsService,
			now: () => clock,
			onFailure: (_id, reason, halted, context) => failures.push({ reason, halted, context }),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		for (let i = 0; i < 10; i += 1) {
			await engine.tick();
			clock += 20 * 60_000;
		}
		return failures[failures.length - 1];
	}

	it('says automatic confirmation stopped, for an account that was confirming', async () => {
		const last = await haltWith('confirm');
		expect(last?.halted).toBe(true);
		expect(last?.reason).toContain('Automatic confirmation stopped');
	});

	it('says checking stopped, for an account that was only watching', async () => {
		const last = await haltWith('notify');
		expect(last?.halted).toBe(true);
		expect(
			last?.reason,
			'a watching account was told automatic confirmation stopped, which it never had'
		).not.toContain('Automatic confirmation');
		expect(last?.reason).toContain('Checking stopped');
	});

	/*
	 * Both sentences contain "stopped", so the flag is the only thing that can
	 * distinguish a halt — which is why the activity log stopped inferring it
	 * from the wording.
	 */
	it('carries the halt as a flag, not something to read out of the sentence', async () => {
		const confirm = await haltWith('confirm');
		const notify = await haltWith('notify');
		expect(confirm?.reason).toContain('stopped');
		expect(notify?.reason).toContain('stopped');
		expect(confirm?.halted).toBe(true);
		expect(notify?.halted).toBe(true);
	});

	it('carries the account name and mode, which a toast needs', async () => {
		expect(await haltWith('confirm').then((f) => f?.context)).toEqual({
			accountName: 'trader',
			mode: 'confirm'
		});
		expect(await haltWith('notify').then((f) => f?.context)).toEqual({
			accountName: 'trader',
			mode: 'notify'
		});
	});
});

/**
 * **A listener that throws is not Steam saying no.**
 *
 * Four of the six listeners run inside `runOne`'s `try`, so a notification that
 * threw landed in the catch — where nothing can tell it from Steam refusing.
 * The successful pass was overwritten with a backoff, logged as `failed` with
 * the listener's own message, and on an hourly account the next poll was pulled
 * from an hour to thirty seconds: the rule that a failure never speeds anything
 * up, inverted by the reporting of a success. The two that run inside the catch
 * were worse — a throw there escaped the sweep as an unhandled rejection.
 */
describe('a notification listener that throws', () => {
	function h(which: 'onOutcome' | 'onPending' | 'onFailure' | 'onSignInNeeded', fail = false) {
		const accounts = [account({ trades: true, notify: { enabled: true, detail: 'full' } })];
		const boom = (): never => {
			throw new Error('the toast host exploded');
		};
		const failures: { halted: boolean }[] = [];
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => scheduleOf(accounts)
		} as unknown as VaultService;
		const engine = new AutoConfirmEngine({
			vault,
			confirmations: {
				runAutoConfirm: fail
					? () => Promise.reject(new Error('steam said no'))
					: () => Promise.resolve({ approved: [], held: [], unreadable: 0 })
			} as unknown as ConfirmationsService,
			now: () => NOW,
			onOutcome: which === 'onOutcome' ? boom : () => undefined,
			onPending: which === 'onPending' ? boom : () => undefined,
			onSignInNeeded: which === 'onSignInNeeded' ? boom : () => undefined,
			onFailure:
				which === 'onFailure'
					? boom
					: (_id, _reason, halted) => {
							failures.push({ halted });
						},
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		return { engine, failures };
	}

	it('does not turn a successful pass into a failure', async () => {
		const { engine, failures } = h('onOutcome');
		await engine.tick();
		expect(failures, 'a throwing listener was recorded as Steam refusing').toEqual([]);
	});

	it('does not turn a successful poll into a failure from onPending either', async () => {
		const { engine, failures } = h('onPending');
		await engine.tick();
		expect(failures).toEqual([]);
	});

	/*
	 * The listeners inside the catch never reached a failure counter — they
	 * escaped `runOne` entirely, rejecting the sweep with nothing anywhere in the
	 * application handling it.
	 */
	it('does not reject the sweep from inside the failure path', async () => {
		const { engine } = h('onFailure', true);
		await expect(engine.tick()).resolves.toBeUndefined();
	});

	it('does not reject the sweep from the sign-in path', async () => {
		const accounts = [account({ notify: { enabled: true, detail: 'full' } })];
		const expired = new ConfirmationsError('the saved session expired.', true);
		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts }),
				autoConfirmSchedule: () => scheduleOf(accounts)
			} as unknown as VaultService,
			confirmations: {
				list: () => Promise.reject(expired)
			} as unknown as ConfirmationsService,
			now: () => NOW,
			onSignInNeeded: () => {
				throw new Error('the toast host exploded');
			},
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		await expect(engine.tick()).resolves.toBeUndefined();
	});

	/*
	 * And the guard must not swallow the thing it is standing next to.
	 */
	it('still records a real Steam failure', async () => {
		const { engine, failures } = h('onOutcome', true);
		await engine.tick();
		expect(failures, 'guarding the listeners swallowed a real failure').toHaveLength(1);
	});
});

/**
 * **A route that changed under a request is not a failure.**
 *
 * Saving a proxy aborts whatever was in the air, and that abort reaches the
 * engine as an ordinary error. Without a per-account epoch the user's own save
 * was scored against them: a `failed` entry, a backoff of up to fifteen
 * minutes, and a strike toward the halt.
 */
describe('an account whose route changes mid-poll', () => {
	function parkedAccount() {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const accounts = [account({ trades: true })];
		const failures: string[] = [];
		const outcomes: string[] = [];
		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts }),
				autoConfirmSchedule: () => scheduleOf(accounts)
			} as unknown as VaultService,
			confirmations: {
				runAutoConfirm: async () => {
					await gate;
					throw new Error("this account's routing changed while the request was in the air.");
				}
			} as unknown as ConfirmationsService,
			now: () => NOW,
			onFailure: (_id, reason) => failures.push(reason),
			onOutcome: (id) => outcomes.push(id),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		return { engine, failures, outcomes, release: () => release?.() };
	}

	it('is not counted against the account', async () => {
		const h = parkedAccount();
		const sweep = h.engine.tick();
		// Let the sweep reach the parked request before the route changes.
		for (let i = 0; i < 5; i += 1) {
			await Promise.resolve();
		}

		h.engine.forgetAccount('76561198000000001');
		h.release();
		await sweep;

		expect(h.failures, "the user's own proxy save was logged as a Steam failure").toEqual([]);
	});

	/*
	 * Replacing a dead proxy is the obvious remedy for the routing errors that
	 * caused a halt. Nothing cleared it before: only a settings save, a lock, or
	 * a restart did.
	 */
	it('clears a halt, so a replaced proxy can be tried again', async () => {
		const accounts = [account({ trades: true })];
		let clock = NOW;
		const failures: { halted: boolean }[] = [];
		let calls = 0;
		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts }),
				autoConfirmSchedule: () => scheduleOf(accounts)
			} as unknown as VaultService,
			confirmations: {
				runAutoConfirm: () => {
					calls += 1;
					return Promise.reject(new Error('routing refused'));
				}
			} as unknown as ConfirmationsService,
			now: () => clock,
			onFailure: (_id, _reason, halted) => failures.push({ halted }),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});

		for (let i = 0; i < 10; i += 1) {
			await engine.tick();
			clock += 20 * 60_000;
		}
		expect(failures[9]?.halted, 'the account should be halted by now').toBe(true);

		const before = calls;
		await engine.tick();
		expect(calls, 'a halted account was polled anyway').toBe(before);

		engine.forgetAccount('76561198000000001');
		clock += 20 * 60_000;
		await engine.tick();
		await engine.tick();
		expect(calls, 'replacing the proxy did not lift the halt').toBeGreaterThan(before);
	});
});

/**
 * **A poll carries the settings it started with, and they can be replaced
 * underneath it.**
 *
 * `runOne` reads `notify` and the disclosure detail before its request and uses
 * them after. Clearing only the schedule on a settings change left the request
 * in flight holding what the user had just replaced — so switching
 * notifications off, or `full` down to `count`, still produced one last `full`
 * toast naming the trade partner and the headline. Precisely the toast somebody
 * switched the feature off to stop.
 */
describe('notification settings changed while a poll was in the air', () => {
	function parked() {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const accounts = [account({ notify: { enabled: true, detail: 'full' } })];
		const pending: { detail: string }[] = [];
		const outcomes: string[] = [];
		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts }),
				autoConfirmSchedule: () => scheduleOf(accounts)
			} as unknown as VaultService,
			confirmations: {
				list: async () => {
					await gate;
					return { confirmations: [{ id: '1' } as unknown as ConfirmationSummary], unreadable: 0 };
				}
			} as unknown as ConfirmationsService,
			now: () => NOW,
			onPending: (_id, _name, _awaiting, _unreadable, detail) => pending.push({ detail }),
			onOutcome: (id) => outcomes.push(id),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		return { engine, pending, outcomes, release: () => release?.() };
	}

	it('raises no toast under the policy the user just replaced', async () => {
		const h = parked();
		const sweep = h.engine.tick();
		for (let i = 0; i < 5; i += 1) {
			await Promise.resolve();
		}

		// The user switches notifications off, or down to `count`.
		h.engine.reset('76561198000000001');
		h.release();
		await sweep;

		expect(h.pending, 'a toast was composed from settings the user had already replaced').toEqual(
			[]
		);
	});

	/*
	 * A confirm-mode poll that actually approved something still reports it.
	 * Approving a trade is a fact about the world whatever the settings now say,
	 * and the activity log is the only record of it.
	 */
	it('still reports an outcome it really achieved', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const accounts = [account({ trades: true })];
		const outcomes: string[] = [];
		const engine = new AutoConfirmEngine({
			vault: {
				isUnlocked: () => true,
				read: () => ({ accounts }),
				autoConfirmSchedule: () => scheduleOf(accounts)
			} as unknown as VaultService,
			confirmations: {
				runAutoConfirm: async () => {
					await gate;
					return { approved: [], held: [], unreadable: 0 };
				}
			} as unknown as ConfirmationsService,
			now: () => NOW,
			onOutcome: (id) => outcomes.push(id),
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});

		const sweep = engine.tick();
		for (let i = 0; i < 5; i += 1) {
			await Promise.resolve();
		}
		engine.reset('76561198000000001');
		release?.();
		await sweep;

		expect(outcomes, 'a real approval went unrecorded').toHaveLength(1);
	});
});

/**
 * **An invalidation a sibling could undo.**
 *
 * `forgetAccount` and `reset` set `earliestDueAt = 0` so the next beat re-reads
 * the vault. Any *other* account's poll finishing later in the same sweep then
 * calls `rememberEarliest`, which recomputes that cache from the state map —
 * and the forgotten account is no longer in it, so the invalidation is quietly
 * reversed by an account it has nothing to do with.
 *
 * With one account it is harmless: the map goes empty and the recompute yields
 * 0 anyway, which is exactly why every earlier test of these two methods
 * missed it. With two it is not, and the worst shape is a halted sibling: its
 * entry holds `Infinity`, so the recompute pins the cache there and the beat's
 * early-out stops the engine reading the vault at all — for every account.
 */
describe('a schedule invalidated while another account is mid-poll', () => {
	function twoAccounts(runFor: (steamId64: string) => Promise<never> | Promise<unknown>) {
		const accounts = [
			account({ trades: true }, { steamId64: '76561198000000001' }),
			account({ trades: true }, { steamId64: '76561198000000002' })
		];
		let clock = NOW;
		let reads = 0;
		const vault = {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			autoConfirmSchedule: () => {
				reads += 1;
				return scheduleOf(accounts);
			}
		} as unknown as VaultService;
		const engine = new AutoConfirmEngine({
			vault,
			confirmations: { runAutoConfirm: runFor } as unknown as ConfirmationsService,
			now: () => clock,
			setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
			clearTimer: () => undefined
		});
		return {
			engine,
			reads: () => reads,
			advance: (ms: number) => {
				clock += ms;
			}
		};
	}

	it('still re-reads the vault when a halted sibling holds infinity', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let park = false;
		// **The SIBLING is the one parked.** The forgotten account's own poll is
		// disowned by its epoch and returns before writing anything, so it cannot
		// be what undoes the invalidation. It is the other account — whose epoch
		// is untouched, and which therefore completes normally and recomputes the
		// cache from a map the forgotten account has just left.
		const h = twoAccounts(async (steamId64) => {
			if (steamId64 === '76561198000000002') {
				if (park) {
					await gate;
				}
				throw new Error('steam said no');
			}
			return { approved: [], held: [], unreadable: 0 };
		});

		// Nine failures: one short of the halt, so the tenth lands while parked.
		for (let i = 0; i < 9; i += 1) {
			await h.engine.tick();
			h.advance(20 * 60_000);
		}

		park = true;
		const sweep = h.engine.tick();
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}

		// The user repairs the OTHER account's proxy while that poll is in flight.
		h.engine.forgetAccount('76561198000000001');

		// The sibling's tenth failure halts it, writing `Infinity` and recomputing.
		release?.();
		await sweep;

		const before = h.reads();
		await h.engine.tick();

		expect(
			h.reads(),
			'a halted sibling pinned the cache at infinity and the engine went silent'
		).toBeGreaterThan(before);
	});

	it('still re-reads the vault when a sibling reschedules normally', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let park = false;
		const h = twoAccounts(async (steamId64) => {
			if (steamId64 === '76561198000000002' && park) {
				await gate;
			}
			return { approved: [], held: [], unreadable: 0 };
		});

		// Both accounts get their slots and their first polls.
		await h.engine.tick();
		h.advance(1000);
		await h.engine.tick();
		h.advance(20 * 60_000);

		// The sibling's poll is in flight when the user saves settings for the
		// other account. Its healthy `nextDueAt` must not overwrite the
		// invalidation `reset` just made.
		park = true;
		const sweep = h.engine.tick();
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}
		h.engine.reset('76561198000000001');
		release?.();
		await sweep;

		const before = h.reads();
		await h.engine.tick();

		expect(h.reads(), 'a sibling rescheduling undid the invalidation').toBeGreaterThan(before);
	});
});
