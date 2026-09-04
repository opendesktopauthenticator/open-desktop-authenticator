import { parse } from 'protobufjs';

/**
 * The two protobuf messages the transfer needs.
 *
 * ## Why protobuf at all, when nothing else here uses it
 *
 * Every other ITwoFactorService call in this application is a form-encoded POST
 * answered with JSON. These two are not, and that was established against a
 * real account rather than assumed: `RemoveAuthenticatorViaChallengeStart`
 * answers HTTP 200 with a zero-byte body and the outcome in `x-eresult`, which
 * is the protobuf shape. So `Continue` has to be encoded properly — there is no
 * JSON form of it to fall back on.
 *
 * ## Why the schema is written out here
 *
 * The definitions are Valve's, and they are copied rather than generated
 * because two messages do not justify a code-generation step in a build that
 * currently has none. Field numbers are the contract: renaming a field is
 * harmless, renumbering one silently sends Steam something different.
 *
 * ## The fields that matter, and the ones that are easy to get wrong
 *
 * `version` defaults to 1 in the schema and Valve's current client sends 2.
 * Relying on the default would send 1, so it is always set explicitly — see
 * `encodeContinueRequest`.
 *
 * `shared_secret`, `identity_secret` and `secret_1` are `bytes`. They arrive as
 * binary and this application stores secrets as base64, so the conversion
 * happens once, here, rather than being repeated wherever a secret is touched.
 *
 * `serial_number` and `steamid` are 64-bit. JavaScript numbers cannot hold a
 * SteamID without losing the low digits, so they are read as strings and stay
 * strings — the same convention the rest of this application uses for SteamIDs.
 */

const SCHEMA = `
syntax = "proto2";

message CTwoFactor_RemoveAuthenticatorViaChallengeStart_Request {
}

message CTwoFactor_RemoveAuthenticatorViaChallengeStart_Response {
  optional bool success = 1;
}

message CTwoFactor_RemoveAuthenticatorViaChallengeContinue_Request {
  optional string sms_code = 1;
  optional bool generate_new_token = 2;
  optional uint32 version = 3 [default = 1];
}

message CRemoveAuthenticatorViaChallengeContinue_Replacement_Token {
  optional bytes shared_secret = 1;
  optional fixed64 serial_number = 2;
  optional string revocation_code = 3;
  optional string uri = 4;
  optional uint64 server_time = 5;
  optional string account_name = 6;
  optional string token_gid = 7;
  optional bytes identity_secret = 8;
  optional bytes secret_1 = 9;
  optional int32 status = 10;
  optional uint32 steamguard_scheme = 11;
  optional fixed64 steamid = 12;
}

message CTwoFactor_RemoveAuthenticatorViaChallengeContinue_Response {
  optional bool success = 1;
  optional CRemoveAuthenticatorViaChallengeContinue_Replacement_Token replacement_token = 2;
}
`;

/*
 * `keepCase` matters more than it looks.
 *
 * protobufjs camel-cases field names by default, so a message built with
 * `sms_code` and `generate_new_token` silently drops both — they match no field
 * — while `version` survives because it is a single word. The result encodes
 * cleanly, is a valid protobuf message, and asks Steam to remove the
 * authenticator without issuing a replacement.
 *
 * Nothing throws. The known test vector is the only reason this was caught.
 */
const root = parse(SCHEMA, { keepCase: true }).root;

const ContinueRequest = root.lookupType(
	'CTwoFactor_RemoveAuthenticatorViaChallengeContinue_Request'
);
const ContinueResponse = root.lookupType(
	'CTwoFactor_RemoveAuthenticatorViaChallengeContinue_Response'
);

/**
 * Valve's current client sends 2.
 *
 * The schema's default is 1, so this must be written into every request rather
 * than left out — an omitted field is not the same as a field set to its
 * default, and only one of those reaches Steam.
 */
export const CONTINUE_VERSION = 2;

/**
 * The replacement authenticator, as Steam returned it.
 *
 * Every field Steam sends is kept, including ones this application does not yet
 * display. They are issued once and never reissued; discarding one because
 * today's UI has no use for it is a decision that cannot be revisited.
 */
export interface ReplacementToken {
	/** base64. The seed login codes are generated from. */
	sharedSecret?: string;
	/** base64. Signs trade and Market confirmations. */
	identitySecret?: string;
	/** base64. Kept because Steam sends it, not because anything reads it. */
	secret1?: string;
	revocationCode?: string;
	uri?: string;
	accountName?: string;
	tokenGid?: string;
	/** Decimal string. Too large for a JavaScript number. */
	serialNumber?: string;
	/** Decimal string, seconds. */
	serverTime?: string;
	/** Decimal string. A SteamID64 loses its low digits as a number. */
	steamId64?: string;
	status?: number;
	steamGuardScheme?: number;
}

export interface ContinueResult {
	/**
	 * Steam's explicit answer. Missing is deliberately different from `false`:
	 * protobuf optional fields inherit their default from the message prototype,
	 * so reading the property without checking wire presence turns an empty reply
	 * into a refusal that Steam never actually sent.
	 */
	success?: boolean;
	replacementToken?: ReplacementToken;
}

const MAX_ENCODED_SECRET_LENGTH = 512;
const MAX_REVOCATION_CODE_LENGTH = 256;
const MAX_URI_LENGTH = 8 * 1024;
const MAX_ACCOUNT_NAME_LENGTH = 64;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_DECIMAL_LENGTH = 32;

