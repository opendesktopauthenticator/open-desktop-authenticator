import { describe, expect, it } from 'vitest';
import {
	canCreateVault,
	MIN_PASSPHRASE_LENGTH,
	passphraseProblem,
	passphraseStrength,
	STRENGTH_ADVICE
} from '../src/shared/passphrase-policy';

const GOOD = 'several unrelated words here';

describe('the no-recovery ceremony gate', () => {
	it('allows creation when everything is satisfied', () => {
		expect(canCreateVault({ passphrase: GOOD, confirmation: GOOD, acknowledged: true })).toBe(true);
	});

	it('refuses until the acknowledgement is ticked', () => {
		// The ceremony is the point. Someone who has not read it must not be able to
		// create a vault they cannot open.
		expect(canCreateVault({ passphrase: GOOD, confirmation: GOOD, acknowledged: false })).toBe(
			false
		);
	});

	it('refuses a mismatched confirmation', () => {
		// A typo in a secret with no recovery path is unrecoverable, which is the
		// entire reason for asking twice.
		expect(canCreateVault({ passphrase: GOOD, confirmation: `${GOOD} `, acknowledged: true })).toBe(
			false
		);
	});

	it('refuses a too-short passphrase even when confirmed and acknowledged', () => {
		const short = 'a'.repeat(MIN_PASSPHRASE_LENGTH - 1);
		expect(canCreateVault({ passphrase: short, confirmation: short, acknowledged: true })).toBe(
			false
		);
	});

	it('refuses two empty fields, which technically match', () => {
		expect(canCreateVault({ passphrase: '', confirmation: '', acknowledged: true })).toBe(false);
	});

	it('is case and whitespace sensitive', () => {
		expect(
			canCreateVault({ passphrase: GOOD, confirmation: GOOD.toUpperCase(), acknowledged: true })
		).toBe(false);
		expect(canCreateVault({ passphrase: ` ${GOOD}`, confirmation: GOOD, acknowledged: true })).toBe(
			false
		);
	});
});

describe('policy', () => {
	it('states there is no recovery when rejecting', () => {
		expect(passphraseProblem('short')).toContain('no way to recover');
	});

	it('imposes no composition rules', () => {
		// Requiring a digit and a symbol pushes people toward `Passw0rd!` and away
		// from long passphrases — the wrong direction with no recovery path.
		expect(passphraseProblem('all lowercase words no digits')).toBeUndefined();
	});

	it('refuses a passphrase that is only whitespace', () => {
		// Twelve spaces satisfied the length rule and created a vault whose
		// passphrase is invisible, unmemorable and permanently unrecoverable.
		expect(passphraseProblem('            ')).toMatch(/whitespace/);
		expect(passphraseProblem('\t\t\t\t\t\t\t\t\t\t\t\t')).toMatch(/whitespace/);
	});

	it('still allows real passphrases containing spaces', () => {
		// Not a composition rule. Spaces are what a passphrase of several words is
		// made of, and padding is the user's business.
		expect(passphraseProblem('correct horse battery staple')).toBeUndefined();
		expect(passphraseProblem('  padded but real  ')).toBeUndefined();
	});

	it('blocks vault creation on a whitespace passphrase', () => {
		expect(
			canCreateVault({
				passphrase: '            ',
				confirmation: '            ',
				acknowledged: true
			})
		).toBe(false);
	});
});

describe('strength feedback is honest', () => {
	it('never flatters a short complex passphrase', () => {
		// Exactly 12 characters, so it passes the minimum — but a conventional
		// meter would rate it "Strong" for having upper, lower, digit and symbol.
		// Character classes are not guessability. It gets the weakest passing band
		// and is told to use more words.
		expect('Password123!').toHaveLength(MIN_PASSPHRASE_LENGTH);
		expect(passphraseStrength('Password123!')).toBe('short');
		expect(STRENGTH_ADVICE[passphraseStrength('Password123!')]).toContain('words');
	});

	it('rates a long simple passphrase above a short complex one', () => {
		// The whole point of refusing composition rules: length wins.
		expect(passphraseStrength('correct horse battery staple')).toBe('good');
	});

	it('rates by length band and advises more words', () => {
		expect(passphraseStrength('a'.repeat(MIN_PASSPHRASE_LENGTH - 1))).toBe('tooShort');
		expect(passphraseStrength('a'.repeat(12))).toBe('short');
		expect(passphraseStrength('a'.repeat(16))).toBe('reasonable');
		expect(passphraseStrength('a'.repeat(24))).toBe('good');
		expect(STRENGTH_ADVICE.short).toContain('words');
	});

	it('has advice for every band', () => {
		for (const band of ['tooShort', 'short', 'reasonable', 'good'] as const) {
			expect(STRENGTH_ADVICE[band]).toBeTruthy();
		}
	});
});
