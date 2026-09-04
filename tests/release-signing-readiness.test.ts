import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync('.github/workflows/release.yml', 'utf8');
const PACKAGE = WORKFLOW.slice(WORKFLOW.indexOf('  package:'), WORKFLOW.indexOf('  publish:'));

function inlineNodeProgram(stepName: string): string {
	const step = WORKFLOW.indexOf(`- name: ${stepName}`);
	expect(step, `${stepName} is absent`).toBeGreaterThanOrEqual(0);
	const command = WORKFLOW.indexOf('node -e "', step);
	expect(command, `${stepName} does not expose an executable policy`).toBeGreaterThan(step);
	const start = command + 'node -e "'.length;
	const end = WORKFLOW.indexOf('\n          "', start);
	expect(end, `${stepName} has no closing delimiter`).toBeGreaterThan(start);
	return WORKFLOW.slice(start, end);
}

const COMPLETE = {
	MACOS_CERTIFICATE_P12: 'certificate',
	MACOS_CERTIFICATE_PASSWORD: 'password',
	APPLE_API_KEY_P8: 'private-key',
	APPLE_API_KEY_ID: 'key-id',
	APPLE_API_ISSUER: 'issuer',
	APPLE_TEAM_ID: 'team'
};

function preflight(ready: boolean, credentials: Partial<typeof COMPLETE> = COMPLETE) {
	return spawnSync(
		process.execPath,
		['-e', inlineNodeProgram('Validate macOS signing readiness')],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				MACOS_SIGNING_READY: String(ready),
				...Object.fromEntries(Object.keys(COMPLETE).map((key) => [key, ''])),
				...credentials
			}
		}
	);
}

function draftNotes(ready: boolean): string {
	const result = spawnSync(
		process.execPath,
		['-e', inlineNodeProgram('Generate draft release notes')],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				MACOS_SIGNING_READY: String(ready),
				TAG: 'v1.5.0',
				GITHUB_REPOSITORY: 'owner/project'
			}
		}
	);
	expect(result.stderr).toBe('');
	expect(result.status).toBe(0);
	return result.stdout;
}

