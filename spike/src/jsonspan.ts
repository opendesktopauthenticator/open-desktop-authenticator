/**
 * Locating the `Session` object inside raw maFile text.
 *
 * Shared by the parser and the write-back path because both were getting the
 * same class of bug independently: a regex run over the whole document matches
 * the FIRST occurrence of a key name anywhere, while `JSON.parse` resolves
 * duplicate keys to the LAST. Any code that reads one and writes the other is
 * quietly operating on a different object than its consumers.
 *
 * Everything here works on text rather than parsed JSON, because SDA writes
 * SteamID as an unquoted number larger than `Number.MAX_SAFE_INTEGER` (F-01) —
 * parsing first would corrupt it before we could look.
 */

/** Inclusive-exclusive span of the `Session` object's body. */
export interface Span {
	start: number;
	end: number;
}

const SESSION_KEY = /"Session"\s*:\s*\{/g;

/**
 * How many `"Session": {` openings the document contains.
 *
 * More than one means the file has duplicate keys. We take the first; JSON
 * consumers take the last. Rather than guess which the user meant, callers
 * refuse to touch such a file.
 */
export function countSessionObjects(raw: string): number {
	SESSION_KEY.lastIndex = 0;
	let count = 0;
	while (SESSION_KEY.exec(raw) !== null) {
		count++;
	}
	return count;
}

/**
 * Body span of the `Session` object, or undefined when there is not exactly one
 * well-formed object to point at.
 *
 * **Use this for WRITING.** More than one `Session` key means the document is
 * ambiguous, and editing one while consumers read another is a silent write to
 * an object nobody reads. Refusing is the only honest option for a writer of
 * irreplaceable secrets.
 *
 * Brace matching is string-aware, so a `}` inside a cookie value does not end
 * the object early.
 */
export function findSessionSpan(raw: string): Span | undefined {
	if (countSessionObjects(raw) !== 1) {
		return undefined;
	}
	return spanAt(raw, 0);
}

/**
 * Body span of the **last** `Session` object.
 *
 * **Use this for READING.** `JSON.parse` resolves duplicate keys to the last
 * occurrence, so every other tool in the ecosystem — and our own zod parse of
 * the same document — sees the last one. A reader that looked at the first would
 * disagree with itself about which object the file describes.
 *
 * Reading permissively and writing conservatively is deliberate: a user's maFile
 * may be their only copy, so we still extract what we can, while refusing to
 * write back into ambiguity.
 */
export function findLastSessionSpan(raw: string): Span | undefined {
	const count = countSessionObjects(raw);
	if (count === 0) {
		return undefined;
	}
	return spanAt(raw, count - 1);
}

/** Span of the Nth (zero-based) `Session` object's body. */
function spanAt(raw: string, index: number): Span | undefined {
	SESSION_KEY.lastIndex = 0;
	let open: RegExpExecArray | null = null;
	for (let i = 0; i <= index; i++) {
		open = SESSION_KEY.exec(raw);
		if (!open) {
			return undefined;
		}
	}
	if (!open) {
		return undefined;
	}

	const bodyStart = open.index + open[0].length;
	let depth = 1;
	let inString = false;
	let escaped = false;

	for (let i = bodyStart; i < raw.length; i++) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === '\\') {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return { start: bodyStart, end: i };
			}
		}
	}

	// Unbalanced braces — refuse rather than guess.
	return undefined;
}

/**
 * The `Session` body text as a **reader** sees it — the last one, matching
 * `JSON.parse`.
 */
export function sessionBody(raw: string): string | undefined {
	const span = findLastSessionSpan(raw);
	return span ? raw.slice(span.start, span.end) : undefined;
}

/** One direct member of an object body. */
export interface Member {
	key: string;
	valueStart: number;
	valueEnd: number;
}

/** Index after the JSON value starting at `from`, or undefined if malformed. */
function valueEnd(body: string, from: number): number | undefined {
	let i = from;
	while (i < body.length && /\s/.test(body[i] as string)) i++;
	if (i >= body.length) return undefined;

	const ch = body[i];

	if (ch === '"') {
		i++;
		while (i < body.length) {
			if (body[i] === '\\') {
				i += 2;
				continue;
			}
			if (body[i] === '"') return i + 1;
			i++;
		}
		return undefined;
	}

	if (ch === '{' || ch === '[') {
		const close = ch === '{' ? '}' : ']';
		let depth = 0;
		let inString = false;
		for (; i < body.length; i++) {
			const c = body[i];
			if (inString) {
				if (c === '\\') i++;
				else if (c === '"') inString = false;
				continue;
			}
			if (c === '"') inString = true;
			else if (c === ch) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) return i + 1;
			}
		}
		return undefined;
	}

	// Scalar: number, true, false, null.
	while (i < body.length && !/[,\s}\]]/.test(body[i] as string)) i++;
	return i;
}

/**
 * The **direct members** of an object body, in order.
 *
 * Depth matters as much as scope. Matching `"RefreshToken"` anywhere inside the
 * Session body also matched one nested in `Session.meta`, so a write landed on
 * the nested key and reported success while `Session.RefreshToken` stayed absent.
 * Only direct members are ours to read or rewrite.
 *
 * @returns undefined when the body is not a well-formed member list — callers
 * refuse rather than operate on a guess.
 */
export function topLevelMembers(body: string): Member[] | undefined {
	const members: Member[] = [];
	let i = 0;

	for (;;) {
		while (i < body.length && /[\s,]/.test(body[i] as string)) i++;
		if (i >= body.length) return members;

		if (body[i] !== '"') return undefined;

		const keyEnd = valueEnd(body, i);
		if (keyEnd === undefined) return undefined;
		let key: string;
		try {
			key = JSON.parse(body.slice(i, keyEnd)) as string;
		} catch {
			return undefined;
		}

		i = keyEnd;
		while (i < body.length && /\s/.test(body[i] as string)) i++;
		if (body[i] !== ':') return undefined;
		i++;

		let start = i;
		while (start < body.length && /\s/.test(body[start] as string)) start++;
		const end = valueEnd(body, i);
		if (end === undefined) return undefined;

		members.push({ key, valueStart: start, valueEnd: end });
		i = end;
	}
}

/** Direct members matching `key`, in document order. */
export function membersNamed(body: string, key: string): Member[] | undefined {
	const members = topLevelMembers(body);
	return members?.filter((m) => m.key === key);
}

/**
 * The document with every `Session` object's body blanked out, so a whole-file
 * search for a top-level key cannot accidentally match one nested inside a
 * Session — including a duplicate Session we are not reading from.
 */
export function outsideSession(raw: string): string {
	const count = countSessionObjects(raw);
	let out = raw;
	for (let i = 0; i < count; i++) {
		const span = spanAt(out, i);
		if (!span) {
			break;
		}
		out = out.slice(0, span.start) + ' '.repeat(span.end - span.start) + out.slice(span.end);
	}
	return out;
}
