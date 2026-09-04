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
 * icon — through a Start Menu shortcut carrying `System.AppUserModel.ID`, which
 * only an installer writes. A source checkout has no such shortcut, so Windows
 * fell back to the icon of the running executable and put Electron's mark on the
 * taskbar, whatever `BrowserWindow.icon` was handed.
 *
 * So a development run does not claim it, an installed or portable process uses
 * its own desktop channel ID, and a Store process keeps its package identity.
 * These cases are the whole rule; each one is a build somebody actually runs.
 */
describe('claiming the Windows shell identity', () => {
	const dev = {
		appId: branding.appId,
		packaged: false,
		portable: false,
		windowsStore: false,
		override: undefined
	};

	it('is skipped by an ordinary development run', () => {
		expect(
			windowsProcessAppId(dev),
			'`npm start` claims the AppUserModelID, which hands the taskbar button back to ' +
				'electron.exe and puts the Electron mark where the product mark should be'
		).toBeUndefined();
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

	/*
	 * The escape hatch exists because the cost of skipping is paid entirely by
	 * notification work: attribution and Action Center routing. Anyone testing
	 * that needs the real thing, and should not have to edit source to get it.
	 */
	it('is restored in development by ODA_WINDOWS_IDENTITY=1', () => {
		expect(
			windowsProcessAppId({ ...dev, override: '1' }),
			'the documented escape hatch does not work, so testing notifications means editing source'
		).toBe(developmentWindowsAppId(branding.appId));
	});

	/*
	 * Exactly "1". An unset variable reads as undefined and an unrelated value
	 * must not switch behaviour on — "0" turning the identity ON is the kind of
	 * thing nobody notices until a taskbar icon is wrong again.
	 */
	it.each([
		['unset', undefined],
		['empty', ''],
		['zero', '0'],
		['false', 'false'],
		['true', 'true']
	])('is not restored by ODA_WINDOWS_IDENTITY=%s', (_name, value) => {
		expect(windowsProcessAppId({ ...dev, override: value })).toBeUndefined();
	});

	it('uses the selected channel ID and leaves the Store package ID untouched at startup', () => {
		expect(MAIN).toMatch(/const windowsStore\s*=/);
		expect(MAIN).toMatch(/windowsProcessAppId\(\{[\s\S]*?windowsStore,[\s\S]*?\}\)/);
		expect(MAIN).toMatch(
			/if \(process\.platform === 'win32' && windowsAppId !== undefined\)\s*\{\s*app\.setAppUserModelId\(windowsAppId\)/
		);
		expect(MAIN).not.toMatch(/app\.setAppUserModelId\(branding\.appId\)/);
		expect(MAIN).toMatch(
			/portableDir === undefined && !windowsStore && windowsAppId !== undefined/
		);
		expect(MAIN).toMatch(/registerWindowsIdentity\(\{\s*appId: windowsAppId,/);
	});
});
