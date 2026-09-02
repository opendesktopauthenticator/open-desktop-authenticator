/**
 * Turning a stored proxy URL into something Chromium will actually honour.
 *
 * Pure, and separate from the transport, because the interesting failures here
 * are all decidable without a network: an unsupported scheme, credentials that
 * cannot be carried, a URL that is not one.
 *
 * ## Why Chromium at all
 *
 * The application runs in Electron, so it already contains Chromium's network
 * stack, and that stack proxies HTTP, HTTPS **and SOCKS5** per session. Measured
 * rather than assumed: with `proxyRules: 'socks5://127.0.0.1:1'` a request
 * resolves to `SOCKS5 127.0.0.1:1` and fails with `ERR_PROXY_CONNECTION_FAILED`
 * — it **fails closed**, reaching the internet not at all rather than falling
 * back to a direct connection. That is the property the anonymity promise
 * depends on, and it is why this needs no proxy-agent dependency (Q19).
 */

import { domainToASCII } from 'node:url';

/** Schemes we accept from a user or a maFile. */
/**
 * Schemes we accept from a user or a maFile.
 *
 * **`socks4a` is deliberately absent.** It is the SOCKS4 dialect that carries a
 * hostname instead of an address, and the two halves of this application
 * disagree about it: `socks-proxy-agent` honours it, while Chromium has no
 * `socks4a` rule at all and the nearest thing — `socks4` — resolves on the
 * machine's own resolver. Accepting it would mean sign-in resolving Steam at
 * the proxy while confirmations resolved it locally, which is precisely the
 * split this application spent a release closing. `socks5` is supported
 * everywhere, does remote DNS on both stacks, and is the answer.
 */
const SUPPORTED = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/**
 * Refused, with a reason rather than a shrug.
 *
 * **SOCKS4 cannot carry a hostname.** The protocol takes an IP address, so the
 * client resolves first and the lookup happens on the machine — every Steam
 * host this application contacts, in the clear, to whatever resolver the
 * network hands out. The proxy sees the connection; the ISP sees the question.
 *
 * That is not a corner case for this feature, it is the feature failing. The
 * routing screen's promise is that an account's traffic leaves by the address
 * the user chose, and the whole reason `Require proxies` exists is to make that
 * absolute rather than best-effort. A scheme that leaks which accounts are being
 * contacted, on every poll, cannot satisfy it.
 *
 * It was accepted before, with a comment noting the local resolution as a known
 * limitation. A known limitation that defeats the guarantee is not a limitation,
 * and the rest of this module already fails closed for far less — a window
 * refuses to open rather than fall back to the real address.
 *
 * Named separately from the unknown-scheme case so the error can say what to
 * use instead. Somebody with a working SOCKS4 endpoint almost always has SOCKS5
 * on the same host.
 */
const REFUSED_SCHEMES = new Map([
	[
		'socks4:',
		'SOCKS4 cannot look up hostnames through the proxy, so every Steam address would be ' +
			'resolved by this machine and visible to your network. Use socks5:// instead — the same ' +
			'proxy almost certainly speaks it.'
	],
	[
		'socks4a:',
		'SOCKS4a is not supported. Use socks5:// instead — the same proxy almost certainly speaks it.'
	]
]);

/**
 * How each maps onto Chromium's proxy-rule vocabulary.
 *
 * `socks5h` is the curl spelling for "resolve DNS at the proxy". Chromium's
 * `socks5` already does remote DNS, so the two are the same thing under
 * different names — but writing `socks5h://` into a proxy rule yields
 * `ERR_NO_SUPPORTED_PROXIES`, so the translation is mandatory rather than
 * cosmetic.
 */
/**
 * The port Chromium uses when a proxy rule does not name one.
 *
 * Measured, not assumed — `setProxy` with each rule below and then
 * `resolveProxy('https://api.steampowered.com/x')`:
 *
 *   socks5://proxy.example  ->  SOCKS5 proxy.example:1080
 *   socks4://proxy.example  ->  SOCKS  proxy.example:1080
 *   http://proxy.example    ->  PROXY  proxy.example:80
 *   https://proxy.example   ->  HTTPS  proxy.example:443
 *
 * It matters because `resolveProxy` **always** reports a port, whether or not
 * the rule carried one, and `assertRouted` compares its answer to `endpoint`.
 * Leaving the port off a portless proxy made those two strings disagree for a
 * proxy that was working perfectly, and the routing check refuses on any
 * disagreement — so every request on that account was blocked, with a message
 * that said "a different proxy is applied to it" about the very same proxy.
 *
 * Filled in here rather than tolerated at the comparison so `proxyRules` and
 * `endpoint` keep being built from one string. Two independent notions of the
 * port is how they came to disagree.
 */
const DEFAULT_PORT: Record<string, string> = {
	'http:': '80',
	'https:': '443',
	'socks5:': '1080',
	'socks5h:': '1080',
	'socks4:': '1080',
	'socks4a:': '1080'
};

const CHROMIUM_SCHEME: Record<string, string> = {
	'http:': 'http',
	'https:': 'https',
	'socks5:': 'socks5',
	'socks5h:': 'socks5',
	'socks4:': 'socks4'
};

/**
 * What `resolveProxy` calls each scheme back.
 *
 * **The protocol half of the routing check.** `routedEndpoint` compared only
 * `host:port` and threw the scheme away, so an `https://` proxy — configured
 * precisely so the hop to the operator is encrypted — was recorded `verified`
 * against an applied `PROXY host:443`, which is the same operator reached in
 * the clear. Every credential and every Steam cookie on that hop is then
 * readable by anything between here and the proxy, and the account card said
 * the route was confirmed.
 *
 * The tokens are the measured ones from `DEFAULT_PORT` above, not guesses:
 * Chromium spells SOCKS4 `SOCKS` and plain HTTP `PROXY`. `socks4` is in
 * `REFUSED_SCHEMES` and so can never reach a plan, but it is mapped anyway —
 * an entry missing from here refuses a proxy that works, which is the failure
 * the port default above is documented so carefully to avoid.
 */
