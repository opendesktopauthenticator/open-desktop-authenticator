import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The strings SignPath Foundation requires, asserted literally.
 *
 * https://signpath.org/terms.html sets conditions that are quoted text rather
 * than a topic: the term "Code signing policy" must appear on the home page and
 * the download/release pages, and the attribution must read exactly
 *
 *   Free code signing provided by SignPath.io, certificate by SignPath Foundation
 *
 * A paraphrase is a failed condition, not a stylistic variation — and every
 * other sentence on this site is written to be improved by whoever edits it
 * next, which is precisely the habit that would quietly break this one. So the
 * exact wording is pinned here, where an edit that "reads better" fails the
 * build instead of the application.
 */

const root = join(__dirname, '..');
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

const POLICY = read('site', 'pages', 'code-signing.mjs');
const HOME = read('site', 'pages', 'home.mjs');
const DOWNLOAD = read('site', 'pages', 'guides.mjs');
const INDEX = read('site', 'pages', 'index.mjs');

/** SignPath's required sentence, character for character. */
const ATTRIBUTION = 'Free code signing provided by SignPath.io, certificate by SignPath Foundation';

describe('the code signing policy SignPath Foundation requires', () => {
	it('carries their attribution sentence exactly', () => {
		expect(POLICY).toContain(ATTRIBUTION);
	});

	it('is a real page in the site, not an orphan file', () => {
		expect(INDEX).toContain('codeSigningPolicy');
		expect(POLICY).toContain("slug: 'code-signing-policy'");
	});

	/*
	 * "on your project's home page and download/release pages (section header or
	 * link to a dedicated page)" — so the literal term has to be present in both
	 * places, not merely a link with different wording.
	 */
	it.each([
		['the home page', () => HOME],
		['the download page', () => DOWNLOAD]
	])('uses the term "Code signing policy" on %s', (_where, source) => {
		expect(source()).toMatch(/code signing policy/i);
		expect(source()).toContain('/code-signing-policy');
	});

	it('names both required roles', () => {
		expect(POLICY).toMatch(/Committers and reviewers/);
		expect(POLICY).toMatch(/Approvers/);
	});

	it('states the multi-factor requirement', () => {
		expect(POLICY).toMatch(/multi-factor authentication/i);
	});

	/*
	 * Their terms accept either a link to a privacy policy or the specific
	 * "will not transfer any information" sentence. This page does both, because
	 * the sentence is true of the application and the link covers the website,
	 * which collects things the application does not.
	 */
	it('covers privacy by link and by statement', () => {
		expect(POLICY).toContain('/privacy');
		expect(POLICY).toMatch(/will not transfer any information to other networked systems/);
	});

	/*
	 * The claim must not drift ahead of reality. Until a certificate exists the
	 * page has to say so.
	 *
	 * The flag carrying that meaning is `codeSigned`, not `signed` — this test
	 * asserted `signed: false` and started failing the moment the checksum list
	 * gained a sigstore signature and `signed` flipped true. That is the split
	 * working: one flag used to mean "the list is signed" and "the binaries are
	 * signed" at once, and a test written against the old name is exactly what
	 * should break when the two are separated.
	 */
	it('does not claim a certificate it does not have', () => {
		expect(POLICY).toMatch(/has not been granted yet/);
		const build = read('site', 'build.mjs');
		expect(build).toMatch(/codeSigned:\s*false/);
	});
});
