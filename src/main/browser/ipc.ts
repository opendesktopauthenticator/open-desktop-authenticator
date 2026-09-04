import { CHANNELS } from '../../shared/channels';
import type { BrowserRoute } from '../../shared/ipc';
import { registerHandler } from '../ipc/router';
import { AccessTokenError } from '../steam/access-token';
import { BrowserSignInRequired, type AccountBrowsers } from './window';

/**
 * The handler behind "open a browser for this account".
 *
 * Thin on purpose. Two refusals, one state, and nothing else — every decision
 * about sessions, routing and windows lives in `window.ts`, and every decision
 * about credentials lives in the vault. What is left here is the order those
 * have to happen in, which is the part with security consequences:
 *
 *  1. The vault must be unlocked. A locked vault has no accounts to speak of
 *     and no consent behind the request.
 *  2. The requested route must still satisfy the vault's proxy policy. A
 *     missing session must not turn a route the policy forbids into a password
 *     prompt for an action that still cannot succeed.
 *  3. The account must have a usable session. Opening a window that lands on a
 *     login page would be worse than refusing, because the user would type a
 *     Steam password into a window this application drew.
 *  4. The token is minted **through the account's own routing**, so the request
 *     that fetches it leaves by the same address the browsing will.
 *
 * ## "Sign in" is a state, not an error
 *
 * Three different things mean the same thing to a user: no saved session, a
 * refresh token Steam has finished with, and a cookie Steam declined. All three
 * come back as `signInRequired` rather than as a throw, so the screen can offer
 * the sign-in instead of printing a sentence about needing one — the same
 * distinction `confirmationsListResponse` already draws, for the same reason.
 * Everything else still throws.
 */

export interface BrowserAccount {
	accountName: string;
	/** Absent when the account has never been signed in, or the token expired. */
	refreshToken?: string | undefined;
	proxyUrl?: string | undefined;
}

export interface BrowserHandlerDeps {
	browsers: AccountBrowsers;
	/** The account as the vault knows it, or undefined if there is no such account. */
	account: (steamId64: string) => BrowserAccount | undefined;
	/**
	 * Mints a short-lived access token, routed the way this window will be.
	 *
	 * **`useProxy` is not decoration here.** The token used to be minted through
	 * the account's stored proxy whatever the user chose, which broke the choice
	 * in both directions. Picking _Direct_ because the proxy is rate-limited or
	 * dead still failed at the token, so the fallback could not fall back — the
	 * window simply never opened. And with a working proxy, the token arrived
	 * over the proxy while the browser it unlocked went out directly: two
	 * addresses for one sign-in, which is the exact correlation this comment used
	 * to say routing exists to avoid.
	 */
	mintToken: (steamId64: string, refreshToken: string, route: BrowserRoute) => Promise<string>;
	isUnlocked: () => boolean;
	/**
	 * Whether the vault demands that everything go through a proxy.
	 *
	 * Read here rather than trusted from the request, because the request is
	 * where the renderer's opinion arrives and this is the process that has to
	 * disagree with it.
	 */
	requireProxies: () => boolean;
	/** Opening a browser is user activity; the auto-lock clock should notice. */
	touch: () => void;
}

/**
 * What the user is told when `Require proxies` refuses a route.
 *
 * One string, shared by the browser and the sign-in, because the two arrive at
 * it by different paths and a user who met two different sentences for one
 * setting would reasonably think they were two different problems.
 */
export const DIRECT_REFUSED =
	'this vault is set to require proxies, so only the fully routed window can be opened. ' +
	'"Steam only" sends some sites straight out. Direct does not use this account’s proxy; it ' +
	'follows this machine’s network settings instead, including any system or company proxy. Turn off ' +
	'"Require proxies" in Settings, or use the routed button.';

/**
 * Is this route acceptable to a vault that requires proxies?
 *
 * **Only `proxy`.** "Steam only" is a proxied route in the sense that Steam
 * always goes through the proxy, and that is not what this setting says: it
 * sends a short list of third-party sites straight out from this machine, which
 * is a deliberate direct request, which is the thing being forbidden. Reading
 * the setting as "Steam is routed" rather than "everything is routed" would
 * make it mean something the switch does not say.
 *
 * The account still has to have a proxy. With none there is no route to take,
 * and opening it anyway would be the quiet fallback the setting rules out.
 */
export function routeSatisfiesStrictMode(
	route: BrowserRoute,
	proxyUrl: string | undefined
): boolean {
	return route === 'proxy' && proxyUrl !== undefined && proxyUrl !== '';
}

export class BrowserRequestError extends Error {}

