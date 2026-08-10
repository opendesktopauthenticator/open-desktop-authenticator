import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { registerSecret } from './redact';
import { countSessionObjects, membersNamed, outsideSession, sessionBody } from './jsonspan';

/**
 * SDA maFile parsing (§12 F2).
 *
 * Two things make this harder than "JSON.parse and read the fields":
 *
 * 1. SDA writes `Session.SteamID` as a JSON *number*. A SteamID64 such as
 *    76561199999999999 is larger than Number.MAX_SAFE_INTEGER (9007199254740991),
 *    so `JSON.parse` silently rounds it to a different account's ID. We therefore
 *    pull the SteamID out of the raw text as digits, and never trust the parsed
 *    number. See `extractSteamId64`.
 *
 * 2. Field presence varies across SDA versions and third-party tools. Only
 *    shared_secret / identity_secret / account_name are required (§12 F2);
 *    everything else degrades to a warning.
 */

/** Largest integer a double can represent exactly. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const SessionSchema = z.object({
	SteamID: z.union([z.number(), z.string()]).optional(),
	/** Stored web cookie. With a live AccessToken this alone can drive mobileconf. */
	SteamLoginSecure: z.string().optional(),
	/**
	 * Present in files written by session-managing tools. A live refresh token
	 * lets us establish a web session without ever handling the password (§11 S8),
	 * which is strictly better than prompting for one.
	 */
	RefreshToken: z.string().optional(),
	AccessToken: z.string().optional(),
	/**
	 * Real-world extension: some tooling stores per-account proxy routing inside
	 * the maFile itself. Not an SDA field, but common enough to honour.
	 */
	proxy: z.string().optional(),
	proxy_type: z.string().optional()
});

const MaFileSchema = z.object({
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
	Session: SessionSchema.optional()
});

export interface ParsedMaFile {
	sourcePath: string;
	accountName: string;
	sharedSecret: string;
	identitySecret: string;
	/** Present only if the file carried one. Absent means "no revocation code on file" (§12 F2). */
	revocationCode?: string;
	/** Present only if the file carried one. Absent means we derive it (§10.4). */
	deviceId?: string;
	/** Exact digits, never round-tripped through a JS number. May be absent. */
	steamId64?: string;
	/** How steamId64 was obtained, for the import report. */
	steamIdSource?: 'Session.SteamID' | 'steamid' | 'filename';
	fullyEnrolled?: boolean;
	/** A stored refresh token, if the file carried a live one. */
	refreshToken?: string;
	/** Short-lived access token, usable for mobileconf while it lasts. */
	accessToken?: string;
	/** Stored web session cookie value (`steamid||token`, URL-encoded). */
	steamLoginSecure?: string;
	/** Proxy URL stored in the file itself, used unless env overrides it. */
	proxy?: string;
	warnings: string[];
}

/**
 * Recover a SteamID64 from raw file text without going through JSON.parse.
 *
 * Matches `"SteamID": 76561199999999999` and the quoted variant, capturing the
 * digits verbatim. Returns undefined if the key is absent.
 */
function extractSteamId64(
	raw: string,
	key: string
): { value: string; quoted: boolean } | undefined {
	// The backreference makes the closing quote match the opening one, so a
	// quoted and an unquoted value are told apart rather than both accepted.
	const pattern = new RegExp(`"${key}"\\s*:\\s*("?)(\\d{5,25})\\1`);
	const match = pattern.exec(raw);
	if (!match?.[2]) {
		return undefined;
	}
	return { value: match[2], quoted: match[1] === '"' };
}

/**
 * `Session.SteamID` specifically — searched inside the Session object only.
 *
 * Searching the whole document found the first `"SteamID"` anywhere, so a file
 * with a top-level `"SteamID"` yielded that value while still reporting the
 * source as `Session.SteamID`: wrong ID, wrong label, no warning.
 */
