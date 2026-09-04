import { z } from 'zod';
import { notifyDetailSchema, type NotifyDetail } from './vault-schema';

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

// Re-exported so the main process keeps one import path for the contract.
// The definitions live in `acknowledgements.ts`, which is zod-free, so the two
// screens that need the phrases do not drag the schema library into the
// renderer bundle.
export {
	TRADES_ACK,
	DEACTIVATE_ACK,
	matchesTradesAck,
	matchesDeactivateAck
} from './acknowledgements';

export const appInfoResponse = z.object({
	productName: z.string(),
	version: z.string(),
	company: z.string(),
	/** Publisher short form and site, for the "powered by" mark and the About screen. */
	companyShort: z.string(),
	companyWebsite: z.string(),
	/** Where a suspicious person goes to check this build is ours (§4). */
	website: z.string(),
	repository: z.string(),
	/** True while the product name is still a placeholder (Q1). */
	brandingUnresolved: z.boolean(),
	/**
	 * Display only. Deliberately not an enum of supported platforms: an
	 * unrecognised value would fail response validation and turn "running
	 * somewhere unsupported" into a hard IPC error on the About screen.
	 */
	platform: z.string(),
	/**
	 * Installed from the Microsoft Store, where Windows does the updating.
	 *
	 * The renderer needs this because the update-check setting is meaningless in
	 * that build: the check is refused before it reads the preference, so leaving
	 * a toggle on screen would offer a switch that changes nothing and describe a
	 * GitHub request that is never made. A control that lies about what it does
	 * is worse than one that is absent.
	 */
	installedFromStore: z.boolean(),
	/**
	 * Whether this machine can show a desktop notification at all.
	 *
	 * **Because a notify-only account has no other surface.** A successful
	 * notify-only poll writes no activity entry — only the confirm arm does — so
	 * on a machine with no notification service a security-critical confirmation
	 * produced no toast, no record and no retry. The setting is still allowed;
	 * the screen beside it has to be able to say what it will actually do.
	 */
	notificationsAvailable: z.boolean(),
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
	/**
	 * Whether the vault refuses unrouted browsing.
	 *
	 * On the status rather than fetched with the settings because the account
	 * list needs it and the status is what that screen already polls. False
	 * while locked, which is also what the list shows then: nothing.
	 */
	requireProxies: z.boolean(),
	/**
	 * Whether update checks are permitted.
	 *
	 * On the status beside `requireProxies` because the renderer's update effect
	 * has to re-run when either of them changes. It asked only when the unlocked
	 * state changed, so turning the check back on — or turning `Require proxies`
	 * off, which is the other thing that stops it — left the app waiting until
	 * the next unlock to find out there was a release.
	 */
	updateCheck: z.boolean(),
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
	/**
	 * The separate encrypted recovery file still needs local publication.
	 *
	 * Deliberately only the actionable state: its filename, generation and
	 * authenticator fingerprint remain in the main process.
	 */
	recoveryBackup: z.enum(['pending', 'stale']).optional(),
	/**
	 * An irreversible operation on this account whose outcome was never
	 * established, carried so the screens keep refusing to repeat it across a
	 * close and a restart rather than for the life of a React component.
	 */
	unresolvedOperation: z
		.object({
			kind: z.enum(['activate', 'deactivate']),
			guidance: z.string(),
			certain: z.boolean().optional(),
			/** Opaque identity required when answering what this exact record means. */
			operationToken: z.string().length(64).optional(),
			/** The fingerprint proves the record names an older authenticator, so it may be discarded. */
			stale: z.boolean().optional(),
			/** Opaque identity of the exact stale record displayed. */
			staleToken: z.string().length(64).optional(),
			/** A legacy record has no identity, so it cannot safely be discarded or reconciled. */
			unidentified: z.boolean().optional(),
			at: z.string()
		})
		.optional(),
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
		pollIntervalSeconds: z.number(),
		/**
		 * Desktop notifications. Independent of the two switches above — an
		 * account may watch without ever approving anything.
		 *
		 * Carried on the summary because the screen cannot render a control for a
		 * value it was never told.
		 */
		notify: z.object({ enabled: z.boolean(), detail: notifyDetailSchema })
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
	/**
	 * Whether every request must go through a proxy.
	 *
	 * On the view because the Settings screen shows it and because `VaultHome`
	 * stops offering Direct when it is on. **Neither of those is the control.**
	 * The main process refuses a `direct` route and refuses the update check on
	 * its own; a renderer that kept drawing the button would be pressing it into
	 * a refusal, which is the behaviour this setting is for.
	 */
	requireProxies: z.boolean(),
	/** 1–240. How long the vault stays unlocked with no interaction. */
	autoLockMinutes: z.number().int().min(1).max(240),
	/** 5–300. How long a copied Steam Guard code stays on the clipboard. */
	clipboardClearSeconds: z.number().int().min(5).max(300),
	/**
	 * Whether to ask GitHub about newer releases.
	 *
	 * Surfaced as a real switch rather than left implicit, because it is the only
	 * request this application makes that is not to Steam. The Settings screen
	 * says what it does and does not send.
	 */
	updateCheck: z.boolean()
});

export const settingsUpdateRequest = vaultSettingsView.strict();

/**
 * The answer to "is there a newer version".
 *
 * Carries a version and a **link to a release page** — never a download URL, and
 * never an asset. The renderer cannot be handed something it could fetch, so a
 * future change that tried to auto-install would have to widen this schema
 * first, in a file §24.3 requires sign-off to change.
 *
 * `unknown` is a first-class state rather than being folded into `upToDate`.
 * "We could not ask" and "you are current" are different facts, and conflating
 * them hides a version with a known break behind a reassuring tick.
 */
