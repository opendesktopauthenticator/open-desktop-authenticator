import { z } from 'zod';

/**
 * The IPC contract — the single source of truth for every channel (§10.2, §11 S6).
 *
 * Rules this file exists to enforce:
 *
 *  - Every channel is declared here, by name, with a zod schema for its request
 *    and its response.
 *  - The main process validates the request against the schema at the boundary,
 *    before any handler logic runs.
 *  - Preload exposes only the channels named here. There is no generic
 *    "invoke anything" bridge, ever.
 *  - Adding a channel is a change to this file, which makes it reviewable. §24.3
 *    requires founder sign-off for any change to the IPC surface.
 *
 * Secrets never travel over IPC except the two user-invoked exceptions in
 * §11 S2. Nothing in this file may carry a sharedSecret, identitySecret,
 * revocationCode, refreshToken, or passphrase without that being deliberate and
 * called out in the schema's comment.
 */

export { CHANNELS, type ChannelName } from './channels';
import { CHANNELS, type ChannelName } from './channels';

/** No arguments. Declared explicitly rather than omitted, so every channel has a schema. */
const emptyRequest = z.object({}).strict();

export const appInfoResponse = z.object({
	productName: z.string(),
	version: z.string(),
	company: z.string(),
	/** True while the product name is still a placeholder (Q1). */
	brandingUnresolved: z.boolean(),
	/**
	 * Display only. Deliberately not an enum of supported platforms: an
	 * unrecognised value would fail response validation and turn "running
	 * somewhere unsupported" into a hard IPC error on the About screen.
	 */
	platform: z.string(),
	/** §8 attribution strings, rendered verbatim by the renderer. */
	attribution: z.object({
		mckay: z.string(),
		valve: z.string()
	}),
	/** Reported so the UI can prove the posture rather than assert it. */
	security: z.object({
		sandbox: z.boolean(),
		contextIsolation: z.boolean(),
		nodeIntegration: z.boolean()
	})
});

/**
 * A passphrase travelling renderer -> main.
 *
 * §11 S2 governs what the renderer *receives*; a passphrase the user types must
 * travel inbound or they cannot unlock anything. It is never echoed back, never
 * logged, and never stored in renderer state beyond the input element.
 *
 * The length policy is NOT enforced here: an existing vault may predate a policy
 * change, and refusing to even attempt an unlock would lock its owner out. The
 * service enforces it on create and change, where it belongs.
 */
const passphrase = z.string().min(1).max(1024);

const okResponse = z.object({ ok: z.literal(true) });

export const vaultStatusResponse = z.object({
	exists: z.boolean(),
	unlocked: z.boolean(),
	/** Null while locked. */
	msUntilAutoLock: z.number().nullable(),
	/** Whether a recovery backup is on disk (§12 F1). */
	backupAvailable: z.boolean()
});

/**
 * An account as the renderer is allowed to see it.
 *
 * Carries no `sharedSecret`, no `identitySecret`, no `refreshToken`, and no
 * revocation code — only whether one exists. Anything the UI needs to *display*
 * belongs here; anything that could act as the account does not.
 */
export const accountSummary = z.object({
	steamId64: z.string(),
	accountName: z.string(),
	status: z.enum(['pendingRevocationBackup', 'pendingActivation', 'active']),
	/** Whether a revocation code is on file — not the code itself. */
	hasRevocationCode: z.boolean(),
	/** Whether per-account routing is configured — not the URL, which has credentials. */
	hasProxy: z.boolean(),
	/**
	 * What is actually **known** about this account's egress, which is not the
	 * same thing as `hasProxy`.
	 *
	 * `hasProxy` says a URL is stored. This says whether Chromium was asked what
	 * it would do with a request and what it answered:
	 *
	 *  - `off` — not routed, and not pretending to be
	 *  - `unverified` — routed, but nothing has connected yet, so nothing is known
	 *  - `verified` — checked, and the intended proxy was applied
	 *  - `blocked` — checked, and it was **not**. The account refuses to connect.
	 *
	 * Shown on the account card because "routed" meaning "a field is populated"
	 * is precisely the reassurance an anonymity feature must not give.
	 */
	routing: z.enum(['off', 'unverified', 'verified', 'blocked']),
	/** Redacted proxy the check concerned, when there is one. Never the credentials. */
	routedVia: z.string().optional(),
	/** Why routing was refused, when `routing` is `blocked`. */
	routingProblem: z.string().optional(),
	autoConfirm: z.object({
		marketListings: z.boolean(),
		trades: z.boolean(),
		pollIntervalSeconds: z.number()
	})
});

