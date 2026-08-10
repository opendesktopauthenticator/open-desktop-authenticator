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
} {
	let clock = NOW;
	const outcomes: { steamId64: string; outcome: AutoConfirmOutcome }[] = [];
	const failures: { steamId64: string; reason: string }[] = [];

	const runAutoConfirm = vi.fn(
		options.run ?? ((): Promise<AutoConfirmOutcome> => Promise.resolve({ approved: [], held: [] }))
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

		advance(15_000);
		await engine.tick();
		expect(runAutoConfirm).toHaveBeenCalledTimes(2);
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
					]
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
				shouldFail ? Promise.reject(new Error('nope')) : Promise.resolve({ approved: [], held: [] })
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
