import { createHash } from 'node:crypto';

/**
 * Which accounts have actually had their revocation code shown, this unlock.
 *
 * §11 S12's ceremony is *show the code, then confirm you wrote it down*. The UI
 * presents it that way, but the UI is not what enforces it — the renderer is
 * untrusted, and a `confirmRevocationBackup` call on its own would clear the
 * warning for an account whose code nobody ever saw. Marking a backup done that
 * did not happen is worse than nagging, because it is the one warning standing
 * between a user and an unrecoverable account.
 *
 * Reset on lock: an unlock is a new sitting, and the ceremony is per sitting.
 *
 * ## Why this is its own file
 *
 * It used to live in `vault/ipc.ts`, which is where the handlers that use it
 * are. That was fine until a *second* place had to record a reveal: finishing
 * an authenticator transfer shows the recovery code, so the transfer handlers
 * have to say so or the confirm afterwards is refused. Importing it from there
 * dragged the whole vault IPC surface — and, through it, Electron's
 * `BrowserWindow` and `dialog` — into a module that needs a `Map` and a hash.
 *
 * A shared rule with two callers belongs to neither of them.
 */
export class RevocationCeremony {
	/**
	 * SteamID to a digest of the code that was shown for it.
	 *
	 * **Not a `Set` of SteamIDs**, which is what this was. The ceremony is about a
	 * *code*, and identity alone cannot express that: reveal code A, import a
	 * maFile carrying a different code B for the same account, and confirming
	 * marked B written down on the strength of having shown A. `mergeAccount` gets
	 * this right — it clears `revocationBackedUpAt` when the code changes, with a
	 * comment saying the ceremony is owed again — so the two halves actively
	 * disagreed, and the half that wins is the one that silences the warning.
	 *
	 * A digest rather than the code, because this outlives the handler that read
	 * it and a second plaintext copy of an unrecoverable secret earns nothing: the
	 * only question ever asked of it is whether it equals the stored code.
	 */
	private readonly revealed = new Map<string, string>();

	recordReveal(steamId64: string, revocationCode: string): void {
		this.revealed.set(steamId64, digest(revocationCode));
	}

	/** Whether *this* code is the one that was shown for this account. */
	hasRevealed(steamId64: string, revocationCode: string): boolean {
		const shown = this.revealed.get(steamId64);
		return shown !== undefined && shown === digest(revocationCode);
	}

	forget(): void {
		this.revealed.clear();
	}
}

function digest(revocationCode: string): string {
	return createHash('sha256').update(revocationCode, 'utf8').digest('hex');
}