export const accountsListResponse = z.object({
	accounts: z.array(accountSummary)
});

/**
 * The settings a user may change, and only those.
 *
 * `convenienceUnlock`, `launchAtStartup` and `startMinimised` exist in the vault
 * schema and are deliberately **not** here: nothing implements them yet, and a
 * control that appears to work and does nothing is worse than no control. They
 * arrive with the features that honour them.
 *
 * Bounds are the schema's own, restated so the UI can refuse a bad value while
 * the user is still looking at the field rather than after a failed save.
 */
export const vaultSettingsView = z.object({
	/** 1–240. How long the vault stays unlocked with no interaction. */
	autoLockMinutes: z.number().int().min(1).max(240),
	/** 5–300. How long a copied Steam Guard code stays on the clipboard. */
	clipboardClearSeconds: z.number().int().min(5).max(300)
});

export const settingsUpdateRequest = vaultSettingsView.strict();

/**
 * §11 S2 exception (a): the forced revocation-code backup ceremony.
 *
 * One of exactly two sanctioned paths for a long-term secret to reach the
 * renderer. Deliberately singular — there is no bulk variant, because a screen
 * showing every recovery code at once is a screenshot away from being the whole
 * vault.
 */
export const revocationRevealRequest = z
	.object({
		steamId64: z.string(),
		/**
		 * Required even though the vault is already unlocked. Being unlocked means
		 * "this machine was used recently", not "the owner is present" — and an
		 * unattended unlocked machine must not surrender recovery codes.
		 */
		passphrase
	})
	.strict();

export const revocationRevealResponse = z.object({
	/** S2 exception (a). Displayed, never stored, cleared on navigation. */
	revocationCode: z.string()
});

/**
 * One maFile as the renderer is allowed to see it (§12 F2).
 *
 * Carries **no secret** — not the shared secret, not the identity secret, not
 * the revocation code, not the session token, not the proxy URL (which usually
 * embeds credentials). Only whether each exists, so the user can see what they
 * are about to import and what the file was missing.
 *
 * `stagingId` is an opaque random id, not a file path. The renderer never learns
 * where the file lives, and cannot name a file the user did not pick.
 */
export const importCandidate = z.object({
	stagingId: z.string(),
	/** Base name only. The containing directory is not the renderer's business. */
	sourceName: z.string(),
	accountName: z.string(),
	steamId64: z.string().optional(),
	/** Where the SteamID came from, so "taken from the file name" is visible. */
	steamIdSource: z.enum(['Session.SteamID', 'steamid', 'filename']).optional(),
	hasRevocationCode: z.boolean(),
	hasProxy: z.boolean(),
	/** Whether a usable MobileApp session came with it — never the token. */
	hasSession: z.boolean(),
	/** False when the file cannot be stored at all; `warnings` says why. */
	importable: z.boolean(),
	/** `vault` — already in the vault. `selection` — an earlier file in this same pick. */
	duplicate: z.enum(['vault', 'selection']).optional(),
	warnings: z.array(z.string())
});

export const importReportResponse = z.object({
	/** True when the user closed the picker. Everything else is then empty. */
	cancelled: z.boolean(),
	candidates: z.array(importCandidate),
	/** Files that could not be parsed at all, with the reason shown to the user. */
	rejected: z.array(z.object({ sourceName: z.string(), reason: z.string() }))
});

export const importCommitRequest = z
	.object({
		selections: z
			.array(
				z
					.object({
						stagingId: z.string().min(1),
						/** Required, not defaulted: overwriting an account is never implicit. */
						replaceExisting: z.boolean(),
						/**
						 * Whether to adopt the proxy stored inside the maFile.
						 *
						 * Required and never defaulted, for the same reason
						 * `replaceExisting` is. maFiles written by trading tools routinely
						 * carry a proxy the user has long since stopped paying for, and
						 * adopting it silently produces an account that cannot reach Steam
						 * at all — routing fails closed by design, so a dead proxy is total
						 * failure rather than degraded service. Importing an account and
						 * choosing to route it are two separate decisions.
						 */
						adoptProxy: z.boolean()
					})
					.strict()
			)
			.max(200)
	})
	.strict();

