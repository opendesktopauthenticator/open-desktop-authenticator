import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { branding } from '../src/shared/branding';
import { developmentWindowsAppId, portableWindowsAppId } from '../src/main/windows-identity';
import {
	applyWindowsTaskbarIdentity,
	windowsTaskbarDetails
} from '../src/main/windows-taskbar-identity';

const ROOT = resolve(__dirname, '..');
const MAIN = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');

const development = {
	platform: 'win32' as const,
	packaged: false,
	windowsStore: false,
	portable: false,
	developmentIdentity: false,
	portableExecutablePath: undefined,
	applicationPath: ROOT,
	executablePath: join(ROOT, 'node_modules/electron/dist/electron.exe')
};

describe('the taskbar identity shared by every top-level window', () => {
	it('uses the real ICO when persistent development identity is explicitly enabled', () => {
		const details = windowsTaskbarDetails({ ...development, developmentIdentity: true });

		expect(details).toEqual({
			appId: developmentWindowsAppId(branding.appId),
			appIconPath: join(ROOT, 'build/icon.ico'),
			appIconIndex: 0,
			relaunchCommand: `"${development.executablePath}" "${ROOT}"`,
			relaunchDisplayName: `${branding.productName} (Development)`
		});
		expect(isAbsolute(details!.appIconPath)).toBe(true);
		expect(details!.appIconPath).not.toBe(development.executablePath);
		expect(existsSync(details!.appIconPath), 'the development taskbar ICO is missing').toBe(true);
	});

	it('leaves an ordinary development BrowserWindow on its native product icon', () => {
		expect(windowsTaskbarDetails(development)).toBeUndefined();
	});

	it('leaves an installed executable on its matching process and shortcut identity', () => {
		const executablePath = join(ROOT, 'release/win-unpacked/Open Desktop Authenticator.exe');
		const details = windowsTaskbarDetails({
			...development,
			packaged: true,
			executablePath
		});

		expect(details).toBeUndefined();
	});

	it('uses the durable outer launcher for a portable icon and relaunch', () => {
		const launcher = join(ROOT, 'release/open-desktop-authenticator-1.5.0-portable.exe');
		const innerExecutable = join(
			process.env.TEMP ?? 'C:\\Temp',
			'oda-inner/Open Desktop Authenticator.exe'
		);
		const details = windowsTaskbarDetails({
			...development,
			packaged: true,
			portable: true,
			portableExecutablePath: launcher,
			executablePath: innerExecutable
		});

		expect(details).toEqual({
			appId: portableWindowsAppId(branding.appId),
			appIconPath: launcher,
			appIconIndex: 0,
			relaunchCommand: `"${launcher}"`,
			relaunchDisplayName: branding.productName
		});
		expect(details!.appIconPath).not.toBe(innerExecutable);
	});

	it('refuses to point a portable identity at the temporary inner executable', () => {
		expect(
			windowsTaskbarDetails({
				...development,
				packaged: true,
				portable: true,
				portableExecutablePath: undefined
			})
		).toBeUndefined();
	});

	it('does not override the Microsoft Store package identity', () => {
		expect(
			windowsTaskbarDetails({ ...development, packaged: true, windowsStore: true })
		).toBeUndefined();
	});

	it('refreshes the AppUserModelID only after the relaunch icon exists', () => {
		const setAppDetails = vi.fn();
		let storedIcon: string | undefined;
		let iconSeenByTaskbar: string | undefined;
		setAppDetails.mockImplementation((details: { appId?: string; appIconPath?: string }): void => {
			// Chromium writes the ID before the icon within each call, and Windows
			// snapshots the group icon when that ID is committed.
			if (details.appId) iconSeenByTaskbar = storedIcon;
			if (details.appIconPath) storedIcon = details.appIconPath;
		});

		const optedIn = { ...development, developmentIdentity: true };
		applyWindowsTaskbarIdentity({ setAppDetails }, optedIn);

		const details = windowsTaskbarDetails(optedIn)!;
		expect(setAppDetails.mock.calls).toEqual([[details], [{ appId: details.appId }]]);
		expect(iconSeenByTaskbar).toBe(details.appIconPath);
	});

	it.each(['darwin', 'linux'] as const)('does nothing on %s', (platform) => {
		const setAppDetails = vi.fn();

		applyWindowsTaskbarIdentity({ setAppDetails }, { ...development, platform });

		expect(setAppDetails).not.toHaveBeenCalled();
	});

	it('passes Store and portable runtime signals at the main-window boundary', () => {
		const construction = MAIN.indexOf('const window = new BrowserWindow(');
		const identity = MAIN.indexOf('applyWindowsTaskbarIdentity(window', construction);
		const reveal = MAIN.indexOf("window.once('ready-to-show'", construction);
		const call = MAIN.slice(identity, reveal);

		expect(call).toContain('windowsStore:');
		expect(call).toContain('process.env.PORTABLE_EXECUTABLE_DIR !== undefined');
		expect(call).toContain("developmentIdentity: process.env.ODA_WINDOWS_IDENTITY === '1'");
		expect(call).toContain('portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE');
	});

	it('assigns the main window before any ready-to-show handler can reveal it', () => {
		const construction = MAIN.indexOf('const window = new BrowserWindow(');
		const identity = MAIN.indexOf('applyWindowsTaskbarIdentity(window', construction);
		const reveal = MAIN.indexOf("window.once('ready-to-show'", construction);

		expect(construction).toBeGreaterThanOrEqual(0);
		expect(identity, 'the main window never receives taskbar app details').toBeGreaterThan(
			construction
		);
		expect(reveal).toBeGreaterThan(identity);
		expect(
			MAIN.slice(construction, reveal).match(/applyWindowsTaskbarIdentity\(window/g)
		).toHaveLength(1);
	});
});
