import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { ConfirmationsError, type ConfirmationsService } from './service';
import { VaultLockedError, type VaultService } from '../vault/service';
import { DIRECT_REFUSED } from '../browser/ipc';
import type { ActivityLog } from './activity';
import type { SteamClock } from '../steam/clock';

/**
 * The confirmations IPC surface (§12 F5, §24.3).
 *
 * Thin on purpose. Every rule that matters — S16, the tag binding, resolving an
 * id to a nonce, what a failure means — lives below this, where it is testable
 * without an Electron process. What is added here is the one thing only this
 * layer knows: that fetching and acting are the user being present.
 */

export function registerConfirmationHandlers(
	confirmations: ConfirmationsService,
	vault: VaultService,
	activity: ActivityLog,
	clock?: SteamClock
): void {
	registerHandler(CHANNELS.confirmationsList, async ({ steamId64 }) => {
		// Opening the confirmations screen is deliberate interaction, so it defers
		// the idle lock. Codes do not do this — they are polled every second and
		// would keep the vault open forever — but a fetch happens because somebody
		// asked for it.
		vault.touch();

		// Confirmation HMACs use the same Steam-corrected clock the codes do.
		await clock?.ensureSynced();

		try {
			const listing = await confirmations.list(steamId64);
			return { ...listing, signInRequired: false };
		} catch (err) {
			// "You need to sign in" is not a failure to report — it is a step the
			// user can take, so it comes back as a state the screen can act on.
			// Everything else still throws.
			if (err instanceof ConfirmationsError && err.needsSignIn) {
				// `unreadable: 0` because nothing was read at all. The screen renders
				// the sign-in prompt instead of a list, so a count here would describe
				// a list that is not on screen.
				return { confirmations: [], signInRequired: true, reason: err.message, unreadable: 0 };
			}
			throw err;
		}
	});

	registerHandler(CHANNELS.activityList, () => {
		// No `vault.touch()`: this is polled to drive the alert badge, so treating it
		// as interaction would hold the vault open forever.
		//
		// **But a locked vault gets nothing.** The log deliberately survives locking
		// — it is how "what happened while I was away" gets answered — and that made
		// it the one thing in this application readable without the passphrase. It
		// names accounts and describes their trades, so answering while locked is a
		// smaller lock than the one the user thinks they set.
		if (!vault.isUnlocked()) {
			return { entries: [], urgent: false, seq: 0 };
		}
		const entries = activity.all();
		// Read with the entries, so the pair describes one moment.
		return { entries, urgent: activity.hasUrgent(), seq: activity.watermark() };
	});

	registerHandler(CHANNELS.activityAcknowledge, ({ upTo }) => {
		// Refused rather than ignored while locked. Acknowledging is destructive in
		// the quietest possible way: it clears the alert that says an account-recovery
		// confirmation was held back, and clearing it before the owner has unlocked
		// means the warning is gone before anybody entitled to see it ever did.
		if (!vault.isUnlocked()) {
			throw new VaultLockedError();
		}
		activity.acknowledge(upTo);
		// Reported back rather than assumed by the caller: an urgent entry recorded
		// after the snapshot the user read is deliberately outside this watermark,
		// and it must keep its badge.
		return { ok: true as const, urgent: activity.hasUrgent() };
	});

	registerHandler(CHANNELS.confirmationsAct, async ({ steamId64, action, ids }) => {
		vault.touch();
		await clock?.ensureSynced();
		await confirmations.act(steamId64, action, ids);
		return { ok: true as const };
	});

	registerHandler(CHANNELS.steamSignIn, async ({ steamId64, password, route }) => {
		vault.touch();
		/*
		 * **The same refusal the browser gives, on the request that carries a
		 * password.**
		 *
		 * Not reachable through the UI today: the browser refuses a `direct`
		 * route before it can ever answer `signInRequired`, so the screen that
		 * sends this is never reached with one. It is guarded anyway because the
		 * channel is reachable without that screen, and because of what is in the
		 * request — a sign-in sent unrouted from a vault that forbids unrouted
		 * traffic puts the account's password on this machine's own connection.
		 */
		if (route === 'direct' && vault.settings().requireProxies) {
			throw new ConfirmationsError(DIRECT_REFUSED);
		}
		// The password is a parameter here and nothing more: it is not returned, not
		// cached, and not written anywhere. What survives this call is the refresh
		// token the service stores in the vault.
		try {
			await confirmations.signIn(steamId64, password, route);
			return { ok: true as const };
		} catch (err) {
			// **Only a sign-in failure becomes a value.** Anything else — a bug here,
			// a locked vault — still throws, because turning every error into
			// "sign-in failed" would hide faults behind a message about passwords.
			if (err instanceof ConfirmationsError) {
				return { ok: false as const, retryable: !err.permanent, reason: err.message };
			}
			throw err;
		}
	});
}
