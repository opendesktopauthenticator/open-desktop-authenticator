/**
 * Security policy as pure data (§11 S6, §9.3).
 *
 * Deliberately free of any `electron` import so it can be asserted on directly
 * by the test suite running under plain Node. Policy is data; applying it is
 * behaviour, and that lives in `src/main/security.ts`.
 */

/**
 * webPreferences every window must use.
 *
 * Frozen so no code path can create a window with a quietly-weakened variant.
 */
export const SECURE_WEB_PREFERENCES = Object.freeze({
	sandbox: true,
	contextIsolation: true,
	nodeIntegration: false,
	nodeIntegrationInWorker: false,
	nodeIntegrationInSubFrames: false,
	webSecurity: true,
	allowRunningInsecureContent: false,
	experimentalFeatures: false,
	webviewTag: false,
	/**
	 * Off by default; development re-enables it explicitly at the call site.
	 *
	 * DevTools in a shipped authenticator is a self-XSS vector: "open the console
	 * and paste this to fix your codes" is a scam that works on real people, and
	 * pasted script runs with full access to whatever `window.api` exposes. Today
	 * that is only app metadata; from milestone 0.1 it is the vault.
	 */
	devTools: false
});

/**
 * Content-Security-Policy for packaged builds.
 *
 * `connect-src 'none'` is the load-bearing directive: the renderer has no
 * network access of its own, so a compromised renderer cannot exfiltrate
 * anything even while running attacker script. All Steam traffic originates in
 * the main process (§11 S5).
 */
export const PRODUCTION_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'none'",
	"object-src 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-ancestors 'none'"
].join('; ');

/**
 * What a window is allowed to navigate to.
 *
 * Two shapes because `file:` URLs have no meaningful origin: `new URL(...).origin`
 * is the string `"null"` for **every** `file:` URL. Comparing origins in a
 * packaged build therefore compares `"null"` to `"null"` and permits navigation
 * to any local file on the machine. A packaged build must be pinned to the exact
 * file instead.
 */
export type NavigationTarget = { kind: 'origin'; origin: string } | { kind: 'file'; href: string };

/**
 * Whether a navigation may proceed.
 *
 * Pure, and therefore directly testable — a predicate guarding local-file access
 * must never be verifiable only by driving a live window.
 *
 * `caseInsensitivePaths` is passed in rather than read from `process.platform`
 * because everything in `shared/` is compiled for the renderer too, where
 * `process` does not exist. Environment-specific facts are supplied by the
 * caller; this module stays environment-agnostic.
 */
export function isAllowedNavigation(
	rawUrl: string,
	target: NavigationTarget,
	options: { caseInsensitivePaths?: boolean } = {}
): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}

	if (target.kind === 'origin') {
		// A file: URL must never satisfy an origin target: its origin is "null",
		// which would match any other origin that also serialises to "null".
		return url.protocol !== 'file:' && url.origin === target.origin;
	}

	if (url.protocol !== 'file:') {
		return false;
	}

	// A file: URL can carry a HOST, and comparing pathnames alone ignores it:
	//     file://evil.com/H:/app/out/renderer/index.html
	// has the same pathname as our bundled entry point. On Windows that is a UNC
	// path — a file served from a remote SMB share — so accepting it would let a
	// network-controlled document pass as our own. Since this predicate also backs
	// the IPC sender check, that document would additionally be trusted to call
	// every channel.
	//
	// `pathToFileURL` always produces an empty host, so anything else is refused.
	// Both the candidate and the target are checked; a target with a host would
	// mean we built it wrong.
	const allowedUrl = new URL(target.href);
	if (url.host !== '' || allowedUrl.host !== '') {
		return false;
	}

	// Compare the resolved path, ignoring query and fragment. Windows paths are
	// case-insensitive, so a case-flipped path is the same file.
	const decode = (u: URL): string => {
		try {
			return decodeURIComponent(u.pathname);
		} catch {
			return u.pathname;
		}
	};
	const actual = decode(url);
	const allowed = decode(allowedUrl);
	return options.caseInsensitivePaths
		? actual.toLowerCase() === allowed.toLowerCase()
		: actual === allowed;
}

/**
 * Hosts the app will hand to the user's browser.
 *
 * An allowlist rather than "any https URL", because from milestone 0.1 the UI
 * renders **attacker-influenced text**: Steam item names, trade counterparties,
 * confirmation descriptions. A crafted link in that content should not be able to
 * send someone to an arbitrary site via a click that looks like it came from
 * their authenticator.
 *
 * Subdomains are matched, so `steamcommunity.com` covers `help.steamcommunity.com`
 * but never `steamcommunity.com.evil.test`.
 */
export const EXTERNAL_LINK_ALLOWLIST = Object.freeze([
	'steamcommunity.com',
	'steampowered.com',
	'valvesoftware.com',
	'github.com'
]);

/** Whether a URL may be handed to the OS browser handler. */
export function isOpenableExternally(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}

	// Only http(s). Anything else — file:, javascript:, ms-msdt:, custom schemes —
	// is a way to launch something rather than to show a page.
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return false;
	}

	const host = url.hostname.toLowerCase();
	return EXTERNAL_LINK_ALLOWLIST.some(
		(allowed) => host === allowed || host.endsWith(`.${allowed}`)
	);
}

/**
 * Development needs Vite's HMR websocket and inline injection, so the strict
 * policy cannot apply there. `isDev` is derived from `app.isPackaged`, so a
 * packaged build can never take the dev branch.
 */
export function cspFor(isDev: boolean, devServerOrigin?: string): string {
	if (!isDev) {
		return PRODUCTION_CSP;
	}
	const origin = devServerOrigin ?? '';
	const ws = origin.replace(/^http/, 'ws');
	return [
		"default-src 'self'",
		`script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`.trim(),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self'",
		`connect-src 'self' ${origin} ${ws}`.trim(),
		"object-src 'none'",
		"frame-ancestors 'none'"
	].join('; ');
}
