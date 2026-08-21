import { generateConfirmationKey, deviceIdFor, CONFIRMATION_TAGS } from './key';
import {
	buildListUrl,
	buildOperationBody,
	ConfirmationProtocolError,
	operationUrl,
	parseListResponse,
	parseOperationResponse,
	tagForAction,
	type Confirmation,
	type ConfirmationAction,
	type ConfirmationList,
	type RequestIdentity
} from './protocol';
import {
	describeType,
	isSecurityCritical,
	mayAutoConfirm,
	partitionForAutoConfirm,
	type AutoConfirmSettings
} from './policy';

/**
 * Fetching and acting on mobile confirmations (§12 F5).
 *
 * The transport is **injected**, and that is the whole architecture of this
 * file. Everything about a Steam request that is security-relevant — which key
 * signed it, which tag that key was bound to, whether S16 permits the operation
 * at all — is decided here and is testable without a socket. What is left for
 * the transport is opening the connection, which is where per-account proxy
 * routing lives (§10.1) and where the one remaining dependency question sits.
 *
 * Consequently nothing in this file knows what a proxy is, and nothing in it can
 * accidentally bypass one: it cannot open a connection at all.
 */

/** One HTTP exchange, as this module needs it. */
export interface SteamRequest {
	method: 'GET' | 'POST';
	url: string;
	/** Form body for a POST. */
	body?: URLSearchParams;
	/** The account's web session cookie. */
	cookie: string;
	/**
	 * Keep the response bytes intact instead of reading them as UTF-8.
	 *
	 * Every call in this application but one answers with text, so UTF-8 is the
	 * right default. The exception is Steam's protobuf-shaped authenticator
	 * transfer, whose body is raw secret material: read as UTF-8, every invalid
	 * byte sequence becomes U+FFFD, which for a body of random bytes is most of
	 * it. The corruption is silent and the result still parses as a string.
	 *
	 * With this set the body is mapped byte-for-byte through latin1, so
	 * `Buffer.from(text, 'latin1')` recovers exactly what Steam sent.
	 */
	binary?: boolean;
}

export interface SteamResponse {
	status: number;
	text: string;
	/**
	 * Steam's own result code, from the `x-eresult` response header.
	 *
	 * The WebAPI answers its protobuf-shaped methods with the outcome in a header
	 * and, very often, an empty body — because a protobuf message whose only
	 * field is unset encodes to zero bytes. Reading HTTP 200 and an empty body as
	 * either success or failure is guessing; this is where Steam actually says.
	 *
	 * Absent when the header was not sent, which is the case for the JSON-shaped
	 * calls that carry their result inside the body instead.
	 */
	eresult?: number;
}

/**
 * Performs one request.
 *
 * Supplied per account, so the implementation carries that account's proxy. A
 * client built for one account physically cannot emit traffic for another — the
 * cross-account bleed F-08 found is not possible through this shape.
 */
export type SteamTransport = (request: SteamRequest) => Promise<SteamResponse>;

/** The account fields a confirmation operation depends on. */
export interface ConfirmationAccount {
	steamId64: string;
	/** base64 or hex, as stored. */
	identitySecret: string;
	autoConfirm: AutoConfirmSettings;
}

export interface ConfirmationsClientOptions {
	transport: SteamTransport;
	/** Injected for testability. Defaults to the wall clock. */
	now?: () => number;
	/** Steam-corrected offset in seconds, from the same source the codes use. */
	timeOffsetSeconds?: () => number;
}

/** What an automatic pass did, and — more importantly — what it did not. */
export interface AutoConfirmResult {
	approved: Confirmation[];
	/** Held back for a human, each with the reason S16 refused it. */
	held: { confirmation: Confirmation; reason: string }[];
}

export class ConfirmationsClient {
	private readonly transport: SteamTransport;
	private readonly now: () => number;
	private readonly offset: () => number;

	constructor(options: ConfirmationsClientOptions) {
		this.transport = options.transport;
		this.now = options.now ?? (() => Date.now());
		this.offset = options.timeOffsetSeconds ?? ((): number => 0);
	}

	/**
	 * Pending confirmations for one account, with the count of what could not be
	 * read alongside them — see `parseListResponse`.
	 */
	async list(account: ConfirmationAccount, cookie: string): Promise<ConfirmationList> {
		const identity = this.identityFor(account, CONFIRMATION_TAGS.list);
		const response = await this.transport({
			method: 'GET',
			url: buildListUrl(identity),
			cookie
		});

		return parseListResponse(this.readBody(response));
	}

