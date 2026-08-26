/**
 * The shared markup helpers.
 *
 * `site/` is plain ESM that the static generator runs directly, with no build
 * step between what is reviewed and what executes — the same reasoning as
 * `tickets/server.d.mts`. This file gives the tests types for it anyway, so
 * they are checked rather than waved through as `any`.
 */

/** HTML-escapes a value for interpolation into a template. */
export function escape(value: unknown): string;

/** The "was this useful" aside. */
export function reviewAsk(site: unknown, options: { got: string }): string;

/**
 * The release gaps still open, derived from `SITE.release` rather than written
 * out by hand — see the note in `markup.mjs` for what went wrong when they were.
 *
 * `clause` completes "what is missing is …", `noun` completes "not yet done: …",
 * and `sentence` stands alone with its consequence attached.
 */
export function releaseGaps(site: unknown, form?: 'clause' | 'noun' | 'sentence'): string[];

/** "a", "a and b", "a, b, and c". Serial comma. */
export function sentenceList(items: string[]): string;

/** "One thing is", "Two things are" — verb agreement follows the count. */
export function countPhrase(n: number): string;
