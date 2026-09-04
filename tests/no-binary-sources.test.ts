import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **A tracked file with a NUL in it is a file nobody can review.**
 *
 * Git decides a blob is binary by looking for a NUL in its first 8000 bytes.
 * Once it decides, `git diff` prints "Binary files differ" and nothing else: no
 * hunks in review, no `git blame`, no `git grep`. The file still runs, still
 * passes, and stops being readable by every tool a reviewer has.
 *
 * Two of these were security regression tests — the upload memory bound and the
 * notification composition rules — which is the worst possible pair to make
 * invisible. A third was a word boundary in the threat-model guard written as a
 * literal backspace, which no document contains, so half of that check could
 * never match anything and passed for exactly that reason. All three came from
 * writing bytes as literals where a numeric escape would do.
 *
 * The control characters in the notification fixtures are the *point* of that
 * test, so this does not forbid testing them. It forbids the literal byte, which
 * is only a spelling choice: the escape produces the same string at run time and
 * leaves the file readable.
 *
 * ## Why the file list comes from git
 *
 * The damage is entirely git's behaviour, so the set to check is exactly the set
 * git tracks. Asking it directly is also the only version of this that cannot
 * quietly stop covering something: the first draft walked a hand-written list of
 * source directories and missed `docs/` — where both published documents live,
 * and where a control character had in fact just been fixed — along with every
 * configuration file at the repository root. It reported 254 files out of 381
 * tracked and looked healthy doing it.
 *
 * Untracked trees drop out for free, which is the other half: `release/`,
 * `sbom-root/` and `node_modules/` need no exclusion list to maintain, because a
 * file git does not track cannot be a file git renders unreviewable.
 *
 * ## Why `.gitattributes` decides what is exempt
 *
 * Icons and installer bitmaps contain NULs because that is what they are. The
 * exemption is read from `.gitattributes` rather than listed here, because that
 * file is where this repository already declares which assets are binary and two
 * lists of the same thing drift. It also means the failure for an undeclared
 * binary asset is the right one: `.gitattributes` says `* text=auto eol=lf`, so
 * a new asset nobody declared is a real omission there, and this says so in
 * those words rather than reporting it as a corrupt source file.
 *
 * There is no allow-list of text extensions on purpose. An allow-list answers
 * "should I look at this?" with silence when it has no opinion, and silence is
 * the failure mode every guard in this repository has been defeated by.
 */

const ROOT = join(__dirname, '..');

/** Tab, newline and carriage return are ordinary text. The rest of C0 is not. */
const ALLOWED = new Set([9, 10, 13]);

/**
 * Every path git tracks.
 *
 * `-z` because a filename may contain anything but NUL, and the newline-
 * separated form quotes such a name into an escape sequence that no longer
 * opens. A failure here is thrown rather than swallowed: a check that silently
 * examined nothing is the thing being guarded against.
 */
function trackedFiles(): string[] {
	const out = execFileSync('git', ['ls-files', '-z'], {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024
	});
	return out.split('\0').filter((path) => path !== '');
}

/**
 * Path patterns `.gitattributes` marks `binary`.
 *
 * Only the simple trailing-glob form this repository uses is understood
 * (`*.png binary`). Anything else is deliberately not interpreted: a pattern
 * this cannot read must not be taken as an exemption, because an exemption
 * granted by accident is how a real NUL would get through.
 */
function binaryExtensions(): Set<string> {
	const declared = new Set<string>();
	const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8');

	for (const line of attributes.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) {
			continue;
		}
		const [pattern, ...attrs] = trimmed.split(/\s+/);
		if (!attrs.includes('binary')) {
			continue;
		}
		const match = /^\*(\.[A-Za-z0-9]+)$/.exec(pattern ?? '');
		if (match?.[1]) {
			declared.add(match[1].toLowerCase());
		}
	}

	return declared;
}

const FILES = trackedFiles();
const BINARY = binaryExtensions();

const isDeclaredBinary = (path: string): boolean => {
	const dot = path.lastIndexOf('.');
	return dot === -1 ? false : BINARY.has(path.slice(dot).toLowerCase());
};

/** Every distinct C0 byte in the file, for a message that says what to look for. */
function controlBytesIn(path: string): number[] {
	const seen = new Set<number>();
	for (const byte of readFileSync(join(ROOT, path))) {
		if (byte < 0x20 && !ALLOWED.has(byte)) {
			seen.add(byte);
		}
	}
	return [...seen].sort((a, b) => a - b);
}

describe('the source tree stays reviewable', () => {
	/*
	 * Both floors are the real counts less a little slack, not round numbers.
	 * A loose floor is the same defect as no floor: the first draft asserted
	 * "more than 200" while inspecting 254 of 381 tracked files, so deleting a
	 * whole source root from its list would not have moved it.
	 */
	it('reads the tracked file list, or this asserts nothing', () => {
		expect(
			FILES.length,
			'git ls-files returned far fewer paths than this repository has, so whatever passes below ' +
				'passed by not looking'
		).toBeGreaterThan(350);
	});

	it('reads the binary declarations, or everything looks exempt', () => {
		expect(
			BINARY.size,
			'.gitattributes declared no binary extensions this could parse. Every icon would then be ' +
				'reported as a corrupt source file, and the reflex fix — widening the exemption — is how ' +
				'this check would stop meaning anything'
		).toBeGreaterThan(3);
	});

	/*
	 * The first 8000 bytes are what git actually inspects, but the whole file is
	 * checked: a NUL further in makes the file no less wrong to write, and the
	 * threshold is git's implementation detail rather than the rule.
	 */
	it('has no tracked file carrying a literal NUL byte', () => {
		const offenders = FILES.filter((path) => !isDeclaredBinary(path)).filter((path) =>
			readFileSync(join(ROOT, path)).includes(0)
		);

		expect(
			offenders,
			'these files contain a literal NUL, so git treats them as binary: no diff in review, no ' +
				'blame, no grep. If one is a source file, write the byte as a numeric escape or build ' +
				'the buffer from byte values — the string produced is identical and the file stays ' +
				'readable. If one is a binary asset, declare its extension in .gitattributes, which is ' +
				'where this repository records that and where the omission actually is'
		).toEqual([]);
	});

	/*
	 * And the rest of the C0 range. A stray form feed or escape does not trip
	 * git's binary detection, but it is invisible in review for the same reason
	 * and arrives the same way — a backspace written where `\b` was meant is the
	 * one that got through last time.
	 */
	it('has no tracked file carrying other invisible control characters', () => {
		const offenders = FILES.filter((path) => !isDeclaredBinary(path))
			.map((path) => ({ path, bytes: controlBytesIn(path) }))
			.filter((hit) => hit.bytes.length > 0)
			.map(
				(hit) => `${hit.path} (${hit.bytes.map((byte) => `0x${byte.toString(16)}`).join(', ')})`
			);

		expect(
			offenders,
			'these files carry literal control characters. They are invisible in review and in most ' +
				'editors; write them as escapes so the next reader can see what the test is about'
		).toEqual([]);
	});
});
