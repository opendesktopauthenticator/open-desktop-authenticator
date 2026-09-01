#!/usr/bin/env node
/**
 * The third-party notices the installer is required to carry.
 *
 * **Every dependency this application ships is under a licence that requires its
 * text to travel with the binary.** MIT says so in one sentence: the notice
 * "shall be included in all copies or substantial portions of the Software".
 * Until now that happened by accident — electron-builder copies whatever files a
 * package directory contains, and most packages keep a `LICENSE` beside their
 * code — and the accident had holes:
 *
 *   - `!node_modules/ ** /*.{ts,md,markdown,flow,coffee}` strips `LICENSE.md`.
 *     Three packages in the closure keep their only licence file under that
 *     name, so the installer carried their code and not their notice.
 *   - Three more ship no licence file at all, declaring it only in
 *     `package.json`.
 *   - `react`, `react-dom` and `scheduler` are excluded from the asar entirely,
 *     because Vite compiles them into the renderer bundle. Their code ships;
 *     their package directories do not; nothing replaced the notice.
 *
 * So it is generated instead of hoped for, from the same production closure the
 * SBOM guard derives, and written where the packaged application can show it.
 *
 * Run before packaging. `tests/third-party-notices.test.ts` regenerates it and
 * compares, so a dependency added without re-running this is a failing test
 * rather than a missing notice.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.env.ROOT || process.cwd();
const out = process.env.OUT || join(root, 'THIRD_PARTY_NOTICES.txt');

/**
 * Every package the installer carries, from the lockfile rather than from
 * `node_modules`: the lockfile is what the SBOM guard compares against, and two
 * different ideas of "what ships" is how they come to disagree.
 */
function closure() {
	const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
	const entries = Object.entries(lock.packages ?? {})
		.filter(([path, entry]) => path !== '' && !entry.dev)
		.map(([path, entry]) => ({
			path,
			name: entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
			version: entry.version ?? ''
		}));
	entries.sort((a, b) =>
		a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
	);
	return entries;
}

/**
 * Line endings flattened to LF, and this is not cosmetic.
 *
 * Some packages ship a licence with CRLF. `.gitattributes` normalises this file
 * to LF on the way into the repository, so a fresh checkout has LF on disk while
 * a fresh generation reproduces the CRLF — and the test that regenerates and
 * compares then fails on every runner, for a file nobody has touched. Measured:
 * 665 CRLF pairs in the generated file against none in the committed blob.
 *
 * Writing LF makes the output the same on every platform, which is what a file
 * that is committed and compared has to be.
 */
const normalise = (text) =>
	text
		.replace(
			new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g'),
			String.fromCharCode(10)
		)
		.trim();

/** Anything a package might call its licence, in any spelling or extension. */
const LICENCE_FILE = /^(.*[-_.])?(licen[sc]e|copying|notice|unlicense|copyright)([-_.].*)?$/i;

/**
 * The licence text a package ships, or nothing.
 *
 * Every candidate is concatenated rather than the first one taken: a dual
 * licence arrives as `LICENSE-MIT` and `LICENSE-APACHE`, and picking one of them
 * would publish a claim about terms nobody agreed to.
 */
function licenceText(packagePath) {
	const dir = join(root, packagePath);
	if (!existsSync(dir)) {
		return undefined;
	}
	const found = readdirSync(dir)
		.filter((name) => LICENCE_FILE.test(name))
		.sort();
	if (found.length === 0) {
		return undefined;
	}
	return found
		.map((name) => `--- ${name} ---\n${normalise(readFileSync(join(dir, name), 'utf8'))}`)
		.join('\n\n');
}

/** What `package.json` claims, for the packages that ship no text. */
function declaredLicence(packagePath) {
	const manifest = join(root, packagePath, 'package.json');
	if (!existsSync(manifest)) {
		return undefined;
	}
	const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
	if (typeof parsed.license === 'string') {
		return parsed.license;
	}
	/*
	 * The two legacy forms, both still in the wild. `{ type, url }` reached the
	 * `missing` list and stopped the build with a message saying the package
	 * declares no licence, about a manifest that declares one plainly.
	 */
	if (
		parsed.license &&
		typeof parsed.license === 'object' &&
		typeof parsed.license.type === 'string'
	) {
		return parsed.license.type;
	}
	// The old array form, still in the wild.
	if (Array.isArray(parsed.licenses)) {
		return parsed.licenses
			.map((entry) => entry?.type)
			.filter(Boolean)
			.join(', ');
	}
	return undefined;
}

/** Said before Electron's own licence, because its own is not the whole of it. */
const ELECTRON_PREAMBLE =
	'Electron is the application runtime, shipped alongside the code above rather than inside ' +
	'it. Its own licence follows. The licences of Chromium, Node.js and their dependencies are ' +
	'placed beside the executable by the installer, as LICENSE.electron.txt and ' +
	'LICENSES.chromium.html.' +
	String.fromCharCode(10) +
	String.fromCharCode(10);

/**
 * **Electron, the largest third-party body in the installer.**
 *
 * It sits in `devDependencies` because at build time it is a build tool, so the
 * closure walk — which filters `dev` — left it out while the header claimed the
 * file listed everything the application includes. It ships as the runtime.
 *
 * Named from the pin in `package.json`, the same source the SBOM guard uses, so
 * the notices cannot describe a different runtime than the one packaged.
 */
