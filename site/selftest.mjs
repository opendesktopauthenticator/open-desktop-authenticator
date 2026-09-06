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
 * **This has to follow a claim that is still false, and `signed` no longer is.**
 *
 * It used to substitute into the homepage's *unsigned* branch and test the
 * `signed` claim, which was right for as long as no signed release existed. The
 * v1.5.0 release publishes `SHA256SUMS.txt.sig` and `.pem`, so `signed` is now
 * true — and that broke this file twice over. The unsigned branch stopped
 * rendering, so a sentence substituted into it never reached the built page; and
 * `verify.mjs` skips a claim entirely once its flag is true (`if
 * (SITE.release[claim.flag]) continue`), so the patterns were never consulted
 * either. Eleven of seventeen cases went quietly wrong, which is precisely the
 * regression this file exists to make visible — about itself, this time.
 *
 * So it anchors on the branch that renders *now*, and tests `reproducible`,
 * which is still false and has its own entry in `verify.mjs`'s CLAIMS table.
 * The mechanism under test is unchanged: substitute one sentence, build, and see
 * whether the verifier's exit code is what the table says it should be.
 *
 * **When `reproducible` becomes true this file must move again**, to whichever
 * claim is false then — `codeSigned`, `gpgSignature` and `audited` are all still
 * available. A tripwire that covers nothing passes silently, so the day no false
 * claim is left is the day this file needs a different design, not deletion.
 */
const ANCHOR =
	"'Published checksums, a signature over that list, and provenance naming the workflow and commit that built it.'";

const CASES = [
	// [name, sentence, must the build FAIL?]
	//
	// The four `reproducible` patterns in verify.mjs's CLAIMS table, one case
	// each, plus the variations that caught real defects in the `signed` entry
	// when this file was written: a determiner in front, and a trailing clause
	// after. Both are how an overclaim actually gets written by someone who
	// believes it.
	['plain overclaim', 'Builds are reproducible.', true],
	['overclaim, our', 'Our builds are reproducible.', true],
	['overclaim, singular', 'The build is reproducible.', true],
	[
		'the phrasing a reader would write',
		'Every release is built reproducible from that source.',
		true
	],
	[
		'the same, with a trailing clause',
		'Builds are reproducible, so you do not have to trust us.',
		true
	],
	[
		'beside an unrelated denial',
		'Builds are reproducible, and the binaries are not code-signed yet.',
		true
	],
	[
		'the invitation to compare',
		'Compare your build against ours byte for byte and they will match.',
		true
	],

	[
		'honest: not yet',
		'Builds are not yet reproducible, and the binaries are not code-signed.',
		false
	],
	/*
	 * **"reproducible builds are still to come" is a wording the site cannot
	 * use, and that is a finding rather than a case.**
	 *
	 * It is honest — reproducible builds genuinely are still to come — but it
	 * contains "builds are still to come", which STALE_ABSENCE reads as the page
	 * claiming no release exists at all, and `published` is now true. So the
	 * build fails on a true sentence.
	 *
	 * Left as a note instead of a passing case, because writing it as `true`
	 * would assert that the false positive is correct, and loosening
	 * STALE_ABSENCE to allow it would weaken the guard that catches a page still
	 * saying nothing has shipped. The three honest phrasings below do not
	 * collide, and the site uses one of them.
	 */
	[
		'honest: the real current copy',
		'Builds are not yet reproducible: you cannot compile the tag yourself and get byte-for-byte identical output.',
		false
	],
	['honest: cannot rebuild', 'You cannot rebuild this tag and get the same bytes.', false],
	// STALE_ABSENCE, the other direction: published is true, so prose that says
	// there is no release yet must fail whatever its subject is called.
	['stale: 1.0 packages', 'The 1.0 packages are still to come.', true],
	['stale: something to install', 'Something you can actually install is still to come.', true],
	['stale: installers', 'Installers are still to come.', true],
	/*
	 * Two cases were removed here rather than rewritten, and it is worth saying
	 * why: both asserted that prose denying a signature must PASS. That was true
	 * while none existed. v1.5.0 publishes one, so "ours does not have one yet"
	 * is now a stale absence — the failure the STALE_ABSENCE table above exists
	 * to catch — and keeping them would have pinned the site's right to say
	 * something false about itself.
	 */
	[
		'stale: denying the signature we now publish',
		'A signature over that list is still to come.',
		true
	]
];

function setup() {
	rmSync(DIR, { recursive: true, force: true });
	for (const dir of ['site', 'src', 'tools']) {
		cpSync(join(REPO, dir), join(DIR, dir), { recursive: true });
	}
	for (const file of [
		'package.json',
		// The security page counts the shipping closure, not just the names in
		// `dependencies`, so the build reads this too. Without it the whole
		// selftest reported seventeen failures for one missing file.
		'package-lock.json',
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
