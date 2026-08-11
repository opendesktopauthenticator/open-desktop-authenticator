import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { ConfirmationsError, type ConfirmationsService } from './service';
import type { VaultService } from '../vault/service';
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
			return { confirmations: await confirmations.list(steamId64), signInRequired: false };
		} catch (err) {
			// "You need to sign in" is not a failure to report — it is a step the
			// user can take, so it comes back as a state the screen can act on.
			// Everything else still throws.
			if (err instanceof ConfirmationsError && err.needsSignIn) {
				return { confirmations: [], signInRequired: true, reason: err.message };
			}
			throw err;
		}
	});

	registerHandler(CHANNELS.activityList, () => {
		// No `vault.touch()`: this is polled to drive the alert badge, so treating it
		// as interaction would hold the vault open forever.
		const entries = activity.all();
		return { entries, urgent: activity.hasUrgent() };
	});

	registerHandler(CHANNELS.activityAcknowledge, () => {
		activity.acknowledge();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.confirmationsAct, async ({ steamId64, action, ids }) => {
		vault.touch();
		await clock?.ensureSynced();
		await confirmations.act(steamId64, action, ids);
		return { ok: true as const };
	});

	registerHandler(CHANNELS.steamSignIn, async ({ steamId64, password }) => {
		vault.touch();
		// The password is a parameter here and nothing more: it is not returned, not
		// cached, and not written anywhere. What survives this call is the refresh
		// token the service stores in the vault.
		await confirmations.signIn(steamId64, password);
		return { ok: true as const };
	});
}
