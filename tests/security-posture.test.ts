import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cspFor, PRODUCTION_CSP, SECURE_WEB_PREFERENCES } from '../src/shared/security-policy';

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
