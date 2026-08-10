import { z } from 'zod';
import { generateGuardCode } from '../codes/totp';
import { deviceIdFor } from '../confirmations/key';
import type { SteamTransport } from '../confirmations/client';

/**
 * Attaching a new authenticator to a Steam account (§12 F3).
 *
 * This is the operation SDA is best known for and the one thing an importer
 * cannot do: it turns an account with no authenticator into one this application
 * holds the secrets for.
 *
 * ## The dangerous shape of this flow
 *
 * It is two calls, and **the account is changed by the first one**. After
 * `AddAuthenticator` returns, Steam has already associated a new authenticator
 * with the account and issued the only copy of its `shared_secret` and
 * `revocation_code` that will ever exist. Steam does not hand them out again.
 *
 * So the failure that matters is not "enrollment failed" — it is "enrollment
 * half-succeeded and we lost the secrets". A user in that state cannot generate
 * codes, cannot sign in, and needs the revocation code they were never shown, or
 * Steam Support. Losing a network connection between the two calls must not be
 * able to cause it.
 *
 * The rule that follows, and which the service enforces: **persist what the
 * first call returns before making the second, and before asking the user for
 * anything.** The vault's `pendingActivation` status exists for exactly this
 * window.
 *
 * ## What this module does not do
 *
 * It does not manage phone numbers. `sms_phone_id: '1'` asks Steam to use the
 * phone already on the account; if there is none, Steam refuses and says so.
 * Adding a phone number is a Steam operation, done on Steam — F-10 records that
 * no library in this ecosystem manages one either.
 */

/** `EAuthenticatorType.MobileApp` — the kind of authenticator SDA and this app hold. */
const AUTHENTICATOR_TYPE = 1;

const BASE = 'https://api.steampowered.com/ITwoFactorService';

/**
 * Steam's `EResult`, for the handful that mean something specific here.
 *
 * Anything not listed is reported with its number rather than guessed at — an
 * invented explanation for an unfamiliar code is worse than an honest one.
 */
const ERESULT = {
	ok: 1,
	fail: 2,
	invalidParam: 8,
	/** No phone on the account, or the phone is not verified. */
	noMatch: 9,
	/** The account already has an authenticator attached. */
	duplicateRequest: 29,
	rateLimited: 84
} as const;

export class EnrollmentError extends Error {
	/** True when trying again with the same inputs cannot possibly work. */
	readonly permanent: boolean;

	constructor(message: string, permanent = true) {
		super(message);
		this.name = 'EnrollmentError';
		this.permanent = permanent;
	}
}

const addResponseSchema = z.object({
	response: z.object({
		status: z.number().int(),
		/** Base64. The seed every Steam Guard code for this account comes from. */
		shared_secret: z.string().optional(),
		/** Base64. Signs confirmation requests. */
		identity_secret: z.string().optional(),
		/** `RXXXXX`. The only way back if the authenticator is ever lost. */
		revocation_code: z.string().optional(),
		serial_number: z.string().optional(),
		/** `otpauth://` URI. Useful for a user who wants a second copy elsewhere. */
		uri: z.string().optional(),
		account_name: z.string().optional(),
		token_gid: z.string().optional(),
		/** Last digits of the phone Steam will text. Shown so the user knows where to look. */
		phone_number_hint: z.string().optional(),
		server_time: z.union([z.string(), z.number()]).optional()
	})
});

const finalizeResponseSchema = z.object({
	response: z.object({
		success: z.boolean().optional(),
		/** Steam asking for a second, later code — the flow is not finished. */
		want_more: z.boolean().optional(),
		status: z.number().int().optional(),
		server_time: z.union([z.string(), z.number()]).optional()
	})
});

/** Everything the first call produces. All of it must be stored before the second. */
export interface StartedEnrollment {
	sharedSecret: string;
	identitySecret: string;
	revocationCode: string;
	deviceId: string;
	serialNumber?: string;
	accountName?: string;
	tokenGid?: string;
	uri?: string;
	/** Masked digits of the phone Steam is texting, when it says. */
	phoneNumberHint?: string;
}

/**
 * `whenUnreadable` is required rather than defaulted, because the honest thing
 * to say differs sharply between the two calls. Before enrollment starts,
 * nothing has changed and "try again" is true. After it starts, the account has
 * already been altered and the same words would be a guess.
 */
function readJson(text: string, status: number, whenUnreadable: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new EnrollmentError(`${whenUnreadable} (HTTP ${status})`, false);
	}
}

/**
 * Turn an `EResult` into something a person can act on.
 *
 * These are the states a user actually lands in, and each has a different next
 * step — which is the whole reason not to collapse them into "enrollment failed".
 */
function describeStatus(status: number): string {
	switch (status) {
		case ERESULT.duplicateRequest:
			return (
				'This account already has an authenticator. Remove the existing one from the Steam ' +
				'mobile app first — this app will not detach it for you.'
			);
		case ERESULT.noMatch:
			return (
				'Steam needs a confirmed phone number on this account before an authenticator can be ' +
				'added. Add and verify one in Steam, then try again.'
			);
		case ERESULT.rateLimited:
			return 'Steam is rate-limiting this account. Wait a while before trying again.';
		case ERESULT.invalidParam:
			return 'Steam rejected the request as malformed. This is a bug in this app, not something you did.';
		case ERESULT.fail:
			return 'Steam refused to add an authenticator, without saying why. Try again in a few minutes.';
		default:
			return `Steam refused to add an authenticator (EResult ${status}).`;
	}
}

