import { beforeEach, describe, expect, it } from 'vitest';
import { clearRegisteredSecrets, mask, registerSecret, scrub } from '../src/redact';
import { parseMaFile } from '../src/mafile';
import { join } from 'node:path';

describe('redaction wrapper (§11 S4)', () => {
	beforeEach(() => {
		clearRegisteredSecrets();
	});

	it('scrubs a registered secret wherever it appears', () => {
		registerSecret('KrbnbF2lShuAa/mL6vPz1rs1ncY=');
		const text = 'request failed for secret=KrbnbF2lShuAa/mL6vPz1rs1ncY= at step 3';
		expect(scrub(text)).toBe('request failed for secret=[REDACTED] at step 3');
	});

	it('scrubs every occurrence, not just the first', () => {
		registerSecret('supersecretvalue');
		expect(scrub('supersecretvalue and supersecretvalue')).toBe('[REDACTED] and [REDACTED]');
	});

	it('ignores values too short to be secrets, so output is not corrupted', () => {
		registerSecret('abc');
		expect(scrub('abc is a normal word fragment in abcdef')).toContain('abc');
	});

	it('masks without revealing enough to be useful', () => {
		const masked = mask('KrbnbF2lShuAa/mL6vPz1rs1ncY=');
		expect(masked.startsWith('Krbnb')).toBe(true);
		expect(masked).not.toContain('6vPz1rs1ncY=');
	});

	it('scrubs a forced short secret, which the default threshold would let through', () => {
		// Classic revocation codes are `R#####` — six characters, below the
		// default floor. It is also the one secret whose loss is unrecoverable.
		// Synthetic. Never use a real revocation code as test data — a test file is
		// committed, and this value cannot be rotated without removing the account's
		// authenticator entirely.
		registerSecret('R99999');
		expect(scrub('code R99999')).toBe('code R99999');

		registerSecret('R99999', { force: true });
		expect(scrub('code R99999')).toBe('code [REDACTED]');
	});

	it('still refuses to register something too short to scrub safely', () => {
		registerSecret('ab', { force: true });
		expect(scrub('ab normal text ab')).toBe('ab normal text ab');
	});

	it('registers the revocation code from a parsed maFile', () => {
		parseMaFile(join(__dirname, '..', 'fixtures', 'classic-sda.maFile'));
		expect(scrub('revocation R12345')).toBe('revocation [REDACTED]');
	});

	it('registers maFile secrets automatically at parse time', () => {
		parseMaFile(join(__dirname, '..', 'fixtures', 'classic-sda.maFile'));
		// Nothing had to opt in: parsing alone makes these unprintable.
		expect(scrub('shared=KrbnbF2lShuAa/mL6vPz1rs1ncY=')).toBe('shared=[REDACTED]');
		expect(scrub('identity=7TslCCxb+eOdtAzs4bMFAN5g+9Q=')).toBe('identity=[REDACTED]');
	});
});