/**
 * The host spelled the way Chromium will spell it back.
 *
 * **`socks5:` and `socks5h:` are not "special" schemes**, so the WHATWG URL
 * parser leaves their host exactly as typed: case preserved, non-ASCII
 * percent-encoded. `http:` and `https:` are special, and the parser lowercases
 * and IDNA-encodes those itself. Chromium makes no such distinction — it
 * canonicalises every proxy host before reporting it through `resolveProxy`.
 *
 * So `endpoint` was built from the raw string and compared with `!==` against a
 * canonicalised one, and for a SOCKS proxy the two could never agree. Measured
 * on this project's own Electron 43.3.0:
 *
 *   socks5://Proxy.Example:1080   ->  SOCKS5 proxy.example:1080
 *   socks5://пример.рф:1080       ->  SOCKS5 xn--e1afmkfd.xn--p1ai:1080
 *   https://Proxy.Example:8080    ->  HTTPS  proxy.example:8080   (already agreed)
 *
 * A single capital letter in a SOCKS hostname therefore blocked every request on
 * that account — every confirmation, poll, clock sync, enrolment and transfer —
 * with `assertRouted` reporting "a different proxy is applied to it" about the
 * very same proxy. That is the identical failure the `DEFAULT_PORT` docblock
 * above was written for, reached by the other half of the same string.
 *
 * `domainToASCII` is the same UTS-46 mapping Chromium applies, and it returns
 * IP literals, bracketed IPv6 and underscore hosts unchanged apart from case.
 */
