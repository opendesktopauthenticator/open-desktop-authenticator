import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	cspFor,
	isOpenableExternally,
	PRODUCTION_CSP,
	SECURE_WEB_PREFERENCES
} from '../src/shared/security-policy';

/**
 * The §11 invariants, asserted rather than documented.
 *
 * A security posture written only in comments erodes: someone flips
 * `sandbox: false` to make a library work and nothing complains. These tests are
 * what make the invariants survive contact with feature work, and several are
 * deliberately source-level checks — they catch the shape of a mistake, not just
 * its runtime effect.
 */

const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('S6 — window security posture', () => {
	it('sandboxes the renderer and isolates context', () => {
		expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
		expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true);
	});

	it('gives the renderer no Node access anywhere', () => {
		expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
		expect(SECURE_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
		expect(SECURE_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false);
	});

	it('keeps web security on and disallows insecure content', () => {
		expect(SECURE_WEB_PREFERENCES.webSecurity).toBe(true);
		expect(SECURE_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
		expect(SECURE_WEB_PREFERENCES.webviewTag).toBe(false);
	});

	it('disables the spellchecker, which phones a Google CDN on Linux', () => {
		// Electron's default is on, and an active spellchecker on Linux downloads
		// Hunspell dictionaries from a Google-run CDN — an undisclosed network
		// request from an app that promises the update check is its only
		// non-Steam traffic. Nothing here is prose: the fields are account names,
		// passphrases and codes.
		expect(SECURE_WEB_PREFERENCES.spellcheck).toBe(false);
	});

	it('disables DevTools by default', () => {
		// "Open the console and paste this to fix your codes" is a scam that works
		// on real people, and pasted script gets everything window.api exposes.
		expect(SECURE_WEB_PREFERENCES.devTools).toBe(false);
	});

	it('re-enables DevTools only when not packaged, and drops the menu when packaged', () => {
		const main = read('src/main/index.ts');
		// The single deliberate relaxation must be tied to isDev, not unconditional.
		expect(main).toMatch(/devTools:\s*isDev/);
		// autoHideMenuBar only hides the bar; the accelerator still works, so the
		// default menu has to go in a packaged build.
		expect(main).toMatch(/if \(!isDev\)[\s\S]{0,80}Menu\.setApplicationMenu\(null\)/);
	});

	it('hardens every WebContents, not only windows it creates', () => {
		expect(read('src/main/index.ts')).toContain('hardenAllWebContents');
		expect(read('src/main/security.ts')).toContain("app.on('web-contents-created'");
	});
});

describe('S6 — IPC answers only our own renderer', () => {
	const router = read('src/main/ipc/router.ts');

	it('checks the sender before doing anything else', () => {
		// ipcMain.handle answers ANY WebContents in the process, not just ours.
		expect(router).toContain('event.senderFrame');
		expect(router).toContain('isTrustedSender');
	});

	it('fails closed when no trusted sender has been configured', () => {
		// A handler answering before setTrustedSender runs would be answering an
		// unknown caller; the default must deny.
		expect(router).toMatch(/isTrustedSender[^=]*=\s*\(\)\s*=>\s*false/);
	});

	it('derives "us" from the same predicate as the navigation lock', () => {
		// Two independent definitions of the trusted origin would drift.
		expect(read('src/main/index.ts')).toMatch(/setTrustedSender\([\s\S]{0,200}isAllowedNavigation/);
	});

	it('cannot be weakened at runtime', () => {
		expect(Object.isFrozen(SECURE_WEB_PREFERENCES)).toBe(true);
		expect(() => {
			(SECURE_WEB_PREFERENCES as { sandbox: boolean }).sandbox = false;
		}).toThrow();
		expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
	});

	it('is the only webPreferences used to create a window', () => {
		const main = read('src/main/index.ts');
		// Any window must spread the shared constant. A literal `webPreferences: {`
		// followed by its own options would be a second, unreviewed posture.
		expect(main).toContain('...SECURE_WEB_PREFERENCES');
		expect(main).not.toMatch(/nodeIntegration:\s*true/);
		expect(main).not.toMatch(/contextIsolation:\s*false/);
		expect(main).not.toMatch(/sandbox:\s*false/);
	});
});

describe('S5 / §9.3 — renderer has no network of its own', () => {
	it('forbids the renderer from opening any connection in production', () => {
		expect(PRODUCTION_CSP).toContain("connect-src 'none'");
	});

	it('allows no remote origins at all', () => {
		expect(PRODUCTION_CSP).toContain("default-src 'self'");
		expect(PRODUCTION_CSP).toContain("script-src 'self'");
		expect(PRODUCTION_CSP).toContain("object-src 'none'");
		expect(PRODUCTION_CSP).toContain("frame-ancestors 'none'");
		expect(PRODUCTION_CSP).toContain("base-uri 'none'");
		expect(PRODUCTION_CSP).not.toMatch(/https?:\/\//);
	});

	it('never serves the relaxed dev policy to a packaged build', () => {
		// Even if a dev server origin is somehow present, isDev=false must win.
		expect(cspFor(false)).toBe(PRODUCTION_CSP);
		expect(cspFor(false, 'http://localhost:5173')).toBe(PRODUCTION_CSP);
	});

	it('relaxes connect-src only in dev, and only for the dev server', () => {
		const dev = cspFor(true, 'http://localhost:5173');
		expect(dev).toContain('ws://localhost:5173');
		expect(dev).not.toContain("connect-src 'none'");
		// The relaxation must not extend to arbitrary remote script.
		expect(dev).not.toContain('https://');
	});
});

describe('S6 — preload is a minimal allowlist, not a bridge', () => {
	const preload = read('src/preload/index.ts');

	it('never exposes ipcRenderer itself', () => {
		expect(preload).not.toMatch(/exposeInMainWorld\(\s*['"`]ipcRenderer/);
		expect(preload).not.toMatch(/exposeInMainWorld\([^)]*,\s*ipcRenderer\s*\)/);
	});

	it('names every channel as a literal from the contract', () => {
		// A function taking a channel from its caller is a generic invoke bridge
		// in disguise, which S6 forbids.
		expect(preload).not.toMatch(/invoke\(\s*channel/);
		expect(preload).not.toMatch(/\(channel(:\s*string)?\)/);
		expect(preload).toContain('CHANNELS.');
	});

	it('pulls in nothing from node:', () => {
		expect(preload).not.toMatch(/from\s+['"]node:/);
		expect(preload).not.toMatch(/require\(\s*['"]node:/);
	});

	it('imports channel values from the zod-free module, not the schema module', () => {
		// A sandboxed preload can only require `electron`. Importing values from
		// shared/ipc.ts drags zod into the bundle, the require throws, and the
		// bridge dies with no error surfaced anywhere — the renderer just looks
		// like it has no API. Type-only imports are fine; they are erased.
		expect(preload).toMatch(
			/import\s*\{[^}]*CHANNELS[^}]*\}\s*from\s*['"]\.\.\/shared\/channels['"]/
		);
		expect(preload).not.toMatch(
			/import\s*\{[^}]*CHANNELS[^}]*\}\s*from\s*['"]\.\.\/shared\/ipc['"]/
		);
		// Any non-type import from ipc.ts would reintroduce the problem.
		const ipcImports = preload.match(/^import\s+(?!type\s)[^;]*from\s*['"]\.\.\/shared\/ipc['"]/gm);
		expect(ipcImports).toBeNull();
	});
});

describe('built preload requires nothing but electron', () => {
	// Skipped when out/ is absent so `npm test` works on a clean checkout; CI
	// builds first, so it always runs there.
	const builtPath = join(root, 'out/preload/index.js');
	const built = existsSync(builtPath) ? readFileSync(builtPath, 'utf8') : undefined;

	it.skipIf(built === undefined)('requires only electron at runtime', () => {
		const requires = [...(built ?? '').matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(
			(m) => m[1]
		);
		expect(requires.length, 'preload should require something').toBeGreaterThan(0);
		for (const mod of requires) {
			expect(mod, `preload requires "${mod}", which a sandboxed preload cannot load`).toBe(
				'electron'
			);
		}
	});
});

describe('§7.2 / §15 — no Steam trademark in product identity', () => {
	it('keeps the product name out of the renderer HTML', () => {
		const html = read('src/renderer/index.html');
		expect(html).not.toMatch(/Steam/i);
	});

	it('carries no Steam or Valve mark in the branding constants', () => {
		const bran = read('src/shared/branding.ts');
		const productLine = /productName:\s*(.+)/.exec(bran)?.[1] ?? '';
		expect(productLine).not.toMatch(/steam|valve/i);
	});
});

/**
 * Everything holding a credential is dropped when the vault locks.
 *
 * A lock means the user has stopped being present. Every service that caches a
 * live credential has a teardown method for it, and `onLock` is the single place
 * they are called from — which makes forgetting one of them invisible: the
 * method still exists, its comment still says it is called on lock, and nothing
 * fails.
 *
 * That is exactly what happened. `EnrollmentService.forget` was written and
 * documented as "called when the vault locks" and was never wired, so a
 * half-finished sign-in and its cached MobileApp access tokens outlived every
 * lock. No unit test could catch it: the omission is in the wiring, and the
 * wiring is this file.
 */
describe('§11 — the lock drops every cached credential', () => {
	const index = read('src/main/index.ts');
	/** The body of the `onLock` handler, so a call elsewhere in the file cannot pass for one here. */
	const onLock = index.slice(index.indexOf('onLock: () => {'), index.indexOf('const codes = '));

	it.each([
		['staged import secrets', 'imports.discard()'],
		['the clipboard', 'clipboard.clearIfOurs()'],
		['confirmation tokens and pending list', 'confirmations.forget()'],
		['per-account cookie jars', 'transports.forgetAll()'],
		['the revocation ceremony', 'ceremony.forget()'],
		['automatic confirmation', 'autoConfirm.stop()'],
		['half-finished enrollments', 'enrollment.forget()']
	])('drops %s', (_what, call) => {
		expect(onLock).toContain(call);
	});

	it('does not block unlocking on a Steam round trip', () => {
		// `vault:unlock` awaits this callback before it returns, so awaiting the
		// clock sync inside it put a Steam request — with a thirty-second transport
		// timeout behind it — between pressing Unlock and the screen changing.
		// Offline, that was half a minute of "Unlocking…" with nothing to press.
		//
		// Asserted on the source because the cost is in the `await`, not in any
		// value a test could read back.
		const index = read('src/main/index.ts');
		const onUnlocked = index.slice(
			index.indexOf('registerVaultHandlers('),
			index.indexOf('registerImportHandlers(')
		);

		expect(onUnlocked).toContain('void clock.ensureSynced()');
		expect(onUnlocked).not.toContain('await clock.ensureSynced()');
	});

	it('has one way back to the window, not several that can drift', () => {
		// The tray click, the tray menu and a second launch all mean "put it in
		// front of me". They were separate implementations and had already drifted:
		// one restored a minimised window and the other did not, so the same intent
		// behaved differently depending on which control was used.
		//
		// Asserted on the source because the difference is in Electron calls no unit
		// test can observe without a real window.
		const index = read('src/main/index.ts');

		expect(index).toContain('const showMainWindow');
		expect(index).toContain("app.on('second-instance', showMainWindow)");
		expect(index).toContain('show: showMainWindow');
		// A second `mainWindow.show()` anywhere would be a second path re-appearing.
		expect(index.match(/mainWindow\.show\(\)/g) ?? []).toHaveLength(0);

		// And every tray control resolves the same window. Making only `show` do so
		// left the menu deciding its label from one window and acting on another —
		// the same defect, reintroduced by the fix for it.
		expect(index).toContain('hide: () => liveWindow()?.hide()');
		expect(index).toContain('isVisible: () => liveWindow()?.isVisible()');
	});

	it('found the handler it is asserting against', () => {
		// Guards the slice above: if `onLock` is renamed or moved, every assertion
		// would trivially pass against an empty string.
		expect(onLock).toContain('onLock: () => {');
		expect(onLock.length).toBeGreaterThan(200);
	});
});

/**
 * Every recovery path the app tells the user about is reachable (§12 F2).
 *
 * `account:recover` was written, tested and wired over IPC, and **nothing in the
 * renderer ever called it**. The main process was complete; the button did not
 * exist. Worse, the enrollment failure message names it — "unlock the vault and
 * use Recover from file" — so the one situation the feature exists for pointed
 * at a control that was not there.
 *
 * A unit test cannot catch that: every piece works in isolation, and the missing
 * piece is the connection between them. So this asserts the connection.
 */
describe('§12 F2 — the recovery path is reachable from the interface', () => {
	it('a screen calls recoverAccount', () => {
		const screens = read('src/renderer/App.tsx');
		expect(screens).toContain('recoverAccount');
	});

	it('and something visible opens it', () => {
		// The IPC call existing behind a screen nobody can navigate to is the same
		// bug one level up.
		const home = read('src/renderer/screens/VaultHome.tsx');
		expect(home).toContain('onRecover');
		expect(home).toContain('Recover from file');
	});

	it('offers the backup on the create screen too, not only the unlock screen', () => {
		// A missing `vault.json` with a good `vault.json.bak` beside it routes to
		// CreateVault, which offered no way to load it. Following the only route the
		// screen gave would write a fresh vault, and the second save after that
		// copies it over the backup — the app talking the user through destroying
		// what it could have handed back.
		const app = read('src/renderer/App.tsx');
		const create = read('src/renderer/screens/CreateVault.tsx');
		const unlock = read('src/renderer/screens/UnlockVault.tsx');

		// The **rendered element**, not the import. Matching the import alone passes
		// while the component sits unused at the top of a file doing nothing, which
		// is exactly what this test would then be certifying.
		expect(create).toContain('<BackupRestore');
		expect(unlock).toContain('<BackupRestore');
		// Both routes reach the same handler, and the create screen is given the
		// flag that decides whether there is anything to offer.
		expect(app.match(/restoreVaultBackup/g) ?? []).toHaveLength(2);
		expect(app).toContain('backupAvailable={status.backupAvailable}');
	});

	it('the vault backup the unlock screen announces can actually be loaded', () => {
		// Same class, found by re-reading the whole tree: `writeEnvelope` keeps a
		// `.bak`, `backupAvailable` reported it, and the unlock screen said it "is
		// never loaded automatically" — which reads as an invitation to load it
		// deliberately. Nothing could. A vault file that would not parse was
		// therefore a total lockout with a good copy sitting beside it.
		const unlock = read('src/renderer/screens/UnlockVault.tsx');
		const app = read('src/renderer/App.tsx');

		expect(unlock).toContain('onRestoreBackup');
		expect(app).toContain('restoreVaultBackup');
	});

	it('the wording matches what the enrollment failure tells the user to do', () => {
		// If either side is reworded without the other, the instruction sends the
		// user looking for a control whose label no longer matches — which is how
		// this was broken in the first place, only more so.
		const enrollment = read('src/main/steam/enrollment.ts');
		const home = read('src/renderer/screens/VaultHome.tsx');
		const phrase = 'Recover from file';

		expect(enrollment).toContain(phrase);
		expect(home).toContain(phrase);
	});
});

describe('external links are https only', () => {
	it('refuses plain http even for allowed hosts', () => {
		// Nothing this app links to serves anything over http that it does not
		// also serve over https, and an http link is one a network attacker can
		// answer — on the app whose job is teaching people to follow only the
		// verified chain.
		expect(isOpenableExternally('http://github.com/anything')).toBe(false);
		expect(isOpenableExternally('http://steamcommunity.com/')).toBe(false);
		expect(isOpenableExternally('https://github.com/anything')).toBe(true);
	});
});

describe('the renderer bundle stays free of the schema library', () => {
	it('no renderer file value-imports the zod-bearing contract', () => {
		// Two screens importing two constants from `ipc.ts` pulled all of zod —
		// a third of the renderer bundle — into a process that validates nothing.
		// The constants live in the zod-free `acknowledgements.ts`; types are fine
		// (erased at compile), values are not.
		const screens = readdirSync(join(root, 'src/renderer/screens')).filter((name) =>
			name.endsWith('.tsx')
		);
		const offenders: string[] = [];
		for (const name of [...screens.map((s) => `screens/${s}`), 'App.tsx']) {
			const source = read(`src/renderer/${name}`);
			// A value import: `import {` ... `} from '<path>/shared/ipc'` without `type`.
			const match = /import \{[^}]*\} from '[^']*shared\/ipc'/.exec(source);
			if (match && !/^import type/.test(match[0]) && /\{[^}]*\b(?!type )[a-z]/.test(match[0])) {
				// Allow imports where every named binding is `type X`.
				const bindings = /\{([^}]*)\}/.exec(match[0])?.[1] ?? '';
				const hasValue = bindings
					.split(',')
					.some((entry) => entry.trim() !== '' && !entry.trim().startsWith('type '));
				if (hasValue) {
					offenders.push(name);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

/**
 * The one window that is deliberately not navigation-locked, and the wiring
 * that makes the exemption real rather than assumed.
 *
 * **This is the bug the ported unit tests could not see.** `browser/window.ts`
 * is tested against an injected fake host, which is what makes its decisions
 * checkable without Electron — and it means the real environment those
 * decisions run inside is invisible to it. `hardenAllWebContents` attaches
 * `will-redirect` to every `WebContents` the process creates, that fires for a
 * programmatic `loadURL` as well as for a click, and every interesting Steam
 * URL answers with a redirect. So the in-app browser could not load a single
 * page, while forty-three unit tests passed.
 *
 * Read out of the source because the alternative is booting Electron. That is a
 * weaker test than driving the app, and it is the strongest one available here.
 */
describe('§9.3 — the in-app browser is exempt, and only it', () => {
	const security = read('src/main/security.ts');
	const host = read('src/main/browser/electron-host.ts');
	const index = read('src/main/index.ts');

	it('lets the process-wide lock take an exemption at all', () => {
		expect(security).toMatch(/hardenAllWebContents\([\s\S]{0,200}isExempt/);
		expect(security).toMatch(/if \(isExempt\(contents\)\) \{\s*return;/);
	});

	it('defaults to locking everything when no exemption is given', () => {
		// A missing argument must not silently unlock the application.
		expect(security).toMatch(/isExempt: \(contents: WebContents\) => boolean = \(\) => false/);
	});

	it('identifies the browser by the sessions it created, not by a guess', () => {
		expect(host).toMatch(/new WeakSet<Session>\(\)/);
		expect(host).toMatch(/browserSessions\.add\(partitioned\)/);
		expect(host).toMatch(/export function isAccountBrowserContents/);
		expect(host).toMatch(/browserSessions\.has\(contents\.session\)/);
	});

	/*
	 * Registration has to happen before the window exists, because
	 * `web-contents-created` fires during construction. `openAccountBrowser`
	 * takes the session first and creates the window last, which is what makes
	 * this hold — asserted here so reordering that function fails loudly.
	 */
	it('registers the session before any window is created', () => {
		const browser = read('src/main/browser/window.ts');
		expect(browser.indexOf('host.sessionFromPartition')).toBeLessThan(
			browser.indexOf('host.createWindow')
		);
	});

	it('is wired up in the main process', () => {
		expect(index).toMatch(/hardenAllWebContents\(rendererTarget, isAccountBrowserContents\)/);
		expect(index).toMatch(/isAccountBrowserContents/);
	});
});
