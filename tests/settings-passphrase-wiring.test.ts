import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The passphrase-change form is actually reachable.
 *
 * The rendering of the form itself is proven in settings-passphrase.test.tsx;
 * these assert the two joints that made the whole feature unreachable before:
 * the Settings screen mounting the form, and the app handing it the preload
 * bridge. Either one missing and the operation exists everywhere except where
 * a user could find it.
 */
describe('the passphrase-change wiring', () => {
	it('is mounted by the Settings screen', () => {
		const source = readFileSync(join(__dirname, '../src/renderer/screens/Settings.tsx'), 'utf8');
		expect(source).toMatch(
			/<PassphraseChange onChange=\{onChangePassphrase\} onBusy=\{setRotating\} \/>/
		);
	});

	it('is handed the real bridge by the app', () => {
		const source = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
		expect(source).toMatch(
			/onChangePassphrase=\{\(current, next\) => api\.changePassphrase\(current, next\)\}/
		);
	});
});

describe('the rotation window', () => {
	const settingsSource = readFileSync(
		join(__dirname, '../src/renderer/screens/Settings.tsx'),
		'utf8'
	);

	it('freezes the three passphrase fields while scrypt runs', () => {
		// Editable fields under a pending rotation meant the value on screen was
		// not the one being installed: submit A, retype B, watch "changed" clear
		// the field — then fail to unlock with the passphrase last seen.
		const masked = settingsSource.match(/type="password"\n\t{4}disabled=\{busy\}/g) ?? [];
		expect(masked).toHaveLength(3);
	});

	it('holds Back until the rotation settles', () => {
		expect(settingsSource).toMatch(/disabled=\{busy \|\| rotating\}/);
		expect(settingsSource).toMatch(/onBusy=\{setRotating\}/);
	});

	it('freezes the settings inputs while a save is in flight', () => {
		// Editing during a pending save showed the edited value beside "Saved."
		// for a value the backend never received.
		expect(settingsSource).toMatch(/id="auto-lock"\n\t{6}type="number"\n\t{6}disabled=\{busy\}/);
		expect(settingsSource).toMatch(
			/id="clipboard-clear"\n\t{6}type="number"\n\t{6}disabled=\{busy\}/
		);
	});
});

describe('per-account busy flags', () => {
	it('clear only their own account', () => {
		const home = readFileSync(join(__dirname, '../src/renderer/screens/VaultHome.tsx'), 'utf8');
		// An unconditional `setCopying(undefined)` in a `finally` re-enabled every
		// account's button, including one whose own copy was still in flight.
		expect(home).toMatch(
			/setCopying\(\(prev\) => \(prev === account\.steamId64 \? undefined : prev\)\)/
		);
		expect(home).toMatch(
			/setExporting\(\(prev\) => \(prev === account\.steamId64 \? undefined : prev\)\)/
		);
		expect(home).not.toMatch(/setCopying\(undefined\)\)/);
	});
});

describe('the create screen and an open session', () => {
	it('is only offered when the session is locked as well as fileless', () => {
		const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
		// A vault file vanishing under an open session must keep the unlocked UI —
		// its next save rewrites the file from memory — not offer to create an
		// empty vault over the accounts the session still holds.
		expect(app).toMatch(/if \(!status\.exists && !status\.unlocked\)/);
	});
});
