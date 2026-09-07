export function calendarDateProblem(value: unknown, now?: Date): string | null;
export function formatPublicationDate(iso: string): string;
export function sourceNoteProblem(source: unknown): string | null;
export function articleOf(html: string): string;
export function editorialBodyOf(html: string): string;

export const PUBLICATION_TIME_ZONE: string;
export const SHINGLE_SIZE: number;
export const JACCARD_LIMIT: number;
export const CONTAINMENT_LIMIT: number;

export function shingles(text: string, size?: number): Set<string>;
export function overlapScores(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>
): { jaccard: number; containment: number };