function canonicalHost(hostname: string): string {
	// What the parser gave us, case-folded. The fallback for everything below,
	// because it is the one form guaranteed not to name a different host.
	const raw = hostname.toLowerCase();

	let decoded: string;
	try {
		decoded = decodeURIComponent(hostname);
	} catch {
		// Not valid percent-encoding, so it is already the literal host.
		return raw;
	}

	/*
	 * **Decoding can put an authority delimiter back into the host.**
	 *
	 * `%40` decodes to `@` and `%2F` to `/`, and both re-split the string the
	 * moment it is pasted into `scheme://host:port` — so `socks5://ex%40mple.com`
	 * would be planned as `socks5://ex@mple.com`, which `socks-proxy-agent` reads
	 * as the user `ex` at the host `mple.com`. A different operator entirely, on
	 * the one feature whose whole job is to send traffic somewhere specific.
	 *
	 * `domainToASCII` does not save us: measured, it returns `''` for
	 * `ex@mple.com` but `'a'` for `a/b.example` — silently truncating to a host
	 * that is not remotely the one asked for.
	 *
	 * So anything carrying a delimiter keeps the spelling the parser produced.
	 * The routing check then refuses it, which is the honest outcome: an address
	 * we cannot canonicalise is one we cannot promise anything about.
	 */
	const delimiter = decoded.startsWith('[') ? /[@/\\?#\s]/ : /[@/\\?#\s:]/;
	if (delimiter.test(decoded)) {
		return raw;
	}

	const ascii = domainToASCII(decoded);
	// Empty means it is not a domain Chromium would accept at all — leave it
	// alone but for case, and let the routing check refuse it honestly.
	return ascii === '' ? raw : ascii;
}

const PAC_TOKEN: Record<string, string> = {
	'http:': 'PROXY',
	'https:': 'HTTPS',
	'socks5:': 'SOCKS5',
	'socks5h:': 'SOCKS5',
	'socks4:': 'SOCKS'
};

/**
 * What a user is told when `Require proxies` stops a request that has no route.
 *
 * Shared, because the same refusal is reached from four places — a transport, a
 * confirmation sign-in, an enrolment and a transfer — and four sentences for one
 * cause reads as four different problems.
 */
export const PROXY_REQUIRED =
	'this vault is set to require proxies, so nothing can be sent without one. Give the ' +
	'account a proxy, or turn off "Require proxies" in Settings.';

export class EgressError extends Error {
	/**
	 * Whether any of the request reached the network before this was thrown.
	 *
	 * **Most of the refusals in this module happen before a byte leaves the
	 * machine**, and they are the point: a routing check that finds Chromium
	 * would go direct, an account closed while a transport was held, a scheme
	 * this cannot carry. Nothing is sent, and the caller can say so.
	 *
	 * The callers could not tell. `enroll.ts` wraps a failed request in "Steam
	 * may have attached an authenticator — check the mobile app, contact Steam
	 * Support, do not try again", which is right for a timeout and alarming
	 * nonsense for a proxy that refused to be used. It had no way to know which
	 * it had, so it assumed the worse one for all of them.
	 *
	 * `false` is the default because the refusals in this file are all
	 * before-the-send; the transport marks the two paths that follow a real
	 * request. An error that is not an `EgressError` says nothing either way, and
	 * a caller with no information should assume the request went — that is the
	 * assumption that cannot lose an authenticator.
	 */
	readonly sent: boolean;

	constructor(message: string, sent = false) {
		super(message);
		this.name = 'EgressError';
		this.sent = sent;
	}
}

/**
 * Chromium network errors, in language that names what the user can act on.
 *
 * Electron's `net` module rejects with the raw internal string —
 * `net::ERR_TUNNEL_CONNECTION_FAILED` and friends. Passed through untranslated
 * it tells the user nothing, and in particular it never mentions the **proxy**,
 * which is the one thing every error in this table has in common. Someone who
 * imported a maFile that happened to carry routing has no way to connect that
 * string to a setting they never knowingly chose.
 *
 * Keyed on the bare code so `net::` prefixes and wrapper text both match.
 */
const NETWORK_ERRORS: Record<string, string> = {
	// The proxy was reached and refused to open the tunnel. Several causes are
	// genuinely indistinguishable from here, so they are listed rather than ranked
	// — an earlier version led with "usually a wrong username or password" and sent
	// the first person to hit it off checking credentials that were correct. The
	// real cause was that the credentials were never sent at all.
	ERR_TUNNEL_CONNECTION_FAILED:
		'the proxy was reachable but refused to open a connection to Steam. That can be ' +
		'a rejected username or password, a proxy that has expired, or one that does not ' +
		'allow this destination — the proxy does not say which.',
	ERR_PROXY_CONNECTION_FAILED: 'the proxy could not be reached at all.',
	ERR_PROXY_AUTH_REQUESTED: 'the proxy demanded credentials that were not accepted.',
	ERR_PROXY_AUTH_UNSUPPORTED: 'the proxy asked for an authentication method we do not support.',
	ERR_UNEXPECTED_PROXY_AUTH: 'the proxy asked for authentication in a way that is not trustworthy.',
	ERR_NO_SUPPORTED_PROXIES: 'the proxy address uses a scheme Chromium cannot route through.',
	ERR_SOCKS_CONNECTION_FAILED: 'the SOCKS proxy refused the connection.',
	ERR_SOCKS_CONNECTION_HOST_UNREACHABLE:
		'the SOCKS proxy could not reach Steam. The proxy is working; its own network is not.',
	ERR_NAME_NOT_RESOLVED: 'the address could not be resolved by DNS.',
	ERR_CONNECTION_REFUSED: 'the connection was refused.',
	ERR_CONNECTION_RESET: 'the connection was reset before an answer arrived.',
	ERR_CONNECTION_TIMED_OUT: 'the connection timed out.',
	ERR_INTERNET_DISCONNECTED: 'this machine has no network connection.',
	ERR_CERT_AUTHORITY_INVALID:
		'the TLS certificate was not signed by an authority this machine trusts. If you are ' +
		'behind a proxy that inspects traffic, it is intercepting the connection to Steam.',
	ERR_CERT_COMMON_NAME_INVALID:
		'the TLS certificate was issued for a different host — something is intercepting the ' +
		'connection to Steam.',
	ERR_CERT_DATE_INVALID: 'the TLS certificate is expired or not yet valid.'
};

/**
 * The same stored proxy, in the form `steam-session` takes.
 *
 * Sign-in does not go through Chromium: `steam-session` speaks to Steam over
 * Node's own HTTP stack, so it needs a URI rather than a `proxyRules` string —
 * and unlike `setProxy`, it accepts the credentials inline and authenticates
 * with them itself.
 *
 * Validated through `planProxy` first, deliberately. A proxy that works for
 * confirmations must not be rejected for sign-in, or the reverse; sharing the
 * rule is what keeps the two from disagreeing about the same stored string.
 *
 * `httpProxy`, `socksProxy` and `agent` are mutually exclusive in
 * `steam-session`, so this returns exactly one.
 */
export type SteamSessionProxy = { httpProxy: string } | { socksProxy: string };

/**
 * SOCKS schemes as `socks-proxy-agent` reads them, chosen for remote DNS.
 *
 * The agent's own table: `socks5` resolves locally, `socks5h` and bare `socks`
 * resolve at the proxy; `socks4` local (the protocol takes only an IP), and
 * `socks4a` remote. See `steamSessionProxy` for why local resolution here is a
 * leak Chromium's half of the app never had.
 */
const NODE_SOCKS_SCHEME: Record<string, string> = {
	'socks5:': 'socks5h',
	'socks5h:': 'socks5h',
	'socks4:': 'socks4'
};

export function steamSessionProxy(proxyUrl: string): SteamSessionProxy {
	const url = new URL(proxyUrl);
	// Throws `EgressError` for anything `planProxy` would refuse — and its
	// `endpoint` is the host:port pair with any default already filled in, which
	// is what the SOCKS branch below needs.
	const plan = planProxy(proxyUrl);

	const scheme = CHROMIUM_SCHEME[url.protocol] as string;
	if (scheme === 'http' || scheme === 'https') {
		return { httpProxy: proxyUrl };
	}

	// **Normalised to the remote-DNS spelling, which is the opposite direction
	// from Chromium's.** The two halves of this application read the same scheme
	// differently: Chromium's `socks5` sends the hostname to the proxy, but
	// `socks-proxy-agent` — which is what `steam-session` builds from this URL —
	// treats `socks5` as *resolve locally* and only `socks5h` as remote. So a
	// stored `socks5://` had every sign-in, enrollment and transfer look Steam's
	// hostnames up on the user's own resolver, at the exact moments an account
	// was being tied to a route — and a user who explicitly wrote `socks5h://`
	// had it silently rewritten to the local-DNS spelling.
	//
	// Remote DNS is part of the SOCKS5 protocol itself (ATYP=DOMAINNAME), and it
	// is what Chromium already does for every confirmation request, so this
	// changes nothing about which proxies work — only where the lookup happens.
	// SOCKS4 genuinely cannot carry a hostname, so it alone stays local; `4a`
	// keeps its remote spelling instead of being downgraded.
	// **Built from the plan's endpoint, not from the raw string.** A portless
	// `socks5://proxy.example` is accepted everywhere else — `planProxy` fills in
	// Chromium's default and confirmations route fine — but `socks-proxy-agent`
	// parses the empty port as `parseInt('')`, i.e. `NaN`, and its own
	// `if (port == null) port = 1080` default never fires because `NaN == null`
	// is false. So sign-in, enrollment and transfer all failed on an address the
	// routing screen had just validated, while confirmations kept working.
	//
	// Credentials still come from the original string; only the authority is
	// replaced, so a password containing `@` or `%` is untouched.
	const nodeScheme = NODE_SOCKS_SCHEME[url.protocol] as string;
	const credentials =
		url.username === '' && url.password === ''
			? ''
			: `${url.username}${url.password === '' ? '' : `:${url.password}`}@`;
	return { socksProxy: `${nodeScheme}://${credentials}${plan.endpoint}` };
}

/**
 * Turn a network failure into something a person can act on.
 *
 * `routedThrough` is the redacted proxy, when there is one. Naming it matters
 * more than the error text does: the failure is otherwise indistinguishable from
 * Steam being down, and the user cannot fix a proxy they do not know is there.
 */
export function describeNetworkError(error: unknown, routedThrough?: string): string {
	const raw = error instanceof Error ? error.message : String(error);
	const code = /\b(ERR_[A-Z0-9_]+)\b/.exec(raw)?.[1];
	const explanation = code ? NETWORK_ERRORS[code] : undefined;

	const where = routedThrough
		? `This account is routed through ${routedThrough}, and ${explanation ?? 'the connection failed'}`
		: explanation
			? `The connection to Steam failed: ${explanation}`
			: 'The connection to Steam failed';

	// The code is kept on the end even when we recognised it. It is what makes a
	// pasted error searchable, and dropping it would trade a support conversation
	// for a slightly tidier sentence.
	const suffix = code ? ` (${code})` : '';

	// An unrecognised code has already been printed by `suffix`; repeating the raw
	// message would just duplicate it.
	if (!explanation && !code) {
		return `${where}: ${raw}`;
	}
	return `${where}${where.endsWith('.') ? '' : '.'}${suffix}`;
}

/** A proxy, split into the part Chromium takes and the part it cannot. */
/**
 * Strip credentials out of anything before it is shown to a user or logged.
 *
 * Library errors quote what they were given. `steam-session` and Chromium both
 * embed the URL they failed on, so a proxy configured as
 * `socks5://user:hunter2@host:1080` arrives inside an error message with the
 * password intact — and enrollment, sign-in and routing all forwarded those
 * messages to the renderer verbatim.
 *
 * Applied at the point of display rather than trusting each library to be
 * careful, because the one that is not careful is the one nobody checked.
 */
export function redactCredentials(message: string): string {
	// `scheme://<userinfo>@host` -> `scheme://***:***@host`, for every URL the
	// message carries. Everything interesting is in deciding where `<userinfo>`
	// ends; see `userinfoEnd`.
	let out = '';
	let cursor = 0;

	// Built here rather than at module scope on purpose: an exec loop over a `g`
	// regex carries `lastIndex` between calls, and a shared one would start the
	// second caller's message part-way through.
	const schemes = /([a-z][a-z0-9+.-]*:)\/\//gi;
	for (let match = schemes.exec(message); match !== null; match = schemes.exec(message)) {
		const start = match.index + match[0].length;
		const at = userinfoEnd(message, match[1] as string, start);
		if (at === undefined) {
			continue;
		}
		out += `${message.slice(cursor, start)}***:***@`;
		cursor = at + 1;
		// Resume after the authority we just rewrote, so a `scheme://` that happened
		// to sit inside somebody's password cannot be matched a second time.
		schemes.lastIndex = cursor;
	}

	return out + message.slice(cursor);
}

/** Anything that ends an authority: `/`, `?`, `#` — and whitespace, usually. */
const AUTHORITY_END = /[\s/?#]/;

/**
 * The same, for the one scan that is allowed to cross a space or a tab.
 *
 * A line break is never crossed. A password may contain a space; it cannot
 * contain a newline and still have arrived as one line of a quoted URL, and
 * refusing to scan past one bounds how much of a multi-line message a single
 * wrong guess below could rewrite.
 */
const CROSSING_END = /[\r\n/?#]/;

/**
 * Prose punctuation stuck to the end of a URL somebody wrote a sentence around.
 *
 * `could not reach http://proxy.example:8080, retrying` ends its authority with
 * a comma that is not part of it. Stripped before the authority is handed to the
 * parser, because the parser rejects `8080,` as a port — and a rejected
 * authority is what sends the scan below looking for credentials further along
 * the sentence, which is exactly where it can do damage.
 *
 * `]` is deliberately absent: it closes an IPv6 literal, and trimming it would
 * turn `[::1]` into something unparseable for the same reason.
 */
const TRAILING_PROSE = /[.,;:!)'"]+$/;

/**
 * The end of the one word that follows `from`, having skipped the whitespace.
 *
 * Used only where both readings of a space parse — see `userinfoEnd`. It is the
 * difference between `http://alice smith:pw@proxy` (one more word finishes the
 * authority, so the space was inside the credentials) and
 * `http://proxy:8080 for account alice@example.net` (the next word is `for`,
 * which finishes nothing, so the URL had already ended).
 */
function nextWordEnd(text: string, from: number, limit: number): number {
	let word = from;
	while (word < limit && /\s/.test(text[word] as string)) {
		word += 1;
	}
	return Math.min(limit, boundary(text, word, AUTHORITY_END));
}

/** The first index at or after `from` that `ends` matches, or the end of `text`. */
function boundary(text: string, from: number, ends: RegExp): number {
	for (let i = from; i < text.length; i += 1) {
		if (ends.test(text[i] as string)) {
			return i;
		}
	}
	return text.length;
}

/**
 * Does this text stand on its own as a complete `host[:port]`, with nobody's
 * credentials in it?
 *
 * The URL parser is the arbiter rather than a second hand-written pattern,
 * because the parser is what `planProxy`, `steamSessionProxy` and Chromium all
 * agree with — and a redactor that disagrees with the parser about where an
 * authority ends is how a password survives redaction. It answers `false` for
 * `alice:hunter` (a port must be digits) and `true` for `proxy.example:8080`,
 * which is the distinction the whitespace-crossing scan turns on.
 */
function isBareAuthority(scheme: string, candidate: string): boolean {
	const trimmed = candidate.replace(TRAILING_PROSE, '');
	if (trimmed === '') {
		return false;
	}
	try {
		const url = new URL(`${scheme}//${trimmed}`);
		return url.hostname !== '' && url.username === '' && url.password === '';
	} catch {
		return false;
	}
}

/**
 * The index of the `@` that ends this URL's credentials, or `undefined` for a
 * URL that carries none.
 *
 * ## Why this is not one regular expression any more
 *
 * It was `[^\s/?#]*@`, and the `\s` in that class was a hole. **A proxy password
 * may contain whitespace**: `new URL('http://alice:hunter 2@proxy.example:8080')`
 * parses, `planProxy` accepts it, `steamSessionProxy` hands the raw string
 * — space and all — to the library that quotes it back in its error, and the
 * pattern stopped dead at the space. `redactCredentials` returned that URL
 * **unchanged**, so `hunter 2` reached the renderer and the activity log through
 * the one function whose entire job is to keep it out of them. A tab does the
 * same, and is nastier still: the URL parser *strips* tabs, so `url.password`
 * reads back as `hunter2` while the raw text everybody logs still has the tab in
 * it — nothing downstream can be trusted to have normalised it away.
 *
 * ## The two readings, and which one wins
 *
 * Whitespace after a scheme is genuinely ambiguous. In
 * `http://alice:hunter 2@proxy.example:8080` the URL continues past the space;
 * in `could not reach http://proxy.example:8080 for alice@example.net` it does
 * not, and a scan that crossed the space anyway would rewrite the whole
 * sentence as `http://***:***@example.net` — the real host destroyed and
 * credentials invented, in a message whose job is to say what failed. That is
 * not hypothetical: an earlier widening of this pattern did exactly that, and
 * it was worse than the leak it fixed.
 *
 * So the space is crossed freely only when the text before it **cannot** be a
 * URL on its own. `alice:hunter` is not an authority — a port must be digits —
 * so the URL must continue and the space is inside the credentials.
 *
 * When both readings parse the string is genuinely ambiguous, and there are two
 * of those: `http://alice smith:pw@proxy` (a bare `alice` is a valid host) and
 * `http://alice:1234 5@proxy` (`alice:1234` is a valid `host:port`). Neither is
 * exotic — a username with a space, and a password whose first fragment is
 * digits. There, the crossing is allowed to reach exactly one word further: a
 * credential fragment is a *word*, while the prose that follows a finished URL
 * is a *sentence*, so `... for account alice@example.net` stops at `for` and
 * never reaches the address. What escapes is the ambiguous shape with a
 * multi-word tail — `http://alice:1234 5 6@proxy` — and what it buys is that a
 * credential-free URL followed by a sentence is never rewritten, which is the
 * failure this pattern has already had once.
 */
function userinfoEnd(message: string, scheme: string, start: number): number | undefined {
	const plainEnd = boundary(message, start, AUTHORITY_END);
	const plain = message.slice(start, plainEnd);

	// The ordinary case, and the whole of the old behaviour: no whitespace to
	// argue about. The **last** `@` is the delimiter, because that is what the URL
	// parser uses — `http://alice:secret@part@proxy:8080` has the password
	// `secret@part`, and stopping at the first `@` left `part` in the message.
	const lastAt = plain.lastIndexOf('@');
	if (lastAt !== -1) {
		return start + lastAt;
	}

	// No `@` before the first space, so this is the ambiguous case: either the URL
	// ended there and what follows is prose, or the credentials contain
	// whitespace.
	let crossingEnd = boundary(message, start, CROSSING_END);
	if (isBareAuthority(scheme, plain)) {
		crossingEnd = Math.min(crossingEnd, nextWordEnd(message, plainEnd, crossingEnd));
	}

	for (
		let at = message.indexOf('@', plainEnd);
		at !== -1 && at < crossingEnd;
		at = message.indexOf('@', at + 1)
	) {
		// What follows the `@` has to be a host and nothing else. That single
		// requirement also picks the right `@` when the password contains one:
		// in `http://a:se cret@part@proxy:8080` the first candidate is followed by
		// `part@proxy:8080`, which the parser reads as carrying a username, so it is
		// rejected and the scan walks on to the `@` that really ends the userinfo.
		const hostEnd = boundary(message, at + 1, AUTHORITY_END);
		if (isBareAuthority(scheme, message.slice(at + 1, hostEnd))) {
			return at;
		}
	}

	return undefined;
}

export interface ProxyPlan {
	/** `proxyRules` for `session.setProxy`. Never contains credentials. */
	proxyRules: string;
	/** Supplied through the session's `login` event instead. */
	credentials?: { username: string; password: string };
	/** For display and logging. Credentials replaced, never merely shortened. */
	redacted: string;
	/**
	 * `host:port`, as Chromium names it back in `resolveProxy`.
	 *
	 * Kept so the applied proxy can be checked against the intended one rather
	 * than merely checked to be non-direct — see `assertRouted`.
	 */
	endpoint: string;
	/**
	 * The PAC token `resolveProxy` must answer with for this plan.
	 *
	 * Checked alongside `endpoint`, because the same host and port reached over a
	 * different protocol is a different route — and for `https`, an unencrypted
	 * one.
	 */
	pacToken: string;
}

/**
 * Whether Chromium says it will send a URL through a proxy, and which.
 *
 * `resolveProxy` answers with a PAC-style string: `DIRECT`, or a list like
 * `SOCKS5 10.0.0.1:1080` / `PROXY 1.2.3.4:8080; DIRECT`. It is a local lookup —
 * no network — so it is affordable on every request.
 *
 * Two things make it worth checking rather than trusting `setProxy`:
 *
 *  - `setProxy` resolving does not mean a rule was applied to *this* URL.
 *    Chromium keeps an implicit bypass list, and a bypassed host goes direct
 *    while every setting still reads as configured.
 *  - A trailing `; DIRECT` in a proxy list is a **fallback to no proxy**. It
 *    looks routed and silently is not, which is the exact failure the anonymity
 *    promise cannot survive.
 */
export function describesDirectRoute(resolved: string): boolean {
	// Any entry being DIRECT is disqualifying, not just the whole string being
	// it: `PROXY 1.2.3.4:8080; DIRECT` means Chromium will go direct the moment
	// the proxy is unreachable, which is precisely when it matters most.
	return resolved
		.split(';')
		.map((entry) => entry.trim().toUpperCase())
		.some((entry) => entry === 'DIRECT' || entry === '');
}

/**
 * The endpoint Chromium says it will actually use, or `undefined` for none.
 *
 * `resolveProxy` answers with a PAC-style list — `SOCKS5 10.0.0.1:1080`, or
 * several separated by `;` — and **the first entry is the one that gets used**.
 * Everything after it is a fallback.
 *
 * This exists because the check that used it was a substring test, and a
 * substring test over this string is wrong three separate ways:
 *
 *   intended 10.0.0.1:1080
 *   SOCKS5 110.0.0.1:10800                       a different host and port
 *   SOCKS5 10.0.0.1:10800                        the same host, another port
 *   PROXY 203.0.113.9:8080; SOCKS5 10.0.0.1:1080 a stranger's proxy, tried first
 *
 * All three contain the intended endpoint verbatim, none contains `DIRECT`, and
 * all three were recorded as `verified`. On the one feature whose entire purpose
 * is to fail closed rather than leak an address.
 */
export function routedVia(resolved: string): { token: string; endpoint: string } | undefined {
	const first = resolved.split(';')[0]?.trim();
	if (first === undefined || first === '' || /^DIRECT$/i.test(first)) {
		return undefined;
	}
	// `SCHEME host:port`. Anything else is not a route we can vouch for, and
	// returning undefined makes the caller refuse rather than guess.
	const parts = first.split(/\s+/);
	const token = parts[0];
	const endpoint = parts[1];
	if (token === undefined || endpoint === undefined) {
		return undefined;
	}
	// Upper-cased because the comparison is against the tokens in `PAC_TOKEN`,
	// and a case difference is not a routing difference.
	return { token: token.toUpperCase(), endpoint };
}

/**
 * The endpoint half of {@link routedVia}.
 *
 * **Not sufficient on its own for a routing check** — the scheme is half the
 * route, and the two callers that verify a proxy compare both. This remains for
 * the places that genuinely only need to know where traffic is going.
 */
export function routedEndpoint(resolved: string): string | undefined {
	return routedVia(resolved)?.endpoint;
}

/**
 * Parse a stored proxy URL.
 *
 * **Credentials are stripped out of `proxyRules` deliberately.** Chromium's proxy
 * rules have no syntax for them: a `socks5://user:pass@host:1080` rule is either
 * rejected or silently parsed with the credentials as part of the hostname, and
 * the second outcome is a connection that quietly fails to authenticate. They
 * are answered through the session's `login` event instead.
 */
/**
 * The registrable domains a Steam session actually talks to.
 *
 * **This list is the whole of the "Steam only" promise.** Anything missing from
 * it leaves by the machine's own address while the account is signed in, which
 * is the one thing that mode exists to prevent — so it errs wide. The cost of an
 * extra domain is a slower asset load through the proxy; the cost of a missing
 * one is the account being seen from home.
 *
 * `steamstatic.com` and `steamusercontent.com` are Valve's own asset and
 * user-content hosts: an inventory page fetches item images from them by the
 * hundred, and a request pattern that specific, arriving from a different
 * address at the same moment as the page, is not meaningfully anonymous.
 *
 * Worth reviewing rather than trusting: it is a judgement about somebody else's
 * infrastructure, and it is the kind of thing that changes without notice.
 */
export const STEAM_ROUTED_DOMAINS = [
	'steampowered.com',
	'steamcommunity.com',
	'steamstatic.com',
	'steamusercontent.com',
	'steamcontent.com',
	'steamgames.com',
	'steamserver.net',
	'steam-chat.com',
	// Not a Valve-owned name, and listed anyway: Steam serves community images
	// through it, so a request for one carries the referring Steam page.
	'steamcdn-a.akamaihd.net',
	'valvesoftware.com'
] as const;

/**
 * Hosts the "Steam only" route is willing to send straight out.
 *
 * **An allowlist, and a short one.** The route's default is the proxy — see
 * `steamOnlyBypass` — so this list is the *entire* set of addresses that mode
 * lets out directly, and every entry is a deliberate decision that this host
 * seeing the machine's own address costs nothing the user cares about.
 *
 * They are the third-party trade and case sites people open beside Steam.
 * Those are the pages that make a proxied window unbearable: heavy, chatty,
 * and behind Cloudflare, which challenges a shared proxy address far more
 * readily than a home connection. None of them is where the account lives.
 *
 * **`challenges.cloudflare.com` is deliberately absent.** Turnstile has to
 * egress from the same address as the page being challenged, or the clearance
 * cookie is issued to an address that never browses and the challenge loops.
 * This window opens on Steam, which is proxied — so Turnstile must be proxied
 * too, and the default does that without an entry here. A user who needs a
 * challenged third-party site has the Direct button.
 */
export const DIRECT_CONTENT_DOMAINS = [
	'csfloat.com',
	'csgoempire.com',
	'csgoroll.com',
	'market.csgo.com',
	'shadowpay.com',
	'waxpeer.com',
	'skinport.com',
	'buff.163.com',
	'dmarket.com',
	'bitskins.com'
] as const;

/**
 * The bypass list for the "Steam only" route.
 *
 * ## Why this is a bypass list and not a PAC script
 *
 * It was a PAC script, and that was wrong twice over.
 *
 * The first design routed Steam and sent everything else direct, which a bypass
 * list genuinely cannot express — `proxyBypassRules` says what *skips* the
 * proxy and has no negation. Inverting the default (see `steamOnlyBypass`'s
 * callers, and the note on `DIRECT_CONTENT_DOMAINS`) so that unrecognised hosts
 * stay on the proxy turned the rule into "proxy everything except this short
 * list" — which is precisely what a bypass list *is*. The PAC survived that
 * change as leftovers.
 *
 * The second reason is the one that made it a defect rather than a detour.
 * **Chromium bypasses loopback and link-local addresses before it consults a
 * PAC script at all, and `<-loopback>` does not turn that off in `pac_script`
 * mode.** Measured in Electron 43.3.0 rather than reasoned about: with the PAC
 * installed, and again with `proxyBypassRules: '<-loopback>'` alongside it,
 * `localhost`, `127.0.0.1`, `[::1]` and `169.254.169.254` all resolved
 * `DIRECT`. The window could reach local services and the cloud-metadata
 * address without touching the proxy, in the mode whose whole promise is that
 * traffic it does not name goes through it. `fixed_servers` honours
 * `<-loopback>`, so the same measurement there routes every one of them.
 *
 * ## The two spellings
 *
 * Both are required, and this was measured too: `csfloat.com` alone does not
 * match `www.csfloat.com`, and `*.csfloat.com` alone does not match the apex.
 * A list carrying only one of them silently proxies half of each site — the
 * half nobody thought to open while testing.
 *
 * `<-loopback>` comes last and applies to the whole list: it removes Chromium's
 * implicit bypass rather than adding to it, so loopback and link-local go
 * through the proxy like everything else that is not named above.
 */
export function steamOnlyBypass(): string {
	return [
		...DIRECT_CONTENT_DOMAINS.flatMap((domain) => [domain, `*.${domain}`]),
		'<-loopback>'
	].join(',');
}

/**
 * `host` is `domain` or something under it.
 *
 * Matches on label boundaries, like Chromium's own bypass matching: `.example`
 * or the whole name, never a bare suffix — otherwise `evil-csfloat.com` would
 * inherit `csfloat.com`'s exemption.
 */
function hostIsUnder(host: string, domains: readonly string[]): boolean {
	const lower = host.toLowerCase().replace(/\.$/, '');
	return domains.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

/**
 * Is this host one the "Steam only" mode routes?
 *
 * **Not the routing rule.** Chromium's bypass list decides that, and its
 * default is the proxy — so the mode routes this list *and* everything else it
 * does not recognise. What this answers is the narrower question the tests and
 * `openAccountBrowser`'s verification sweep need: is this one of the names the
 * mode explicitly promises to route, and therefore one whose configuration is
 * worth checking against Chromium before a window opens.
 */
export function isSteamRoutedHost(host: string): boolean {
	return hostIsUnder(host, STEAM_ROUTED_DOMAINS);
}

/**
 * Is this a host the "Steam only" mode lets out directly?
 *
 * Steam wins first: this answers `false` for a Steam host even if one were ever
 * added to `DIRECT_CONTENT_DOMAINS`. That ordering used to be enforced by where
 * the two blocks sat in a generated PAC script; it is now enforced by
 * `steamOnlyBypass` never putting a Steam name in the bypass list at all, which
 * `browser-window.test.ts` checks entry by entry.
 */
export function isDirectContentHost(host: string): boolean {
	return !isSteamRoutedHost(host) && hostIsUnder(host, DIRECT_CONTENT_DOMAINS);
}

export function planProxy(proxyUrl: string): ProxyPlan {
	/*
	 * Trimmed before anything else, because the check below refuses whitespace and
	 * people paste addresses. `new URL` already ignores surrounding ASCII
	 * whitespace, so this only makes the two agree — without it a pasted
	 * `http://proxy.example:8080` with a trailing newline, no credentials
	 * anywhere in it, was refused with a message about usernames and passwords.
	 */
	const address = proxyUrl.trim();

	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new EgressError('that is not a usable proxy address');
	}

	// Named refusals first, so the message can say what to use instead rather
	// than only what will not work.
	const refused = REFUSED_SCHEMES.get(url.protocol);
	if (refused !== undefined) {
		throw new EgressError(refused);
	}
	if (!SUPPORTED.has(url.protocol)) {
		throw new EgressError(
			`${url.protocol.replace(':', '')} proxies are not supported — use http, https or socks5`
		);
	}
	if (url.hostname === '') {
		throw new EgressError('a proxy address needs a host');
	}

	/*
	 * **Whitespace in the credentials, refused here so `redactCredentials` never
	 * meets it.**
	 *
	 * That function has to decide, from text alone, whether a space after a
	 * scheme continues the URL or ends it — `http://alice:hunter 2@proxy` against
	 * `could not reach http://proxy:8080 for alice@example.net`. It resolves the
	 * ambiguity by crossing exactly one word, and its own comment names what
	 * escapes: a multi-word tail. `http://alice:1234 5 6@proxy.example:8080` was
	 * accepted by this function and returned **unchanged** by the one whose whole
	 * job is keeping credentials out of messages, so the password reached
	 * anywhere an error is displayed or logged.
	 *
	 * Widening the scan is the fix that looks obvious and is wrong: an earlier
	 * attempt at it rewrote whole sentences, inventing credentials and destroying
	 * the real host in a message whose job is to say what failed. The ambiguity
	 * cannot be resolved from text, so the answer is to stop producing the text.
	 *
	 * No standard is being bent to do it. RFC 3986 does not permit a raw space in
	 * userinfo at all; a password containing one is written `%20`, which arrives
	 * here percent-encoded, survives redaction, and is decoded below before it
	 * goes to the proxy. A user with a space in their password loses nothing but
	 * the spelling.
	 *
	 * Control characters are refused with them: the URL parser silently strips a
	 * tab, so `url.password` would read back clean while the raw text everybody
	 * logs still carried it.
	 */
	/*
	 * Codepoint arithmetic rather than a character class, for the same reason
	 * `tests/no-binary-sources.test.ts` is written that way: spelling this as a
	 * regex means typing the control characters, and typing them is how two of
	 * them got into source files as literal bytes in the first place.
	 */
	const invisible = (text: string): boolean =>
		[...text].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			/*
			 * `\s` rather than a codepoint range, and this is the whole of the
			 * second attempt at this fix. The first tested `code <= 0x20` — ASCII
			 * space and the C0 controls — so a password separated by U+00A0 was
			 * accepted and came back from `redactCredentials` **unchanged**: the
			 * reported defect exactly, spelled with a different space character.
			 * U+2028, U+2003 and U+3000 did the same.
			 *
			 * They work for the reason the ASCII space did. `AUTHORITY_END` is
			 * built from `\s`, so the redactor stops at every one of them, while
			 * `CROSSING_END` does not — and the one-word crossing that resolves the
			 * ambiguity is beaten by a multi-word tail. Refusing exactly the class
			 * the redactor's own boundaries are made of is what keeps the two in
			 * step. A hand-listed set of codepoints is a list to fall behind.
			 */
			return /\s/u.test(character) || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
		});

	/*
	 * Checked against the **raw** string, not `url.username` / `url.password`.
	 * `new URL` percent-encodes a raw space on the way in, so the parsed halves
	 * come back clean — `hunter%202` — while the text that is stored on the
	 * account and pasted into every error message still has the space in it. A
	 * check on the parsed values passes every case it exists to catch.
	 *
	 * The whole address rather than the userinfo alone: a host with a space in it
	 * is not a host, and picking the userinfo substring back out of raw text is
	 * the parse `redactCredentials` already cannot do reliably.
	 */
	if (invisible(address)) {
		throw new EgressError(
			'a proxy address cannot contain a space or any other invisible character. Web ' +
				'addresses have no way to carry one, and inside a username or password it would ' +
				'survive into error messages that are otherwise stripped of credentials. If the ' +
				'password really contains a space, write it percent-encoded as %20.'
		);
	}

	/*
	 * **Credentials on a SOCKS proxy are refused, because only half of this
	 * application can send them.**
	 *
	 * `steam-session` hands the whole URL to `socks-proxy-agent`, which
	 * authenticates happily. Chromium cannot: its SOCKS5 client implements no
	 * authentication methods, and the `login` event this transport listens for is
	 * an HTTP 407 mechanism that a SOCKS handshake never produces. So a stored
	 * `socks5://user:pass@host` signed in fine and then failed every
	 * confirmation, every enrollment attach and every clock sync — and if the
	 * proxy also allowed unauthenticated connections, it would instead succeed on
	 * both while presenting two different identities to the operator.
	 *
	 * Refused here rather than discovered later: this is the one moment the user
	 * is looking at the field they typed it into. HTTP and HTTPS proxies carry
	 * credentials on both stacks and are unaffected.
	 */
	const socks = url.protocol.startsWith('socks');
	if (socks && (url.username !== '' || url.password !== '')) {
		throw new EgressError(
			'a SOCKS proxy that needs a username and password cannot be used: Chromium, which ' +
				'carries this app’s Steam traffic, cannot authenticate to one. Use an http or https ' +
				'proxy for credentials, or a SOCKS proxy that allows this machine without them'
		);
	}

	const scheme = CHROMIUM_SCHEME[url.protocol] as string;
	// Always ported. Chromium fills its own default in when a rule omits one and
	// then reports that filled-in port back through `resolveProxy`, so a portless
	// `endpoint` can never match what the routing check is handed.
	const port = url.port === '' ? (DEFAULT_PORT[url.protocol] as string) : url.port;
	// Canonicalised, so `endpoint` is the string Chromium reports back rather
	// than the one the user happened to type. See `canonicalHost`.
	const host = `${canonicalHost(url.hostname)}:${port}`;

	const plan: ProxyPlan = {
		proxyRules: `${scheme}://${host}`,
		redacted: `${scheme}://${url.username === '' ? '' : '***:***@'}${host}`,
		endpoint: host,
		pacToken: PAC_TOKEN[url.protocol] as string
	};

	if (url.username !== '' || url.password !== '') {
		// Decoded, because a stored URL percent-encodes them and Chromium's login
		// callback wants the real values. Getting this wrong authenticates with the
		// literal `%40` rather than the `@` the user's proxy expects.
		plan.credentials = {
			username: percentDecode(url.username),
			password: percentDecode(url.password)
		};
	}

	return plan;
}

/**
 * Percent-decode, falling back to the literal text.
 *
 * `decodeURIComponent` throws `URIError` on a stray `%` — and a password like
 * `100%sure` or `bad%ZZ` contains exactly that. Throwing there would surface as
 * an unhandled error type nothing was expecting, for a password that is
 * perfectly valid; the sensible reading of an undecodable value is that it was
 * never encoded.
 */
function percentDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * How this application presents itself to Steam.
 *
 * ## Why `okhttp` and not a browser string
 *
 * This is what the real Steam Android app sends, and it is what `steam-session`
 * hardcodes for `MobileApp` logins. Matching it exactly is the whole strategy:
 * millions of ordinary users send this, so it is the largest crowd available to
 * stand in.
 *
 * The previous value was a Chrome-on-Android browser string. That created a
 * contradiction nobody real produces — the same account signed in as the
 * Android app and then fetched its confirmations as a mobile browser. An
 * inconsistency between two halves of one session is a stronger signal than any
 * single header, because no genuine client behaves that way.
 *
 * ## Why this is NOT randomised per account
 *
 * The instinct is to give every account its own identity so they cannot be
 * linked. It backfires. Anti-fraud systems flag **rare** fingerprints, not
 * common ones, so a unique string per account makes each one individually
 * anomalous rather than collectively invisible. It also cannot be made
 * consistent: the TLS fingerprint underneath is Chromium's and does not change,
 * so an exotic User-Agent over a Chromium handshake is a mismatch — exactly what
 * fingerprinting looks for.
 *
 * What actually keeps accounts unlinkable is a separate exit address per
 * account, which routing already provides, plus not ticking in lockstep, which
 * the auto-confirm jitter handles.
 *
 * **This does not defeat TLS fingerprinting**, and THREAT_MODEL says so. Steam
 * can distinguish this application's traffic from the real mobile app's if it
 * looks. What this buys is that the accounts do not stand out from one another.
 */
export const STEAM_USER_AGENT = 'okhttp/4.9.2';

/**
 * The cookie the Steam mobile app sends alongside that User-Agent.
 *
 * `steam-session` sends exactly this for MobileApp logins, and `WebApiTransport`
 * keys off `mobileClientVersion=` to decide a request is from the mobile app.
 * Sending the User-Agent without it would be half a disguise.
 */
export const STEAM_MOBILE_CLIENT_COOKIE = 'mobileClient=android; mobileClientVersion=777777 3.10.3';

/**
 * Headers Chromium adds that an `okhttp` client would never send.
 *
 * Client hints and fetch metadata are browser concepts. Arriving beside an
 * okhttp User-Agent they are a contradiction, and a contradiction is more
 * identifying than any one header — so they are stripped at the session level
 * rather than merely left unset, because Electron adds them itself.
 */
export const BROWSER_ONLY_HEADERS = [
	'sec-ch-ua',
	'sec-ch-ua-mobile',
	'sec-ch-ua-platform',
	'sec-fetch-site',
	'sec-fetch-mode',
	'sec-fetch-dest',
	'sec-fetch-user',
	'upgrade-insecure-requests',
	'accept-language'
] as const;

/**
 * The only hosts this application will ever send a Steam session to.
 *
 * The transport attaches a `steamLoginSecure` cookie to whatever URL it is
 * handed. Nothing today builds a URL from anything but our own constants — but
 * "nothing today" is not a control, and the cost of a mistake here is a live
 * Steam session posted to somebody else's server.
 */
const STEAM_HOSTS = new Set([
	'steamcommunity.com',
	'api.steampowered.com',
	'store.steampowered.com',
	'login.steampowered.com'
]);

/**
 * Whether a session may be attached to this URL.
 *
 * HTTPS is required for the same reason: a cookie is a credential, and there is
 * no version of sending one in clear text that is acceptable.
 */
export function isSteamEndpoint(candidate: string): boolean {
	try {
		const url = new URL(candidate);
		return url.protocol === 'https:' && STEAM_HOSTS.has(url.hostname);
	} catch {
		return false;
	}
}
