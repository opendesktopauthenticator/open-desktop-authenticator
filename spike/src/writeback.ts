import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { log } from './redact';
import { findSessionSpan, membersNamed } from './jsonspan';

/**
 * Persist refreshed session tokens back into a maFile.
 *
 * This is the ONLY thing in the spike that writes to disk, and it writes to a
 * file that already contains the account's shared_secret, identity_secret and
 * revocation_code. That file is frequently the only copy of the revocation code
 * in existence, so a botched write is not "lose a token", it is "lose the
 * ability to recover the account". The care below is proportionate to that.
 *
 * Three rules:
 *
 * 1. **Never round-trip through JSON.parse/stringify.** SDA stores SteamID as an
 *    unquoted number larger than Number.MAX_SAFE_INTEGER (F-01), so parsing and
 *    re-serialising would silently rewrite it to a different account's ID. It
 *    would also drop every field our zod schema does not model (`secret_1`,
 *    `error_sch`, `token_gid`, whatever a future tool adds). We do surgical text
 *    replacement instead: the file comes out byte-identical except the tokens.
 *
 * 2. **Atomic.** Write a temp file, fsync it, rename over the original. A crash
 *    mid-write leaves the original intact, never a half-written file.
 *
 * 3. **Verify, then roll back.** After writing we re-read and re-validate. If
 *    anything is wrong the original is restored from the backup.
 */

export interface TokenUpdate {
	refreshToken?: string | undefined;
	accessToken?: string | undefined;
	steamLoginSecure?: string | undefined;
}

export type WriteBackResult =
	| { status: 'written'; fields: string[]; backupPath: string }
	| { status: 'unchanged' }
	| { status: 'disabled' }
	| { status: 'skipped'; reason: string };

/** Fields we are willing to touch. Anything else in the file is untouchable. */
const WRITABLE = ['RefreshToken', 'AccessToken', 'SteamLoginSecure'] as const;
type WritableField = (typeof WRITABLE)[number];

/**
 * Session-object location lives in `jsonspan.ts`, shared with the parser.
 *
 * Both were independently getting the same bug: a whole-file regex matches the
 * FIRST occurrence of a key, while `JSON.parse` resolves duplicates to the LAST.
 * `findSessionSpan` also refuses a document containing more than one `Session`
 * object, because editing the first while consumers read the last is a silent
 * write to an object nobody reads.
 */
export { findSessionSpan } from './jsonspan';

/**
 * Replace a string-valued field inside the `Session` object, or insert it if the
 * key is absent. Returns the original text unchanged when there is no
 * well-formed Session object to write into.
 */
/**
 * Why a field cannot be written, or undefined if it can.
 *
 * Exported so `persistTokens` can consult it BEFORE deciding a file is
 * unchanged. Without that, a duplicate key whose *first* occurrence already held
 * the new value was reported `unchanged` while `JSON.parse` still resolved to the
 * stale second one — the write silently never happened.
 */
export function fieldWriteBlocker(raw: string, field: WritableField): string | undefined {
	const span = findSessionSpan(raw);
	if (!span) {
		return 'there is not exactly one well-formed Session object';
	}
	const members = membersNamed(raw.slice(span.start, span.end), field);
	if (!members) {
		return 'the Session object could not be parsed into members';
	}
	if (members.length > 1) {
		// We would rewrite one; JSON.parse resolves to another.
		return `Session contains ${members.length} "${field}" keys, so which one counts is ambiguous`;
	}
	return undefined;
}

export function setSessionField(raw: string, field: WritableField, value: string): string {
	if (fieldWriteBlocker(raw, field)) {
		return raw;
	}

	const span = findSessionSpan(raw);
	if (!span) {
		return raw;
	}

	const body = raw.slice(span.start, span.end);
	const encoded = JSON.stringify(value);
	const existing = membersNamed(body, field)?.[0];

	if (existing) {
		// Replace the value in place, whatever its type. Matching only quoted
		// values used to send a numeric token down the insert path, producing a
		// duplicate key that JSON.parse then resolved the wrong way.
		//
		// Refuse an object or array rather than overwrite something structured we
		// were never asked to own.
		const current = body.slice(existing.valueStart, existing.valueEnd).trimStart();
		if (current.startsWith('{') || current.startsWith('[')) {
			return raw;
		}
		const updatedBody =
			body.slice(0, existing.valueStart) + encoded + body.slice(existing.valueEnd);
		return raw.slice(0, span.start) + updatedBody + raw.slice(span.end);
	}

	// Absent — insert as the first member. A trailing comma is only valid when
	// something follows it, so an empty Session gets none.
	const hasExistingKeys = body.trim().length > 0;
	const inserted = `\n    ${JSON.stringify(field)}: ${encoded}${hasExistingKeys ? ',' : '\n  '}`;
	return raw.slice(0, span.start) + inserted + body + raw.slice(span.end);
}

/**
 * The field's current value, JSON-decoded.
 *
 * Decoding matters: the regex captures the escaped source text, so comparing it
 * directly against a raw value makes anything containing a quote or backslash
 * look permanently mismatched. Real tokens are JWTs and never hit that, which is
 * exactly why it would have gone unnoticed.
 */
