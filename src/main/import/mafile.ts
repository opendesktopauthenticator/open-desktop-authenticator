import { z } from 'zod';
import { isUsableMobileToken, jwtAudience, jwtExpiry } from '../steam-jwt';
import { countSessionObjects, membersNamed, outsideSession, sessionBody } from './jsonspan';
import { planProxy } from '../net/egress';

/**
 * SDA maFile parsing (§12 F2).
 *
 * Harder than "JSON.parse and read the fields" for three reasons:
 *
 * 1. **SteamID precision.** SDA writes `Session.SteamID` as a JSON *number*, and
 *    a SteamID64 exceeds `Number.MAX_SAFE_INTEGER`. `JSON.parse` silently rounds
 *    it to a different account's ID (F-01). The digits are recovered from raw
 *    text and the parsed number is never trusted.
 * 2. **Field variance.** Presence differs across SDA versions and third-party
 *    tools. Only `shared_secret`, `identity_secret` and `account_name` are
 *    required; everything else degrades to a warning.
 * 3. **Credential-bearing files.** maFiles in the wild carry live sessions, not
 *    just seeds (F-11). Tokens are therefore filtered at this boundary rather
 *    than stored and discovered to be useless later.
 *
 * Operates on **text**, never on a path. File reading is the caller's job, which
 * keeps every rule here testable without touching a disk.
 */

/** Largest integer a double represents exactly. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// Proxy acceptance is NOT decided here. It used to be, against a list that had
// drifted from the network layer's — `socks:` was accepted at import and refused
// at egress, `socks4a:` the other way round — so a file could import cleanly and
// then fail on its first Steam request with an error pointing nowhere useful.
// `planProxy` is the one authority on what can actually be routed.

const sessionSchema = z.object({
	SteamID: z.union([z.number(), z.string()]).optional(),
	SteamLoginSecure: z.string().optional(),
	RefreshToken: z.string().optional(),
	AccessToken: z.string().optional(),
	/**
	 * Not an SDA field. Some ecosystem tooling stores per-account routing inside
	 * the maFile, and users expect it to survive an import (F-11).
	 */
	proxy: z.string().optional(),
	proxy_type: z.string().optional()
});

const maFileSchema = z.object({
	shared_secret: z.string().min(1, 'shared_secret is empty'),
	identity_secret: z.string().min(1, 'identity_secret is empty'),
	account_name: z.string().min(1, 'account_name is empty'),
	revocation_code: z.string().optional(),
	device_id: z.string().optional(),
	serial_number: z.union([z.number(), z.string()]).optional(),
	token_gid: z.string().optional(),
	uri: z.string().optional(),
	status: z.number().optional(),
	fully_enrolled: z.boolean().optional(),
	steamid: z.union([z.number(), z.string()]).optional(),
	Session: sessionSchema.optional()
});

export type SteamIdSource = 'Session.SteamID' | 'steamid' | 'filename';

/**
 * A parsed maFile, **including its secrets**. Main-process only; never crosses
 * IPC. The renderer sees `ImportCandidate` in `shared/ipc.ts` instead.
 */
export interface ParsedMaFile {
	accountName: string;
	sharedSecret: string;
	identitySecret: string;
	revocationCode?: string;
	deviceId?: string;
	/** Exact digits, never round-tripped through a JS number. */
	steamId64?: string;
	steamIdSource?: SteamIdSource;
	fullyEnrolled?: boolean;
	/** Kept only when MobileApp-scoped and unexpired — see `isUsableMobileToken`. */
	refreshToken?: string;
	/** Per-account routing carried by the file itself. */
	proxyUrl?: string;
	warnings: string[];
}

export class MaFileParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MaFileParseError';
	}
}

/**
 * The **last direct member** named `key` at the document's top level.
 *
 * This was a first-match regex, which is the same bug `Session.SteamID` had —
 * fixed there, and missed here. `RegExp.exec` returns the *first* occurrence
 * while `JSON.parse` resolves duplicate keys to the *last*, so a file carrying
 * two top-level `"steamid"` keys imported the account under a **different
 * account's ID**: silently, with no warning, and every downstream decision —
 * duplicate detection, confirmations, identity — then wrong. Same class as F-01
 * and just as damaging.
 *
 * Depth matters as well as order: a `steamid` nested inside some other object is
 * not the document's, so direct members only.
 */
