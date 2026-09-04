/**
 * Types for the shipping-contents classifier, so the test that drives it is
 * type-checked like any other. See `builder-exclusions.d.mts` for why these
 * scripts are `.mjs` with a hand-written declaration beside them.
 */

/**
 * @param files electron-builder's `files` array, verbatim — `unknown` elements
 * because electron-builder also accepts `{ from, to, filter }` objects, and
 * typing this as `string[]` would hide from the compiler the case the parser
 * has to survive.
 * @returns lowercased filename suffixes the packaging rules strip from every
 * package, e.g. `.d.ts`, `.md`, `.map`.
 */
export declare function strippedExtensionsFrom(files: readonly unknown[]): Set<string>;

/**
 * @param dir an installed package directory.
 * @param stripped suffixes from `strippedExtensionsFrom`.
 * @returns whether anything loadable survives the packaging rules.
 */
export declare function carriesCode(dir: string, stripped: ReadonlySet<string>): boolean;