	/**
	 * Act on confirmations the **user** chose.
	 *
	 * Any type may be actioned this way, including account recovery — someone
	 * recovering their own account has every right to approve it. What is refused
	 * is doing that in bulk: a security-critical confirmation must be a decision
	 * taken about one specific thing, not one of eleven items swept up by a
	 * "select all" the user did not read.
	 */
	async act(
		account: ConfirmationAccount,
		cookie: string,
		action: ConfirmationAction,
		confirmations: readonly Confirmation[]
	): Promise<void> {
		const critical = confirmations.filter((entry) => isSecurityCritical(entry.type));
		if (critical.length > 0 && confirmations.length > 1) {
			throw new ConfirmationProtocolError({
				kind: 'unreadable',
				message: `${describeType(critical[0]?.type ?? 0)} confirmations must be handled one at a time, not in a batch.`
			});
		}

		await this.send(account, cookie, action, confirmations);
	}

	/**
	 * Approve only what S16 permits, and report everything it did not.
	 *
	 * The policy is applied here, at the boundary that actually sends the request,
	 * rather than trusted from a caller that already filtered. `policy.ts` explains
	 * why that matters: the confirmation this refuses is the one that hands
	 * somebody the account.
	 */
	async autoConfirm(
		account: ConfirmationAccount,
		cookie: string,
		confirmations: readonly Confirmation[]
	): Promise<AutoConfirmResult> {
		const { automatic, manual } = partitionForAutoConfirm(confirmations, account.autoConfirm);

		if (automatic.length === 0) {
			return { approved: [], held: manual };
		}

		// Belt and braces. `partitionForAutoConfirm` already applied the rule; this
		// asserts it again on the exact list about to be sent, so no future edit
		// between the two can widen what gets approved without failing here.
		for (const entry of automatic) {
			if (!mayAutoConfirm(entry, account.autoConfirm).act) {
				throw new ConfirmationProtocolError({
					kind: 'unreadable',
					message: 'refusing to auto-confirm something the policy does not permit'
				});
			}
		}

		await this.send(account, cookie, 'allow', automatic);
		return { approved: [...automatic], held: manual };
	}

	private async send(
		account: ConfirmationAccount,
		cookie: string,
		action: ConfirmationAction,
		confirmations: readonly Confirmation[]
	): Promise<void> {
		const identity = this.identityFor(account, tagForAction(action));
		const response = await this.transport({
			method: 'POST',
			url: operationUrl(),
			body: buildOperationBody(identity, action, confirmations),
			cookie
		});

		parseOperationResponse(this.readBody(response));
	}

	/** A freshly signed identity. Keys are single-use, so this is never cached. */
	private identityFor(account: ConfirmationAccount, tag: RequestIdentity['tag']): RequestIdentity {
		const unixSeconds = Math.floor(this.now() / 1000) + this.offset();
		return {
			steamId64: account.steamId64,
			deviceId: deviceIdFor(account.steamId64),
			unixSeconds,
			key: generateConfirmationKey(account.identitySecret, unixSeconds, tag),
			tag
		};
	}

	/**
	 * The body, once the HTTP status has been ruled acceptable.
	 *
	 * Steam signals an expired session with a redirect or a 401/403 as often as it
	 * does with a JSON body, so the status is classified here rather than left for
	 * the parser to guess at from HTML.
	 */
	private readBody(response: SteamResponse): string {
		if (response.status === 401 || response.status === 403) {
			throw new ConfirmationProtocolError({
				kind: 'sessionExpired',
				message: 'Steam rejected this session. Sign in again.'
			});
		}
		if (response.status >= 300) {
			throw new ConfirmationProtocolError({
				kind: 'unreadable',
				message: `Steam answered with HTTP ${response.status}.`
			});
		}
		return response.text;
	}
}

/**
 * The cookie that identifies a mobile web session.
 *
 * `steamLoginSecure` is `steamid||accessToken`, URL-encoded. The token must be
 * MobileApp-scoped — a web-scoped one produces a session that looks fine and
 * cannot drive mobileconf (F-13), which is why import refuses to store one.
 */
export function buildSessionCookie(steamId64: string, accessToken: string): string {
	if (!/^\d{5,25}$/.test(steamId64)) {
		throw new ConfirmationProtocolError({
			kind: 'unreadable',
			message: 'a session cookie needs a SteamID made of digits'
		});
	}
	if (accessToken === '' || /[\s;]/.test(accessToken)) {
		// A token containing a semicolon or whitespace would terminate the cookie
		// early and silently send a different session than intended.
		throw new ConfirmationProtocolError({
			kind: 'unreadable',
			message: 'that access token is not a value a cookie can carry'
		});
	}

	return `steamLoginSecure=${steamId64}%7C%7C${encodeURIComponent(accessToken)}`;
}
