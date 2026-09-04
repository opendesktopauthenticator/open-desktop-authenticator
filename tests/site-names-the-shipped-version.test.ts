import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The site must not tell people to hash a file that does not exist.**
 *
 * `/verify` is the page whose whole argument is "check us rather than trust
 * us", and it prints the commands to run — with the installer's filename in
 * them, and the version inside that filename. Three of those were typed by hand
 * as `1.0.0`, so the first release after that one would have published
 * instructions naming an artifact nobody could download, on the one page where
 * being wrong costs the most: somebody following it gets "no such file",
 * concludes the verification story is broken, and skips it.
 *
 * `SITE.version` already read the built `package.json`. The page simply did not
 * use it, and nothing noticed.
 *
 * ## Why this reads the source rather than the built site
 *
 * Two earlier shapes of this guard were wrong in opposite directions, and both
 * are worth recording because each looked obviously right.
 *
 * Walking `site/dist` failed first: that directory is generated and git-ignored,
 * and both workflows run `npm test` *before* `node site/build.mjs`. It passed
 * locally, where a stale build happened to be lying around, and would have
 * failed every clean CI run on the very commit that added it — a guard that
 * holds only on the machine that wrote it, and that also stops the build.
 *
 * Importing `site/build.mjs` to render the pages was worse. That module writes
 * the whole site at import: thirty-two files, on every test run.
 * `site-release-gaps.test.ts` says so in as many words — "build.mjs writes the
 * site when it runs, and a test must not" — and reads the file instead.
 *
 * So this asks the question that can be asked without either: **does any page
 * put a literal version into a release filename?** That is the defect itself
 * rather than a proxy for it. A filename must come from the latest version
 * explicitly marked as published on GitHub — never from the package version,
 * which can move before there is a file for a visitor to download.
 */

const PAGES = join(__dirname, '..', 'site', 'pages');

/** The product's artifact-name stem, as the release workflow spells it. */
const STEM = 'open-desktop-authenticator-';

function pageSources(): { name: string; source: string }[] {
	return readdirSync(PAGES)
		.filter((name) => name.endsWith('.mjs'))
		.map((name) => ({ name, source: readFileSync(join(PAGES, name), 'utf8') }));
}

/** Every release filename a page spells out, with what follows the stem. */
function filenames(): { page: string; text: string }[] {
	const found: { page: string; text: string }[] = [];
	for (const { name, source } of pageSources()) {
		for (const match of source.matchAll(/open-desktop-authenticator-[^\s"'`<)]*/g)) {
			found.push({ page: name, text: match[0] });
		}
	}
	return found;
}

describe('the release filenames the site publishes', () => {
	it('are there at all, so the check below is not measuring an empty set', () => {
		expect(
			filenames().length,
			`no page mentions ${STEM}..., so the version check measured nothing`
		).toBeGreaterThan(0);
	});

	it('take the version from the build rather than spelling one out', () => {
		const hardcoded = filenames()
			.filter((entry) => /open-desktop-authenticator-[0-9]/.test(entry.text))
			.map((entry) => `${entry.page}: ${entry.text}`);

		expect(
			hardcoded,
			'these name a version that was true when somebody typed it. They tell a reader to verify ' +
				'a download that will not exist after the next release — on the page whose whole ' +
				'argument is that you should check rather than trust'
		).toEqual([]);
	});

	/*
	 * And they interpolate the one value that is derived from the package being
	 * built, rather than some other string that merely is not a digit.
	 */
	it('interpolate the exact version marked as published on GitHub', () => {
		const interpolated = filenames().filter((entry) =>
			entry.text.includes('${s.publication.github.latestVersion}')
		);

		expect(
			interpolated.length,
			'no release filename is built from the independently verified GitHub publication state'
		).toBeGreaterThan(0);
		expect(filenames().some((entry) => entry.text.includes('${s.version}'))).toBe(false);
	});
});

describe('release prose distinguishes source and public versions', () => {
	it('does not call the package version published without an exact channel marker', () => {
		const home = readFileSync(join(PAGES, 'home.mjs'), 'utf8');
		const guides = readFileSync(join(PAGES, 'guides.mjs'), 'utf8');
		const safety = readFileSync(join(PAGES, 'safety.mjs'), 'utf8');

		expect(home).toContain('s.publication.github.current');
		expect(home).toContain('s.publication.store.current');
		expect(guides).toContain('publicationSummary(s)');
		expect(safety).toContain('s.publication.github.latestVersion');
		expect(`${home}\n${guides}\n${safety}`).not.toMatch(
			/Status: 1\.0|\b1\.0 is published|commands apply to 1\.0|\b1\.0 is out/
		);
	});

	it('keeps historical first-release statements explicitly tied to 1.0', () => {
		const all = pageSources()
			.map(({ source }) => source)
			.join('\n');
		expect(all).toContain('Version 1.0 was published on');
	});
});

describe('the 1.5 route notes name the routes the UI actually offers', () => {
	it('describes account proxy, Steam-only through it, and Direct', () => {
		const changelog = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
		const current = changelog.slice(
			changelog.indexOf('## [1.5.0]'),
			changelog.indexOf('## [1.0.0]')
		);
		expect(current).toMatch(/account's\s+proxy/);
		expect(current).toMatch(/Steam-only[^\n]*same proxy/i);
		expect(current).toContain('Direct');
		expect(current).not.toContain('a different one');
	});
});
