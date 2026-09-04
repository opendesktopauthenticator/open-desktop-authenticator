import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the release workflow is allowed to publish.
 *
 * v1.0.0 shipped `Open.Desktop.Authenticator.1.0.0.appx` as a release asset.
 * The workflow says in as many words that it must not — an appx built for the
 * Store is deliberately unsigned, because Microsoft re-signs it on ingestion,
 * so a visitor who downloaded it could not install it. It was published anyway,
 * listed in `SHA256SUMS.txt` under a name GitHub does not serve, and attested
 * by nothing, because the provenance step names three extensions and appx is
 * not one of them.
 *
 * The cause was a `download-artifact` step with no `pattern:`, which collects
 * every artifact the run produced including `store-package`. A comment saying
 * the file is not released did not stop it being released, so the guarantee is
 * asserted here and enforced by a step in the job itself.
 */

const WORKFLOW = readFileSync(join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

function packageTargets(workflow: string, os: string): string[] {
	const packageJob = workflow.slice(workflow.indexOf('  package:'), workflow.indexOf('  publish:'));
	const rows = [
		...packageJob.matchAll(/^\s*- os:\s*([^\s#]+)\s*\r?\n\s*targets:\s*([^\r\n#]+)$/gm)
	];
	const row = rows.find((match) => match[1] === os);
	if (!row) throw new Error(`the package matrix has no exact ${os} row`);
	return (row[2] ?? '').trim().split(/\s+/);
}

function declaredArchitectures(from: string, to: string): string[] {
	const config = readFileSync(join(__dirname, '..', 'electron-builder.config.mjs'), 'utf8');
	const block = config.slice(config.indexOf(from), config.indexOf(to));
	return [...block.matchAll(/arch: \[([^\]]+)\]/g)]
		.flatMap((match) =>
			[...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((architecture) => architecture[1] ?? '')
		)
		.filter((architecture) => architecture !== '')
		.filter((architecture, index, all) => all.indexOf(architecture) === index);
}

function missingArchitectures(workflow: string, os: string, from: string, to: string): string[] {
	const targets = packageTargets(workflow, os);
	return declaredArchitectures(from, to).filter(
		(architecture) => !targets.some((target) => target.endsWith(`:${architecture}`))
	);
}

/** The publish job only — the package job legitimately handles the appx. */
const PUBLISH = WORKFLOW.slice(WORKFLOW.indexOf('  publish:'));

describe('the release publishes only what it attests', () => {
	it('downloads platform artifacts by pattern, not everything', () => {
		expect(PUBLISH).toContain('pattern: package-*');
	});

	/*
	 * The specific regression. `merge-multiple` without `pattern` is what
	 * published the appx, and it reads as harmless — it is about flattening
	 * directories, not about which artifacts are fetched.
	 */
	it('never collects the Store package into staging', () => {
		const download = PUBLISH.slice(
			PUBLISH.indexOf('download-artifact'),
			PUBLISH.indexOf('List what will be published')
		);
		expect(download).toContain('pattern:');
		expect(download).not.toContain('store-package');
	});

	it('refuses to publish a file the provenance step does not cover', () => {
		expect(PUBLISH).toContain('Refuse to publish anything unattested');
	});

	/*
	 * The guard and the attestation have to agree. If somebody adds `.msi` to
	 * the provenance globs and forgets the guard, the release starts failing;
	 * if they add it to the guard and forget provenance, an unattested file
	 * ships — which is the failure this whole file exists for.
	 */
	it('guards exactly the extensions the attestation signs', () => {
		const attestation = PUBLISH.slice(PUBLISH.indexOf('subject-path:'));
		const attested = ['exe', 'AppImage', 'deb', 'dmg'];
		for (const ext of attested) {
			expect(attestation).toContain(`staging/*.${ext}`);
		}
		// The guard's allow-list, written as a grep alternation.
		expect(PUBLISH).toContain(`\\.(${attested.join('|')})$`);
	});

	/*
	 * The config and the workflow have to agree about architecture.
	 *
	 * `electron-builder.config.mjs` declares `arch: ['x64', 'arm64']` for nsis.
	 * Passing targets on the command line overrides that whole block, `arch`
	 * included, and defaults to the runner's own architecture — so the config
	 * promised arm64 while every release shipped x64 only, silently, for as long
	 * as the project has existed. Neither file was wrong on its own.
	 */
	it.each([
		['win', 'windows-latest', '	win: {', '	nsis: {'],
		['mac', 'macos-latest', '	mac: {', '	dmg: {']
	])(
		"builds every %s architecture in that platform's exact matrix row",
		(_platform, os, from, to) => {
			expect(declaredArchitectures(from, to)).toContain('arm64');
			expect(missingArchitectures(WORKFLOW, os, from, to)).toEqual([]);
		}
	);

	it('fails when Windows loses arm64 even though the macOS row still names it', () => {
		const fixture = WORKFLOW.replace(
			'targets: --win nsis:x64 nsis:arm64 portable:x64',
			'targets: --win nsis:x64 portable:x64'
		);
		expect(fixture, 'the Windows fixture mutation did not apply').not.toBe(WORKFLOW);
		expect(missingArchitectures(fixture, 'windows-latest', '	win: {', '	nsis: {')).toEqual(['arm64']);
		expect(missingArchitectures(fixture, 'macos-latest', '	mac: {', '	dmg: {')).toEqual([]);
	});

	it('still states that the Store package is not a release asset', () => {
		expect(WORKFLOW).toContain('not published as a release');
	});
});

/**
 * macOS, which is built long before it can be shipped.
 *
 * The README promises that this project will not ship an unsigned macOS build,
 * and until the Apple Developer enrolment completes every macOS build CI
 * produces is unsigned. A promise in a README is not a mechanism; `pattern:
 * package-*` is. These check that the mechanism and the promise still agree.
 *
 * The cost of getting it wrong is not theoretical — it is exactly how v1.0.0
 * shipped an appx that nobody could install.
 */
describe('the macOS build, before it is signed', () => {
	const PACKAGE = WORKFLOW.slice(WORKFLOW.indexOf('  package:'), WORKFLOW.indexOf('  publish:'));

	it('is built on every release, so the target is exercised', () => {
		expect(PACKAGE).toContain('os: macos-latest');
		expect(PACKAGE).toContain('--mac dmg');
	});

	/*
	 * The gate. An unsigned `.dmg` uploaded under `package-*` reaches the
	 * release page, and Gatekeeper refuses it on every machine except the one
	 * that built it — an unusable file, published in the one place this project
	 * asks strangers to trust.
	 */
	it('cannot reach the release page until a repository variable says so', () => {
		const upload = PACKAGE.slice(PACKAGE.lastIndexOf('upload-artifact'));
		expect(upload).toContain('MACOS_SIGNING_READY');
		// The name it falls back to must not match the publish job's pattern.
		expect(upload).toContain('macos-unsigned-check');
		expect('macos-unsigned-check'.startsWith('package-')).toBe(false);
	});

	/*
	 * `CSC_LINK` is not a macOS variable. electron-builder reads it on Windows
	 * too, so a Developer ID certificate exported into the whole matrix makes
	 * the Windows job try to sign the `.exe` with it — a build failure on the
	 * platform that was working, caused by adding a secret for another one.
	 */
	it('hands the signing certificate to the macOS runner only', () => {
		const packageStep = PACKAGE.slice(PACKAGE.indexOf('- name: Package'));
		for (const variable of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY']) {
			const at = packageStep.indexOf(`${variable}:`);
			expect(at, `${variable} is not set at all`).toBeGreaterThan(-1);
			// The value is one `${{ ... }}` expression, so it ends at the first `}}`.
			const value = packageStep.slice(at, packageStep.indexOf('}}', at));
			expect(value, `${variable} is not gated on the runner`).toContain("runner.os == 'macOS'");
		}
	});

	/*
	 * **`APPLE_API_KEY` is a path.**
	 *
	 * electron-builder hands it to `@electron/notarize`, which puts it after
	 * `xcrun notarytool --key` — a file. electron-builder's own published
	 * documentation says to set the variable to the base64 contents of the
	 * `.p8`, and following it makes notarisation fail looking for a file named
	 * after a wall of base64.
	 *
	 * This is here because the wrong version is the one a reader will find if
	 * they go looking, so "simplifying" the decode step away is a natural thing
	 * to do and breaks a release that cannot be tested from this machine.
	 */
	it('hands notarisation a path to the key, not the key', () => {
		expect(PACKAGE, 'the .p8 is never written to disk').toContain('apple-api-key.p8');

		const at = PACKAGE.indexOf('APPLE_API_KEY:');
		const value = PACKAGE.slice(at, PACKAGE.indexOf('}}', at));
		expect(value, 'APPLE_API_KEY is the secret itself, which notarytool cannot open').not.toContain(
			'secrets.APPLE_API_KEY_P8'
		);
		expect(value).toContain('apple-api-key.p8');
	});

	it('does not leave the signing key on the runner', () => {
		expect(PACKAGE).toContain('Remove the notarisation key');
		// `always()`, or a failed build keeps the key for the rest of the job.
		const removal = PACKAGE.slice(PACKAGE.indexOf('Remove the notarisation key'));
		expect(removal.slice(0, 200)).toContain('always()');
	});

	/*
	 * Notarisation needs the Hardened Runtime, and the Hardened Runtime stops
	 * V8 dead without these two. A `.dmg` that is signed, notarised, and
	 * crashes on launch is the worst of the available outcomes: it passes every
	 * check this pipeline can make.
	 */
	it('grants the two entitlements Electron cannot run without', () => {
		const plist = readFileSync(join(__dirname, '..', 'signing', 'entitlements.mac.plist'), 'utf8');
		expect(plist).toContain('com.apple.security.cs.allow-jit');
		expect(plist).toContain('com.apple.security.cs.allow-unsigned-executable-memory');
	});

	/*
	 * And nothing else. Every entitlement below weakens the process, and this
	 * process holds an unlocked vault. `disable-library-validation` is the one
	 * to watch: Electron apps carry it as a matter of habit, for native modules
	 * this project does not have.
	 */
	it('grants nothing that would let a stranger into the process', () => {
		const plist = readFileSync(join(__dirname, '..', 'signing', 'entitlements.mac.plist'), 'utf8');
		const granted = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
		expect(granted).toEqual([
			'com.apple.security.cs.allow-jit',
			'com.apple.security.cs.allow-unsigned-executable-memory'
		]);
	});
});
