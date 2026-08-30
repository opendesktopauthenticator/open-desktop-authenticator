import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { RevocationCeremony } from '../vault/revocation-ceremony';
import { VaultLockedError, type VaultService } from '../vault/service';
import { TransferError, type TransferService } from './transfer';
import { PROXY_REQUIRED } from '../net/egress';

/**
 * IPC for moving an authenticator off the Steam mobile app.
 *
 * ## What crosses, and what does not
 *
 * Inbound: an account name, a password, and the Guard code the user read off
 * the phone. Outbound: which account was authenticated. That is the whole
 * surface. By the time `authenticate` answers, the main process is holding a
 * MobileApp refresh token and an access token for that account — credentials as
 * real as the password that produced them — and none of it crosses IPC, is
 * logged, or appears in an error.
 *
 * ## Why the vault has to be unlocked to sign in
 *
 * Nothing is written yet, so on the face of it the lock is irrelevant here. It
 * is checked anyway, for the same reason enrolment checks it: the flow this
 * begins ends with Steam rotating an authenticator and handing back secrets
 * that exist nowhere else. Finding out the vault is locked at *that* moment is
 * the one failure this feature must not have, and the cheapest place to find
 * out is before the user has spent an SMS.
 */
export function registerTransferHandlers(
	transfer: TransferService,
	vault: VaultService,
	/**
	 * The show-then-confirm ceremony, so a completed transfer counts as a show.
	 *
	 * **The screen displayed the code and nothing recorded that it had.** A
	 * transfer stores the account as `pendingRevocationBackup` on purpose, and
	 * the completion screen ends with "I have written the recovery code down"
	 * above a Done button — but Done only closed the screen. The acknowledgement
	 * went nowhere, the account stayed pending, and the home screen went on
	 * saying the code had never been backed up, about a code the user had just
	 * been shown and had just confirmed writing down.
	 *
	 * The fix is not to weaken the ceremony. `revocationConfirmBackup` refuses
	 * unless the code was revealed, which is exactly right — one IPC call must
	 * not clear the warning for an account whose code nobody ever saw. It *was*
	 * seen: on this screen, in this session, in the same breath as being
	 * generated. Recording that here is what makes the confirm honest rather
	 * than a second ceremony asking the user to prove something they have
	 * already done.
	 */
	ceremony: RevocationCeremony = new RevocationCeremony()
): void {
	/**
	 * Unlocked, and counted as activity.
	 *
	 * A transfer has a long pause in the middle while the user waits for a text
	 * and reads it off a phone. None of that is something the idle timer can
	 * observe, and a vault that locks partway through would strand a rotation
	 * Steam has already performed.
	 */
	const requireUnlocked = (): void => {
		if (!vault.isUnlocked()) {
			throw new VaultLockedError();
		}
		vault.touch();
	};

	/**
	 * The code is on its way to a screen, so the ceremony has seen it shown.
	 *
	 * Recorded *with* the code, exactly as the reveal handler does it, so a
	 * confirm cannot ride on this for some other code stored later.
	 */
	const revealed = <T extends { steamId64: string; revocationCode: string }>(result: T): T => {
		ceremony.recordReveal(result.steamId64, result.revocationCode);
		return result;
	};

	registerHandler(
		CHANNELS.transferAuthenticate,
		async ({ accountName, password, steamGuardCode, proxyUrl }) => {
			requireUnlocked();
			/*
			 * The same refusal enrolment gets, for a heavier payload: this call
			 * carries a password *and* a Steam Guard code. Like enrolment it goes
			 * through `steam-session` rather than a transport, so the factory's
			 * check never sees it — and like enrolment there is no stored account
			 * yet, so the proxy field on the form is the only route there is.
			 */
			if (vault.settings().requireProxies && (proxyUrl === undefined || proxyUrl === '')) {
				throw new TransferError(PROXY_REQUIRED);
			}
			return transfer.authenticate(accountName, password, steamGuardCode, proxyUrl);
		}
	);

	/**
	 * Sends a text to the phone on the account.
	 *
	 * Still reversible — no authenticator changes — but it is the first call that
	 * costs the user something they cannot take back, in the form of a message
	 * and Steam's rate limit. The vault check is repeated rather than assumed
	 * from the sign-in, because minutes of reading warnings may have passed.
	 */
	registerHandler(CHANNELS.transferStartChallenge, async () => {
		requireUnlocked();
		return transfer.startChallenge();
	});

	/**
	 * The point of no return.
	 *
	 * Everything before this can be walked away from. This cannot: when it
	 * answers, the authenticator on the user's phone has already been replaced.
	 */
	registerHandler(CHANNELS.transferComplete, async ({ smsCode }) => {
		requireUnlocked();
		return revealed(await transfer.completeTransfer(smsCode));
	});

	/** Storage only. Steam is not asked again — it could not be. */
	registerHandler(CHANNELS.transferRetryPersist, async () => {
		requireUnlocked();
		return revealed(await transfer.retryPersist());
	});

	registerHandler(CHANNELS.transferStatus, () => {
		// **Nothing while locked.** The lock handler deliberately keeps a transfer
		// that is holding replacement material, which is right — but it left this
		// channel answering with the account name, the SteamID and whether secrets
		// were outstanding, to a renderer that has proved nothing. The activity log
		// was gated for exactly this reason a moment ago; this surface is newer and
		// was missed.
		//
		// Costs the recovery flow nothing: every caller reads it after unlocking.
		if (!vault.isUnlocked()) {
			return Promise.resolve({});
		}
		const current = transfer.current();
		if (!current) {
			return Promise.resolve({});
		}
		// `live()` never expires a transfer while secrets are held, so whenever
		// `awaiting` is set there is a `current` to report it against.
		const awaiting = transfer.awaiting();
		return Promise.resolve(awaiting ? { transfer: current, awaiting } : { transfer: current });
	});

	/**
	 * Abandoning is always allowed here, and will not be later.
	 *
	 * Until the SMS code is submitted, nothing on the Steam account has changed
	 * and dropping the session costs the user only a sign-in. Once Steam has been
	 * asked to rotate the authenticator there is no equivalent — which is why
	 * that step gets its own channel rather than sharing this one.
	 */
	registerHandler(CHANNELS.transferCancel, () => {
		// **Gated like the status it discharges.** Cancelling clears the
		// unanswered-submission warning, and status is deliberately silent while
		// locked — so without this, code in a locked renderer could erase the one
		// record telling the owner to go and check their phone, before they ever
		// unlocked to see it.
		if (!vault.isUnlocked()) {
			throw new VaultLockedError();
		}
		transfer.cancel();
		return Promise.resolve({});
	});
}
