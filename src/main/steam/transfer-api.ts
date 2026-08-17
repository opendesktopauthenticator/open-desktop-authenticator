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
export type StartChallengeResult = {
	/** What the result code means, when it is one we recognise. */
	meaning?: string;
	/** Steam's own result code, when it sent one. 1 is OK. */
	eresult?: number;
	/** True when Steam said the text was sent, by whichever route it said it. */
	sent: boolean;
	/** How Steam answered, so the next endpoint need not re-learn it. */
	shape: 'json' | 'protobuf';
};

/** `EResult.OK`. The only value that means the text went out. */
const ERESULT_OK = 1;

/**
 * The results this call actually produces, in words.
 *
 * A bare number in front of a user is a dead end — they cannot look it up and
 * it does not tell them what to do next. These are the ones worth naming; the
 * same values `enroll.ts` already recognises, which is not a coincidence since
 * both are ITwoFactorService.
 *
 * Anything unlisted is reported as its number rather than guessed at. A wrong
 * explanation is worse than an unfamiliar one, because it sends somebody off to
 * fix the wrong thing.
 */
const RESULT_MEANING: Readonly<Record<number, string>> = {
	2: 'Steam refused the request without saying why.',
	8: 'Steam rejected the request as malformed. That is a bug here, not something you did.',
	9: 'There is no verified phone number on this account, so Steam has nowhere to send a code.',
	15: 'This session is not allowed to do that. Signing in again may help.',
	84: 'Steam is rate-limiting these requests. Wait several minutes before asking again.'
};

/** What Steam's result code means, in a sentence, when it is one we know. */
export function describeResult(eresult: number | undefined): string | undefined {
	return eresult === undefined ? undefined : RESULT_MEANING[eresult];
}

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

	/*
	 * An empty body is the expected answer here, not a broken one.
	 *
	 * `CTwoFactor_RemoveAuthenticatorViaChallengeStart_Response` has a single
	 * optional field, and an unset optional field encodes to nothing at all — so
	 * a successful protobuf reply is zero bytes. The first version of this
	 * classified that as "not JSON, probably protobuf, needs a decoder", which
	 * was true and useless: there is nothing in it to decode. Steam says what
	 * happened in `x-eresult`.
	 */
	if (text === '') {
		return {
			...(response.eresult === undefined ? {} : { eresult: response.eresult }),
			...(describeResult(response.eresult) === undefined
				? {}
				: { meaning: describeResult(response.eresult) }),
			sent: response.eresult === ERESULT_OK,
			shape: 'protobuf'
		};
	}

	try {
		const parsed: unknown = JSON.parse(text);
		const success =
			typeof parsed === 'object' && parsed !== null && 'response' in parsed
				? Boolean((parsed as { response?: { success?: unknown } }).response?.success)
				: false;
		return {
			...(response.eresult === undefined ? {} : { eresult: response.eresult }),
			...(describeResult(response.eresult) === undefined
				? {}
				: { meaning: describeResult(response.eresult) }),
			sent: success,
			shape: 'json'
		};
	} catch {
		// A non-empty body that is not JSON is a protobuf message with something in
		// it, which for this response means `success` was explicitly set. Trust the
		// header over guessing at the bytes.
		return {
			...(response.eresult === undefined ? {} : { eresult: response.eresult }),
			...(describeResult(response.eresult) === undefined
				? {}
				: { meaning: describeResult(response.eresult) }),
			sent: response.eresult === ERESULT_OK,
			shape: 'protobuf'
		};
	}
}
