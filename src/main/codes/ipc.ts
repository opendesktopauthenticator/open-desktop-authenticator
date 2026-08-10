import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import type { ClipboardCourier } from './clipboard';
import type { CodeService } from './service';
import type { VaultService } from '../vault/service';
import type { SteamClock } from '../steam/clock';

/**
 * The Steam Guard code IPC surface (§12 F4, §24.3).
 *
 * Copying happens **in the main process**, not by handing the renderer a string
 * to paste into `navigator.clipboard`. Two reasons:
 *
 *  - the auto-clear timer has to outlive the page. The renderer is reloaded
 *    whenever the vault locks, and a timer living there would die with it,
 *    leaving the code on the clipboard permanently;
 *  - a sandboxed renderer's clipboard access is subject to permissions we deny
 *    wholesale, so routing through main is also the only reliable path.
 */

export function registerCodeHandlers(
	codes: CodeService,
	vault: VaultService,
	clipboard: ClipboardCourier,
	clock?: SteamClock
): void {
	registerHandler(CHANNELS.codesList, async () => {
		// Codes are useless if they are signed against the wrong clock. Await the
		// sync when we have never checked — a fire-and-forget would show one wrong
		// window of codes before the answer landed, which is exactly when someone
		// is staring at the screen trying to log in.
		await clock?.ensureSynced();

		const { codes: generated, failures } = codes.all();
		return {
			codes: generated,
			failures,
			clockUnverified: codes.clockUnverified()
		};
	});

	registerHandler(CHANNELS.codeCopy, async ({ steamId64 }) => {
		await clock?.ensureSynced();

		const generated = codes.for(steamId64);

		// The user's own setting, not a constant: someone who pastes slowly should
		// not have the clipboard emptied underneath them.
		//
		// `settings()` rather than `read()`: the latter deep-clones every secret in
		// the vault, which is a great deal of secret-bearing garbage to create in
		// order to read one integer.
		const seconds = vault.settings().clipboardClearSeconds;
		clipboard.copy(generated.code, seconds * 1000);

		// Copying is interaction. Without this the vault could idle-lock while the
		// user is actively reading codes off the screen.
		vault.touch();

		return { code: generated.code, clipboardClearsInSeconds: seconds };
	});
}
