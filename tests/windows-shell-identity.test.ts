import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branding } from '../src/shared/branding';
import {
	developmentWindowsAppId,
	portableWindowsAppId,
	windowsProcessAppId
} from '../src/main/windows-identity';

const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
	/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
	''
);

/**
 * **Who is allowed to be "Open Desktop Authenticator" as far as the shell is
 * concerned.**
 *
 * Claiming the AppUserModelID is not free. It is what names a toast and lets
 * Action Center route a click, and it is also what decides the taskbar button's
 * icon. An installed build gets that mapping from its executable and shortcut;
 * a source checkout has neither, so every development window supplies complete
 * relaunch properties under a separate development ID.
 *
 * Installed, portable and development processes use separate desktop IDs, and a
 * Store process keeps its package identity. These cases are the whole rule;
 * each one is a build somebody actually runs.
 */
describe('claiming the Windows shell identity', () => {
	const dev = {
		appId: branding.appId,
		packaged: false,
		portable: false,
		windowsStore: false
	};

	it('uses a separate stable identity in ordinary development', () => {
		expect(
			windowsProcessAppId(dev),
			'two development windows without their own AUMID regroup under electron.exe'
		).toBe(developmentWindowsAppId(branding.appId));
		expect(windowsProcessAppId(dev)).not.toBe(branding.appId);
	});

	it('is claimed by a packaged build, which is what ships', () => {
		expect(
			windowsProcessAppId({ ...dev, packaged: true }),
			'an installed build must claim its identity: without it a toast is captioned with the ' +
				'raw appId and Action Center cannot route a click back to the confirmation'
		).toBe(branding.appId);
	});

	/*
	 * Portable is a real build a real person runs, so its window has the same
	 * right to its own name. The thing portable withholds is the *registry* write,
	 * which is decided separately at the call site — this predicate deliberately
	 * does not fold those two together.
	 */
	it('is claimed by the portable build too', () => {
		expect(windowsProcessAppId({ ...dev, packaged: true, portable: true })).toBe(
			portableWindowsAppId(branding.appId)
		);
		expect(portableWindowsAppId(branding.appId)).not.toBe(branding.appId);
	});

	it('never overrides the identity derived from a Microsoft Store package', () => {
		expect(
			windowsProcessAppId({ ...dev, packaged: true, windowsStore: true }),
			'a Store package must keep the AUMID derived from its signed package manifest'
		).toBeUndefined();
	});

	it('uses the selected channel ID and leaves the Store package ID untouched at startup', () => {
		expect(MAIN).toMatch(
			/const windowsStore\s*=\s*\(process as NodeJS\.Process & \{ windowsStore\?: boolean \}\)\.windowsStore === true/
		);
		expect(MAIN).toMatch(
			/windowsProcessAppId\(\{\s*appId:\s*branding\.appId,\s*packaged:\s*app\.isPackaged,\s*portable:\s*portableDir !== undefined,\s*windowsStore\s*\}\)/
		);
		expect(MAIN).not.toMatch(/windowsProcessAppId\(\{[\s\S]*?override:/);
		expect(MAIN).toMatch(
			/if \(process\.platform === 'win32' && windowsAppId !== undefined\)\s*\{\s*app\.setAppUserModelId\(windowsAppId\)/
		);
		expect(MAIN).not.toMatch(/app\.setAppUserModelId\(branding\.appId\)/);
		expect(MAIN).toMatch(
			/portableDir === undefined\s*&&\s*!windowsStore\s*&&\s*windowsAppId !== undefined\s*&&\s*\(app\.isPackaged \|\| persistentDevelopmentIdentity\)/
		);
		expect(MAIN).toMatch(/registerWindowsIdentity\(\{\s*appId: windowsAppId,/);
	});
});
