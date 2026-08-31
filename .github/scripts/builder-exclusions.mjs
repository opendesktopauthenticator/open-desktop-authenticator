/**
 * Which packages electron-builder removes from the installer entirely.
 *
 * Split out of the SBOM guard so it can be tested, because it is the part that
 * decides what the published report *claims*. The guard says, of every
 * production dependency, how it reaches the user — as a package directory
 * inside the asar, or compiled into the renderer bundle — and that sentence is
 * only true if this reads the packaging rules correctly.
 *
 * It did not. The first version matched one literal spelling of a whole-package
 * exclusion and silently skipped everything else, so the identical rule written
 * electron-builder's other standard way fell through and the report went back to
 * claiming all forty packages ship as directories. A verifier proved it by
 * substituting the equivalent glob: the guard stayed green and the false
 * statement came back.
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

/**
 * @param files electron-builder's `files` array, verbatim.
 * @returns the package names removed from the installer completely.
 * @throws ExclusionShapeError for an entry that names a package and cannot be
 * classified — which must stop a release rather than be assumed harmless.
 */
export function excludedPackagesFrom(files) {
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

		const rest = entry.slice('!node_modules/'.length);
		const slash = rest.indexOf('/');
		if (slash === -1) {
			// `!node_modules/foo` with no tail at all. Not a shape electron-builder
			// uses for a package, and not one to guess about.
			throw new ExclusionShapeError(
				`"${entry}" names something under node_modules with no path after it, and this cannot ` +
					'tell what it removes.'
			);
		}

		const head = rest.slice(0, slash);
		const tail = rest.slice(slash + 1);

		// A glob where the package name goes applies to every package, so it trims
		// files out of packages that still ship as directories.
		if (head.includes('*')) {
			continue;
		}

		const names = (
			head.startsWith('{') && head.endsWith('}') ? head.slice(1, -1).split(',') : [head]
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
