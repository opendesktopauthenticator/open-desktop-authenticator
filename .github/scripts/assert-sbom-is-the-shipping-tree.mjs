#!/usr/bin/env node
// The SBOM published beside a release must be a list of what the installer
// contains. Twice now it has been something else, and both times the document
// was well-formed, published, and wrong.
//
// First it was generated from `path: .`, so it catalogued `spike/` — the Phase
// 0 proof of concept whose own package.json says "Not shipped" — and told the
// world this product carries `request` and `steamcommunity`, eleven advisories
// with no fix between them, while §2.3 of docs/THREAT_MODEL.md exists to say
// exactly the opposite. The same scan left `electron` out, because the scanner
// skips devDependencies and electron lives there, so the document was silent
// about the single largest thing in the download.
//
// The assembly step was fixed. The check that guarded it was not, and an
// adversarial review then walked through it three separate ways:
//
//   1. Delete `--omit=dev` from the assembly's `npm ci`. The SBOM becomes 495
//      packages of eslint, vitest, typescript, prettier and electron-builder —
//      the original defect, whole — and the old check printed success.
//   2. Rename the contaminant. The old check named `request`,
//      `steamcommunity` and `spike-cli` as literal strings, so `phase0-spike`
//      and `steam-totp` walked straight past it. A deny-list of three names is
//      defeated by a fourth name.
//   3. Hand it an SBOM of a different application entirely — jquery, lodash,
//      express, moment, axios, uuid, twelve invented names and one correct
//      electron entry. It passed, because the only positive claims were
//      "at least ten packages" and "electron is in here somewhere".
//
// All three are the same hole: the check described what must not be present.
// Absence is unbounded and cannot be enumerated. So this script states what
// SHIPS instead, and it does not take the SBOM's word for any of it — the
// expected set is derived from package.json and package-lock.json, which the
// assembly step never touches, by walking the production dependency graph the
// way npm resolves it. The SBOM then has to match that set exactly: nothing
// outside it, nothing missing from it. Dev packages are outside it. A renamed
// spike package is outside it. Another application's packages are outside it
// and this one's are all missing. One comparison, and none of the three
// escapes had to be predicted by name.

import { readFileSync } from 'node:fs';

const sbomPath = process.env.SBOM || process.argv[2];
const manifestPath = process.env.MANIFEST || 'package.json';
const lockfilePath = process.env.LOCKFILE || 'package-lock.json';

function fail(message) {
	console.log(`::error::${message}`);
	process.exit(1);
}

function readJson(label, path) {
	if (!path) {
		fail(`${label} was not given a path, so nothing would be checked at all`);
	}
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		fail(`${label} could not be read from ${path}: ${error.message}`);
	}
}

// `node-bignumber` publishes its own version as the string "v1.2.2" while the
// lockfile records "1.2.2" for the same tarball. Both are that package, and a
// release must not fail over a leading letter, so every comparison below runs
// on versions with that prefix removed rather than on whatever each file typed.
function version(value) {
	return String(value ?? '')
		.trim()
		.replace(/^v/, '');
}

// ---------------------------------------------------------------------------
// What ships. Derived from the lockfile, never read off the SBOM.
// ---------------------------------------------------------------------------

const manifest = readJson('the manifest', manifestPath);
const lock = readJson('the lockfile', lockfilePath);

const entries = lock.packages;
if (!entries || typeof entries !== 'object' || !entries['']) {
	fail(
		`${lockfilePath} has no "packages" map with a root entry, so the shipping tree cannot be derived and every comparison below would pass on an empty expectation`
	);
}

// npm's own resolution: a package at node_modules/a/node_modules/b that
// requires c is served by the nearest node_modules walking up. Reproducing that
// here is what lets this follow the real graph instead of trusting the `dev`
// flags npm wrote into the file. The flags and the walk agree on this tree
// today; if a future npm changes how it writes them, the walk still describes
// the closure and the flags are nobody's promise.
function resolveFrom(fromPath, name) {
	let dir = fromPath;
	for (;;) {
		const candidate = `${dir === '' ? '' : `${dir}/`}node_modules/${name}`;
		if (Object.hasOwn(entries, candidate)) {
			return candidate;
		}
		if (dir === '') {
			return null;
		}
		const cut = dir.lastIndexOf('/node_modules/');
		dir = cut === -1 ? '' : dir.slice(0, cut);
	}
}

