import { z } from 'zod';
import { isUsableMobileToken, jwtExpiry } from '../steam-jwt';
import type { SteamTransport } from '../confirmations/client';

/**
 * Turning a stored refresh token into a usable web session (§12 F5).
 *
 * A refresh token lasts months; the access token it mints lasts hours. Only the
 * long-lived one is stored, and only if it is MobileApp-scoped — a web-scoped
 * token produces a session that looks fine and cannot drive confirmations
 * (F-13), which is why import refuses to keep one.
 *
 * This is the whole reason an imported maFile carrying a live session can start
 * fetching confirmations without ever asking for a password (§11 S8). Handling a
 * password we do not need is a risk taken for nothing.
 *
 * Goes through the account's transport like everything else, so it is routed and
 * subject to the same failure rules. Nothing here opens a socket.
 */

const ENDPOINT =
	'https://api.steampowered.com/IAuthenticationService/GenerateAccessTokenForApp/v1/';

const responseSchema = z.object({
	response: z.object({
		access_token: z.string().min(1)
	})
});

export class AccessTokenError extends Error {
	/** True when the refresh token itself is finished and a password login is needed. */
	readonly needsSignIn: boolean;

	constructor(message: string, needsSignIn = false) {
		super(message);
		this.name = 'AccessTokenError';
		this.needsSignIn = needsSignIn;
	}
}

/**
 * Mint a short-lived access token.
 *
 * @throws AccessTokenError with `needsSignIn` set when the stored token cannot
 * be used at all — expired, or scoped for the website rather than the app. That
 * distinction is what lets the UI say "sign in again" instead of "something went
 * wrong", which are very different instructions to a user.
 */
export async function mintAccessToken(
	transport: SteamTransport,
	steamId64: string,
	refreshToken: string,
	nowMs: number
): Promise<string> {
	// Checked before spending a request. An expired token is a dead credential and
	// Steam's answer to one is an opaque failure; saying so locally is both faster
	// and clearer.
	if (!isUsableMobileToken(refreshToken, nowMs)) {
		const expiry = jwtExpiry(refreshToken);
		throw new AccessTokenError(
			expiry && expiry.getTime() <= nowMs
				? `the saved session expired on ${expiry.toISOString().slice(0, 10)}. Sign in again.`
				: 'the saved session cannot be used for confirmations. Sign in again.',
			true
		);
	}

	const response = await transport({
		method: 'POST',
		url: ENDPOINT,
		body: new URLSearchParams({
			refresh_token: refreshToken,
			steamid: steamId64
		}),
		// This endpoint authenticates with the token in the body, not a cookie —
		// which is the point: it is what we call when there is no session yet.
		cookie: ''
	});

	if (response.status === 401 || response.status === 403) {
		throw new AccessTokenError('Steam rejected the saved session. Sign in again.', true);
	}
	if (response.status >= 300) {
		throw new AccessTokenError(`Steam answered with HTTP ${response.status}.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(response.text);
	} catch {
		throw new AccessTokenError('Steam returned something that is not a valid response.');
	}

	const result = responseSchema.safeParse(parsed);
	if (!result.success) {
		// Steam answers a spent refresh token with `{"response":{}}` and HTTP 200,
		// so an empty body here means the token is finished rather than that
		// something went wrong in transit.
		throw new AccessTokenError(
			'Steam did not return a session for this account. Sign in again.',
			true
		);
	}

	const accessToken = result.data.response.access_token;
	// Same gate the refresh token passed, applied to what Steam just minted.
	// A web-scoped (or already-expired) access token would otherwise produce a
	// session cookie that looks fine and cannot drive mobileconf — F-13 on the
	// *output* side of the mint rather than the input.
	if (!isUsableMobileToken(accessToken, nowMs)) {
		throw new AccessTokenError(
			'Steam returned a session that cannot be used for confirmations. Sign in again.',
			true
		);
	}

	return accessToken;
}
