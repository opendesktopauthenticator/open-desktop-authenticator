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

describe('screens that must not keep a credential after a throw', () => {
	it('clears the Steam password on the rejection path too', () => {
		const source = readFileSync(join(__dirname, '../src/renderer/screens/SteamSignIn.tsx'), 'utf8');
		// The comment says "whatever the outcome"; a throw — IPC failure, schema
		// refusal, dead transport — is an outcome, and only `.then` cleared.
		const rejection = source.slice(source.indexOf('.catch('));
		expect(rejection).toMatch(/setPassword\(''\)/);
	});

	it('clears the enrollment password and proxy however onBegin settles', () => {
		const source = readFileSync(
			join(__dirname, '../src/renderer/screens/AddAuthenticator.tsx'),
			'utf8'
		);
		expect(source).toMatch(
			/\.finally\(\(\) => \{\s*setPassword\(''\);\s*setProxyUrl\(''\);\s*\}\)/
		);
	});
});

describe('lists that must not be overwritten by a stale answer', () => {
	it('gives refresh a generation the poll and dialog closes both respect', () => {
		const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
		// The poll skips a tick while its own is in flight, but dialog closes call
		// refresh directly — and both wrote setAccounts, so the older answer could
		// land last: imported accounts vanished, removed ones came back.
		expect(app).toMatch(/const refreshSeq = useRef\(0\)/);
		expect(app).toMatch(/const mine = \(refreshSeq\.current \+= 1\)/);
		expect(app).toMatch(/if \(!newest\(\)\) \{\s*return;\s*\}\s*setAccounts\(listed\)/);
	});

	it('cannot start a second list beside its first fetch', () => {
		const screen = readFileSync(
			join(__dirname, '../src/renderer/screens/Confirmations.tsx'),
			'utf8'
		);
		// Refresh was enabled while the mount fetch was still running, so the two
		// raced and the last writer won — a slow first list could hide a recovery
		// confirmation Refresh had already shown. `busy` starts true so the button
		// is disabled for the mount fetch; the ref is what `refresh` tests, so the
		// guard survives a re-fetch when the account changes.
		expect(screen).toMatch(/const \[busy, setBusy\] = useState\(true\);/);
		// **A count, not a boolean.** StrictMode runs the mount effect twice, so a
		// boolean was cleared by whichever fetch settled first — unlocking the
		// guard while the second was still in the air, which is the race itself.
		expect(screen).toMatch(/const listing = useRef\(1\);/);
		expect(screen).toMatch(/if \(busy \|\| listing\.current > 0\) \{/);
		// Every path that increments must decrement, or the screen locks itself out.
		const ups = screen.match(/listing\.current \+= 1;/g) ?? [];
		const downs = screen.match(/listing\.current -= 1;/g) ?? [];
		expect(ups).toHaveLength(2);
		expect(downs).toHaveLength(2);
	});
});

describe('the create screen and an in-flight restore', () => {
	it('shares one busy flag across both forms', () => {
		const screen = readFileSync(join(__dirname, '../src/renderer/screens/CreateVault.tsx'), 'utf8');
		// Both forms end in a deliberate second of scrypt. With separate flags the
		// user could submit the restore and then press Create, and whichever KDF
		// finished first won — create winning installs an empty vault whose next
		// save copies over the .bak the restore was reading.
		expect(screen).toMatch(/onBusy=\{setBusy\}/);
	});
});

describe('the portable build', () => {
	it('does not write the Windows identity keys', () => {
		const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');
		// "No installer, no writes outside its own directory" is the whole point
		// of that target; this writes two values under HKCU, one of them a path
		// pointing back at the copy the user was only trying out.
		expect(main).toMatch(/if \(portableDir === undefined\) \{\s*void registerWindowsIdentity\(/);
	});
});

describe('navigation that would abandon an irreversible operation', () => {
	it('disables "Move it here instead" while enrollment is in flight', () => {
		const screen = readFileSync(
			join(__dirname, '../src/renderer/screens/AddAuthenticator.tsx'),
			'utf8'
		);
		// Submit was guarded by `busy` and this was not, so pressing it during
		// `onBegin` only changed the view: the component unmounted, main carried
		// on, and Steam could attach an authenticator whose revocation-code
		// ceremony had no screen left to run on.
		expect(screen).toMatch(/className="link" onClick=\{onMove\} disabled=\{busy\}/);
	});
});

describe('the transfer sign-in form', () => {
	it('clears the password, Guard code and proxy however the attempt settles', () => {
		const screen = readFileSync(
			join(__dirname, '../src/renderer/screens/MoveAuthenticator.tsx'),
			'utf8'
		);
		// The password is single-use, the Guard code is one-time and already spent
		// by the attempt, and the proxy URL routinely carries credentials of its
		// own — yet all three survived a rejection and sat in state and the DOM.
		const submit = screen.slice(
			screen.indexOf('const submit = async'),
			screen.indexOf('const requestCode')
		);
		const settle = submit.slice(submit.indexOf('} finally {'));
		expect(settle).toMatch(/setPassword\(''\)/);
		expect(settle).toMatch(/setCode\(''\)/);
		expect(settle).toMatch(/setProxyUrl\(''\)/);
	});
});

describe('the activity badge', () => {
	it('follows what the acknowledgement reports, not an assumption', () => {
		const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
		// An urgent entry recorded between the snapshot and the acknowledgement is
		// outside the watermark on purpose, so main keeps it urgent — and clearing
		// the badge unconditionally hid a fresh account-recovery warning until
		// some later poll happened to restore it.
		expect(app).toMatch(/\.then\(\(result\) => setActivityUrgent\(result\.urgent\)\)/);
		expect(app).not.toMatch(/setActivityUrgent\(false\)\)/);
	});
});
