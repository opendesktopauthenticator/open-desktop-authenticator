/**
 * Every name-dependent value in the application, in one place.
 *
 * Nothing anywhere else in `src/` may hard-code a product name, app id, window
 * title, or domain — they all come from here, so resolving a naming question is
 * a single-file edit rather than a hunt through the tree.
 *
 * Q1 is resolved (D12): the product is **Open Desktop Authenticator**, on
 * `opendesktopauthenticator.com`, in the GitHub organisation
 * `opendesktopauthenticator`.
 *
 * Every value here is now a real one, so `hasUnresolvedBranding()` reports false
 * and release tooling no longer refuses on branding grounds. **That check can
 * only prove these are not placeholders — it cannot prove the URL resolves.**
 * Confirming the organisation and repository actually exist, and match what
 * `/official` publishes, is a human step on the release checklist.
 */

export const PRODUCT_NAME_PLACEHOLDER = '[PRODUCT_NAME]';

/**
 * Every marker that means "still a placeholder".
 *
 * `appId` cannot literally contain `[PRODUCT_NAME]` — a reverse-DNS identifier
 * has to be a valid one — so a single marker is not enough. Checking only for
 * `[PRODUCT_NAME]` would report branding as resolved the moment the display
 * fields were filled in, leaving a placeholder application id to ship.
 */
const PLACEHOLDER_MARKERS = [PRODUCT_NAME_PLACEHOLDER, 'product-name-placeholder'] as const;

export const branding = {
	/** Display name. Window titles, About dialog, installer. */
	productName: 'Open Desktop Authenticator',

	/**
	 * Short form for tight spaces — tray tooltip, window chrome, conversation.
	 * Deliberately echoes SDA's shape without claiming to be it (§8).
	 */
	shortName: 'ODA',

	/** Executable and CLI name. */
	binaryName: 'oda',

	/** Reverse-DNS application id, derived from the domain we actually own. */
	appId: 'com.opendesktopauthenticator.desktop',

	/** The legal owner. Settled from the start (D1/D2). */
	company: 'MASTERPANEL LLC',

	/** Short form of the publisher, for the "powered by" mark in tight spaces. */
	companyShort: 'MASTERPANEL',

	/**
	 * The publisher's own site.
	 *
	 * Part of the same chain as `repository`: somebody deciding whether this
	 * download is genuine should be able to get from the application to a named
	 * company and check that it exists. A publisher who cannot be looked up is
	 * indistinguishable from one who does not.
	 */
	companyWebsite: 'https://masterspanel.com',

	/** Official domains registry lives at /official (§16). */
	website: 'https://opendesktopauthenticator.com',

	/**
	 * GitHub org and repository.
	 *
	 * This is not decoration. §4's whole answer to the clone problem is a chain a
	 * stranger can walk — website → company → **this URL** → source → public CI
	 * build → published hash and provenance — so it is the link a suspicious user follows to check
	 * that a download is ours. It must resolve to the real repository, and the org
	 * name must match what is published on `/official`.
	 */
	repository: 'https://github.com/opendesktopauthenticator/open-desktop-authenticator',

	/**
	 * The folder under the OS application-data directory. **Pinned, not derived.**
	 *
	 * `app.getPath('userData')` is built from `app.getName()`, and `getName()`
	 * returns package.json's `productName` when that field exists and falls back
	 * to `name` when it does not. This project has no `productName` in
	 * package.json today, so the vault lives in `open-desktop-authenticator`.
	 *
	 * Which means adding a `productName` field — an obvious, harmless-looking
	 * tidy-up that any packaging guide will suggest — would move the vault path.
	 * The application would then open a fresh empty directory, find no vault, and
	 * present itself as a first run. Every account still on disk, none of them
	 * visible, and the user reaching for a recovery code because the app appears
	 * to have eaten their authenticator.
	 *
	 * Nothing has shipped yet, so this is free to fix now and expensive later:
	 * once a release exists, changing this value orphans the vault of everybody
	 * who installed it. `app.setName()` is called with this before any path is
	 * read, so the location is a decision recorded here rather than a side effect
	 * of a field somebody may add.
	 */
	dataDirectory: 'open-desktop-authenticator'
} as const;

/** Fields that are still placeholders. Empty once every naming question is closed. */
export function unresolvedBrandingFields(): string[] {
	return Object.entries(branding)
		.filter(([, value]) => PLACEHOLDER_MARKERS.some((marker) => value.includes(marker)))
		.map(([key]) => key);
}

/** True while any name-dependent value is unresolved. Release tooling must refuse to build. */
export function hasUnresolvedBranding(): boolean {
	return unresolvedBrandingFields().length > 0;
}

/**
 * Exact attribution strings (§8). Never paraphrased — attribution is never
 * phrased as endorsement.
 *
 * **`mckay` was rewritten for D14 and needs founder confirmation.** The original
 * §8 wording named three libraries as things this app was "built on". Two of
 * them are not shipped (D13, Q19) and one now is (`steam-session`), so the
 * original had become false in both directions. The replacement states exactly
 * what is true: one dependency, and a debt for the other two.
 */
export const attribution = {
	mckay:
		'Signing in to Steam uses steam-session, an open-source library by DoctorMcKay. ' +
		'Our own code generation and confirmation handling are checked against ' +
		`steam-totp, and steamcommunity documented the protocol. ${branding.productName} ` +
		'is an independent project and is not affiliated with or endorsed by DoctorMcKay.',
	valve:
		`${branding.productName} is an independent open-source project maintained by ` +
		'MASTERPANEL LLC. Not affiliated with, endorsed by, or sponsored by Valve Corporation. ' +
		'Steam and the Steam logo are trademarks of Valve Corporation.'
} as const;
