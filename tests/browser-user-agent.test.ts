import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as browser from '../src/main/browser/window';

type BrowserUserAgent = (
	chromiumVersion: string,
	platform: NodeJS.Platform,
	architecture: NodeJS.Architecture
) => string;

/*
 * Keep the pre-fix module loadable so this suite demonstrates the behavioural
 * failure rather than stopping at "missing export". Once the helper exists,
 * every assertion below exercises it directly. Before then, the fallback is the
 * exact frozen value the application currently sends and the platform/version
 * cases fail for the reason this regression is meant to capture.
 */
const browserUserAgent: BrowserUserAgent =
	(browser as { browserUserAgent?: BrowserUserAgent }).browserUserAgent ??
	(() => browser.BROWSER_USER_AGENT);

const ROOT = join(__dirname, '..');
const BROWSER_SOURCE = join(ROOT, 'src', 'main', 'browser');

describe('the account browser identifies the Chromium it actually embeds', () => {
	it('uses the supplied Chromium version without an Electron product token', () => {
		const userAgent = browserUserAgent('151.2.3456.78', 'win32', 'x64');

		expect(userAgent).toContain('Chrome/151.2.3456.78');
		expect(userAgent).not.toMatch(/Electron\//i);
	});

	it.each([
		['win32', 'x64', 'Windows NT 10.0; Win64; x64'],
		['win32', 'arm64', 'Windows NT 10.0; ARM64'],
		['darwin', 'x64', 'Macintosh; Intel Mac OS X 10_15_7'],
		// Chromium deliberately keeps its long-standing macOS compatibility token
		// on Apple Silicon. The architecture input is still covered so a future
		// branch cannot accidentally turn macOS into a Windows or Linux identity.
		['darwin', 'arm64', 'Macintosh; Intel Mac OS X 10_15_7'],
		['linux', 'x64', 'X11; Linux x86_64'],
		['linux', 'arm64', 'X11; Linux aarch64']
	] as const)(
		'uses the Chromium-compatible platform token for %s/%s',
		(platform, architecture, expected) => {
			const userAgent = browserUserAgent('151.2.3456.78', platform, architecture);

			expect(userAgent).toContain(`(${expected})`);
			expect(userAgent).toContain('Chrome/151.2.3456.78');
		}
	);

	it('initialises the shipped value from the running Electron process', () => {
		const source = readFileSync(join(BROWSER_SOURCE, 'window.ts'), 'utf8');
		const initialiser = source.slice(
			source.indexOf('export const BROWSER_USER_AGENT'),
			source.indexOf('export const START_URL')
		);

		expect(initialiser).toContain('process.versions.chrome');
		expect(initialiser).toContain('process.platform');
		expect(initialiser).toContain('process.arch');
	});

	it('contains no frozen Chrome 140 identity on the product browser path', () => {
		const productSource = readdirSync(BROWSER_SOURCE)
			.filter((name) => name.endsWith('.ts'))
			.map((name) => readFileSync(join(BROWSER_SOURCE, name), 'utf8'))
			.join('\n');

		expect(productSource).not.toMatch(/Chrome\/140(?:\.0){0,3}/);
	});
});
