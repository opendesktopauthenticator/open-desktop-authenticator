export interface EditorialRecord {
	readonly value: string;
	readonly evidence: string;
	readonly proofs: readonly string[];
}

export const EDITORIAL_BY_SLUG: Readonly<Record<string, EditorialRecord>>;
export const EDITORIAL: typeof EDITORIAL_BY_SLUG;

export function editorialStatementProblem(statement: unknown): string | null;

export function attachEditorial<T extends { slug: string; noindex?: boolean }>(
	pages: T[]
): Array<T & { editorial?: EditorialRecord }>;
