import { resolve } from 'node:path';
import { branding } from '../shared/branding';

/**
 * The part of an Electron top-level window used to give Windows a stable
 * taskbar identity.
 *
 * Kept structural so the same helper accepts both `BrowserWindow` and
 * `BaseWindow`. The account browser deliberately uses the latter, and having
 * two call sites construct these values independently is how the second window
 * ended up changing the taskbar group back to Electron.
 */
export interface WindowsTaskbarWindow {
	setAppDetails(details: { appId: string; appIconPath: string; appIconIndex: number }): void;
}

export interface WindowsTaskbarEnvironment {
	platform: NodeJS.Platform;
	packaged: boolean;
	applicationPath: string;
	executablePath: string;
}

export interface WindowsTaskbarDetails {
	appId: string;
	appIconPath: string;
	appIconIndex: number;
}

/**
 * The properties Windows uses for the taskbar group, rather than for the
 * title-bar or Alt-Tab icon.
 *
 * An installed or portable executable already carries `build/icon.ico` as a
 * PE resource, so its own absolute path is the durable packaged resource. In a
 * development run the executable is Electron itself; use the generated ICO in
 * the source tree instead.
 */
export function windowsTaskbarDetails({
	platform,
	packaged,
	applicationPath,
	executablePath
}: WindowsTaskbarEnvironment): WindowsTaskbarDetails | undefined {
	if (platform !== 'win32') {
		return undefined;
	}

	return {
		appId: branding.appId,
		appIconPath: packaged ? resolve(executablePath) : resolve(applicationPath, 'build', 'icon.ico'),
		appIconIndex: 0
	};
}

/** Apply the shared taskbar identity before the window is shown. */
export function applyWindowsTaskbarIdentity(
	window: WindowsTaskbarWindow,
	environment: WindowsTaskbarEnvironment
): void {
	const details = windowsTaskbarDetails(environment);
	if (details) {
		window.setAppDetails(details);
	}
}
