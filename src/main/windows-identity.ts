import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { rgbaOf } from '../shared/logo';
import { encodePng } from './png';

const run = promisify(execFile);

/**
 * Telling Windows what this application is called.
 *
 * ## The problem
 *
 * A toast notification is labelled with the application's name, and Windows does
 * not get that name from the window, the executable, or `productName`. It gets it
 * from the **AppUserModelID** — and an AppUserModelID is only an opaque string
 * until something maps it to a display name. With nothing registered, Windows
 * shows the string, so the tray notice arrived above the words
 * `com.opendesktopauthenticator.desktop`. The icon has the same cause: with no
 * registered image, Windows falls back to scaling the 16px tray icon up to the
 * ~48px the toast draws at, which is why it looked soft.
 *
 * ## The fix, and why this one
 *
 * There are two documented ways to associate a name with an AppUserModelID. The
 * usual one is a Start Menu shortcut carrying the ID, which an installer creates
 * — and this application has no installer yet, so in development there is no
 * shortcut and nothing to read a name from.
 *
 * The other is this: a key under the *user's own* hive naming the ID's display
 * name and icon. It is the mechanism Windows provides for exactly this case, it
 * works whether or not the app is packaged, and it keeps working once there is an
 * installer.
 *
 * ## What it touches
 *
 * One key, `HKCU\\Software\\Classes\\AppUserModelId\\<our id>`, holding two
 * strings. It is per-user, it is scoped to this application's own identifier, and
 * it is what an installer would write anyway. Nothing outside that key is read or
 * changed, and the values are checked before writing so an unchanged install does
 * not touch the registry on every launch.
 *
 * ## Failure
 *
 * Entirely best-effort. Every path swallows its error: this controls the caption
 * above a notification, and there is no version of that worth failing a launch
 * over — or worth delaying one, which is why the caller does not await it.
 */

/** Where the toast icon is written. Must be a real path on disk: Windows reads
 *  the file itself, so anything inside an asar archive is invisible to it. */
const ICON_FILE = 'notification-icon.png';

/**
 * Big enough for the largest a toast draws it.
 *
 * Windows renders the app logo at roughly 48px, doubled on a 200% display. 256
 * leaves room above that so the image is always being scaled down, never up —
 * scaling up is what the tray icon was doing, and what this replaces.
 */
const ICON_PX = 256;

/**
 * Runs `reg` and resolves its stdout. Rejects when `reg` exits non-zero, which is
 * how it reports a key or value that is simply not there.
 *
 * Injectable, because the entire purpose of this module is a side effect on the
 * machine it runs on — and a test that performed it would be a test that changes
 * the developer's own settings.
 */
export type RegCommand = (args: readonly string[]) => Promise<string>;

// execFile, not exec: these arguments carry a filesystem path and a product name,
// and neither should ever meet a shell.
const realReg: RegCommand = async (args) => (await run('reg', [...args])).stdout;

/**
 * One value out of `reg query` output, which looks like:
 *
 *     HKEY_CURRENT_USER\Software\Classes\AppUserModelId\com.example
 *         DisplayName    REG_SZ    Open Desktop Authenticator
 *
 * Only REG_SZ is recognised, which is the only type this module writes. A value
 * of some other type reads as absent and is replaced — right, because it is not
 * one of ours. An empty value reads as absent too: a real application on this
 * machine ships `IconUri` set to the empty string, and treating that as a value
 * would mean never filling it in.
 */
export function parseRegValue(stdout: string, name: string): string | undefined {
	const found = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.*)$`, 'im').exec(stdout);
	const value = found?.[1]?.trim();
	return value === undefined || value === '' ? undefined : value;
}

async function readValue(reg: RegCommand, key: string, name: string) {
	try {
		return parseRegValue(await reg(['query', key, '/v', name]), name);
	} catch {
		// Non-zero exit is how `reg` reports "not found", which is not an error here.
		return undefined;
	}
}

/**
 * Ensure the toast icon exists on disk, and answer with its path.
 *
 * Rewritten only when the bytes differ, so changing the mark propagates but an
 * ordinary launch does not touch the disk.
 */
function ensureIcon(userDataPath: string): string {
	const path = join(userDataPath, ICON_FILE);
	const wanted = encodePng(ICON_PX, rgbaOf(ICON_PX));
	try {
		if (readFileSync(path).equals(wanted)) {
			return path;
		}
	} catch {
		// Missing or unreadable; fall through and write it.
	}
	writeFileSync(path, wanted);
	return path;
}

/**
 * Register this application's name and icon against its AppUserModelID.
 *
 * A no-op anywhere but Windows, where the whole concept does not exist.
 */
export async function registerWindowsIdentity({
	appId,
	displayName,
	userDataPath,
	platform = process.platform,
	reg = realReg
}: {
	appId: string;
	displayName: string;
	userDataPath: string;
	platform?: NodeJS.Platform;
	reg?: RegCommand;
}): Promise<void> {
	if (platform !== 'win32') {
		return;
	}
	try {
		const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
		const iconPath = ensureIcon(userDataPath);

		// Checked before written. Two `reg query` calls on a launch that changes
		// nothing, rather than two writes.
		const [name, icon] = await Promise.all([
			readValue(reg, key, 'DisplayName'),
			readValue(reg, key, 'IconUri')
		]);
		if (name !== displayName) {
			await reg(['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', displayName, '/f']);
		}
		if (icon !== iconPath) {
			await reg(['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconPath, '/f']);
		}
	} catch {
		// See the note above: this is the caption on a notification.
	}
}
