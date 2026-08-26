import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The sentences that describe what this project has not done yet.
 *
 * These went wrong in the way that matters most on a site whose argument is
 * "verify us rather than trust us": the homepage said **nothing signs the
 * checksum list** for as long as the checksum list had been signed, two
 * paragraphs below a hero that read the flag correctly and said the opposite.
 * The page contradicted itself, and it did so by understating its own security.
 *
 * `site/build.mjs` already carried the rule — "every status claim on the site
 * renders from this object" — but the rule was written down and not enforced,
 * and two paragraphs were typed by hand. So the gap list is derived now, and
 * this is what stops it being typed by hand again.
 *
 * Deliberately at the seam rather than on the helper alone: a correct
 * `releaseGaps` is worth nothing if a page stops calling it.
 */

type Release = Record<string, boolean>;

let markup: typeof import('../site/markup.mjs', { with: { 'resolution-mode': 'import' } });
let pages: typeof import('../site/pages/index.mjs', { with: { 'resolution-mode': 'import' } });

/**
 * Pages are reached through `PAGES`, the same list the generator renders from,
 * rather than by importing each module. A page that stopped being in the list
 * would still pass a test that imported it directly.
 */
const page = (slug: string) => {
	const found = pages.PAGES.find((candidate) => candidate.slug === slug);
	if (!found) {
		throw new Error(`no page with slug ${slug}`);
	}
	return found;
};

// `beforeAll` rather than top-level await: this suite compiles as CommonJS, so
// the await is a type error even though vitest runs it happily. Every closure
// below is lazy, so they see these once they are assigned.
beforeAll(async () => {
	markup = await import('../site/markup.mjs');
	pages = await import('../site/pages/index.mjs');
});

/** Nothing done yet — the state the hand-written prose was originally true for. */
const NOTHING: Release = {
	published: true,
	checksums: true,
	signed: false,
	codeSigned: false,
	reproducible: false,
	audited: false
};

const site = (release: Release) => ({ release });
const gaps = (release: Release, form?: 'clause' | 'noun') =>
	markup.releaseGaps(site(release), form);

/** The rendered paragraph, with tags and runs of whitespace flattened away. */
const words = (html: string) =>
	html
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

describe('which gaps are still open', () => {
	it('lists all four when none of them is done', () => {
		expect(gaps(NOTHING)).toHaveLength(4);
	});

	/*
	 * The regression itself. `signed` went true when the release workflow
	 * started signing SHA256SUMS.txt with cosign; the sentence did not notice.
	 */
	it('drops the signing gap once the checksum list is signed', () => {
		const open = gaps({ ...NOTHING, signed: true });
		expect(open).toHaveLength(3);
		expect(open.join(' ')).not.toMatch(/signs the checksum list/i);
	});

	/*
	 * A signature over a list nobody publishes is not something to claim. This
	 * is the one combination where the flag being true does *not* close the gap,
	 * so it is worth pinning rather than leaving to the reader of the condition.
	 */
	it('keeps the signing gap if the checksum list is not published at all', () => {
		expect(gaps({ ...NOTHING, checksums: false, signed: true }).join(' ')).toMatch(
			/signs the checksum list/i
		);
	});

	it('has nothing to say when everything is done', () => {
		const done = {
			published: true,
			checksums: true,
			signed: true,
			codeSigned: true,
			reproducible: true,
			audited: true
		};
		expect(gaps(done)).toEqual([]);
	});

	it('offers both phrasings, and they differ', () => {
		expect(gaps(NOTHING, 'clause')).not.toEqual(gaps(NOTHING, 'noun'));
		// "what is missing is …" versus "not yet done: …".
		expect(gaps(NOTHING, 'clause')[0]).toMatch(/^nothing signs/);
		expect(gaps(NOTHING, 'noun')[0]).toMatch(/^signing/);
	});
});

