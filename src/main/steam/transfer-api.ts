import type { SteamTransport } from '../confirmations/client';

/**
 * Steam's authenticator *replacement* endpoints.
 *
 * ## The two calls
 *
 * `RemoveAuthenticatorViaChallengeStart` asks Steam to text a code to the phone
 * number on the account. It changes nothing and can be repeated.
 *
 * `RemoveAuthenticatorViaChallengeContinue` submits that code and, with
 * `generate_new_token` set, makes Steam rotate the authenticator and hand back
 * a fresh secret bundle. That one is irreversible and lives elsewhere — this
 * file deliberately holds only the harmless half until the storage that has to
 * survive the other half is built.
 *
 * ## Why the name says Remove and the feature says transfer
 *
 * Valve's RPC is called `RemoveAuthenticatorViaChallenge`, which reads like the
 * destructive operation this feature exists to avoid. It is not. With
 * `generate_new_token` the server replaces the authenticator in one step and
 * issues the replacement, which is why it carries the shorter restriction
 * rather than the fifteen-day one a genuine remove-then-add costs. The name is
 * Valve's; the behaviour is the transfer.
 *
 * ## What this file does not assume
 *
 * Every other ITwoFactorService call in this application — AddAuthenticator,
 * FinalizeAddAuthenticator, QueryTime — is a form-encoded POST answered with
 * JSON, and the WebAPI generally offers that shape alongside the protobuf one.
 * Whether these two methods do as well is not something to guess at, so the
 * response is classified rather than parsed blind: JSON is read as JSON, and
 * anything else is reported as needing the protobuf decoder rather than
 * silently mangled into a wrong answer.
 */

const BASE = 'https://api.steampowered.com/ITwoFactorService';

export class TransferApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'TransferApiError';
		this.status = status;
	}
}

/** What Steam's answer turned out to be, so the caller need not guess. */
export type StartChallengeResult =
	/** Decoded, and Steam agreed to send the text. */
	| { shape: 'json'; success: boolean }
	/**
	 * A 200 that is not JSON — almost certainly a protobuf body.
	 *
	 * Carried as a length and a prefix rather than the bytes themselves. This is
	 * a diagnostic for deciding how to parse, not a payload, and a response body
	 * from an authenticated Steam call is not something to keep around.
	 */
	| { shape: 'binary'; bytes: number; prefixHex: string };

/**
 * Ask Steam to text a code to the phone on the account.
 *
 * Safe to call and safe to abandon: no authenticator is altered, and the user
 * can simply not use the code. It is not safe to call *repeatedly* — Steam
 * rate-limits it and the user's phone is on the other end — so the caller is
 * responsible for not offering it twice in a row.
 *
 * The request protobuf has no fields, so its encoding is zero bytes and its
 * base64 form is the empty string. The form field must still be present:
 * omitting it is not the same as sending it empty.
 */
export async function startTransferChallenge(
	transport: SteamTransport,
	accessToken: string
): Promise<StartChallengeResult> {
	const response = await transport({
		method: 'POST',
		url: `${BASE}/RemoveAuthenticatorViaChallengeStart/v1/?access_token=${encodeURIComponent(accessToken)}`,
		body: new URLSearchParams({ input_protobuf_encoded: '' }),
		cookie: ''
	});

	if (response.status !== 200) {
		/*
		 * Never the body.
		 *
		 * Steam's error bodies for an authenticated call have carried account
		 * detail before, and this message ends up in front of a user and possibly
		 * in a bug report. The status is enough to act on.
		 */
		throw new TransferApiError(
			response.status === 429
				? 'Steam is rate-limiting this. Wait a few minutes before asking for another text.'
				: `Steam refused to start the transfer (HTTP ${response.status}).`,
			response.status
		);
	}

	const text = response.text ?? '';
	try {
		const parsed: unknown = JSON.parse(text);
		const success =
			typeof parsed === 'object' && parsed !== null && 'response' in parsed
				? Boolean((parsed as { response?: { success?: unknown } }).response?.success)
				: false;
		return { shape: 'json', success };
	} catch {
		/*
		 * Not JSON. Report that plainly rather than treating an unparseable body as
		 * a failure: a protobuf response with success set looks identical to a
		 * network error if the only question asked is "did JSON.parse throw".
		 */
		return {
			shape: 'binary',
			bytes: text.length,
			prefixHex: [...text.slice(0, 16)]
				.map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
				.join(' ')
		};
	}
}
