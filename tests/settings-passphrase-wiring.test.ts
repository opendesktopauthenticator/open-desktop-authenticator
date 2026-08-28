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
		// Every path that increments must decrement, or the screen locks itself out
		// of ever refreshing. Balance is the invariant, not a particular count —
		// the post-sign-in reload legitimately added a third pair.
		const ups = screen.match(/listing\.current \+= 1;/g) ?? [];
		const downs = screen.match(/listing\.current -= 1;/g) ?? [];
		expect(ups.length).toBeGreaterThanOrEqual(2);
		expect(downs).toHaveLength(ups.length);
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

describe('forms on one screen that each end in a key derivation', () => {
	const restore = readFileSync(
		join(__dirname, '../src/renderer/screens/BackupRestore.tsx'),
		'utf8'
	);

	it('let the restore form know the screen is already busy', () => {
		// `onBusy` only reported outwards. Create and restore sit together on the
		// screen that warns not to create before restoring — and nothing stopped
		// opening the restore form while "Creating…" was on screen. A winning
		// create leaves an empty vault whose next save copies itself over the very
		// backup the other form exists to read.
		expect(restore).toMatch(/siblingBusy\?: boolean;/);
		expect(restore).toMatch(/if \(!passphrase \|\| busy \|\| siblingBusy\)/);
		// Including the opener, which is what actually admits the second flow.
		expect(restore).toMatch(/onClick=\{\(\) => setOpen\(true\)\}\s*\n\s*disabled=\{siblingBusy\}/);
	});

	it('is wired from both screens that mount it', () => {
		for (const screen of ['CreateVault', 'UnlockVault']) {
			const source = readFileSync(join(__dirname, `../src/renderer/screens/${screen}.tsx`), 'utf8');
			expect([screen, /onBusy=\{setBusy\}/.test(source)]).toEqual([screen, true]);
			expect([screen, /siblingBusy=\{busy\}/.test(source)]).toEqual([screen, true]);
		}
	});
});

describe('the update-check toggle', () => {
	it('freezes while a save is in flight, like the fields beside it', () => {
		const source = readFileSync(join(__dirname, '../src/renderer/screens/Settings.tsx'), 'utf8');
		// The number inputs were frozen and this was not, so unchecking during
		// "Saving…" changed the screen without changing the request — and the
		// success handler then wrote "Saved." beside a value never sent.
		expect(source).toMatch(
			/checked=\{checked\}\s*\n\s*disabled=\{disabled\}\s*\n\s*onChange=\{\(event\) => onChange/
		);
		expect(source).toMatch(/<UpdateCheckSetting[\s\S]*?disabled=\{busy\}/);
	});
});

describe('per-account status on the account list', () => {
	it('is only written by the newest attempt', () => {
		const source = readFileSync(join(__dirname, '../src/renderer/screens/VaultHome.tsx'), 'utf8');
		// One status slot for the whole list: the first copy after an unlock waits
		// on the Steam clock sync, and another row's button stays live meanwhile,
		// so an older failure could overwrite a newer success.
		expect(source).toMatch(/const attempt = useRef\(0\);/);
		expect(source.match(/const mine = \(attempt\.current \+= 1\);/g) ?? []).toHaveLength(2);

		/*
		 * The browser counts separately, and that is deliberate rather than an
		 * oversight this test should have caught.
		 *
		 * `attempt` is shared by copy and export because they share one status
		 * slot. The browser has its own slot, so sharing the counter would make
		 * opening a browser silence an export result that is still on screen and
		 * still true.
		 */
		expect(source).toMatch(/const browserAttempt = useRef\(0\);/);
		expect(source.match(/const mine = \(browserAttempt\.current \+= 1\);/g) ?? []).toHaveLength(2);

		// Every asynchronous writer to a shared slot, guarded: two for copy, two
		// for export, and one each for the proxied and the direct browser button —
		// neither has a success message to write, only a failure.
		expect(source.match(/if \(!newest\(\)\) \{/g) ?? []).toHaveLength(6);
	});
});

describe('the recovery screen', () => {
	it('does not name a passphrase that activation may have replaced', () => {
		const screen = readFileSync(
			join(__dirname, '../src/renderer/screens/RecoverAccount.tsx'),
			'utf8'
		);
		const service = readFileSync(join(__dirname, '../src/main/vault/recovery.ts'), 'utf8');
		// Activation rewrites the file through `updateRecovery`, resealing it with
		// whatever key the vault holds then — so "the passphrase when the account
		// was created" was false in exactly the case where somebody is reading it,
		// and following it would suggest the only backup was dead.
		expect(screen).not.toMatch(/when the account was created/);
		expect(screen).not.toMatch(/sealed once and never rewritten/);
		expect(screen).toMatch(/when this file was last written/);
		expect(service).not.toMatch(/when \*\*the account was created\*\*/);
		expect(service).toMatch(/when the file was last written/);
	});
});

describe('promise chains in the renderer', () => {
	it('never fire-and-forget a `.finally` without a `.catch`', () => {
		// `.finally` re-throws, so `void work().finally(...)` is an unhandled
		// rejection wearing the look of deliberate fire-and-forget — and on a
		// screen the user is actively using, the failure it swallows is one they
		// needed to see. Caught once already, in the reload that runs after a
		// successful Steam sign-in.
		for (const file of [
			'App.tsx',
			'screens/Confirmations.tsx',
			'screens/VaultHome.tsx',
			'screens/Settings.tsx',
			'screens/MoveAuthenticator.tsx',
			'screens/AddAuthenticator.tsx',
			'screens/Activity.tsx'
		]) {
			const source = readFileSync(join(__dirname, '../src/renderer', file), 'utf8');
			const bare = /void\s+\w+\([^)]*\)\s*\n?\s*\.finally\(/.test(source);
			expect([file, bare]).toEqual([file, false]);
		}
	});

	it('keeps the confirmations listing counter balanced', () => {
		const source = readFileSync(
			join(__dirname, '../src/renderer/screens/Confirmations.tsx'),
			'utf8'
		);
		const ups = (source.match(/listing\.current \+= 1;/g) ?? []).length;
		const downs = (source.match(/listing\.current -= 1;/g) ?? []).length;
		expect(downs).toBe(ups);
	});
});
