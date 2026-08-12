import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The in-process rate limiter, under the conditions that actually stress it.
 *
 * nginx limits these paths in front of the service and is what holds under real
 * load. This is the backstop for the day that zone gets edited away, so the
 * things worth testing are the ones that only appear when the map is full — and
 * the map only fills during a flood across thousands of addresses, which is
 * exactly when nobody is watching a test suite.
 *
 * **The first version of this file passed against the broken limiter.** Both
 * defects need conditions a fast test does not naturally produce: the
 * cross-window bug needs an entry that is old by one window and young by
 * another, and nothing in a test that finishes in eight milliseconds is old by
 * any window. The windows here are therefore small and real time is allowed to
 * pass, rather than the ten and fifteen minutes production uses.
 */

let service: typeof import('../tickets/server.mjs', { with: { 'resolution-mode': 'import' } });

beforeAll(async () => {
	process.env.TICKETS_DB = ':memory:';
	process.env.TICKETS_NO_LISTEN = '1';
	service = await import('../tickets/server.mjs');
});

afterAll(() => service.server?.close?.());

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unique per test, so one test's traffic is never another's budget. */
let run = 0;
const scope = () => `run${(run += 1)}`;

/** Fill the map past the cap with short-window traffic, as a flood would. */
const flood = (tag: string, count: number, windowMs: number) => {
	for (let i = 0; i < count; i++) service.tooMany(`attach:${tag}:${i}`, 12, windowMs);
};

describe('a key is judged against its own window, not the caller of the moment', () => {
	// Production uses ten minutes for the public forms and fifteen for login.
	// These stand in for that pair at a scale a test can wait out.
	const SHORT = 120;
	const LONG = 4000;

	it('does not forgive a login while a shorter-window sweep runs', async () => {
		const tag = scope();
		const guesser = `login:${tag}`;

		for (let i = 0; i < 5; i++) {
			expect(service.tooMany(guesser, 5, LONG)).toBe(false);
		}
		expect(service.tooMany(guesser, 5, LONG), 'the budget is spent').toBe(true);

		// Let it age past the *short* window while staying well inside its own.
		await wait(SHORT + 60);

		// Now push the map over the cap with short-window traffic. The old sweep
		// judged every entry against the calling window's cutoff, so this deleted
		// the login entry and handed a password guesser five fresh attempts.
		flood(tag, 5200, SHORT);

		expect(
			service.tooMany(guesser, 5, LONG),
			"a guesser must not be forgiven early by someone else's traffic"
		).toBe(true);
	});

	it('still forgives a key once its own window has genuinely passed', async () => {
		// The guard must not become a permanent ban: someone who mistyped a
		// password five times has to get back in.
		const key = `login:${scope()}`;
		for (let i = 0; i < 6; i++) service.tooMany(key, 5, 60);
		expect(service.tooMany(key, 5, 60)).toBe(true);

		await wait(120);
		expect(service.tooMany(key, 5, 60), 'the window elapsed, so the slate is clean').toBe(false);
	});
});

describe('the map stays bounded, and sweeping stays cheap', () => {
	it('never grows past the cap however many addresses arrive', () => {
		const tag = scope();
		flood(tag, 12_000, 60_000); // all live, so nothing is sweepable
		expect(service.attemptStats().size).toBeLessThanOrEqual(5000);
	});

	it('sweeps once in a while, not once per request', () => {
		const tag = scope();
		flood(tag, 12_000, 60_000); // arrive at a full map
		const before = service.attemptStats().sweeps;
		flood(`${tag}:more`, 2000, 60_000);
		const swept = service.attemptStats().sweeps - before;

		// Each sweep clears 1,000 entries, so 2,000 inserts is about two sweeps.
		// Sweeping to the cap instead of below it made this 2,000 — a full walk of
		// a 5,000-entry map on every request, on the busiest path, at exactly the
		// moment the box is already carrying whatever filled the map.
		expect(swept, `${swept} sweeps for 2000 inserts`).toBeLessThan(10);
	});

	it('keeps counting the caller that is actually hammering it', () => {
		// Eviction drops entries closest to expiring. Someone mid-flood has the
		// freshest entry there is, so they must survive their own noise — a
		// limiter that forgets whoever is loudest is worse than none.
		const tag = scope();
		const loud = `submit:${tag}:loud`;
		for (let i = 0; i < 6; i++) service.tooMany(loud, 5, 60_000);
		expect(service.tooMany(loud, 5, 60_000)).toBe(true);

		flood(tag, 6000, 30_000);

		expect(
			service.tooMany(loud, 5, 60_000),
			'the loudest caller must not be evicted by their own flood'
		).toBe(true);
	});
});
