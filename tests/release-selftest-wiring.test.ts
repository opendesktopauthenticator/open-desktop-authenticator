import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', ...parts), 'utf8');

/** The body of one top-level workflow job, without relying on a YAML parser. */
function job(source: string, name: string): string {
	const start = source.indexOf(`\n  ${name}:\n`);
	expect(start, `workflow has no ${name} job`).toBeGreaterThan(-1);
	const after = start + 1;
	const next = source.slice(after + 2).search(/^ {2}[a-zA-Z0-9_-]+:\s*$/m);
	return next === -1 ? source.slice(after) : source.slice(after, after + 2 + next);
}

describe('release selftests are themselves wired into the gates', () => {
	it('executes every generated negative SBOM fixture', () => {
		const source = read('.github', 'workflows', 'sbom.yml');
		const generated = [
			...source.matchAll(/fs\.writeFileSync\('(selftest-[^']+\.spdx\.json)'/g)
		].map((match) => match[1]);
		const consumed = [
			...source.matchAll(/^\s*expect_red\s+'[^']+'\s+(selftest-\S+\.spdx\.json)\s*$/gm)
		].map((match) => match[1]);

		expect(generated.length, 'the selftest generates no negative SBOM fixtures').toBeGreaterThan(0);
		expect(
			[...consumed].sort(),
			`generated fixture(s) not passed to expect_red: ${generated
				.filter((fixture) => !consumed.includes(fixture))
				.join(', ')}`
		).toEqual([...generated].sort());
	});

	it('re-runs the CI website-verifier selftest against a release tag', () => {
		const ciVerify = job(read('.github', 'workflows', 'ci.yml'), 'verify');
		const releaseVerify = job(read('.github', 'workflows', 'release.yml'), 'verify');
		const command = 'node site/selftest.mjs';

		expect(ciVerify, 'CI no longer runs the website-verifier selftest').toContain(command);
		expect(
			releaseVerify,
			'a tag can reference a commit ordinary CI never saw, but release verification omitted ' +
				'the verifier selftest used by CI'
		).toContain(command);
	});
});