describe('the grammar around the list', () => {
	it.each([
		[[], ''],
		[['a'], 'a'],
		[['a', 'b'], 'a and b'],
		[['a', 'b', 'c'], 'a, b, and c'],
		[['a', 'b', 'c', 'd'], 'a, b, c, and d']
	])('joins %j as "%s"', (items, expected) => {
		expect(markup.sentenceList(items)).toBe(expected);
	});

	it.each([
		[0, 'Nothing is'],
		[1, 'One thing is'],
		[2, 'Two things are'],
		[3, 'Three things are'],
		[4, 'Four things are']
	])('agrees the verb with %i', (n, expected) => {
		expect(markup.countPhrase(n)).toBe(expected);
	});
});

/**
 * The seam. Each of these renders the real page body against a made-up release
 * object, which is the only way to catch a page that quietly stops deriving.
 */
describe('the pages that carry the sentence', () => {
	it.each([
		['the homepage', (s: unknown) => page('index').body(s)],
		['the alternatives page', (s: unknown) => page('alternatives').body(s)],
		['the FAQ', (s: unknown) => page('faq').body(s)]
	])('%s never claims the checksum list is unsigned once it is', (_name, render) => {
		const signed = words(render(site({ ...NOTHING, signed: true })));
		expect(signed).not.toMatch(/signs the checksum list/i);
		expect(signed, 'the sentence disappeared entirely').toMatch(/code-signing certificate/i);

		// And still says it while it is true, or the check above proves nothing.
		expect(words(render(site(NOTHING)))).toMatch(/checksum list/i);
	});

	it.each([
		['the homepage', (s: unknown) => page('index').body(s)],
		['the alternatives page', (s: unknown) => page('alternatives').body(s)],
		['the FAQ', (s: unknown) => page('faq').body(s)]
	])('%s says something sensible when there is nothing left to admit', (_name, render) => {
		const done = {
			published: true,
			checksums: true,
			signed: true,
			codeSigned: true,
			reproducible: true,
			audited: true
		};
		const text = words(render(site(done)));
		// No dangling "is written down rather than left for you to find: ." and no
		// empty count — the two ways a derived sentence fails at zero.
		expect(text).not.toMatch(/:\s*\./);
		expect(text).not.toMatch(/not yet done:\s*—/);
		expect(text).not.toMatch(/\bthings are not yet done: \./);
	});

	/*
	 * The FAQ is the one that promised the guarantee it was breaking: its last
	 * sentence says the site refuses to build if a page goes on saying something
	 * is missing after it is not, while the paragraph above it said exactly that
	 * about the checksum signature. The promise has to survive the rewrite.
	 */
	it('keeps the FAQ’s enforcement promise, which is now true', () => {
		const text = words(page('faq').body(site({ ...NOTHING, signed: true })));
		expect(text).toMatch(/refuses to build/);
		expect(text).toMatch(/goes on saying it is missing after it is not/);
	});

	/*
	 * The FAQ gives each gap its consequence rather than just its name, and one
	 * of those consequences used to read "are further out still" — which only
	 * parses while something precedes it. Derived, nothing is guaranteed to.
	 */
	it('gives the FAQ a sentence that stands on its own', () => {
		const only = words(
			page('faq').body(site({ ...NOTHING, signed: true, codeSigned: true, audited: true }))
		);
		expect(only).toMatch(/Builds are not yet reproducible/);
		expect(only, 'a dangling comparative with nothing before it').not.toMatch(/further out still/);
	});

	/*
	 * The count word has to move with the list. "Three things are not yet done"
	 * above two items is the same class of error as the one this file exists
	 * for: prose that stopped tracking the thing it describes.
	 */
	it('counts the alternatives page list correctly as gaps close', () => {
		const at = (release: Release) => words(page('alternatives').body(site(release)));
		expect(at(NOTHING)).toMatch(/Four things are not yet done/);
		expect(at({ ...NOTHING, signed: true })).toMatch(/Three things are not yet done/);
		expect(at({ ...NOTHING, signed: true, audited: true })).toMatch(/Two things are not yet done/);
		expect(at({ ...NOTHING, signed: true, audited: true, reproducible: true })).toMatch(
			/One thing is not yet done/
		);
	});
});
