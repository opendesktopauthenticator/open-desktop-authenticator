/**
 * Locating values inside raw maFile text, without parsing it first.
 *
 * Everything here works on text rather than parsed JSON, because SDA writes
 * `Session.SteamID` as an unquoted number larger than `Number.MAX_SAFE_INTEGER`
 * (F-01) — parsing first corrupts it into a *different account's* ID before
 * anything can look at it.
 *
 * Two rules were learned the hard way in the Phase 0 spike, one bug at a time:
 *
 *  - **Scope.** A regex over the whole document matches the first occurrence of
 *    a key anywhere, while `JSON.parse` resolves duplicate keys to the last. Any
 *    code that reads one while its consumers read the other is quietly working
 *    on a different object than it reports.
 *  - **Depth.** Matching a key anywhere inside the Session body also matches one
 *    nested in `Session.meta`. Only *direct* members are ours to read.
 *
 * Deliberately a re-implementation rather than an import from `/spike`: the
 * spike is throwaway reference code that never ships, and the application must
 * not depend on it. The tests are re-implemented too, for the same reason.
 */

/** Inclusive-exclusive span of an object's body. */
export interface Span {
	start: number;
	end: number;
}

const SESSION_KEY = /"Session"\s*:\s*\{/g;

/**
 * How many `"Session": {` openings the document contains.
 *
 * More than one means duplicate keys. We read the last, as JSON parsers do, and
 * say so — nothing else about the file would hint at it.
 */
export function countSessionObjects(raw: string): number {
	SESSION_KEY.lastIndex = 0;
	let count = 0;
	while (SESSION_KEY.exec(raw) !== null) {
		count++;
	}
	return count;
}

/** Body span of the Nth (zero-based) Session object, or undefined if malformed. */
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
 * The **last** Session object's body text, matching what `JSON.parse` resolves
 * duplicate keys to — and therefore what our own schema parse of the same bytes
 * sees. A reader that took the first would disagree with itself.
 */
export function sessionBody(raw: string): string | undefined {
	const count = countSessionObjects(raw);
	if (count === 0) {
		return undefined;
	}
	const span = spanAt(raw, count - 1);
	return span ? raw.slice(span.start, span.end) : undefined;
}

/** One direct member of an object body. */
export interface Member {
	key: string;
	valueStart: number;
	valueEnd: number;
}

/** Index just past the JSON value starting at `from`, or undefined if malformed. */
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
 * The direct members of an object body, in document order.
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
	return topLevelMembers(body)?.filter((member) => member.key === key);
}

/**
 * The document with every Session body blanked out, so a whole-file search for a
 * top-level key cannot match one nested inside a Session — including inside a
 * duplicate Session we are not reading from.
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
