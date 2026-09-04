/**
 * Which packages electron-builder removes from the installer entirely.
 *
 * Split out of the SBOM guard so it can be tested, because it is the part that
 * decides what the published report *claims*. The guard says, of every
 * production dependency, how it reaches the user — as a package directory
 * inside the asar, or compiled into the renderer bundle — and that sentence is
 * only true if this reads the packaging rules correctly.
 *
 * It did not, twice, the same way both times.
 *
 * The first version matched one literal spelling of a whole-package exclusion
 * and silently skipped everything else, so the identical rule written
 * electron-builder's other standard way fell through and the report went back to
 * claiming all forty packages ship as directories.
 *
 * The second version — written to fix that, with "classify or refuse, never
 * skip" in this comment — split the path at the first slash and so read
 * `!node_modules/@doctormckay/stdlib/**` as the scope `@doctormckay` having a
 * *part* of it removed. Not placed, not refused, skipped in silence: the exact
 * behaviour the rule above forbids, in the commit that introduced the rule. The
 * word "scope" appeared nowhere in the file and no test used a scoped name,
 * while the production closure contains twelve scoped packages.
 *
 * **So the rule here is to classify or refuse, never to skip.** Anything naming
 * a concrete package that this cannot confidently place is an error, because the
 * alternative is a published document that guesses.
 */

/** A tail of nothing but stars and slashes: the whole package is gone. */
const ONLY_GLOBS = /^\*+(?:\/\*+)*$/;

export class ExclusionShapeError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ExclusionShapeError';
	}
}

/** A brace list, `{a,b,c}`, and nothing else around it. */
const isBraceList = (segment) => segment.startsWith('{') && segment.endsWith('}');

const namesIn = (segment) =>
	(isBraceList(segment) ? segment.slice(1, -1).split(',') : [segment]).map((name) => name.trim());

/**
 * @param files electron-builder's `files` array, verbatim.
 * @param candidates every package name that could be excluded — the production
 * closure. Only needed to answer a scope-wide exclusion such as
 * `!node_modules/@types/**`, which names no package and therefore cannot be
 * expanded without knowing what is installed. Omit it and such an entry is
 * refused rather than guessed at.
 * @returns the package names removed from the installer completely.
 * @throws ExclusionShapeError for an entry that names a package and cannot be
 * classified — which must stop a release rather than be assumed harmless.
 */
export function excludedPackagesFrom(files, candidates) {
	const excluded = new Set();

	for (const entry of files) {
		/*
		 * A non-string entry is refused rather than stringified. electron-builder
		 * also accepts `{ from, to, filter }` objects, and `String(...)` turns one
		 * into `[object Object]` — which matches nothing and was skipped in
		 * silence. An exclusion this cannot read is not an exclusion that is
		 * absent.
		 */
		if (typeof entry !== 'string') {
			throw new ExclusionShapeError(
				`a "files" entry is not a string (${JSON.stringify(entry)}), so it cannot be read. ` +
					'It may remove a package the SBOM then describes as shipping.'
			);
		}
		if (!entry.startsWith('!node_modules/')) {
			continue;
		}

		const segments = entry.slice('!node_modules/'.length).split('/');
		const first = segments[0] ?? '';

		/*
		 * **A package name is one segment, or two when it is scoped.** This is the
		 * whole of the second defect: `@doctormckay/stdlib/**` is a scope, a name
		 * and a tail, and reading the scope as the name left the tail looking like
		 * a partial exclusion of a package called `@doctormckay`.
		 */
		const scoped = first.startsWith('@');

		if (scoped && segments.length >= 2 && (segments[1] ?? '').includes('*')) {
			/*
			 * `!node_modules/@types/**` — every package in a scope, naming none of
			 * them. Expanded against the closure when there is one, because that is
			 * the only place the names exist. Without it there is nothing to answer
			 * with, and answering anyway is the guess this file exists to prevent.
			 */
			const tail = segments.slice(1).join('/');
			if (!ONLY_GLOBS.test(tail)) {
				// Trims files across the scope; those packages still ship.
				continue;
			}
			if (!candidates) {
				throw new ExclusionShapeError(
					`"${entry}" removes every package in the ${first} scope, and this was not given the ` +
						'list of installed packages, so it cannot say which ones.'
				);
			}
			for (const name of candidates) {
				if (name.startsWith(`${first}/`)) {
					excluded.add(name);
				}
			}
			continue;
		}

		const nameLength = scoped ? 2 : 1;
		if (segments.length <= nameLength) {
			// `!node_modules/foo` or `!node_modules/@scope/foo` with no tail at all.
			// Not a shape electron-builder uses for a package, and not one to guess
			// about.
			throw new ExclusionShapeError(
				`"${entry}" names something under node_modules with no path after it, and this cannot ` +
					'tell what it removes.'
			);
		}

		const head = segments.slice(0, nameLength).join('/');
		const tail = segments.slice(nameLength).join('/');

		// A glob where the package name goes applies to every package, so it trims
		// files out of packages that still ship as directories.
		if (!scoped && head.includes('*')) {
			continue;
		}

		/*
		 * A brace list is understood as the whole of a segment and nowhere else.
		 * `@types/{node,react}` would otherwise be taken as one package with a
		 * literal brace in its name, which is a silent wrong answer rather than a
		 * loud one.
		 */
		if (head.includes('{') && !isBraceList(segments[nameLength - 1] ?? '')) {
			throw new ExclusionShapeError(
				`"${entry}" puts a brace list somewhere this cannot read it as a package name.`
			);
		}

		const names = (
			scoped ? namesIn(segments[1] ?? '').map((name) => `${first}/${name}`) : namesIn(head)
		).map((name) => name.trim());

		if (ONLY_GLOBS.test(tail)) {
			for (const name of names) {
				excluded.add(name);
			}
			continue;
		}

		/*
		 * Braces in the tail can hide a whole-package exclusion inside a list of
		 * alternatives, and expanding them here would be a second glob engine.
		 * Refused instead: rare enough that saying so costs nothing, and the
		 * alternative is the report guessing.
		 */
		if (tail.includes('{')) {
			throw new ExclusionShapeError(
				`"${entry}" uses a brace list after the package name, and this cannot tell whether it ` +
					'removes the whole package.'
			);
		}

		// Names a concrete package and removes only part of it — a type-declaration
		// or test-directory filter. The package still ships as a directory, which
		// is what the report is about.
		if (/[^*/]/.test(tail)) {
			continue;
		}

		throw new ExclusionShapeError(
			`"${entry}" cannot be classified as removing the whole package or only part of it.`
		);
	}

	return excluded;
}
