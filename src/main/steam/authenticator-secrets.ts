import { createHash } from 'node:crypto';
import { isUsableSharedSecret } from '../codes/totp';

/** Which required authenticator key cannot be used by this build. */
export type AuthenticatorSecretProblem = 'login' | 'confirmation';

/**
 * Validate both twenty-byte Steam authenticator keys.
 *
 * Presence is not enough: Node's Base64 decoder silently accepts malformed or
 * short input, after which the app generates confidently wrong codes forever.
 * Identity secrets use the same encoding and length as shared secrets.
 */
export function authenticatorSecretProblem(secrets: {
	sharedSecret: string;
	identitySecret: string;
}): AuthenticatorSecretProblem | undefined {
	if (!isUsableSharedSecret(secrets.sharedSecret)) return 'login';
	if (!isUsableSharedSecret(secrets.identitySecret)) return 'confirmation';
	return undefined;
}

export function describeAuthenticatorSecretProblem(problem: AuthenticatorSecretProblem): string {
	return problem === 'login'
		? 'the login secret is not a valid 20-byte Steam authenticator key'
		: 'the confirmation secret is not a valid 20-byte Steam authenticator key';
}

/** Identify one authenticator without retaining another copy of its secret. */
export function authenticatorFingerprint(account: { sharedSecret?: string }): string {
	return createHash('sha256')
		.update(account.sharedSecret ?? '')
		.digest('hex')
		.slice(0, 16);
}

/** Whether a stored value can actually be an authenticator fingerprint we produced. */
export function isAuthenticatorFingerprint(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

/** Whether a value is the canonical UUID generated for one irreversible operation. */
export function isOperationId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	);
}

/** Stable JSON projection for a record whose key order may have changed on disk. */
function canonicalRecord(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalRecord);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, member]) => member !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, member]) => [key, canonicalRecord(member)])
		);
	}
	return value;
}

/**
 * Opaque identity for one displayed stale safety record.
 *
 * The renderer needs to prove it is clearing the exact record it was shown,
 * without receiving the authenticator fingerprint itself. Including the source
 * also prevents one prompt from clearing a different vault/journal copy.
 */
export function operationRecordToken<
	T extends {
		steamId64: string;
		kind: 'activate' | 'deactivate';
		fingerprint?: string | undefined;
		at: string;
	}
>(source: 'vault' | 'journal', record: T): string {
	return createHash('sha256')
		.update(JSON.stringify(canonicalRecord({ source, record })))
		.digest('hex');
}