// Two answers per package, because they are not the same question. `required`
// is what must appear: reachable from `dependencies` along edges npm cannot
// skip. `allowed` also holds what npm may legitimately leave out — an
// optionalDependency with no build for this runner, an optional peer. This tree
// has none of those today. That it has none today is not a thing to build on,
// and the alternative is a release going red on Linux over a package that only
// installs on Windows.
const reached = new Map();
const queue = [];

function enqueue(path, mandatory) {
	const before = reached.get(path);
	if (before === undefined || (mandatory && !before)) {
		reached.set(path, mandatory);
		queue.push({ path, mandatory });
	}
}

const root = entries[''];
for (const name of Object.keys(root.dependencies ?? {})) {
	const path = resolveFrom('', name);
	if (!path) {
		fail(
			`${manifestPath} depends on ${name} but ${lockfilePath} has no entry for it: the lockfile is stale, and a stale lockfile means this check is comparing the SBOM against an application that does not exist`
		);
	}
	enqueue(path, true);
}
for (const name of Object.keys(root.optionalDependencies ?? {})) {
	const path = resolveFrom('', name);
	if (path) {
		enqueue(path, false);
	}
}

while (queue.length > 0) {
	const { path, mandatory } = queue.shift();
	const entry = entries[path] ?? {};
	const optionalPeers = entry.peerDependenciesMeta ?? {};
	const edges = [];
	for (const name of Object.keys(entry.dependencies ?? {})) {
		edges.push([name, mandatory]);
	}
	for (const name of Object.keys(entry.peerDependencies ?? {})) {
		edges.push([name, mandatory && optionalPeers[name]?.optional !== true]);
	}
	for (const name of Object.keys(entry.optionalDependencies ?? {})) {
		edges.push([name, false]);
	}
	for (const [name, childMandatory] of edges) {
		const childPath = resolveFrom(path, name);
		if (childPath) {
			enqueue(childPath, childMandatory);
		}
	}
}

const allowed = new Set();
const required = new Set();
for (const [path, mandatory] of reached) {
	const entry = entries[path];
	// An aliased install carries its real name in the entry; everything else is
	// named by the directory it lands in.
	const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
	const id = `${name}@${version(entry.version)}`;
	allowed.add(id);
	if (mandatory) {
		required.add(id);
	}
}

// Electron is the exception the whole assembly step exists for: it sits in
// devDependencies because at build time it is a build tool, and it is the
// runtime the installer embeds. The version comes from the manifest so the
// SBOM cannot quietly name a different runtime than the packaging job used.
const pinned = (manifest.devDependencies ?? {}).electron;
if (!pinned) {
	fail(
		`${manifestPath} no longer pins electron in devDependencies, so this check cannot say which runtime the installer embeds`
	);
}
if (!/^\d+\.\d+\.\d+/.test(pinned)) {
	fail(
		`electron is pinned as "${pinned}", which is a range rather than one version: the SBOM names the version that was packaged, and a range cannot be compared against it`
	);
}
allowed.add(`electron@${version(pinned)}`);
required.add(`electron@${version(pinned)}`);

// The application's own manifest sits at the top of the scanned tree and
// scanners generally catalogue it. Generally is not always, and which entry a
// scanner writes for the directory it was pointed at is scanner-version trivia,
// so this is permitted rather than demanded. The positive claim this check
// rests on is the dependency closure above, which is dozens of packages deep
// and cannot be satisfied by accident.
allowed.add(`${manifest.name}@${version(manifest.version)}`);

// A derivation that silently produced nothing would make every comparison below
// pass vacuously — which is the exact shape of the failure this script exists
// to stop, one level up.
if (required.size < 10) {
	fail(
		`only ${required.size} packages were derived from ${lockfilePath} as shipping; this project ships dozens, so the walk is broken, and an expectation of nothing accepts anything`
	);
}

