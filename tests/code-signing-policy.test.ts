import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **The page no longer claims a sponsor, and must not start again.**
 *
 * This file used to pin the strings the SignPath Foundation requires — chiefly
 * the attribution "Free code signing provided by SignPath.io, certificate by
 * SignPath Foundation", which their terms quote verbatim and which a paraphrase
 * would fail. The application was declined, so that sentence now names a sponsor
 * who is not sponsoring this project, and every claim that a certificate was
 * coming names a plan that does not exist.
 *
 * So the assertions are inverted. What is pinned now is that no page claims a
 * certificate, a sponsor or an application in progress, and that the pages still
 * say plainly that the direct downloads are unsigned. The page itself stays: who
 * approves a release, and how a stranger verifies one, never depended on the
 * certificate.
 *
 * The absence checks are deliberately about the *claim*, not the word. The
 * policy page still names SignPath once, in the paragraph explaining that the
 * application was declined — recording what happened is the opposite of
 * claiming it.
 */

const root = join(__dirname, '..');
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

const POLICY = read('site', 'pages', 'code-signing.mjs');
const HOME = read('site', 'pages', 'home.mjs');
const DOWNLOAD = read('site', 'pages', 'guides.mjs');
const INDEX = read('site', 'pages', 'index.mjs');
const BUILD = read('site', 'build.mjs');

/** The sentence their terms require of a sponsored project. */
const ATTRIBUTION = 'Free code signing provided by SignPath.io, certificate by SignPath Foundation';

describe('the code signing policy page', () => {
	it('no longer carries a sponsor attribution', () => {
		expect(
			POLICY,
			'the page names SignPath as the sponsor of a certificate this project does not have, ' +
				'which is a false claim on the one page whose subject is who you can trust'
		).not.toContain(ATTRIBUTION);
	});

	it('is a real page in the site, not an orphan file', () => {
		expect(INDEX).toContain('codeSigningPolicy');
		expect(POLICY).toContain("slug: 'code-signing-policy'");
	});

	/*
	 * The page survives the sponsor. Both surfaces still link to it, because "who
	 * approved this release" is a question a reader has whether or not a signature
	 * exists — and a dangling route would be worse than the claim it replaced.
	 */
	it.each([
		['the home page', () => HOME],
		['the download page', () => DOWNLOAD]
	])('is still reachable from %s', (_where, source) => {
		expect(source()).toContain('/code-signing-policy');
	});

	it('still names both accountable roles', () => {
		expect(POLICY).toMatch(/Committers and reviewers/);
		expect(POLICY).toMatch(/Approvers/);
	});

	it('still states the multi-factor requirement', () => {
		expect(POLICY).toMatch(/multi-factor authentication/i);
	});

	it('still covers privacy by link and by statement', () => {
		expect(POLICY).toContain('/privacy');
		expect(POLICY).toMatch(/will not transfer any information to other networked systems/);
	});
});

/**
 * **Nothing anywhere may say a certificate is coming.**
 *
 * The download page said "We are applying to the SignPath Foundation… once that
 * is granted" for as long as that was true, and it stopped being true the moment
 * the application was declined. The same sentence promised it would change when
 * the situation did; this is what holds it to that.
 */
describe('what the site says about signing', () => {
	const PAGES: [string, string][] = [
		['the policy page', POLICY],
		['the download page', DOWNLOAD],
		['the home page', HOME],
		['the build config', BUILD]
	];

	it.each(PAGES)('%s does not say an application is pending', (_where, source) => {
		expect(source).not.toMatch(
			/has not been granted yet|are applying to|application is in progress/i
		);
	});

	it.each(PAGES)('%s does not promise a certificate is coming', (_where, source) => {
		expect(source).not.toMatch(/once (that|the certificate) is granted|until the SignPath/i);
	});

	/*
	 * And the honest statement is still there. Removing a false claim by deleting
	 * the whole subject would leave a reader with no idea whether the file they
	 * downloaded is signed, which is worse than the claim was.
	 */
	it('still tells the reader the direct downloads are unsigned', () => {
		expect(POLICY).toMatch(/not code-signed|carry a code-signing certificate/i);
		expect(DOWNLOAD).toMatch(/not signed by us|are not, so Windows warns/i);
	});

	it('still derives that from the flag rather than prose alone', () => {
		expect(BUILD).toMatch(/codeSigned:\s*false/);
	});
});
