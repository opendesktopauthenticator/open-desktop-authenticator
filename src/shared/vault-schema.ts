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
 * How much a confirmation notification says.
 *
 * A toast is not a private surface: Windows shows it on the lock screen and
 * keeps it in notification history. `full` names the trade partner and the
 * items — which is what makes it useful and what makes it a disclosure.
 *
 * It is the default anyway, and the reason is that notifications are **off** by
 * default: nothing reaches a toast until somebody opens this account's screen
 * and switches them on, which is where the disclosure sits. `count` and `type`
 * are there for a shared or unattended machine.
 *
 * The strings `full` prints are Steam's, not ours — the only place text this
 * application did not author reaches an OS surface. They are length-capped and
 * stripped of control characters on the way.
 */
export const notifyDetailSchema = z.enum(['count', 'type', 'full']);
export type NotifyDetail = z.infer<typeof notifyDetailSchema>;

/**
 * Defaults are named constants rather than inline literals because zod 4
 * requires a `.default()` to be the schema's full output type — so the same
 * values are needed twice, and two copies of a security-relevant default is how
 * "off by default" quietly becomes "on".
 */
export const AUTO_CONFIRM_DEFAULTS = Object.freeze({
	marketListings: false,
	trades: false,
	pollIntervalSeconds: 15,
	/**
	 * Frozen **separately**. `Object.freeze` is shallow and `as const` is a
	 * type-level claim with no runtime effect, so without this line the nested
	 * object stays writable — and a single stray write to it changes what every
	 * later parse defaults to, for the life of the process.
	 */
	notify: Object.freeze({ enabled: false, detail: 'full' })
});

// `.passthrough()` on every persisted object, not just accounts. The promise at
// the top of this file — a vault written by a newer build survives an older one
// — held only for account-level fields; unknown settings and top-level fields
// were silently stripped by the next `mutate()`, which validates and writes the
// stripped object back.
export const autoConfirmSchema = z
	.object({
		/** Market listings. Off by default (§12 F6). */
		marketListings: z.boolean().default(AUTO_CONFIRM_DEFAULTS.marketListings),
		/** Trades. Off by default, sterner consent (§12 F6). */
		trades: z.boolean().default(AUTO_CONFIRM_DEFAULTS.trades),
		/** Seconds. Minimum 10 enforced by the engine, not here. */
		pollIntervalSeconds: z
			.number()
			.int()
			.min(10)
			.default(AUTO_CONFIRM_DEFAULTS.pollIntervalSeconds),
		/**
		 * Desktop notifications for confirmations that need a person. Independent
		 * of the two auto-confirm switches above: an account may watch without
		 * ever approving anything, which is the point of the feature.
		 */
		notify: z
			.object({
				enabled: z.boolean().default(AUTO_CONFIRM_DEFAULTS.notify.enabled),
				detail: notifyDetailSchema.default(AUTO_CONFIRM_DEFAULTS.notify.detail)
			})
			// **The nested object needs its own `.passthrough()`.** The outer
			// `autoConfirmSchema` has one, which protects a sibling key called
			// `notify` — it does not protect keys *inside* it. Without this, a
			// future build adding `notify.sound` would have it stripped by the next
			// `mutate()` in an older build, which is exactly the promise the top of
			// this file makes.
			.passthrough()
			// **A function, not a literal — defensively, and measurably not yet
			// load-bearing.** zod resolves a `.default()` with a *shallow* clone, so
			// a literal here is safe today: every field inside `notify` is a
			// primitive, and each parse gets its own copy of them. Measured, not
			// assumed.
			//
			// It matters one level up, where `accountSchema` defaults the whole
			// `autoConfirm` — there the shallow clone copies the outer object and
			// leaves `notify` shared, which is the bug this file used to have.
			//
			// The function form is kept because the day somebody adds a nested field
			// inside `notify`, the literal silently becomes the same bug. Swapping
			// it back turns no test red, and that is recorded here rather than
			// papered over with a test that cannot honestly fail.
			.default(() => ({ ...AUTO_CONFIRM_DEFAULTS.notify }))
	})
	.passthrough();

