import type { Account } from '../../shared/vault-schema';

/**
 * Writing an account back out as a maFile (§12 F2, the other direction).
 *
 * ## Why this exists
 *
 * An authenticator that can only be imported from and never exported to is a
 * trap: the secrets are yours, and a vault only this application can open is a
 * dependency on this application continuing to exist. MAINTENANCE.md admits this
 * is a single-maintainer project — export is what makes that admission
 * survivable rather than merely honest.
 *
 * It is also the format the whole ecosystem reads, so an exported file works in
 * SDA and in anything else that speaks maFile.
 *
 * ## The shape is SDA's, deliberately
 *
 * Not our own. A file only this app can read would defeat the point, so the
 * field names, casing and nesting are the ones every other tool expects —
 * `snake_case` at the top level, a capitalised `Session` block, and `SteamID` as
 * a **number**, because that is what the format has always contained.
 *
 * ## F-01 applies to writing, not only to reading
 *
 * A first version of this wrote `SteamID: Number(account.steamId64)` with a
 * comment claiming that was safe because the value came from a string we
 * already held. It is not safe: `Number('76561199999999999')` is
 * `76561200000000000` **before** `JSON.stringify` ever sees it, so the exported
 * file named a different account. Its own test caught it.
 *
 * So the digits are placed into the JSON text directly, through a sentinel,
 * and never become a JavaScript number at any point.
 */

/**
 * Stands in for the SteamID while the object is serialised, then is replaced by
 * the raw digits. Deliberately unmistakable: if one ever survives into a written
 * file, it is obvious rather than subtly wrong.
 */
const STEAM_ID_SENTINEL = '__ODA_STEAMID_SENTINEL__';

/** An account rendered in the format the ecosystem reads. */
export function toMaFile(account: Account): string {
	const file: Record<string, unknown> = {
		shared_secret: account.sharedSecret,
		identity_secret: account.identitySecret,
		account_name: account.accountName,
		// Present even when empty: tools index on these keys, and a missing one
		// reads as a corrupt file rather than an absent value.
		device_id: account.deviceId ?? '',
		serial_number: account.serialNumber ?? '',
		revocation_code: account.revocationCode ?? '',
		// `status: 1` is what SDA writes for an active authenticator.
		status: 1,
		// **Not `status === 'active'`.** `pendingRevocationBackup` is the ordinary
		// state of a freshly activated account — it means "activated, and the user
		// has not yet confirmed writing the revocation code down", which is a fact
		// about this application and none of Steam's business. Exporting those as
		// `fully_enrolled: false` told every reader, including our own importer,
		// that the authenticator had never been activated; re-importing then set the
		// account back to `pendingActivation` and offered to finalize an
		// authenticator Steam finalized long ago.
		//
		// Only `pendingActivation` genuinely means not finished.
		fully_enrolled: account.status !== 'pendingActivation',
		uri: account.uri ?? '',
		token_gid: account.tokenGid ?? '',
		secret_1: account.secret1 ?? '',
		Session: {
			// Serialised as a quoted sentinel, then swapped for the raw digits below
			// so the file carries an unquoted number the ecosystem expects — without
			// the value ever passing through JavaScript's number type.
			SteamID: STEAM_ID_SENTINEL
		}
	};

	// **The refresh token is deliberately not exported.**
	//
	// It is a live credential: anyone holding the file could reach Steam as this
	// account without a password until it expires. A maFile is a backup, and a
	// backup that logs somebody in is a different and worse object than one that
	// generates codes. The secrets in here are already enough to restore an
	// authenticator, which is what an export is for.

	// The quotes around the sentinel go with it, leaving a bare number token.
	// `steamId64` is validated as digits by the vault schema, so nothing here can
	// inject arbitrary text into the JSON.
	const serialised = JSON.stringify(file, null, 2).replace(
		`"${STEAM_ID_SENTINEL}"`,
		account.steamId64
	);

	return `${serialised}\n`;
}

/**
 * The filename the ecosystem expects.
 *
 * SDA names files by SteamID64, and tools that scan a folder rely on it. Kept
 * exactly, rather than made friendlier with an account name, so an exported file
 * drops into an existing collection without being the odd one out.
 */
export function maFileName(account: Account): string {
	return `${account.steamId64}.maFile`;
}
