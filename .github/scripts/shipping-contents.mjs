/**
 * Which packages in the installer actually carry code, and which arrive empty.
 *
 * The release guard's report says, of every production dependency, how it
 * reaches the user. It had two answers — a package directory inside the asar, or
 * compiled into the renderer bundle — and two packages fit neither.
 *
 * `@types/node` and `undici-types` are in the production closure because
 * `protobufjs` depends on the first and the first depends on the second. Every
 * file they contain is a TypeScript declaration, and `electron-builder.config.mjs`
 * strips `*.{ts,md,markdown,flow,coffee}` and `*.d.{ts,cts,mts}` from every
 * package. What ships is a directory holding `package.json` and `LICENSE`. Not
 * one byte of it can be loaded, and the report called it a shipping package
 * directory alongside `protobufjs` and `zod`.
 *
 * That is an overstatement in a published document, which is the same defect
 * class as the one that produced this file's neighbour: the report was true
 * about the packaging rule it read and false about what a reader takes from it.
 *
 * ## How the answer is reached
 *
 * By listing the package's own files and asking which of them survive the
 * extension filters *read out of the builder config* — not a list written here,
 * and not a list of package names. A package left with nothing but its manifest
 * and its licence carries no code, whatever it is called; a `@types/*` package
 * that started shipping a `.js` shim would be classified as carrying code on the
 * next run without anybody editing this.
 *
 * The filters are matched on extension only, which is deliberately the *weaker*
 * half of what electron-builder does. Path-shaped exclusions like
 * `!node_modules/ ** /{test,docs}/ ** ` are ignored here, so this can only ever
 * conclude that MORE files survive than really do. An overstatement is the thing
 * being fixed, so the error this cannot make is the one that matters: nothing is
 * called empty unless it is empty under a rule stricter than the real one.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files that are not code and are not evidence of code.
 *
 * A licence has to ship — that is the entire point of shipping the directory —
 * and a manifest is what makes the directory a package rather than a folder.
 * Matched case-insensitively without an extension rule because these arrive
 * spelled every possible way: `LICENSE`, `LICENCE.md`, `license.txt`, `COPYING`.
 */
const METADATA = /^(?:package\.json|licen[sc]e|copying|notice|authors|patents)(?:[.-].*)?$/i;

/**
 * The extensions a `files` entry strips from every package.
 *
 * Reads the two shapes electron-builder's own docs use for this — a brace list
 * (`*.{ts,md}`) and a single extension (`*.map`) — from any entry that applies
 * across all packages. An entry naming one package cannot empty a different
 * one, so it is not consulted.
 */
export function strippedExtensionsFrom(files) {
	const stripped = new Set();

	for (const entry of files) {
		if (typeof entry !== 'string' || !entry.startsWith('!')) {
			continue;
		}
		// Applies to every package, rather than naming one. `!node_modules/**/…`
		// and the bare `!**/…` both do; `!node_modules/react/…` does not.
		if (!/^!(?:node_modules\/)?\*\*\//.test(entry)) {
			continue;
		}

		const basename = entry.slice(entry.lastIndexOf('/') + 1);

		// `*.d.{ts,cts,mts}` and `*.{ts,md,markdown}` — the brace list is the tail.
		const braced = /^\*(\.[^{]*)?\.\{([^}]+)\}$/.exec(basename);
		if (braced) {
			const stem = braced[1] ?? '';
			for (const extension of braced[2].split(',')) {
				stripped.add(`${stem}.${extension.trim()}`.toLowerCase());
			}
			continue;
		}

		// `*.map`
		const single = /^\*(\.[^*{}]+)$/.exec(basename);
		if (single) {
			stripped.add(single[1].toLowerCase());
		}
	}

	return stripped;
}

/** Does this filename end in one of the stripped suffixes? */
function isStripped(name, stripped) {
	const lower = name.toLowerCase();
	for (const suffix of stripped) {
		if (lower.endsWith(suffix)) {
			return true;
		}
	}
	return false;
}

/**
 * Walk a package directory, stopping at nested `node_modules`.
 *
 * A nested dependency is its own package with its own entry in the closure, and
 * counting its files here would make an empty package look full because
 * something underneath it is not.
 */
function filesIn(dir, found = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (entry === 'node_modules') {
			continue;
		}
		const full = join(dir, entry);
		let stats;
		try {
			stats = statSync(full);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			filesIn(full, found);
		} else {
			found.push(entry);
		}
	}
	return found;
}

/**
 * @param dir the installed package directory.
 * @param stripped suffixes the packaging rules remove, from `strippedExtensionsFrom`.
 * @returns `true` when something loadable survives, `false` when the directory
 * ships as a manifest and a licence and nothing else.
 *
 * A directory that cannot be read returns `true`: this decides only how the
 * report is *worded*, and the wording that overstates is the safe one to fall
 * back to. Calling a package empty because it could not be opened would be the
 * failure this file exists to remove, committed in the other direction.
 */
export function carriesCode(dir, stripped) {
	const names = filesIn(dir);
	if (names.length === 0) {
		return true;
	}
	return names.some((name) => !METADATA.test(name) && !isStripped(name, stripped));
}
