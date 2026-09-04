import { describe, expect, it } from 'vitest';
import { claimsWindowsShellIdentity } from '../src/main/windows-identity';

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
 * So a development run does not claim it, and everything that ships does. These
 * cases are the whole of that rule; each one is a build somebody actually runs.
 */
describe('claiming the Windows shell identity', () => {
	const dev = { packaged: false, portable: false, override: undefined };

	it('is skipped by an ordinary development run', () => {
		expect(
			claimsWindowsShellIdentity(dev),
			'`npm start` claims the AppUserModelID, which hands the taskbar button back to ' +
				'electron.exe and puts the Electron mark where the product mark should be'
		).toBe(false);
	});

	it('is claimed by a packaged build, which is what ships', () => {
		expect(
			claimsWindowsShellIdentity({ ...dev, packaged: true }),
			'an installed build must claim its identity: without it a toast is captioned with the ' +
				'raw appId and Action Center cannot route a click back to the confirmation'
		).toBe(true);
	});

	/*
	 * Portable is a real build a real person runs, so its window has the same
	 * right to its own name. The thing portable withholds is the *registry* write,
	 * which is decided separately at the call site — this predicate deliberately
	 * does not fold those two together.
	 */
	it('is claimed by the portable build too', () => {
		expect(claimsWindowsShellIdentity({ ...dev, portable: true })).toBe(true);
	});

	/*
	 * The escape hatch exists because the cost of skipping is paid entirely by
	 * notification work: attribution and Action Center routing. Anyone testing
	 * that needs the real thing, and should not have to edit source to get it.
	 */
	it('is restored in development by ODA_WINDOWS_IDENTITY=1', () => {
		expect(
			claimsWindowsShellIdentity({ ...dev, override: '1' }),
			'the documented escape hatch does not work, so testing notifications means editing source'
		).toBe(true);
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
		expect(claimsWindowsShellIdentity({ ...dev, override: value })).toBe(false);
	});
});