export function registerBrowserHandlers(deps: BrowserHandlerDeps): void {
	registerHandler(CHANNELS.accountOpenBrowser, async ({ steamId64, route }) => {
		if (!deps.isUnlocked()) {
			throw new BrowserRequestError('unlock the vault first');
		}

		const account = deps.account(steamId64);
		if (account === undefined) {
			throw new BrowserRequestError('that account is not in this vault');
		}

		/*
		 * **Before both the sign-in state and the token mint.**
		 *
		 * `mintToken` on a `direct` route goes to Steam over this machine's own
		 * network, so refusing after it would only report a leak that had already
		 * happened. The missing-session answer has to come after this guard too:
		 * it makes the renderer offer a password form, but signing in cannot make a
		 * forbidden route acceptable. Asking for credentials for an action that is
		 * guaranteed to be refused is not an actionable state.
		 *
		 * An account with no proxy is refused too, and deliberately: with this on
		 * there is no route for it, and opening it "as best we can" is the exact
		 * quiet fallback the setting rules out. The message names the two ways
		 * out rather than leaving the user at a dead end.
		 */
		if (deps.requireProxies() && !routeSatisfiesStrictMode(route, account.proxyUrl)) {
			throw new BrowserRequestError(DIRECT_REFUSED);
		}

		if (account.refreshToken === undefined || account.refreshToken === '') {
			return {
				signInRequired: true,
				reason: `There is no saved Steam session for ${account.accountName}.`
			};
		}

		/*
		 * Read before the token is minted, and checked again after.
		 *
		 * `isUnlocked` above is a fact about the moment the button was pressed.
		 * Minting is a Steam round trip with a thirty-second timeout behind it,
		 * and the idle timer, a suspend or a lid closing can all land inside it —
		 * so that check answered a question that had since changed, and a browser
		 * signed in to a Steam account opened for a vault that was locked.
		 *
		 * The counter, not just a second `isUnlocked()`: `AccountBrowsers` reads
		 * the same one after every await inside the open, so a lock anywhere
		 * between this line and the window appearing is caught exactly once and
		 * in one place.
		 */
		const since = deps.browsers.generationNow();
		/*
		 * **And the account's own epoch, for the same reason and at the same
		 * moment.**
		 *
		 * The lock counter was captured here and the routing one was not, so
		 * `open` fell back to reading the epoch fresh — after the mint. Removing
		 * the account, or changing its proxy, while Steam was answering bumped
		 * that epoch and the default then compared the new value with itself: the
		 * check agreed, and a signed-in window opened on routing the user had
		 * just replaced, or for an account that had been deleted.
		 */
		const sinceEpoch = deps.browsers.epochNow(steamId64);

		/**
		 * **Everything that may have changed while Steam was answering — on every
		 * way out of the mint, not only the successful one.**
		 *
		 * `mintToken` is a Steam round trip with a thirty-second timeout behind it.
		 * Inside that window the vault can lock, `Require proxies` can be switched
		 * on, the account's routing can change, and the account itself can be
		 * removed. The checks for all of that sat after the mint on the success
		 * path, and the `needsSignIn` branch returned above them.
		 *
		 * So removing an account mid-mint still answered `signInRequired`, and that
		 * answer is not inert: it is what makes the renderer offer a sign-in — for
		 * an account the vault no longer holds, and on a screen the user may have
		 * left. A failure to mint is not a reason to skip the questions; it is the
		 * path least likely to have been thought about.
		 *
		 * Throws rather than returning, because every one of these is a refusal
		 * with a sentence the user can act on, and `signInRequired` is not one of
		 * them.
		 */
		const revalidate = (): void => {
			if (deps.requireProxies() && !routeSatisfiesStrictMode(route, account.proxyUrl)) {
				throw new BrowserRequestError(DIRECT_REFUSED);
			}
			if (!deps.isUnlocked()) {
				throw new BrowserRequestError('unlock the vault first');
			}
		};

		/**
		 * The epoch, checked only where nothing else will.
		 *
		 * On the success path `open` is handed `sinceEpoch` and owns this decision
		 * — deliberately, so a routing change during the open itself is caught in
		 * the one place that can also close the window it has already built.
		 * Checking eagerly here would take that decision away from it.
		 *
		 * The `signInRequired` path never reaches `open`, so the question is asked
		 * nowhere at all. It is the reason removing an account mid-mint still came
		 * back as "sign in again" for an account that no longer existed.
		 */
		const stillTheSameAccount = (): void => {
			if (deps.browsers.epochNow(steamId64) !== sinceEpoch) {
				throw new BrowserRequestError(
					'this account changed while it was opening, so nothing was opened'
				);
			}
		};

		let accessToken: string;
		try {
			accessToken = await deps.mintToken(steamId64, account.refreshToken, route);
		} catch (err) {
			// A refresh token Steam has finished with. Common after months away,
			// and indistinguishable to the user from never having signed in — so it
			// gets the same answer rather than a raw error about a token.
			if (err instanceof AccessTokenError && err.needsSignIn) {
				revalidate();
				stillTheSameAccount();
				return { signInRequired: true, reason: err.message };
			}
			throw err;
		}

		revalidate();

		try {
			await deps.browsers.open(
				{
					steamId64,
					accountName: account.accountName,
					proxyUrl: account.proxyUrl,
					// The renderer's choice, passed straight through. It cannot supply an
					// address — only say whether to use the one already stored here.
					route,
					accessToken
				},
				// Anything that locked the vault while the token was being minted has
				// already moved this on, and the open refuses rather than appearing.
				since,
				// Anything that changed this account's routing, or removed it, has
				// moved this on.
				sinceEpoch
			);
		} catch (err) {
			// Steam declined the cookie. The window has already closed itself and
			// wiped its session; what is left is to tell the user the one thing that
			// helps, which is not "it failed".
			if (err instanceof BrowserSignInRequired) {
				/*
				 * **The same questions as the mint's failure path, for the same
				 * reason.** `open` is a window being built, a session being wiped and
				 * a cookie being refused — seconds during which the vault can lock,
				 * `Require proxies` can be switched on, and the account can be removed
				 * or rerouted. The mint's branch was fixed and this one was not, so the
				 * renderer was still offered a sign-in for an account the vault no
				 * longer holds.
				 */
				revalidate();
				stillTheSameAccount();
				return { signInRequired: true, reason: err.message };
			}
			throw err;
		}

		// After the window is up, not before. Touching first would extend the
		// auto-lock on a request that then failed — and a sign-in state is one of
		// those: nothing opened, so nothing here counts as the user being present.
		deps.touch();
		return { signInRequired: false };
	});
}
