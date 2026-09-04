import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ignored = (path: string): boolean =>
	spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], {
		cwd: process.cwd(),
		encoding: 'utf8'
	}).status === 0;

describe('local release-candidate output', () => {
	it('ignores the whole top-level release-rc tree without hiding release source', () => {
		const patterns = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
		expect(patterns).toContain('/release-rc/');
		expect(ignored('release-rc/win-unpacked/resources/app.asar')).toBe(true);
		expect(ignored('docs/RELEASE_CHECKLIST.md')).toBe(false);
		expect(ignored('.github/workflows/release.yml')).toBe(false);
	});
});
