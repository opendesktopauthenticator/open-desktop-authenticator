import { z } from 'zod';
import { CONFIRMATION_TAGS, type ConfirmationTag } from './key';

/**
 * The mobileconf wire protocol (§12 F5).
 *
 * Pure request-building and response-parsing. No sockets, no proxy, no clock —
 * every one of those is the caller's, which is what makes the rules here
 * testable without an account and without a network.
 *
 * Steam publishes none of this. The shapes below are what Phase 0 observed
 * against live accounts, so they are written to **tolerate additions and refuse
 * surprises**: unknown fields on a confirmation are ignored, but a response that
 * is not recognisably a confirmation list is an error rather than an empty list.
 * An authenticator that silently shows "no confirmations pending" when it in
 * fact failed to ask is worse than one that says it is broken.
 */

const BASE = 'https://steamcommunity.com/mobileconf';

/** Identifies the client to Steam. `react` is what the current mobile app sends. */
const CLIENT_MODE = 'react';

/**
 * Attacker-controlled text is capped before it is stored or shown.
 *
 * `headline` and `summary` come from whoever created the trade. React escapes
 * markup, so this is not about injection — it is about a counterparty being
 * unable to push a megabyte of text through the UI, the vault, or a log line.
 */
const MAX_TEXT = 512;
const cappedText = z
	.string()
	.transform((value) => (value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value));

/**
 * One pending confirmation.
 *
 * `id` and `nonce` are strings on the wire and stay strings: `id` is a 64-bit
 * value and `nonce` is opaque. Neither is ours to reinterpret, and turning
 * either into a number is the F-01 mistake in a new place.
 */
export const confirmationSchema = z
	.object({
		/**
		 * Strings only. Accepting a number and calling `String()` on it looks
		 * tolerant and is the F-01 mistake wearing a disguise: by the time zod sees
		 * the value, `JSON.parse` has already rounded it, so the coercion preserves
		 * a number that is no longer the one Steam sent. Acting on a mangled id
		 * means acting on the wrong confirmation, so an unexpected shape is refused
		 * rather than papered over.
		 */
		id: z.string().min(1),
		nonce: z.string().min(1),
		/** Numeric type. S16 in `policy.ts` decides what may be done with it. */
		type: z.number().int(),
		/** Steam's own label. Displayed alongside ours, never trusted in place of `type`. */
		type_name: cappedText.optional(),
		/**
		 * Display only, and a SteamID64 — comfortably past the safe-integer range.
		 * A numeric one is dropped rather than shown, because a counterparty id
		 * that is quietly wrong is worse than none at all.
		 */
		creator_id: z.string().optional().catch(undefined),
		headline: cappedText.optional(),
		summary: z.array(cappedText).max(20).optional(),
		/**
		 * Item or avatar image, on Steam's CDN.
		 *
		 * Parsed so it is accounted for, and deliberately **never handed to the
		 * renderer as an image source.** A remote `<img>` is a request the renderer
		 * makes directly, outside the per-account transport — so it would leave from
		 * the user's real address for an account routed through a proxy, and tell
		 * Steam's CDN exactly which confirmations were being looked at. Rendering it
		 * would defeat the routing guarantee at the one moment the user is
		 * definitely looking at the screen.
		 */
		icon: z.string().max(2048).optional(),
		/** Whether this confirmation covers several items rather than one. */
		multi: z.boolean().optional(),
		/**
		 * Unix seconds, as Steam sends it. Some responses send it as a string.
		 *
		 * Worth having: "pending since" is how a user notices a confirmation they
		 * did not create. A trade that appeared while they were asleep is the shape
		 * of an account takeover.
		 */
		creation_time: z.union([z.number().int(), z.string()]).optional().catch(undefined)
	})
	// Additions are Valve's to make. Dropping unknown fields is fine here — unlike
	// the vault, nothing is persisted from this shape.
	.passthrough();

export type Confirmation = z.infer<typeof confirmationSchema>;

const listResponseSchema = z.object({
	success: z.boolean(),
	/**
	 * Deliberately **not** `z.array(confirmationSchema)`.
	 *
	 * A typed array here is all-or-nothing: one entry Steam sent in an unexpected
	 * shape fails the whole parse, and the user is shown nothing at all. See
	 * `parseListResponse` for why that is the wrong trade on this particular list.
	 */
	conf: z.array(z.unknown()).optional(),
	needauth: z.boolean().optional(),
	message: z.string().max(1024).optional(),
	detail: z.string().max(1024).optional()
});

