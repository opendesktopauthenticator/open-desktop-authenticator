import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { branding } from '../src/shared/branding';
import {
	applyWindowsTaskbarIdentity,
	windowsTaskbarDetails
} from '../src/main/windows-taskbar-identity';

const ROOT = resolve(__dirname, '..');
const MAIN = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');

const development = {
	platform: 'win32' as const,
	packaged: false,
	applicationPath: ROOT,
	executablePath: join(ROOT, 'node_modules/electron/dist/electron.exe')
};

describe('the taskbar identity shared by every top-level window', () => {
	it('names the product and uses the real ICO instead of electron.exe in development', () => {
		const details = windowsTaskbarDetails(development);

		expect(details).toEqual({
			appId: branding.appId,
			appIconPath: join(ROOT, 'build/icon.ico'),
			appIconIndex: 0
		});
		expect(isAbsolute(details!.appIconPath)).toBe(true);
		expect(details!.appIconPath).not.toBe(development.executablePath);
		expect(existsSync(details!.appIconPath), 'the development taskbar ICO is missing').toBe(true);
	});

	it('uses the packaged executable icon resource, not a path inside the asar', () => {
		const executablePath = join(ROOT, 'release/win-unpacked/Open Desktop Authenticator.exe');
		const details = windowsTaskbarDetails({
			...development,
			packaged: true,
			executablePath
		});

		expect(details).toEqual({
			appId: branding.appId,
			appIconPath: executablePath,
			appIconIndex: 0
		});
		expect(isAbsolute(details!.appIconPath)).toBe(true);
	});

	it('applies those details exactly once on Windows', () => {
		const setAppDetails = vi.fn();

		applyWindowsTaskbarIdentity({ setAppDetails }, development);

		expect(setAppDetails).toHaveBeenCalledOnce();
		expect(setAppDetails).toHaveBeenCalledWith(windowsTaskbarDetails(development));
	});

	it.each(['darwin', 'linux'] as const)('does nothing on %s', (platform) => {
		const setAppDetails = vi.fn();

		applyWindowsTaskbarIdentity({ setAppDetails }, { ...development, platform });

		expect(setAppDetails).not.toHaveBeenCalled();
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
