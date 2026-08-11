import { writeFile } from 'node:fs/promises';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { maFileName, toMaFile } from '../import/export';
import { DEACTIVATE_ACK } from '../../shared/ipc';
import { readRecoveryFile } from '../vault/recovery';
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

export interface OpenRecoveryDialog {
	/** Resolves to the file's contents, or undefined if the user cancelled. */
	pick(): Promise<string | undefined>;
}

export function registerEnrollmentHandlers(
	enrollment: EnrollmentService,
	vault: VaultService,
	dialog: SaveDialog,
	/** Drops an account's in-memory session, exactly as a local removal does. */
	onRemoved: (steamId64: string) => void = () => undefined,
	recoveryDialog: OpenRecoveryDialog = { pick: () => Promise.resolve(undefined) }
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

	// No `requireUnlocked` here, and that is deliberate: this only drops state we
	// are already holding. Refusing to clean up because the vault happened to lock
	// would leave the live session running for exactly the reason it should not.
	registerHandler(CHANNELS.enrollCancel, () => {
		enrollment.forget();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.enrollActivate, async ({ steamId64, code }) => {
		requireUnlocked();
		return { state: await enrollment.activate(steamId64, code) };
	});

	registerHandler(
		CHANNELS.accountDeactivate,
		async ({ steamId64, passphrase, acknowledgement }) => {
			requireUnlocked();

			// Checked here, not by the screen. The auto-confirm gate taught this lesson
			// the expensive way: a phrase enforced only in the renderer is a convention,
			// and this is the one operation more destructive than switching trades on.
			if (acknowledgement.trim().replace(/\s+/g, ' ').toUpperCase() !== DEACTIVATE_ACK) {
				throw new Error(`type "${DEACTIVATE_ACK}" to remove this authenticator from Steam`);
			}

			await enrollment.deactivate(steamId64, passphrase);

			// The same cleanup a local removal does: cookie jar, cached session,
			// pending list. An account whose authenticator is gone must not still have
			// a live session sitting in memory.
			onRemoved(steamId64);
			return { ok: true as const };
		}
	);

	registerHandler(CHANNELS.accountRecover, async ({ passphrase }) => {
		requireUnlocked();

		const text = await recoveryDialog.pick();
		if (text === undefined) {
			return { state: 'cancelled' as const };
		}

		// Decrypted in the main process and never handed outward. The renderer
		// learns which account came back and nothing else.
		const recovered = await readRecoveryFile(text, passphrase);

		const already = vault.read().accounts.some((entry) => entry.steamId64 === recovered.steamId64);
		if (already) {
			// Not an error. Somebody recovering a file they did not need should be
			// told that plainly rather than shown a failure.
			return { state: 'alreadyPresent' as const, accountName: recovered.accountName };
		}

		await vault.mutate((draft) => {
			draft.accounts.push(recovered.account);
		});

		return {
			state: 'restored' as const,
			accountName: recovered.accountName,
			steamId64: recovered.steamId64
		};
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