const operationResponseSchema = z.object({
	success: z.boolean(),
	needauth: z.boolean().optional(),
	message: z.string().max(1024).optional()
});

/** Why a mobileconf call did not produce an answer. */
export type ConfirmationFailure =
	/** The web session is gone or was never mobile-scoped. Sign in again. */
	| { kind: 'sessionExpired'; message: string }
	/** Steam answered, and said no. */
	| { kind: 'steamRefused'; message: string }
	/** Steam answered with something we cannot read — an HTML error page, usually. */
	| { kind: 'unreadable'; message: string };

export class ConfirmationProtocolError extends Error {
	readonly failure: ConfirmationFailure;

	constructor(failure: ConfirmationFailure) {
		super(failure.message);
		this.name = 'ConfirmationProtocolError';
		this.failure = failure;
	}
}

/** Everything a signed mobileconf request needs, minus the operation itself. */
export interface RequestIdentity {
	steamId64: string;
	deviceId: string;
	/** Steam-corrected time the key was signed for. Sent alongside it. */
	unixSeconds: number;
	key: string;
	tag: ConfirmationTag;
}

/** The shared query parameters every mobileconf endpoint expects. */
function identityParams(identity: RequestIdentity): Record<string, string> {
	return {
		p: identity.deviceId,
		a: identity.steamId64,
		k: identity.key,
		t: String(identity.unixSeconds),
		m: CLIENT_MODE,
		tag: identity.tag
	};
}

/** The URL that lists pending confirmations. */
export function buildListUrl(identity: RequestIdentity): string {
	if (identity.tag !== CONFIRMATION_TAGS.list) {
		// The tag is what the key was signed over. Sending a key minted for one
		// operation under another's name does not merely fail — it is the mistake
		// the tag exists to prevent, so it is refused here rather than by Steam.
		throw new ConfirmationProtocolError({
			kind: 'unreadable',
			message: `a confirmation list needs a key signed with the "list" tag, not "${identity.tag}"`
		});
	}

	const url = new URL(`${BASE}/getlist`);
	for (const [name, value] of Object.entries(identityParams(identity))) {
		url.searchParams.set(name, value);
	}
	return url.toString();
}

/** Accept or deny. `allow` and `cancel` are Steam's words for it. */
export type ConfirmationAction = 'allow' | 'cancel';

/** The tag that must have signed the key for a given action. */
export function tagForAction(action: ConfirmationAction): ConfirmationTag {
	return action === 'allow' ? CONFIRMATION_TAGS.accept : CONFIRMATION_TAGS.reject;
}

/**
 * The form body that acts on one or more confirmations.
 *
 * Steam takes parallel `cid[]` / `ck[]` arrays. They are built together from a
 * single list so the two cannot drift out of step — a mismatched pair would act
 * on a confirmation the caller never chose.
 */
export function buildOperationBody(
	identity: RequestIdentity,
	action: ConfirmationAction,
	confirmations: readonly { id: string; nonce: string }[]
): URLSearchParams {
	if (identity.tag !== tagForAction(action)) {
		throw new ConfirmationProtocolError({
			kind: 'unreadable',
			message: `acting with "${action}" needs a key signed with the "${tagForAction(action)}" tag, not "${identity.tag}"`
		});
	}
	if (confirmations.length === 0) {
		throw new ConfirmationProtocolError({
			kind: 'unreadable',
			message: 'refusing to send a confirmation operation that names nothing'
		});
	}

	const body = new URLSearchParams({ ...identityParams(identity), op: action });
	for (const confirmation of confirmations) {
		body.append('cid[]', confirmation.id);
		body.append('ck[]', confirmation.nonce);
	}
	return body;
}

/** Where an operation is POSTed. */
export function operationUrl(): string {
	return `${BASE}/multiajaxop`;
}

/**
 * A confirmation list, and the count of what could not be read.
 *
 * Two fields rather than a bare array because `unreadable` is not a diagnostic
 * — it is the difference between "you have nothing pending" and "there is
 * something here we could not read". A caller that drops it is making the second
 * look like the first.
 */
