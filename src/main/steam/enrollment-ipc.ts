import { writeFile } from 'node:fs/promises';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { maFileName, toMaFile } from '../import/export';
import type { EnrollmentService } from './enrollment';
import { VaultLockedError, type VaultService } from '../vault/service';

/**
 * IPC for enrollment and maFile export (§12 F2, F3).
 *
 * Both surfaces share one rule with import: **no filesystem path crosses IPC in
 * either direction.** The renderer asks for a file to be written, the OS dialog
 * decides where, and the answer is a file name. A full path names the user's
 * machine and their folder layout to a process that has no use for either.
 */

export interface SaveDialog {
	/** Resolves to the chosen path, or undefined if the user cancelled. */
	show(suggestedName: string): Promise<string | undefined>;
}

export function registerEnrollmentHandlers(
	enrollment: EnrollmentService,
	vault: VaultService,
	dialog: SaveDialog
): void {
	/**
	 * Checked before a password is sent anywhere, and before a secret is read.
	 *
	 * Enrolling writes to the vault. Discovering it is locked *after* Steam has
	 * attached an authenticator is the one failure this flow must not have.
	 */
	const requireUnlocked = (): void => {
		if (!vault.isUnlocked()) {
			throw new VaultLockedError();
		}
	};

	registerHandler(CHANNELS.enrollBegin, async ({ accountName, password, proxyUrl }) => {
		requireUnlocked();
		return enrollment.begin(accountName, password, proxyUrl);
	});

	registerHandler(CHANNELS.enrollEmailCode, async ({ code }) => {
		requireUnlocked();
		return enrollment.submitEmailCode(code);
	});

	registerHandler(CHANNELS.enrollActivate, async ({ steamId64, code }) => {
		requireUnlocked();
		return { state: await enrollment.activate(steamId64, code) };
	});

	registerHandler(CHANNELS.accountExport, async ({ steamId64 }) => {
		requireUnlocked();

		const account = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!account) {
			throw new Error('no such account in this vault');
		}

		const suggested = maFileName(account);
		const destination = await dialog.show(suggested);
		if (destination === undefined) {
			return { state: 'cancelled' as const };
		}

		// `mode: 0o600` — owner-only. This file contains the same secrets as the
		// vault and none of its encryption, so the one protection available is that
		// other users on the machine cannot read it. The user is told as much on
		// the screen that offers this.
		await writeFile(destination, toMaFile(account), { encoding: 'utf8', mode: 0o600 });

		return { state: 'saved' as const, fileName: suggested };
	});
}