export const importCommitResponse = z.object({
	outcomes: z.array(
		z.object({
			stagingId: z.string(),
			accountName: z.string(),
			result: z.enum(['imported', 'replaced', 'skipped']),
			/** Present whenever the result is `skipped`. */
			reason: z.string().optional()
		})
	)
});

/**
 * A Steam Guard code (§12 F4).
 *
 * This is the one response that carries something usable, and it is deliberate.
 * A code is not a long-term secret: it expires in under thirty seconds, it
 * cannot be reversed into the shared secret that produced it, and it is useless
 * without the account password. §11 S2 protects the shared secret — which never
 * leaves the main process — not its short-lived output.
 */
export const guardCode = z.object({
	steamId64: z.string(),
	accountName: z.string(),
	/** Five characters from Steam's alphabet. */
	code: z.string(),
	secondsRemaining: z.number()
});

export const codesListResponse = z.object({
	codes: z.array(guardCode),
	/**
	 * Accounts whose code could not be produced — a corrupted shared secret, say.
	 * Reported per account so one damaged record cannot hide every other code.
	 */
	failures: z.array(z.object({ steamId64: z.string(), reason: z.string() })),
	/**
	 * True while this machine's clock has never been checked against Steam's. The
	 * UI says so, because a skewed clock produces codes Steam rejects and looks
	 * exactly like a broken authenticator.
	 */
	clockUnverified: z.boolean()
});

export const codeCopyRequest = z.object({ steamId64: z.string() }).strict();

export const codeCopyResponse = z.object({
	/** Echoed so the UI can show what it put on the clipboard. */
	code: z.string(),
	/** When the clipboard will be wiped, so the user can be told rather than surprised. */
	clipboardClearsInSeconds: z.number()
});

/**
 * A pending confirmation, as the renderer may see it.
 *
 * **No nonce.** Acting on a confirmation needs its id *and* its nonce; only the
 * id crosses, so the UI can ask to approve something it was shown and cannot ask
 * to approve something it was not.
 *
 * `typeName` is ours, from the S16 table — a label the server chooses is a label
 * an attacker chooses, and this one is what the user reads before deciding.
 */
export const confirmationSummary = z.object({
	id: z.string(),
	type: z.number(),
	typeName: z.string(),
	/** Steam's own label for the type. Shown beside ours, never trusted in its place. */
	steamTypeName: z.string().optional(),
	headline: z.string().optional(),
	summary: z.array(z.string()).optional(),
	creatorId: z.string().optional(),
	/** Unix **milliseconds**, normalised from whatever Steam sent. */
	createdAtMs: z.number().optional(),
	/** Whether this confirmation covers several items rather than one. */
	multi: z.boolean().optional(),
	/**
	 * Whether Steam supplied an image — never the URL.
	 *
	 * The renderer must not fetch it: a remote `<img>` is a request made outside
	 * the per-account transport, so it would leave from the user's real address
	 * for a routed account. Sending only the boolean means the renderer cannot
	 * make that request even by accident.
	 */
	hasIcon: z.boolean(),
	/** Account recovery or a phone-number change: someone may be taking the account. */
	securityCritical: z.boolean(),
	/** Whether this type could ever be automatic. Not whether it will be. */
	autoConfirmable: z.boolean()
});

export const confirmationsListResponse = z.object({
	confirmations: z.array(confirmationSummary),
	/**
	 * Steam has no usable session for this account.
	 *
	 * A **state**, not an error, and that distinction is the point: it is
	 * something the user can fix in one step, so the screen becomes the way to fix
	 * it rather than a message about a failure. Returning it as a thrown error
	 * meant the renderer could only show text.
	 */
	signInRequired: z.boolean(),
	/** Why, in terms the user can act on. Present when `signInRequired`. */
	reason: z.string().optional()
});

/**
 * One thing automatic confirmation did, or refused to do.
 *
 * Same shape the renderer already receives for a confirmation — no nonce, no
 * secret. `held` is the one that matters: a refused account-recovery
 * confirmation means somebody may be taking the account.
 */
export const activityEntry = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('approved'),
		at: z.string(),
		confirmations: z.array(confirmationSummary)
	}),
	z.object({
		kind: z.literal('held'),
		at: z.string(),
		confirmation: confirmationSummary,
		reason: z.string()
	}),
	z.object({ kind: z.literal('failed'), at: z.string(), reason: z.string() }),
	z.object({ kind: z.literal('halted'), at: z.string(), reason: z.string() })
]);

