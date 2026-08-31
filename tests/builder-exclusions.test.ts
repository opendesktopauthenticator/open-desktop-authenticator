import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * `resolution-mode` says to resolve the type the way the runtime `import()`
 * below will, rather than the way this CommonJS file resolves everything else.
 * Without it TypeScript refuses the type reference outright (TS1542), and the
 * tempting fix — dropping the type and letting the import arrive as `any` — is
 * what made fifteen real type errors invisible a moment ago.
 */
type Parser = typeof import('../.github/scripts/builder-exclusions.mjs', {
	with: { 'resolution-mode': 'import' }
});

/*
 * Loaded through `await import` rather than a static one, which is how
 * `store-identity.mjs` is already reached from `tests/artifact-names.test.ts`.
 * These tests compile as CommonJS and the script is a real ES module, because CI
 * runs it with bare `node` between the checkout and the release guard, with no
 * build step in between. A static import of one from the other is the error TS
 * numbers 1479; the dynamic form is the shape that is actually legal, and the
 * hand-written `.d.mts` beside the script is what keeps it type-checked instead
 * of arriving as `any`.
 */
let excludedPackagesFrom: Parser['excludedPackagesFrom'];
let ExclusionShapeError: Parser['ExclusionShapeError'];

beforeAll(async () => {
	({ excludedPackagesFrom, ExclusionShapeError } =
		await import('../.github/scripts/builder-exclusions.mjs'));
});

/**
 * **What the published SBOM is allowed to claim about the installer.**
 *
 * The release guard says, of every production dependency, how it reaches the
 * user: as a package directory inside the asar, or compiled into the renderer
 * bundle. That sentence is only true if the packaging rules are read correctly,
 * and reading them is what this does.
 *
 * It read them by matching one literal spelling. A verifier substituted
 * electron-builder's other standard spelling of the *same* exclusion — a one
 * character difference — and the guard stayed green while the report went back
 * to claiming all forty packages ship as directories inside the asar. That is
 * the exact false statement the check was added to remove, restored silently.
 *
 * This repo's named recurring failure is guards that assert on the literal text
 * of source instead of the property. This is that failure, in the script whose
 * output is a public document.
 *
 * So the rule is **classify or refuse**, never skip: anything naming a concrete
 * package that cannot confidently be placed stops the release, because the
 * alternative is publishing a guess.
 */

const EXCLUDED = ['react', 'react-dom', 'scheduler'];

describe('exclusions that remove a whole package', () => {
	/*
	 * All of these are the same rule. electron-builder accepts every one, and a
	 * guard that recognises only the first is a guard that can be defeated by
	 * reformatting.
	 */
	it.each<[string, string[]]>([
		['a brace list with a doubled star', ['!node_modules/{react,react-dom,scheduler}/**']],
		[
			'a brace list with a doubled star and a single',
			['!node_modules/{react,react-dom,scheduler}/**/*']
		],
		['a brace list with one star', ['!node_modules/{react,react-dom,scheduler}/*']],
		[
			'separate entries with a doubled star',
			['!node_modules/react/**', '!node_modules/react-dom/**', '!node_modules/scheduler/**']
		],
		[
			'separate entries with a doubled star and a single',
			['!node_modules/react/**/*', '!node_modules/react-dom/**/*', '!node_modules/scheduler/**/*']
		],
		[
			'separate entries with one star',
			['!node_modules/react/*', '!node_modules/react-dom/*', '!node_modules/scheduler/*']
		],
		['spaces inside the brace list', ['!node_modules/{react, react-dom, scheduler}/**']]
	])('are recognised when written as %s', (_shape, files) => {
		expect(
			[...excludedPackagesFrom(files)].sort(),
			'this spelling of the exclusion was not recognised, so the SBOM would claim these ' +
				'packages ship as directories inside the asar when the installer does not contain them'
		).toEqual(EXCLUDED);
	});
});

describe('exclusions that only trim files out of a package', () => {
	/*
	 * The package still ships as a directory, which is what the report is about.
	 * Folding these in would claim react's fate for every dependency in the tree.
	 */
	it.each([
		['type declarations across every package', '!node_modules/**/*.d.{ts,cts,mts}'],
		['a test directory across every package', '!node_modules/**/test/**'],
		['one subdirectory of one package', '!node_modules/react/lib/**'],
		['one file type in one package', '!node_modules/react/**/*.map']
	])('leave %s out of the excluded set', (_what, pattern) => {
		expect(excludedPackagesFrom([pattern])).toEqual(new Set());
	});

	it('ignores entries that are not node_modules exclusions at all', () => {
		expect(excludedPackagesFrom(['out/**', '!**/*.md', 'package.json'])).toEqual(new Set());
	});
});

/**
 * **The half that was missing: refusing what it cannot read.**
 *
 * The first version `continue`d on anything unrecognised, which is how the
 * equivalent glob slipped past. Silence is the defect; an exclusion this cannot
 * classify has to stop the release.
 */
describe('exclusions this cannot classify', () => {
	it('refuses an object entry rather than stringifying it', () => {
		expect(
			() => excludedPackagesFrom([{ from: 'assets', to: 'assets' }]),
			'an object entry became "[object Object]", matched nothing, and was skipped — so an ' +
				'exclusion written that way is invisible to the report'
		).toThrow(ExclusionShapeError);
	});

	it('refuses a brace list after the package name', () => {
		// Could hide a whole-package exclusion among alternatives, and expanding it
		// here would be a second glob engine.
		expect(() => excludedPackagesFrom(['!node_modules/react/{**,lib}'])).toThrow(
			ExclusionShapeError
		);
	});

	it('refuses a package with no path after it', () => {
		expect(() => excludedPackagesFrom(['!node_modules/react'])).toThrow(ExclusionShapeError);
	});

	it('names the entry it could not read', () => {
		expect(() => excludedPackagesFrom(['!node_modules/react/'])).toThrow(/node_modules\/react\//);
	});
});

/**
 * And the rule the installer actually carries, so this file cannot drift into
 * describing a configuration that no longer exists.
 */
describe('the exclusions the shipped build really has', () => {
	it('are read out of the real builder config', () => {
		const config = readFileSync(join(__dirname, '..', 'electron-builder.config.mjs'), 'utf8');
		const match = /files:\s*\[([\s\S]*?)\]/.exec(config);
		expect(match, 'electron-builder.config.mjs no longer has a files array').not.toBeNull();

		const entries = [...(match?.[1] ?? '').matchAll(/'([^']*)'/g)].map((hit) => hit[1] as string);
		expect(entries.length, 'no files entries were parsed, so this asserts nothing').toBeGreaterThan(
			0
		);

		expect(
			[...excludedPackagesFrom(entries)].sort(),
			'the packages the installer leaves out have changed, so the SBOM guard now describes a ' +
				'different build than the one that ships — update this list deliberately'
		).toEqual(EXCLUDED);
	});
});
