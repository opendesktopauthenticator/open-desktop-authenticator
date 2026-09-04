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
const ACCOUNT_BROWSER = readFileSync(join(ROOT, 'src/main/browser/electron-host.ts'), 'utf8');

const development = {
	platform: 'win32' as const,
	packaged: false,
	windowsStore: false,
	portable: false,
	portableExecutablePath: undefined,
	applicationPath: ROOT,
	executablePath: join(ROOT, 'node_modules/electron/dist/electron.exe')
};

describe('the taskbar identity shared by every top-level window', () => {
	it('keeps both constructors on the native image and applies identity separately', () => {
		for (const [name, source] of [
			['main', MAIN],
			['account', ACCOUNT_BROWSER]
		] as const) {
			const construction = source.indexOf('new BrowserWindow(');
			const identity = source.indexOf('applyWindowsTaskbarIdentity(window', construction);
			const constructorBoundary = source.slice(construction, identity);

			expect(construction, `${name} BrowserWindow constructor is missing`).toBeGreaterThanOrEqual(
				0
			);
			expect(identity, `${name} taskbar identity boundary is missing`).toBeGreaterThan(
				construction
			);
			expect(constructorBoundary).toContain('icon: windowImage()');
			expect(constructorBoundary).not.toContain('browserWindowIcon');
		}
	});

	it('uses the real ICO and complete group details in ordinary development', () => {
		const details = windowsTaskbarDetails(development);

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

		applyWindowsTaskbarIdentity({ setAppDetails }, development);

		const details = windowsTaskbarDetails(development)!;
		expect(setAppDetails.mock.calls).toEqual([[details], [{ appId: details.appId }]]);
		expect(iconSeenByTaskbar).toBe(details.appIconPath);
	});

	it.each(['darwin', 'linux'] as const)('does nothing on %s', (platform) => {
		const setAppDetails = vi.fn();

		applyWindowsTaskbarIdentity({ setAppDetails }, { ...development, platform });

		expect(setAppDetails).not.toHaveBeenCalled();
	});

	it('passes the complete ungated runtime identity to both window boundaries', () => {
		for (const [name, source] of [
			['main', MAIN],
			['account', ACCOUNT_BROWSER]
		] as const) {
			const construction = source.indexOf('new BrowserWindow(');
			const identity = source.indexOf('applyWindowsTaskbarIdentity(window', construction);
			const beforeIdentity = source.slice(construction, identity);
			const call = source.slice(identity, identity + 750);

			expect(identity, `${name} taskbar identity call is missing`).toBeGreaterThan(construction);
			expect(beforeIdentity, `${name} taskbar identity is conditional`).not.toMatch(/\bif\s*\(/);
			expect(beforeIdentity).not.toContain('ODA_WINDOWS_IDENTITY');
			expect(call).toContain('platform: process.platform');
			expect(call).toContain('packaged: app.isPackaged');
			expect(call).toContain(
				'windowsStore: (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true'
			);
			expect(call).toContain('process.env.PORTABLE_EXECUTABLE_DIR !== undefined');
			expect(call).toContain('portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE');
			expect(call).toContain('applicationPath: app.getAppPath()');
			expect(call).toContain('executablePath: process.execPath');
			expect(call).not.toContain('developmentIdentity');
			expect(call).not.toContain('ODA_WINDOWS_IDENTITY');
		}
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
