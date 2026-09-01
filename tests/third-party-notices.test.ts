import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Every dependency this application ships is under a licence that requires its
 * text to travel with the binary.**
 *
 * MIT puts it in one sentence: the notice "shall be included in all copies or
 * substantial portions of the Software". Until `scripts/generate-notices.mjs`
 * existed that happened by accident — electron-builder copies whatever a package
 * directory contains, and most packages keep a `LICENSE` beside their code — and
 * the accident had holes that were measured rather than guessed:
 *
 *   - `!node_modules/ ** /*.{ts,md,markdown,flow,coffee}` strips `LICENSE.md`,
 *     which is the only licence file `ms`, `permessage-deflate` and
 *     `websocket-extensions` have. Their code shipped and their notice did not.
 *   - `@doctormckay/stdlib`, `agent-base` and `socks-proxy-agent` include no
 *     licence file at all, declaring it only in `package.json`.
 *   - `react`, `react-dom` and `scheduler` are excluded from the asar entirely,
 *     because Vite compiles them into the renderer bundle. Their code ships;
 *     their package directories do not; nothing replaced the notice.
 *
 * The file is generated from the same production closure the SBOM guard derives
 * from — two different ideas of "what ships" is how those come to disagree — and
 * this regenerates it and compares, so a dependency added without re-running the
 * script is a failing test rather than a missing notice.
 */

const ROOT = join(__dirname, '..');
const NOTICES = join(ROOT, 'THIRD_PARTY_NOTICES.txt');

/** The production closure, read the way the generator reads it. */
function closure(): { name: string; version: string }[] {
	const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
		packages: Record<string, { dev?: boolean; name?: string; version?: string }>;
	};
	return Object.entries(lock.packages)
		.filter(([path, entry]) => path !== '' && !entry.dev)
		.map(([path, entry]) => ({
			name: entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
			version: entry.version ?? ''
		}));
}

