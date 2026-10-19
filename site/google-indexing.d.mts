export const GOOGLE_SEARCH_POLICY: Readonly<{
	reviewed: string;
	excludedSlugs: readonly string[];
}>;

export function googlebotMeta(slug: string): string;
export function validateGoogleSearchPolicy(
	pages: readonly { slug: string; noindex?: boolean }[]
): void;
