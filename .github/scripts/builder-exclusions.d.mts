/**
 * Types for the exclusion parser, so the test that drives it is type-checked
 * like any other.
 *
 * The script itself is plain `.mjs` because CI runs it with bare `node`, with no
 * build step between the checkout and the release guard. Importing it from a
 * test without this left every value it returned as `any`, which turned fifteen
 * real type errors into silence — the test could have called a function that
 * does not exist and still compiled.
 */

/**
 * An entry in `files` that names a package and cannot be classified.
 *
 * Thrown rather than skipped: an exclusion this cannot read may remove a package
 * the published SBOM then describes as shipping.
 */
export declare class ExclusionShapeError extends Error {
	constructor(message: string);
}

/**
 * @param files electron-builder's `files` array, verbatim — which is why the
 * element type is `unknown` and not `string`. electron-builder also accepts
 * `{ from, to, filter }` objects, and typing this as `string[]` would hide from
 * the compiler the exact case the parser exists to refuse.
 * @param candidates every package name that could be excluded — the production
 * closure. Needed only to answer a scope-wide exclusion such as
 * `!node_modules/@types/**`, which names no package; without it such an entry is
 * refused rather than guessed at.
 * @returns the package names removed from the installer completely.
 */
export declare function excludedPackagesFrom(
	files: readonly unknown[],
	candidates?: readonly string[]
): Set<string>;
