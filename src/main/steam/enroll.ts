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

	/**
	 * **The request reached Steam and the reply did not reach us.**
	 *
	 * Every call in this file changes the account, and each one sends its request
	 * before anything can go wrong with the answer. So a timeout, a torn
	 * connection, an HTTP error page or an unparseable body all mean the same
	 * thing: Steam may have done it. The account may now carry an authenticator
	 * whose secrets this application never received, or may have had one removed
	 * while the vault still shows codes for it.
	 *
	 * It was reported as though nothing had happened — `startEnrollment` said
	 * "Nothing was changed" in those words — and a timeout did not reach any of
	 * these messages at all: `await transport(...)` threw a network error straight
	 * past them, so the one case where the outcome is least knowable produced the
	 * least guidance.
	 *
	 * `transfer.ts` has carried this distinction since it was written, under
	 * `terminal`. This is the same idea for the three operations here, and it
	 * exists to stop two things: telling the user nothing happened when something
	 * may have, and retrying blindly on top of a change that may already be in
	 * place.
	 */
	readonly committed: boolean;

	constructor(message: string, permanent = true, committed = false) {
		super(message);
		this.name = 'EnrollmentError';
		this.permanent = permanent;
		this.committed = committed;
	}
}

/**
 * What to tell somebody whose request was sent and whose answer never arrived.
 *
 * One sentence per operation, because the account is in a different state after
 * each and "check Steam" is not an instruction anybody can act on. None of them
 * says what happened, because nothing here knows.
 */
const UNCERTAIN = {
	add:
		'Steam was asked to add an authenticator and did not answer, so this application cannot ' +
		'tell whether it did. Open the Steam mobile app and look at Steam Guard on this account ' +
		'before trying again: if an authenticator was attached, its secrets were in the reply that ' +
		'never arrived and this application does not have them. Removing it there, or contacting ' +
		'Steam Support, is the way out — adding another on top will not work.',
	finalize:
		'Steam was asked to activate the authenticator and did not answer, so this application ' +
		'cannot tell whether it did. Check the Steam mobile app: if Steam Guard is now on, the ' +
		'authenticator is active and the codes this application shows are the right ones. Do not ' +
		'start again from the beginning until you have looked.',
	remove:
		'Steam was asked to remove the authenticator and did not answer, so this application cannot ' +
		'tell whether it did. Check Steam Guard on the account before assuming either way — the ' +
		'codes shown here may no longer be the ones Steam accepts.'
} as const;

/**
 * Send a request that changes the account, and turn any failure to *get an
 * answer* into the uncertainty it actually is.
 *
 * The throw is what was missing. `transport` rejects on a timeout, a DNS
 * failure, a dropped connection or a refused proxy, and every one of those
 * happens after the bytes have gone.
 */
async function commitRequest(
	transport: SteamTransport,
	request: Parameters<SteamTransport>[0],
	uncertain: string
): Promise<Awaited<ReturnType<SteamTransport>>> {
	try {
		return await transport(request);
	} catch (err) {
		// Not `permanent: false`. Trying again is exactly what must not happen
		// until somebody has looked at the account.
		throw new EnrollmentError(`${uncertain} (${describeCause(err)})`, true, true);
	}
}

