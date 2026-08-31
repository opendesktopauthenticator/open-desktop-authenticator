import { randomUUID } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { maFileName, toMaFile } from '../import/export';
import { DEACTIVATE_ACK, matchesDeactivateAck } from '../../shared/ipc';
import { readRecoveryFile, RecoveryError } from '../vault/recovery';
import type { EnrollmentService } from './enrollment';
import { EnrollmentError } from './enroll';
import { PROXY_REQUIRED } from '../net/egress';
import { ProxyConsent } from '../net/proxy-consent';
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

/**
 * What identifies the authenticator this export is a copy of.
 *
 * Not the account id: an account removed and re-enrolled keeps its SteamID and
 * shares nothing else, and a maFile written from the old secrets would be a
 * backup of something Steam has already stopped accepting.
 */
function fingerprint(account: {
	steamId64: string;
	sharedSecret: string;
	identitySecret: string;
	revocationCode?: string | undefined;
}): string {
	return [
		account.steamId64,
		account.sharedSecret,
		account.identitySecret,
		account.revocationCode ?? ''
	].join('|');
}

export function registerEnrollmentHandlers(
	enrollment: EnrollmentService,
	vault: VaultService,
	dialog: SaveDialog,
	/** Drops an account's in-memory session, exactly as a local removal does. */
	onRemoved: (steamId64: string) => void = () => undefined,
	recoveryDialog: OpenRecoveryDialog = { pick: () => Promise.resolve(undefined) },
	/** See `ProxyConsent`. Refuses by default when nothing supplies a way to ask. */
	proxyConsent: ProxyConsent = new ProxyConsent()
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
		/*
		 * **`Require proxies` reaches this, and it did not.**
		 *
		 * The setting is enforced at `SteamTransportFactory.forAccount`, which
		 * every Steam request crosses — except the ones that do not use a
		 * transport. `steam-session` speaks over Node's own HTTP stack, so an
		 * enrolment sent a password to Steam's login servers from this machine's
		 * own address, on a vault that forbade exactly that.
		 *
		 * There is no stored account to read a proxy from: this is the call that
		 * creates one. So the field on the form is what decides, and empty means
		 * refused rather than "unrouted for now" — an account enrolled from the
		 * user's own address has already told Steam the thing the proxy was for.
		 */
		if (vault.settings().requireProxies && (proxyUrl === undefined || proxyUrl === '')) {
			throw new EnrollmentError(PROXY_REQUIRED);
		}
		/*
		 * **And the address itself needs approving before a password goes down it.**
		 *
		 * There is no stored account to compare against here, so every proxy on
		 * this path is a destination the vault has never seen — which is exactly
		 * the case the gate exists for. The renderer chooses this host, and this
		 * call sends a password and reaches Steam through it; without the gate a
		 * compromised renderer picks the host and gets both the exfiltration
		 * channel and the credential travelling through it.
		 */
		if (proxyUrl !== undefined && proxyUrl !== '') {
			await proxyConsent.require(proxyUrl, { accountName, reason: 'signIn' });
			/*
			 * **And the vault is checked again, because the dialog waits.**
			 *
			 * `requireUnlocked()` above answered for the moment the button was
			 * pressed. Consent is an OS dialog a person can leave on screen
			 * indefinitely, and the vault locks on its own schedule — so without
			 * this, approving after a lock sent the password to Steam for a vault
			 * that had closed, over an endpoint approved by nobody who was there.
			 * The rule is re-asked too: `Require proxies` can be turned on inside
			 * the same wait.
			 */
			requireUnlocked();
			if (vault.settings().requireProxies && (proxyUrl === undefined || proxyUrl === '')) {
				throw new EnrollmentError(PROXY_REQUIRED);
			}
		}
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

		// And once more with the plaintext in hand. The decrypt is a deliberate
		// second of scrypt, and the idle lock does not pause for it — a lock that
		// landed during it means nobody is present for the secrets that were just
		// decrypted. They cannot be un-read, but nothing further happens with
		// them, and the refusal names the real reason instead of surfacing the
		// vault read below failing incidentally.
		requireUnlocked();

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
		// A unique name, and `wx`. A fixed `.tmp` suffix truncated whatever already
		// sat at that name — a sibling file that was never ours — and two exports
		// to the same destination shared one temp, so either's failure path could
		// delete the other's work. The random name makes collisions impossible and
		// `wx` makes this write constitutionally unable to empty an existing file.
		const temp = `${destination}.${randomUUID()}.tmp`;

		/*
		 * What this file is about to contain, captured before the write.
		 *
		 * Re-read and compared after it, beside the lock check — see there. The
		 * revocation code is included because replacing it alone makes an exported
		 * copy wrong in the way that matters most: it is the one secret whose loss
		 * cannot be undone, and a backup holding the previous one is worse than no
		 * backup, because somebody will believe it.
		 */
		const exported = fingerprint(current);

		/*
		 * Cleanup and refusal in one place, so both failure paths below can keep a
		 * **bare** `catch`.
		 *
		 * That is not style. `preserve-caught-error` wants a `cause` on anything
		 * rethrown from a bound error — and the whole rule of this module is that
		 * no filesystem path crosses IPC. A failed write throws with the absolute
		 * destination in its message, so attaching it as a cause would hand the
		 * renderer the user's folder layout through the back door, to satisfy a
		 * lint rule about diagnostics.
		 */
		const giveUp = async (): Promise<never> => {
			await rm(temp, { force: true }).catch(() => undefined);
			throw new Error(`${suggested} could not be written to that location.`);
		};

		try {
			await writeFile(temp, toMaFile(current), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		} catch {
			await giveUp();
		}

		{
			/*
			 * **Checked once more, between writing and publishing.**
			 *
			 * The check before this covers the save dialog, which is the long wait —
			 * but the write is a wait too, and a slow one on the drives people
			 * actually export to: a USB stick, a network share, an SD card. Lock the
			 * vault during it — manually, by idling, by shutting the lid — and the
			 * rename still completed and put a plaintext maFile at the destination,
			 * carrying the same secrets as the vault and none of its encryption,
			 * after the application had been told nobody is present.
			 *
			 * The rename is the moment the file becomes real, so this is the last
			 * place the answer can still be no. The temp goes with it: it holds the
			 * same plaintext, and it exists only because the destination is not
			 * safe to write directly.
			 */
			// A lock is not a disk problem, and telling somebody their drive would
			// not take the file when what actually happened is that their vault
			// locked sends them to fix the wrong thing — so this is thrown from
			// outside the write's own catch, where it cannot be mistaken for one.
			if (!vault.isUnlocked()) {
				await rm(temp, { force: true }).catch(() => undefined);
				throw new VaultLockedError();
			}

			/*
			 * **And that it is still the same account.**
			 *
			 * The lock is re-checked here and the account's identity was not, so
			 * only half the race was closed. The write is the wait — slow on the
			 * drives people export to — and an account can be removed, or have its
			 * authenticator replaced, while it runs. The rename then published a
			 * plaintext maFile holding secrets the vault no longer has, and told the
			 * user it had saved their account.
			 *
			 * Removed is the worse half: it puts the secrets somebody just chose to
			 * be rid of into a fresh unencrypted file at a path of their choosing.
			 * Replaced is quieter and lasts longer — a backup that silently holds
			 * the previous authenticator, which Steam has already stopped accepting,
			 * discovered at the one moment it is ever used.
			 *
			 * Compared on the secrets themselves rather than on presence, because
			 * "still in the vault" is true of a re-enrolled account that shares
			 * nothing with the one this file describes.
			 */
			const stillThere = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
			if (!stillThere || fingerprint(stillThere) !== exported) {
				await rm(temp, { force: true }).catch(() => undefined);
				throw new Error(
					!stillThere
						? 'that account was removed while it was being exported, so nothing was written.'
						: "that account's authenticator was replaced while it was being exported, so " +
								'nothing was written. Export it again to get the current one.'
				);
			}
		}

		/*
		 * Whether the destination was already there, read before the rename.
		 *
		 * It decides what a lock *during* the rename is allowed to do about it —
		 * see below. `access` rather than a stat: only existence matters, and this
		 * is a question about the path, not about its contents.
		 */
		/*
		 * **The previous file is set aside, not merely noted.**
		 *
		 * An earlier version recorded whether the destination existed and, if it
		 * did, left the replacement in place when a lock landed during the rename —
		 * on the reasoning that deleting would destroy a backup the user had before
		 * they pressed anything.
		 *
		 * That reasoning had a hole, and it produced the worst available outcome:
		 * the old backup was gone, freshly exported plaintext was sitting at that
		 * path, and the user was told the export had failed because the vault
		 * locked. Every part of that is wrong at once — a destroyed file, a new
		 * exposure, and a message saying neither happened.
		 *
		 * Moving it aside first makes the rename undoable, so the lock can be
		 * honoured exactly: the new file goes, the old one comes back, and
		 * "nothing was replaced" is true. The same set-aside-then-restore the vault
		 * writer has always used, for the same reason.
		 */
		const kept = `${destination}.${randomUUID()}.prev`;
		const replacing = await rename(destination, kept)
			.then(() => true)
			.catch(() => false);

		try {
			await rename(temp, destination);
		} catch {
			// Put back whatever was there before saying the export failed.
			if (replacing) {
				await rename(kept, destination).catch(() => undefined);
			}
			await giveUp();
		}

		/*
		 * **The rename is the commit, and it is not instant.**
		 *
		 * The check above covers everything up to it. The rename itself is a
		 * filesystem round trip — on the removable and network drives people
		 * actually export to, a slow one — and a lock landing inside it still
		 * published the plaintext maFile, then answered `saved`.
		 *
		 * There is no way to make a rename part of the same transaction as a lock,
		 * so this undoes it instead, and only where undoing is honest:
		 *
		 *  - **Nothing was there before.** This export created the file, so
		 *    removing it restores the directory exactly as it was, and the lock
		 *    means nobody is present to have wanted it.
		 *  - **Something was there.** The rename has already replaced it, and
		 *    deleting now would destroy a backup the user had before they pressed
		 *    anything — a worse outcome than a plaintext file for the same account
		 *    that already existed at that path a second ago, which is no new
		 *    exposure at all. It stays, and the refusal still says the vault
		 *    locked.
		 */
		if (!vault.isUnlocked()) {
			// Undone completely: the export this lock cancelled leaves the directory
			// exactly as it found it, whether or not something was already there.
			await rm(destination, { force: true }).catch(() => undefined);
			if (replacing) {
				await rename(kept, destination).catch(() => undefined);
			}
			throw new VaultLockedError();
		}

		/*
		 * The export stands, so the copy it replaced is no longer needed. Removed
		 * rather than left beside it: a stray `.prev` full of the same secrets is
		 * a second plaintext file nobody asked for.
		 *
		 * **And when it cannot be removed, the caller is told.** A swallowed
		 * failure here answered `saved` while a second plaintext file sat in the
		 * user's folder — the previous authenticator's secrets, at a path only the
		 * OS dialog knows, with nothing anywhere mentioning it. A scanner holding
		 * the file, a network share dropping, a removable drive pulled: all
		 * ordinary, all silent.
		 */
		let staleCopy = false;
		if (replacing) {
			staleCopy = await rm(kept, { force: true }).then(
				() => false,
				() => true
			);
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

		return { state: 'saved' as const, fileName: suggested, ...(staleCopy ? { staleCopy } : {}) };
	});
}