export type AutoConfirm = z.infer<typeof autoConfirmSchema>;

/**
 * A fresh `autoConfirm` for a newly added account.
 *
 * A function rather than `{ ...AUTO_CONFIRM_DEFAULTS }` at each call site,
 * because `notify` is a nested object and a shallow spread copies the
 * *reference*. Every account added in one session would then share one `notify`,
 * and `vault/ipc.ts` mutates `account.autoConfirm` in place — so switching
 * notifications on for one account would switch them on for all of them, and
 * the vault would be written that way.
 *
 * The flat defaults tolerated a spread. This one does not, which is exactly the
 * kind of change that looks like it needs no follow-up and does.
 */
export function newAutoConfirm(): AutoConfirm {
	return {
		...AUTO_CONFIRM_DEFAULTS,
		notify: { ...AUTO_CONFIRM_DEFAULTS.notify }
	};
}

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
		 * The rest of what Steam issues at enrollment, kept for export fidelity.
		 *
		 * None of these is used to talk to Steam — codes come from `sharedSecret`
		 * and confirmations from `identitySecret`. They are stored because a maFile
		 * written without them is a lossy copy of the one Steam handed us, and the
		 * point of export is that the user is not tied to this application.
		 *
		 * `uri` is the `otpauth://` form, which is how somebody puts the same
		 * authenticator into a second tool if they want one.
		 */
		serialNumber: z.string().optional(),
		tokenGid: z.string().optional(),
		uri: z.string().optional(),
		secret1: z.string().optional(),

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
		/**
		 * `newAutoConfirm` as a **function**, not `AUTO_CONFIRM_DEFAULTS` as a
		 * value. zod resolves a default with a shallow clone, so passing the
		 * constant gave every account parsed without an `autoConfirm` — a legacy
		 * vault, a hand-edited one, a recovery file — the *same* nested `notify`,
		 * shared with the exported constant. One in-place write then flipped
		 * notifications on for every co-defaulted account and for every account
		 * created afterwards.
		 */
		autoConfirm: autoConfirmSchema.default(newAutoConfirm),

		addedAt: z.string(),
		/** Set when the forced revocation-code ceremony completed (§11 S12). */
		revocationBackedUpAt: z.string().optional(),
		/**
		 * **An irreversible Steam operation whose outcome was never established.**
		 *
		 * Activation and removal both reach Steam before anything can go wrong with
		 * the answer, so a lost reply leaves the account in a state only Steam can
		 * report. The screens learned to stop offering the action again — and they
		 * learned it in React state, which lives exactly as long as the component.
		 * Close the screen, or restart, and the application offered "Finish
		 * activation" or "Remove" again, having just said in as many words that it
		 * would not send the request a second time.
		 *
		 * Written here because this is the only place that outlives both. It is
		 * cleared by the user saying they have checked the account, which is the
		 * one thing that can actually settle it — nothing local can.
		 */
		unresolvedOperation: z
			.object({
				kind: z.enum(['activate', 'deactivate']),
				/** What the user was told to do, kept so the screen says it again. */
				guidance: z.string(),
				/** `true` when Steam is known to have acted, rather than may have. */
				certain: z.boolean().optional(),
				/**
				 * **Which authenticator this was about.**
				 *
				 * The record was keyed on the SteamID alone, and a SteamID outlives the
				 * authenticator attached to it: remove the account and enrol or import
				 * a replacement, and a record left over from the old one matched the
				 * new one exactly. Resolving it then marked a brand-new authenticator
				 * active — or, on the removal branch, deleted it.
				 *
				 * A digest of the shared secret rather than the secret: it identifies
				 * the authenticator without adding another copy of the thing the whole
				 * vault exists to protect. Optional because records written before this
				 * existed have none, and those are refused rather than guessed at.
				 */
				fingerprint: z.string().optional(),
				/** Shared identity of the pre-send note and post-answer latch. */
				operationId: z.string().optional(),
				at: z.string()
			})
			/*
			 * **Passthrough, like the account around it.** The account object keeps
			 * fields a newer build wrote, for the reason given below it: losing an
			 * unrecognised field could mean losing a secret. A nested object without
			 * the same rule breaks that promise one level down — zod strips what it
			 * does not know, and the next ordinary save writes the stripped version
			 * back, so a newer build's addition here is destroyed by an older build
			 * merely opening the vault.
			 */
			.passthrough()
			.optional(),
		/**
		 * Ownership and durable retry state for this authenticator's separate
		 * encrypted recovery file.
		 *
		 * Kept inside the encrypted vault so import, enrollment and transfer can
		 * commit the account and the obligation to publish its backup in one
		 * write. `fileName` is a basename allocated by the application, never a
		 * caller-controlled path. It becomes authoritative only after publication
		 * succeeds; `pending` deliberately carries none.
		 */
		recoveryBackup: z
			.object({
				version: z.literal(1),
				/** Generation guard: an older asynchronous completion cannot clear a newer debt. */
				id: z.string().uuid(),
				/** Identifies the authenticator without storing another secret. */
				authenticatorFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
				state: z.enum(['pending', 'current', 'stale']),
				/** Exact application-owned basename; required once a file is owned. */
				fileName: z.string().min(1).max(255).optional(),
				changedAt: z.string()
			})
			.passthrough()
			.superRefine((backup, context) => {
				if (backup.state !== 'pending' && backup.fileName === undefined) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'a published recovery backup needs its exact filename'
					});
				}
				if (backup.state === 'pending' && backup.fileName !== undefined) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'a pending recovery backup cannot claim a filename'
					});
				}
			})
			.optional()
	})
	// Preserve fields written by a newer build rather than dropping them on the
	// next save. Losing an unrecognised field could mean losing a secret.
	.passthrough();

