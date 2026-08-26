import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import type { AccountBrowsers } from './window';

/**
 * The handler behind "open a browser for this account".
 *
 * Thin on purpose. It holds three refusals and nothing else — every decision
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
	registerHandler(CHANNELS.accountOpenBrowser, async ({ steamId64 }) => {
		if (!deps.isUnlocked()) {
			throw new BrowserRequestError('unlock the vault first');
		}

		const account = deps.account(steamId64);
		if (account === undefined) {
			throw new BrowserRequestError('that account is not in this vault');
		}

		if (account.refreshToken === undefined || account.refreshToken === '') {
			// Named precisely, because the fix differs from every other failure
			// here: this one is "sign in", not "try again".
			throw new BrowserRequestError(
				`${account.accountName} has no saved Steam session. Sign in to that account first.`
			);
		}

		const accessToken = await deps.mintToken(steamId64, account.refreshToken);

		await deps.browsers.open({
			steamId64,
			accountName: account.accountName,
			proxyUrl: account.proxyUrl,
			accessToken
		});

		// After the window is up, not before. Touching first would extend the
		// auto-lock on a request that then failed.
		deps.touch();
		return { ok: true as const };
	});
}
