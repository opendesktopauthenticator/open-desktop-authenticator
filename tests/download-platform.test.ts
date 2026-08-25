import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Which download the site puts in front of a visitor.
 *
 * `/download` offers the Microsoft Store to Windows and the release page to
 * Linux, because a Store link is inert on Linux and a hash-verification ritual
 * is the wrong thing to hand a frightened Windows user who has a signed package
 * available to them. Getting the platform wrong therefore does not degrade the
 * page politely — it recommends the route that cannot work.
 *
 * The detection is four regexes over strings browsers have been lying about for
 * thirty years, so it is asserted rather than trusted. Android is the case that
 * makes this a test instead of a glance: its user agent says `Linux`, and a
 * naive check hands a phone user a `.deb`.
 */

const SOURCE = readFileSync(join(__dirname, '..', 'site', 'assets', 'download.js'), 'utf8');

/** Run the real asset against a faked navigator and report what it stamped. */
function detect(userAgent: string, userAgentData: { platform: string } | null): string | undefined {
	const element = {
		attributes: {} as Record<string, string>,
		setAttribute(name: string, value: string) {
			this.attributes[name] = value;
		}
	};
	const document = { querySelector: () => element };
	const navigator = {
		userAgentData,
		platform: userAgentData ? userAgentData.platform : '',
		userAgent
	};
	// The real asset, run as a browser would run it, against a faked global.
	// `node:vm` rather than a Function constructor: this is deliberately
	// executing a script from disk, and saying so plainly is better than
	// smuggling it past a lint rule that exists for good reason.
	runInNewContext(SOURCE, { document, navigator });
	return element.attributes['data-platform'];
}

describe('the download page picks a platform', () => {
	it.each([
		[
			'Windows 11, Chrome',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140',
			{ platform: 'Windows' }
		],
		[
			'Windows, Firefox — no userAgentData',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/130',
			null
		]
	])('offers the Store on %s', (_label, agent, data) => {
		expect(detect(agent, data)).toBe('windows');
	});

	it.each([
		['Ubuntu, Firefox', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Firefox/130', null],
		['Linux, Chrome', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', { platform: 'Linux' }]
	])('offers the release page on %s', (_label, agent, data) => {
		expect(detect(agent, data)).toBe('linux');
	});

	/*
	 * The whole reason this file exists.
	 *
	 * Android reports `Linux` in its user agent. Matching on that alone sends a
	 * phone to a page offering an AppImage and a .deb, for an application that
	 * does not run on phones at all.
	 */
	it('does not mistake Android for Linux', () => {
		const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile';
		expect(detect(android, null)).toBe('other');
	});

	it.each([
		['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605'],
		['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15']
	])('falls back to showing everything on %s', (_label, agent) => {
		expect(detect(agent, null)).toBe('other');
	});

	/*
	 * An unrecognised platform must leave the page alone rather than hide
	 * options, and the markup must carry the hook the script looks for — if
	 * `data-download` is ever renamed in the page, this silently stops running
	 * and every visitor quietly gets the undifferentiated list.
	 */
	it('keys off an attribute the download page actually has', () => {
		expect(SOURCE).toContain('[data-download]');
		const page = readFileSync(join(__dirname, '..', 'site', 'pages', 'guides.mjs'), 'utf8');
		expect(page).toContain('data-download');
	});
});