function currentValue(raw: string, field: WritableField): string | undefined {
	// Scoped to the Session body for the same reason as setSessionField: reading
	// a same-named key elsewhere in the file would make the verification step
	// confirm a write that never landed where it mattered.
	const span = findSessionSpan(raw);
	if (!span) {
		return undefined;
	}
	const body = raw.slice(span.start, span.end);
	const members = membersNamed(body, field);
	// Exactly one direct member, or there is nothing unambiguous to report.
	if (!members || members.length !== 1) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(body.slice(members[0]!.valueStart, members[0]!.valueEnd));
		return typeof parsed === 'string' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Write updated tokens into `sourcePath`.
 *
 * Set SPIKE_NO_WRITEBACK=1 to disable entirely.
 */
export function persistTokens(sourcePath: string, update: TokenUpdate): WriteBackResult {
	if (process.env.SPIKE_NO_WRITEBACK === '1') {
		return { status: 'disabled' };
	}

	let original: string;
	try {
		original = readFileSync(sourcePath, 'utf8');
	} catch (err) {
		return {
			status: 'skipped',
			reason: `could not read the file: ${err instanceof Error ? err.message : String(err)}`
		};
	}

	// Refuse to touch anything that is not the JSON we think it is. An encrypted
	// SDA manifest, for instance, must never be "surgically edited".
	if (!original.trimStart().startsWith('{')) {
		return { status: 'skipped', reason: 'the file is not plain JSON' };
	}
	if (!/"Session"\s*:\s*\{/.test(original)) {
		return { status: 'skipped', reason: 'the file has no Session object to write into' };
	}

	const pending: Array<[WritableField, string]> = [];
	const candidates: Array<[WritableField, string | undefined]> = [
		['RefreshToken', update.refreshToken],
		['AccessToken', update.accessToken],
		['SteamLoginSecure', update.steamLoginSecure]
	];
	for (const [field, value] of candidates) {
		if (!value) {
			continue;
		}
		// Ambiguity is checked BEFORE "is it already correct". Otherwise a
		// duplicate key whose first occurrence already held the new value looked
		// unchanged, while JSON.parse still resolved to the stale second one — the
		// write silently never happened and the caller was told nothing needed doing.
		const blocker = fieldWriteBlocker(original, field);
		if (blocker) {
			return { status: 'skipped', reason: blocker };
		}
		if (currentValue(original, field) !== value) {
			pending.push([field, value]);
		}
	}

	if (pending.length === 0) {
		return { status: 'unchanged' };
	}

	let updated = original;
	for (const [field, value] of pending) {
		updated = setSessionField(updated, field, value);
	}

	// Guard against a regex that silently matched nothing.
	for (const [field, value] of pending) {
		if (currentValue(updated, field) !== value) {
			return { status: 'skipped', reason: `could not place ${field} into the file safely` };
		}
	}

	// Parse-check the result. We never write it back, but it must still be valid
	// JSON — this catches a malformed insertion before it reaches disk.
	try {
		JSON.parse(updated);
	} catch (err) {
		return {
			status: 'skipped',
			reason: `the edit would have produced invalid JSON (${err instanceof Error ? err.message : String(err)})`
		};
	}

	const backupPath = `${sourcePath}.bak`;
	const tempPath = `${sourcePath}.tmp`;

	try {
		// Keep exactly one backup: the last known-good version.
		copyFileSync(sourcePath, backupPath);

		const fd = openSync(tempPath, 'w');
		try {
			writeSync(fd, updated, 0, 'utf8');
			fsyncSync(fd); // durable before the rename, or the atomicity is a lie
		} finally {
			closeSync(fd);
		}
		renameSync(tempPath, sourcePath);

		// Verify what actually landed.
		const readBack = readFileSync(sourcePath, 'utf8');
		if (readBack !== updated) {
			throw new Error('file on disk does not match what we wrote');
		}
		JSON.parse(readBack);
	} catch (err) {
		// Roll back to the backup rather than leave a damaged maFile.
		try {
			if (existsSync(backupPath)) {
				copyFileSync(backupPath, sourcePath);
			}
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
		} catch {
			/* nothing further we can safely do */
		}
		return {
			status: 'skipped',
			reason: `write failed and the original was restored: ${err instanceof Error ? err.message : String(err)}`
		};
	}

	return { status: 'written', fields: pending.map(([f]) => f), backupPath };
}

/** Report the outcome without ever printing a token. */
export function reportWriteBack(sourcePath: string, result: WriteBackResult): void {
	switch (result.status) {
		case 'written':
			log.info(
				`  saved ${result.fields.join(', ')} back to the maFile (backup: ${result.backupPath})`
			);
			break;
		case 'unchanged':
			break;
		case 'disabled':
			log.info('  token write-back disabled (SPIKE_NO_WRITEBACK=1)');
			break;
		case 'skipped':
			log.warn(`could not save tokens to ${sourcePath}: ${result.reason}`);
			break;
	}
}
