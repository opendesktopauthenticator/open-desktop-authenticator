import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branding } from '../src/shared/branding';

/**
 * Where the vault lives, and why it must not move.
 *
 * `app.getPath('userData')` is derived from `app.getName()`, and `getName()`
 * prefers package.json's `productName` over its `name`. This project has no
 * `productName` field, so the packaged application resolved its data directory
 * to `open-desktop-authenticator` — which is correct today and one tidy-up away
 * from being wrong.
 *
 * Adding `productName` is exactly what a packaging guide tells you to do, and
 * `electron-builder` already sets it in its own config, so the two look like
 * they should match. If that field ever lands in package.json the userData path
 * changes underneath every existing installation: the app opens a new, empty
 * directory, finds no vault, and presents a first-run screen to somebody whose
 * accounts are still sitting on disk a few folders away. The likely next step
 * for that person is burning a revocation code to recover an authenticator that
 * was never actually lost.
 *
 * `src/main/index.ts` therefore pins the path explicitly before anything reads
 * it. These tests fail if the pin is removed, if the value drifts, or if a
 * `productName` field appears and quietly reintroduces the ambiguity.
 */

const root = join(__dirname, '..');
const mainSource = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
	string,
	unknown
>;

describe('the vault directory is pinned, not inherited', () => {
	it('is set explicitly before any path is read', () => {
		expect(mainSource).toMatch(/app\.setPath\(\s*'userData'/);
	});

	it('is pinned from branding rather than a literal', () => {
		// A hard-coded string here and a value in branding is two places to
		// disagree, which is how the path drifts in the first place. Asserted on
		// the pieces rather than on one exact expression: the call now chooses
		// between two roots, and pinning its formatting made this fail for a change
		// that kept every invariant it exists to protect.
		const call = mainSource.slice(
			mainSource.search(/app\.setPath\(\s*'userData'/),
			mainSource.indexOf('hardenApp()')
		);
		expect(call).toContain('branding.dataDirectory');
		expect(call).toContain("app.getPath('appData')");
		expect(call).not.toMatch(/'userData',\s*'[^']+'/);
	});

	it('keeps a portable build out of AppData entirely', () => {
		// The portable target promises "no writes outside its own directory", which
		// is the whole reason to run it from a stick on a machine you do not own.
		// It wrote the vault to %APPDATA% like every other build, leaving encrypted
		// account data on the host and sharing it with any installed copy.
		//
		// electron-builder sets this variable for that target and nothing else, so
		// it is the only signal available — the binary is otherwise identical.
		const call = mainSource.slice(
			mainSource.search(/app\.setPath\(\s*'userData'/),
			mainSource.indexOf('hardenApp()')
		);
		expect(mainSource).toContain('PORTABLE_EXECUTABLE_DIR');
		expect(call).toContain('portableDir');
	});

	it('is pinned before the single-instance lock, which also derives from it', () => {
		const pin = mainSource.search(/app\.setPath\(\s*'userData'/);
		const lock = mainSource.indexOf('hardenApp()');
		expect(pin).toBeGreaterThan(-1);
		expect(lock).toBeGreaterThan(-1);
		expect(pin, 'the path must be fixed before anything consumes it').toBeLessThan(lock);
	});

	it('still holds the value every shipped build has used', () => {
		// Changing this string is a migration, not an edit. It is asserted
		// literally so that altering it cannot pass as a rename.
		expect(branding.dataDirectory).toBe('open-desktop-authenticator');
	});

	it('has no productName in package.json to compete with it', () => {
		// Not because productName is forbidden — electron-builder sets its own —
		// but because one in *package.json* changes app.getName() and so changes
		// the default the pin exists to override. If this ever needs to be added,
		// the pin above is what keeps it harmless, and this test is the place to
		// record that decision.
		expect(
			manifest.productName,
			'adding productName moves the default userData path; the pin must be verified first'
		).toBeUndefined();
	});
});