// ---------------------------------------------------------------------------
// What the SBOM says.
// ---------------------------------------------------------------------------

const sbom = readJson('the SBOM', sbomPath);
const packages = Array.isArray(sbom.packages) ? sbom.packages : null;
if (!packages) {
	fail(`${sbomPath} has no "packages" array: it is not an SPDX document this check can read`);
}

// SPDX names the thing the document is about, and for a directory scan that is
// the directory itself, not a package that ships. It is identified here by the
// document's own DESCRIBES relationship rather than by guessing the name the
// scanner gives it, because the name is scanner-version trivia and the
// relationship is in the spec.
const described = new Set(sbom.documentDescribes ?? []);
for (const relationship of sbom.relationships ?? []) {
	if (
		relationship.spdxElementId === 'SPDXRef-DOCUMENT' &&
		relationship.relationshipType === 'DESCRIBES'
	) {
		described.add(relationship.relatedSpdxElement);
	}
}

function purl(entry) {
	const refs = Array.isArray(entry.externalRefs) ? entry.externalRefs : [];
	return refs.find((ref) => ref.referenceType === 'purl')?.referenceLocator ?? '';
}

// A tolerance, not an assertion. Syft writes its directory entry as
// `SPDXRef-DocumentRoot-Directory-sbom-root` and also points DESCRIBES at it,
// so the check above already skips it — but if a future version of the action
// writes one and forgets the other, the only symptom would be a red release
// over an entry that was never a package. Recognising the identifier shape too
// costs a version-less, purl-less entry's worth of laxity and saves somebody
// from "fixing" that red by loosening the comparison that actually matters.
function isScannedDirectory(entry) {
	return (
		described.has(entry.SPDXID) ||
		(/^SPDXRef-DocumentRoot-/i.test(String(entry.SPDXID ?? '')) &&
			purl(entry) === '' &&
			version(entry.versionInfo) === '')
	);
}

const catalogued = new Set();
const foreign = new Set();
for (const entry of packages) {
	if (isScannedDirectory(entry)) {
		continue;
	}
	const id = `${typeof entry.name === 'string' ? entry.name : ''}@${version(entry.versionInfo)}`;
	// Sorted into two buckets rather than one, because they fail differently.
	// An npm entry is a claim about the shipping tree and is compared against
	// it. Anything else means a cataloguer other than the JavaScript one found
	// something in a tree that holds nothing but package metadata — and it is
	// also how contamination hides from a purl-based comparison, by arriving
	// without a purl.
	if (purl(entry).startsWith('pkg:npm/')) {
		catalogued.add(id);
	} else {
		foreign.add(id);
	}
}

const extra = [...catalogued].filter((id) => !allowed.has(id)).sort();
const missing = [...required].filter((id) => !catalogued.has(id)).sort();
const problems = [];

if (extra.length > 0) {
	problems.push(
		`the SBOM lists ${extra.length} package(s) that ${lockfilePath} says this application does not ship: ${extra.join(', ')}`
	);
}
if (missing.length > 0) {
	problems.push(
		`the SBOM omits ${missing.length} package(s) the installer contains: ${missing.join(', ')}`
	);
}
if (foreign.size > 0) {
	problems.push(
		`the SBOM lists ${foreign.size} entries that are not npm packages, and the tree that was scanned holds nothing else: ${[...foreign].sort().join(', ')}`
	);
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.log(`::error::${problem}`);
	}
	console.log(
		`This SBOM is not a description of what ships. Expected exactly the ${required.size} packages in the production closure of ${manifestPath} plus electron ${version(pinned)}; the document catalogues ${catalogued.size} npm entries.`
	);
	console.log(
		'If the difference is legitimate then the lockfile is what changed, and this check follows the lockfile. Do not widen the check.'
	);
	process.exit(1);
}

console.log(
	`SBOM matches the shipping tree exactly: ${catalogued.size} npm entries, every one of the ${required.size} packages in the production closure of ${manifestPath}, electron ${version(pinned)} among them, and nothing else.`
);
