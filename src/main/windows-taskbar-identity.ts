import { resolve } from 'node:path';
import { branding } from '../shared/branding';
import { developmentWindowsAppId, portableWindowsAppId } from './windows-identity';

/**
 * The part of an Electron top-level window used to give Windows a stable
 * taskbar identity.
 *
 * Kept structural so the policy can be tested without Electron. Both top-level
 * windows are BrowserWindows now; the account shell uses its owned contents for
 * the trusted toolbar and child views for open-web pages.
 */
export interface WindowsTaskbarWindow {
	setAppDetails(details: {
		appId?: string;
		appIconPath?: string;
		appIconIndex?: number;
		relaunchCommand?: string;
		relaunchDisplayName?: string;
	}): void;
}

export interface WindowsTaskbarEnvironment {
	platform: NodeJS.Platform;
	packaged: boolean;
	windowsStore: boolean;
	portable: boolean;
	developmentIdentity: boolean;
	portableExecutablePath?: string;
	applicationPath: string;
	executablePath: string;
}

export interface WindowsTaskbarDetails {
	appId: string;
	appIconPath: string;
	appIconIndex: number;
	relaunchCommand: string;
	relaunchDisplayName: string;
}

function quoteWindowsCommandArgument(value: string): string {
	// Windows paths cannot contain a double quote, so no further escaping is
	// possible or necessary. Always quote: every supported path may contain a
	// space, including the default Program Files and source-checkout locations.
	return `"${value}"`;
}

/**
 * The properties Windows uses for the taskbar group, rather than for the
 * title-bar or Alt-Tab icon.
 *
 * An opted-in development identity has no installed shortcut, and a portable
 * run executes an inner binary from a temporary directory. Those two channels
 * therefore need complete per-window relaunch metadata. Ordinary development
 * uses the BrowserWindows' native icons. Installed builds already have the
 * matching executable and shortcut; Store builds already have package identity.
 */
export function windowsTaskbarDetails({
	platform,
	packaged,
	windowsStore,
	portable,
	developmentIdentity,
	portableExecutablePath,
	applicationPath,
	executablePath
}: WindowsTaskbarEnvironment): WindowsTaskbarDetails | undefined {
	if (platform !== 'win32' || windowsStore) {
		return undefined;
	}

	if (portable) {
		if (!portableExecutablePath) {
			// Never point a shell pin at electron-builder's temporary inner
			// executable. The window keeps its native icon if the documented outer
			// launcher variable is unexpectedly unavailable.
			return undefined;
		}
		const launcher = resolve(portableExecutablePath);
		return {
			appId: portableWindowsAppId(branding.appId),
			appIconPath: launcher,
			appIconIndex: 0,
			relaunchCommand: quoteWindowsCommandArgument(launcher),
			relaunchDisplayName: branding.productName
		};
	}

	// Installed and unpacked NSIS executables already carry the product icon and
	// use the builder's matching process/shortcut identity. A per-window override
	// is redundant there and would override a future package identity again.
	if (packaged) {
		return undefined;
	}
	if (!developmentIdentity) {
		return undefined;
	}

	const appPath = resolve(applicationPath);
	const electronPath = resolve(executablePath);
	return {
		appId: developmentWindowsAppId(branding.appId),
		appIconPath: resolve(appPath, 'build', 'icon.ico'),
		appIconIndex: 0,
		relaunchCommand: `${quoteWindowsCommandArgument(electronPath)} ${quoteWindowsCommandArgument(appPath)}`,
		relaunchDisplayName: `${branding.productName} (Development)`
	};
}

/**
 * Apply the shared taskbar identity before the window is shown.
 *
 * Electron/Chromium commits AppUserModelID before RelaunchIconResource inside a
 * combined call. Windows refreshes the taskbar at that first commit, while the
 * icon is still absent. Repeating the ID after the complete metadata call is
 * therefore load-bearing: it refreshes Explorer after the icon exists without
 * clearing any of the other properties.
 */
export function applyWindowsTaskbarIdentity(
	window: WindowsTaskbarWindow,
	environment: WindowsTaskbarEnvironment
): void {
	const details = windowsTaskbarDetails(environment);
	if (details) {
		window.setAppDetails(details);
		window.setAppDetails({ appId: details.appId });
	}
}
