import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What a published artifact is called, and why it may not contain a space.
 *
 * `SHA256SUMS.txt` is generated in CI from the staging directory. GitHub then
 * replaces spaces with dots when it stores a release asset — so with
 * `${productName}` in the name, every filename in the checksum file disagreed
 * with the file a user actually downloads. The documented way to use it is
 * `sha256sum --check SHA256SUMS.txt`, which reports "No such file or directory"
 * for every line: the one file whose entire job is verification, failing at it,
 * while every hash inside it was correct.
 *
 * That was found by verifying a real download by hand. Nothing else could have
 * found it — the hashes matched, CI was green, and the release page looked
 * complete.
 *
 * The three names have to agree: what the builder produces, what the checksum
 * file lists, and what the site tells people to type.
 */

const BUILDER = readFileSync(join(__dirname, '..', 'electron-builder.config.mjs'), 'utf8');
const SAFETY = readFileSync(join(__dirname, '..', 'site', 'pages', 'safety.mjs'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
	name: string;
};

/** Every `artifactName` template the config declares. */
const templates = [...BUILDER.matchAll(/artifactName: '([^']+)'/g)].map((m) => m[1] as string);

describe('published artifact names', () => {
	it('declares one for every target', () => {
		// NSIS, portable, and the shared Linux template.
		expect(templates).toHaveLength(3);
	});

	it('never interpolates the product name, which contains spaces', () => {
		for (const template of templates) {
			expect(template, template).not.toContain('${productName}');
		}
	});

	it('builds from the package name instead', () => {
		// `open-desktop-authenticator` — already hyphenated, already lower case.
		expect(pkg.name).not.toMatch(/\s/);
		for (const template of templates) {
			expect(template, template).toContain('${name}');
		}
	});

	it('produces nothing GitHub would rename', () => {
		// A literal space anywhere in the template survives into the filename.
		for (const template of templates) {
			expect(template, template).not.toMatch(/\s/);
		}
	});
});

describe('the verification instructions name real files', () => {
	it('uses the package name in its examples', () => {
		// The page previously said `OpenDesktopAuthenticator-Setup.exe`, which
		// matched neither the artifacts nor the checksum file — a third spelling.
		expect(SAFETY).toContain(`${pkg.name}-`);
		expect(SAFETY).not.toContain('OpenDesktopAuthenticator-Setup.exe');
		expect(SAFETY).not.toContain('OpenDesktopAuthenticator.AppImage');
	});

	it('still offers the bulk check, which is the one that was broken', () => {
		expect(SAFETY).toContain('sha256sum --check SHA256SUMS.txt');
	});

	it('warns that PowerShell prints upper case', () => {
		// Not cosmetic. Somebody verifying carefully sees a wall of capitals against
		// a lower-case list and concludes their download is wrong.
		expect(SAFETY).toMatch(/upper case/i);
	});
});