/**
 * How the in-app browser leaves the machine.
 *
 * Three, not two, because the middle one is what people actually want. A proxy
 * shared between accounts collects rate limits and Cloudflare challenges a home
 * connection never sees, so a fully routed window is sometimes the one that
 * will not load — and going fully direct puts the machine's own address on the
 * account, which is the thing the proxy was bought to prevent.
 *
 * `steam-only` routes every Steam request **and everything it does not
 * recognise**, and lets out only a short, named list of third-party trade
 * sites. Not "everything else goes direct", which is what the first version of
 * this route did and what this comment used to say: under that rule a Steam
 * domain nobody had listed became a silent direct request, from the window
 * whose whole promise is that Steam does not see this machine's address.
 * Defaulting the other way costs a slow load on an unknown host and cannot
 * leak. `egress.ts` holds the list and the reasoning.
 *
 * The choice is per window, and the account keeps its stored proxy either way —
 * this says which of them to use, never what the address is.
 */
export const browserRoute = z.enum(['proxy', 'steam-only', 'direct']);
export type BrowserRoute = z.infer<typeof browserRoute>;

export const updateCheckResponse = z.discriminatedUnion('state', [
	z.object({ state: z.literal('disabled') }),
	/**
	 * Installed from the Microsoft Store, which does the updating itself.
	 *
	 * Distinct from `disabled`, which means the user switched checking off. This
	 * is not a preference and there is nothing to turn back on: Windows fetches
	 * and verifies the new package, so pointing this user at a GitHub release
	 * would hand them a second, unmanaged copy of an application they already
	 * have — the one outcome an authenticator can least afford, since the two
	 * installs would keep separate vaults.
	 */
	z.object({ state: z.literal('storeManaged') }),
	z.object({ state: z.literal('upToDate') }),
	z.object({
		state: z.literal('updateAvailable'),
		version: z.string(),
		url: z.string(),
		publishedAt: z.string().optional()
	}),
	z.object({ state: z.literal('unknown'), reason: z.string() })
]);

/**
 * Where an enrollment got to.
 *
 * `enrolled` means the Steam account has already been changed and the secrets
 * are already in the vault — it is not "about to happen", it is "has happened".
 * The screen must treat it as a point of no return and send the user straight to
 * the revocation-code ceremony.
 *
 * No secret is carried. The revocation code reaches the user through the
 * existing S2-sanctioned reveal, gated on the passphrase, rather than being
 * handed out as a side effect of enrolling.
 */
/**
 * What a transfer sign-in answers with.
 *
 * Deliberately thin. The main process is holding a refresh token and an access
 * token for this account at this point — credentials as real as the password
 * that produced them — and none of that has any business crossing IPC. The
 * renderer needs to know which account it is looking at and nothing else.
 */
export const transferAuthenticateResponse = z.object({
	state: z.literal('authenticated'),
	steamId64: z.string(),
	accountName: z.string()
});

/**
 * What Steam answered when asked to send the text.
 *
 * Answered against a real account: this endpoint replies protobuf, and a
 * successful reply is *empty*, because the response message's only field is
 * optional and an unset optional field encodes to nothing. The outcome is in
 * the `x-eresult` header instead, which is why `sent` is derived from that
 * rather than from the body.
 */
export const transferStartChallengeResponse = z.object({
	/** True when Steam said the text went out. */
	sent: z.boolean(),
	/** Steam's own result code, when it sent one. 1 is OK. */
	eresult: z.number().optional(),
	/** How Steam answered. Recorded because it was an open question. */
	shape: z.enum(['json', 'protobuf']),
	/** What the result code means, when it is one we recognise. */
	meaning: z.string().optional()
});

/**
 * A finished transfer.
 *
 * The revocation code crosses IPC here, and only here. It has to: the screen
 * must put it in front of the user, and this is the one moment it exists
 * outside the vault. Nothing else about the authenticator travels — not the
 * shared secret, not the identity secret, not the session.
 */
export const transferCompleteResponse = z.object({
	steamId64: z.string(),
	accountName: z.string(),
	revocationCode: z.string(),
	timeOffsetSeconds: z.number(),
	/** Vault success with a retained local recovery-publication retry. */
	recoveryWarning: z.string().optional()
});

/** The transfer in progress, if one is still live. */
export const transferStatusResponse = z.object({
	transfer: z.object({ steamId64: z.string(), accountName: z.string() }).optional(),
	recovery: z
		.object({
			attemptId: z.string().uuid(),
			state: z.enum(['sending', 'unanswered', 'unreadable', 'not-replaced', 'replacement']),
			at: z.string(),
			/** Exact replacement ciphertext is present, though this build cannot use it. */
			retained: z.boolean(),
			/** This exact recovery choice can delete or replace a proven backup-era row. */
			requiresPassphrase: z.boolean().optional()
		})
		.optional(),
	/** A malformed/newer durable record. A new transfer remains blocked. */
	problem: z.string().optional(),
	/**
	 * The retry this transfer is waiting on, when it is waiting on one.
	 *
	 * Carries no secret — it names a *step*, and both steps are already their own
	 * channel. It exists because every vault lock reloads the renderer, and the
	 * knowledge that a retry was owed lived only in React state that the reload
	 * destroyed. Steam had already rotated the authenticator by then, so what the
	 * reload stranded was the only copy of the replacement.
	 *
	 * `persist` — the decoded replacement still needs saving, or its exact stored
	 *   row still needs verification and workflow cleanup. Retrying never contacts
	 *   Steam.
	 * `unanswered` — the request went out and nothing came back, so whether the
	 *   authenticator was replaced is genuinely not known.
	 * `unreadable` — Steam answered, so it rotated, and this build cannot use what
	 *   it sent. A dead end: the account needs Steam Support.
	 * `cleanup` — Steam provably did not replace the authenticator, but the local
	 *   safety record could not be cleared; clearing it makes a later retry safe.
	 */
	awaiting: z
		.enum(['persist', 'unreadablePersist', 'unanswered', 'unreadable', 'cleanup'])
		.optional()
});

export type TransferAuthenticated = z.infer<typeof transferAuthenticateResponse>;
export type TransferStatus = z.infer<typeof transferStatusResponse>;
export type TransferStartChallenge = z.infer<typeof transferStartChallengeResponse>;
export type TransferComplete = z.infer<typeof transferCompleteResponse>;