function extractTopLevelSteamId(
	raw: string,
	key: string
): { value: string; quoted: boolean } | undefined {
	// Session bodies are already blanked by the caller so their keys cannot be
	// mistaken for the document's own. Strip the outer braces to leave a member
	// list that `topLevelMembers` can walk.
	const open = raw.indexOf('{');
	const close = raw.lastIndexOf('}');
	if (open === -1 || close <= open) {
		return undefined;
	}

	const body = raw.slice(open + 1, close);
	const members = membersNamed(body, key);
	const last = members?.[members.length - 1];
	if (!last) {
		return undefined;
	}

	const rawValue = body.slice(last.valueStart, last.valueEnd).trim();
	const quoted = rawValue.startsWith('"');
	const digits = quoted ? rawValue.slice(1, -1) : rawValue;
	return /^\d{5,25}$/.test(digits) ? { value: digits, quoted } : undefined;
}

/**
 * `Session.SteamID` specifically — the **last direct member** of the **last**
 * Session object.
 *
 * Both qualifiers are load-bearing. Searching the whole document found a
 * top-level `"SteamID"` while still reporting the source as `Session.SteamID`:
 * wrong ID, wrong label, no warning. Searching without depth awareness let a
 * `Session.meta.SteamID` masquerade as the real one.
 */
function extractSessionSteamId(raw: string): { value: string; quoted: boolean } | undefined {
	const body = sessionBody(raw);
	if (body === undefined) {
		return undefined;
	}

	const members = membersNamed(body, 'SteamID');
	const last = members?.[members.length - 1];
	if (!last) {
		return undefined;
	}

	const rawValue = body.slice(last.valueStart, last.valueEnd).trim();
	const quoted = rawValue.startsWith('"');
	const digits = quoted ? rawValue.slice(1, -1) : rawValue;
	return /^\d{5,25}$/.test(digits) ? { value: digits, quoted } : undefined;
}

/** A SteamID64 for an individual account is 17 digits starting with 7656119. */
function looksLikeSteamId64(value: string): boolean {
	return /^7656119\d{10}$/.test(value);
}

/**
 * Parse one maFile.
 *
 * @param text     the file's contents
 * @param fileName the file's base name, used only as the last SteamID fallback
 * @param nowMs    injected clock, so token-expiry rules are testable
 * @throws MaFileParseError when the file is not a maFile we can use at all.
 */
