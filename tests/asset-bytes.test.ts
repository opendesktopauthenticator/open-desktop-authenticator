import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Published asset URLs must not depend on which machine built the site.
 *
 * Everything in `site/assets/` is served under a content-hashed filename, so
 * these bytes *are* the URL. Two of them were checked out with CRLF endings
 * while the repository held LF, which git hides — `text=auto eol=lf` in
 * `.gitattributes` means git normalises before comparing, so `git status` was
 * clean while the files on disk were sixteen bytes longer than the blobs.
 *
 * The build hashes what is on disk. So a Windows working tree published
 * `exactpic.399f379cd6.svg` and a clean checkout of the same commit produced
 * `exactpic.77e274aa13.svg`: the deployed URL could not be reproduced from the
 * repository it supposedly came from. On a site whose whole argument is "check
 * what we published against the source", that is the wrong bug to have.
 *
 * Text bytes, not line-ending style, is the point — this asserts the property
 * the hash depends on rather than a preference.
 */

const ASSETS = join(__dirname, '..', 'site', 'assets');
/** Formats whose bytes are text, and therefore vulnerable to normalisation. */
const TEXT = /\.(svg|js|css|json|txt|webmanifest)$/i;

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? filesUnder(full) : [full];
	});
}

describe('published assets are byte-identical everywhere', () => {
	const text = filesUnder(ASSETS).filter((f) => TEXT.test(f));

	it('finds the text assets it is meant to be checking', () => {
		// A glob that silently matches nothing is a test that always passes.
		expect(text.length).toBeGreaterThan(0);
	});

	it.each(text.map((f) => [f.slice(f.indexOf('assets')), f]))(
		'%s carries no carriage returns',
		(_label, file) => {
			const bytes = readFileSync(file);
			const cr = bytes.filter((b) => b === 0x0d).length;
			expect(cr, 'CRLF on disk changes this file’s hash, and its hash is its published URL').toBe(
				0
			);
		}
	);
});
