#!/usr/bin/env node
// The tree the SBOM scanner is pointed at, assembled so that scanning it
// actually produces an inventory.
//
// **Why this file exists.** The step this replaces ended with `rm -f
// package-lock.json`, on the reasoning that npm writes a `dev` flag next to
// every entry, that the scanner honours the flag, and that the electron entry
// added by hand would therefore be dropped. Every clause of that is true. The
// conclusion was not. Syft's `javascript-package-cataloger` — the one that
// reads `package.json` files out of `node_modules` — is tagged `installed` and
// `image` and carries no `directory` tag, so on a directory scan it does not
// run at all. `javascript-lock-cataloger` is the only JavaScript cataloger
// tagged `directory`, and it reads exactly one kind of file: the lockfile that
// step deleted. Removing the lockfile did not remove a dev flag; it removed the
// entire npm inventory. An audit reproducing the workflow against the scanner
// version the pinned action ships got three document entries and no package
// URLs at all, and the guard that runs next then reported forty missing
// packages and two foreign entries and failed. Every release. Ordinary CI never
// walked this path, so nothing said so until somebody tried to ship.
//
// So the lockfile stays, and rather than deleting it this writes a lockfile in
// which nothing is a development dependency, because everything in it ships.
//
// **Where the contents come from is the point.** The lockfile written here is
// not a restatement of the graph walk in assert-sbom-is-the-shipping-tree.mjs.
// If it were, the guard would be checking its own arithmetic and would pass
// happily on a tree with nothing installed in it. It is copied from
// `node_modules/.package-lock.json`, the hidden lockfile npm writes to record
// what it actually placed on disk during `npm ci --omit=dev`. That makes the
// SBOM a description of an installed tree, and it makes the guard's comparison
// one between two independently derived answers: npm's, and the walk.

// **The installs happen here, not in the workflow.** Two workflows run this
// path — `release.yml`, where it matters, and `sbom.yml`, which exists to make
// sure it still works — and the whole value of the second is that it exercises
// what the first does. Two copies of the same shell in two files would drift,
// and the release is where the drift would be discovered.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.env.ROOT || '.';
const out = process.env.OUT || 'sbom-root';
const configOut = process.env.SYFT_CONFIG_OUT || 'sbom-syft.yaml';
const scratch = process.env.RUNNER_TEMP || tmpdir();

function fail(message) {
	console.log(`::error::${message}`);
	process.exit(1);
}

function readJson(label, path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		fail(`${label} could not be read from ${path}: ${error.message}`);
	}
}

// On Linux, where releases are built, npm is a real executable and no shell is
// involved in deciding what any argument means. On Windows npm is a `.cmd`
// shim, and Node has refused to spawn one without a shell since it closed the
// batch-argument injection hole in 2024 — so a maintainer running this locally
// gets `EINVAL` otherwise. The shell is therefore asked for only there, and the
// thing that makes it safe is that the sole non-literal argument, electron's
// version, has to match a fully anchored pattern a few lines below before it
// can reach this function.
const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';
function run(cwd, args) {
	console.log(`$ npm ${args.join(' ')}   (in ${cwd})`);
	execFileSync(npm, args, {
		cwd,
		stdio: 'inherit',
		shell: windows,
		// Beside `--ignore-scripts`, not instead of it. Electron's postinstall
		// fetches a ~100 MB runtime this tree has no use for — only the package
		// metadata is wanted — and a release should not wait on a download in
		// order to describe a file it has already built.
		env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
	});
}

const manifest = readJson('the manifest', join(root, 'package.json'));
const rootLock = readJson('the lockfile', join(root, 'package-lock.json'));

