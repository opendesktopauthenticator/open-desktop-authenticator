import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';

/**
 * Where a clicked notification goes.
 *
 * **A push alone cannot do this**, and the reason is not the one it looks like.
 * Closing the window to the tray destroys nothing — that path is
 * `preventDefault()` plus `hide()`, so the `webContents`, its document and its
 * listeners all survive and a `webContents.send` is delivered normally. What is
 * not stable is the document behind it: locking the vault **reloads** the
 * window, unconditionally and with no visibility check. A click arriving in
 * that window lands on a renderer with no subscriber, or on the unlock screen,
 * and the intent disappears with nothing reporting that it did.
 *
 * So the intent is remembered here and the renderer collects it once it has an
 * account list to navigate within, with the push as the fast path for the
 * ordinary case.
 */
export class ToastClickRouter {
	private readonly reveal: () => void;
	private readonly push: (steamId64: string) => void;

	/**
	 * The account a click asked for, until a renderer takes it.
	 *
	 * One slot, not a queue. Two clicks before anybody looks at the window mean
	 * the person wants the second one; a backlog of navigations nobody asked for
	 * is worse than forgetting the first.
	 */
	private pending: string | undefined;

	constructor(options: { reveal: () => void; push: (steamId64: string) => void }) {
		this.reveal = options.reveal;
		this.push = options.push;
	}

	/**
	 * A toast for this account was clicked.
	 *
	 * Remembers, reveals and pushes — **all three, always**. There is deliberately
	 * no "was the window hidden?" branch: a window can be hidden *and* have been
	 * reloaded by a lock, so the two paths have to be able to run together.
	 */
	activate(steamId64: string): void {
		this.pending = steamId64;
		this.reveal();
		this.push(steamId64);
	}

	/**
	 * Look at the click the renderer was not there to receive.
	 *
	 * **Reading no longer clears it.** It did, and the renderer then navigated —
	 * or failed to. `openConfirmationsFor` returns false when the account is not
	 * in the list yet, which is precisely the case this slow path exists for: a
	 * click landing after unlock and before `listAccounts` has answered. The
	 * intent was already gone from main by then, so a security notification opened
	 * the application and never opened Confirmations, with nothing anywhere
	 * reporting that it had not.
	 *
	 * The push path had this right from the start — it gates its clear on that
	 * same boolean — and the path that exists for the harder case did not.
	 */
	peek(): { steamId64?: string } {
		return this.pending === undefined ? {} : { steamId64: this.pending };
	}

	/**
	 * The renderer navigated. Forget it.
	 *
	 * Matched against what is pending rather than clearing whatever is there: a
	 * second click arriving between the peek and the acknowledgement is a newer
	 * intention, and it must not be swallowed by an acknowledgement of the first.
	 */
	acknowledge(steamId64: string): void {
		if (this.pending === steamId64) {
			this.pending = undefined;
		}
	}

	/**
	 * Forget an intent nobody collected. Called on lock.
	 *
	 * A click from before a lock is stale by the time somebody unlocks: they came
	 * back and typed a passphrase, which is a new intention, and navigating them
	 * somewhere they asked for an hour ago is not helpful.
	 */
	forget(): void {
		this.pending = undefined;
	}
}

/**
 * Registered like every other handler group, so the registration test can see
 * it. A channel in the contract with nothing answering it fails at runtime, in
 * a packaged build, on a screen somebody is looking at.
 */
export function registerToastClickHandlers(router: ToastClickRouter): void {
	registerHandler(CHANNELS.takePendingConfirmations, ({ acknowledged }) => {
		if (acknowledged !== undefined) {
			router.acknowledge(acknowledged);
			return {};
		}
		return router.peek();
	});
}
