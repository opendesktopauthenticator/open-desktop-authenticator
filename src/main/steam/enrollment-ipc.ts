import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { maFileName, toMaFile } from '../import/export';
import { DEACTIVATE_ACK, matchesDeactivateAck } from '../../shared/ipc';
import { readRecoveryFile, RecoveryError } from '../vault/recovery';
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
		// **And count this as activity.** Enrolling has a pause in the middle while
		// the user goes to find an emailed code, and typing into another application
		// is not something the idle timer can see. Without this, the vault could lock
		// partway through the one flow whose failure costs an authenticator — and it
		// would look like the app locking for no reason, because from the user's
		// point of view they had been working the whole time.
		vault.touch();
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
			if (!matchesDeactivateAck(acknowledgement)) {
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

		// **Checked again, and this is the one that matters.** The picker stays open
		// for as long as the user browses, and the vault auto-locks on its own
		// schedule — so by the time a file comes back, the session that authorised
		// this may be gone. Decrypting anyway pulls a shared secret, an identity
		// secret and a revocation code into memory with nobody present, and the
		// `vault.read()` further down throws far too late to un-read them.
		//
		// The maFile import path has guarded exactly this window since it was
		// written. This one did not.
		requireUnlocked();

		// Decrypted in the main process and never handed outward. The renderer
		// learns which account came back and nothing else.
		const recovered = await readRecoveryFile(text, passphrase);

		// **The account's own SteamID decides, not the file's metadata.**
		//
		// A recovery file carries the SteamID twice: once at the top level, where it
		// is informational so files can be told apart without decrypting them, and
		// once inside the account itself. The duplicate check read the outer one and
		// the insert used the inner one, so a file whose two copies disagreed —
		// corrupt, hand-edited, or built by something else — could pass a check
		// against one identity and then push an account under another, landing a
		// second row for an account already present.
		const identity = recovered.account.steamId64;
		if (identity !== recovered.steamId64) {
			throw new RecoveryError(
				'that recovery file disagrees with itself about which account it is for, so it was not used.'
			);
		}

		const already = vault.read().accounts.some((entry) => entry.steamId64 === identity);
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

		// **Checked again, after the dialog.** A save dialog sits open for as long as
		// the user takes to pick a folder, and the idle timer, a suspend or an OS
		// screen lock can all fire in that window. The account was copied out before
		// the dialog opened, so without this the plaintext secrets are written after
		// the vault has locked — the one moment the application has been told nobody
		// is present.
		requireUnlocked();

		// And re-read, for the same reason. The copy taken before the dialog
		// outlives anything that happened during it — writing it out for an
		// account since removed would put secrets the user just chose to be rid of
		// into a fresh plaintext file.
		const current = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!current) {
			throw new Error('that account is no longer in this vault, so nothing was exported.');
		}

		// `mode: 0o600` — owner-only. This file contains the same secrets as the
		// vault and none of its encryption, so the one protection available is that
		// other users on the machine cannot read it. The user is told as much on
		// the screen that offers this.
		//
		// **Temp beside the destination, then rename — never truncate in place.**
		// Writing straight to the chosen path opens it for truncation first, so a
		// write that then failed — disk full, a drive unplugged mid-copy — had
		// already emptied the previous maFile at that name. Re-exporting over an
		// existing backup is the ordinary case, and a failed export must leave the
		// old file exactly as it was; the vault and recovery writers have always
		// worked this way.
		//
		// Wrapped because a failed write throws with the absolute path in its
		// message, and the rule at the top of this module is that no path crosses
		// IPC in either direction.
		const temp = `${destination}.tmp`;
		try {
			await writeFile(temp, toMaFile(current), { encoding: 'utf8', mode: 0o600 });
			await rename(temp, destination);
		} catch {
			await rm(temp, { force: true }).catch(() => undefined);
			throw new Error(`${suggested} could not be written to that location.`);
		}
		// **`mode` alone was not enough.** POSIX applies it only when the file is
		// created, so exporting over a file that already existed — a second export to
		// the same name, which is the ordinary case — kept whatever permissions it
		// had, commonly `0644`, while replacing its contents with an unencrypted
		// shared_secret and identity_secret.
		//
		// Best effort: Windows has no POSIX mode, and failing an export that has
		// already written its bytes would leave the user worse off than a permission
		// bit that could not be set.
		try {
			await chmod(destination, 0o600);
		} catch {
			/* not supported here; the directory's own permissions still apply */
		}

		return { state: 'saved' as const, fileName: suggested };
	});
}