function extractSessionSteamId(raw: string): { value: string; quoted: boolean } | undefined {
	const body = sessionBody(raw);
	if (body === undefined) {
		return undefined;
	}

	// The LAST direct member named SteamID, matching what JSON.parse resolves to.
	// Taking the first disagreed with our own zod parse of the same bytes, which
	// is the rule jsonspan.ts exists to enforce. Direct members only, so a
	// `Session.meta.SteamID` cannot masquerade as the real one.
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
 * Read the `aud` (audience) claim from a Steam JWT.
 *
 * This matters more than it looks. Steam scopes tokens per platform:
 *   web/client login  -> aud: ["client", "web"]
 *   mobile refresh    -> aud: ["web", "renew", "derive", "mobile"]
 *
 * Mobile confirmations require a token scoped for `mobile`. A stored access
 * token from a web session cannot drive mobileconf no matter how valid it is.
 */
export function jwtAudience(token: string): string[] {
	const payload = token.split('.')[1];
	if (!payload) {
		return [];
	}
	try {
		const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
			aud?: string[] | string;
		};
		if (Array.isArray(decoded.aud)) {
			return decoded.aud;
		}
		return typeof decoded.aud === 'string' ? [decoded.aud] : [];
	} catch {
		return [];
	}
}

/**
 * Read the `exp` claim from a Steam JWT.
 *
 * The payload is unauthenticated metadata — we use it only to decide whether
 * attempting a token login is worth it, never to make a trust decision.
 */
export function jwtExpiry(token: string): Date | undefined {
	const payload = token.split('.')[1];
	if (!payload) {
		return undefined;
	}
	try {
		const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
			exp?: number;
		};
		return typeof decoded.exp === 'number' ? new Date(decoded.exp * 1000) : undefined;
	} catch {
		return undefined;
	}
}

export class MaFileError extends Error {
	constructor(
		message: string,
		readonly sourcePath: string
	) {
		super(message);
		this.name = 'MaFileError';
	}
}

