import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { describeReadFailure, manifestsFirst } from '../src/main/import/ipc';
import { looksEncrypted } from '../src/main/import/sda-crypto';

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

/**
 * The hundred-file cap and the manifest (§12 F2).
 *
 * The cap keeps a mistaken selection from pulling a whole drive into memory. It
 * takes the *first* hundred paths, which is fine for maFiles and quietly fatal
 * for the one file the encrypted ones cannot be read without.
 */
describe('finding manifest.json beside the chosen files', () => {
	// The behaviour lives in the scan handler, which needs Electron's dialog. What
	// is asserted here is the decision the handler makes, spelled out so the rule
	// is pinned even though the surrounding I/O is not reachable from a unit test.
	it('is only reached when something encrypted was chosen and no manifest was', () => {
		const encrypted = Buffer.alloc(32).toString('base64');
		const plain = '{"shared_secret":"s"}';
		const manifest = '{"entries":[]}';

		const needsLookup = (files: { name: string; text: string }[]): boolean =>
			files.some((file) => looksEncrypted(file.text)) &&
			!files.some((file) => file.name.toLowerCase() === 'manifest.json');

		// The case the user hit: encrypted maFiles picked, manifest left behind.
		expect(needsLookup([{ name: 'a.maFile', text: encrypted }])).toBe(true);
		// Already chosen — nothing to look for.
		expect(
			needsLookup([
				{ name: 'a.maFile', text: encrypted },
				{ name: 'manifest.json', text: manifest }
			])
		).toBe(false);
		// Nothing encrypted — no reason to open a file nobody picked.
		expect(needsLookup([{ name: 'a.maFile', text: plain }])).toBe(false);
	});
});

describe('manifestsFirst', () => {
	/** An SDA folder bigger than the cap. maFiles are named for their SteamID. */
	function bigFolder(count: number): string[] {
		const files = Array.from(
			{ length: count },
			(_, index) => `C:/SDA/maFiles/765611980000${String(index).padStart(5, '0')}.maFile`
		);
		// Where an alphabetical picker puts it: every digit sorts ahead of `m`.
		return [...files, 'C:/SDA/maFiles/manifest.json'];
	}

	it('keeps the manifest when the selection is over the cap', () => {
		// Without this the manifest is sliced off, every encrypted file becomes
		// undecryptable, and the screen tells the user to also choose manifest.json
		// — which they just did. Selecting again reproduces it exactly, so there is
		// no way out of it from the UI.
		const kept = manifestsFirst(bigFolder(150)).slice(0, 100);

		expect(kept.some((path) => path.endsWith('manifest.json'))).toBe(true);
	});

	it('does not drop or duplicate anything', () => {
		const paths = bigFolder(5);
		const ordered = manifestsFirst(paths);

		expect(ordered).toHaveLength(paths.length);
		expect([...ordered].sort()).toEqual([...paths].sort());
	});

	it('leaves the order of the maFiles themselves alone', () => {
		// Only the manifests move. The report lists candidates in the order they
		// were chosen, and shuffling that would make a long list hard to follow.
		const ordered = manifestsFirst(['b.maFile', 'manifest.json', 'a.maFile', 'c.maFile']);

		expect(ordered).toEqual(['manifest.json', 'b.maFile', 'a.maFile', 'c.maFile']);
	});

	it('handles a selection with no manifest, and one with nothing else', () => {
		expect(manifestsFirst(['a.maFile', 'b.maFile'])).toEqual(['a.maFile', 'b.maFile']);
		expect(manifestsFirst(['manifest.json'])).toEqual(['manifest.json']);
		expect(manifestsFirst([])).toEqual([]);
	});
});
