import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

type PagesModule = typeof import('../site/pages/index.mjs', {
	with: { 'resolution-mode': 'import' }
});
type Page = PagesModule['PAGES'][number];

let uninstall: Page;

beforeAll(async () => {
	const { PAGES } = await import('../site/pages/index.mjs');
	const page = PAGES.find((candidate) => candidate.slug === 'uninstall');
	if (!page) throw new Error('Site fixture is missing /uninstall');
	uninstall = page;
});

const ROOT = join(__dirname, '..');
const PORTABLE_VERIFIER = join(ROOT, '.github', 'scripts', 'verify-portable-runtime.ps1');
const UUID = '11111111-1111-4111-8111-111111111111';
const DATA_LEAK_FIXTURES = [
	'open-desktop-authenticator\\lockfile',
	'vault.json',
	'vault.json.bak',
	'vault.json.tmp',
	'vault.json.rotating',
	'vault.json.rotating.tmp',
	'vault.json.bak.tmp',
	`vault.json.bak.previous-${UUID}`,
	`vault.json.superseded-${UUID}`,
	'pending-operations\\76561198000000001.activate.json',
	'pending-steam-workflows\\76561198000000001.enrollment.json',
	'recovery\\76561198000000001.abc.oda-recovery',
	`76561198000000001.abc.oda-recovery.${UUID}.tmp`,
	'76561198000000001.maFile',
	`76561198000000001.maFile.${UUID}.tmp`,
	'blob_storage\\000003.log',
	'Cache\\Cache_Data\\data_0',
	'Code Cache\\js\\index',
	'DawnGraphiteCache\\data_0',
	'DawnWebGPUCache\\data_0',
	'GPUCache\\data_0',
	'IndexedDB\\https_steamcommunity_0.indexeddb.leveldb',
	'Local Storage\\leveldb\\CURRENT',
	'Network\\Cookies',
	'Partitions\\unrecognized-future-partition',
	'browser-chrome',
	'browser-76561198000000001',
	'steam-76561198000000001',
	'steam-76561198000000001-1',
	'steam-direct-76561198000000001',
	'steam-direct-76561198000000001-2',
	'steam-steam-clock-sync',
	'steam-steam-clock-sync-3',
	'steam-login-system',
	'Session Storage\\CURRENT',
	'Shared Dictionary\\db',
	'Cookies',
	'DIPS',
	'DIPS-wal',
	'Local State',
	'lockfile'
] as const;

const runDetectorFixture = (paths: readonly string[]) =>
	spawnSync(
		'pwsh',
		[
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-File',
			PORTABLE_VERIFIER,
			'-DetectorFixtureJson',
			JSON.stringify(paths)
		],
		{ encoding: 'utf8' }
	);

const words = (html: string) =>
	html
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

