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

/** Anything a package might call its licence, in any spelling or extension. */
const LICENCE_FILE = /^(licen[sc]e|copying|notice|unlicense)(\.|$)/i;

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
		.map((name) => `--- ${name} ---\n${readFileSync(join(dir, name), 'utf8').trim()}`)
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
	// The old array form, still in the wild.
	if (Array.isArray(parsed.licenses)) {
		return parsed.licenses
			.map((entry) => entry?.type)
			.filter(Boolean)
			.join(', ');
	}
	return undefined;
}

const sections = [];
const missing = [];

for (const entry of closure()) {
	const text = licenceText(entry.path);
	const declared = declaredLicence(entry.path);

	if (text === undefined && declared === undefined) {
		missing.push(`${entry.name}@${entry.version}`);
		continue;
	}

	sections.push(
		[
			`${'='.repeat(76)}`,
			`${entry.name} ${entry.version}`,
			'',
			text ??
				`No licence file is included in this package. Its package.json declares: ${declared}.`,
			''
		].join('\n')
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
