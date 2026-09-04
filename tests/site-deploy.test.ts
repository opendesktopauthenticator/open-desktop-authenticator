import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function posix(path: string): string {
	const slash = path.replaceAll('\\', '/');
	return process.platform === 'win32'
		? slash.replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`)
		: slash;
}

function run(command: string, args: string[], cwd?: string) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000 });
	if (result.error !== undefined) throw result.error;
	if (result.signal !== null) throw new Error(`${command} ended on ${result.signal}`);
	return result;
}

function assetsIn(html: string): string[] {
	return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]!);
}

type TarMember = {
	name: string;
	type: 'file' | 'directory' | 'symlink' | 'hardlink';
	body?: string;
	link?: string;
};

/** A tiny ustar writer for link fixtures; no filesystem symlink privilege is required. */
function archiveBytes(members: TarMember[]): Buffer {
	const blocks: Buffer[] = [];
	for (const member of members) {
		const body = Buffer.from(member.body ?? '', 'utf8');
		const header = Buffer.alloc(512);
		const put = (value: string, offset: number, length: number) =>
			header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'ascii');
		put(member.name, 0, 100);
		put('0000644\0', 100, 8);
		put('0000000\0', 108, 8);
		put('0000000\0', 116, 8);
		put(`${(member.type === 'file' ? body.length : 0).toString(8).padStart(11, '0')}\0`, 124, 12);
		put('00000000000\0', 136, 12);
		header.fill(0x20, 148, 156);
		put(
			member.type === 'file'
				? '0'
				: member.type === 'directory'
					? '5'
					: member.type === 'symlink'
						? '2'
						: '1',
			156,
			1
		);
		if (member.link) put(member.link, 157, 100);
		put('ustar\0', 257, 6);
		put('00', 263, 2);
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		put(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
		blocks.push(header);
		if (member.type === 'file') {
			blocks.push(body);
			const padding = (512 - (body.length % 512)) % 512;
			if (padding) blocks.push(Buffer.alloc(padding));
		}
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

describe('the checked-in site deploy helper', () => {
	it('keeps cached-page assets, deletes retired pages, and retries from an empty stage', () => {
		const root = mkdtempSync(join(ROOT, 'tmp', 'oda-site-deploy-'));
		roots.push(root);
		const source = join(root, 'source');
		const live = join(root, 'live');
		const staging = join(root, 'staging');
		const rsyncProgram = join(root, 'rsync.mjs');
		const bashEnv = join(root, 'bash-env');
		const calls = join(root, 'rsync-calls');
		const destinations = join(root, 'rsync-destinations');
		const mutations = join(root, 'mutations');
		mkdirSync(source);
		mkdirSync(live);
		mkdirSync(staging);
		cpSync(join(ROOT, 'site'), join(source, 'site'), { recursive: true });
		rmSync(join(source, 'site', 'dist'), { recursive: true, force: true });
		mkdirSync(join(source, 'src', 'shared'), { recursive: true });
		mkdirSync(join(source, 'src', 'main'), { recursive: true });
		mkdirSync(join(source, 'tools'), { recursive: true });
		cpSync(join(ROOT, 'src', 'shared', 'logo.ts'), join(source, 'src', 'shared', 'logo.ts'));
		cpSync(join(ROOT, 'src', 'main', 'png.ts'), join(source, 'src', 'main', 'png.ts'));
		cpSync(join(ROOT, 'tools', 'raster.mjs'), join(source, 'tools', 'raster.mjs'));
		cpSync(join(ROOT, 'package.json'), join(source, 'package.json'));
		cpSync(join(ROOT, 'package-lock.json'), join(source, 'package-lock.json'));

		writeFileSync(
			rsyncProgram,
			`import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const args = process.argv.slice(2);
const source = resolve(args.at(-2));
const destination = resolve(args.at(-1));
const counter = process.env.TEST_RSYNC_CALLS;
const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(count + 1));
appendFileSync(process.env.TEST_RSYNC_DESTINATIONS, destination + '\\n');
if (process.env.TEST_RSYNC_FAIL === 'first' && count === 0) process.exit(7);
mkdirSync(destination, { recursive: true });
const deleting = args.includes('--delete');
if (deleting) {
  for (const name of readdirSync(destination)) {
    if (name !== 'assets') rmSync(join(destination, name), { recursive: true, force: true });
  }
}
for (const name of readdirSync(source)) {
  if (deleting && name === 'assets') continue;
  cpSync(join(source, name), join(destination, name), { recursive: true, force: true });
}
`,
			'utf8'
		);
		writeFileSync(
			bashEnv,
			`mktemp() {
  printf 'mktemp\\n' >> "$TEST_MUTATIONS"
  if [ -n "\${TEST_MKTEMP_RESULT:-}" ]; then printf '%s\\n' "$TEST_MKTEMP_RESULT"; else command mktemp "$@"; fi
}
realpath() {
  last=
  for argument in "$@"; do last=$argument; done
  if [ -n "\${TEST_CANONICAL_ARCHIVE:-}" ] && [ "$last" = "$TEST_REPOINT_ARCHIVE" ]; then
    resolved=$TEST_CANONICAL_ARCHIVE
  else
    resolved=$(command realpath "$@") || return
  fi
  printf '%s\\n' "$resolved"
  if [ -n "\${TEST_REPOINT_ARCHIVE:-}" ] && [ "$last" = "$TEST_REPOINT_ARCHIVE" ]; then
    if [ -n "\${TEST_CANONICAL_ARCHIVE:-}" ]; then
      cp -f -- "$TEST_REPOINT_TARGET" "$TEST_REPOINT_ARCHIVE"
    else
      ln -sf -- "$TEST_REPOINT_TARGET" "$TEST_REPOINT_ARCHIVE"
    fi
  fi
}
tar() { printf 'tar\\n' >> "$TEST_MUTATIONS"; command tar "$@"; }
rsync() { "$REAL_NODE" "$TEST_RSYNC_PROGRAM" "$@"; }
chown() {
  printf 'chown %s\\n' "$*" >> "$TEST_MUTATIONS"
  if [ "\${TEST_CHOWN_FAIL:-}" = '1' ]; then return 9; fi
}
`,
			'utf8'
		);

		const build = () => {
			const result = run(process.execPath, ['site/build.mjs'], source);
			expect(result.status, result.stderr).toBe(0);
		};
		const archive = (name: string) => {
			const path = join(root, name);
			const result = run(BASH, [
				'-c',
				`tar -czf "${posix(path)}" -C "${posix(join(source, 'site', 'dist'))}" .`
			]);
			expect(result.status, result.stderr).toBe(0);
			return path;
		};
		const deploy = (
			archivePath: string,
			fail = '',
			webRoot = live,
			owner = '',
			stagingParent = staging,
			mktempResult = '',
			chownFail = '',
			repointArchive = '',
			repointTarget = '',
			canonicalArchiveResult = ''
		) => {
			const result = spawnSync(
				BASH,
				[posix(join(ROOT, 'infra', 'deploy-site.sh')), posix(archivePath)],
				{
					encoding: 'utf8',
					timeout: 30_000,
					env: {
						...process.env,
						BASH_ENV: posix(bashEnv),
						ODA_SITE_OWNER: owner,
						ODA_SITE_STAGING_PARENT: posix(stagingParent),
						ODA_SITE_WEB_ROOT: posix(webRoot),
						REAL_NODE: process.execPath.replaceAll('\\', '/'),
						TEST_RSYNC_CALLS: posix(calls),
						TEST_RSYNC_DESTINATIONS: posix(destinations),
						TEST_RSYNC_FAIL: fail,
						TEST_RSYNC_PROGRAM: posix(rsyncProgram),
						TEST_MUTATIONS: posix(mutations),
						TEST_MKTEMP_RESULT: mktempResult === '' ? '' : posix(mktempResult),
						TEST_CHOWN_FAIL: chownFail,
						TEST_REPOINT_ARCHIVE: repointArchive === '' ? '' : posix(repointArchive),
						TEST_REPOINT_TARGET: repointTarget === '' ? '' : posix(repointTarget),
						TEST_CANONICAL_ARCHIVE:
							canonicalArchiveResult === '' ? '' : posix(canonicalArchiveResult)
					}
				}
			);
			if (result.error !== undefined) throw result.error;
			return result;
		};
		const clearEvidence = () => {
			for (const path of [calls, destinations, mutations]) rmSync(path, { force: true });
		};

		const guardArchive = join(root, 'guard.tgz');
		writeFileSync(
			guardArchive,
			archiveBytes([
				{ name: 'index.html', type: 'file', body: '<link href="/assets/good.css">' },
				{ name: 'assets/', type: 'directory' },
				{ name: 'assets/good.css', type: 'file', body: 'body{}' }
			])
		);
		const destructiveTargets = ['/', '//', '/var/..', 'relative'];
		if (process.platform !== 'win32') {
			const rootLink = join(root, 'root-link');
			symlinkSync('/', rootLink, 'dir');
			destructiveTargets.push(rootLink);
		}
		for (const target of destructiveTargets) {
			clearEvidence();
			const rejected = deploy(guardArchive, '', target, 'nobody:nobody');
			expect(rejected.status, target).not.toBe(0);
			expect(existsSync(guardArchive)).toBe(true);
			expect(existsSync(calls)).toBe(false);
			expect(existsSync(mutations)).toBe(false);
		}

		writeFileSync(join(live, 'index.html'), 'original live page');
		writeFileSync(join(live, 'old.html'), 'original retired page');
		const assertOriginalLiveTree = () => {
			expect(readFileSync(join(live, 'index.html'), 'utf8')).toBe('original live page');
			expect(readFileSync(join(live, 'old.html'), 'utf8')).toBe('original retired page');
		};

		const overlappingParents = [live, join(live, 'nested-staging')];
		if (process.platform !== 'win32') {
			const liveAlias = join(root, 'live-staging-alias');
			symlinkSync(live, liveAlias, 'dir');
			overlappingParents.push(liveAlias);
		}
		for (const stagingParent of overlappingParents) {
			clearEvidence();
			const rejected = deploy(guardArchive, '', live, 'nobody:nobody', stagingParent);
			expect(rejected.status, stagingParent).not.toBe(0);
			expect(rejected.stderr).toMatch(/staging directory must be outside/i);
			expect(existsSync(guardArchive)).toBe(true);
			expect(existsSync(calls)).toBe(false);
			expect(existsSync(mutations)).toBe(false);
			expect(existsSync(join(live, 'nested-staging'))).toBe(false);
			assertOriginalLiveTree();
		}

		// The post-create guard is independent of the configured-parent check.
		// A racing or compromised mktemp result must not reach archive inspection.
		const forcedLiveStage = join(live, 'forced-stage');
		mkdirSync(forcedLiveStage);
		clearEvidence();
		const postCreateRejected = deploy(
			guardArchive,
			'',
			live,
			'nobody:nobody',
			staging,
			forcedLiveStage
		);
		expect(postCreateRejected.status).not.toBe(0);
		expect(postCreateRejected.stderr).toMatch(/generated staging directory overlaps/i);
		expect(readFileSync(mutations, 'utf8')).toBe('mktemp\n');
		expect(existsSync(calls)).toBe(false);
		expect(readdirSync(forcedLiveStage)).toEqual([]);
		assertOriginalLiveTree();
		rmSync(forcedLiveStage, { recursive: true });

		const insideArchivePaths = [join(live, 'uploaded-site.tgz')];
		const liveArchiveFolder = join(live, 'incoming');
		mkdirSync(liveArchiveFolder);
		insideArchivePaths.push(join(liveArchiveFolder, 'uploaded-site.tgz'));
		if (process.platform !== 'win32') {
			const liveArchiveAlias = join(root, 'live-archive-alias');
			symlinkSync(live, liveArchiveAlias, 'dir');
			insideArchivePaths.push(join(liveArchiveAlias, 'aliased-site.tgz'));
		}
		for (const insideArchive of insideArchivePaths) {
			writeFileSync(insideArchive, readFileSync(guardArchive));
			clearEvidence();
			const rejected = deploy(insideArchive, '', live, 'nobody:nobody', staging, '', '1');
			expect(rejected.status, insideArchive).not.toBe(0);
			expect(rejected.stderr).toMatch(/archive must be outside/i);
			expect(existsSync(insideArchive)).toBe(true);
			expect(existsSync(calls)).toBe(false);
			expect(existsSync(mutations)).toBe(false);
			assertOriginalLiveTree();
			rmSync(insideArchive, { force: true });
		}
		rmSync(liveArchiveFolder, { recursive: true });
		rmSync(join(live, 'index.html'));
		rmSync(join(live, 'old.html'));

		for (const [kind, member] of [
			['symbolic', { name: 'assets/escape.css', type: 'symlink', link: '../../escape.css' }],
			['hard', { name: 'assets/copy.css', type: 'hardlink', link: 'assets/good.css' }]
		] as const) {
			clearEvidence();
			const hostile = join(root, `${kind}-link.tgz`);
			writeFileSync(
				hostile,
				archiveBytes([
					{ name: 'index.html', type: 'file', body: '<link href="/assets/good.css">' },
					{ name: 'assets/', type: 'directory' },
					{ name: 'assets/good.css', type: 'file', body: 'body{}' },
					member
				])
			);
			const rejected = deploy(hostile);
			expect(rejected.status).not.toBe(0);
			expect(rejected.stderr).toMatch(/link or special file/i);
			expect(readdirSync(live)).toEqual([]);
			expect(existsSync(hostile)).toBe(true);
		}

		// Resolve the archive once. This injected canonicalizer returns a distinct
		// validated file and immediately poisons the caller's original spelling;
		// every later read and the final removal must use the returned path.
		const canonicalLive = join(root, 'canonical-live');
		const canonicalArchive = join(root, 'canonical-site.tgz');
		const archiveSpelling = join(root, 'canonical-site-spelling.tgz');
		const replacement = join(root, 'replacement-not-an-archive');
		mkdirSync(canonicalLive);
		writeFileSync(canonicalArchive, readFileSync(guardArchive));
		writeFileSync(archiveSpelling, readFileSync(guardArchive));
		writeFileSync(replacement, 'not a gzip archive');
		clearEvidence();
		const canonicalAttempt = deploy(
			archiveSpelling,
			'',
			canonicalLive,
			'',
			staging,
			'',
			'',
			archiveSpelling,
			replacement,
			canonicalArchive
		);
		expect(canonicalAttempt.status, canonicalAttempt.stderr).toBe(0);
		expect(readFileSync(join(canonicalLive, 'index.html'), 'utf8')).toContain('/assets/good.css');
		expect(existsSync(canonicalArchive)).toBe(false);
		expect(readFileSync(archiveSpelling, 'utf8')).toBe('not a gzip archive');

		build();
		writeFileSync(join(source, 'site', 'dist', 'retired.html'), 'retired generation');
		const firstArchive = archive('first.tgz');
		const first = deploy(firstArchive);
		expect(first.status, first.stderr).toBe(0);
		const firstIndex = readFileSync(join(live, 'index.html'), 'utf8');
		const firstAssets = assetsIn(firstIndex);
		expect(firstAssets.length).toBeGreaterThan(0);
		expect(existsSync(join(live, 'retired.html'))).toBe(true);

		// A previous implementation reused this fixed name. Its contents must be
		// irrelevant to every new attempt.
		mkdirSync(join(staging, 'oda-new', 'assets'), { recursive: true });
		writeFileSync(join(staging, 'oda-new', 'index.html'), 'stale interrupted deploy');
		writeFileSync(join(staging, 'oda-new', 'retired-again.html'), 'stale');

		writeFileSync(
			join(source, 'site', 'assets', 'site.css'),
			`${readFileSync(join(source, 'site', 'assets', 'site.css'), 'utf8')}\n/* next generation */\n`
		);
		build();
		const secondArchive = archive('second.tgz');
		writeFileSync(calls, '0');
		const interrupted = deploy(secondArchive, 'first');
		expect(interrupted.status).not.toBe(0);
		expect(readFileSync(join(live, 'index.html'), 'utf8')).toBe(firstIndex);
		expect(existsSync(secondArchive)).toBe(true);

		writeFileSync(calls, '0');
		writeFileSync(destinations, '');
		const retry = deploy(secondArchive, '', `${posix(live)}/unused/..`);
		expect(retry.status, retry.stderr).toBe(0);
		expect(existsSync(secondArchive)).toBe(false);
		const currentIndex = readFileSync(join(live, 'index.html'), 'utf8');
		expect(currentIndex).not.toBe(firstIndex);
		expect(existsSync(join(live, 'retired.html'))).toBe(false);
		expect(existsSync(join(live, 'retired-again.html'))).toBe(false);
		const usedDestinations = readFileSync(destinations, 'utf8')
			.trim()
			.split(/\r?\n/)
			.map((path) => resolve(path));
		expect(usedDestinations).toEqual([resolve(join(live, 'assets')), resolve(live)]);
		for (const asset of [...firstAssets, ...assetsIn(currentIndex)]) {
			expect(existsSync(join(live, asset.replace(/^\//, ''))), asset).toBe(true);
		}
	}, 120_000);
});
