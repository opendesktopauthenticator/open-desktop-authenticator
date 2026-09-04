import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync('.github/workflows/release.yml', 'utf8');

function preflightProgram(): string {
	const step = WORKFLOW.indexOf('- name: Validate the release ref');
	expect(step, 'the cheap dispatch preflight is absent').toBeGreaterThanOrEqual(0);
	const command = WORKFLOW.indexOf('node -e "', step);
	expect(command, 'the preflight does not expose an executable policy').toBeGreaterThan(step);
	const start = command + 'node -e "'.length;
	const end = WORKFLOW.indexOf('\n          "', start);
	expect(end, 'the preflight program has no closing delimiter').toBeGreaterThan(start);
	return WORKFLOW.slice(start, end);
}

function run(eventName: string, refType: string, refName: string, tagInput: string) {
	return spawnSync(process.execPath, ['-e', preflightProgram()], {
		encoding: 'utf8',
		env: {
			...process.env,
			EVENT_NAME: eventName,
			REF_TYPE: refType,
			REF_NAME: refName,
			TAG_INPUT: tagInput
		}
	});
}

describe('manual release dispatch preflight', () => {
	it('rejects the ordinary branch dispatch before checkout or build jobs', () => {
		const result = run('workflow_dispatch', 'branch', 'main', 'v1.5.0');
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('must be dispatched from that exact tag');

		const version = WORKFLOW.indexOf('  version:');
		const preflight = WORKFLOW.indexOf('- name: Validate the release ref', version);
		const checkout = WORKFLOW.indexOf('- uses: actions/checkout@', version);
		expect(preflight).toBeGreaterThan(version);
		expect(checkout).toBeGreaterThan(preflight);
	});

	it('accepts a dispatch whose selected ref is the exact entered tag', () => {
		expect(run('workflow_dispatch', 'tag', 'v1.5.0', 'v1.5.0').status).toBe(0);
	});

	it('rejects a dispatch from a different tag', () => {
		expect(run('workflow_dispatch', 'tag', 'v1.4.0', 'v1.5.0').status).not.toBe(0);
	});

	it('leaves a tag-push release path valid', () => {
		expect(run('push', 'tag', 'v1.5.0', '').status).toBe(0);
	});

	it('makes every expensive verification leg wait for the preflight', () => {
		const verify = WORKFLOW.slice(WORKFLOW.indexOf('  verify:'), WORKFLOW.indexOf('  version:'));
		expect(verify).toMatch(/verify:\s+needs: version\s+name:/);
	});
});
