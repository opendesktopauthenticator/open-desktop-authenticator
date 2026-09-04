import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * See `builder-exclusions.test.ts` for why the script is reached this way: CI
 * runs it with bare `node`, so it is a real ES module, and these tests compile
 * as CommonJS.
 */
type Contents = typeof import('../.github/scripts/shipping-contents.mjs', {
	with: { 'resolution-mode': 'import' }
});

let strippedExtensionsFrom: Contents['strippedExtensionsFrom'];
let carriesCode: Contents['carriesCode'];

beforeAll(async () => {
	({ strippedExtensionsFrom, carriesCode } =
		await import('../.github/scripts/shipping-contents.mjs'));
});

/**
 * **The third answer the release report was missing.**
 *
 * It told a reader that every production dependency reaches them one of two
 * ways: as a package directory inside the asar, or compiled into the renderer
 * bundle. Two packages fit neither. `@types/node` and `undici-types` are in the
 * closure because `protobufjs` depends on the first and it depends on the
 * second, and every file either one contains is a TypeScript declaration that
 * the packaging rules strip. What ships is `package.json` and `LICENSE`.
 *
 * The report was true about the rule it read and false about what a reader takes
 * from it, which is the same defect as the exclusion parser next door — and it
 * was in a published document both times.
 *
 * The fix that would have been wrong is a list of the two names. This asks the
 * property instead: what survives the filters, read out of the real builder
 * config. A `@types/*` package that started shipping a `.js` shim would be
 * reclassified on the next run with nobody editing anything.
 */

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'oda-shipping-'));
	for (const [path, body] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, body);
	}
	return root;
}

/**
 * The rules the installer really carries, imported rather than hand-copied.
 *
 * This was a literal copy of the `files` array, and it went stale the moment the
 * real one changed: it still said `out/**` after the build trees were named
 * individually, and knew nothing about the notices file or the two exclusions
 * added since — while calling itself "the rules the installer really carries".
 * Every case below was then measured against a configuration that does not ship.
 */
const REAL_FILES: unknown[] = [];

beforeAll(async () => {
	const config = await import('../electron-builder.config.mjs');
	REAL_FILES.push(...(config.default.files ?? []));
	expect(REAL_FILES.length, 'the builder config exports no files array').toBeGreaterThan(5);
});

describe('which extensions the packaging rules strip', () => {
	it('reads a brace list', () => {
		const stripped = strippedExtensionsFrom(REAL_FILES);
		for (const extension of ['.ts', '.md', '.markdown', '.flow', '.coffee']) {
			expect(stripped, `${extension} is stripped by the real config and was not read`).toContain(
				extension
			);
		}
	});

	it('reads a brace list that has a stem in front of it', () => {
		// `*.d.{ts,cts,mts}` — the `.d` matters, because `.cts` alone is a source
		// extension nothing strips and `.d.cts` is a declaration everything does.
		const stripped = strippedExtensionsFrom(REAL_FILES);
		expect(stripped).toContain('.d.cts');
		expect(stripped).toContain('.d.mts');
		expect(stripped).not.toContain('.cts');
	});

	it('reads a single extension', () => {
		expect(strippedExtensionsFrom(REAL_FILES)).toContain('.map');
	});

	/*
	 * An entry naming one package cannot empty a different one, and treating it
	 * as global is how a report starts calling packages empty that are not.
	 */
	it('ignores an exclusion that names a single package', () => {
		expect(strippedExtensionsFrom(['!node_modules/react/*.js'])).toEqual(new Set());
	});

	it('ignores entries that exclude nothing', () => {
		expect(strippedExtensionsFrom(['out/**/*', 'package.json'])).toEqual(new Set());
	});

	it('survives an object entry rather than stringifying it', () => {
		expect(strippedExtensionsFrom([{ from: 'a', to: 'b' }])).toEqual(new Set());
	});
});

describe('whether a package carries code once the rules have run', () => {
	const stripped = () => strippedExtensionsFrom(REAL_FILES);

	it('says no for a declarations-only package', () => {
		const root = tree({
			'package.json': '{"name":"@types/thing","types":"index.d.ts"}',
			LICENSE: 'MIT',
			'index.d.ts': 'export {};',
			'fs/promises.d.ts': 'export {};'
		});
		expect(
			carriesCode(root, stripped()),
			'every file here is a declaration the installer strips, so what ships is a manifest and ' +
				'a licence — calling that a shipping package directory overstates it'
		).toBe(false);
	});

	it('says yes as soon as one loadable file survives', () => {
		const root = tree({
			'package.json': '{"name":"@types/thing"}',
			LICENSE: 'MIT',
			'index.d.ts': 'export {};',
			'shim.js': 'module.exports = {};'
		});
		expect(carriesCode(root, stripped())).toBe(true);
	});

	it('says yes for an ordinary package', () => {
		const root = tree({
			'package.json': '{"name":"zod","main":"index.js"}',
			'index.js': 'module.exports = {};',
			'README.md': '# zod'
		});
		expect(carriesCode(root, stripped())).toBe(true);
	});

	/*
	 * Licences arrive spelled every possible way, and one counted as code would
	 * put a package straight back into the overstating group.
	 */
	it.each(['LICENSE', 'LICENCE', 'license.txt', 'LICENSE-MIT', 'COPYING', 'NOTICE'])(
		'does not count %s as code',
		(name) => {
			const root = tree({
				'package.json': '{"name":"@types/thing"}',
				[name]: 'text',
				'index.d.ts': 'export {};'
			});
			expect(carriesCode(root, stripped())).toBe(false);
		}
	);

	/*
	 * A nested dependency is its own entry in the closure. Counting its files
	 * here would report an empty package as full because something underneath it
	 * is not.
	 */
	it('does not count a nested dependency as this package carrying code', () => {
		const root = tree({
			'package.json': '{"name":"@types/thing"}',
			'index.d.ts': 'export {};',
			'node_modules/undici-types/index.js': 'module.exports = {};'
		});
		expect(carriesCode(root, stripped())).toBe(false);
	});

	/*
	 * **Which way this is allowed to be wrong.** The whole finding is an
	 * overstatement, so the error that must be impossible is calling a package
	 * empty when it is not. A directory nobody can read is reported the loud way.
	 */
	it('reports a directory it cannot read as carrying code', () => {
		expect(carriesCode(join(tmpdir(), 'oda-no-such-package-directory'), stripped())).toBe(true);
	});
});

/**
 * And the two packages the finding was actually about, in the tree on this
 * machine — so this file cannot pass while describing an installed tree that
 * does not exist.
 */
describe('the production closure as it is installed here', () => {
	const modules = join(__dirname, '..', 'node_modules');

	it.each(['@types/node', 'undici-types'])('%s ships no loadable code', (name) => {
		const dir = join(modules, name);
		if (!existsSync(dir)) {
			// Skipping is the honest outcome — the alternative is a green result
			// that measured nothing at all.
			expect.fail(`${name} is not installed, so this asserts nothing about the shipping tree`);
		}
		expect(
			carriesCode(dir, strippedExtensionsFrom(REAL_FILES)),
			`${name} is in the production closure and the report describes it as a package directory ` +
				'inside the asar. Every file it holds is a declaration the installer strips'
		).toBe(false);
	});

	it.each(['zod', 'protobufjs'])('%s does ship code', (name) => {
		const dir = join(modules, name);
		if (!existsSync(dir)) {
			expect.fail(`${name} is not installed, so this asserts nothing about the shipping tree`);
		}
		expect(carriesCode(dir, strippedExtensionsFrom(REAL_FILES))).toBe(true);
	});
});
