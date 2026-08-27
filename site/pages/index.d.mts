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
	/** Long-form guides receive review metadata and an on-page contents list. */
	guide?: boolean;
	title: string;
	description: string;
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
