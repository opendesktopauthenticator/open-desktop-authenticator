import { deviceIdFor } from '../confirmations/key';
import type { Account } from '../../shared/vault-schema';
import { newAutoConfirm } from '../../shared/vault-schema';
import type { ReplacementToken } from './transfer-proto';

/**
 * Turning Steam's replacement into an account this application can keep.
 *
 * ## The window this code lives in
 *
 * By the time any of this runs, Steam has already rotated the authenticator.
 * The secrets in hand exist in exactly one place — memory — and Steam will not
 * reissue them. Every decision here follows from that: validate before
 * believing, keep everything Steam sent, and never report success on the
 * strength of a write that has not been read back.
 *
 * ## Why validation is strict and refusal is loud
 *
 * A malformed replacement is not a reason to shrug and store it anyway. An
 * account saved without a usable `shared_secret` generates no codes, and the
 * user finds out at the moment they need to log in — long after the recovery
 * code that could have detached it has scrolled away. Better to refuse, keep
 * the bundle in memory, and say plainly what is wrong.
 */

export class ReplacementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReplacementError';
	}
}

/**
 * Steam Guard schemes this application understands.
 *
 * 0 is what a device-bound authenticator reports; the value is carried through
 * to storage either way. An unfamiliar scheme is refused rather than assumed
 * compatible: the scheme governs how codes are derived, and generating wrong
 * codes forever is a worse outcome than declining once.
 */
const SUPPORTED_SCHEMES = new Set([0, 1, 2]);

/**
 * Check that what Steam sent is a usable authenticator for the right account.
 *
 * @throws ReplacementError naming the single reason, so the screen can say it.
 */
export function validateReplacement(
	token: ReplacementToken | undefined,
	expectedSteamId64: string
): asserts token is ReplacementToken {
	if (!token) {
		throw new ReplacementError('Steam reported success but sent no replacement authenticator.');
	}

	/*
	 * The identity check comes first and is exact.
	 *
	 * Storing a replacement against the wrong account would overwrite a working
	 * authenticator with one that belongs elsewhere — losing both. String
	 * comparison rather than numeric: these are 64-bit values that a JavaScript
	 * number cannot hold, and two different SteamIDs can round to one number.
	 */
	if (!token.steamId64) {
		throw new ReplacementError('Steam did not say which account the new authenticator is for.');
	}
	if (token.steamId64 !== expectedSteamId64) {
		throw new ReplacementError(
			'Steam returned an authenticator for a different account. Nothing has been saved.'
		);
	}

	if (!token.sharedSecret) {
		throw new ReplacementError('The replacement has no login secret, so it could not make codes.');
	}
	if (!token.identitySecret) {
		throw new ReplacementError(
			'The replacement has no confirmation secret, so it could not approve trades.'
		);
	}
	if (!token.revocationCode) {
		throw new ReplacementError(
			'Steam sent no recovery code with the replacement. Without one there would be no way ' +
				'to detach this authenticator later.'
		);
	}
	if (!token.serverTime) {
		throw new ReplacementError('Steam sent no server time, so codes could not be aligned to it.');
	}
	if (token.steamGuardScheme !== undefined && !SUPPORTED_SCHEMES.has(token.steamGuardScheme)) {
		throw new ReplacementError(
			`Steam used an authenticator scheme this app does not know (${token.steamGuardScheme}).`
		);
	}
}

/**
 * Steam's clock, minus this machine's, in seconds.
 *
 * Taken from the replacement rather than from a separate `QueryTime` call: it
 * is the time Steam issued this authenticator against, and one fewer request in
 * the window where a failure is expensive.
 */
export function offsetFrom(token: ReplacementToken, nowMs: number): number {
	const serverSeconds = Number(token.serverTime);
	if (!Number.isFinite(serverSeconds)) {
		return 0;
	}
	return serverSeconds - Math.floor(nowMs / 1000);
}

/**
 * Map a validated replacement onto the stored account shape.
 *
 * Every field Steam sent is carried across, including the ones nothing reads
 * yet. They are issued once; dropping one because today's UI has no use for it
 * is a decision nobody gets to revisit.
 *
 * The account name comes from the sign-in rather than from Steam's reply. Both
 * should agree, but the one the user typed is the one they will look for in a
 * list, and Steam has been known to answer with a canonicalised form.
 */
export function accountFromReplacement(
	token: ReplacementToken,
	accountName: string,
	proxyUrl: string | undefined,
	addedAtIso: string
): Account {
	// `validateReplacement` has already refused anything missing these.
	const account: Account = {
		steamId64: token.steamId64 as string,
		accountName,
		sharedSecret: token.sharedSecret as string,
		identitySecret: token.identitySecret as string,
		revocationCode: token.revocationCode,
		deviceId: deviceIdFor(token.steamId64 as string),
		/*
		 * Stored as needing its recovery code written down, exactly as a fresh
		 * enrolment is. Steam has just issued a code that exists nowhere else, and
		 * the ceremony that forces it in front of the user is the same one.
		 */
		status: 'pendingRevocationBackup',
		addedAt: addedAtIso,
		autoConfirm: { ...newAutoConfirm(), pollIntervalSeconds: 30 }
	};

	if (token.serialNumber !== undefined) account.serialNumber = token.serialNumber;
	if (token.tokenGid !== undefined) account.tokenGid = token.tokenGid;
	if (token.uri !== undefined) account.uri = token.uri;
	if (token.secret1 !== undefined) account.secret1 = token.secret1;
	if (proxyUrl !== undefined && proxyUrl !== '') account.proxyUrl = proxyUrl;

	return account;
}

/**
 * Confirm a stored account is the one that was meant to be stored.
 *
 * Read back from the vault rather than trusting the write, because "the write
 * did not throw" and "the secrets are on disk and decryptable" are different
 * claims, and only the second one is safe to report to somebody whose phone has
 * just stopped being their authenticator.
 *
 * Compared by value, not by hash: this runs in the main process, on secrets it
 * already holds, and a mismatch has to be detectable rather than merely
 * probable. Nothing here is logged.
 */
export function storedFaithfully(stored: Account | undefined, expected: Account): boolean {
	return (
		stored !== undefined &&
		stored.steamId64 === expected.steamId64 &&
		stored.sharedSecret === expected.sharedSecret &&
		stored.identitySecret === expected.identitySecret &&
		stored.revocationCode === expected.revocationCode
	);
}
