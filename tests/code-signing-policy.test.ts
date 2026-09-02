import { readdirSync, readFileSync } from 'node:fs';
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
 *
 * **Every page, not a hand-picked few.** The first version of this listed four
 * constants and passed while five other surfaces still said "yet" — the download
 * page contradicted itself a hundred lines apart, `/verify` named a future
 * signer, and the release-notes template published on every GitHub release said
 * the same. A guard that only looks where you remembered to look is how that
 * happened, so this reads the whole directory.
 */
describe('what the project says about signing', () => {
	const SURFACES: [string, string][] = [
		...readdirSync(join(root, 'site', 'pages'))
			.filter((name) => name.endsWith('.mjs'))
			.map((name): [string, string] => [`site/pages/${name}`, read('site', 'pages', name)]),
		['site/markup.mjs', read('site', 'markup.mjs')],
		['site/build.mjs', BUILD],
		['README.md', read('README.md')],
		['.github/workflows/release.yml', read('.github', 'workflows', 'release.yml')]
	];

	it('has surfaces to check at all', () => {
		expect(
			SURFACES.length,
			'nothing was read, so every assertion below is vacuous'
		).toBeGreaterThan(8);
	});

	/*
	 * "not signed yet" about the **checksum list** is deliberately not matched:
	 * that gap is real and still pending. What must not survive is a claim about
	 * a *code-signing certificate* arriving.
	 */
	const PENDING =
		/code[- ]signing certificate yet|certificate yet|are applying to|application is in progress|has not been granted|once (that|the certificate) is granted|until the SignPath|when signing exists|blocked on SignPath/i;

	it.each(SURFACES)('%s does not say a certificate is coming', (_where, source) => {
		const hit = PENDING.exec(source);
		expect(
			hit?.[0],
			'this surface still tells the reader a code-signing certificate is on its way, which it ' +
				'is not — the SignPath Foundation application was declined and none is planned'
		).toBeUndefined();
	});

	/*
	 * And the honest statement is still there. Removing a false claim by deleting
	 * the whole subject would leave a reader with no idea whether the file they
	 * downloaded is signed, which is worse than the claim was.
	 */
	it('still tells the reader the direct downloads are unsigned', () => {
		expect(POLICY).toMatch(/not code-signed|carry a code-signing certificate/i);
		expect(DOWNLOAD).toMatch(/no code-signing certificate, and none is planned/i);
	});

	it('says so on the verification page too, where the check comes back NotSigned', () => {
		expect(read('site', 'pages', 'safety.mjs')).toMatch(/none is planned/i);
	});

	it('still derives that from the flag rather than prose alone', () => {
		expect(BUILD).toMatch(/codeSigned:\s*false/);
	});
});