/**
 * Bound every server-controlled field before it can enter the durable workflow
 * envelope. Steam's real values are far smaller; values outside these limits
 * are corrupted or hostile optional metadata and are omitted. This function is
 * also applied by the service because tests and future adapters can supply a
 * decoded token without going through this module's protobuf decoder.
 */
export function boundedReplacementToken(token: ReplacementToken): ReplacementToken {
	const out: ReplacementToken = {};
	const text = <K extends keyof ReplacementToken>(key: K, max: number): void => {
		const value = token[key];
		if (typeof value === 'string' && value !== '' && value.length <= max) {
			(out as Record<string, unknown>)[key] = value;
		}
	};
	text('sharedSecret', MAX_ENCODED_SECRET_LENGTH);
	text('identitySecret', MAX_ENCODED_SECRET_LENGTH);
	text('secret1', MAX_ENCODED_SECRET_LENGTH);
	text('revocationCode', MAX_REVOCATION_CODE_LENGTH);
	text('uri', MAX_URI_LENGTH);
	text('accountName', MAX_ACCOUNT_NAME_LENGTH);
	text('tokenGid', MAX_IDENTIFIER_LENGTH);
	text('serialNumber', MAX_DECIMAL_LENGTH);
	text('serverTime', MAX_DECIMAL_LENGTH);
	text('steamId64', MAX_DECIMAL_LENGTH);
	if (typeof token.status === 'number' && Number.isFinite(token.status)) out.status = token.status;
	if (typeof token.steamGuardScheme === 'number' && Number.isFinite(token.steamGuardScheme)) {
		out.steamGuardScheme = token.steamGuardScheme;
	}
	return out;
}

/**
 * Encode the request that rotates the authenticator.
 *
 * `generateNewToken` is not a parameter. Sending this request without it tells
 * Steam to remove the authenticator and issue nothing back — the destructive
 * operation this entire feature exists to avoid — so it is hardcoded true and
 * cannot be switched off from anywhere, including a mistake in the UI.
 */
export function encodeContinueRequest(smsCode: string): Buffer {
	const message = ContinueRequest.create({
		sms_code: smsCode,
		generate_new_token: true,
		version: CONTINUE_VERSION
	});
	return Buffer.from(ContinueRequest.encode(message).finish());
}

/** A `bytes` field as base64, or undefined when Steam omitted it. */
function asBase64(value: unknown): string | undefined {
	if (value instanceof Uint8Array) {
		return value.length ? Buffer.from(value).toString('base64') : undefined;
	}
	return undefined;
}

/**
 * A 64-bit field as a decimal string.
 *
 * protobufjs hands back a Long for 64-bit fields, or a number when the runtime
 * has been configured otherwise. Both are stringified rather than converted,
 * because `Number(steamid)` silently rounds — and a SteamID that is wrong in
 * its last two digits looks entirely plausible.
 */
function asDecimalString(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? String(value) : undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	/*
	 * A Long from protobufjs, or anything else that can name itself as digits.
	 *
	 * Checked against `Object.prototype.toString` rather than merely for the
	 * presence of the method: every object has one, and the default returns
	 * "[object Object]", which would sail through a digits test only by failing
	 * it — quietly turning a SteamID into undefined.
	 */
	if (typeof value === 'object') {
		const candidate = value as { toString?: () => string };
		if (
			typeof candidate.toString === 'function' &&
			candidate.toString !== Object.prototype.toString
		) {
			const text = candidate.toString();
			return /^\d+$/.test(text) ? text : undefined;
		}
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Protobufjs exposes optional defaults through the prototype; keep wire absence absent. */
function own(record: Record<string, unknown>, field: string): unknown {
	return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : undefined;
}

/**
 * Decode Steam's answer.
 *
 * Throws on a body that is not this message at all. That is deliberate: the
 * caller has just asked Steam to rotate an authenticator, and "I could not read
 * the reply" must not be mistaken for "it did not happen".
 */
export function decodeContinueResponse(body: Buffer): ContinueResult {
	const decoded = ContinueResponse.decode(body) as unknown as Record<string, unknown>;
	const success = Object.prototype.hasOwnProperty.call(decoded, 'success')
		? decoded.success === true
		: undefined;
	const raw = decoded.replacement_token;

	if (typeof raw !== 'object' || raw === null) {
		return success === undefined ? {} : { success };
	}

	const token = raw as Record<string, unknown>;
	const replacement: ReplacementToken = {};
	const set = <K extends keyof ReplacementToken>(key: K, value: ReplacementToken[K]): void => {
		if (value !== undefined) {
			replacement[key] = value;
		}
	};

	set('sharedSecret', asBase64(own(token, 'shared_secret')));
	set('identitySecret', asBase64(own(token, 'identity_secret')));
	set('secret1', asBase64(own(token, 'secret_1')));
	set('revocationCode', asString(own(token, 'revocation_code')));
	set('uri', asString(own(token, 'uri')));
	set('accountName', asString(own(token, 'account_name')));
	set('tokenGid', asString(own(token, 'token_gid')));
	set('serialNumber', asDecimalString(own(token, 'serial_number')));
	set('serverTime', asDecimalString(own(token, 'server_time')));
	set('steamId64', asDecimalString(own(token, 'steamid')));
	set('status', asNumber(own(token, 'status')));
	set('steamGuardScheme', asNumber(own(token, 'steamguard_scheme')));

	return {
		...(success === undefined ? {} : { success }),
		replacementToken: boundedReplacementToken(replacement)
	};
}
