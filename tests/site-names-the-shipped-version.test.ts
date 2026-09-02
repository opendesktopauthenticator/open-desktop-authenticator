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
 * rather than a proxy for it — the filenames must come from `SITE.version`, and
 * a hand-typed one is wrong the moment the version moves, whatever the built
 * output happens to say today.
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
	it('interpolate the built version', () => {
		const interpolated = filenames().filter((entry) => entry.text.includes('${s.version}'));

		expect(
			interpolated.length,
			'no release filename is built from SITE.version, so nothing ties what the site publishes ' +
				'to what the installer is called'
		).toBeGreaterThan(0);
	});
});
