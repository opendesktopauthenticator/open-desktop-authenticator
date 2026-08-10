import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as SteamTotp from 'steam-totp';
import { generateGuardCode, secondsRemaining } from '../../src/main/codes/totp';

/**
 * Differential test: our code generator against `steam-totp`.
 *
 * The application deliberately does not depend on `steam-totp` — Steam Guard
 * code generation is twenty lines and it is the most security-critical
 * computation in the product, so it is written out where it can be read (see
 * `src/main/codes/totp.ts`). The cost of that choice is that "it matches the
 * library everyone else uses" stops being true by construction.
 *
 * So it is asserted instead, here in the spike, which already depends on the
 * library. Every disagreement over thousands of windows and dozens of secrets
 * fails the build.
 *
 * This is the reason the spike is kept rather than deleted after Phase 0: it is
 * where the reference implementations live.
 */

/** Steam shared secrets are twenty random bytes, base64-encoded. */
function randomSecret(): string {
	return randomBytes(20).toString('base64');
}

/** Pin the clock so both implementations see exactly the same second. */
function at(unixSeconds: number, run: () => void): void {
	vi.setSystemTime(new Date(unixSeconds * 1000));
	run();
}

beforeAll(() => {
	vi.useFakeTimers();
});

afterAll(() => {
	vi.useRealTimers();
});

describe('parity with steam-totp', () => {
	it('agrees on a fixed secret across a decade of windows', () => {
		const secret = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
		// Every 7919 seconds (a prime, so the sample does not land on a pattern)
		// from 2020 to 2030.
		let checked = 0;
		for (let t = 1_577_836_800; t < 1_893_456_000; t += 7919) {
			at(t, () => {
				expect(generateGuardCode(secret, t), `mismatch at t=${t}`).toBe(
					SteamTotp.generateAuthCode(secret)
				);
			});
			checked++;
		}
		// Guards against a loop that silently did nothing.
		expect(checked).toBeGreaterThan(30_000);
	});

	it('agrees across many random secrets', () => {
		for (let i = 0; i < 200; i++) {
			const secret = randomSecret();
			const t = 1_600_000_000 + Math.floor(Math.random() * 500_000_000);
			at(t, () => {
				expect(generateGuardCode(secret, t), `mismatch for a random secret at t=${t}`).toBe(
					SteamTotp.generateAuthCode(secret)
				);
			});
		}
	});

	it('agrees on the boundaries of a window', () => {
		const secret = randomSecret();
		// A window opens on a multiple of 30. Both edges and both neighbours.
		const base = 1_700_000_010;
		for (const t of [base - 1, base, base + 1, base + 29, base + 30, base + 31]) {
			at(t, () => {
				expect(generateGuardCode(secret, t), `mismatch at t=${t}`).toBe(
					SteamTotp.generateAuthCode(secret)
				);
			});
		}
	});

	it('agrees on how long is left in the window', () => {
		for (const t of [1_700_000_000, 1_700_000_001, 1_700_000_029, 1_700_000_030]) {
			at(t, () => {
				// steam-totp exposes Steam-corrected time; the remainder is the same
				// arithmetic both sides must agree on.
				expect(secondsRemaining(t)).toBe(30 - (SteamTotp.time(0) % 30));
			});
		}
	});

	it('produces codes only from Steam alphabet', () => {
		const secret = randomSecret();
		for (let t = 1_700_000_000; t < 1_700_003_000; t += 31) {
			expect(generateGuardCode(secret, t)).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
		}
	});
});
