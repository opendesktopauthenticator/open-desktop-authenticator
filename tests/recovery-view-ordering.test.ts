import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enrollmentMayBeClearedAsNotAttached, recoveryExitView } from '../src/shared/recovery-view';

describe('coexisting durable Steam workflow recovery', () => {
	it('never offers a safe retry when this process knows Steam attached the authenticator', () => {
		expect(
			enrollmentMayBeClearedAsNotAttached({ state: 'sending', stored: false, certain: true })
		).toBe(false);
		expect(
			enrollmentMayBeClearedAsNotAttached({ state: 'sending', stored: false, certain: false })
		).toBe(true);
		expect(enrollmentMayBeClearedAsNotAttached({ state: 'recoverable', stored: false })).toBe(
			false
		);
	});
	it('drains a queued transfer after enrollment instead of returning to accounts', () => {
		expect(recoveryExitView('move')).toBe('move');
		expect(recoveryExitView(undefined)).toBe('accounts');
	});

	it('uses the same queue-draining exit for enrollment and its revocation backup', () => {
		const source = readFileSync(
			join(__dirname, '..', 'src', 'renderer', 'App.tsx'),
			'utf8'
		).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
		const calls = source.match(/leaveEnrollmentRecovery\(\)/g) ?? [];
		// RevocationBackup.onClose + AddAuthenticator.onClose.
		expect(calls).toHaveLength(2);
	});

	it('never promises restart recovery for a reply held only in memory', () => {
		const source = readFileSync(
			join(__dirname, '..', 'src', 'renderer', 'screens', 'AddAuthenticator.tsx'),
			'utf8'
		).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
		expect(source).toMatch(
			/durable \? \([\s\S]*survives a restart[\s\S]*\) : \([\s\S]*held only by this running app[\s\S]*Do not quit or restart/
		);
	});
});