export const activityListResponse = z.object({
	entries: z.array(z.object({ steamId64: z.string(), entry: activityEntry })),
	/** True while something is waiting that a person genuinely needs to look at. */
	urgent: z.boolean()
});

export const confirmationsActRequest = z
	.object({
		steamId64: z.string(),
		action: z.enum(['allow', 'cancel']),
		ids: z.array(z.string()).min(1).max(100)
	})
	.strict();

/**
 * The channel table. Adding an entry here is the only way to add IPC surface,
 * and §24.3 requires founder sign-off for the change.
 */
export const IPC_CONTRACT = {
	[CHANNELS.appInfo]: { request: emptyRequest, response: appInfoResponse },

	[CHANNELS.vaultStatus]: { request: emptyRequest, response: vaultStatusResponse },
	[CHANNELS.vaultCreate]: { request: z.object({ passphrase }).strict(), response: okResponse },
	[CHANNELS.vaultUnlock]: { request: z.object({ passphrase }).strict(), response: okResponse },
	[CHANNELS.vaultLock]: { request: emptyRequest, response: okResponse },
	[CHANNELS.vaultTouch]: { request: emptyRequest, response: okResponse },
	[CHANNELS.vaultChangePassphrase]: {
		request: z.object({ current: passphrase, next: passphrase }).strict(),
		response: okResponse
	},

	[CHANNELS.accountsList]: { request: emptyRequest, response: accountsListResponse },

	[CHANNELS.settingsGet]: { request: emptyRequest, response: vaultSettingsView },
	[CHANNELS.settingsUpdate]: { request: settingsUpdateRequest, response: okResponse },

	[CHANNELS.accountRemove]: {
		request: z
			.object({
				steamId64: z.string(),
				/**
				 * Required even though the vault is unlocked, exactly as the revocation
				 * reveal requires it. Being unlocked means this machine was used
				 * recently, not that its owner is at it — and an unattended machine
				 * must not be able to destroy the only copy of a shared secret.
				 */
				passphrase,
				/**
				 * The user has been told that this does not remove the authenticator
				 * from Steam. Sent as a value rather than assumed, so the destructive
				 * path cannot be reached by a caller that never showed the warning.
				 */
				acknowledged: z.literal(true)
			})
			.strict(),
		response: okResponse
	},

	[CHANNELS.accountSetAutoConfirm]: {
		request: z
			.object({
				steamId64: z.string(),
				/** Market listings. Off by default (§12 F6). */
				marketListings: z.boolean(),
				/** Trades. Off by default, and the sterner of the two. */
				trades: z.boolean(),
				/**
				 * Seconds between polls. Floored at 10 by the vault schema and again
				 * here: a tighter loop is rate-limit bait, and the point of automatic
				 * confirmation is not to be fast.
				 */
				pollIntervalSeconds: z.number().int().min(10).max(3600)
			})
			.strict(),
		response: okResponse
	},

	[CHANNELS.accountSetProxy]: {
		request: z
			.object({
				steamId64: z.string(),
				/**
				 * `null` removes routing entirely. Not an empty string: "" and "unset"
				 * being the same value is how a control that looks cleared leaves
				 * something behind.
				 */
				proxyUrl: z.string().max(2048).nullable()
			})
			.strict(),
		response: okResponse
	},

	[CHANNELS.importScan]: { request: emptyRequest, response: importReportResponse },
	[CHANNELS.importCommit]: { request: importCommitRequest, response: importCommitResponse },
	[CHANNELS.importDiscard]: { request: emptyRequest, response: okResponse },

	[CHANNELS.codesList]: { request: emptyRequest, response: codesListResponse },
	[CHANNELS.codeCopy]: { request: codeCopyRequest, response: codeCopyResponse },

	[CHANNELS.activityList]: { request: emptyRequest, response: activityListResponse },

	[CHANNELS.confirmationsList]: {
		request: z.object({ steamId64: z.string() }).strict(),
		response: confirmationsListResponse
	},
	[CHANNELS.confirmationsAct]: { request: confirmationsActRequest, response: okResponse },

	[CHANNELS.steamSignIn]: {
		// The password travels inbound, exactly as a vault passphrase does, and is
		// dropped as soon as Steam has answered.
		request: z.object({ steamId64: z.string(), password: z.string().min(1).max(1024) }).strict(),
		response: okResponse
	},

	[CHANNELS.revocationReveal]: {
		request: revocationRevealRequest,
		response: revocationRevealResponse
	},
	[CHANNELS.revocationConfirmBackup]: {
		request: z.object({ steamId64: z.string() }).strict(),
		response: okResponse
	}
} as const satisfies Record<ChannelName, { request: z.ZodType; response: z.ZodType }>;