export interface ConfirmationList {
	confirmations: Confirmation[];
	/** Entries Steam sent that this version could not parse. */
	unreadable: number;
}

/**
 * Read a `getlist` response.
 *
 * ## Entries are validated one at a time, on purpose
 *
 * The envelope is still all-or-nothing — a reply that is not recognisably a
 * confirmation list throws, and always should. But the **entries** inside it are
 * parsed individually, and one that fails no longer takes the others with it.
 *
 * This started as `z.array(confirmationSchema)`, which reads as the stricter and
 * therefore safer choice. It is the opposite here. Refusing the whole list is
 * fail-closed for a *trade* — nothing gets approved — and fail-blind for the
 * thing this application most needs to show: `policy.ts` calls an account
 * recovery confirmation "the single most urgent thing this application can show
 * anybody", and under the old rule a single malformed sibling entry hid it
 * completely.
 *
 * Nor does that need an attacker. Any shape Valve changes — a `type` sent as a
 * string, an `icon` URL past 2048 characters, a twenty-first summary line —
 * would empty **every user's** list at once, until a new build shipped, on an
 * application whose one job is confirmations.
 *
 * What must not happen is a silent drop, so the count comes back with the list
 * and the screen says so. The original rule holds in the form that mattered:
 * "nothing pending" and "we could not read it" still never look the same.
 *
 * @throws ConfirmationProtocolError when the response as a whole is not a
 * confirmation list, or Steam refused it.
 */
export function parseListResponse(raw: string): ConfirmationList {
	const parsed = readJson(raw);
	const result = listResponseSchema.safeParse(parsed);

	if (!result.success) {
		throw new ConfirmationProtocolError({
			kind: 'unreadable',
			message: 'Steam sent a confirmation list in a shape this version does not understand.'
		});
	}

	// `needauth` is authoritative even when `success` is true. Treating the pair
	// as an empty list would show "nothing pending" for a dead session — the
	// exact failure mode this parser exists to prevent.
	if (result.data.needauth) {
		throw refusal(true, result.data.message ?? result.data.detail);
	}
	if (!result.data.success) {
		throw refusal(result.data.needauth, result.data.message ?? result.data.detail);
	}

	// `success: true` with no `conf` is Steam's way of saying "none pending".
	const confirmations: Confirmation[] = [];
	let unreadable = 0;

	for (const entry of result.data.conf ?? []) {
		const parsedEntry = confirmationSchema.safeParse(entry);
		if (parsedEntry.success) {
			confirmations.push(parsedEntry.data);
		} else {
			// Counted, never described. The reason an entry failed is a schema detail;
			// what the user needs is that something is there and cannot be shown.
			unreadable += 1;
		}
	}

	return { confirmations, unreadable };
}

/** Read the response to an accept or deny. */
export function parseOperationResponse(raw: string): void {
	const parsed = readJson(raw);
	const result = operationResponseSchema.safeParse(parsed);

	if (!result.success) {
		throw new ConfirmationProtocolError({
			kind: 'unreadable',
			message:
				'Steam sent a reply this version does not understand; the confirmation may or may not have gone through.'
		});
	}

	if (result.data.needauth) {
		throw refusal(true, result.data.message);
	}
	if (!result.data.success) {
		throw refusal(result.data.needauth, result.data.message);
	}
}

function readJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// Overwhelmingly this is Steam's HTML sign-in page, served with HTTP 200,
		// which is what an expired session looks like from here.
		const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(raw);
		throw new ConfirmationProtocolError(
			looksLikeHtml
				? {
						kind: 'sessionExpired',
						message:
							'Steam returned a web page instead of an answer, which means the session is no longer valid. Sign in again.'
					}
				: {
						kind: 'unreadable',
						message: 'Steam returned something that is not a valid response.'
					}
		);
	}
}

function refusal(
	needauth: boolean | undefined,
	message: string | undefined
): ConfirmationProtocolError {
	if (needauth) {
		return new ConfirmationProtocolError({
			kind: 'sessionExpired',
			message: 'Steam no longer accepts this session. Sign in again.'
		});
	}
	return new ConfirmationProtocolError({
		kind: 'steamRefused',
		message: message ?? 'Steam refused the request without saying why.'
	});
}
