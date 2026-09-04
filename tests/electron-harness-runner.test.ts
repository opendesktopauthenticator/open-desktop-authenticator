import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const ROOT = resolve(__dirname, '..');

// This test compiles as CommonJS while the executable runner is ESM. Keep the
// boundary as a real dynamic import — the same operation Node performs here —
// rather than asking TypeScript to turn a type-only ESM import into `require`.
const loadRunner = () => import('../tools/run-electron-harness.mjs');

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'oda-electron-runner-test-'));
	roots.push(root);
	return root;
}

describe('the real-Electron harness process boundary', () => {
	it('contains a child-created spelling tree and removes the exact scratch directory', async () => {
		const root = fixtureRoot();
		let inspected = false;
		let scratch = '';

		const result = await (
			await loadRunner()
		).runIsolatedProcess({
			executable: process.execPath,
			args: ['-e', "require('fs').mkdirSync('Microsoft/Spelling/neutral',{recursive:true})"],
			tempRoot: root,
			stdio: 'ignore',
			removeDirectory: async (path, options) => {
				scratch = path;
				expect(options).toMatchObject({
					recursive: true,
					force: true,
					maxRetries: 8,
					retryDelay: 125
				});
				expect(existsSync(join(path, 'Microsoft', 'Spelling', 'neutral'))).toBe(true);
				expect(
					resolve(path).startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`)
				).toBe(true);
				expect(
					resolve(path).startsWith(`${ROOT}${process.platform === 'win32' ? '\\' : '/'}`)
				).toBe(false);
				inspected = true;
				await import('node:fs/promises').then(({ rm }) => rm(path, options));
			}
		});

		expect(result.code).toBe(0);
		expect(result.signal).toBeNull();
		expect(inspected).toBe(true);
		expect(result.scratch).toBe(scratch);
		expect(existsSync(scratch)).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it('waits for a signalled child and removes its scratch directory', async () => {
		const root = fixtureRoot();
		const result = await (
			await loadRunner()
		).runIsolatedProcess({
			executable: 'injected-child',
			args: [],
			tempRoot: root,
			stdio: 'ignore',
			spawnProcess: (_executable, _args, options) => {
				expect(
					resolve(options.cwd).startsWith(
						`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`
					)
				).toBe(true);
				const child = new EventEmitter() as unknown as ChildProcess;
				queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
				return child;
			}
		});

		expect(result).toMatchObject({ code: null, signal: 'SIGTERM' });
		expect(existsSync(result.scratch)).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it('cleans the scratch directory before surfacing an asynchronous spawn error', async () => {
		const root = fixtureRoot();
		let scratch = '';
		const attempt = (await loadRunner()).runIsolatedProcess({
			executable: 'injected-child',
			args: [],
			tempRoot: root,
			stdio: 'ignore',
			spawnProcess: (_executable, _args, options) => {
				scratch = options.cwd;
				const child = new EventEmitter() as unknown as ChildProcess;
				queueMicrotask(() => {
					child.emit('error', new Error('spawn refused'));
					child.emit('close', null, null);
				});
				return child;
			}
		});

		await expect(attempt).rejects.toThrow(/spawn refused/i);
		expect(existsSync(scratch)).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it('returns a child failure without leaving its scratch directory', async () => {
		const root = fixtureRoot();
		const result = await (
			await loadRunner()
		).runIsolatedProcess({
			executable: process.execPath,
			args: ['-e', 'process.exit(7)'],
			tempRoot: root,
			stdio: 'ignore'
		});

		expect(result).toMatchObject({ code: 7, signal: null });
		expect(existsSync(result.scratch)).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	it('turns a child signal into its conventional failing exit code', async () => {
		const { exitCodeForOutcome } = await loadRunner();
		expect(exitCodeForOutcome({ code: null, signal: 'SIGTERM' })).toBe(
			128 + constants.signals.SIGTERM
		);
		expect(exitCodeForOutcome({ code: 7, signal: null })).toBe(7);
	});

	it('fails instead of hiding a scratch cleanup failure', async () => {
		const root = fixtureRoot();
		await expect(
			(await loadRunner()).runIsolatedProcess({
				executable: process.execPath,
				args: ['-e', 'process.exit(0)'],
				tempRoot: root,
				stdio: 'ignore',
				removeDirectory: () => Promise.reject(new Error('held open'))
			})
		).rejects.toThrow(/could not remove Electron harness scratch directory/i);
	});

	it('routes every real Electron gate through the isolated runner', () => {
		const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
			string,
			string
		>;
		const combined = `${scripts['smoke:browser']} ${scripts['stress:browser']}`;
		expect(combined.match(/node tools\/run-electron-harness\.mjs/g)).toHaveLength(4);
		expect(combined).not.toMatch(/(?:^|&&\s*)electron\s+(?:out|tools)[/\\]/);
	});
});
