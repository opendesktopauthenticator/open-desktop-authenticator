/**
 * Google Search scope reviewed on 19 October 2026.
 *
 * These articles remain available to readers and other search engines. Only
 * Google receives noindex; the site's generic robots metadata, canonical URLs,
 * sitemap, internal links and crawl access remain unchanged. Product pages and
 * ODA-specific workflows are deliberately outside this exact-route list.
 *
 * Do not replace this with a prefix, a `guide` flag or a global robots rule:
 * those would also exclude the product's download, verification and help pages.
 */
export const GOOGLE_SEARCH_POLICY = Object.freeze({
	reviewed: '2026-10-19',
	excludedSlugs: Object.freeze([
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
	])
});

const googleExcludedSlugs = new Set(GOOGLE_SEARCH_POLICY.excludedSlugs);

/** An exact page-list slug, not a URL prefix or a category. */
export function googlebotMeta(slug) {
	return googleExcludedSlugs.has(slug) ? '<meta name="googlebot" content="noindex, follow">' : '';
}

/** Catch a mistyped route or a global exclusion before writing the site. */
export function validateGoogleSearchPolicy(pages) {
	const bySlug = new Map(pages.map((page) => [page.slug, page]));
	if (bySlug.size !== pages.length) throw new Error('Google Search policy: duplicate page slug');
	if (googleExcludedSlugs.size !== GOOGLE_SEARCH_POLICY.excludedSlugs.length) {
		throw new Error('Google Search policy: duplicate excluded slug');
	}
	for (const slug of googleExcludedSlugs) {
		const page = bySlug.get(slug);
		if (!page) throw new Error(`Google Search policy: unknown page ${slug}`);
		if (page.noindex) throw new Error(`Google Search policy: ${slug} is globally noindex`);
	}
}
