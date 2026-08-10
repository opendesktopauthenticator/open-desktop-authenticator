/**
 * Reading Steam's JWTs — payload only, never as a trust decision.
 *
 * A JWT's payload is unauthenticated: anyone can rewrite it. Everything here is
 * used to decide whether a token is *worth attempting*, never to decide whether
 * a token is *valid*. Steam decides that.
 *
 * Main-process only. Tokens never reach the renderer (§11 S2), so this
 * deliberately does not live in `shared/`.
 */

interface JwtPayload {
	aud?: string[] | string;
	exp?: number;
}

function payloadOf(token: string): JwtPayload | undefined {
	const segment = token.split('.')[1];
	if (!segment) {
		return undefined;
	}
	try {
		const decoded: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
		return typeof decoded === 'object' && decoded !== null ? decoded : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The `aud` (audience) claim.
 *
 * This matters more than it looks. Steam scopes tokens per platform:
 *
 *   web / client login  -> aud: ["client", "web"]
 *   mobile refresh      -> aud: ["web", "renew", "derive", "mobile"]
 *
 * Mobile confirmations require a token scoped for `mobile`. A stored web token
 * looks perfectly valid and unexpired, and still cannot drive mobileconf (F-13)
 * — the failure surfaces much later as an unexplained confirmation error, so the
 * audience is checked at the boundary where the token enters instead.
 */
export function jwtAudience(token: string): string[] {
	const aud = payloadOf(token)?.aud;
	if (Array.isArray(aud)) {
		return aud.filter((entry): entry is string => typeof entry === 'string');
	}
	return typeof aud === 'string' ? [aud] : [];
}

/** The `exp` claim, or undefined when the token cannot be decoded. */
export function jwtExpiry(token: string): Date | undefined {
	const exp = payloadOf(token)?.exp;
	return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000) : undefined;
}

/** True when the token is decodable, unexpired, and scoped for the mobile app. */
export function isUsableMobileToken(token: string, nowMs: number): boolean {
	const expiry = jwtExpiry(token);
	if (!expiry || expiry.getTime() <= nowMs) {
		return false;
	}
	return jwtAudience(token).includes('mobile');
}
