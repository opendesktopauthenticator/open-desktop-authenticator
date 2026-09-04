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
	/*
	 * **This test used to pin the bug in place.**
	 *
	 * It asserted the exact text of a `finally` that cleared only its own
	 * account — which was correct, and was the *finishing* half. The starting
	 * half wrote a single account name, so beginning a second copy re-enabled the
	 * first row's button while its request was still in flight. Two accounts
	 * never appeared in the assertion, so it could not have noticed.
	 *
	 * The behaviour now lives in `vault-home-busy.test.tsx`, which runs the
	 * updaters with two accounts instead of reading them. What is left here is
	 * the one thing source text is good for: that the state is a set, so a
	 * regression to a single name is visible.
	 */
	it('are a set, not one account at a time', () => {
		const home = readFileSync(join(__dirname, '../src/renderer/screens/VaultHome.tsx'), 'utf8');
		const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
		expect(home).toMatch(/const \[copying, setCopying\] = useState<ReadonlySet<string>>/);
		expect(app).toMatch(
			/const \[exportingAccountIds, setExportingAccountIds\] = useState<ReadonlySet<string>>/
		);
		expect(app).toMatch(/const exportingAccounts = useRef\(new Set<string>\(\)\)/);
		expect(home).toMatch(/exporting\?: ReadonlySet<string>/);
		// The single-name shape, in either direction.
		expect(home).not.toMatch(/setCopying\(account\.steamId64\)/);
		expect(app).not.toMatch(/setExportingAccountIds\(account\.steamId64\)/);
		expect(home).not.toMatch(/copying === account\.steamId64/);
		expect(home).not.toMatch(/exporting === account\.steamId64/);
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
		// The portable target keeps application data beside the executable and does
		// not install itself; this writes two values under HKCU, one of them a path
		// pointing back at the copy the user was only trying out. Windows Temp
		// runtime extraction is unrelated to this persistent identity record.
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
		const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
		/*
		 * **One counter per status slot, and there are three slots.**
		 *
		 * The first copy after an unlock waits on the Steam clock sync, and another
		 * row's button stays live meanwhile, so an older failure could overwrite a
		 * newer success — hence the counters at all.
		 *
		 * This test used to assert the opposite of what it should: that copy and
		 * export *shared* one, with a comment explaining that the browser's was
		 * separate because it writes a separate slot. Copy and export write
		 * separate slots too. Sharing meant starting an export silenced a copy that
		 * then succeeded, leaving a live Steam Guard code on the clipboard with a
		 * running timer and nothing on screen saying so — and the reverse silenced
		 * a save that had already written a file holding the keys to an account.
		 * The test did not miss that; it wrote it down as intended.
		 */
		expect(source).toMatch(/const copyAttempt = useRef\(0\);/);
		expect(app).toMatch(/const exportAttempt = useRef\(new Map<string, number>\(\)\);/);

		// One writer for copy and one for the browser — whose three buttons share
		// a helper rather than repeating the claim. Export is now owned by App so a
		// navigation cannot unmount its attempt or its eventual result.
		expect(source.match(/const mine = \(copyAttempt\.current \+= 1\);/g) ?? []).toHaveLength(1);
		// Export's counter is a map too, for the same reason the browser's is: its
		// result carries the warning that a plaintext copy is still on disk, and a
		// second account's export used to discard it as stale.
		expect(
			app.match(
				/const mine = \(exportAttempt\.current\.get\(account\.steamId64\) \?\? 0\) \+ 1;/g
			) ?? []
		).toHaveLength(1);
		expect(app).toMatch(
			/const current = \(\): boolean => exportAttempt\.current\.get\(account\.steamId64\) === mine;/
		);
		expect(app).not.toMatch(/exportAttempt\.current \+= 1/);
		/*
		 * The browser's counter is a **map**, not a number. A single number made
		 * account B's press "newer" than account A's, so A's failure was discarded
		 * as stale — with A's browser unopened and nothing on screen saying why.
		 * `browserError` is rendered on the row it belongs to, so the two never
		 * competed for anything in the first place.
		 */
		expect(source).toMatch(/const browserAttempt = useRef\(new Map<string, number>\(\)\)/);
		expect(source).not.toMatch(/browserAttempt\.current \+= 1/);
		/*
		 * **One claim, shared by all three buttons.**
		 *
		 * This asserted a claim per button while there were two, which is the
		 * weaker property: it counted copies rather than requiring that every
		 * button have one. A third button added without its own claim would have
		 * satisfied a count of two and opened without ever claiming — its failure
		 * then discarded as stale, or worse, shown on top of a different route's.
		 * A single helper cannot be forgotten by a button that calls it.
		 */
		expect(source.match(/const newest = claimBrowser\(account\.steamId64\);/g) ?? []).toHaveLength(
			1
		);
		expect(source).toMatch(
			/const openBrowserAs = \(account: AccountSummary, route: BrowserRoute\)/
		);
		// Every button goes through it, and none of them calls `onOpenBrowser`
		// directly — which is what would skip the claim.
		expect(source.match(/openBrowserAs\(account, /g) ?? []).toHaveLength(3);
		expect(source.match(/[^s]onOpenBrowser\(account, /g) ?? []).toHaveLength(1);

		/*
		 * **And each button sends the route its own label promises.**
		 *
		 * Counting the calls was the whole check here, and counting is exactly
		 * what a wrong route survives: three buttons, three calls, two of them
		 * routing the same way. The Steam-only button would have opened a fully
		 * proxied window — the mode the user pressed it to get away from — while
		 * every other test in the suite stayed green. So the label, the tooltip
		 * and the route are asserted as one string rather than three facts that
		 * happen to be true separately.
		 */
		expect(source).toMatch(
			/onClick=\{\(\) => openBrowserAs\(account, 'steam-only'\)\}\s*>\s*Steam only\s*</
		);
		expect(source).toMatch(
			/onClick=\{\(\) => openBrowserAs\(account, 'direct'\)\}\s*>\s*Direct\s*</
		);
		// The first button is the only one that reads the account: an unrouted
		// account has no proxy to send anything through.
		expect(source).toMatch(/openBrowserAs\(account, account\.hasProxy \? 'proxy' : 'direct'\)/);

		/*
		 * And the failure itself is per account. One object served the whole list,
		 * so two accounts failing meant the second overwrote the first — the
		 * message is rendered on its own row, so they were never competing.
		 */
		expect(source).toMatch(
			/const \[browserError, setBrowserError\] = useState<ReadonlyMap<string, string>>/
		);
		expect(source).not.toMatch(/browserError\?\.steamId64 === account\.steamId64/);

		/*
		 * Export results are app-owned and append-only until their own Dismiss is
		 * pressed. This both keeps the plaintext warning per attempt and lets it
		 * survive the account list being unmounted by any navigation.
		 */
		expect(app).toMatch(
			/const \[exportNotices, updateExportNotices\] = useReducer\(exportNoticeReducer, \[\]\)/
		);
		expect(app).toMatch(/return \[\.\.\.state, action\.notice\];/);
		expect(source).not.toMatch(/setExported|setExportError/);

		// No counter is read by anything but the attempt that owns it: a bare
		// `attempt` would be the shared one coming back.
		expect(source).not.toMatch(/[^a-zA-Z]attempt\.current/);

		// Every asynchronous row-local writer is guarded: two for copy and one for
		// the browser. Export's resolve/reject pair is behavior-tested through its
		// shared `current()` gate in export-navigation-survival.test.tsx.
		expect(source.match(/if \(!newest\(\)\) \{/g) ?? []).toHaveLength(3);
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

/**
 * **The switch for `Require proxies`, on the screen that owns it.**
 *
 * The setting existed in the vault schema, with a docblock describing what it
 * would do, and no screen offered it and no code read it. A user could not turn
 * it on, and a vault that already had it on was not obeyed.
 */
describe('the Require proxies control', () => {
	const source = readFileSync(join(__dirname, '../src/renderer/screens/Settings.tsx'), 'utf8');

	it('is on the settings form', () => {
		expect(source).toMatch(/Require proxies/);
		expect(source).toMatch(/checked=\{settings\.requireProxies\}/);
	});

	it('saves through the same path as every other setting', () => {
		// `change({ requireProxies })` rather than a write of its own: the form
		// posts the whole view, and a field that saved by another route would be
		// dropped by the next save of any other field.
		expect(source).toMatch(/change\(\{ requireProxies: event\.target\.checked \}\)/);
	});

	/*
	 * Both consequences, next to the switch. Each one is otherwise met as an
	 * unexplained failure — a Trade button that refuses, and update checks that
	 * silently stop.
	 */
	it('says what it costs', () => {
		expect(source).toMatch(/Direct button goes\s+away/);
		expect(source).toMatch(/Update checks stop/i);
	});
});

/**
 * **Cancelling the restore form left the passphrase in it.**
 *
 * `BackupRestore` stays mounted on the Create and Unlock screens — closing the
 * form only hides it — so the controlled value survived, and reopening
 * presented the previous secret already typed in. Success and failure both
 * clear it; abandoning was the third way out and was the one that did not.
 */
describe('the backup restore form', () => {
	const source = readFileSync(join(__dirname, '../src/renderer/screens/BackupRestore.tsx'), 'utf8');

	it('clears the passphrase when the form is cancelled', () => {
		// The handler attached to the button labelled Cancel: everything from the
		// last `onClick` before that label up to the label itself.
		// `lastIndexOf`: the handler's own comment mentions Cancel, and it sits
		// before the label, so the first match cuts the region in half.
		const label = source.lastIndexOf('Cancel');
		const cancel = source.slice(source.lastIndexOf('onClick', label), label);
		expect(cancel, 'Cancel closed the form and kept the secret').toMatch(/setPassphrase\(''\)/);
	});

	/*
	 * All three exits, so a fourth added later is measured against a rule rather
	 * than against whichever two happened to be right.
	 */
	it('clears it on every way out of the form', () => {
		expect(source.match(/setPassphrase\(''\)/g) ?? []).toHaveLength(3);
	});
});

/**
 * **A form that says "optional" for a field the main process requires.**
 *
 * Under `Require proxies` an enrolment or a transfer with an empty proxy is
 * refused before any credential is sent — correctly. Both screens still called
 * the field optional and offered a submit, so the user was invited into an
 * action that could only fail.
 *
 * Asserted on the source rather than the markup: an unfilled form disables its
 * submit anyway — the account name and password are empty too — so the rendered
 * attribute is the same either way and cannot tell the two apart. What
 * distinguishes them is the condition, and that is what regresses. The label
 * itself is checked by rendering, in `browser-button.test.tsx`.
 */
describe('the enrolment and transfer forms under Require proxies', () => {
	it('gates the enrolment submit on the proxy field', () => {
		const source = readFileSync(
			join(__dirname, '../src/renderer/screens/AddAuthenticator.tsx'),
			'utf8'
		);
		expect(source).toMatch(/requireProxies && proxyUrl\.trim\(\) === ''/);
		expect(source).toMatch(/through a proxy \(required\)/);
	});

	it('gates the transfer submit the same way', () => {
		const source = readFileSync(
			join(__dirname, '../src/renderer/screens/MoveAuthenticator.tsx'),
			'utf8'
		);
		expect(source).toMatch(/requireProxies && proxyUrl\.trim\(\) === ''/);
		expect(source, 'the transfer form still calls a required field optional').toMatch(
			/through a proxy \(required\)/
		);
	});
});

/**
 * **The update check has to restart when the settings that stop it change.**
 *
 * The effect depended on the unlocked state alone, so the two switches that
 * stop a check could not start one again: turning update checks back on, or
 * turning `Require proxies` off, left the app waiting for the next unlock to
 * discover there was a release.
 */
describe('when the app asks about updates', () => {
	const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');

	it('re-asks on every save, through a revision rather than the values', () => {
		expect(app).toMatch(/\}, \[api, status\?\.unlocked, settingsRevision\]\);/);
	});

	/**
	 * **And deliberately not on the values themselves.**
	 *
	 * Watching `status.requireProxies` and `status.updateCheck` looked equivalent
	 * and is not. Turn `Require proxies` on and straight off again between two
	 * status polls and both come back to what they already were: React sees no
	 * dependency change, no newer check starts, and the answer from the check the
	 * first save aborted is still the newest anybody claimed — so the staleness
	 * guard lets it through and the screen shows "could not check".
	 *
	 * A counter cannot return to a value it has already had.
	 */
	it('does not depend on the settings values, which can return to themselves', () => {
		const deps = app.slice(app.indexOf('}, [api, status?.unlocked'), app.indexOf('if (fatal'));
		expect(deps, 'a quick on-then-off would look like no change at all').not.toMatch(
			/status\?\.(requireProxies|updateCheck)/
		);
	});

	it('bumps the revision only after a save that succeeded', () => {
		// From the handler's opening brace, not from the save call — a bump added
		// *above* the call would otherwise sit outside the slice and be invisible
		// to the ordering check below.
		const at = app.indexOf('onSave={async (settings) => {');
		const saved = app.slice(at, at + 2400);

		// After the awaited `updateSettings`, so a throw never reaches it — a
		// failed save must not supersede the check that is running.
		expect(saved).toMatch(/setSettingsRevision\(\(revision\) => revision \+ 1\)/);
		expect(saved.indexOf('api.updateSettings(')).toBeLessThan(
			saved.indexOf('setSettingsRevision(')
		);
		// Once. A second bump anywhere in the handler is a save counted twice, or
		// counted before it succeeded.
		expect(saved.match(/setSettingsRevision\(/g) ?? []).toHaveLength(1);
	});

	it('still carries both settings on the status, for the rest of the screen', () => {
		// The account list hides Direct and Steam-only on `requireProxies`; that
		// still needs the value, it just no longer drives the update effect.
		const shared = readFileSync(join(__dirname, '../src/shared/ipc.ts'), 'utf8');
		const status = shared.slice(
			shared.indexOf('export const vaultStatusResponse'),
			shared.indexOf('export const accountSummary')
		);
		expect(status).toMatch(/requireProxies: z\.boolean\(\)/);
		expect(status).toMatch(/updateCheck: z\.boolean\(\)/);
	});
});

/**
 * **A proxy field holding only spaces is not a proxy.**
 *
 * Enrolment sends `proxyUrl.trim() || undefined`. The transfer screen sent the
 * raw value, so a field the user had effectively left blank reached `new URL()`
 * in the main process and failed with `Invalid URL` — a transfer refused for
 * something that looked empty on screen. Fails closed rather than leaking, and
 * is still a defect: the screen already treats the trimmed value as the real
 * one everywhere else it looks at it.
 */
describe('the proxy field on the two credential forms', () => {
	it.each([['AddAuthenticator.tsx'], ['MoveAuthenticator.tsx']])(
		'%s submits the trimmed value, or nothing',
		(screen) => {
			const source = readFileSync(join(__dirname, `../src/renderer/screens/${screen}`), 'utf8');
			expect(source).toMatch(/proxyUrl\.trim\(\) \|\| undefined/);
		}
	);

	it('neither submits the raw value', () => {
		for (const screen of ['AddAuthenticator.tsx', 'MoveAuthenticator.tsx']) {
			const source = readFileSync(join(__dirname, `../src/renderer/screens/${screen}`), 'utf8');
			// The bare identifier as an argument, which is what the transfer did.
			expect(source, `${screen} passes the untrimmed field`).not.toMatch(/,\s*proxyUrl\s*\)/);
		}
	});
});

/**
 * **Saving reads the status back, rather than waiting for the poll.**
 *
 * The update effect watches `status.requireProxies` and `status.updateCheck`,
 * and the status is polled once a second. A quick on-then-off of `Require
 * proxies` between two ticks therefore changed both fields back to what they
 * already were: the effect never re-ran, and the check the first save aborted
 * was never retried. The setting had been turned off and on again with no
 * visible consequence at all.
 */
describe('saving settings and the status the screen watches', () => {
	const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
	// Forward from the call rather than back from a later name: `onClose={() =>
	// setView(` appears on an earlier screen too, so an `indexOf` for it ends
	// the slice before it starts.
	const saveAt = app.indexOf('const result = await api.updateSettings(');
	const save = app.slice(saveAt, saveAt + 1600);

	/*
	 * The predicate in `update-banner-race.test.tsx` decides correctly given two
	 * different numbers. This is what makes them different: reading the counter
	 * instead of claiming it gives every check the same one, and the predicate
	 * then says every answer is current — the race, restored, with the guard
	 * still in place and still agreeing with itself.
	 */
	it('claims a sequence number for each check rather than reading one', () => {
		expect(app).toMatch(/const mine = \(updateSeq\.current \+= 1\);/);
		expect(app).toMatch(/updateAnswerIsCurrent\(updateSeq\.current, mine,/);
	});

	it('refreshes the status straight after a successful save', () => {
		expect(save, 'the screen waits up to a poll to notice its own save').toMatch(
			/refresh\(\{ includeCodes: false \}\)/
		);
	});

	/*
	 * After the write, or it reads the values being replaced.
	 */
	it('refreshes after the save, not before', () => {
		expect(save.indexOf('api.updateSettings(')).toBeLessThan(save.indexOf('refresh({'));
	});

	/*
	 * Without the codes: they are the slow part — `listCodes` waits on the Steam
	 * clock sync — and nothing about a settings save changes them.
	 */
	it('does not drag the Steam clock sync into a settings save', () => {
		expect(save).not.toMatch(/refresh\(\)/);
	});
});
