import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRegValue, registerWindowsIdentity } from '../src/main/windows-identity';

/**
 * Telling Windows what to call this application above a notification.
 *
 * **Every test here injects the `reg` command.** The real one changes the
 * registry of whatever machine it runs on, and a test suite that alters the
 * developer's settings to prove it can alter the developer's settings is not a
 * test, it is the bug. What is asserted instead is the decision-making: what it
 * would run, and — just as important — when it runs nothing at all.
 */

const APP_ID = 'com.opendesktopauthenticator.desktop';
const KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;

let userData: string;
beforeEach(() => {
	userData = mkdtempSync(join(tmpdir(), 'oda-identity-'));
});
afterEach(() => {
	rmSync(userData, { recursive: true, force: true });
});

/** A fake `reg` that records calls and answers queries from a starting state. */
function fakeReg(existing: Record<string, string> = {}) {
	const calls: string[][] = [];
	const command = (args: readonly string[]): Promise<string> => {
		calls.push([...args]);
		if (args[0] === 'query') {
			const name = args[3] ?? '';
			const value = existing[name];
			if (value === undefined) {
				// What `reg` does when the key or value is absent: exits non-zero, which
				// reaches the caller as a rejected promise.
				return Promise.reject(
					new Error('ERROR: The system was unable to find the specified registry key')
				);
			}
			return Promise.resolve(`\r\n${args[1]}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`);
		}
		if (args[0] === 'add') {
			existing[args[3] ?? ''] = args[7] ?? '';
		}
		return Promise.resolve('');
	};
	const writes = () => calls.filter((c) => c[0] === 'add').map((c) => [c[3], c[7]]);
	return { command, calls, writes };
}

const run = (reg: ReturnType<typeof fakeReg>, platform: NodeJS.Platform = 'win32') =>
	registerWindowsIdentity({
		appId: APP_ID,
		displayName: 'Open Desktop Authenticator',
		userDataPath: userData,
		platform,
		reg: reg.command
	});

describe('parsing reg output', () => {
	// The shapes below are copied from real `reg query` output on Windows 11.
	it('reads a REG_SZ value', () => {
		const out =
			'\r\nHKEY_CURRENT_USER\\...\r\n    DisplayName    REG_SZ    Cloudflare One Client\r\n';
		expect(parseRegValue(out, 'DisplayName')).toBe('Cloudflare One Client');
	});

	it('keeps spaces inside a value but not around it', () => {
		expect(
			parseRegValue('    DisplayName    REG_SZ    Open Desktop Authenticator  ', 'DisplayName')
		).toBe('Open Desktop Authenticator');
	});

	it('treats an empty value as absent', () => {
		// Not hypothetical: Cloudflare's client ships `IconUri` set to empty. Reading
		// that as a value would mean never writing a real one.
		expect(parseRegValue('    IconUri    REG_SZ    \r\n', 'IconUri')).toBeUndefined();
	});

	it('ignores a value of another type', () => {
		// Windows' own AccountHealth toast uses REG_EXPAND_SZ. Anything that is not
		// the type we write is not ours, and gets replaced rather than trusted.
		expect(
			parseRegValue('    IconUri    REG_EXPAND_SZ    %SystemRoot%\\a.png', 'IconUri')
		).toBeUndefined();
	});

	it('does not match a value whose name merely ends with ours', () => {
		// What the anchor is actually for — worth stating, because the obvious test
		// for it does not test it. A *prefix* collision like `DisplayNameTwo` cannot
		// match even unanchored, since `Two` is not the whitespace the pattern needs
		// next; the first version of this test asserted that and passed with the
		// anchor removed. A name *ending* in ours is the one an unanchored pattern
		// happily matches inside.
		const out = '    MyDisplayName    REG_SZ    wrong\r\n    DisplayName    REG_SZ    right\r\n';
		expect(parseRegValue(out, 'DisplayName')).toBe('right');
	});
});

describe('registering', () => {
	it('does nothing at all off Windows', async () => {
		// The concept does not exist there, and neither does `reg`.
		const reg = fakeReg();
		await run(reg, 'linux');
		expect(reg.calls).toEqual([]);
		expect(() => readFileSync(join(userData, 'notification-icon.png'))).toThrow();
	});

	it('writes both values when nothing is registered yet', async () => {
		const reg = fakeReg();
		await run(reg);
		expect(reg.writes()).toEqual([
			['DisplayName', 'Open Desktop Authenticator'],
			['IconUri', join(userData, 'notification-icon.png')]
		]);
	});

	it('writes nothing when both are already correct', async () => {
		// The reason it reads before it writes: this runs on every single launch,
		// and an unchanged install has no business touching the registry.
		const reg = fakeReg({
			DisplayName: 'Open Desktop Authenticator',
			IconUri: join(userData, 'notification-icon.png')
		});
		await run(reg);
		expect(reg.writes()).toEqual([]);
	});

	it('writes only the value that is wrong', async () => {
		const reg = fakeReg({
			DisplayName: 'Some Older Name',
			IconUri: join(userData, 'notification-icon.png')
		});
		await run(reg);
		expect(reg.writes()).toEqual([['DisplayName', 'Open Desktop Authenticator']]);
	});

	it('stays inside its own key', async () => {
		// A registry write is the kind of thing that should be provably narrow.
		const reg = fakeReg();
		await run(reg);
		expect(reg.calls.length).toBeGreaterThan(0);
		for (const call of reg.calls) {
			expect(call[1]).toBe(KEY);
		}
	});

	it('survives reg being missing entirely', async () => {
		// It controls a caption on a notification. Nothing here is worth a failed
		// launch, so the whole thing swallows its errors — asserted, because
		// "it's in a try/catch" is not the same as "it returns".
		const exploding = {
			command: () => Promise.reject(new Error('spawn reg ENOENT')),
			calls: [],
			writes: () => []
		};
		await expect(run(exploding as unknown as ReturnType<typeof fakeReg>)).resolves.toBeUndefined();
	});
});

describe('the icon it points at', () => {
	it('writes a real 256px PNG where Windows can read it', async () => {
		// Not inside the asar archive, which Windows cannot see into, and big enough
		// that the ~48px a toast draws at is always a downscale.
		await run(fakeReg());
		const bytes = readFileSync(join(userData, 'notification-icon.png'));
		expect(bytes.subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		);
		// IHDR width and height, straight after the 8-byte signature and length/type.
		expect(bytes.readUInt32BE(16)).toBe(256);
		expect(bytes.readUInt32BE(20)).toBe(256);
	});

	it('leaves an already-correct icon alone', async () => {
		await run(fakeReg());
		const path = join(userData, 'notification-icon.png');
		const first = readFileSync(path);
		const before = readFileSync(path).length;
		await run(fakeReg());
		expect(readFileSync(path).equals(first)).toBe(true);
		expect(readFileSync(path).length).toBe(before);
	});

	it('replaces one that does not match the current mark', async () => {
		// So changing the logo propagates to the notification rather than leaving a
		// stale image behind on every machine that ever ran an older build.
		const path = join(userData, 'notification-icon.png');
		writeFileSync(path, Buffer.from('not a png'));
		await run(fakeReg());
		expect(readFileSync(path).length).toBeGreaterThan(1000);
		expect(readFileSync(path).subarray(1, 4).toString('ascii')).toBe('PNG');
	});
});
