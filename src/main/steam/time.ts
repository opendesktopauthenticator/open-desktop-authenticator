import { z } from 'zod';
import type { SteamTransport } from '../confirmations/client';

/**
 * Asking Steam what time it thinks it is (§12 F4 / F5).
 *
 * Codes and confirmation HMACs are validated against **Steam's** clock. A machine
 * more than half a window out produces answers Steam rejects, and the user sees
 * "invalid code" with nothing pointing at the real cause.
 *
 * Implemented here rather than through `steam-totp.getTimeOffset`, which opens a
 * bare `https.request` with no agent — the F-08 leak path Phase 0 documented.
 * Going through the injected transport means the query is routed like every other
 * Steam call, and fails closed with the proxy rather than going direct.
 *
 * Pure request + parse. Applying the offset to the codes service is the caller's
 * job, so a failed sync cannot accidentally record "checked, and we are correct"
 * by writing zero — the same trap the spike hit and documented as F-07's cousin.
 */

const ENDPOINT = 'https://api.steampowered.com/ITwoFactorService/QueryTime/v1/';

const responseSchema = z.object({
	response: z.object({
		/** Unix seconds, as Steam's two-factor service sees them. */
		server_time: z.union([z.string(), z.number()]).transform((value, ctx) => {
			const n = typeof value === 'number' ? value : Number(value);
			if (!Number.isFinite(n) || n <= 0) {
				ctx.addIssue({ code: 'custom', message: 'server_time is not a usable unix timestamp' });
				return z.NEVER;
			}
			return Math.floor(n);
		})
	})
});

export class SteamTimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SteamTimeError';
	}
}

/**
 * Seconds to add to the local clock so it matches Steam's.
 *
 * Matches `steam-totp`'s definition: `server_time - floor(nowMs / 1000)` at the
 * moment the body is read. Latency is not folded in — Steam accepts a window of
 * skew, and inventing a midpoint correction here would diverge from the library
 * every other authenticator is compared against.
 */
export async function queryTimeOffset(
	transport: SteamTransport,
	nowMs: number = Date.now()
): Promise<number> {
	const response = await transport({
		method: 'POST',
		url: ENDPOINT,
		// No body and no cookie: QueryTime is unauthenticated. The point of going
		// through the transport is the *route*, not a session.
		cookie: ''
	});

	if (response.status !== 200) {
		throw new SteamTimeError(`Steam answered the time query with HTTP ${response.status}.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(response.text);
	} catch {
		throw new SteamTimeError('Steam returned something that is not a valid time response.');
	}

	const result = responseSchema.safeParse(parsed);
	if (!result.success) {
		throw new SteamTimeError('Steam returned a time response this version does not understand.');
	}

	return result.data.response.server_time - Math.floor(nowMs / 1000);
}