export function parseMaFile(text: string, fileName: string, nowMs: number): ParsedMaFile {
	// SDA files are sometimes written with a UTF-8 BOM. Spelled as an escape
	// rather than the literal character, which is invisible in every editor.
	const raw = text.replace(/^\uFEFF/, '').trim();

	if (!raw.startsWith('{')) {
		// Encrypted SDA files never reach here — the import service sets them aside
		// before parsing and asks for a passphrase instead. So anything that lands
		// on this branch is genuinely not a maFile, and saying "it might be
		// encrypted" would send the user looking for a password that does not exist.
		throw new MaFileParseError('this is not a maFile — it does not contain JSON.');
	}

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		throw new MaFileParseError(
			`not valid JSON: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	const result = maFileSchema.safeParse(json);
	if (!result.success) {
		const detail = result.error.issues
			.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('; ');
		throw new MaFileParseError(`does not look like a maFile — ${detail}`);
	}

	const data = result.data;
	const warnings: string[] = [];

	// --- SteamID, in order of trustworthiness ---------------------------------
	let steamId64: string | undefined;
	let steamIdSource: SteamIdSource | undefined;
	/** Only an unquoted JSON number was ever at risk of precision loss. */
	let storedAsNumber = false;

	const fromSession = extractSessionSteamId(raw);
	// Top-level lookups must not see inside a Session, or they match its keys.
	const fromTopLevel = extractTopLevelSteamId(outsideSession(raw), 'steamid');
	const fromFileName = fileName.replace(/\.maFile$/i, '');

	if (fromSession && looksLikeSteamId64(fromSession.value)) {
		steamId64 = fromSession.value;
		steamIdSource = 'Session.SteamID';
		storedAsNumber = !fromSession.quoted;
	} else if (fromTopLevel && looksLikeSteamId64(fromTopLevel.value)) {
		steamId64 = fromTopLevel.value;
		steamIdSource = 'steamid';
		storedAsNumber = !fromTopLevel.quoted;
	} else if (looksLikeSteamId64(fromFileName)) {
		steamId64 = fromFileName;
		steamIdSource = 'filename';
		warnings.push(
			'The SteamID came from the file name — the file itself did not contain a usable one.'
		);
	} else {
		warnings.push(
			'This file contains no SteamID, and the file name is not one either. It cannot be ' +
				'imported until the account is identified by signing in, which arrives in 0.2.'
		);
	}

	// Warn only where the value was genuinely at risk. A quoted SteamID survives
	// JSON.parse intact, and crying wolf on those trains the reader to ignore the
	// warning on the files where it actually matters.
	if (storedAsNumber && steamId64 && BigInt(steamId64) > MAX_SAFE) {
		const roundTripped = String(Number(steamId64));
		if (roundTripped !== steamId64) {
			warnings.push(
				`The SteamID was stored as an unquoted number beyond JavaScript's safe-integer ` +
					`range; a naive parse would have read it as ${roundTripped}, which is a different ` +
					'account. It was read from the raw text instead.'
			);
		}
	}

	// --- Everything else ------------------------------------------------------
	if (!data.revocation_code) {
		warnings.push(
			'NO REVOCATION CODE. If this authenticator is lost you cannot recover the account ' +
				'yourself — only Steam Support can.'
		);
	}

	if (countSessionObjects(raw) > 1) {
		warnings.push(
			`This file contains ${countSessionObjects(raw)} "Session" objects, so it is malformed. ` +
				'The last one was read, which is what JSON parsers do — but you should clean the ' +
				'file up.'
		);
	}

	if (data.fully_enrolled === false) {
		warnings.push('fully_enrolled is false — this authenticator may never have been activated.');
	}

	const parsed: ParsedMaFile = {
		accountName: data.account_name,
		sharedSecret: data.shared_secret,
		identitySecret: data.identity_secret,
		warnings
	};

	if (data.revocation_code !== undefined) parsed.revocationCode = data.revocation_code;
	if (data.device_id !== undefined) parsed.deviceId = data.device_id;
	if (steamId64 !== undefined) parsed.steamId64 = steamId64;
	if (steamIdSource !== undefined) parsed.steamIdSource = steamIdSource;
	if (data.fully_enrolled !== undefined) parsed.fullyEnrolled = data.fully_enrolled;

	const refreshToken = data.Session?.RefreshToken;
	if (refreshToken) {
		// Three ways a stored token is worthless, each with its own explanation:
		// undecodable, expired, or scoped for the web rather than the mobile app.
		// The third is the one that would otherwise be discovered much later, as an
		// unexplained confirmation failure (F-13).
		const expiry = jwtExpiry(refreshToken);
		if (!expiry) {
			warnings.push('A stored session token could not be read, so it was discarded.');
		} else if (expiry.getTime() <= nowMs) {
			warnings.push(
				`The stored session token expired on ${expiry.toISOString().slice(0, 10)}. You will ` +
					'be asked to sign in when this account is first used.'
			);
		} else if (!jwtAudience(refreshToken).includes('mobile')) {
			warnings.push(
				'The stored session token is scoped for the Steam website, not the mobile app. It ' +
					'cannot approve confirmations, so it was discarded — you will be asked to sign in.'
			);
		} else {
			parsed.refreshToken = refreshToken;
			warnings.push(
				`A usable session was imported with this account, valid until ` +
					`${expiry.toISOString().slice(0, 10)} — no password will be needed before then.`
			);
		}
		// Belt and braces: the store above must agree with the shared predicate that
		// every other caller uses to decide whether a token is worth attempting.
		if (parsed.refreshToken && !isUsableMobileToken(parsed.refreshToken, nowMs)) {
			delete parsed.refreshToken;
		}
	}

	const proxy = data.Session?.proxy;
	if (proxy) {
		if (safeProxyUrl(proxy)) {
			parsed.proxyUrl = proxy;
		} else {
			warnings.push(
				'The routing address stored in this file is not a usable proxy URL, so it was ' +
					'ignored. You can set one for this account afterwards.'
			);
		}
	}

	return parsed;
}

/** Whether the network layer could actually route through this. */
function safeProxyUrl(value: string): boolean {
	try {
		planProxy(value);
		return true;
	} catch {
		return false;
	}
}
