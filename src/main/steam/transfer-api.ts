import type { SteamTransport } from '../confirmations/client';
import { wipe } from '../vault/crypto';
import {
	decodeContinueResponse,
	encodeContinueRequest,
	type ContinueResult
} from './transfer-proto';

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
	/** True only when Steam supplied an application-level negative result. */
	readonly provesNoChange: boolean;

	constructor(message: string, status: number, provesNoChange = false) {
		super(message);
		this.name = 'TransferApiError';
		this.status = status;
		this.provesNoChange = provesNoChange;
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
	const text = response.text ?? '';

	/*
	 * Steam's authenticated application result outranks the HTTP envelope. A
	 * proxy or intermediary can supply a misleading status, while x-eresult is
	 * the endpoint's answer. In particular, Steam has returned EResult.OK with an
	 * HTTP error status after the text was already sent; inviting another request
	 * in that case sends a second SMS and spends the account's rate limit.
	 */
	if (response.eresult !== undefined) {
		let shape: StartChallengeResult['shape'] = 'protobuf';
		if (text !== '') {
			try {
				const decoded: unknown = JSON.parse(text);
				if (typeof decoded === 'object' && decoded !== null && 'response' in decoded) {
					shape = 'json';
				}
			} catch {
				// A non-JSON body belongs to the protobuf form of this endpoint.
			}
		}
		return {
			eresult: response.eresult,
			...(describeResult(response.eresult) === undefined
				? {}
				: { meaning: describeResult(response.eresult) }),
			sent: response.eresult === ERESULT_OK,
			shape
		};
	}

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
		return { sent: false, shape: 'protobuf' };
	}

	try {
		const parsed: unknown = JSON.parse(text);
		const success =
			typeof parsed === 'object' && parsed !== null && 'response' in parsed
				? Boolean((parsed as { response?: { success?: unknown } }).response?.success)
				: false;
		return { sent: success, shape: 'json' };
	} catch {
		// A non-empty body that is not JSON is a protobuf message with something in
		// it, which for this response means `success` was explicitly set. Trust the
		// header over guessing at the bytes.
		return { sent: false, shape: 'protobuf' };
	}
}

/**
 * Submit the texted code, and take the replacement Steam issues.
 *
 * **This is the irreversible call.** When it returns, the authenticator on the
 * user's phone has already stopped being the account's authenticator, and the
 * only copy of its replacement is the value this function returns.
 *
 * It is never retried automatically, and the transport is not permitted to
 * either. A request that times out may still have been processed: retrying
 * would submit a spent code against an account whose authenticator has already
 * rotated, and the second answer would look like a failure while the first
 * silently succeeded and threw the secrets away. A caller that loses the reply
 * has an uncertain outcome, not a failed one, and must say so.
 */
export async function continueTransfer(
	transport: SteamTransport,
	accessToken: string,
	smsCode: string,
	/**
	 * Signals that a response body arrived and may contain replacement material.
	 *
	 * It is called before an unreadable body is rejected and before a decoded
	 * replacement is handed to service-level validation. It is not called for a
	 * bare HTTP error or an empty response, because those contain no recoverable
	 * bytes and must remain an indeterminate outcome.
	 */
	onRaw?: (body: Buffer) => void
): Promise<ContinueResult> {
	const encoded = encodeContinueRequest(smsCode);
	let body: Buffer | undefined;
	try {
		const response = await transport({
			method: 'POST',
			url: `${BASE}/RemoveAuthenticatorViaChallengeContinue/v1/?access_token=${encodeURIComponent(accessToken)}`,
			body: new URLSearchParams({ input_protobuf_encoded: encoded.toString('base64') }),
			cookie: '',
			// The reply is raw secret material. Read as UTF-8 it comes back mangled
			// beyond recovery, and quietly — see SteamRequest.binary.
			binary: true
		});

		/*
		 * `latin1`, not `utf8`.
		 *
		 * The transport hands back a string, and protobuf is binary. Decoding those
		 * bytes as UTF-8 replaces every invalid sequence with U+FFFD — which for a
		 * body full of raw secret material means most of it. latin1 is a byte-for-byte
		 * mapping, so the buffer that comes out is the one that went in.
		 */
		body = Buffer.from(response.text ?? '', 'latin1');
		let decoded: ContinueResult | undefined;
		if (body.length !== 0) {
			try {
				decoded = decodeContinueResponse(body);
			} catch {
				// A body existed, but it was not the response protocol. Preserve that
				// distinction for recovery without treating HTTP as a rollback receipt.
				onRaw?.(body);
				if (response.eresult !== undefined && response.eresult !== ERESULT_OK) {
					throw new TransferApiError(
						describeResult(response.eresult) ?? `Steam refused the code (HTTP ${response.status}).`,
						response.status,
						true
					);
				}
				throw new TransferApiError(
					`Steam returned HTTP ${response.status}, but its transfer result could not be read conclusively.`,
					response.status
				);
			}
		}

		/*
		 * Protocol evidence wins over transport metadata. A gateway can replace an
		 * HTTP status after Steam acted, and a contradictory EResult must never erase
		 * the only replacement bundle. A token is preserved even if the optional
		 * success bit is missing or contradictory; validation happens in the service.
		 */
		if (decoded?.success === true || decoded?.replacementToken !== undefined) {
			onRaw?.(body);
			return decoded;
		}
		if (decoded?.success === false) {
			if (response.eresult === ERESULT_OK) {
				throw new TransferApiError(
					'Steam returned contradictory transfer results, so this application cannot safely retry.',
					response.status
				);
			}
			return decoded;
		}

		/*
		 * HTTP status alone cannot prove that an irreversible POST was rolled back.
		 * Only Steam's authenticated application-level negative result is enough.
		 */
		if (response.eresult !== undefined && response.eresult !== ERESULT_OK) {
			throw new TransferApiError(
				describeResult(response.eresult) ?? `Steam refused the code (HTTP ${response.status}).`,
				response.status,
				true
			);
		}
		if (response.status !== 200) {
			throw new TransferApiError(
				`Steam returned HTTP ${response.status} without a conclusive transfer result.`,
				response.status
			);
		}
		return decoded ?? {};
	} finally {
		wipe(encoded);
		if (body !== undefined) wipe(body);
	}
}
