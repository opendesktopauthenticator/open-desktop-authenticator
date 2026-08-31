/**
 * Does the tripwire actually trip? Both directions, measured.
 *
 * **site/verify.mjs had no tests, which is why every change to it shipped
 * unguarded.** It is a table of regexes over rendered prose, and the two ways it
 * can be wrong are opposite: it can miss an overclaim, and it can fail honest
 * copy. Reading the patterns tells you neither. Three separate defects lived in
 * the `signed` entry at once — a pattern that could never match because the
 * haystack is tag-stripped, a determiner-dependent one that caught "The checksum
 * list is signed" but not "Our checksum list is signed", and no way at all to
 * write the honest sentence — and the build was green throughout.
 *
 * So this substitutes one sentence into the homepage, builds, runs the verifier
 * and reports the real exit code. When it was first written the working tree got
 * six of these wrong.
 *
 * A repair attempt in between rescued any claim sharing a sentence with a
 * negation word, which reads reasonable and is not: 40% of the sentences on the
 * built site contain one. It turned two overclaims this file used to catch into
 * passes. That is the kind of regression this table exists to make visible.
 *
 *   node site/selftest.mjs                 # the working tree's verify.mjs
 *   node site/selftest.mjs <verify.mjs>    # some other one, same table
 */
import { cpSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIR = join(tmpdir(), 'oda-site-selftest');
const swapVerifier = process.argv[2];

const ANCHOR_FILE = 'pages/home.mjs';
/*
 * The homepage's own unsigned-branch sentence — the branch that renders while
 * `signed` is false, and where the real overclaim was written.
 */
const ANCHOR =
	"'Public source, public CI, published checksums, and build provenance naming the workflow and commit that built it. The checksum list is not signed yet, and the binaries are not code-signed.'";

const CASES = [
	// [name, sentence, must the build FAIL?]
	['plain overclaim', 'The checksum list is signed.', true],
	['overclaim, our', 'Our checksum list is signed.', true],
	['overclaim, this', 'This checksum list is signed.', true],
	['the wording that shipped', 'We publish checksums with a signature over them.', true],
	[
		'the same, with a trailing clause',
		'We publish checksums with a signature over them, so you do not have to trust us.',
		true
	],
	[
		'beside an unrelated denial',
		'The checksum list is signed, and the binaries are not code-signed yet.',
		true
	],
	[
		'beside another unrelated denial',
		'The checksum list is signed, and code signing has not landed yet.',
		true
	],
	['the sig file', 'Every release carries SHA256SUMS.txt.sig and a certificate.', true],

	[
		'honest: no signature yet',
		'There is no signature over the checksum list yet, and the binaries are not code-signed.',
		false
	],
	[
		'honest: still to come',
		'We publish checksums, and a signature over that list is still to come.',
		false
	],
	[
		'honest: nothing signs it',
		'Nothing signs the checksum list, so take it from the release page itself.',
		false
	],
	['honest: unsigned', 'The checksum list is unsigned.', false],
	// STALE_ABSENCE, the other direction: published is true, so prose that says
	// there is no release yet must fail whatever its subject is called.
	['stale: 1.0 packages', 'The 1.0 packages are still to come.', true],
	['stale: something to install', 'Something you can actually install is still to come.', true],
	['stale: installers', 'Installers are still to come.', true],
	[
		'honest: ideally',
		'Ideally a signature over that list too, but ours does not have one yet.',
		false
	],
	[
		'honest: the real current copy',
		'Public source, public CI, published checksums, and build provenance naming the workflow and commit that built it. The checksum list is not signed yet, and the binaries are not code-signed.',
		false
	]
];

function setup() {
	rmSync(DIR, { recursive: true, force: true });
	for (const dir of ['site', 'src', 'tools']) {
		cpSync(join(REPO, dir), join(DIR, dir), { recursive: true });
	}
	for (const file of [
		'package.json',
		'LICENSE',
		'README.md',
		'THREAT_MODEL.md',
		'SECURITY.md',
		'CHANGELOG.md'
	]) {
		if (existsSync(join(REPO, file))) {
			cpSync(join(REPO, file), join(DIR, file));
		}
	}
	// Linked, not copied: it is the one directory large enough to matter.
	symlinkSync(join(REPO, 'node_modules'), join(DIR, 'node_modules'), 'junction');
	if (swapVerifier) {
		cpSync(swapVerifier, join(DIR, 'site', 'verify.mjs'));
	}
}

function run(sentence, pristine) {
	const page = join(DIR, 'site', ANCHOR_FILE);
	writeFileSync(page, pristine.replace(ANCHOR, JSON.stringify(sentence)));
	try {
		execFileSync('node', ['site/build.mjs'], { cwd: DIR, stdio: 'pipe' });
	} catch (err) {
		return { error: 'build failed: ' + String(err.stderr || err.stdout || err).slice(-300) };
	}
	try {
		execFileSync('node', ['site/verify.mjs'], { cwd: DIR, stdio: 'pipe' });
		return { code: 0, note: '' };
	} catch (err) {
		const out = String(err.stdout || '');
		const line = out
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l.startsWith('-'));
		return { code: err.status, note: (line ?? out.trim().split('\n').pop() ?? '').slice(0, 110) };
	}
}

setup();
const pristine = readFileSync(join(DIR, 'site', ANCHOR_FILE), 'utf8');
if (!pristine.includes(ANCHOR)) {
	console.log('the anchor sentence is gone from ' + ANCHOR_FILE + '; this harness needs updating');
	process.exit(2);
}

let wrong = 0;
console.log(swapVerifier ? `verifier: ${swapVerifier}` : 'verifier: the working tree');
for (const [name, sentence, mustFail] of CASES) {
	const result = run(sentence, pristine);
	if (result.error) {
		console.log(`  ERROR  ${name}: ${result.error}`);
		wrong += 1;
		continue;
	}
	const ok = (result.code !== 0) === mustFail;
	if (!ok) wrong += 1;
	console.log(
		`  ${ok ? 'ok   ' : 'WRONG'} ${mustFail ? 'must FAIL' : 'must PASS'}  exit=${result.code}  ${name}` +
			(result.note ? `\n            ${result.note}` : '')
	);
}
rmSync(DIR, { recursive: true, force: true });

/*
 * **A non-zero exit, or this whole file is decoration.**
 *
 * It ran for a while printing WRONG lines and exiting 0, which would have made
 * its CI step a no-op — the exact shape of defect it was written to catch, in
 * the thing catching it.
 */
if (wrong > 0) {
	console.error(`\n${wrong} of ${CASES.length} wrong — the tripwire does not do what it says`);
	process.exit(1);
}
console.log(`\nall ${CASES.length} correct`);
