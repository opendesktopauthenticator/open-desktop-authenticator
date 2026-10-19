import { beforeAll, describe, expect, it } from 'vitest';

type GoogleIndexingModule = typeof import('../site/google-indexing.mjs', {
	with: { 'resolution-mode': 'import' }
});
type PagesModule = typeof import('../site/pages/index.mjs', {
	with: { 'resolution-mode': 'import' }
});

let indexing: GoogleIndexingModule;
let pages: PagesModule;

beforeAll(async () => {
	indexing = await import('../site/google-indexing.mjs');
	pages = await import('../site/pages/index.mjs');
});

// These lists record the agreed scope independently of the implementation.
const EXCLUDED = [
	'steam-desktop-authenticator',
	'scam-clones',
	'steam-inventory-stolen',
	'what-is-a-mafile',
	'how-to-open-mafile',
	'encrypted-mafile',
	'lost-authenticator',
	'steam-revocation-code',
	'move-steam-authenticator-new-phone',
	'steam-guard-trade-holds',
	'steam-guard-code-not-working',
	'steam-guard-without-phone',
	'steam-mobile-vs-desktop-authenticator',
	'alternatives'
];
const KEPT = [
	'index',
	'verify',
	'security',
	'official',
	'code-signing-policy',
	'move-steam-authenticator-to-pc',
	'approve-steam-confirmations-desktop',
	'download',
	'import-from-sda',
	'uninstall',
	'docs',
	'faq',
	'support',
	'owners',
	'credits',
	'donate',
	'privacy'
];

describe('the reviewed Google Search page scope', () => {
	it('excludes exactly the 14 agreed routes, without duplicates or global exclusions', () => {
		expect(indexing.GOOGLE_SEARCH_POLICY.reviewed).toBe('2026-10-19');
		expect([...indexing.GOOGLE_SEARCH_POLICY.excludedSlugs].sort()).toEqual([...EXCLUDED].sort());
		expect(pages.PAGES.map((page) => page.slug).sort()).toEqual(
			[...EXCLUDED, ...KEPT, '404'].sort()
		);
		expect(pages.PAGES.filter((page) => page.noindex).map((page) => page.slug)).toEqual(['404']);
		expect(() => indexing.validateGoogleSearchPolicy(pages.PAGES)).not.toThrow();
	});

	it.each(EXCLUDED)('adds a Google-only noindex, follow directive to %s', (slug) => {
		expect(indexing.googlebotMeta(slug)).toBe('<meta name="googlebot" content="noindex, follow">');
	});

	it.each(KEPT)('leaves %s available to Google Search', (slug) => {
		expect(indexing.googlebotMeta(slug)).toBe('');
	});

	it.each([
		'404',
		'unknown-page',
		'',
		'/steam-desktop-authenticator',
		'Steam-Desktop-Authenticator',
		'steam-desktop-authenticator-extra'
	])('does not apply the policy to the unlisted slug %s', (slug) => {
		expect(indexing.googlebotMeta(slug)).toBe('');
	});

	it('rejects ambiguous duplicate page definitions', () => {
		const duplicate = pages.PAGES.find((page) => page.slug === 'steam-desktop-authenticator')!;
		expect(() => indexing.validateGoogleSearchPolicy([...pages.PAGES, duplicate])).toThrow(
			/duplicate/i
		);
	});

	it('rejects a policy route whose page has been removed or renamed', () => {
		const missing = pages.PAGES.filter((page) => page.slug !== 'steam-desktop-authenticator');
		expect(() => indexing.validateGoogleSearchPolicy(missing)).toThrow(/unknown/i);
	});

	it('rejects widening a Google-only exclusion to every search engine', () => {
		const globallyExcluded = pages.PAGES.map((page) =>
			page.slug === 'steam-desktop-authenticator' ? { ...page, noindex: true } : page
		);
		expect(() => indexing.validateGoogleSearchPolicy(globallyExcluded)).toThrow(
			/globally noindex/i
		);
	});
});