describe('portable-mode claims', () => {
	it('limits locality to user data and names the launcher runtime extraction', () => {
		const sources = [
			'electron-builder.config.mjs',
			'src/main/index.ts',
			'site/pages/guides.mjs',
			'site/pages/safety.mjs'
		].map((path) => readFileSync(join(ROOT, path), 'utf8'));
		const all = sources.join('\n');
		expect(all).not.toMatch(
			/no writes outside its own directory|writes nothing outside its own folder/i
		);
		expect(all).not.toMatch(/portable build has no installer and touches no registry key/i);
		expect(all).toMatch(/vaults?, settings and recovery/i);
		expect(all).toMatch(/Electron(?: and|\/)Chromium runtime files to Windows Temp/i);
	});

	it('runs the real packaged executable and refuses an absent portable artifact', () => {
		const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
		const fixture = readFileSync(PORTABLE_VERIFIER, 'utf8');
		expect(workflow).toContain('verify-portable-runtime.ps1');
		expect(workflow).toContain('$portable.Count -ne 1');
		expect(workflow).toContain('-PortablePath $portable[0].FullName');
		expect(workflow).not.toContain('-DetectorFixtureJson');
		expect(fixture).toContain("$env:ELECTRON_RUN_AS_NODE = '1'");
		expect(fixture).toContain('$runtimeObserved.Count -eq 0');
		expect(fixture).toContain('$left.Count -ne 0');
		expect(fixture).toMatch(/vault\\\.json/);
		expect(fixture).toContain('.oda-recovery');
	});

	it('runs a separate normal app start and makes the beside-executable marker mandatory', () => {
		const fixture = readFileSync(PORTABLE_VERIFIER, 'utf8');
		const nodeMode = fixture.indexOf("$env:ELECTRON_RUN_AS_NODE = '1'");
		const normalMode = fixture.indexOf("Remove-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE'");
		const normalStart = fixture.indexOf(
			'$appProcess = Start-Process -FilePath $fixturePortable',
			normalMode
		);
		expect(nodeMode).toBeGreaterThan(-1);
		expect(normalMode).toBeGreaterThan(nodeMode);
		expect(normalStart).toBeGreaterThan(normalMode);
		expect(fixture.slice(normalMode, normalStart)).not.toContain("ELECTRON_RUN_AS_NODE = '1'");
		expect(fixture).toContain("$startupMarker = Join-Path $expectedDataRoot 'lockfile'");
		expect(fixture).toMatch(
			/if \(-not \(Test-Path -LiteralPath \$startupMarker -PathType Leaf\)\) \{\s*throw 'Normal portable app did not create its beside-executable startup marker/
		);
		expect(fixture).toContain('Copy-Item -LiteralPath $portable -Destination $fixturePortable');
		expect(fixture).toContain('Get-FileHash -LiteralPath $fixturePortable');
		expect(fixture).toContain('New-Item -ItemType Directory -Path $path');
		expect(fixture).not.toContain('New-Item -ItemType Directory -LiteralPath');
		expect(fixture).toContain('Stop-ExactProbeProcesses -Roots @($appFixture, $appTemp)');
		expect(fixture).toContain('Assert-NoApplicationData -Paths @($appObserved)');
	});

	it('makes the normal-start contract reject the three dangerous structural mutations', () => {
		const fixture = readFileSync(PORTABLE_VERIFIER, 'utf8');
		const contractHolds = (source: string) => {
			const nodeMode = source.indexOf("$env:ELECTRON_RUN_AS_NODE = '1'");
			const normalMode = source.indexOf("Remove-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE'");
			const normalStart = source.indexOf(
				'$appProcess = Start-Process -FilePath $fixturePortable',
				normalMode
			);
			return (
				nodeMode >= 0 &&
				normalMode > nodeMode &&
				normalStart > normalMode &&
				!source.slice(normalMode, normalStart).includes("ELECTRON_RUN_AS_NODE = '1'") &&
				/if \(-not \(Test-Path -LiteralPath \$startupMarker -PathType Leaf\)\) \{\s*throw 'Normal portable app did not create its beside-executable startup marker/.test(
					source
				) &&
				source.includes('Assert-NoApplicationData -Paths @($appObserved)')
			);
		};
		expect(contractHolds(fixture)).toBe(true);
		const mutants = [
			fixture.replace(
				"Remove-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE' -ErrorAction SilentlyContinue",
				"$env:ELECTRON_RUN_AS_NODE = '1'"
			),
			fixture.replace(
				'if (-not (Test-Path -LiteralPath $startupMarker -PathType Leaf)) {',
				'if ($false -and -not (Test-Path -LiteralPath $startupMarker -PathType Leaf)) {'
			),
			fixture.replaceAll(
				'Assert-NoApplicationData -Paths @($appObserved)',
				"Assert-NoApplicationData -Paths @('runtime-only')"
			)
		];
		for (const mutant of mutants) expect(contractHolds(mutant)).toBe(false);
	});

	it.skipIf(process.platform !== 'win32')(
		'rejects every production data-name fixture through the executable detector',
		() => {
			const result = runDetectorFixture(DATA_LEAK_FIXTURES);
			const output = `${result.stdout}\n${result.stderr}`;
			expect(result.status, `leaks were accepted\n${output}`).not.toBe(0);
			for (const path of DATA_LEAK_FIXTURES) {
				expect(output, `${path} was not classified\n${output}`).toContain(
					`APPLICATION-DATA: ${path}`
				);
			}
		}
	);

	it.skipIf(process.platform !== 'win32')(
		'accepts ordinary launcher extraction names instead of making the detector vacuous',
		() => {
			const paths = [
				'nsis-guid\\resources\\app.asar',
				'nsis-guid\\locales\\en-US.pak',
				'nsis-guid\\LICENSE.electron.txt'
			] as const;
			const result = runDetectorFixture(paths);
			expect(
				result.status,
				`ordinary extraction paths were refused\n${result.stdout}\n${result.stderr}`
			).toBe(0);
		}
	);
});

describe('uninstall and data-residue claims', () => {
	it('does not deny intentional traffic and names each destination', () => {
		const body = uninstall.body({
			name: 'Open Desktop Authenticator',
			repo: 'https://github.com/example/oda',
			reviews: {
				profile: 'https://reviews.example/profile',
				write: 'https://reviews.example/write',
				widget: {
					script: 'https://reviews.example/widget.js',
					origin: 'https://reviews.example',
					locale: 'en-US',
					templateId: 'template',
					businessUnitId: 'unit',
					token: 'token'
				}
			}
		});
		const copy = words(body);
		expect(copy).not.toMatch(/nothing was ever sent anywhere/i);
		expect(copy).not.toMatch(/never (?:sent|contacts?) anything anywhere/i);
		expect(copy).toMatch(/no server that stores a copy of your vault or account data/i);
		expect(copy).toMatch(/requests to Steam/i);
		expect(copy).toMatch(/update check contacts GitHub/i);
		expect(body).toContain('href="/privacy"');
	});
});
