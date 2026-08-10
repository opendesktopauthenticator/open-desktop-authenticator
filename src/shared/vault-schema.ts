import { z } from 'zod';

/**
 * What lives inside the encrypted envelope (§10.3).
 *
 * This is a persistence format: changing it means migrating every existing
 * vault, and the data inside is frequently the only copy in existence. Fields
 * are added, never repurposed.
 *
 * Unknown fields are **preserved**, not stripped — see `accountSchema`. A vault
 * written by a newer build and opened by an older one must not silently lose the
 * fields the older build does not understand.
 */

/**
 * SteamID64 is a **string**, always, everywhere.
 *
 * It exceeds `Number.MAX_SAFE_INTEGER`, so any path that lets it become a
 * JavaScript number silently rewrites it into a different account's ID (F-01).
 * Storing it as a string is the only reason that cannot happen here.
 */
export const steamId64Schema = z
	.string()
	.regex(/^7656119\d{10}$/, 'must be a 17-digit SteamID64 stored as a string');

/** Base64 secret as Steam issues them. */
const secretSchema = z.string().min(1);

export const accountStatusSchema = z.enum([
	/** Secrets are stored but the revocation code has not been backed up yet. */
	'pendingRevocationBackup',
	/** Enrollment started, `finalizeTwoFactor` not yet completed (§12 F3). */
	'pendingActivation',
	/** Fully usable. */
	'active'
]);

/**
 * Defaults are named constants rather than inline literals because zod 4
 * requires a `.default()` to be the schema's full output type — so the same
 * values are needed twice, and two copies of a security-relevant default is how
 * "off by default" quietly becomes "on".
 */
export const AUTO_CONFIRM_DEFAULTS = {
	marketListings: false,
	trades: false,
	pollIntervalSeconds: 15
} as const;

export const autoConfirmSchema = z.object({
	/** Market listings. Off by default (§12 F6). */
	marketListings: z.boolean().default(AUTO_CONFIRM_DEFAULTS.marketListings),
	/** Trades. Off by default, sterner consent (§12 F6). */
	trades: z.boolean().default(AUTO_CONFIRM_DEFAULTS.trades),
	/** Seconds. Minimum 10 enforced by the engine, not here. */
	pollIntervalSeconds: z.number().int().min(10).default(AUTO_CONFIRM_DEFAULTS.pollIntervalSeconds)
});

export const accountSchema = z
	.object({
		steamId64: steamId64Schema,
		accountName: z.string().min(1),

		sharedSecret: secretSchema,
		identitySecret: secretSchema,

		/**
		 * Absent for accounts imported from a maFile that never had one. Such an
		 * account cannot be self-recovered and cannot use authenticator removal, so
		 * import flags it loudly rather than refusing (§12 F2).
		 */
		revocationCode: z.string().optional(),

		/**
		 * Kept for maFile export fidelity only. It is NOT what gets sent to Steam:
		 * steamcommunity derives the device ID from the SteamID on every request,
		 * and Steam does not validate it (F-02).
		 */
		deviceId: z.string().optional(),

		/**
		 * A **MobileApp-scoped** refresh token. A web-scoped token looks valid and
		 * unexpired but cannot drive mobile confirmations (F-13), so the audience is
		 * validated on load rather than at the first failed confirmation.
		 */
		refreshToken: z.string().optional(),

		/** Per-account network routing. The ecosystem already stores one per account
		 * inside maFiles, so users expect it here (F-11). */
		proxyUrl: z.string().optional(),

		status: accountStatusSchema,
		autoConfirm: autoConfirmSchema.default(AUTO_CONFIRM_DEFAULTS),

		addedAt: z.string(),
		/** Set when the forced revocation-code ceremony completed (§11 S12). */
		revocationBackedUpAt: z.string().optional()
	})
	// Preserve fields written by a newer build rather than dropping them on the
	// next save. Losing an unrecognised field could mean losing a secret.
	.passthrough();

export const VAULT_SETTINGS_DEFAULTS = {
	autoLockMinutes: 10,
	clipboardClearSeconds: 30,
	convenienceUnlock: false,
	launchAtStartup: false,
	startMinimised: false,
	/**
	 * Ask GitHub whether a newer release exists. On by default (§11 S11).
	 *
	 * **Defaulting this to off would be the wrong kind of caution.** It is the one
	 * request this application makes that is not to Steam, and it does reveal an
	 * IP and that this app is running — so it is disclosed and switchable. But an
	 * authenticator running a version with a known Valve-side break, whose user
	 * never finds out, is a worse outcome than GitHub learning somebody asked a
	 * question every anonymous visitor may ask. Nothing about the user is sent.
	 */
	updateCheck: true
} as const;

export const vaultSettingsSchema = z.object({
	autoLockMinutes: z
		.number()
		.int()
		.min(1)
		.max(240)
		.default(VAULT_SETTINGS_DEFAULTS.autoLockMinutes),
	clipboardClearSeconds: z
		.number()
		.int()
		.min(5)
		.max(300)
		.default(VAULT_SETTINGS_DEFAULTS.clipboardClearSeconds),
	/** Off by default; refused entirely on Linux without a real keyring (§10.3). */
	convenienceUnlock: z.boolean().default(VAULT_SETTINGS_DEFAULTS.convenienceUnlock),
	launchAtStartup: z.boolean().default(VAULT_SETTINGS_DEFAULTS.launchAtStartup),
	startMinimised: z.boolean().default(VAULT_SETTINGS_DEFAULTS.startMinimised),
	updateCheck: z.boolean().default(VAULT_SETTINGS_DEFAULTS.updateCheck)
});

export const vaultContentsSchema = z.object({
	/** Monotonic, incremented on every save. Detects a lost or rolled-back write. */
	seq: z.number().int().nonnegative(),
	accounts: z.array(accountSchema),
	settings: vaultSettingsSchema.default(VAULT_SETTINGS_DEFAULTS),
	createdAt: z.string(),
	updatedAt: z.string()
});

export type Account = z.infer<typeof accountSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type VaultSettings = z.infer<typeof vaultSettingsSchema>;
export type VaultContents = z.infer<typeof vaultContentsSchema>;

/** A brand-new, empty vault. */
export function emptyVault(now = new Date()): VaultContents {
	const iso = now.toISOString();
	return vaultContentsSchema.parse({
		seq: 0,
		accounts: [],
		settings: {},
		createdAt: iso,
		updatedAt: iso
	});
}

/**
 * Passphrase policy (§10.3) lives in its own zod-free module so the renderer can
 * import it without pulling zod into its bundle. Re-exported here so vault code
 * has one obvious place to look.
 */
export { MIN_PASSPHRASE_LENGTH, passphraseProblem } from './passphrase-policy';
