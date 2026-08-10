import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { describeReadFailure } from '../src/main/import/ipc';

/**
 * No filesystem path reaches the renderer (§12 F2).
 *
 * `src/main/import/ipc.ts` promises in its own header that "a path never travels
 * in either direction; only the base name does", and `docs/PLAN_AMENDMENTS.md`
 * repeats the guarantee. It was not true: the rejection reason forwarded
 * `err.message`, and Node embeds the absolute path in every filesystem error —
 * `ENOENT: no such file or directory, open 'C:\\Users\\alice\\Downloads\\x.maFile'`
 * — which puts the user's home directory and account name into the renderer.
 *
 * A promise a comment makes is worth what a test makes it worth.
 */

// Hoisted above the imports by vitest, so importing the module under test does
// not pull in a real Electron.
vi.mock('electron', () => ({
	ipcMain: { handle: (): undefined => undefined, removeHandler: (): undefined => undefined },
	dialog: {
		showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
			Promise.resolve({ canceled: true, filePaths: [] })
	},
	BrowserWindow: { getFocusedWindow: (): undefined => undefined, getAllWindows: () => [] }
}));

/** A real fs error, not a hand-built one — the point is what Node actually produces. */
function realError(run: () => void): unknown {
	try {
		run();
		throw new Error('expected the operation to fail');
	} catch (err) {
		return err;
	}
}

const SECRET_PATH = 'C:/Users/someone/Documents/private-folder/account.maFile';

describe('describeReadFailure', () => {
	it('never leaks the path from a real ENOENT', () => {
		const err = realError(() => readFileSync(SECRET_PATH, 'utf8'));

		// Confirm the premise: Node really does put the path in the message.
		expect((err as Error).message).toContain('private-folder');

		const described = describeReadFailure(err);
		expect(described).not.toContain('private-folder');
		expect(described).not.toContain('someone');
		expect(described).not.toContain('.maFile');
		expect(described).toBe('this file no longer exists.');
	});

	it('never leaks the path from a real stat failure', () => {
		const err = realError(() => statSync(SECRET_PATH));
		expect(describeReadFailure(err)).not.toContain('private-folder');
	});

	it('says something useful for the errors a user can act on', () => {
		expect(describeReadFailure({ code: 'EACCES' })).toMatch(/permission/);
		expect(describeReadFailure({ code: 'EISDIR' })).toMatch(/folder/);
		expect(describeReadFailure({ code: 'EBUSY' })).toMatch(/in use/);
	});

	it('falls back without echoing anything for an unknown failure', () => {
		// The default branch is the one most likely to be reached by an error we
		// have not seen, so it must not forward a message it has not inspected.
		const described = describeReadFailure(new Error(`something about ${SECRET_PATH}`));
		expect(described).toBe('this file could not be read.');
		expect(described).not.toContain('private-folder');
	});

	it('survives a non-error being thrown at it', () => {
		for (const value of [undefined, null, 'a string', 42, {}]) {
			expect(typeof describeReadFailure(value)).toBe('string');
		}
	});
});
