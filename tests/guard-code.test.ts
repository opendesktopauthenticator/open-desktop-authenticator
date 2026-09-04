import { describe, expect, it, vi } from 'vitest';
import {
	decodeSharedSecret,
	generateGuardCode,
	GuardCodeError,
	isUsableSharedSecret,
	secondsRemaining,
	WINDOW_SECONDS
} from '../src/main/codes/totp';

/**
 * Steam Guard code generation (§12 F4).
 *
 * The vectors below were produced by `steam-totp`, the library the rest of the
 * ecosystem uses, and are pinned here so this suite stands on its own. The
 * broader proof — tens of thousands of windows and hundreds of secrets compared
 * against that library — lives in `spike/tests/totp-parity.test.ts`, where the
 * library is actually installed.
 *
 * Wrong codes are not a cosmetic failure. A user with a wrong code cannot log
 * in, cannot trade, and has no way to tell whether the fault is ours or Steam's.
 */

/** Twenty random bytes, base64. Not a real account's secret. */
const SECRET = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';

describe('known answers', () => {
	it.each([
		[0, 'W3J46'],
		[1_500_000_000, 'Q9JC4'],
		[1_700_000_000, 'X45RP'],
		[1_893_456_000, 'PJ4MJ']
	])('t=%i produces %s', (time, expected) => {
		expect(generateGuardCode(SECRET, time)).toBe(expected);
	});

	it('is stable for every second inside one window', () => {
		const start = 1_700_000_010; // a multiple of 30
		const expected = generateGuardCode(SECRET, start);
		for (let offset = 0; offset < WINDOW_SECONDS; offset++) {
			expect(generateGuardCode(SECRET, start + offset)).toBe(expected);
		}
	});

	it('changes at the window boundary', () => {
		const start = 1_700_000_010;
		expect(generateGuardCode(SECRET, start + WINDOW_SECONDS)).not.toBe(
			generateGuardCode(SECRET, start)
		);
	});

	it('ignores sub-second precision', () => {
		expect(generateGuardCode(SECRET, 1_700_000_000.9)).toBe(
			generateGuardCode(SECRET, 1_700_000_000)
		);
	});

	it('uses only Steam alphabet', () => {
		for (let t = 1_700_000_000; t < 1_700_006_000; t += 30) {
			expect(generateGuardCode(SECRET, t)).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
		}
	});

	it('handles a counter beyond 32 bits', () => {
		// The counter is written as two 32-bit halves; a single writeUInt32BE would
		// silently truncate here. Year 6053.
		const far = 2 ** 32 * WINDOW_SECONDS + 12_345;
		expect(() => generateGuardCode(SECRET, far)).not.toThrow();
		expect(generateGuardCode(SECRET, far)).not.toBe(generateGuardCode(SECRET, 12_345));
	});
});

describe('shared secret validation', () => {
	it('accepts a well-formed secret', () => {
		expect(decodeSharedSecret(SECRET)).toHaveLength(20);
	});

	it('tolerates surrounding whitespace', () => {
		expect(decodeSharedSecret(`  ${SECRET}\n`)).toHaveLength(20);
	});

	it('rejects an empty secret', () => {
		expect(() => decodeSharedSecret('')).toThrow(GuardCodeError);
		expect(() => decodeSharedSecret('   ')).toThrow(/no shared secret/);
	});

	it('rejects a secret that is not really base64', () => {
		// Buffer.from silently discards non-base64 characters, so a corrupted
		// secret would otherwise decode to something shorter and generate
		// confidently wrong codes forever.
		expect(() => decodeSharedSecret('not a secret!!')).toThrow(/not valid base64/);
	});

	it('rejects a secret of the wrong length', () => {
		expect(() => decodeSharedSecret(Buffer.alloc(16).toString('base64'))).toThrow(
			/16 bytes; Steam's are 20/
		);
	});

	it('refuses to generate a code from an unusable secret', () => {
		expect(() => generateGuardCode('', 1_700_000_000)).toThrow(GuardCodeError);
	});
});