function electronEntry() {
	const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const pinned = (manifest.devDependencies ?? {}).electron;
	if (typeof pinned !== 'string') {
		return undefined;
	}
	return {
		path: 'node_modules/electron',
		name: 'electron',
		version: pinned.replace(/^[^0-9]*/, '')
	};
}

/**
 * **A bare identifier is not a notice.**
 *
 * MIT asks that "the above copyright notice and this permission notice shall be
 * included in all copies" — the notice *is* the text. Three shipped packages had
 * only the sentence "package.json declares: MIT", which supplies neither the
 * copyright line nor the permission, and so satisfies neither the licence nor the
 * reader.
 *
 * What goes in instead is reconstructed from the manifest and labelled as
 * reconstructed, because that is exactly what it is. The identifier and the
 * author are the package's own statements; the wording is the canonical text for
 * the identifier they chose. No year is invented — the manifest does not state
 * one, and a guessed year in a copyright line is worse than no year at all.
 *
 * Only the short, unambiguous licences. Apache-2.0 and the GPLs carry conditions
 * and appendices a reconstruction should not paraphrase, so a package declaring
 * one of those keeps the identifier and says plainly that the text is not here.
 */
const BLANK = String.fromCharCode(10) + String.fromCharCode(10);

const RECONSTRUCTED = {
	MIT: (holder) =>
		`Copyright (c) ${holder}` +
		BLANK +
		'Permission is hereby granted, free of charge, to any person obtaining a copy of this ' +
		'software and associated documentation files (the "Software"), to deal in the Software ' +
		'without restriction, including without limitation the rights to use, copy, modify, merge, ' +
		'publish, distribute, sublicense, and/or sell copies of the Software, and to permit ' +
		'persons to whom the Software is furnished to do so, subject to the following conditions:' +
		BLANK +
		'The above copyright notice and this permission notice shall be included in all copies or ' +
		'substantial portions of the Software.' +
		BLANK +
		'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, ' +
		'INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR ' +
		'PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE ' +
		'LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT ' +
		'OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR ' +
		'OTHER DEALINGS IN THE SOFTWARE.',
	ISC: (holder) =>
		`Copyright (c) ${holder}` +
		BLANK +
		'Permission to use, copy, modify, and/or distribute this software for any purpose with or ' +
		'without fee is hereby granted, provided that the above copyright notice and this ' +
		'permission notice appear in all copies.' +
		BLANK +
		'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO ' +
		'THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO ' +
		'EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL ' +
		'DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER ' +
		'IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN ' +
		'CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.'
};

/**
 * Whoever the manifest names as the author, in one line.
 *
 * A licence with no holder in it is the same empty gesture as the identifier
 * alone, so a package that names nobody keeps the old sentence rather than
 * getting a copyright line addressed to no one.
 */
function declaredAuthor(packagePath) {
	const manifest = join(root, packagePath, 'package.json');
	if (!existsSync(manifest)) {
		return undefined;
	}
	const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
	const author = parsed.author;
	if (typeof author === 'string' && author.trim() !== '') {
		return author.trim();
	}
	if (author && typeof author.name === 'string' && author.name.trim() !== '') {
		return typeof author.email === 'string' && author.email.trim() !== ''
			? `${author.name.trim()} <${author.email.trim()}>`
			: author.name.trim();
	}
	return undefined;
}

/** The terms for a package that declares a licence and ships no text. */
function reconstructed(packagePath, declared) {
	const template = RECONSTRUCTED[declared];
	if (template === undefined) {
		return undefined;
	}
	const holder = declaredAuthor(packagePath);
	if (holder === undefined) {
		return undefined;
	}
	return (
		`This package ships no licence file. Its package.json declares ${declared} and names ` +
		`${holder} as the author. The ${declared} terms follow, reproduced from the standard text ` +
		'rather than from a file in the package.' +
		BLANK +
		template(holder)
	);
}

const sections = [];
const missing = [];

const electron = electronEntry();
for (const entry of [...(electron ? [electron] : []), ...closure()]) {
	const text = licenceText(entry.path);
	const declared = declaredLicence(entry.path);

	if (text === undefined && declared === undefined) {
		missing.push(`${entry.name}@${entry.version}`);
		continue;
	}

	const body =
		text ??
		reconstructed(entry.path, declared) ??
		`No licence file is included in this package. Its package.json declares: ${declared}.`;

	sections.push(
		[
			`${'='.repeat(76)}`,
			`${entry.name} ${entry.version}`,
			'',
			entry.name === 'electron' ? `${ELECTRON_PREAMBLE}${body}` : body,
			''
		].join(String.fromCharCode(10))
	);
}

/*
 * A package with neither a licence file nor a declared licence is not something
 * to ship quietly. It stops the build rather than producing a notices file that
 * silently omits somebody.
 */
if (missing.length > 0) {
	console.log(
		`::error::${missing.length} shipped package(s) declare no licence and include no licence file: ` +
			`${missing.join(', ')}. Their terms cannot be published, so the installer cannot be built ` +
			'until somebody establishes what they are.'
	);
	process.exit(1);
}

const header = [
	'THIRD-PARTY NOTICES',
	'',
	'This application includes the following third-party software. Each package',
	'is listed with the licence text it ships, or with the licence its manifest',
	'declares where it ships none.',
	'',
	'Generated by scripts/generate-notices.mjs from package-lock.json. Do not edit',
	'by hand — tests/third-party-notices.test.ts regenerates it and compares.',
	''
].join('\n');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${header}\n${sections.join('\n')}`, 'utf8');

console.log(`Wrote ${out}: ${sections.length} packages.`);
