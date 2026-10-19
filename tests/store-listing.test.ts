import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **The Store listing, which nothing else in this repository can see.**
 *
 * `docs/STORE_LISTING.md` says it plainly: a listing is re-entered in Partner
 * Center on every submission, so it is the one piece of user-facing copy that
 * can drift from the site and the README without a single check going red.
 *
 * It already has. Submission 1 shipped "our download button only ever links a
 * file published on our GitHub releases page", written when GitHub was the only
 * channel — and it stopped being true the moment the listing itself existed.
 * The sentence is the anti-counterfeit warning, and it is displayed *on the
 * Store page*, so the people it reaches are the ones who just installed from the
 * Store, being told that genuine builds come only from somewhere else and that
 * "anything else claiming to be this application is not ours".
 *
 * These check the file, which is what gets pasted into Partner Center. They
 * cannot check what is live — nothing here can — but they stop the source of
 * that paste from going wrong again, and they keep it agreeing with the site
 * that says the same thing to the same people.
 */

const LISTING = readFileSync(join(__dirname, '..', 'docs', 'STORE_LISTING.md'), 'utf8');
const GUIDES = readFileSync(join(__dirname, '..', 'site', 'pages', 'guides.mjs'), 'utf8');

/** The listing's anti-counterfeit paragraph, without its blockquote markers. */
const warning = (() => {
	const start = LISTING.indexOf('> BEFORE YOU INSTALL ANYTHING ELSE');
	expect(start, 'the anti-counterfeit paragraph is gone from the listing').toBeGreaterThan(-1);
	const end = LISTING.indexOf('> Source, documented threat model', start);
	expect(end, 'the anti-counterfeit paragraph has no end marker').toBeGreaterThan(start);
	return LISTING.slice(start, end).replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
})();

describe('the Store listing copy', () => {
	it('names all four official download sources', () => {
		expect(warning).toMatch(/four official download sources/i);
		expect(warning).toMatch(/Microsoft Store|This listing/i);
		expect(warning).toMatch(/GitHub releases page/);
		expect(warning).toContain('Softonic');
		expect(warning).toContain('Uptodown');
	});

	/**
	 * The exact sentence that shipped, refused by name.
	 *
	 * A general "mentions both" check would pass on a paragraph that named the
	 * Store somewhere else and still told the reader the download button only
	 * ever points at GitHub. This is the wording that was actually wrong.
	 */
	it('does not say the download button links only to GitHub', () => {
		expect(
			warning,
			'the wording that told Store users their copy was not genuine is back'
		).not.toMatch(/only ever links a file published on our GitHub releases page/);
	});

	/*
	 * The product website links to downloads without serving installers itself.
	 */
	it('still says the website hosts no installer', () => {
		expect(warning).toMatch(/hosts no installer/i);
	});

	it('agrees with the site, which tells the same people the same thing', () => {
		// All four sources must be described as official, while downloaded files
		// still need the verification appropriate to their package.
		expect(GUIDES).toMatch(/four official download sources/i);
		expect(warning).toMatch(
			/four official download sources are this Microsoft Store listing, our GitHub releases page, Softonic and Uptodown/i
		);
		expect(GUIDES).toContain('Softonic');
		expect(GUIDES).toContain('Uptodown');
		expect(warning).toContain('https://open-desktop-authenticator.en.softonic.com/');
		expect(warning).toMatch(/Softonic lists a Windows x64 download/);
		expect(warning).toContain('https://open-desktop-authenticator.en.uptodown.com/windows');
		expect(warning).toMatch(/Uptodown offers Windows x64/);
		expect(warning).toMatch(/Softonic displays Official distributor and Trusted Program labels/);
		expect(warning).toMatch(/authorization from the developer or its designated representative/);
		expect(warning).toMatch(/Trusted Program reflects the VirusTotal scan reported by Softonic/);
		expect(warning).toMatch(/separate Softonic downloader instead of the original ODA installer/);
		expect(warning).toMatch(/Resolution is not verified/);
		expect(warning).toMatch(/checksums, build provenance and publisher-signature/);
		expect(warning).not.toMatch(
			/three official download sources|only two places|primary release channels|recognized external|anything else claiming to be this application is not ours/i
		);
	});

	/*
	 * The ID is in the file so a reader can check they are looking at the right
	 * listing, and `electron-builder.config.mjs` packages against the identity in
	 * `store-identity.mjs`. Two records of one product that can disagree.
	 */
	it('carries the Store ID the listing is for', () => {
		expect(LISTING).toContain('9NMM2XJ6HZ1D');
	});

	/**
	 * **The note that says the live listing is behind this file.**
	 *
	 * It is load-bearing: without it a reader compares the file to the Store
	 * page, finds them different, and has no way to tell whether the file is the
	 * fix or the drift. It should be deleted in the submission that lands the
	 * corrected wording — and this test is what makes that deletion deliberate
	 * rather than forgotten, because it fails if the note goes while the
	 * "one sentence behind" state it describes has not been resolved anywhere.
	 */
	it('keeps a note saying the live listing has not caught up yet', () => {
		expect(
			LISTING,
			'either the note went without the submission, or the submission went without removing it'
		).toMatch(/live listing is one sentence behind|submission/i);
	});
});