describe('the third-party notices the installer carries', () => {
	it('exists', () => {
		expect(
			existsSync(NOTICES),
			'no notices file has been generated, so the installer ships dependency code with no ' +
				'licence text for the packages whose own files are stripped or absent'
		).toBe(true);
	});

	const text = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : '';

	it('names every package the installer carries', () => {
		const listed = closure().filter(
			(entry) => !text.includes(`\n${entry.name} ${entry.version}\n`)
		);

		expect(
			listed.map((entry) => `${entry.name}@${entry.version}`),
			'these shipped packages have no entry in the notices file, so the application distributes ' +
				'their code without the notice their licence requires'
		).toEqual([]);
	});

	/**
	 * The six the accident missed, named individually. A generator that produced
	 * an entry for everything and text for nothing would pass the check above.
	 */
	it.each([
		['ms', 'a licence only in LICENSE.md'],
		['permessage-deflate', 'a licence only in LICENSE.md'],
		['websocket-extensions', 'a licence only in LICENSE.md'],
		['react', 'excluded from the asar and bundled into the renderer'],
		['react-dom', 'excluded from the asar and bundled into the renderer'],
		['scheduler', 'excluded from the asar and bundled into the renderer']
	])('carries real licence text for %s, which has %s', (name) => {
		const start = text.indexOf(`\n${name} `);
		expect(start, `${name} has no section at all`).toBeGreaterThan(-1);
		const section = text.slice(start, text.indexOf('='.repeat(76), start + 1));

		expect(
			section,
			`${name} is listed without the licence text its own package directory does not deliver`
		).toMatch(/Copyright|Permission is hereby granted|Licensed under/i);
	});

	/* And the three that ship no file are at least attributed. */
	it.each(['@doctormckay/stdlib', 'agent-base', 'socks-proxy-agent'])(
		'names the declared licence for %s, which ships no licence file',
		(name) => {
			const start = text.indexOf(`\n${name} `);
			expect(start, `${name} has no section at all`).toBeGreaterThan(-1);
			const section = text.slice(start, text.indexOf('='.repeat(76), start + 1));
			expect(section).toMatch(/declares: \w/);
		}
	);

	/**
	 * **Regenerated and compared**, so a dependency added without re-running the
	 * script fails here rather than shipping without a notice. The generator is
	 * pure — lockfile in, text out — so a difference means the file is stale.
	 */
	it('is up to date with the lockfile', () => {
		const dir = mkdtempSync(join(tmpdir(), 'oda-notices-'));
		try {
			const fresh = join(dir, 'NOTICES.txt');
			execFileSync(process.execPath, [join(ROOT, 'scripts', 'generate-notices.mjs')], {
				cwd: ROOT,
				env: { ...process.env, ROOT, OUT: fresh },
				stdio: 'pipe'
			});
			expect(
				readFileSync(fresh, 'utf8'),
				'the notices file does not match what the generator produces now — a dependency was ' +
					'added or changed without running `npm run notices`'
			).toBe(text);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/**
	 * **The same bytes on every platform, because it is committed and compared.**
	 *
	 * Some packages ship a licence with CRLF. `.gitattributes` normalises this
	 * file to LF on the way into the repository, so a fresh checkout had LF on
	 * disk while a fresh generation reproduced the CRLF — and the comparison above
	 * then failed on every runner, for a file nobody had touched. Measured before
	 * the generator was made to flatten them: 665 CRLF pairs against none in the
	 * committed blob.
	 */
	it('has no carriage returns in it', () => {
		const bytes = readFileSync(NOTICES);
		const crlf = bytes.reduce(
			(count, byte, index) => (byte === 13 && bytes[index + 1] === 10 ? count + 1 : count),
			0
		);
		expect(
			crlf,
			'a licence with CRLF was copied through verbatim, so what git stores and what the ' +
				'generator produces are different files and the comparison above fails on a fresh clone'
		).toBe(0);
	});

	/**
	 * **The installer actually includes it — read from the array, not the text.**
	 *
	 * This asserted the string appeared anywhere in the config source, so
	 * commenting the entry out kept it green while the file stopped shipping. The
	 * comment explaining why it is there would have satisfied it on its own.
	 */
	it('is in the packaging rules', async () => {
		const config = await import('../electron-builder.config.mjs');
		expect(
			config.default.files,
			'electron-builder.config.mjs exports no files array'
		).toBeInstanceOf(Array);
		expect(
			config.default.files,
			'the notices file is generated and then left out of the installer, which is the same as ' +
				'not having one'
		).toContain('THIRD_PARTY_NOTICES.txt');
	});

	/**
	 * **Every licence file a package ships is read, whatever it is called.**
	 *
	 * The match anchored on the word and required a dot or the end of the name
	 * after it, so `LICENSE-MIT.txt` did not match — and `punycode`, which ships
	 * exactly that and nothing else, was written up as "No licence file is
	 * included in this package". A false statement, in a legal notice, about a
	 * file sitting in the directory being read.
	 */
	it('reads a licence whose name carries a suffix', () => {
		const start = text.indexOf(String.fromCharCode(10) + 'punycode ');
		expect(start, 'punycode has no section').toBeGreaterThan(-1);
		const section = text.slice(start, text.indexOf('='.repeat(76), start + 1));

		expect(
			section,
			'punycode ships LICENSE-MIT.txt and the notices say it ships no licence file'
		).not.toMatch(/No licence file is included/);
		expect(section).toMatch(/Permission is hereby granted|Copyright/i);
	});

	/**
	 * **And the runtime, which is the largest third-party body in the installer.**
	 *
	 * Electron is a devDependency because at build time it is a build tool, so the
	 * closure walk left it out — while the header claimed the file lists
	 * everything the application includes.
	 */
	it('names the Electron runtime and where the rest of its licences are', () => {
		const start = text.indexOf(String.fromCharCode(10) + 'electron ');
		expect(start, 'the runtime is not in the notices at all').toBeGreaterThan(-1);
		const section = text.slice(start, text.indexOf('='.repeat(76), start + 1));

		expect(section, 'the version is not the one package.json pins').toMatch(/electron \d+\./);
		expect(
			section,
			'nothing says where Chromium and Node.js licences are, and they are not in this file'
		).toMatch(/LICENSES\.chromium\.html/);
		expect(section).toMatch(/Copyright/i);
	});
});