export type AppInfo = z.infer<typeof appInfoResponse>;
export type VaultStatus = z.infer<typeof vaultStatusResponse>;
export type AccountSummary = z.infer<typeof accountSummary>;
export type ImportCandidate = z.infer<typeof importCandidate>;
export type ImportReport = z.infer<typeof importReportResponse>;
export type ImportSelection = z.infer<typeof importCommitRequest>['selections'][number];
export type ImportOutcome = z.infer<typeof importCommitResponse>['outcomes'][number];
export type GuardCodeSummary = z.infer<typeof guardCode>;
export type CodesList = z.infer<typeof codesListResponse>;
export type ConfirmationSummary = z.infer<typeof confirmationSummary>;
export type ConfirmationsList = z.infer<typeof confirmationsListResponse>;
export type ActivityEntryView = z.infer<typeof activityEntry>;
export type ActivityList = z.infer<typeof activityListResponse>;
export type VaultSettingsView = z.infer<typeof vaultSettingsView>;

/** The typed surface preload puts on `window`. Renderer sees exactly this. */
export interface RendererApi {
	getAppInfo(): Promise<AppInfo>;

	getVaultStatus(): Promise<VaultStatus>;
	createVault(passphrase: string): Promise<{ ok: true }>;
	unlockVault(passphrase: string): Promise<{ ok: true }>;
	lockVault(): Promise<{ ok: true }>;
	touchVault(): Promise<{ ok: true }>;
	changePassphrase(current: string, next: string): Promise<{ ok: true }>;

	listAccounts(): Promise<{ accounts: AccountSummary[] }>;

	/** The timings the user can change. No secrets. */
	getSettings(): Promise<VaultSettingsView>;
	updateSettings(settings: VaultSettingsView): Promise<{ ok: true }>;
	/** Set routing for one account, or pass `null` to remove it. */
	setAccountProxy(steamId64: string, proxyUrl: string | null): Promise<{ ok: true }>;
	/** Enable or disable automatic confirmation for one account, per type. */
	setAccountAutoConfirm(
		steamId64: string,
		settings: { marketListings: boolean; trades: boolean; pollIntervalSeconds: number }
	): Promise<{ ok: true }>;
	/**
	 * Remove an account and its secrets from this vault.
	 *
	 * Irreversible, and does not touch Steam. The passphrase and the explicit
	 * acknowledgement are both required by the contract.
	 */
	removeAccount(steamId64: string, passphrase: string): Promise<{ ok: true }>;

	/** Opens the OS file picker and reports what was chosen. No paths, no secrets. */
	scanMaFiles(): Promise<ImportReport>;
	commitImport(selections: ImportSelection[]): Promise<{ outcomes: ImportOutcome[] }>;
	discardImport(): Promise<{ ok: true }>;

	/** Steam Guard codes for every account. Short-lived by construction. */
	listCodes(): Promise<CodesList>;
	/** Copy one code. Main owns the clipboard and its auto-clear timer. */
	copyCode(steamId64: string): Promise<{ code: string; clipboardClearsInSeconds: number }>;

	/** What automatic confirmation did while nobody was watching. */
	listActivity(): Promise<ActivityList>;
	/** Pending confirmations for one account. */
	listConfirmations(steamId64: string): Promise<ConfirmationsList>;
	/** Approve or deny by id. The nonce never leaves the main process. */
	actOnConfirmations(
		steamId64: string,
		action: 'allow' | 'cancel',
		ids: string[]
	): Promise<{ ok: true }>;
	/** Sign in once. The password is used and dropped; the session is what is kept. */
	signInToSteam(steamId64: string, password: string): Promise<{ ok: true }>;

	/** §11 S2 exception (a). Requires the passphrase again. */
	revealRevocationCode(steamId64: string, passphrase: string): Promise<{ revocationCode: string }>;
	/** Record that the code has been written down, clearing the account's warning. */
	confirmRevocationBackup(steamId64: string): Promise<{ ok: true }>;
}
