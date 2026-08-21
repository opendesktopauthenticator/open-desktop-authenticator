import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { VaultLockedError, type VaultService } from '../vault/service';
import type { TransferService } from './transfer';

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
export function registerTransferHandlers(transfer: TransferService, vault: VaultService): void {
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

	registerHandler(
		CHANNELS.transferAuthenticate,
		async ({ accountName, password, steamGuardCode, proxyUrl }) => {
			requireUnlocked();
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
		return transfer.completeTransfer(smsCode);
	});

	/** Storage only. Steam is not asked again — it could not be. */
	registerHandler(CHANNELS.transferRetryPersist, async () => {
		requireUnlocked();
		return transfer.retryPersist();
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
