/**
 * Types for the Store identity module.
 *
 * `store-identity.mjs` is plain JavaScript because `electron-builder.config.mjs`
 * imports it directly and the builder does not run TypeScript. The declarations
 * live here so the test suite can read the same values under `checkJs`-free
 * strictness rather than reaching for `any`.
 */

export declare const STORE_IDENTITY_PLACEHOLDER: string;

export declare const storeIdentity: {
	/** Assigned by Microsoft. Partner Center → Product Identity. */
	identityName: string;
	/** The full Distinguished Name, `CN=…`. Issued per publisher account. */
	publisher: string;
	/** The company's legal name, as the Store account records it. */
	publisherDisplayName: string;
	/** Ours by choice, and fixed: changing it is a new app to Windows. */
	applicationId: string;
};

/** Fields still carrying the placeholder. Empty once Partner Center has answered. */
export declare function unresolvedStoreFields(): string[];

/** True while the Store identity is incomplete. The appx target must refuse. */
export declare function hasUnresolvedStoreIdentity(): boolean;
