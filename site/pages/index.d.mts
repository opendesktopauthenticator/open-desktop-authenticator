/**
 * The page list, as the generator sees it.
 *
 * Only the fields a type-checked caller touches are described. The page objects
 * carry more — structured data, scripts, heroes, breadcrumb overrides — and
 * those stay the generator's business, in the same spirit as
 * `tickets/server.d.mts`.
 */

export interface SitePage {
	/** The URL segment. `index` is the homepage. */
	slug: string;
	/** Optional reader-facing hub used by navigation and breadcrumbs. */
	parent?: string;
	/** Exclude utility/error pages from indexing and editorial publication gates. */
	noindex?: boolean;
	/** Long-form guides receive review metadata and an on-page contents list. */
	guide?: boolean;
	/** Date of the last material content change; required for indexed pages. */
	updated?: string;
	/** Optional later fact-check date when the article did not materially change. */
	reviewed?: string;
	/**
	 * The internal publication case for this URL. It is deliberately review data,
	 * not a search-facing disclaimer: the rendered page must earn both claims.
	 */
	editorial?: {
		value: string;
		evidence: string;
		proofs: readonly string[];
	};
	/** Page-specific source/testing disclosure shown on long-form guides. */
	sourced?: string | ((site: unknown) => string);
	title: string;
	description: string | ((site: unknown) => string);
	/**
	 * The page's HTML.
	 *
	 * Takes the whole `SITE` object. Pages that need nothing from it declare no
	 * parameter, which is why this is the widest honest type rather than a named
	 * one — the site's own shape lives in `build.mjs` and is not exported.
	 */
	body(site: unknown): string;
}

export const PAGES: SitePage[];
