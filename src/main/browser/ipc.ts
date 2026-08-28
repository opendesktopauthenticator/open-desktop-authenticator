import { CHANNELS } from '../../shared/channels';
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
 *  2. The account must have a usable session. Opening a window that lands on a
 *     login page would be worse than refusing, because the user would type a
 *     Steam password into a window this application drew.
 *  3. The token is minted **through the account's own routing**, so the request
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
	/** Mints a short-lived access token, routed like the account. */
	mintToken: (steamId64: string, refreshToken: string) => Promise<string>;
	isUnlocked: () => boolean;
	/** Opening a browser is user activity; the auto-lock clock should notice. */
	touch: () => void;
}

export class BrowserRequestError extends Error {}

export function registerBrowserHandlers(deps: BrowserHandlerDeps): void {
	registerHandler(CHANNELS.accountOpenBrowser, async ({ steamId64, useProxy }) => {
		if (!deps.isUnlocked()) {
			throw new BrowserRequestError('unlock the vault first');
		}

		const account = deps.account(steamId64);
		if (account === undefined) {
			throw new BrowserRequestError('that account is not in this vault');
		}

		if (account.refreshToken === undefined || account.refreshToken === '') {
			return {
				signInRequired: true,
				reason: `There is no saved Steam session for ${account.accountName}.`
			};
		}

		let accessToken: string;
		try {
			accessToken = await deps.mintToken(steamId64, account.refreshToken);
		} catch (err) {
			// A refresh token Steam has finished with. Common after months away,
			// and indistinguishable to the user from never having signed in — so it
			// gets the same answer rather than a raw error about a token.
			if (err instanceof AccessTokenError && err.needsSignIn) {
				return { signInRequired: true, reason: err.message };
			}
			throw err;
		}

		try {
			await deps.browsers.open({
				steamId64,
				accountName: account.accountName,
				proxyUrl: account.proxyUrl,
				// The renderer's choice, passed straight through. It cannot supply an
				// address — only say whether to use the one already stored here.
				useProxy,
				accessToken
			});
		} catch (err) {
			// Steam declined the cookie. The window has already closed itself and
			// wiped its session; what is left is to tell the user the one thing that
			// helps, which is not "it failed".
			if (err instanceof BrowserSignInRequired) {
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
