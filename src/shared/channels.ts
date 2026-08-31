/**
 * Channel names, with no runtime dependencies whatsoever.
 *
 * This file is separate from `ipc.ts` for one specific reason: **the preload
 * script runs sandboxed** (§11 S6), and a sandboxed preload can only `require`
 * a small allowlist — `electron` and a few polyfilled builtins. Requiring an
 * ordinary npm module throws, the preload dies, and `window.api` is silently
 * never exposed.
 *
 * `ipc.ts` imports zod to declare the schemas. If preload imported its channel
 * names from there, the bundler would emit `require("zod")` into the preload and
 * the whole bridge would fail at runtime — with no error surfaced anywhere
 * obvious, because the preload failing looks identical to the renderer simply
 * not having an API.
 *
 * So: preload imports values from here only, and types from `ipc.ts` using
 * `import type`, which the compiler erases.
 *
 * `tests/security-posture.test.ts` asserts the built preload requires nothing
 * but `electron`.
 */

/** Every legal channel name. Preload allowlists exactly these. */
export const CHANNELS = {
	/** Non-secret application metadata for the About screen and window chrome. */
	appInfo: 'app:info',

	/** Whether a vault exists, whether it is unlocked, when it will auto-lock. */
	vaultStatus: 'vault:status',
	/** Create a new vault. Passphrase inbound. */
	vaultCreate: 'vault:create',
	/** Unlock an existing vault. Passphrase inbound. */
	vaultUnlock: 'vault:unlock',
	/**
	 * Replace the vault with its backup and unlock it. Passphrase inbound.
	 *
	 * The way out of a corrupted vault file. Without it, `unlock` reads the main
	 * file unconditionally, so a damaged one locked the user out of every account
	 * they had while a good copy sat beside it — and the unlock screen said so.
	 */
	vaultRestoreBackup: 'vault:restoreBackup',
	/**
	 * Adopt a vault file the user already has, when this machine has none.
	 *
	 * The picker is opened by the main process, as every other file flow here is,
	 * so no path crosses the bridge in either direction.
	 */
	vaultAdopt: 'vault:adopt',
	/** Lock now. */
	vaultLock: 'vault:lock',
	/** Defer the idle auto-lock. */
	vaultTouch: 'vault:touch',
	/** Re-seal under a new passphrase. Both passphrases inbound. */
	vaultChangePassphrase: 'vault:changePassphrase',

	/** Account list WITHOUT any secret. */
	accountsList: 'accounts:list',

	/**
	 * Vault settings the user can actually change (§10.3).
	 *
	 * Carries no secrets — timings only. Separate from `vault:status`, which is
	 * polled every second and has no business shipping settings with it.
	 */
	settingsGet: 'settings:get',
	settingsUpdate: 'settings:update',

	/**
	 * Set or clear one account's network routing (§10.1).
	 *
	 * Routing is **optional, per account, and always removable**. An account with
	 * none connects the way everything else on the machine does. This channel is
	 * how a proxy that arrived inside an imported maFile — possibly a dead one —
	 * can be replaced or taken off entirely.
	 */
	accountSetProxy: 'account:setProxy',

	/**
	 * Open a browser window signed in as one account, routed like that account.
	 *
	 * For finishing a trade that this application deliberately does not automate.
	 * §12's answer to "why not just automate trading" is that confirming what you
	 * started is a different thing from acting for you, and that line does not
	 * move — so the alternative to a bot is a browser, carrying the routing the
	 * user configured instead of leaking their own address into an account they
	 * were careful to separate.
	 *
	 * Takes no URL. Where the window starts is this application's decision, not
	 * the renderer's: a channel that accepted a destination would be a way to
	 * point a signed-in Steam session at any page somebody could get into the
	 * renderer.
	 */
	accountOpenBrowser: 'account:openBrowser',

	/**
	 * Turn automatic confirmation on or off for one account (§12 F6).
	 *
	 * Per account and per type, never global. What the user enables here is the
	 * *most* that S16 will act on — the allowlist in `confirmations/policy.ts`
	 * still decides the rest, and no setting reachable from this channel can widen
	 * it beyond trades and market listings.
	 */
	accountSetAutoConfirm: 'account:setAutoConfirm',

	/**
	 * Remove an account from this vault (§12 F2).
	 *
	 * Gated like the revocation reveal, and for a heavier reason: this destroys
	 * the only copy of a shared secret and a revocation code that most users have.
	 * It does **not** remove the authenticator from Steam — that is the whole
	 * danger, and the reason the request carries an explicit acknowledgement
	 * alongside the passphrase.
	 */
	accountRemove: 'account:remove',

	/**
	 * Import (§12 F2). Three channels, because the secrets stay in the main
	 * process for the whole flow:
	 *
	 *  - `importScan` opens the OS file picker, parses what was chosen, and
	 *    returns a report describing it. The renderer never names a path and
	 *    never receives a secret.
	 *  - `importCommit` writes chosen candidates into the vault by opaque id.
	 *  - `importDiscard` drops the staged secrets without importing anything.
	 */
	importScan: 'import:scan',
	/**
	 * Decrypt the encrypted maFiles from the current scan. Passphrase inbound.
	 *
	 * Its own channel rather than an argument to `importScan`, because the
	 * passphrase cannot be asked for until the files have been read and found to
	 * need one — and re-scanning would reopen the picker.
	 */
	importUnlock: 'import:unlock',
	importCommit: 'import:commit',
	importDiscard: 'import:discard',

	/**
	 * Steam Guard codes (§12 F4). Codes DO cross to the renderer — they have to
	 * be readable — but they are not long-term secrets: each one dies in under
	 * thirty seconds and cannot be turned back into the shared secret that made
	 * it. §11 S2 governs the shared secret, which never leaves the main process.
	 */
	codesList: 'codes:list',
	/** Copy one code via the main process, which also owns the auto-clear timer. */
	codeCopy: 'codes:copy',

	/**
	 * Mobile confirmations (§12 F5).
	 *
	 * The renderer receives an id and enough text to decide; the nonce that makes
	 * acting on one possible never leaves the main process, so the UI can approve
	 * only what it was actually shown.
	 */
	/**
	 * What automatic confirmation did while nobody was watching.
	 *
	 * Read-only and carries no secret. It exists because the engine was computing
	 * held-back confirmations — including account recovery — and dropping them,
	 * which made the loudest warning this app can raise land nowhere.
	 */
	activityList: 'activity:list',
	/**
	 * Mark what is in the log as seen.
	 *
	 * Separate from `activity:list` because that one is polled once a second to
	 * drive the alert badge — acknowledging there would discharge the warning
	 * without anybody having read it. This is called when the screen is opened,
	 * which is the only moment that means the user actually looked.
	 */
	activityAcknowledge: 'activity:acknowledge',

	confirmationsList: 'confirmations:list',
	confirmationsAct: 'confirmations:act',

	/**
	 * Sign in to Steam once, with a password (§12 F3).
	 *
	 * Inbound only, and used inside the handler rather than stored: what is kept
	 * is the long-lived refresh token it produces. §11 S2 governs what the
	 * renderer *receives*, and this returns nothing but success.
	 */
	steamSignIn: 'steam:signIn',

	/**
	 * Reveal one revocation code — §11 S2 exception (a), the backup ceremony.
	 * Requires the passphrase again; being unlocked is not enough.
	 */
	revocationReveal: 'revocation:reveal',

	/**
	 * Record that the user has written their revocation code down (§11 S12).
	 *
	 * No passphrase: the dangerous half of the ceremony is the reveal, which is
	 * gated. This only clears a warning the user is looking at, and demanding the
	 * passphrase twice in one flow teaches people to type it reflexively.
	 */
	revocationConfirmBackup: 'revocation:confirmBackup',

	/**
	 * Ask whether a newer release has been published (§11 S11).
	 *
	 * Answers with a version and a link, and **never** a download. The renderer
	 * cannot fetch a binary and the main process does not offer to: an
	 * application that replaces its own executable is the mechanism the clone
	 * sites use, and the last step of the verification chain belongs to the user.
	 */
	updateCheck: 'update:check',

	/**
	 * Adding an authenticator to an account that has none (§12 F3).
	 *
	 * Three channels because the flow has two unavoidable human pauses: a code
	 * emailed at sign-in (the account has no authenticator yet, so Steam cannot
	 * ask for one) and a code texted at activation.
	 *
	 * `begin` is the one that changes the Steam account. By the time it answers,
	 * the secrets are already in the vault — see `EnrollmentService`.
	 */
	/**
	 * Moving an authenticator that already exists on the Steam mobile app.
	 *
	 * Separate from `enroll:*` on purpose. Enrolling attaches a new authenticator
	 * and refuses an account that already has one; transferring asks Steam to
	 * *replace* the existing one, which is a different operation with a different
	 * cost — and folding it into enrolment is how somebody ends up doing
	 * remove-then-add and paying fifteen days for it.
	 *
	 * `authenticate` changes nothing on the account. It signs in and stops.
	 */
	transferAuthenticate: 'transfer:authenticate',
	transferStartChallenge: 'transfer:startChallenge',
	/**
	 * The irreversible one. Submits the texted code and rotates the authenticator.
	 *
	 * Its own channel rather than a mode of another, because cancellation stops
	 * being possible the moment it is called and the UI has to know exactly where
	 * that line is.
	 */
	transferComplete: 'transfer:complete',
	/** Finish storing a replacement Steam already issued. Safe to repeat. */
	transferRetryPersist: 'transfer:retryPersist',
	transferStatus: 'transfer:status',
	transferCancel: 'transfer:cancel',
	enrollBegin: 'enroll:begin',
	enrollEmailCode: 'enroll:emailCode',
	enrollActivate: 'enroll:activate',
	/**
	 * Abandon a sign-in that has not attached anything yet.
	 *
	 * Needed because the email-code step is a genuine pause with a live
	 * `LoginSession` behind it. Leaving the screen used to drop the UI and leave
	 * that session running until its fifteen-minute TTL — so the way out of a
	 * mistyped account name was to wait, or to quit the application.
	 */
	enrollCancel: 'enroll:cancel',

	/**
	 * Write an account back out as a maFile (§12 F2).
	 *
	 * The user picks the destination through the OS dialog, so no path crosses
	 * IPC in either direction — the same rule import follows.
	 */
	accountExport: 'account:export',

	/**
	 * Detach an authenticator from Steam entirely (F-09, Q15).
	 *
	 * Distinct from `account:remove`, which only forgets an account locally and
	 * leaves Steam still demanding codes for it. This one tells Steam to drop the
	 * authenticator, using the revocation code, and then forgets the account.
	 *
	 * The most destructive channel in the contract. One account per call, and the
	 * passphrase is verified against the vault file every time — an attacker with
	 * an unlocked vault must not be able to strip 2FA from everything at once.
	 */
	accountDeactivate: 'account:deactivate',

	/**
	 * Put an account back from its recovery file (§12 F2).
	 *
	 * Written automatically at enrollment and deliberately **not** deleted when an
	 * account is removed — recovering from that removal is the whole reason it
	 * exists. The passphrase inbound is the one the vault had when the file was
	 * written, which is not necessarily the current one.
	 */
	accountRecover: 'account:recover',

	/**
	 * Collect a notification click the renderer was not there to receive.
	 *
	 * The push above is the fast path and nothing depends on it landing. A lock
	 * **reloads** the window, so a click can arrive at a document that is about
	 * to be replaced, or at the unlock screen — in both cases the listener is
	 * gone. Main remembers the intent; the renderer collects it once it has an
	 * account list to navigate within, and collecting clears it.
	 */
	takePendingConfirmations: 'app:takePendingConfirmations'
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * Main→renderer pushes, which are a different kind of thing from everything
 * above.
 *
 * `CHANNELS` entries are `ipcMain.handle` request/response pairs, and every one
 * of them is required to have an `IPC_CONTRACT` schema — a test enforces it,
 * which is what stops a channel being added without one. A `webContents.send`
 * has no request to validate and no response to return, so putting one in that
 * table would mean weakening the rule for the sake of a single entry.
 *
 * They are named here rather than written inline because the alternative is
 * what the browser chrome does today: the same string typed out in the main
 * process and again in the preload, where a typo produces a listener that is
 * simply never called and nothing fails to say so.
 */
export const PUSH_CHANNELS = {
	/**
	 * A clicked notification asking for one account's confirmations.
	 *
	 * Carries a SteamID the main process already holds. It does not *act* —
	 * navigating is all it does, and the renderer ignores an id that is not in
	 * the account list it already has. Approving still goes through the
	 * confirmation channels with their own checks.
	 */
	openConfirmations: 'app:open-confirmations'
} as const;

export type PushChannelName = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS];
