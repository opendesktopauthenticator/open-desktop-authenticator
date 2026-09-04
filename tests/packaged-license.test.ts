import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function applicationArchive(rootLicense: boolean): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), 'oda-first-party-license-'));
	roots.push(root);
	const source = join(root, 'app');
	mkdirSync(join(source, 'resources'), { recursive: true });
	writeFileSync(join(source, 'package.json'), '{"name":"fixture"}');
	const licence = readFileSync(join(ROOT, 'LICENSE'));
	if (rootLicense) writeFileSync(join(source, 'LICENSE'), licence);
	// A dependency/runtime licence may contain the same words. It must not satisfy
	// the application's own root-notice requirement.
	writeFileSync(join(source, 'resources', 'LICENSE.electron.txt'), licence);
	const archive = join(root, 'app.asar');
	await createPackage(source, archive);
	return archive;
}

function verify(archive: string) {
	return spawnSync(
		process.execPath,
		[join(ROOT, '.github', 'scripts', 'verify-packaged-license.mjs'), archive],
		{ cwd: ROOT, encoding: 'utf8', timeout: 20_000 }
	);
}

function verifyTree(tree: string) {
	return spawnSync(
		process.execPath,
		[join(ROOT, '.github', 'scripts', 'verify-packaged-license.mjs'), '--tree', tree],
		{ cwd: ROOT, encoding: 'utf8', timeout: 20_000 }
	);
}

describe('the first-party licence package boundary', () => {
	it('accepts the exact project licence at the application archive root', async () => {
		const result = verify(await applicationArchive(true));
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/first-party licence verified/i);
	});

	it('rejects an archive that has only an Electron/dependency licence', async () => {
		const result = verify(await applicationArchive(false));
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/no first-party LICENSE at the application archive root/i);
	});

	it('discovers every ASAR through arbitrary package pathnames and rejects a bad later match', async () => {
		const tree = mkdtempSync(join(tmpdir(), 'oda-package-tree-'));
		roots.push(tree);
		const firstDirectory = join(tree, 'one package [x]', 'resources');
		const secondDirectory = join(tree, 'two-$-ユニコード', 'resources');
		mkdirSync(firstDirectory, { recursive: true });
		mkdirSync(secondDirectory, { recursive: true });
		copyFileSync(await applicationArchive(true), join(firstDirectory, 'app.asar'));
		copyFileSync(await applicationArchive(true), join(secondDirectory, 'app.asar'));

		const allValid = verifyTree(tree);
		expect(allValid.status, allValid.stderr).toBe(0);
		expect(allValid.stdout.match(/first-party licence verified:/g)).toHaveLength(2);

		copyFileSync(await applicationArchive(false), join(secondDirectory, 'app.asar'));
		const badSecond = verifyTree(tree);
		expect(badSecond.status).not.toBe(0);
		expect(badSecond.stderr).toMatch(/no first-party LICENSE at the application archive root/i);
	});

	it('refuses a package tree with zero application archives', () => {
		const tree = mkdtempSync(join(tmpdir(), 'oda-empty-package-tree-'));
		roots.push(tree);
		const result = verifyTree(tree);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/refusing a vacuous licence check/i);
	});

	it('makes both ordinary packages and AppX non-vacuous release gates', () => {
		const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
		const appx = readFileSync(join(ROOT, '.github', 'scripts', 'verify-appx-license.ps1'), 'utf8');
		expect(workflow).toContain('verify-packaged-license.mjs --tree release');
		expect(workflow).not.toMatch(/\b(?:mapfile|readarray|coproc)\b|declare\s+-A/);
		expect(workflow).toContain("steps.store_license.outcome == 'success'");
		expect(appx).toContain('$packages.Count -ne 1');
		expect(appx).toContain('$asarEntries.Count -ne 1');
		expect(appx).toContain("'(^|/)app/resources/app\\.asar$'");
		expect(appx).toContain('verify-packaged-license.mjs $scratch');
	});
});
