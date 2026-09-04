import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const WINDOW = readFileSync(join(ROOT, 'src', 'main', 'browser', 'window.ts'), 'utf8');
const HOST = readFileSync(join(ROOT, 'src', 'main', 'browser', 'electron-host.ts'), 'utf8');

/** Ignore explanations: the executable code is the identity boundary. */
const withoutComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

describe('the account browser keeps Chromium’s native identity', () => {
	it('does not construct a second, Chrome-only user-agent', () => {
		const executable = withoutComments(WINDOW);

		expect(executable).not.toMatch(/BROWSER_USER_AGENT|browserUserAgent|process\.versions\.chrome/);
		expect(executable).not.toMatch(/Mozilla\/5\.0|AppleWebKit|Safari\/537\.36/);
	});

	it('does not override the session or any initial or popup-adopted tab', () => {
		const executable = `${withoutComments(WINDOW)}\n${withoutComments(HOST)}`;

		expect(executable).not.toMatch(/\.setUserAgent\s*\(/);
		expect(executable).not.toMatch(/\buserAgent\s*:/);
	});

	it('contains no browser automation or fingerprint-evasion switch', () => {
		const executable = `${withoutComments(WINDOW)}\n${withoutComments(HOST)}`;

		expect(executable).not.toMatch(
			/enable-automation|AutomationControlled|remote-debugging|navigator\.webdriver|puppeteer|playwright/i
		);
	});
});