describe('window arithmetic', () => {
	it('counts down from 30 to 1', () => {
		const start = 1_700_000_010;
		expect(secondsRemaining(start)).toBe(30);
		expect(secondsRemaining(start + 1)).toBe(29);
		expect(secondsRemaining(start + 29)).toBe(1);
		expect(secondsRemaining(start + 30)).toBe(30);
	});

	it('never reports zero, which would show as an expired code still on screen', () => {
		for (let t = 1_700_000_000; t < 1_700_000_120; t++) {
			const left = secondsRemaining(t);
			expect(left).toBeGreaterThan(0);
			expect(left).toBeLessThanOrEqual(30);
		}
	});

	it('holds the 1–30 contract for times that should never happen', () => {
		// `%` keeps the sign of its left operand, so a negative time produced 31–35
		// and NaN produced NaN — both of which reach the UI as a countdown that
		// cannot be true. A time before 1970 is nonsense, not a case to support.
		for (const t of [-5, -1, -0.5, 0, Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
			const left = secondsRemaining(t);
			expect(Number.isFinite(left), `t=${t}`).toBe(true);
			expect(left, `t=${t}`).toBeGreaterThan(0);
			expect(left, `t=${t}`).toBeLessThanOrEqual(30);
		}
	});
});

describe('hex secrets', () => {
	// `steam-totp` accepts a forty-character hex secret, so files in the wild use
	// that form. Rejecting it meant an import that succeeded and then never
	// produced a code — the worst possible way to be incompatible.
	const hex = Buffer.from(SECRET, 'base64').toString('hex');

	it('produces the same code from hex as from the equivalent base64', () => {
		expect(hex).toHaveLength(40);
		expect(generateGuardCode(hex, 1_700_000_000)).toBe(generateGuardCode(SECRET, 1_700_000_000));
	});

	it('accepts upper case hex', () => {
		expect(generateGuardCode(hex.toUpperCase(), 1_700_000_000)).toBe(
			generateGuardCode(SECRET, 1_700_000_000)
		);
	});

	it('does not treat a longer string containing hex as a hex secret', () => {
		// The reference implementation's test is unanchored. Ours is not, so a
		// string that merely contains forty hex characters is still read as base64.
		expect(() => decodeSharedSecret(`${hex}deadbeef`)).toThrow(GuardCodeError);
	});
});

describe('isUsableSharedSecret', () => {
	it('accepts what generateGuardCode accepts', () => {
		expect(isUsableSharedSecret(SECRET)).toBe(true);
		expect(isUsableSharedSecret(Buffer.from(SECRET, 'base64').toString('hex'))).toBe(true);
	});

	it('rejects what it cannot use, without throwing', () => {
		for (const bad of ['', '   ', 'not a secret!!', Buffer.alloc(16).toString('base64')]) {
			expect(isUsableSharedSecret(bad)).toBe(false);
		}
	});

	it('wipes the decoded validation key on success', () => {
		const fill = vi.spyOn(Buffer.prototype, 'fill');
		try {
			expect(isUsableSharedSecret(SECRET)).toBe(true);
			expect(
				fill.mock.instances.some(
					(buffer) =>
						Buffer.isBuffer(buffer) && buffer.length === 20 && buffer.every((byte) => byte === 0)
				)
			).toBe(true);
		} finally {
			fill.mockRestore();
		}
	});
});

describe('secret-buffer lifetime', () => {
	it('wipes the decoded key, counter and digest after generating a code', () => {
		const fill = vi.spyOn(Buffer.prototype, 'fill');
		try {
			expect(generateGuardCode(SECRET, 1_700_000_000)).toBe('X45RP');
			const wipedLengths = fill.mock.instances
				.filter((buffer): buffer is Buffer => Buffer.isBuffer(buffer))
				.filter((buffer) => buffer.every((byte) => byte === 0))
				.map((buffer) => buffer.length);
			expect(wipedLengths).toEqual(expect.arrayContaining([8, 20, 20]));
		} finally {
			fill.mockRestore();
		}
	});
});