export function parseMaFile(sourcePath: string): ParsedMaFile {
	let raw: string;
	try {
		raw = readFileSync(sourcePath, 'utf8');
	} catch (err) {
		throw new MaFileError(
			`could not read file: ${err instanceof Error ? err.message : String(err)}`,
			sourcePath
		);
	}

	// SDA files are sometimes written with a UTF-8 BOM.
	const text = raw.replace(/^﻿/, '').trim();

	if (text.startsWith('{') === false) {
		throw new MaFileError(
			'file is not JSON. If this came from an SDA install with encryption enabled, ' +
				'it is an encrypted manifest — that format lands in milestone 0.2, not the spike.',
			sourcePath
		);
	}

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		throw new MaFileError(
			`file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			sourcePath
		);
	}

	const result = MaFileSchema.safeParse(json);
	if (!result.success) {
		const detail = result.error.issues
			.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('; ');
		throw new MaFileError(`does not look like a valid maFile — ${detail}`, sourcePath);
	}

	const data = result.data;
	const warnings: string[] = [];

	// Register secrets before anything can print them.
	registerSecret(data.shared_secret);
	registerSecret(data.identity_secret);
	// Forced: `R#####` is six characters, below the default threshold, and it is
	// the one secret whose loss is unrecoverable.
	registerSecret(data.revocation_code, { force: true });
	registerSecret(data.Session?.RefreshToken);
	registerSecret(data.Session?.AccessToken);
	registerSecret(data.Session?.SteamLoginSecure);
	if (data.Session?.proxy) {
		// May carry proxy credentials; proxy.ts registers those properly on parse.
		registerSecret(data.Session.proxy);
	}

	// --- SteamID recovery, in order of trustworthiness -----------------------
	let steamId64: string | undefined;
	let steamIdSource: ParsedMaFile['steamIdSource'];
	/** Only an unquoted JSON number is at risk of precision loss. */
	let storedAsNumber = false;

	const fromSession = extractSessionSteamId(text);
	// Top-level lookups must not see inside Session, or they would match its keys.
	const fromTopLevel = extractSteamId64(outsideSession(text), 'steamid');
	const fromFilename = basename(sourcePath).replace(/\.maFile$/i, '');

	if (fromSession && looksLikeSteamId64(fromSession.value)) {
		steamId64 = fromSession.value;
		steamIdSource = 'Session.SteamID';
		storedAsNumber = !fromSession.quoted;
	} else if (fromTopLevel && looksLikeSteamId64(fromTopLevel.value)) {
		steamId64 = fromTopLevel.value;
		steamIdSource = 'steamid';
		storedAsNumber = !fromTopLevel.quoted;
	} else if (looksLikeSteamId64(fromFilename)) {
		steamId64 = fromFilename;
		steamIdSource = 'filename';
		warnings.push(
			'SteamID was taken from the filename — the file itself did not contain a usable one.'
		);
	} else {
		warnings.push('no SteamID in this file. It will have to be resolved at first login (§12 F2).');
	}

	// Warn only when the value was actually at risk. A quoted SteamID survives
	// JSON.parse intact, and crying wolf on those would train the reader to
	// ignore the warning on the files where it genuinely matters.
	if (storedAsNumber && steamId64 && BigInt(steamId64) > MAX_SAFE) {
		const roundTripped = String(Number(steamId64));
		if (roundTripped !== steamId64) {
			warnings.push(
				`SteamID ${steamId64} was stored as an unquoted JSON number and exceeds JS ` +
					`safe-integer range; a naive JSON.parse would have read it as ${roundTripped}. ` +
					'Parsed from raw text instead.'
			);
		}
	}

	if (!data.revocation_code) {
		warnings.push(
			'NO REVOCATION CODE in this file. If you lose this authenticator you cannot ' +
				'self-recover the account. Flagged per §12 F2.'
		);
	}

	if (!data.device_id) {
		warnings.push('no device_id in this file; it will be derived from the SteamID (§10.4).');
	}

	// A file with more than one `Session` key is malformed. We still read it —
	// using the last, exactly as JSON.parse and every other tool in the ecosystem
	// does — but the user is told, because nothing else about the file will hint
	// at it and write-back will refuse to touch it.
	const sessionCount = countSessionObjects(text);
	if (sessionCount > 1) {
		warnings.push(
			`this file contains ${sessionCount} "Session" objects. Reading the last one, which is ` +
				'what JSON parsers do — but the file is malformed, saving tokens back to it will be ' +
				'refused, and you should clean it up.'
		);
	}

	if (data.fully_enrolled === false) {
		warnings.push('fully_enrolled is false — this authenticator may never have been activated.');
	}

	if (data.Session?.RefreshToken) {
		const expiry = jwtExpiry(data.Session.RefreshToken);
		if (expiry === undefined) {
			warnings.push('a RefreshToken is present but could not be decoded; ignoring it.');
		} else if (expiry.getTime() <= Date.now()) {
			warnings.push(
				`the stored RefreshToken EXPIRED on ${expiry.toISOString()}. A password login is ` +
					'required to get a new one.'
			);
		} else {
			warnings.push(
				`a live RefreshToken is on file (expires ${expiry.toISOString()}) — a session can be ` +
					'established without the account password.'
			);
		}
	}

	const parsed: ParsedMaFile = {
		sourcePath,
		accountName: data.account_name,
		sharedSecret: data.shared_secret,
		identitySecret: data.identity_secret,
		warnings
	};

	if (data.revocation_code !== undefined) parsed.revocationCode = data.revocation_code;
	if (data.device_id !== undefined) parsed.deviceId = data.device_id;
	// Kept only if it is actually usable — decodable AND unexpired.
	//
	// An expired token is a dead credential: every caller re-checks the expiry and
	// falls back anyway, so carrying it achieves nothing except keeping a stale
	// secret in memory and routing every run through the "expired, falling back"
	// branch. The parse-time warning above already tells the user why.
	if (data.Session?.RefreshToken) {
		const expiry = jwtExpiry(data.Session.RefreshToken);
		if (expiry && expiry.getTime() > Date.now()) {
			parsed.refreshToken = data.Session.RefreshToken;
		}
	}
	// Same rule as the refresh token, symmetrically: decodable AND unexpired.
	// Keeping an expired access token was inconsistent with the refresh-token
	// policy and left a dead credential in memory for callers that re-check the
	// expiry a moment later anyway.
	if (data.Session?.AccessToken) {
		const accessExpiry = jwtExpiry(data.Session.AccessToken);
		if (accessExpiry && accessExpiry.getTime() > Date.now()) {
			parsed.accessToken = data.Session.AccessToken;
		}
	}
	if (data.Session?.SteamLoginSecure) parsed.steamLoginSecure = data.Session.SteamLoginSecure;
	if (data.Session?.proxy) parsed.proxy = data.Session.proxy;
	if (steamId64 !== undefined) parsed.steamId64 = steamId64;
	if (steamIdSource !== undefined) parsed.steamIdSource = steamIdSource;
	if (data.fully_enrolled !== undefined) parsed.fullyEnrolled = data.fully_enrolled;

	return parsed;
}
