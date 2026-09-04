import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
	scripts: Record<string, string>;
};

const integrationFiles = [
	'tests/infra-runtime.test.ts',
	'tests/cloudflare-firewall.test.ts',
	'tests/site-deploy.test.ts'
];

const testsNamedBy = (command: string): string[] =>
	command.match(/tests\/[a-z0-9-]+\.test\.ts/g) ?? [];

function script(name: string): string {
	const value = manifest.scripts[name];
	if (value === undefined) throw new Error(`package.json has no ${name} script`);
	return value;
}

describe('the complete test gate is partitioned without gaps or overlap', () => {
	it('runs the parallel core before the serial real-process phase', () => {
		expect(script('test')).toBe('npm run test:core && npm run test:integration');
	});

	it('excludes exactly the integration files from the core phase', () => {
		const core = script('test:core');
		expect(core).toBe(
			'vitest run --exclude tests/infra-runtime.test.ts --exclude ' +
				'tests/cloudflare-firewall.test.ts --exclude tests/site-deploy.test.ts'
		);
		expect(testsNamedBy(core)).toEqual(integrationFiles);
		expect(core.match(/--exclude/g)).toHaveLength(integrationFiles.length);
		expect(core).not.toContain('--maxWorkers');
	});

	it('names the same three files once in a one-worker integration phase', () => {
		const integration = script('test:integration');
		expect(integration).toBe(
			'vitest run tests/infra-runtime.test.ts tests/cloudflare-firewall.test.ts ' +
				'tests/site-deploy.test.ts --maxWorkers=1'
		);
		expect(testsNamedBy(integration)).toEqual(integrationFiles);
		expect(new Set(testsNamedBy(integration)).size).toBe(integrationFiles.length);
		expect(integration.match(/--maxWorkers=1/g)).toHaveLength(1);
		expect(integration).not.toContain('--exclude');
	});

	it('keeps CI and release on the combined npm test gate', () => {
		for (const workflow of ['ci.yml', 'release.yml']) {
			const source = readFileSync(join(ROOT, '.github', 'workflows', workflow), 'utf8');
			expect(source, `${workflow} no longer runs the complete test gate`).toMatch(
				/^\s*-?\s*run:\s+npm test\s*$/m
			);
			expect(source).not.toMatch(/npm run test:(?:core|integration)/);
		}
	});
});
