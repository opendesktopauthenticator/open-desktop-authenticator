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
		const attested = ['exe', 'AppImage', 'deb'];
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
	it('builds every architecture the config declares', () => {
		const config = readFileSync(join(__dirname, '..', 'electron-builder.config.mjs'), 'utf8');
		const win = config.slice(config.indexOf('	win: {'), config.indexOf('	nsis: {'));
		const declared = [...win.matchAll(/arch: \[([^\]]+)\]/g)]
			.flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((a) => a[1]))
			.filter((a, i, all) => all.indexOf(a) === i);

		expect(declared).toContain('arm64');
		const targets = WORKFLOW.slice(WORKFLOW.indexOf('targets: --win'));
		for (const arch of declared) {
			expect(targets, `the workflow never builds ${arch}`).toContain(`:${arch}`);
		}
	});

	it('still states that the Store package is not a release asset', () => {
		expect(WORKFLOW).toContain('not published as a release');
	});
});