// ---------------------------------------------------------------------------
// Install what ships, and nothing else.
//
// Production dependencies only, resolved from the lockfile, which is the same
// tree `npm ci` gave the packaging job. eslint, vitest and electron-builder are
// on no user's disk; listing them invites somebody to chase an advisory in a
// package that never shipped.
// ---------------------------------------------------------------------------

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'package.json'), join(out, 'package.json'));
cpSync(join(root, 'package-lock.json'), join(out, 'package-lock.json'));
run(out, ['ci', '--omit=dev', '--ignore-scripts']);

// ---------------------------------------------------------------------------
// What npm actually installed.
// ---------------------------------------------------------------------------

const hiddenPath = join(out, 'node_modules', '.package-lock.json');
if (!existsSync(hiddenPath)) {
	fail(
		`${hiddenPath} does not exist, which means npm never installed anything into ${out}: the SBOM would describe an empty tree, and an empty tree is the exact thing the guard after this exists to reject`
	);
}
const hidden = readJson('the record npm keeps of the installed tree', hiddenPath);
const installed = hidden.packages;
if (!installed || typeof installed !== 'object' || Object.keys(installed).length === 0) {
	fail(
		`${hiddenPath} lists no packages, so nothing was installed and the SBOM would be a description of nothing`
	);
}

// `npm ci --omit=dev` should leave nothing flagged as development. If a future
// npm starts writing those flags anyway, the scanner would silently drop every
// entry carrying one — this defect returning by a quieter route, and showing up
// as a guard failure nobody could explain from the log.
const flagged = Object.keys(installed).filter(
	(path) => installed[path].dev === true || installed[path].devOptional === true
);
if (flagged.length > 0) {
	fail(
		`npm installed ${flagged.length} package(s) into ${out} that are still flagged as development dependencies (${flagged.join(', ')}); the scanner skips those, so the SBOM would quietly omit them`
	);
}

// ---------------------------------------------------------------------------
// Electron, the one thing that ships and is not a production dependency.
// ---------------------------------------------------------------------------

const pinned = (manifest.devDependencies ?? {}).electron;
if (!pinned) {
	fail(
		'package.json no longer pins electron in devDependencies, so this tree cannot name the runtime the installer embeds'
	);
}
// Anchored at both ends, which is a second job as well as the obvious one. It
// says the pin is one exact version rather than a range — an SBOM names the
// version that was packaged, and a range is not one — and it is also what lets
// this string be passed to npm as an argument without a shell being involved in
// deciding what it means.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned)) {
	fail(
		`electron is pinned as "${pinned}", which is not a single exact version: an SBOM names the version that was packaged, and a range is not one`
	);
}

// Taken from the repository's own lockfile rather than from whatever the
// metadata install happened to resolve, so the SBOM names the tarball this
// repository pins. A disagreement here means the manifest and the lockfile
// describe different runtimes, which is how an SBOM ends up describing a build
// nobody made.
const electronLockEntry = rootLock.packages?.['node_modules/electron'] ?? {};
if (electronLockEntry.version && electronLockEntry.version !== pinned) {
	fail(
		`package.json pins electron ${pinned} but package-lock.json resolves electron ${electronLockEntry.version}; the SBOM would name a runtime that was never packaged`
	);
}

// ---------------------------------------------------------------------------
// Write the pair the scanner reads.
// ---------------------------------------------------------------------------

