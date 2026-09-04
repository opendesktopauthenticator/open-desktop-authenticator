import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	applicationWindows,
	isAccountBrowserWindow,
	markAccountBrowserWindow,
	preferredApplicationWindow
} from '../src/main/window-role';

const source = (path: string): string =>
	readFileSync(join(__dirname, '..', path), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/.*$/gm, ' ');

const MAIN = source('src/main/index.ts');
const HOST = source('src/main/browser/electron-host.ts');
const IMPORT_IPC = source('src/main/import/ipc.ts');
const VAULT_IPC = source('src/main/vault/ipc.ts');

describe('native window roles', () => {
	it('marks an account browser without changing or retaining its public shape', () => {
		const account = { name: 'account' };

		expect(markAccountBrowserWindow(account)).toBe(account);
		expect(isAccountBrowserWindow(account)).toBe(true);
		expect(isAccountBrowserWindow({ name: 'other' })).toBe(false);
	});

	it('returns only application windows from a mixed BrowserWindow enumeration', () => {
		const main = { name: 'main' };
		const account = markAccountBrowserWindow({ name: 'trade' });

		expect(applicationWindows([account, main])).toEqual([main]);
	});

	it('uses a focused application window', () => {
		const main = { name: 'main' };
		const otherApp = { name: 'other app surface' };

		expect(preferredApplicationWindow(otherApp, [main, otherApp])).toBe(otherApp);
	});

	it('falls back to the main window when an account browser has focus', () => {
		const main = { name: 'main' };
		const account = markAccountBrowserWindow({ name: 'trade' });

		expect(preferredApplicationWindow(account, [account, main])).toBe(main);
	});

	it('never returns an account browser when no application window exists', () => {
		const account = markAccountBrowserWindow({ name: 'trade' });

		expect(preferredApplicationWindow(account, [account])).toBeUndefined();
		expect(preferredApplicationWindow(undefined, [account])).toBeUndefined();
	});

	it('marks the account BrowserWindow immediately after constructing it', () => {
		const construction = HOST.indexOf('const window = new BrowserWindow(');
		const mark = HOST.indexOf('markAccountBrowserWindow(window)', construction);
		const toolbar = HOST.indexOf('const chrome = window.webContents', construction);

		expect(construction).toBeGreaterThanOrEqual(0);
		expect(mark).toBeGreaterThan(construction);
		expect(mark).toBeLessThan(toolbar);
	});

	it('filters every main-only enumeration and dialog parent', () => {
		expect(MAIN.match(/applicationWindows\(BrowserWindow\.getAllWindows\(\)\)/g)).toHaveLength(3);
		expect(MAIN.match(/preferredApplicationWindow\(/g)).toHaveLength(2);
		expect(IMPORT_IPC.match(/preferredApplicationWindow\(/g)).toHaveLength(1);
		expect(VAULT_IPC.match(/preferredApplicationWindow\(/g)).toHaveLength(1);

		for (const file of [MAIN, IMPORT_IPC, VAULT_IPC]) {
			expect(file).not.toMatch(
				/getFocusedWindow\(\)\s*\?\?\s*BrowserWindow\.getAllWindows\(\)\[0\]/
			);
		}
	});

	it('keeps the Windows session-end listener intentionally global', () => {
		const allWindowLoops = MAIN.match(/for \(const \w+ of BrowserWindow\.getAllWindows\(\)\)/g);
		expect(allWindowLoops).toHaveLength(1);
		expect(MAIN).toMatch(
			/for \(const existing of BrowserWindow\.getAllWindows\(\)\)\s*\{\s*existing\.on\('session-end', endOfSession\)/
		);
	});
});