/**
 * **An enrollment that must not be retried, carried as an outcome.**
 *
 * `AddAuthenticator` is irreversible and it is sent before anything can go wrong
 * with the answer, so a lost reply, a reply without the secrets, or a vault
 * write that fails afterwards all end with the account possibly — or definitely
 * — carrying an authenticator this machine cannot use. Those crossed IPC as
 * ordinary errors, which is a shape the screen recovers from by clearing `busy`
 * and re-enabling the control that sends the request again.
 *
 * `certain` separates "Steam definitely did this" from "nobody can tell", which
 * is the difference between two true sentences and one false one.
 */
const haltedOutcome = z.object({
	state: z.literal('uncertain'),
	guidance: z.string(),
	certain: z.boolean().optional(),
	persisted: z.boolean().optional(),
	/** The durable operation when an existing account is involved. */
	kind: z.enum(['enroll', 'activate', 'deactivate']).optional(),
	/** Main-process generated; never derived from an account name or used unchecked as a path. */
	attemptId: z.string().uuid().optional(),
	steamId64: z.string().optional(),
	accountName: z.string().optional(),
	/** Exact workflow state/recovery source for a successful reply that still needs saving. */
	enrollmentState: z
		.enum(['sending', 'unanswered', 'not-attached', 'attached', 'recoverable', 'unreadable'])
		.optional(),
	recovery: z.enum(['durable', 'memory']).optional(),
	usable: z.boolean().optional(),
	/** The exact issued authenticator is already stored; only workflow cleanup remains. */
	stored: z.boolean().optional()
});

export const enrollBeginResponse = z.discriminatedUnion('state', [
	haltedOutcome,
	z.object({ state: z.literal('needsEmailCode'), emailDomain: z.string().optional() }),
	z.object({
		state: z.literal('enrolled'),
		steamId64: z.string(),
		accountName: z.string(),
		hasRevocationCode: z.boolean().optional(),
		/** Masked digits of the phone Steam is texting, when it says. */
		phoneNumberHint: z.string().optional(),
		/** Vault success with a retained local recovery-publication retry. */
		recoveryWarning: z.string().optional(),
		recoveryAttemptId: z.string().uuid().optional(),
		recoveryAt: z.string().optional()
	})
]);

export const enrollmentStatusResponse = z.object({
	pending: z
		.object({
			attemptId: z.string().uuid(),
			steamId64: z.string(),
			accountName: z.string(),
			state: z.enum([
				'sending',
				'unanswered',
				'not-attached',
				'attached',
				'recoverable',
				'unreadable'
			]),
			at: z.string(),
			/** The account and its secrets are already in the vault; only cleanup remains. */
			stored: z.boolean(),
			/** This process or the durable state proves Steam attached the authenticator. */
			certain: z.boolean().optional(),
			/** The retained one-time keys pass the app's Base64 and 20-byte checks. */
			usable: z.boolean().optional(),
			/** Durable survives restart; memory survives only this process. */
			recovery: z.enum(['durable', 'memory']).optional()
		})
		.optional(),
	/** A malformed/newer durable record. Irreversible enrollment remains blocked. */
	problem: z.string().optional()
});
export type EnrollmentStatus = z.infer<typeof enrollmentStatusResponse>;

/**
 * What a recovery attempt produced.
 *
 * Carries the account name so the user can see *which* account came back, and
 * nothing else — the secrets it restored go straight into the vault and never
 * pass through the renderer.
 */
/**
 * The outcome of signing in to Steam.
 *
 * A **returned** failure rather than a thrown one, because the screen has to act
 * on more than the message: `retryable: false` means no password will ever work
 * — Steam wants the sign-in approved elsewhere, or the account uses emailed
 * codes this app cannot answer — and a form that keeps inviting another attempt
 * is telling the user something untrue.
 *
 * Electron's IPC preserves only an error's message, so a thrown failure could
 * not carry the flag. This mirrors `confirmations:list`, which already returns
 * `signInRequired` rather than throwing for the same reason.
 */
export const signInResponse = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true) }),
	z.object({ ok: z.literal(false), retryable: z.boolean(), reason: z.string() })
]);

/** Whether a vault file was taken on, or the picker was simply closed. */
export const adoptResponse = z.discriminatedUnion('state', [
	z.object({ state: z.literal('adopted') }),
	z.object({ state: z.literal('cancelled') })
]);

export const recoverResponse = z.discriminatedUnion('state', [
	z.object({ state: z.literal('cancelled') }),
	z.object({ state: z.literal('restored'), accountName: z.string(), steamId64: z.string() }),
	/** The account is already here; recovering it again would do nothing. */
	z.object({ state: z.literal('alreadyPresent'), accountName: z.string() })
]);

/**
 * The result of writing a maFile.
 *
 * Reports the **file name** and never the path. A full path names the user's
 * machine and their folder layout, which the renderer has no use for — the same
 * reasoning that keeps import from ever handing one over.
 */
export const exportResponse = z.discriminatedUnion('state', [
	z.object({
		state: z.literal('saved'),
		fileName: z.string(),
		/**
		 * The previous export at that name could not be removed, and is still
		 * there.
		 *
		 * **Reported rather than swallowed.** The export sets the old file aside so
		 * a lock can be undone; on success it deletes that copy. When the delete
		 * failed — a scanner holding the file, a removable drive going away — the
		 * failure was ignored and the answer was still `saved`, leaving a second
		 * plaintext file full of the previous authenticator secrets that nobody
		 * was told about. The export did succeed, so this is not a failure; it is
		 * a thing the user has to know.
		 */
		staleCopy: z.boolean().optional()
	}),
	z.object({ state: z.literal('cancelled') })
]);

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
	rejected: z.array(z.object({ sourceName: z.string(), reason: z.string() })),
	/**
	 * Encrypted SDA files waiting for a passphrase.
	 *
	 * Not `rejected`: these are recoverable, and the difference decides what the
	 * screen offers. Defaulted so a report built before this field existed still
	 * parses.
	 */
	locked: z
		.array(
			z.object({
				sourceName: z.string(),
				/**
				 * False when no `manifest.json` supplied this file's IV and salt, so no
				 * passphrase could decrypt it. The fix is to choose the manifest too,
				 * which is not something a failed decryption would ever suggest.
				 */
				decryptable: z.boolean(),
				/**
				 * Why the last attempt failed, if there was one.
				 *
				 * On the row rather than in `rejected`, because the file can still be
				 * decrypted — a wrong passphrase is a retry, not a verdict.
				 */
				lastError: z.string().optional()
			})
		)
		.default([])
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
			reason: z.string().optional(),
			/** The vault commit succeeded, but its separate recovery publication did not. */
			warning: z.string().optional()
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