// No devDependencies field at all. Anything left there would be resolved as
// development by any tool that reads this manifest, and the whole claim of this
// tree is that everything in it ships.
const shippingManifest = {
	name: manifest.name,
	version: manifest.version,
	description: manifest.description,
	license: manifest.license,
	private: true,
	dependencies: { ...(manifest.dependencies ?? {}), electron: pinned }
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(shippingManifest, null, 2)}\n`);

const packages = {
	'': {
		name: manifest.name,
		version: manifest.version,
		license: manifest.license,
		dependencies: shippingManifest.dependencies
	}
};
for (const [path, entry] of Object.entries(installed)) {
	packages[path] = entry;
}
packages['node_modules/electron'] = {
	version: pinned,
	resolved: electronLockEntry.resolved,
	integrity: electronLockEntry.integrity,
	license: 'MIT'
};

writeFileSync(
	join(out, 'package-lock.json'),
	`${JSON.stringify(
		{
			name: manifest.name,
			version: manifest.version,
			lockfileVersion: 3,
			requires: true,
			packages
		},
		null,
		2
	)}\n`
);

// Electron's own manifest, installed somewhere else and copied in. `npm install
// electron` in the assembled tree would also add `@electron/get` and
// `extract-zip`, which run when the package is installed and are in no
// installer — an SBOM that invents three packages is a smaller version of the
// mistake this whole path exists to fix.
//
// The copy means the tree holds a `node_modules/electron/package.json` as well
// as a lockfile entry, so the two catalogers say the same thing about the
// runtime from two different files and neither answer is this script's opinion.
const metaDir = join(scratch, 'electron-meta');
rmSync(metaDir, { recursive: true, force: true });
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, 'package.json'), '{"name":"electron-meta","private":true}\n');
run(metaDir, ['install', '--ignore-scripts', '--no-audit', '--no-fund', `electron@${pinned}`]);

const metaManifest = join(metaDir, 'node_modules', 'electron', 'package.json');
const meta = readJson('the manifest of the electron installed for metadata', metaManifest);
if (meta.version !== pinned) {
	fail(
		`the electron installed for metadata reports version ${meta.version} but package.json pins ${pinned}`
	);
}
const electronDir = join(out, 'node_modules', 'electron');
mkdirSync(electronDir, { recursive: true });
writeFileSync(join(electronDir, 'package.json'), `${JSON.stringify(meta, null, 2)}\n`);

// ---------------------------------------------------------------------------
// The scanner's configuration, written here so it travels with the tree.
// ---------------------------------------------------------------------------
//
// **One cataloger, named, rather than the ecosystem.**
//
// `default-catalogers` replaces the base set rather than filtering it, so naming
// `javascript` ran both JavaScript catalogers: the lock cataloger, the only one
// tagged `directory`, and the package cataloger, which reads `node_modules`.
// That was deliberate — the lockfile and the installed files each answering
// independently — and the cost was paid by the published document. The exact
// pinned scanner produced **82 npm records for 41 components**: every dependency
// listed twice, in a file whose readers are tools that count.
//
// The redundancy it bought has not been given up, it has been moved to where it
// belongs. `shipping-contents.mjs` reads the installed tree directly to decide
// how each package reaches the user, so the files on disk are still cross-checked
// against the lockfile — in the guard, which can say what it found, rather than
// in the artifact, which can only list it again.
//
// The lock cataloger is the authoritative one because its input is the file this
// script writes: a deterministic lockfile holding exactly the shipping closure,
// including the synthetic electron entry that no `node_modules` scan would find.
//
// Everything else is excluded, and that is the second half of the fix. The
// guard rejects any catalogued entry that carries no npm package URL, and the
// only way such an entry reaches a tree holding nothing but package metadata is
// a cataloger that had no business running on it.
rmSync(configOut, { force: true });
writeFileSync(
	configOut,
	[
		'# Written by .github/scripts/assemble-shipping-tree.mjs. Do not edit by hand.',
		'default-catalogers:',
		'  - javascript-lock-cataloger',
		''
	].join('\n')
);

const paths = Object.keys(packages).filter((path) => path !== '');
console.log(`Assembled ${out} as a shipping-only tree:`);
console.log(
	`  manifest:  ${shippingManifest.name}@${shippingManifest.version}, no devDependencies`
);
console.log(`  lockfile:  ${paths.length} entries, lockfileVersion 3, none flagged dev`);
console.log(`  electron:  ${pinned}, from the pin in package.json`);
console.log(`  scanner:   ${configOut}, javascript-lock-cataloger only`);
for (const path of paths.sort()) {
	console.log(`    ${path}@${packages[path].version}`);
}
