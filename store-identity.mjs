/**
 * The three values that only Partner Center can tell you.
 *
 * An MSIX package declares who published it, and Windows refuses to install one
 * whose declared identity does not match the account that submitted it. Those
 * strings are issued when the Microsoft Store account is created, so they cannot
 * be derived, guessed, or filled in from anywhere in this repository.
 *
 * They are placeholders until then, and `electron-builder.config.mjs` refuses to
 * produce an appx while they still are — the same shape as
 * `hasUnresolvedBranding()` in `src/shared/branding.ts`, and for the same
 * reason. A package built with a placeholder identity is not a broken build that
 * fails loudly; it is a package that builds, uploads, and is rejected by the
 * Store with a message about identity mismatch that reads like a bug in the
 * pipeline. Better to refuse at the point where the missing thing is obvious.
 *
 * ## Where each one comes from
 *
 * Partner Center → your app → Product Identity. It lists all three verbatim.
 *
 *   identityName          Looks like `12345MASTERPANELLLC.OpenDesktopAuthenti`.
 *                         Microsoft assigns it; it is not your choice.
 *   publisher             The full `CN=...` string, including the GUID-looking
 *                         tail. Copy it exactly — it is a Distinguished Name,
 *                         not a display value, and a single character out means
 *                         the package will not install.
 *   publisherDisplayName  What users see. **Must match the Store account's
 *                         legal name**, which is the same string the Kentucky
 *                         record settles. If those disagree, so do the Store
 *                         listing and this application's About screen.
 */

/** The marker that means "still waiting on Partner Center". */
export const STORE_IDENTITY_PLACEHOLDER = '[FROM_PARTNER_CENTER]';

export const storeIdentity = {
	/** Assigned by Microsoft. Partner Center → Product Identity → Package/Identity/Name. */
	identityName: 'TheMaster.OpenDesktopAuthenticator',

	/**
	 * The full Distinguished Name. Partner Center → Product Identity → Publisher.
	 *
	 * A GUID rather than a readable name, and that is Microsoft's doing: the
	 * Store issues one per publisher account and the package will not install if
	 * a single character differs. It is not a secret — it ships inside every
	 * package — and it is not the name users see, which is
	 * `publisherDisplayName` below.
	 */
	publisher: 'CN=249BBF8E-FB90-4514-91E4-4A29DD6A669E',

	/**
	 * Shown to users in the Store and in Windows.
	 *
	 * Not a placeholder, because it is not Microsoft's to tell us — it is the
	 * company's legal name, and it has to match both the Store account and
	 * `branding.company`. Left here rather than imported so that this file is
	 * readable by the builder config without pulling TypeScript through it.
	 */
	publisherDisplayName: 'MASTERPANEL LLC',

	/**
	 * Identifies the app within the package. Alphanumeric, must start with a
	 * letter, no spaces. Ours by choice, and changing it later is a new app to
	 * Windows rather than an update to this one — so it is set once.
	 */
	applicationId: 'OpenDesktopAuthenticator'
};

/** Fields still waiting on Partner Center. Empty once the Store account exists. */
export function unresolvedStoreFields() {
	return Object.entries(storeIdentity)
		.filter(([, value]) => value.includes(STORE_IDENTITY_PLACEHOLDER))
		.map(([key]) => key);
}

/** True while the Store identity is incomplete. The appx target must refuse. */
export function hasUnresolvedStoreIdentity() {
	return unresolvedStoreFields().length > 0;
}