/** The identity of one notification click, shared by push and recovery paths. */
export const toastClick = z
	.object({
		steamId64: z.string(),
		token: z.number().int().positive().safe()
	})
	.strict();
export type ToastClick = z.infer<typeof toastClick>;

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
	reason: z.string().optional(),
	/**
	 * How many entries Steam sent that this build could not read.
	 *
	 * Required rather than optional, so a handler cannot omit it and leave the
	 * screen quietly reporting a short list as a complete one. Carries a count and
	 * nothing else — the reason an entry failed to parse is a schema detail the
	 * renderer has no use for, and echoing unparsed content back would hand
	 * attacker-influenced text to the UI without passing the caps in `protocol.ts`.
	 */
	unreadable: z.number().int().min(0)
});

/**
 * What came of asking for a browser window.
 *
 * No payload, because the result is a window rather than data. The one thing
 * worth reporting is the state that stops it opening and that the user can
 * clear in a single step — deliberately the same shape as
 * `confirmationsListResponse.signInRequired`, and for the reason written there:
 * thrown as an error, the renderer can only print it.
 *
 * Three unrelated causes arrive here as one answer, because they are one answer
 * to the person reading it: no session was ever saved, the saved one has
 * expired, or Steam declined the cookie minted from it.
 */
export const openBrowserResponse = z.object({
	/** False means a window is open. */
	signInRequired: z.boolean(),
	/** Why, in terms the user can act on. Present when `signInRequired`. */
	reason: z.string().optional()
});

export type OpenBrowserResult = z.infer<typeof openBrowserResponse>;

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
	z.object({ kind: z.literal('halted'), at: z.string(), reason: z.string() }),
	/**
	 * Steam sent confirmations this build could not read.
	 *
	 * Its own kind because it is neither an approval nor a hold: there is no
	 * confirmation to name, only a count of entries that were skipped. Automatic
	 * confirmation runs while nobody is watching, so without this the pass would
	 * simply record nothing — and what it skipped might have been the
	 * account-recovery confirmation.
	 */
	z.object({ kind: z.literal('unreadable'), at: z.string(), count: z.number().int().min(1) }),
	/**
	 * The saved session expired and only the user can fix it.
	 *
	 * Its own kind rather than a `failed` entry, because `failed` is not urgent —
	 * so the one condition no amount of retrying resolves was the one the log
	 * stayed quiet about. Carries no reason: there is one cause, and the kind
	 * names it.
	 */
	z.object({ kind: z.literal('signInRequired'), at: z.string() })
]);

export const activityListResponse = z.object({
	entries: z.array(z.object({ steamId64: z.string(), entry: activityEntry })),
	/** True while something is waiting that a person genuinely needs to look at. */
	urgent: z.boolean(),
	/**
	 * How far this snapshot goes.
	 *
	 * Sent back when acknowledging, so the alert is discharged only for what was
	 * actually on screen. Listing and acknowledging are separate round trips, and
	 * an automatic pass finishing between them would otherwise be marked seen by
	 * somebody who never saw it.
	 */
	seq: z.number().int().min(0)
});

/** Maximum ids carried by one confirmation action IPC request. */
export const CONFIRMATION_ACTION_BATCH_LIMIT = 100;

