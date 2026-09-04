import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const WINDOW = readFileSync(join(ROOT, 'src', 'main', 'browser', 'window.ts'), 'utf8');
const HOST = readFileSync(join(ROOT, 'src', 'main', 'browser', 'electron-host.ts'), 'utf8');

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

const MAIN_FILES = sourceFiles(join(ROOT, 'src', 'main')).sort();

/** Ignore explanations: the executable code is the identity boundary. */
const withoutComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

const mainExecutable = (): { name: string; source: string }[] =>
	MAIN_FILES.map((path) => ({
		name: relative(ROOT, path).replaceAll('\\', '/'),
		source: withoutComments(readFileSync(path, 'utf8'))
	}));

describe('the account browser keeps Chromium’s native identity', () => {
	it('does not construct a second, Chrome-only user-agent', () => {
		const executable = withoutComments(WINDOW);

		expect(executable).not.toMatch(/BROWSER_USER_AGENT|browserUserAgent|process\.versions\.chrome/);
		expect(executable).not.toMatch(/Mozilla\/5\.0|AppleWebKit|Safari\/537\.36/);
	});

	it('does not override the session or any initial or popup-adopted tab', () => {
		const executable = `${withoutComments(WINDOW)}\n${withoutComments(HOST)}`;

		expect(executable).not.toMatch(/\.setUserAgent(?:\?\.)?\s*\(/);
		expect(executable).not.toMatch(/\buserAgent\s*:/);
	});

	it('contains no browser automation or fingerprint-evasion switch', () => {
		const executable = mainExecutable()
			.map(({ source }) => source)
			.join('\n');

		expect(executable).not.toMatch(
			/enable-automation|AutomationControlled|remote-debugging|navigator\.webdriver|puppeteer|playwright/i
		);
	});

	it('contains no application-wide browser identity override', () => {
		const executable = mainExecutable()
			.map(({ source }) => source)
			.join('\n');

		expect(executable).not.toMatch(/app\.userAgentFallback\s*=/);
		expect(executable).not.toMatch(
			/appendSwitch\s*\(\s*['"](?:user-agent|enable-automation|remote-debugging-(?:port|pipe))['"]/i
		);
		expect(executable).not.toMatch(/defaultSession\.setUserAgent\s*\(/);
	});

	it('confines Steam-mobile identity rewriting to the two non-browser transports', () => {
		const files = mainExecutable();
		expect(
			files
				.filter(({ source }) => /\.setUserAgent(?:\?\.)?\s*\(/.test(source))
				.map(({ name }) => name)
		).toEqual(['src/main/net/transport.ts']);
		expect(
			files
				.filter(({ source }) => /\.onBeforeSendHeaders\s*\(/.test(source))
				.map(({ name }) => name)
		).toEqual(['src/main/net/transport.ts', 'src/main/steam/system-login-transport.ts']);
	});
});