function fencedCodeBlocks(markdown: string): Array<{ language: string; command: string }> {
	const lines = markdown.split(/\r?\n/);
	const blocks: Array<{ language: string; command: string }> = [];
	for (let index = 0; index < lines.length; index += 1) {
		const opening = lines[index]?.match(/^```([A-Za-z0-9_-]+)$/);
		if (!opening) continue;
		const closing = lines.indexOf('```', index + 1);
		expect(closing, `the ${opening[1]} block is not closed`).toBeGreaterThan(index);
		blocks.push({
			language: opening[1] ?? '',
			command: lines.slice(index + 1, closing).join('\n')
		});
		index = closing;
	}
	return blocks;
}

describe('macOS signing readiness', () => {
	it('ignores a complete secret set while the deliberate switch is off', () => {
		expect(preflight(false).status).toBe(0);
		expect(PACKAGE).toContain('- name: Validate macOS signing readiness');

		for (const variable of [
			'CSC_LINK',
			'CSC_KEY_PASSWORD',
			'APPLE_API_KEY',
			'APPLE_API_KEY_ID',
			'APPLE_API_ISSUER',
			'APPLE_TEAM_ID'
		]) {
			const packageStep = PACKAGE.slice(
				PACKAGE.indexOf('- name: Package'),
				PACKAGE.indexOf('- name: Remove the notarisation key')
			);
			const at = packageStep.indexOf(`${variable}:`);
			expect(at, `${variable} is absent`).toBeGreaterThanOrEqual(0);
			const value = packageStep.slice(at, packageStep.indexOf('}}', at));
			expect(value, `${variable} escapes the readiness switch`).toContain(
				"vars.MACOS_SIGNING_READY == 'true'"
			);
		}

		// Every raw secret reference in the package job, including the preflight
		// and key-materialisation step, is behind both gates. A step-level `if`
		// alone still gives a running preflight process those secrets when the
		// switch is false.
		for (const secret of Object.keys(COMPLETE)) {
			let from = 0;
			let checked = 0;
			while (true) {
				const at = PACKAGE.indexOf(`secrets.${secret}`, from);
				if (at < 0) break;
				const start = PACKAGE.lastIndexOf('${{', at);
				const end = PACKAGE.indexOf('}}', at);
				const expression = PACKAGE.slice(start, end);
				expect(expression).toContain("runner.os == 'macOS'");
				expect(expression).toContain("vars.MACOS_SIGNING_READY == 'true'");
				checked += 1;
				from = end + 2;
			}
			expect(checked, `${secret} is never wired`).toBeGreaterThan(0);
		}
	});

	it('refuses readiness when any credential is missing', () => {
		for (const missing of Object.keys(COMPLETE) as (keyof typeof COMPLETE)[]) {
			const credentials = { ...COMPLETE, [missing]: '' };
			const result = preflight(true, credentials);
			expect(result.status, `${missing} was optional`).not.toBe(0);
			expect(result.stderr).toContain(missing);
		}
	});

	it('accepts the complete signed configuration', () => {
		expect(preflight(true).status).toBe(0);
	});

	it('keeps the builder half-configuration refusal', () => {
		const program = `import(${JSON.stringify(pathToFileURL(resolve('electron-builder.config.mjs')).href)})`;
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
			encoding: 'utf8',
			env: { ...process.env, CSC_LINK: 'certificate', APPLE_API_KEY: '' }
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('half-configured');
	});
});

describe('draft release signing copy', () => {
	it('calls only the Windows and Linux direct downloads unsigned before macOS publication', () => {
		const notes = draftNotes(false);
		expect(notes).toMatch(/Windows and Linux direct downloads are unsigned/i);
		expect(notes).toMatch(/No macOS DMG is included/i);
		expect(notes).not.toMatch(/macOS DMGs? (?:is|are) signed and notarized/i);
	});

	it('calls a published macOS DMG signed and notarized', () => {
		const notes = draftNotes(true);
		expect(notes).toMatch(/Windows and Linux direct downloads are unsigned/i);
		expect(notes).toMatch(/macOS DMGs? (?:is|are) Developer ID-signed and notarized by Apple/i);
		expect(notes).not.toMatch(/macOS DMGs? (?:is|are) signed and notarized by Apple/i);
		expect(notes).not.toMatch(/No macOS DMG is included/i);
	});

	it.each([false, true])(
		'puts every verification command in an explicit fenced block (ready=%s)',
		(ready) => {
			const notes = draftNotes(ready);
			const blocks = fencedCodeBlocks(notes);
			expect(blocks).toEqual([
				{
					language: 'shell',
					command: 'sha256sum --check --ignore-missing SHA256SUMS.txt'
				},
				{
					language: 'shell',
					command: 'shasum -a 256 --check --ignore-missing SHA256SUMS.txt'
				},
				{
					language: 'powershell',
					command: String.raw`Get-FileHash .\<file> -Algorithm SHA256`
				},
				{
					language: 'shell',
					command:
						'cosign verify-blob SHA256SUMS.txt ' +
						'--signature SHA256SUMS.txt.sig ' +
						'--certificate SHA256SUMS.txt.pem ' +
						'--certificate-identity https://github.com/owner/project/.github/workflows/release.yml@refs/tags/v1.5.0 ' +
						'--certificate-oidc-issuer https://token.actions.githubusercontent.com'
				}
			]);
			expect(notes).toContain(String.raw`Get-FileHash .\<file> -Algorithm SHA256`);
		}
	);

	it.each([false, true])(
		'publishes the complete checksum signature command (ready=%s)',
		(ready) => {
			const notes = draftNotes(ready);
			const command = notes
				.split('\n')
				.map((line) => line.trim())
				.find((line) => line.startsWith('cosign verify-blob'));
			expect(command).toBe(
				'cosign verify-blob SHA256SUMS.txt ' +
					'--signature SHA256SUMS.txt.sig ' +
					'--certificate SHA256SUMS.txt.pem ' +
					'--certificate-identity https://github.com/owner/project/.github/workflows/release.yml@refs/tags/v1.5.0 ' +
					'--certificate-oidc-issuer https://token.actions.githubusercontent.com'
			);
		}
	);
});
