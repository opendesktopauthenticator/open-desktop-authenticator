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

/** Schemes we accept from a user or a maFile. */
const SUPPORTED = new Set(['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:']);

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
	'socks4:': 'socks4',
	'socks4a:': 'socks4'
};

export class EgressError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EgressError';
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
	'socks4:': 'socks4',
	'socks4a:': 'socks4a'
};

export function steamSessionProxy(proxyUrl: string): SteamSessionProxy {
	const url = new URL(proxyUrl);
	// Throws `EgressError` for anything `planProxy` would refuse.
	planProxy(proxyUrl);

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
	const nodeScheme = NODE_SOCKS_SCHEME[url.protocol] as string;
	return { socksProxy: `${nodeScheme}:${proxyUrl.slice(url.protocol.length)}` };
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
	// scheme://<anything>@host -> scheme://***:***@host
	//
	// **Any userinfo, not only a `user:pass` pair.** The pattern used to require
	// both halves to be non-empty, while `planProxy` accepts credentials when
	// *either* is — so `http://alice@proxy:8080` and `http://:secret@proxy:8080`
	// are routable, are credential-bearing, and travelled through this function
	// completely untouched into renderer-visible errors and activity records.
	//
	// Greedy, and stopping only at a character that ends the authority. The URL
	// parser treats the **last** `@` in an authority as the delimiter, so
	// `http://alice:secret@part@proxy:8080` has the password `secret@part` — and a
	// class that also excluded `@` stopped at the first one, leaving `part` of that
	// password in the message it was supposed to be scrubbing from.
	//
	// The class excludes `?` and `#` as well as `/`, because all three end the
	// authority. Bounding on `/` alone was not enough and was actively worse than
	// the pattern it replaced: `https://example.com?email=alice@example.net` has no
	// slash before its `@`, so the match ran through the query string and rewrote
	// the whole thing as `https://***:***@example.net` — destroying the real host
	// and inventing credentials that were never there, in a message whose job is to
	// tell somebody what failed.
	return message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1***:***@');
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
export function routedEndpoint(resolved: string): string | undefined {
	const first = resolved.split(';')[0]?.trim();
	if (first === undefined || first === '' || /^DIRECT$/i.test(first)) {
		return undefined;
	}
	// `SCHEME host:port`. Anything else is not a route we can vouch for, and
	// returning undefined makes the caller refuse rather than guess.
	const parts = first.split(/\s+/);
	return parts.length >= 2 ? parts[1] : undefined;
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
export function planProxy(proxyUrl: string): ProxyPlan {
	let url: URL;
	try {
		url = new URL(proxyUrl);
	} catch {
		throw new EgressError('that is not a usable proxy address');
	}

	if (!SUPPORTED.has(url.protocol)) {
		throw new EgressError(
			`${url.protocol.replace(':', '')} proxies are not supported — use http, https or socks5`
		);
	}
	if (url.hostname === '') {
		throw new EgressError('a proxy address needs a host');
	}

	const scheme = CHROMIUM_SCHEME[url.protocol] as string;
	// Always ported. Chromium fills its own default in when a rule omits one and
	// then reports that filled-in port back through `resolveProxy`, so a portless
	// `endpoint` can never match what the routing check is handed.
	const port = url.port === '' ? (DEFAULT_PORT[url.protocol] as string) : url.port;
	const host = `${url.hostname}:${port}`;

	const plan: ProxyPlan = {
		proxyRules: `${scheme}://${host}`,
		redacted: `${scheme}://${url.username === '' ? '' : '***:***@'}${host}`,
		endpoint: host
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