/**
 * Ask Steam to attach a new authenticator.
 *
 * **This changes the account.** On success the caller is holding the only copy
 * of secrets Steam will never reissue, and is responsible for storing them
 * before doing anything else — including before telling the user it worked.
 */
export async function startEnrollment(
	transport: SteamTransport,
	options: { steamId64: string; accessToken: string; unixSeconds: number }
): Promise<StartedEnrollment> {
	const deviceId = deviceIdFor(options.steamId64);

	const response = await transport({
		method: 'POST',
		url: `${BASE}/AddAuthenticator/v1/?access_token=${encodeURIComponent(options.accessToken)}`,
		body: new URLSearchParams({
			steamid: options.steamId64,
			authenticator_time: String(options.unixSeconds),
			authenticator_type: String(AUTHENTICATOR_TYPE),
			device_identifier: deviceId,
			// Use the phone already on the account. This app never manages one.
			sms_phone_id: '1'
		}),
		cookie: ''
	});

	const parsed = addResponseSchema.safeParse(
		readJson(
			response.text,
			response.status,
			'Steam answered with something unreadable. Nothing was changed — try again in a moment.'
		)
	);
	if (!parsed.success) {
		throw new EnrollmentError(
			'Steam sent a reply this app could not read. Nothing was changed.',
			false
		);
	}

	const body = parsed.data.response;
	if (body.status !== ERESULT.ok) {
		throw new EnrollmentError(describeStatus(body.status), body.status !== ERESULT.rateLimited);
	}

	// Checked together, and hard. A partial response here is the worst case in
	// the whole application: Steam has attached the authenticator, and a missing
	// field means the account is now protected by a secret nobody holds.
	const { shared_secret, identity_secret, revocation_code } = body;
	if (!shared_secret || !identity_secret || !revocation_code) {
		throw new EnrollmentError(
			'Steam accepted the request but did not return the secrets. This account may now have an ' +
				'authenticator nobody can use — contact Steam Support with your account details before ' +
				'trying again.'
		);
	}

	const started: StartedEnrollment = {
		sharedSecret: shared_secret,
		identitySecret: identity_secret,
		revocationCode: revocation_code,
		deviceId
	};
	if (body.serial_number !== undefined) started.serialNumber = body.serial_number;
	if (body.account_name !== undefined) started.accountName = body.account_name;
	if (body.token_gid !== undefined) started.tokenGid = body.token_gid;
	if (body.uri !== undefined) started.uri = body.uri;
	if (body.phone_number_hint !== undefined) started.phoneNumberHint = body.phone_number_hint;

	return started;
}

/** What Steam said about an activation attempt. */
export type FinalizeOutcome =
	| { state: 'activated' }
	/** Steam wants another code from a later window. Send one and call again. */
	| { state: 'wantMore' };

/**
 * Confirm the authenticator with the SMS code Steam sent.
 *
 * The Guard code is generated from the secret Steam has just issued — proving to
 * Steam that the secret arrived intact, which is the actual point of this step.
 * If the stored secret were wrong, this is where it would be caught, before the
 * account is left depending on it.
 */
export async function finalizeEnrollment(
	transport: SteamTransport,
	options: {
		steamId64: string;
		accessToken: string;
		sharedSecret: string;
		/** The code texted to the phone on the account. */
		activationCode: string;
		unixSeconds: number;
	}
): Promise<FinalizeOutcome> {
	const authenticatorCode = generateGuardCode(options.sharedSecret, options.unixSeconds);

	const response = await transport({
		method: 'POST',
		url: `${BASE}/FinalizeAddAuthenticator/v1/?access_token=${encodeURIComponent(
			options.accessToken
		)}`,
		body: new URLSearchParams({
			steamid: options.steamId64,
			authenticator_code: authenticatorCode,
			authenticator_time: String(options.unixSeconds),
			activation_code: options.activationCode,
			validate_sms_code: '1'
		}),
		cookie: ''
	});

	const parsed = finalizeResponseSchema.safeParse(
		readJson(
			response.text,
			response.status,
			'Steam answered with something unreadable. Your authenticator may or may not be active — ' +
				'check the Steam mobile app before trying again.'
		)
	);
	if (!parsed.success) {
		throw new EnrollmentError(
			'Steam sent a reply this app could not read. Your authenticator may or may not be active — ' +
				'check the Steam mobile app before trying again.',
			false
		);
	}

	const body = parsed.data.response;

	// Asked for before `success` is examined: Steam sets `want_more` to mean
	// "that code was right, now prove you can produce the next one". Treating it
	// as a failure would send the user round the SMS loop again for no reason.
	if (body.want_more === true) {
		return { state: 'wantMore' };
	}

	if (body.success === true) {
		return { state: 'activated' };
	}

	if (body.status !== undefined && body.status !== ERESULT.ok) {
		throw new EnrollmentError(
			`Steam did not accept the activation code (EResult ${body.status}). Check the code and ` +
				'try again — it expires quickly.',
			false
		);
	}

	throw new EnrollmentError(
		'Steam did not accept the activation code. Check it and try again — it expires quickly.',
		false
	);
}
