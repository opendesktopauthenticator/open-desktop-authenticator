import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The site must not tell people to hash a file that does not exist.**
 *
 * `/verify` is the page whose whole argument is "check us rather than trust
 * us", and it prints the commands to run — with the installer's filename in
 * them, and the version inside that filename. Three of those were typed by
 * hand as `1.0.0`, so the first release after that one would have published
 * instructions naming an artifact nobody could download, on the one page where
 * being wrong costs the most: somebody following it gets "no such file",
 * concludes the verification story is broken, and skips it.
 *
 * `SITE.version` already read the built `package.json`. The page simply did not
 * use it, and nothing noticed — the site's own checks passed with the stale
 * version in place, which is why this exists rather than a corrected string.
 *
 * Asserted against the rendered page rather than the source, so a page that
 * stops interpolating fails here even if the helper is still correct.
 */

const ROOT = join(__dirname, '..');

/** The version that is actually built, which is the only right answer. */
const version = (
	JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * Every release filename the built site prints, wherever it prints one.
 *
 * Matched on the product's own artifact-name shape rather than on a list of
 * pages: a filename typed onto a different page tomorrow is the same defect,
 * and a guard that only looks at `/verify` would not see it.
 */
function publishedFilenames(): string[] {
	const dist = join(ROOT, 'site', 'dist');
	const found = new Set<string>();
	const files = readdirRecursive(dist).filter((name) => name.endsWith('.html'));
	for (const file of files) {
		const html = readFileSync(file, 'utf8');
		for (const match of html.matchAll(/open-desktop-authenticator-([0-9][^\s"'<]*)/g)) {
			found.add(match[0]);
		}
	}
	return [...found];
}

function readdirRecursive(dir: string): string[] {
	// Kept local and tiny: importing a walker for this would be more code than
	// the walk.
	let out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out = out.concat(readdirRecursive(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

describe('the release filenames the site publishes', () => {
	const names = publishedFilenames();

	it('are there at all, so this is not passing on an empty set', () => {
		expect(
			names.length,
			'no release filename was found in the built site, so the check below measured nothing — ' +
				'run `node site/build.mjs` first'
		).toBeGreaterThan(0);
	});

	it('name the version that is actually built', () => {
		const wrong = names.filter((name) => !name.includes(`-${version}-`));

		expect(
			wrong,
			`these tell somebody to verify a download that does not exist. The build is ${version}`
		).toEqual([]);
	});
});