export const confirmationsActRequest = z
	.object({
		steamId64: z.string(),
		action: z.enum(['allow', 'cancel']),
		ids: z.array(z.string()).min(1).max(CONFIRMATION_ACTION_BATCH_LIMIT)
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
	[CHANNELS.updateCheck]: { request: emptyRequest, response: updateCheckResponse },

	[CHANNELS.transferAuthenticate]: {
		/*
		 * The Guard code is read off the phone that still holds the authenticator,
		 * so it is typed rather than derived. It travels inbound exactly as the
		 * password does and is dropped as soon as Steam has answered.
		 */
		request: z
			.object({
				accountName: z.string().min(1).max(64),
				password: z.string().min(1).max(1024),
				steamGuardCode: z.string().min(1).max(16),
				proxyUrl: z.string().max(2048).optional()
			})
			.strict(),
		response: transferAuthenticateResponse
	},
	[CHANNELS.transferStartChallenge]: {
		request: emptyRequest,
		response: transferStartChallengeResponse
	},
	[CHANNELS.transferComplete]: {
		request: z.object({ smsCode: z.string().min(1).max(16) }).strict(),
		response: transferCompleteResponse
	},
	[CHANNELS.transferRetryPersist]: {
		request: z.object({ passphrase: z.string().min(1).max(1024).optional() }).strict(),
		response: transferCompleteResponse
	},
	[CHANNELS.transferStatus]: { request: emptyRequest, response: transferStatusResponse },
	[CHANNELS.transferResolve]: {
		request: z
			.object({
				attemptId: z.string().uuid(),
				resolution: z.enum(['notReplaced', 'replaced', 'resolvedOutsideApp']),
				passphrase: z.string().min(1).max(1024).optional()
			})
			.strict(),
		response: okResponse
	},
	[CHANNELS.transferCancel]: { request: emptyRequest, response: z.object({}).strict() },

	[CHANNELS.enrollBegin]: {
		// The password travels inbound exactly as a vault passphrase does, and is
		// dropped as soon as Steam has answered.
		request: z
			.object({
				accountName: z.string().min(1).max(64),
				password: z.string().min(1).max(1024),
				/**
				 * Routing for this account, applied from its very first request.
				 *
				 * Optional, like all routing. But it must be offered **here** rather
				 * than only afterwards: enrolling unrouted and adding a proxy later
				 * lets Steam link the user's real address to the proxy through the
				 * account, and nothing configured afterwards undoes that.
				 */
				proxyUrl: z.string().max(2048).optional()
			})
			.strict(),
		response: enrollBeginResponse
	},
	[CHANNELS.enrollEmailCode]: {
		request: z.object({ code: z.string().min(1).max(16) }).strict(),
		response: enrollBeginResponse
	},
	[CHANNELS.enrollActivate]: {
		request: z.object({ steamId64: z.string(), code: z.string().min(1).max(16) }).strict(),
		response: z.object({
			state: z.enum([
				'activated',
				'wantMore',
				'uncertain',
				'staleOperation',
				'unidentifiedOperation'
			]),
			kind: z.enum(['activate', 'deactivate']).optional(),
			/** Present only for `uncertain`. See `uncertainOutcome`. */
			guidance: z.string().optional(),
			/** Opaque identity present only for `staleOperation`. */
			staleToken: z.string().length(64).optional(),
			/** Opaque identity present when an applicable `uncertain` record may be resolved. */
			operationToken: z.string().length(64).optional(),
			/** `true` when Steam is known to have acted, rather than may have. */
			certain: z.boolean().optional(),
			/**
			 * Whether the refusal was written down where it outlives this window.
			 *
			 * The vault write can fail, and it was swallowed — after which the screen
			 * went on promising the request would not be sent again, about a record
			 * that does not exist. `false` means the warning is worth reading now,
			 * because it will not be there later.
			 */
			persisted: z.boolean().optional(),
			/** Activation succeeded; only the separate encrypted recovery backup is stale. */
			recoveryWarning: z.string().optional()
		})
	},
	[CHANNELS.enrollStatus]: { request: emptyRequest, response: enrollmentStatusResponse },
	[CHANNELS.enrollRetryPersist]: {
		request: z.object({ attemptId: z.string().uuid(), steamId64: z.string() }).strict(),
		response: enrollBeginResponse
	},
	[CHANNELS.enrollResolve]: {
		request: z
			.object({
				attemptId: z.string().uuid(),
				steamId64: z.string(),
				resolution: z.enum(['notAttached', 'storedHere', 'resolvedOutsideApp'])
			})
			.strict(),
		response: okResponse
	},

	[CHANNELS.enrollCancel]: { request: emptyRequest, response: okResponse },

	[CHANNELS.accountResolveOperation]: {
		/**
		 * **What the user found, not merely that they looked.**
		 *
		 * Clearing the record on its own leaves the account in whichever state the
		 * interrupted operation left it — an activation Steam completed still reads
		 * `pendingActivation`, so "Finish activation" comes straight back; a
		 * removal Steam performed leaves the account listed and still showing codes
		 * that mean nothing. One generic "checked" cannot be right for both of
		 * those and for the third case, where Steam did nothing and a retry is
		 * exactly what is wanted.
		 */
		request: z.union([
			z
				.object({
					steamId64: z.string(),
					/**
					 * **Which operation the user is answering about.**
					 *
					 * The handler read the *stored* kind and acted on it, so a screen
					 * asking "is Steam Guard on this account now?" could resolve a
					 * left-over removal record — and "yes" then meant "the removal
					 * succeeded", which deleted the account. The caller states what it
					 * asked, and a record of a different kind is refused rather than
					 * reinterpreted.
					 */
					kind: z.enum(['activate', 'deactivate']),
					/** The exact applicable record displayed before the user checked Steam. */
					operationToken: z.string().length(64),
					steamActed: z.boolean(),
					/**
					 * Required to confirm a removal, exactly as `accountDeactivate`
					 * requires it: this path deletes an account, and being unlocked is
					 * not enough to do that.
					 */
					/*
					 * Bounded like every other passphrase in the contract. This one reaches
					 * scrypt, and an unbounded string reaches it with whatever length the
					 * caller chose — a megabyte of it verified as readily as a sentence.
					 */
					passphrase: z.string().min(1).max(1024).optional()
				})
				.strict(),
			z
				.object({
					steamId64: z.string(),
					kind: z.enum(['activate', 'deactivate']),
					/** Explicitly discard evidence proved to describe an older authenticator. */
					discardStale: z.literal(true),
					/** Must identify the exact record that the main process displayed. */
					staleToken: z.string().length(64)
				})
				.strict()
		]),
		response: z
			.object({
				ok: z.literal(true),
				/** Reconciliation succeeded; only the recovery backup correction failed. */
				recoveryWarning: z.string().optional()
			})
			.strict()
	},

	[CHANNELS.accountExport]: {
		request: z.object({ steamId64: z.string() }).strict(),
		response: exportResponse
	},

	[CHANNELS.accountFinishRecoveryBackup]: {
		request: z.object({ steamId64: z.string() }).strict(),
		response: okResponse
	},

	[CHANNELS.accountRecover]: {
		// No path: the OS picker names the file, exactly as import does.
		request: z.object({ passphrase }).strict(),
		response: recoverResponse
	},

	/**
	 * Collect a notification click the renderer was not there to receive.
	 *
	 * Empty request: the renderer is not asking about an account, it is asking
	 * whether anything is waiting. Main decides what, from an id it already had.
	 *
	 * `steamId64` is optional because "nothing is waiting" is the ordinary
	 * answer. Reading only peeks; an exact `{ steamId64, token }` acknowledgement
	 * clears the intent after navigation succeeds. The renderer's monotonic token
	 * claim prevents a repeated peek from navigating twice.
	 *
	 * The matching push lives in `PUSH_CHANNELS`, not here: `IPC_CONTRACT`
	 * describes `ipcMain.handle` request/response pairs, and a
	 * `webContents.send` has neither.
	 */
	[CHANNELS.takePendingConfirmations]: {
		/*
		 * No argument peeks; `acknowledged` clears. Reading used to clear on its
		 * own, so a renderer that could not navigate — the account not yet in its
		 * list, which is the case this exists for — lost the click entirely.
		 */
		request: z.object({ acknowledged: toastClick.optional() }).strict(),
		response: z.union([z.object({}).strict(), toastClick])
	},

	[CHANNELS.accountDeactivate]: {
		request: z
			.object({
				steamId64: z.string(),
				/**
				 * Required, and verified against the vault file rather than against the
				 * session being open. This removes Steam Guard from a real account; an
				 * unattended unlocked machine must not be able to do it.
				 */
				passphrase,
				/**
				 * The words the user had to type. Enforced by the handler, not the
				 * screen — the same lesson as the auto-confirm gate, applied to the one
				 * operation that is more destructive than switching trades on.
				 */
				acknowledgement: z.string()
			})
			.strict(),
		response: z.object({
			ok: z.literal(true).optional(),
			/*
			 * A removal whose request reached Steam and whose reply did not. The
			 * account may already have had its authenticator detached, so the screen
			 * must not offer the same removal again.
			 */
			state: z.enum(['uncertain', 'staleOperation', 'unidentifiedOperation']).optional(),
			kind: z.enum(['activate', 'deactivate']).optional(),
			guidance: z.string().optional(),
			/** Opaque identity present only for `staleOperation`. */
			staleToken: z.string().length(64).optional(),
			/** Opaque identity present when an applicable `uncertain` record may be resolved. */
			operationToken: z.string().length(64).optional(),
			/** `true` when Steam is known to have acted, rather than may have. */
			certain: z.boolean().optional(),
			/** Whether the refusal outlives this window. See `enrollActivate`. */
			persisted: z.boolean().optional()
		})
	},

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
				/**
				 * **The passphrase is the gate, and it is the only one.**
				 *
				 * There used to be an `acknowledged: z.literal(true)` here, described as
				 * proof that the caller had shown the warning about this not removing
				 * the authenticator from Steam. It proved nothing: the preload wrote the
				 * literal itself, so every call carried it and no call could fail to.
				 * The main process never read it. A constant that looks like consent is
				 * worse than no field at all, because it makes a surface look guarded
				 * while the only real check is the one below.
				 */
				passphrase
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
				pollIntervalSeconds: z.number().int().min(10).max(3600),
				/**
				 * The literal words the user had to type to switch trades on.
				 *
				 * Required only when trades are being **turned on**, and checked in the
				 * handler rather than here. The schema cannot do it: whether this is a
				 * transition depends on what the account's setting already is, and the
				 * contract has no access to the vault.
				 *
				 * A first attempt did enforce it here, on `trades === true` alone. That
				 * demanded the phrase again for every later edit — so once trades were
				 * on, changing the poll interval was impossible, because the screen
				 * correctly stops asking for an acknowledgement it does not need.
				 *
				 * Trades are the setting that spends money while nobody is watching, so
				 * the gate belongs at the boundary that decides — but on the transition,
				 * not on the value.
				 */
				tradesAcknowledgement: z.string().optional(),
				/**
				 * Desktop notifications for this account.
				 *
				 * Declared explicitly because this request is `.strict()`: an
				 * unrecognised key is *rejected*, not ignored, so a screen sending
				 * `notify` against a contract that did not name it would fail the whole
				 * save rather than quietly drop the field.
				 *
				 * **No acknowledgement ceremony.** Trades spend money while nobody is
				 * watching, which is why they demand a typed phrase; a notification
				 * spends nothing and must not inherit that gate — the disclosure about
				 * what a toast shows belongs on the screen, beside the switch.
				 */
				notify: z.object({ enabled: z.boolean(), detail: notifyDetailSchema })
			})
			.strict(),
		response: okResponse
	},

	[CHANNELS.accountOpenBrowser]: {
		request: z
			.object({
				steamId64: z.string(),
				/*
				 * Whether to route this window through the account's proxy.
				 *
				 * A choice and not a URL. The renderer still cannot say *where* the
				 * traffic goes — only whether to use the address already stored for
				 * this account — so nothing that reaches the renderer can aim a
				 * signed-in session at a proxy of its own choosing.
				 */
				route: browserRoute
			})
			.strict(),
		response: openBrowserResponse
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

	[CHANNELS.vaultAdopt]: {
		// The chosen vault is authenticated before adoption. This also supplies the
		// actual key needed to prove pending workflow ciphertext remains recoverable.
		request: z.object({ passphrase }).strict(),
		response: adoptResponse
	},

	[CHANNELS.vaultRestoreBackup]: {
		// The passphrase the **backup** was sealed under, which is usually the
		// current one but need not be if it has been changed since.
		request: z.object({ passphrase }).strict(),
		response: okResponse
	},

	[CHANNELS.importScan]: { request: emptyRequest, response: importReportResponse },
	[CHANNELS.importUnlock]: {
		// The SDA passphrase, inbound exactly as a vault passphrase is, and dropped
		// as soon as the files have been decrypted. Not bounded below by a minimum:
		// this passphrase was chosen in another program under another program's
		// rules, and refusing a short one would just be refusing to import.
		request: z.object({ passphrase: z.string().min(1).max(1024) }).strict(),
		response: importReportResponse
	},
	[CHANNELS.importCommit]: { request: importCommitRequest, response: importCommitResponse },
	[CHANNELS.importDiscard]: { request: emptyRequest, response: okResponse },

	[CHANNELS.codesList]: { request: emptyRequest, response: codesListResponse },
	[CHANNELS.codeCopy]: { request: codeCopyRequest, response: codeCopyResponse },

	[CHANNELS.activityList]: { request: emptyRequest, response: activityListResponse },
	[CHANNELS.activityAcknowledge]: {
		// The snapshot the user actually read, not "everything up to now".
		request: z.object({ upTo: z.number().int().min(0) }).strict(),
		/**
		 * What is *still* urgent once this acknowledgement is applied.
		 *
		 * `ok: true` alone let the renderer clear its badge unconditionally — and
		 * an entry recorded after the displayed snapshot is deliberately not
		 * covered by the watermark, so main correctly kept it urgent while the UI
		 * hid it until some later poll. The answer carries the truth now, so the
		 * caller has nothing to assume.
		 */
		response: z.object({ ok: z.literal(true), urgent: z.boolean() }).strict()
	},

	[CHANNELS.confirmationsList]: {
		request: z.object({ steamId64: z.string() }).strict(),
		response: confirmationsListResponse
	},
	[CHANNELS.confirmationsAct]: { request: confirmationsActRequest, response: okResponse },

	[CHANNELS.steamSignIn]: {
		// The password travels inbound, exactly as a vault passphrase does, and is
		// dropped as soon as Steam has answered.
		request: z
			.object({
				steamId64: z.string(),
				password: z.string().min(1).max(1024),
				/**
				 * Whether to route this sign-in through the account's stored proxy.
				 *
				 * **Optional, and defaulting to the account's own routing**, because
				 * that is what every caller but one wants: a confirmation screen
				 * signing in has no reason to leave by any other address.
				 *
				 * The one exception is the browser, whose *Direct* option exists
				 * precisely because that proxy is rate-limited, blocked or dead. When
				 * Steam declines the saved session the user is asked to sign in again
				 * — and that sign-in went through the proxy regardless, so the
				 * fallback failed at the one step it was chosen to get past.
				 */
				route: browserRoute.optional()
			})
			.strict(),
		response: signInResponse
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
export type UpdateCheckResult = z.infer<typeof updateCheckResponse>;
export type EnrollBegin = z.infer<typeof enrollBeginResponse>;
export type ExportResult = z.infer<typeof exportResponse>;
export type AdoptResult = z.infer<typeof adoptResponse>;
export type RecoverResult = z.infer<typeof recoverResponse>;
export type SignInResult = z.infer<typeof signInResponse>;

/** The typed surface preload puts on `window`. Renderer sees exactly this. */
export interface RendererApi {
	getAppInfo(): Promise<AppInfo>;

	getVaultStatus(): Promise<VaultStatus>;
	createVault(passphrase: string): Promise<{ ok: true }>;
	unlockVault(passphrase: string): Promise<{ ok: true }>;
	/** Replace the vault with its backup and unlock it. The way out of a corrupt file. */
	restoreVaultBackup(passphrase: string): Promise<{ ok: true }>;
	/** Take on a vault file from elsewhere. Only possible when this machine has none. */
	adoptVaultFile(passphrase: string): Promise<AdoptResult>;
	lockVault(): Promise<{ ok: true }>;
	touchVault(): Promise<{ ok: true }>;
	changePassphrase(current: string, next: string): Promise<{ ok: true }>;

	listAccounts(): Promise<{ accounts: AccountSummary[] }>;

	/** The timings the user can change. No secrets. */
	getSettings(): Promise<VaultSettingsView>;
	updateSettings(settings: VaultSettingsView): Promise<{ ok: true }>;
	/**
	 * Whether a newer release exists. Returns a link, never a download.
	 *
	 * Resolves rather than rejects on failure — an update check is background
	 * work the user did not ask for, and it must not be able to take down the
	 * screen they are actually using.
	 */
	checkForUpdate(): Promise<UpdateCheckResult>;

	/**
	 * Add an authenticator to an account that has none.
	 *
	 * `begin` is the call that changes the Steam account: once it answers
	 * `enrolled`, the secrets are already in the vault and there is no undoing it
	 * from here. The screen treats that as a point of no return.
	 */
	authenticateTransfer(
		accountName: string,
		password: string,
		steamGuardCode: string,
		proxyUrl?: string
	): Promise<TransferAuthenticated>;
	startTransferChallenge(): Promise<TransferStartChallenge>;
	completeTransfer(smsCode: string): Promise<TransferComplete>;
	retryTransferPersist(passphrase?: string): Promise<TransferComplete>;
	getTransferStatus(): Promise<TransferStatus>;
	resolveTransfer(
		attemptId: string,
		resolution: 'notReplaced' | 'replaced' | 'resolvedOutsideApp',
		passphrase?: string
	): Promise<{ ok: true }>;
	cancelTransfer(): Promise<object>;
	beginEnrollment(accountName: string, password: string, proxyUrl?: string): Promise<EnrollBegin>;
	submitEnrollmentEmailCode(code: string): Promise<EnrollBegin>;
	getEnrollmentStatus(): Promise<EnrollmentStatus>;
	retryEnrollmentPersist(attemptId: string, steamId64: string): Promise<EnrollBegin>;
	resolveEnrollment(
		attemptId: string,
		steamId64: string,
		resolution: 'notAttached' | 'storedHere' | 'resolvedOutsideApp'
	): Promise<{ ok: true }>;
	/**
	 * Say the account has been checked, clearing the refusal to repeat an
	 * operation whose outcome was never established.
	 */
	resolveAccountOperation(
		steamId64: string,
		kind: 'activate' | 'deactivate',
		operationToken: string,
		steamActed: boolean,
		passphrase?: string
	): Promise<{ ok: true; recoveryWarning?: string }>;
	/** Clear only an exact safety record proved to describe an older authenticator. */
	clearStaleAccountOperation(
		steamId64: string,
		kind: 'activate' | 'deactivate',
		staleToken: string
	): Promise<{ ok: true }>;
	/** Abandon a sign-in that has not attached an authenticator yet. */
	cancelEnrollment(): Promise<{ ok: true }>;
	activateAuthenticator(
		steamId64: string,
		code: string
	): Promise<{
		state: 'activated' | 'wantMore' | 'uncertain' | 'staleOperation' | 'unidentifiedOperation';
		kind?: 'activate' | 'deactivate';
		staleToken?: string;
		operationToken?: string;
		/**
		 * Present only for `uncertain`: what the user should do about a request
		 * Steam may already have acted on. Carried across IPC because an error
		 * crosses as a message alone, and the screens then re-offered the very
		 * action the message told them not to repeat.
		 */
		guidance?: string;
		/** `true` when Steam is known to have acted, rather than may have. */
		certain?: boolean;
		/** Whether the refusal outlives this window. */
		persisted?: boolean;
		/** Activation succeeded; only the separate encrypted recovery backup is stale. */
		recoveryWarning?: string;
	}>;

	/** Write an account out as a maFile. Opens the OS save dialog; returns a name. */
	exportAccount(steamId64: string): Promise<ExportResult>;
	/**
	 * Finish this account's separate encrypted recovery backup locally.
	 * Does not contact Steam and exposes neither a path nor a secret.
	 */
	finishRecoveryBackup(steamId64: string): Promise<{ ok: true }>;

	/**
	 * Restore an account from the recovery file written when it was enrolled.
	 *
	 * Opens the OS picker. The passphrase is the one the vault had at the time the
	 * file was written, which changing the vault passphrase does not update.
	 */
	recoverAccount(passphrase: string): Promise<RecoverResult>;

	/**
	 * Detach the authenticator from Steam, then forget the account.
	 *
	 * Not the same as `removeAccount`, which only forgets it here. This one leaves
	 * the Steam account with no second factor at all.
	 */
	deactivateAuthenticator(
		steamId64: string,
		passphrase: string,
		acknowledgement: string
	): Promise<{
		ok?: true;
		state?: 'uncertain' | 'staleOperation' | 'unidentifiedOperation';
		kind?: 'activate' | 'deactivate';
		staleToken?: string;
		operationToken?: string;
		guidance?: string;
		certain?: boolean;
		persisted?: boolean;
	}>;
	/** Set routing for one account, or pass `null` to remove it. */
	setAccountProxy(steamId64: string, proxyUrl: string | null): Promise<{ ok: true }>;
	/** Enable or disable automatic confirmation for one account, per type. */
	setAccountAutoConfirm(
		steamId64: string,
		settings: {
			marketListings: boolean;
			trades: boolean;
			pollIntervalSeconds: number;
			/** Required by the contract when switching `trades` on. See `TRADES_ACK`. */
			tradesAcknowledgement?: string;
			/**
			 * Desktop notifications for this account.
			 *
			 * Not optional. The request schema is `.strict()`, so a save that omits
			 * it fails rather than leaving the field alone — and a screen that can
			 * silently skip a field is a screen that can silently reset it.
			 */
			notify: { enabled: boolean; detail: NotifyDetail };
		}
	): Promise<{ ok: true }>;
	/**
	 * Subscribe to notification clicks. Called once, from an effect.
	 *
	 * The id is matched against the account list the renderer already holds and
	 * ignored if absent: this navigates to an account the user has, never to
	 * whatever arrives on the wire.
	 *
	 * **Returns an unsubscribe.** It returned `void`, so "called once" was a
	 * hope rather than a contract — no caller could clean up even when React
	 * re-ran the effect, and one did, once a second.
	 */
	onOpenConfirmations(listener: (click: ToastClick) => void): () => void;
	/**
	 * Take a notification click that arrived while nothing was listening.
	 *
	 * Returns `{}` when nothing is waiting, which is the ordinary answer. The
	 * result carries a click token; acknowledgement clears only that exact token.
	 */
	takePendingConfirmations(request?: {
		acknowledged?: ToastClick;
	}): Promise<{ steamId64?: string; token?: number }>;
	/**
	 * Remove an account and its secrets from this vault.
	 *
	 * Irreversible, and does not touch Steam. The passphrase and the explicit
	 * acknowledgement are both required by the contract.
	 */
	removeAccount(steamId64: string, passphrase: string): Promise<{ ok: true }>;

	/** Opens the OS file picker and reports what was chosen. No paths, no secrets. */
	scanMaFiles(): Promise<ImportReport>;
	/**
	 * Decrypt the encrypted files from the last scan, and report again.
	 *
	 * Files that do not decrypt stay locked so the passphrase can be retried; the
	 * new report says which, and why.
	 */
	unlockImport(passphrase: string): Promise<ImportReport>;
	commitImport(selections: ImportSelection[]): Promise<{ outcomes: ImportOutcome[] }>;
	discardImport(): Promise<{ ok: true }>;

	/** Steam Guard codes for every account. Short-lived by construction. */
	listCodes(): Promise<CodesList>;
	/** Copy one code. Main owns the clipboard and its auto-clear timer. */
	copyCode(steamId64: string): Promise<{ code: string; clipboardClearsInSeconds: number }>;

	/** What automatic confirmation did while nobody was watching. */
	listActivity(): Promise<ActivityList>;
	/** Mark the log as seen, so the "needs you" alert can be discharged. */
	/**
	 * @param upTo the `seq` from the listing the user actually saw. Anything
	 * recorded after that snapshot stays unacknowledged.
	 */
	/** Answers with the urgency that remains, so the caller need not assume. */
	acknowledgeActivity(upTo: number): Promise<{ ok: true; urgent: boolean }>;
	/** Pending confirmations for one account. */
	listConfirmations(steamId64: string): Promise<ConfirmationsList>;
	/** Approve or deny by id. The nonce never leaves the main process. */
	actOnConfirmations(
		steamId64: string,
		action: 'allow' | 'cancel',
		ids: string[]
	): Promise<{ ok: true }>;
	/** Sign in once. The password is used and dropped; the session is what is kept. */
	signInToSteam(steamId64: string, password: string, route?: BrowserRoute): Promise<SignInResult>;

	/** §11 S2 exception (a). Requires the passphrase again. */
	revealRevocationCode(steamId64: string, passphrase: string): Promise<{ revocationCode: string }>;
	/**
	 * Open a signed-in, routed browser for this account.
	 *
	 * Resolves when the window is on screen, not when the user is finished with
	 * it — there is nothing to wait for once it is up. What comes back is the one
	 * thing that stops it opening and that the caller can offer to fix.
	 */
	openAccountBrowser(steamId64: string, route: BrowserRoute): Promise<OpenBrowserResult>;
	/** Record that the code has been written down, clearing the account's warning. */
	confirmRevocationBackup(steamId64: string): Promise<{ ok: true }>;
}