export const VAULT_SETTINGS_DEFAULTS = {
	/**
	 * Refuse to let anything leave by an address other than the one configured.
	 *
	 * **Off, because it settles an ambiguity rather than fixing a defect.** The
	 * browser offers *Direct* beside the routed button: a shared proxy collects
	 * rate limits and Cloudflare challenges a home connection never sees, so the
	 * routed window is sometimes the one that will not load, and somebody who
	 * only wants to accept one trade is better served by an honest choice than by
	 * a window that refuses to open. The control states its cost.
	 *
	 * Some people want the stronger rule anyway: a configured proxy is the only
	 * way out, and the option to go around it should not exist. Turning this on
	 * removes the Direct button and refuses the update check — the one request
	 * this application makes that no account's proxy applies to.
	 *
	 * Enforced in the main process, not by hiding a button. "Only the renderer
	 * offers it" has never counted as a control here.
	 */
	requireProxies: false,
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

export const vaultSettingsSchema = z
	.object({
		requireProxies: z.boolean().default(VAULT_SETTINGS_DEFAULTS.requireProxies),
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
	})
	.passthrough();

export const vaultContentsSchema = z
	.object({
		/** Monotonic, incremented on every save. Detects a lost or rolled-back write. */
		seq: z.number().int().nonnegative(),
		accounts: z.array(accountSchema),
		settings: vaultSettingsSchema.default(VAULT_SETTINGS_DEFAULTS),
		createdAt: z.string(),
		updatedAt: z.string()
	})
	.passthrough()
	// **One Steam identity, one stored account.** Every consumer assumes it —
	// codes and confirmations `find` the first match, removal splices exactly
	// one — and the schema was the one layer that never said so, so a valid
	// legacy or third-party vault carrying duplicates was accepted whole and
	// then half-honoured everywhere. Refused with a message naming the account,
	// because "not valid" alone would strand the person holding the file.
	.superRefine((contents, ctx) => {
		const seen = new Set<string>();
		for (const account of contents.accounts) {
			if (seen.has(account.steamId64)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `duplicate entries for account ${account.steamId64} — this vault lists the same Steam account twice`
				});
				return;
			}
			seen.add(account.steamId64);
		}
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
