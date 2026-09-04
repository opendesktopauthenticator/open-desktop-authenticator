/**
 * Run a real-Electron smoke program without giving Chromium the repository as
 * its working directory.
 *
 * On Windows, even a minimal standalone Electron program can ask the system
 * spelling service to create a relative `Microsoft/Spelling/neutral` tree.
 * The service's temporary parent has an opaque name. Launching hundreds of
 * renderers from the checkout consequently left hundreds of those empty trees
 * beside package.json. The application itself pins its data path; these small
 * standalone programs did not have an equivalent process boundary.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import electronPath from 'electron';

const SCRATCH_PREFIX = 'oda-electron-harness-';

/**
 * Launch one process in a unique disposable directory and wait until all of
 * its inherited stdio has closed before cleaning that directory.
 *
 * Dependency seams are deliberate: the unit test drives a harmless Node child
 * that creates the exact relative spelling tree observed from Electron and can
 * inspect it at the cleanup boundary.
 */
export async function runIsolatedProcess({
	executable,
	args,
	tempRoot = tmpdir(),
	spawnProcess = spawn,
	removeDirectory = rm,
	stdio = 'inherit'
}) {
	const scratch = await mkdtemp(join(tempRoot, SCRATCH_PREFIX));
	let outcome;
	let childError;
	let launchError;
	let cleanupError;

	try {
		outcome = await new Promise((settle) => {
			const child = spawnProcess(executable, args, {
				cwd: scratch,
				stdio,
				windowsHide: true,
				env: process.env
			});
			child.once('error', (error) => {
				childError = error;
			});
			child.once('close', (code, signal) => settle({ code, signal }));
		});
	} catch (error) {
		launchError = error;
	} finally {
		try {
			await removeDirectory(scratch, {
				recursive: true,
				force: true,
				maxRetries: 8,
				retryDelay: 125
			});
		} catch (error) {
			cleanupError = error;
		}
	}

	if (cleanupError !== undefined) {
		throw new Error(`could not remove Electron harness scratch directory ${scratch}`, {
			cause: cleanupError
		});
	}
	if (launchError !== undefined) throw launchError;
	if (childError !== undefined) throw childError;
	return { ...outcome, scratch };
}

export function exitCodeForOutcome({ code, signal }) {
	if (signal === null) return code ?? 1;
	const number = constants.signals[signal];
	return typeof number === 'number' ? 128 + number : 1;
}

async function main() {
	const [requestedHarness, ...args] = process.argv.slice(2);
	if (requestedHarness === undefined) {
		throw new Error('usage: node tools/run-electron-harness.mjs <harness> [arguments...]');
	}
	if (typeof electronPath !== 'string' || electronPath.length === 0) {
		throw new Error('the Electron executable could not be resolved');
	}

	const harness = resolve(process.cwd(), requestedHarness);
	const result = await runIsolatedProcess({
		executable: electronPath,
		args: [harness, ...args]
	});
	if (result.signal !== null) {
		process.stderr.write(`Electron harness ended with signal ${result.signal}\n`);
	}
	process.exitCode = exitCodeForOutcome(result);
}

if (basename(process.argv[1] ?? '') === 'run-electron-harness.mjs') {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
