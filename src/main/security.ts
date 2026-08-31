import { app, shell, type Session, type WebContents } from 'electron';
import {
	cspFor,
	isAllowedNavigation,
	isOpenableExternally,
	type NavigationTarget
} from '../shared/security-policy';

/**
 * Applying the §11 security posture.
 *
 * The policy itself is pure data in `src/shared/security-policy.ts`; this module
 * is the behaviour that installs it. §19 requires all of it wired from the first
 * commit rather than retrofitted — every one of these is far harder to add once
 * features depend on the looser behaviour.
 */

export {
	SECURE_WEB_PREFERENCES,
	PRODUCTION_CSP,
	cspFor,
	isAllowedNavigation,
	isOpenableExternally,
	type NavigationTarget
} from '../shared/security-policy';

/** Attach the CSP to every response in this session. */
export function applyContentSecurityPolicy(
	session: Session,
	isDev: boolean,
	devServerOrigin?: string
): void {
	const policy = cspFor(isDev, devServerOrigin);
	session.webRequest.onHeadersReceived((details, callback) => {
		callback({
			responseHeaders: {
				...details.responseHeaders,
				'Content-Security-Policy': [policy]
			}
		});
	});
}

/**
 * Refuse every permission request (§P8).
 *
 * We need none of them — no camera, microphone, geolocation, notifications, or
 * clipboard-read. Denying by default means a future dependency cannot quietly
 * acquire one.
 */
export function denyAllPermissions(session: Session): void {
	session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
	session.setPermissionCheckHandler(() => false);

	/**
	 * **`spellcheck: false` on `webPreferences` is not enough, and that was
	 * measured rather than assumed.**
	 *
	 * `SECURE_WEB_PREFERENCES` sets it, and the stated reason is the network
	 * call: an active spellchecker downloads Hunspell dictionaries from a
	 * Google-run CDN, which is a request this application never disclosed and
	 * one that would leave by the machine's own address rather than an account's
	 * proxy. But the preference governs the *view*; the spellchecker itself is a
	 * session-level service, and a real Electron run shows it still enabled with
	 * `en-US` loaded on a session whose every view has the preference off.
	 *
	 * Nothing should be requesting a dictionary in that state. This closes the
	 * question rather than reasoning about it — which is the same mistake the
	 * preference audit made once already.
	 */
	session.setSpellCheckerEnabled(false);
}

/**
 * Block navigation away from bundled content, and send any external link to the
 * user's real browser instead of a window we control (§9.3).
 *
 * Without this, a link inside rendered content — a Steam item name, a
 * confirmation description — could navigate the app itself to an attacker page.
 */
export function lockNavigation(contents: WebContents, target: NavigationTarget): void {
	// Supplied here because `shared/` is compiled for the renderer too and cannot
	// read `process`. Windows paths are case-insensitive, so a case-flipped path
	// is the same file and must not be treated as a different one.
	const options = { caseInsensitivePaths: process.platform === 'win32' };
	contents.on('will-navigate', (event, url) => {
		if (!isAllowedNavigation(url, target, options)) {
			event.preventDefault();
		}
	});

	// `will-navigate` covers only the top-level frame. Subframes should not exist
	// at all (`frame-src 'none'`), but if one ever does it must obey the same rule.
	contents.on('will-frame-navigate', (event) => {
		if (!isAllowedNavigation(event.url, target, options)) {
			event.preventDefault();
		}
	});

	// A redirect is a second navigation the first check never saw: `will-navigate`
	// fires for the original URL, and a 302 can then land somewhere else entirely.
	contents.on('will-redirect', (event, url) => {
		if (!isAllowedNavigation(url, target, options)) {
			event.preventDefault();
		}
	});

	contents.setWindowOpenHandler(({ url }) => {
		// Never opens a window we control. The only question is whether the URL is
		// worth handing to the user's browser.
		if (isOpenableExternally(url)) {
			void shell.openExternal(url);
		}
		return { action: 'deny' };
	});

	contents.on('will-attach-webview', (event) => {
		event.preventDefault();
	});
}

/**
 * Apply navigation locking to **every** `WebContents` the process creates.
 *
 * This is the only place it is applied. An earlier version also hardened each
 * window explicitly at construction, which attached every listener twice — the
 * `web-contents-created` event already covers windows we build. Duplicate
 * listeners are harmless in effect but make the real coverage ambiguous, and
 * ambiguity about which code enforces a security rule is how the rule gets
 * removed by someone tidying up.
 *
 * Covering everything here also catches WebContents we do not construct: one
 * created by a dependency, or by future code that forgets to harden it. Per
 * window hardening is easy to forget once, and once is enough.
 */
export function hardenAllWebContents(
	target: NavigationTarget,
	isExempt: (contents: WebContents) => boolean = () => false
): void {
	app.on('web-contents-created', (_event, contents) => {
		/*
		 * **One window is deliberately not locked down, and it has to say so.**
		 *
		 * The in-app browser exists to load Valve's pages, which are not bundled
		 * content by any definition — so every rule above refuses them. It refused
		 * silently and completely: `will-redirect` fires for a programmatic
		 * `loadURL` as well as for a click, `steamcommunity.com/my/tradeoffers/`
		 * answers with a 302, and the redirect was cancelled before the first page
		 * ever rendered. The window could not load anything at all.
		 *
		 * An exemption is the honest shape for that. The alternative — loosening
		 * `isAllowedNavigation` until Steam fits through — would weaken the rule
		 * for the main window too, which is the one that must never leave bundled
		 * content.
		 *
		 * What the exempt window gives up is written down in
		 * `docs/THREAT_MODEL.md` §2.6b: it may navigate anywhere, it says where it
		 * is in its title, and it holds nothing but a short-lived Steam session.
		 */
		if (isExempt(contents)) {
			return;
		}
		lockNavigation(contents, target);
	});
}

/**
 * Process-wide hardening, applied before any window exists.
 *
 * @returns false when another instance already holds the lock, in which case the
 * caller MUST return immediately. `app.quit()` only *requests* a quit — it does
 * not stop the current tick — so without an early return this process would go on
 * to register IPC handlers and create a window while the first instance is still
 * running. §10.3's atomic vault writes assume a single writer.
 */
export function hardenApp(): boolean {
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return false;
	}
	return true;
}
