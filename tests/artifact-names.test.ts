import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What a published artifact is called, and why it may not contain a space.
 *
 * `SHA256SUMS.txt` is generated in CI from the staging directory. GitHub then
 * replaces spaces with dots when it stores a release asset — so with
 * `${productName}` in the name, every filename in the checksum file disagreed
 * with the file a user actually downloads. The documented way to use it is
 * `sha256sum --check SHA256SUMS.txt`, which reports "No such file or directory"
 * for every line: the one file whose entire job is verification, failing at it,
 * while every hash inside it was correct.
 *
 * That was found by verifying a real download by hand. Nothing else could have
 * found it — the hashes matched, CI was green, and the release page looked
 * complete.
 *
 * The three names have to agree: what the builder produces, what the checksum
 * file lists, and what the site tells people to type.
 */

const BUILDER = readFileSync(join(__dirname, '..', 'electron-builder.config.mjs'), 'utf8');
const SAFETY = readFileSync(join(__dirname, '..', 'site', 'pages', 'safety.mjs'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
	name: string;
};

/** Every `artifactName` template the config declares. */
const templates = [...BUILDER.matchAll(/artifactName: '([^']+)'/g)].map((m) => m[1] as string);

describe('published artifact names', () => {
	it('declares one for every target', () => {
		// NSIS, portable, and the shared Linux template.
		expect(templates).toHaveLength(3);
	});

	it('never interpolates the product name, which contains spaces', () => {
		for (const template of templates) {
			expect(template, template).not.toContain('${productName}');
		}
	});

	it('builds from the package name instead', () => {
		// `open-desktop-authenticator` — already hyphenated, already lower case.
		expect(pkg.name).not.toMatch(/\s/);
		for (const template of templates) {
			expect(template, template).toContain('${name}');
		}
	});

	it('produces nothing GitHub would rename', () => {
		// A literal space anywhere in the template survives into the filename.
		for (const template of templates) {
			expect(template, template).not.toMatch(/\s/);
		}
	});
});

describe('the verification instructions name real files', () => {
	it('uses the package name in its examples', () => {
		// The page previously said `OpenDesktopAuthenticator-Setup.exe`, which
		// matched neither the artifacts nor the checksum file — a third spelling.
		expect(SAFETY).toContain(`${pkg.name}-`);
		expect(SAFETY).not.toContain('OpenDesktopAuthenticator-Setup.exe');
		expect(SAFETY).not.toContain('OpenDesktopAuthenticator.AppImage');
	});

	/*
	 * The bulk check must still be offered — and must still carry
	 * `--ignore-missing`.
	 *
	 * Without it, `sha256sum --check` reports `FAILED open or read` for every
	 * artifact in the list the reader did not download, and exits non-zero. A
	 * reader who took one file out of six therefore sees five failures and a
	 * warning around their single `OK`, which is indistinguishable from the
	 * tampering they were checking for. The names being right is necessary and
	 * was never sufficient.
	 */
	it('still offers the bulk check, which is the one that was broken', () => {
		expect(SAFETY).toContain('sha256sum --check');
		expect(SAFETY).toContain('SHA256SUMS.txt');
	});

	it('does not tell people to run the bulk check without --ignore-missing', () => {
		const bulk = SAFETY.slice(SAFETY.indexOf('sha256sum --check'));
		expect(bulk.slice(0, 60)).toContain('--ignore-missing');
	});

	it('warns that PowerShell prints upper case', () => {
		// Not cosmetic. Somebody verifying carefully sees a wall of capitals against
		// a lower-case list and concludes their download is wrong.
		expect(SAFETY).toMatch(/upper case/i);
	});
});

describe('a dispatched release builds the tag it names', () => {
	const workflow = readFileSync(join(__dirname, '../.github/workflows/release.yml'), 'utf8');

	it('verifies the ref is a pushed tag before building', () => {
		// `actions/checkout` accepts any ref, so a branch named like a tag built
		// the branch — and `gh release create` then invented the missing tag from
		// the default branch: hashes and provenance for one commit, binaries from
		// another, on the workflow whose entire purpose is that they match.
		expect(workflow).toContain('git fetch --depth 1 origin "refs/tags/$tag:refs/tags/$tag"');
		expect(workflow).toMatch(/git rev-parse HEAD.*git rev-parse "refs\/tags\/\$tag/);
	});

	it('tells gh to refuse rather than invent a missing tag', () => {
		expect(workflow).toContain('--verify-tag');
	});
});

describe('what the package is allowed to contain', () => {
	const config = readFileSync(join(__dirname, '../electron-builder.config.mjs'), 'utf8');

	it('excludes declaration files in every spelling', () => {
		// `*.{ts,...}` catches `.d.ts` and misses `.d.cts` and `.d.mts` entirely —
		// a hundred-odd files Electron can never load, since a package is entered
		// through its compiled entry point.
		expect(config).toContain("'!node_modules/**/*.d.{ts,cts,mts}'");
		expect(config).not.toMatch(/^\s*'node_modules\/\*\*\/\*\.d\.ts'/m);
	});

	it('excludes the React packages the renderer already bundles', () => {
		// Vite compiles the renderer into a single file that contains React and
		// ReactDOM; main and preload import neither. Shipping the packages too
		// duplicated roughly half the ASAR.
		expect(config).toContain("'!node_modules/{react,react-dom,scheduler}/**'");
	});
});

/*
 * The Store identity, now that Partner Center has issued it.
 *
 * These three values are Microsoft's, not ours, and the package will not
 * install if a single character differs — `store-identity.mjs` says so in as
 * many words. They are pinned here because the failure mode is remote and
 * slow: a mismatch is rejected at upload, long after the build looked fine.
 */
describe('the Microsoft Store identity', () => {
	it('is fully resolved — no placeholders left', async () => {
		const store = await import('../store-identity.mjs');
		expect(store.unresolvedStoreFields()).toEqual([]);
		expect(store.hasUnresolvedStoreIdentity()).toBe(false);
	});

	it('carries exactly what Partner Center issued', async () => {
		const { storeIdentity } = await import('../store-identity.mjs');
		expect(storeIdentity.identityName).toBe('TheMaster.OpenDesktopAuthenticator');
		// A GUID, because the Store issues one per publisher account. Not a
		// secret — it ships inside every package — and not the name users see.
		expect(storeIdentity.publisher).toBe('CN=249BBF8E-FB90-4514-91E4-4A29DD6A669E');
		// Must match the Store account's legal name and `branding.company`.
		expect(storeIdentity.publisherDisplayName).toBe('MASTERPANEL LLC');
	});

	it('is built in CI but never published as a release asset', () => {
		const workflow = readFileSync(join(__dirname, '../.github/workflows/release.yml'), 'utf8');
		// A Store appx is deliberately unsigned — Microsoft re-signs it on
		// ingestion — so a visitor who downloaded one could not install it. It is
		// uploaded as a workflow artifact for the maintainer, and the release's
		// own collection step only ever globs exe/AppImage/deb.
		expect(workflow).toContain('--win appx --publish never');
		expect(workflow).toContain('name: store-package');
		const collect = workflow.slice(
			workflow.indexOf('Collect artifacts'),
			workflow.indexOf('Collect the Store package')
		);
		expect(collect).not.toContain('appx');

		/*
		 * **This assertion is why v1.0.0 shipped an appx anyway.**
		 *
		 * Everything above was true and stayed true: the packaging job never
		 * globs appx into `dist-release`. The leak was one job later. `publish`
		 * called `download-artifact` with no `pattern:`, which fetches every
		 * artifact the run produced — including `store-package` — straight into
		 * the staging directory that `gh release create staging/*` publishes.
		 *
		 * So a test named "never published as a release asset" passed on every
		 * run while the file was on the release page, unattested and listed in
		 * SHA256SUMS.txt under a name GitHub does not serve. Checking the half
		 * of the pipeline that was already correct is worse than not checking:
		 * it is a green tick over the thing that was broken.
		 */
		const publish = workflow.slice(workflow.indexOf('  publish:'));
		expect(publish).toContain('pattern: package-*');
	});
});

/*
 * The Store tiles must be ours.
 *
 * Without `build/appx/`, electron-builder falls back to its own bundled
 * `SampleAppx.*.png` — placeholder art from 2019 that ships inside the
 * packaging tool. The first Store package built here carried exactly that, and
 * the install prompt showed a generic Electron logo for an application whose
 * whole argument is that a stranger can tell ours from somebody else's.
 */
describe('the Store tile art', () => {
	const required = [
		['StoreLogo.png', 50, 50],
		['Square150x150Logo.png', 150, 150],
		['Square44x44Logo.png', 44, 44],
		['Wide310x150Logo.png', 310, 150]
	] as const;

	it('exists for every asset electron-builder would otherwise substitute', () => {
		// The four names are exactly what its appx target looks for. Miss one and
		// it silently uses its own `SampleAppx.*.png` for that tile.
		for (const [name] of required) {
			expect(existsSync(join(__dirname, '../build/appx', name))).toBe(true);
		}
	});

	it('is the right size in each case', () => {
		for (const [name, width, height] of required) {
			const png = readFileSync(join(__dirname, '../build/appx', name));
			// PNG IHDR: width and height are big-endian 32-bit at offsets 16 and 20.
			expect([name, png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([name, width, height]);
		}
	});
});
