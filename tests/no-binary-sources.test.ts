import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * **A source file with a NUL in it is a source file nobody can review.**
 *
 * Git decides a blob is binary by looking for a NUL in its first 8000 bytes.
 * Once it decides, `git diff` prints "Binary files differ" and nothing else: no
 * hunks in review, no `git blame`, no `grep`. The file still runs, still passes,
 * and stops being readable by every tool a reviewer has.
 *
 * Two of these were security regression tests — the upload memory bound and the
 * notification composition rules — which is the worst possible pair to make
 * invisible. Both came from writing bytes as literals where a numeric escape
 * would do: an MP4 signature in one, control characters in the other.
 *
 * The control characters in the notification fixtures are the *point* of that
 * test, so this does not forbid testing them. It forbids the literal byte, which
 * is only a spelling choice: the escape produces the same string at runtime and
 * leaves the file readable.
 *
 * Nothing guarded this before — not eslint, not .gitattributes — so the two that
 * were fixed could come back on the next edit with nobody the wiser. They are
 * also easy to reintroduce by accident: a shell heredoc that interprets an
 * escape hands the writing tool a real byte, which is how this very file first
 * failed its own check.
 *
 * Written with codepoint arithmetic rather than a character-class regex for that
 * reason: a guard against literal control characters must not need one to say so.
 */

const ROOT = join(__dirname, '..');

/** Where hand-written source lives. Generated trees are somebody else's rules. */
const ROOTS = ['src', 'tests', 'tools', 'site', 'scripts', 'tickets', '.github'];

const SKIP = new Set(['node_modules', 'dist', 'out', '.git', 'coverage']);

/**
 * Extensions that are text by nature. An icon or a font legitimately contains
 * NULs, so listing what to *check* is safer than listing what to skip — a new
 * binary asset type must not silently start failing this.
 */
const TEXT = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html|sh|mjs|cjs)$/;

function sourceFiles(dir: string, found: string[] = []): string[] {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (SKIP.has(entry)) {
			continue;
		}
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			sourceFiles(full, found);
		} else if (TEXT.test(entry)) {
			found.push(full);
		}
	}
	return found;
}

const FILES = ROOTS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

/** Tab, newline and carriage return are ordinary text. The rest of C0 is not. */
const ALLOWED = new Set([9, 10, 13]);

function controlBytesIn(bytes: Buffer): number[] {
	const seen = new Set<number>();
	for (const byte of bytes) {
		if (byte < 0x20 && !ALLOWED.has(byte)) {
			seen.add(byte);
		}
	}
	return [...seen].sort((a, b) => a - b);
}

function offenders(predicate: (bytes: Buffer) => boolean): string[] {
	return FILES.filter((file) => predicate(readFileSync(file))).map((file) =>
		relative(ROOT, file).replace(/\\/g, '/')
	);
}

describe('the source tree stays reviewable', () => {
	it('finds files to check, or this asserts nothing', () => {
		expect(FILES.length).toBeGreaterThan(200);
	});

	/*
	 * The first 8000 bytes are what git actually inspects, but the whole file is
	 * checked: a NUL further in makes the file no less wrong to write, and the
	 * threshold is git's implementation detail rather than the rule.
	 */
	it('has no file carrying a literal NUL byte', () => {
		expect(
			offenders((bytes) => bytes.includes(0)),
			'these files contain a literal NUL, so git treats them as binary: no diff in review, no ' +
				'blame, no grep. Write it as a numeric escape, or build the buffer from byte values — ' +
				'the string produced is identical and the file stays readable'
		).toEqual([]);
	});

	/*
	 * And the rest of the C0 range. A stray form feed or escape does not trip
	 * git's binary detection, but it is invisible in review for the same reason
	 * and arrives the same way.
	 */
	it('has no file carrying other invisible control characters', () => {
		const found = FILES.map((file) => ({
			file: relative(ROOT, file).replace(/\\/g, '/'),
			bytes: controlBytesIn(readFileSync(file))
		}))
			.filter((hit) => hit.bytes.length > 0)
			.map(
				(hit) => `${hit.file} (${hit.bytes.map((byte) => `0x${byte.toString(16)}`).join(', ')})`
			);

		expect(
			found,
			'these files carry literal control characters. They are invisible in review and in most ' +
				'editors; write them as escapes so the next reader can see what the test is about'
		).toEqual([]);
	});
});
