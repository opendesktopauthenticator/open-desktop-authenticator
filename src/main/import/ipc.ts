import { BrowserWindow, dialog } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import type { ImportReport } from '../../shared/ipc';
import type { ImportService, StagedFile } from './service';

/**
 * The import IPC surface (§12 F2, §24.3).
 *
 * The file picker lives here rather than in the renderer for one reason: **the
 * renderer never names a file.** It cannot ask us to read an arbitrary path,
 * because no channel takes a path — it can only ask the OS picker to be shown,
 * and the user decides what that returns. A path never travels in either
 * direction; only the base name does, and only so the user can tell two files
 * apart in the report.
 */

/**
 * A maFile is about a kilobyte. A megabyte is generous by three orders of
 * magnitude and still bounds what a mistaken selection can pull into memory.
 */
const MAX_FILE_BYTES = 1024 * 1024;

/** More than this in one go is a wrong folder, not an import. */
const MAX_FILES = 100;

export function registerImportHandlers(imports: ImportService): void {
	registerHandler(CHANNELS.importScan, async (): Promise<ImportReport> => {
		// Checked before the picker opens, so a locked vault never even asks.
		imports.assertUnlocked();

		const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

		const picked = await (parent
			? dialog.showOpenDialog(parent, PICKER_OPTIONS)
			: dialog.showOpenDialog(PICKER_OPTIONS));

		if (picked.canceled || picked.filePaths.length === 0) {
			return { cancelled: true, candidates: [], rejected: [] };
		}

		// Checked again, and this is the one that matters. The dialog can stay open
		// for as long as the user browses, and the vault auto-locks on its own
		// schedule — so by the time files come back, the session that authorised
		// this may be gone. Reading them anyway would pull every chosen secret into
		// memory with nobody present, and discarding the staging afterwards cannot
		// un-read them.
		imports.assertUnlocked();

		const files: StagedFile[] = [];
		const rejected: ImportReport['rejected'] = [];

		for (const path of picked.filePaths.slice(0, MAX_FILES)) {
			const name = basename(path);
			try {
				const size = statSync(path).size;
				if (size > MAX_FILE_BYTES) {
					rejected.push({
						sourceName: name,
						reason: `this file is ${Math.round(size / 1024)} KB. A maFile is about a kilobyte, so this is not one.`
					});
					continue;
				}
				files.push({ name, text: readFileSync(path, 'utf8') });
			} catch (err) {
				rejected.push({ sourceName: name, reason: describeReadFailure(err) });
			}
		}

		if (picked.filePaths.length > MAX_FILES) {
			rejected.push({
				sourceName: `${picked.filePaths.length - MAX_FILES} more file(s)`,
				reason: `only ${MAX_FILES} files can be imported at once.`
			});
		}

		const report = imports.stage(files);
		return { ...report, rejected: [...rejected, ...report.rejected] };
	});

	registerHandler(CHANNELS.importCommit, async ({ selections }) => ({
		outcomes: await imports.commit(selections)
	}));

	registerHandler(CHANNELS.importDiscard, () => {
		imports.discard();
		return { ok: true as const };
	});
}

/**
 * Why a chosen file could not be read, **without naming where it lives.**
 *
 * Node's filesystem errors embed the absolute path: `ENOENT: no such file or
 * directory, open 'C:\Users\alice\Downloads\x.maFile'`. Forwarding that message
 * would put the user's home directory — and their account name on the machine —
 * into the renderer, which is exactly the thing this module's header promises
 * never travels. The base name already identifies the file.
 */
export function describeReadFailure(err: unknown): string {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	switch (code) {
		case 'ENOENT':
			return 'this file no longer exists.';
		case 'EACCES':
		case 'EPERM':
			return 'this file could not be opened — permission was refused.';
		case 'EISDIR':
			return 'this is a folder, not a file.';
		case 'EBUSY':
			return 'this file is in use by another program.';
		default:
			return 'this file could not be read.';
	}
}

const PICKER_OPTIONS = {
	title: 'Choose maFiles to import',
	// `dontAddToRecent` keeps an authenticator file out of the OS recent-documents
	// list, where its name would advertise which accounts live on this machine.
	properties: ['openFile', 'multiSelections', 'dontAddToRecent'] as const,
	filters: [
		{ name: 'Steam authenticator files', extensions: ['maFile'] },
		{ name: 'All files', extensions: ['*'] }
	]
} satisfies Electron.OpenDialogOptions;
