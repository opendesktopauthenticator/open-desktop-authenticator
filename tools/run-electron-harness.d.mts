import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { RmDirOptions } from 'node:fs';

export interface IsolatedProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	scratch: string;
}

export interface IsolatedProcessOptions {
	executable: string;
	args: string[];
	tempRoot?: string;
	stdio?: StdioOptions;
	spawnProcess?: (
		executable: string,
		args: string[],
		options: {
			cwd: string;
			stdio: StdioOptions;
			windowsHide: boolean;
			env: NodeJS.ProcessEnv;
		}
	) => ChildProcess;
	removeDirectory?: (path: string, options: RmDirOptions) => Promise<void>;
}

export function runIsolatedProcess(options: IsolatedProcessOptions): Promise<IsolatedProcessResult>;

export function exitCodeForOutcome(outcome: Pick<IsolatedProcessResult, 'code' | 'signal'>): number;