/** The transport's own words, kept short and never in place of the guidance. */
function describeCause(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 120 ? `${message.slice(0, 119)}…` : message;
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

const removeResponseSchema = z.object({
	response: z.object({
		success: z.boolean().optional(),
		/**
		 * Steam limits how many times a revocation code may be got wrong before it
		 * stops accepting it. Surfaced because running out is unrecoverable without
		 * Steam Support, and a user deserves to know how close they are.
		 */
		revocation_attempts_remaining: z.number().int().optional()
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
function readJson(
	text: string,
	status: number,
	whenUnreadable: string,
	committed = false
): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// An HTTP error page, a proxy's captive portal, a truncated body: the
		// request went either way, so `committed` decides whether the caller may
		// be told to try again.
		throw new EnrollmentError(`${whenUnreadable} (HTTP ${status})`, committed, committed);
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

	const response = await commitRequest(
		transport,
		{
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
		},
		UNCERTAIN.add
	);

	const parsed = addResponseSchema.safeParse(
		readJson(response.text, response.status, UNCERTAIN.add, true)
	);
	if (!parsed.success) {
		// **Not "nothing was changed".** The request went before this reply came
		// back, so an unreadable one says nothing about what Steam did with it.
		throw new EnrollmentError(UNCERTAIN.add, true, true);
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
		/**
		 * Whether Steam sent the code by SMS.
		 *
		 * Decided by whether `AddAuthenticator` returned a `phone_number_hint`, not
		 * assumed. An account with no phone still enrols — F-10 flagged this as
		 * plausible and a live run confirmed it — and Steam delivers the activation
		 * code by email instead. Telling Steam to `validate_sms_code` for a code it
		 * never texted is asking it to check the wrong thing.
		 */
		validateSmsCode?: boolean;
	}
): Promise<FinalizeOutcome> {
	const authenticatorCode = generateGuardCode(options.sharedSecret, options.unixSeconds);

	const response = await commitRequest(
		transport,
		{
			method: 'POST',
			url: `${BASE}/FinalizeAddAuthenticator/v1/?access_token=${encodeURIComponent(
				options.accessToken
			)}`,
			body: new URLSearchParams({
				steamid: options.steamId64,
				authenticator_code: authenticatorCode,
				authenticator_time: String(options.unixSeconds),
				activation_code: options.activationCode,
				// Only claimed when there is a phone to have texted.
				...(options.validateSmsCode === false ? {} : { validate_sms_code: '1' })
			}),
			cookie: ''
		},
		UNCERTAIN.finalize
	);

	const parsed = finalizeResponseSchema.safeParse(
		readJson(response.text, response.status, UNCERTAIN.finalize, true)
	);
	if (!parsed.success) {
		throw new EnrollmentError(UNCERTAIN.finalize, true, true);
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
				'try again — it expires quickly, and on an account with no phone number it arrives ' +
				'by email rather than by text.',
			false
		);
	}

	/*
	 * **A reply with none of the three fields is not a refusal.**
	 *
	 * Every optional field in the schema is optional because Steam omits it in
	 * some answers, so `{}` and `{"response":{}}` parse cleanly and arrive here —
	 * and they were reported as "Steam did not accept the activation code", a
	 * definite claim about an account whose state nothing here knows. That is the
	 * same defect as the unreadable-reply path, reached through the branch that
	 * looked like it had already handled everything.
	 */
	if (body.success === undefined && body.status === undefined) {
		throw new EnrollmentError(UNCERTAIN.finalize, true, true);
	}

	throw new EnrollmentError(
		'Steam did not accept the activation code. Check it and try again — it expires quickly.',
		false
	);
}

/**
 * Detach an authenticator from a Steam account (F-09, Q15).
 *
 * ## This is the most destructive thing this application can do
 *
 * It removes Steam Guard from the account. Not "removes it from this app" —
 * removes it from Steam. Afterwards the account has no second factor at all
 * until the owner adds one somewhere else, which is a window an attacker would
 * very much like to create.
 *
 * That is why F-09 flagged it as a **new threat-model entry** rather than a
 * feature: an attacker holding an unlocked vault could otherwise strip 2FA from
 * every account in one pass, turning a bounded compromise into permanent
 * takeover of all of them. The service therefore demands the passphrase per
 * account and refuses to act on more than one at a time. Those are not UI
 * politeness; they are what makes this safe to ship.
 *
 * ## It needs the revocation code
 *
 * Steam will not detach an authenticator without it, which means an account
 * imported without one — §12 F2 permits this, loudly — cannot use this at all.
 * The screen says so before offering the button rather than after it fails.
 */
export async function removeAuthenticator(
	transport: SteamTransport,
	options: {
		steamId64: string;
		accessToken: string;
		revocationCode: string;
	}
): Promise<void> {
	const response = await commitRequest(
		transport,
		{
			method: 'POST',
			url: `${BASE}/RemoveAuthenticator/v1/?access_token=${encodeURIComponent(options.accessToken)}`,
			body: new URLSearchParams({
				steamid: options.steamId64,
				revocation_code: options.revocationCode.trim(),
				// `1` is "remove the authenticator entirely", which is what this means.
				// Steam also has a scheme for moving one to another device; that is a
				// different operation and deliberately not offered here.
				steamguard_scheme: '1'
			}),
			cookie: ''
		},
		UNCERTAIN.remove
	);

	const parsed = removeResponseSchema.safeParse(
		readJson(response.text, response.status, UNCERTAIN.remove, true)
	);
	if (!parsed.success) {
		throw new EnrollmentError(UNCERTAIN.remove, true, true);
	}

	const body = parsed.data.response;
	if (body.success === true) {
		return;
	}

	/*
	 * **`success` absent is not `success: false`.** The field is optional because
	 * Steam omits it in some answers, so `{}` parsed cleanly and was reported as a
	 * rejected revocation code — a definite claim about an account that may well
	 * have had its authenticator removed. Only an explicit `false` is a refusal.
	 */
	if (body.success === undefined && body.revocation_attempts_remaining === undefined) {
		throw new EnrollmentError(UNCERTAIN.remove, true, true);
	}

	// A wrong revocation code is by far the likeliest cause, and it is worth
	// naming: the alternative is a user concluding the feature is broken and
	// trying repeatedly with the same wrong code.
	throw new EnrollmentError(
		body.revocation_attempts_remaining !== undefined
			? `Steam did not accept that revocation code. ${body.revocation_attempts_remaining} ` +
					'attempts remain before Steam stops accepting it at all.'
			: 'Steam did not accept that revocation code. Check it character by character — it is ' +
					'the code beginning with R that you were told to write down.',
		false
	);
}
