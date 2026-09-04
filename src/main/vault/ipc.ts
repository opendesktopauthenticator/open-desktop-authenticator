import { BrowserWindow, dialog } from 'electron';
import type { VaultService } from './service';
import { RevocationCeremony } from './revocation-ceremony';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { planProxy } from '../net/egress';
import { ProxyConsent } from '../net/proxy-consent';
import type { RoutingStatus } from '../net/transport';
import { matchesTradesAck, TRADES_ACK, type AccountSummary } from '../../shared/ipc';
import type { Account, NotifyDetail } from '../../shared/vault-schema';
import type { Envelope } from '../../shared/vault-format';
import { VaultKeyOperationCoordinator } from './key-operation-coordinator';
import {
	authenticatorFingerprint,
	isAuthenticatorFingerprint,
	operationRecordToken
} from '../steam/authenticator-secrets';
import { markRecoveryBackupNeeded } from './recovery-state';

/*
 * Re-exported, not redefined.
 *
 * The ceremony moved to its own module once the transfer handlers needed to
 * record a reveal too — importing it from here would have pulled the whole
 * vault IPC surface, and Electron's `dialog`, into a module that needs a `Map`
 * and a hash. This keeps the name available where it has always been imported
 * from.
 */
export { RevocationCeremony };

/**
 * The vault's IPC surface (§11 S6, §24.3).
 *
 * Two rules shape every handler here:
 *
 * 1. **Nothing that can act as an account crosses outbound.** Account listings
 *    carry whether a secret exists, never the secret. The single exception is
 *    the revocation-code reveal, which §11 S2 sanctions and which is gated
 *    harder than S2 requires.
 * 2. **Errors are shaped for a user, not for a prober.** A wrong passphrase and
 *    a damaged file already produce the same message inside the crypto layer;
 *    nothing here reintroduces a distinction.
 */

/**
 * @param onProxyChanged told when an account's routing changed, so the network
 * layer can drop the session that still holds the old one. Injected rather than
 * imported: the vault has no business knowing what a socket is. Its second
 * argument says the account was **removed** rather than re-routed, which is the
 * difference between dropping a cache and destroying a record.
 * @param ceremony tracks which revocation codes have been shown this unlock.
 * @param onUnlocked fired after a successful create/unlock so the Steam clock
 * can be checked before the user is staring at codes.
 */
export function registerVaultHandlers(
	vault: VaultService,
	onProxyChanged: (steamId64: string, removed?: boolean) => void = () => undefined,
	ceremony: RevocationCeremony = new RevocationCeremony(),
	onUnlocked: () => Promise<void> | void = () => undefined,
	onAutoConfirmChanged: (steamId64: string) => void = () => undefined,
	// A lookup rather than the transport factory itself: this module has no other
	// business with the network layer, and the account list only needs an answer.
	routingStatus: (steamId64: string) => RoutingStatus | undefined = () => undefined,
	/**
	 * Fired when a save turns `Require proxies` **on**, and only then.
	 *
	 * A callback rather than something this module does itself: the work is
	 * closing browser windows and dropping cached transports, and this file has
	 * no business with either.
	 *
	 * **On the transition, not on every save that leaves it on.** Firing it
	 * whenever the value was true looked idempotent — with the rule in force
	 * there is nothing non-compliant left to close — and it is not, because the
	 * callback also calls `forgetAll()`. That advances every transport's
	 * generation and cancels requests in flight. So with strict mode already on,
	 * saving an unrelated setting like the clipboard timeout killed a correctly
	 * proxied confirmation that happened to be running: enforcement interrupting
	 * exactly the traffic it exists to protect.
	 */
	onRequireProxies: () => void = () => undefined,
	/**
	 * Gate on a proxy destination the renderer has not been given permission for.
	 *
	 * Defaulted to a live instance rather than a permissive stub: an
	 * `AccountBrowsers`-style seam that silently allows everything when a caller
	 * forgets to pass it is the same hole with an extra step, and a bare
	 * `ProxyConsent` refuses by default until it is given a way to ask.
	 */
	proxyConsent: ProxyConsent = new ProxyConsent(),
	/**
	 * Whether replacing the vault key/file can proceed without orphaning scoped
	 * recovery material. A transfer wraps its one-time key under this vault, so a
	 * new vault and passphrase rotation must refuse while one exists. Adoption and
	 * backup restore stay available as disaster recovery: a missing/damaged vault
	 * may need its matching copy restored before the workflow key can be opened.
	 */
	canReplaceVaultKey: () => boolean = () => true,
	keyCoordinator: VaultKeyOperationCoordinator = new VaultKeyOperationCoordinator(),
	/** Candidate vaults must keep every encrypted Steam workflow decryptable. */
	isCompatibleRecoveryVault: (candidate: Pick<Envelope, 'kdf'>, key: Buffer) => boolean = () =>
		true,
	/** Whether a durable Steam workflow can still write or reconcile this account. */
	accountMutationBlocked: (steamId64: string) => boolean = () => false,
	/**
	 * Process-only workflow cleanup debt cannot be judged from a candidate vault
	 * or from the durable journal: an enrollment or transfer record has already
	 * been unlinked while its directory flush failed. Restoring an older backup
	 * in that state can erase the only vault copy of secrets Steam already issued.
	 * Kept separate from `canReplaceVaultKey`, because a compatible durable
	 * workflow must not block disaster recovery from its matching backup.
	 */
	hasProcessOnlyWorkflowCleanupDebt: () => boolean = () => false,
	/**
	 * Complete an account's separate encrypted recovery backup using durable
	 * main-process ownership. This callback is local-only; the vault IPC module
	 * receives neither a filesystem path nor a Steam service.
	 */
	onFinishRecoveryBackup: (steamId64: string) => Promise<void> | void = () => {
		throw new Error('Recovery backup completion is not available.');
	},
	/** Rebuild policy-dependent background schedules after strict routing is relaxed. */
	onRequireProxiesDisabled: () => void = () => undefined
): void {
	/**
	 * The setting has already committed when this runs. A local recovery-file
	 * failure must therefore leave its durable marker for the account row to
	 * explain and retry; throwing would falsely say the setting itself was not
	 * saved. The production callback performs no Steam or network work.
	 */
	const tryRefreshRecoveryBackup = async (steamId64: string): Promise<void> => {
		try {
			await onFinishRecoveryBackup(steamId64);
		} catch {
			// The pending/stale marker is the error channel and survives a restart.
		}
	};

	const requireReplaceableVaultKey = (): void => {
		if (!canReplaceVaultKey()) {
			throw new Error(
				'Finish or resolve the saved authenticator enrollment or transfer before replacing this vault or ' +
					'changing its passphrase. Its encrypted recovery key belongs to the current vault.'
			);
		}
	};
	const requireCompatibleRecoveryVault = (candidate: Envelope, key: Buffer): void => {
		let compatible: boolean;
		try {
			compatible = isCompatibleRecoveryVault(candidate, key);
		} catch {
			throw new Error(
				'A saved authenticator workflow cannot be read. The vault was not replaced; repair the application data folder or update the app first.'
			);
		}
		if (!compatible) {
			throw new Error(
				'That vault cannot open the saved authenticator recovery material. Nothing was replaced; choose the matching vault or backup.'
			);
		}
	};
	const requireNoProcessOnlyWorkflowCleanupDebt = (): void => {
		let blocked = true;
		try {
			blocked = hasProcessOnlyWorkflowCleanupDebt();
		} catch {
			// Unknown is blocked. Letting an older backup replace the current vault
			// is the irreversible direction when the safety state cannot answer.
		}
		if (blocked) {
			throw new Error(
				'Finish resolving the stored authenticator workflow and clear its local safety record before restoring or adopting a vault. Nothing was replaced.'
			);
		}
	};
	const requireCompatibleRecoveryVaultAtCommit = (candidate: Envelope, key: Buffer): void => {
		requireCompatibleRecoveryVault(candidate, key);
		// Compatibility and cleanup debt are separate facts. The early handler check
		// avoids needless passphrase work, but a journal clear can create process-only
		// debt while that asynchronous derivation is running. This callback executes
		// synchronously at the service's final pre-write boundary.
		requireNoProcessOnlyWorkflowCleanupDebt();
		// An export can still be cleaning its set-aside file after the vault locked.
		// The candidate-to-file commit is synchronous after this callback, so this is
		// the last boundary at which replacing every account can be refused safely.
		keyCoordinator.assertNoAccountSnapshots();
	};
	registerHandler(CHANNELS.vaultStatus, () => ({
		exists: vault.exists(),
		unlocked: vault.isUnlocked(),
		msUntilAutoLock: vault.msUntilAutoLock() ?? null,
		// Locked means no settings to read, and nothing on screen to gate.
		requireProxies: vault.isUnlocked() && vault.settings().requireProxies,
		// Locked reads false for the same reason: nothing is being checked then.
		updateCheck: vault.isUnlocked() && vault.settings().updateCheck,
		backupAvailable: vault.backupAvailable() !== undefined
	}));

	registerHandler(CHANNELS.vaultCreate, async ({ passphrase }) => {
		return keyCoordinator.duringVaultReplacement(async () => {
			requireReplaceableVaultKey();
			await vault.create(passphrase);
			await onUnlocked?.();
			return { ok: true as const };
		});
	});

	registerHandler(CHANNELS.vaultUnlock, async ({ passphrase }) => {
		await vault.unlock(passphrase);
		await onUnlocked?.();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.vaultAdopt, async ({ passphrase }) => {
		return keyCoordinator.duringVaultReplacement(async () => {
			requireNoProcessOnlyWorkflowCleanupDebt();
			const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
			const options = {
				title: 'Choose a vault file',
				properties: ['openFile', 'dontAddToRecent'] as const,
				filters: [
					{ name: 'Vault file', extensions: ['json'] },
					{ name: 'All files', extensions: ['*'] }
				]
			} satisfies Electron.OpenDialogOptions;

			const picked = await (parent
				? dialog.showOpenDialog(parent, options)
				: dialog.showOpenDialog(options));

			const path = picked.canceled ? undefined : picked.filePaths[0];
			if (path === undefined) {
				return { state: 'cancelled' as const };
			}

			// Parsed and written by the service, which refuses outright if a vault
			// already exists — this must never be a way to replace one.
			await vault.adoptFrom(path, passphrase, requireCompatibleRecoveryVaultAtCommit);
			return { state: 'adopted' as const };
		});
	});

	// Same post-unlock work as a normal unlock: this leaves the vault open, so
	// anything that runs on unlocking has to run here too.
	registerHandler(CHANNELS.vaultRestoreBackup, async ({ passphrase }) => {
		return keyCoordinator.duringVaultReplacement(async () => {
			requireNoProcessOnlyWorkflowCleanupDebt();
			await vault.restoreFromBackup(passphrase, requireCompatibleRecoveryVaultAtCommit);
			await onUnlocked?.();
			return { ok: true as const };
		});
	});

	registerHandler(CHANNELS.vaultLock, () => {
		vault.lock('manual');
		return { ok: true as const };
	});

	registerHandler(CHANNELS.vaultTouch, () => {
		vault.touch();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.vaultChangePassphrase, async ({ current, next }) => {
		return keyCoordinator.duringVaultReplacement(async () => {
			requireReplaceableVaultKey();
			await vault.changePassphrase(current, next);
			return { ok: true as const };
		});
	});

	registerHandler(CHANNELS.accountsList, () => ({
		// Routing is asked of the transport rather than read off the account: the
		// account knows what was configured, and only the transport knows what
		// Chromium actually did with it.
		accounts: vault
			.read()
			.accounts.map((account) => toSummary(account, routingStatus(account.steamId64)))
	}));

	registerHandler(CHANNELS.accountFinishRecoveryBackup, async ({ steamId64 }) => {
		await onFinishRecoveryBackup(steamId64);
		vault.touch();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.settingsGet, () => {
		// `settings()` rather than `read()`: the latter deep-clones every secret in
		// the vault to hand back two numbers.
		const settings = vault.settings();
		return {
			requireProxies: settings.requireProxies,
			autoLockMinutes: settings.autoLockMinutes,
			clipboardClearSeconds: settings.clipboardClearSeconds,
			updateCheck: settings.updateCheck
		};
	});

	registerHandler(
		CHANNELS.settingsUpdate,
		async ({ requireProxies, autoLockMinutes, clipboardClearSeconds, updateCheck }) => {
			// Read before the write, because after it there is nothing left to
			// compare against and every save would look like a transition.
			const wasRequired = vault.settings().requireProxies;
			await vault.mutate((draft) => {
				// Assigned field by field, not spread. Spreading the request would let a
				// future field arrive here without anyone deciding it should be writable,
				// and `convenienceUnlock` is exactly the sort of thing that must not be
				// settable by accident.
				draft.settings.requireProxies = requireProxies;
				draft.settings.autoLockMinutes = autoLockMinutes;
				draft.settings.clipboardClearSeconds = clipboardClearSeconds;
				draft.settings.updateCheck = updateCheck;
			});

			// Lengthening the timeout should take effect now, not after the current
			// one expires. The auto-lock poll reads the setting each tick, so this
			// only has to survive the write — but touching also stops a save from
			// counting as idle time.
			vault.touch();

			// After the write, so whatever the callback tears down is judged
			// against the new rule rather than the old one — and only when the
			// rule is new, for the reason `onRequireProxies` documents.
			if (requireProxies && !wasRequired) {
				onRequireProxies();
			} else if (!requireProxies && wasRequired) {
				onRequireProxiesDisabled();
			}
			return { ok: true as const };
		}
	);

	registerHandler(CHANNELS.accountRemove, async ({ steamId64, passphrase }) => {
		// Gated exactly as the revocation reveal is, and for a heavier reason: that
		// one shows a secret, this one destroys it. Verified against the file, so it
		// is a real proof of knowledge rather than "the session happens to be open".
		await vault.verifyPassphrase(passphrase);

		const releaseAccountMutation = keyCoordinator.beginAccountMutation(steamId64);
		try {
			if (accountMutationBlocked(steamId64)) {
				throw new Error(
					'Finish or resolve this account’s unfinished authenticator operation before removing it.'
				);
			}
			await vault.mutate((draft) => {
				removeAccountFrom(draft.accounts, steamId64);
			});
		} finally {
			releaseAccountMutation();
		}

		// Everything that account had in memory goes with it — its cookie jar, its
		// cached Steam session, its pending confirmations. Leaving those behind
		// would mean a removed account could still reach Steam until the next lock.
		//
		// **`removed` distinguishes this from the routing saves below**, which
		// reach the same callback. Only here is it right to destroy the account's
		// activity history: everywhere else the account is still present, and the
		// entries still describe it.
		onProxyChanged(steamId64, true);

		vault.touch();
		return { ok: true as const };
	});

	registerHandler(
		CHANNELS.accountSetAutoConfirm,
		async ({
			steamId64,
			marketListings,
			trades,
			pollIntervalSeconds,
			tradesAcknowledgement,
			notify
		}) => {
			let recoveryChanged = false;
			const changedAt = new Date().toISOString();
			await vault.mutate((draft) => {
				const account = draft.accounts.find((entry) => entry.steamId64 === steamId64);
				if (!account) {
					throw new Error('no such account in this vault');
				}

				// The gate is on the **transition**, which only this side knows about.
				// Switching trades on is the one change here that lets items leave an
				// account with nobody watching; changing the interval afterwards, or
				// switching it back off, is not, and demanding the phrase for those
				// would train people to type it without reading it.
				if (trades && !account.autoConfirm.trades && !matchesTradesAck(tradesAcknowledgement)) {
					throw new Error(`type "${TRADES_ACK}" to switch automatic trade confirmation on`);
				}

				recoveryChanged =
					account.autoConfirm.marketListings !== marketListings ||
					account.autoConfirm.trades !== trades ||
					account.autoConfirm.pollIntervalSeconds !== pollIntervalSeconds ||
					account.autoConfirm.notify.enabled !== notify.enabled ||
					account.autoConfirm.notify.detail !== notify.detail;

				// Field by field again. This structure decides what gets approved
				// without a human present, and it is not one to populate by spread.
				account.autoConfirm.marketListings = marketListings;
				account.autoConfirm.trades = trades;
				account.autoConfirm.pollIntervalSeconds = pollIntervalSeconds;
				// Field by field here too, and for the same reason — a spread would
				// write whatever future key arrived on the request without anyone
				// having decided it should be writable from the renderer.
				account.autoConfirm.notify.enabled = notify.enabled;
				account.autoConfirm.notify.detail = notify.detail;
				if (recoveryChanged) {
					markRecoveryBackupNeeded(account, account.recoveryBackup, changedAt);
				}
			});

			onAutoConfirmChanged(steamId64);
			if (recoveryChanged) {
				await tryRefreshRecoveryBackup(steamId64);
			}
			vault.touch();
			return { ok: true as const };
		}
	);

	registerHandler(CHANNELS.accountSetProxy, async ({ steamId64, proxyUrl }) => {
		// Validated before it is stored, not when it is first used. A proxy that
		// cannot work should be refused while the user is looking at the field they
		// typed it into — otherwise the failure surfaces later as an account that
		// silently stops fetching, with nothing pointing at the cause.
		if (proxyUrl !== null) {
			planProxy(proxyUrl);

			/*
			 * **And a destination the user has not agreed to needs them to.**
			 *
			 * `planProxy` checks the scheme, the port and the credentials, and
			 * never the host — so this call is a renderer-controlled outbound
			 * connection to any name it likes, which is an exfiltration channel the
			 * threat model says the renderer does not have. Asked before the write,
			 * so a refusal leaves the vault untouched, and skipped entirely when
			 * the account already routes through that endpoint.
			 */
			const account = vault.read().accounts.find((candidate) => candidate.steamId64 === steamId64);

			/*
			 * **Saving the address it already uses introduces nothing**, so there is
			 * no decision to put to anybody — and a dialog with no decision left in
			 * it is how people are taught to click Allow on the one that matters.
			 * The screen saves the whole routing form, so this is the ordinary case
			 * whenever some other field on it changed.
			 *
			 * Compared here rather than left to the unlock-time seeding, so the
			 * handler is right on its own: seeding is an optimisation for a
			 * different problem, and a rule that only holds because something else
			 * happened first is a rule waiting to be broken by a refactor.
			 */
			/*
			 * The *stored* address is parsed defensively, unlike the incoming one:
			 * this is a value an older build may have written, and throwing on it
			 * would block the very edit that replaces it. Unreadable means "not a
			 * destination", which asks rather than skips — the safe direction.
			 */
			/*
			 * **The whole address, not its endpoint.**
			 *
			 * Comparing `host:port` meant saving the same approved endpoint with
			 * different credentials counted as "unchanged" and skipped the dialog —
			 * and the transport then sends those credentials to the proxy on the
			 * next authentication. A compromised renderer needs no new destination
			 * for that: it encodes what it wants to leak into the username and
			 * password and posts it to an operator the user already approved.
			 *
			 * String equality is deliberately strict. A cosmetic difference
			 * re-asks, which is the safe direction to be wrong in, and the same
			 * fingerprint inside `ProxyConsent` means a genuine re-save of the
			 * identical address still never reaches a dialog.
			 */
			const current =
				account?.proxyUrl === undefined || account.proxyUrl === '' ? undefined : account.proxyUrl;
			if (current !== proxyUrl) {
				await proxyConsent.require(proxyUrl, {
					...(account?.accountName === undefined ? {} : { accountName: account.accountName }),
					reason: 'route'
				});
			}
		}

		let changed = false;
		const changedAt = new Date().toISOString();
		await vault.mutate((draft) => {
			changed = applyProxyChange(draft.accounts, steamId64, proxyUrl);
			if (changed) {
				const account = draft.accounts.find((entry) => entry.steamId64 === steamId64);
				if (account !== undefined) {
					markRecoveryBackupNeeded(account, account.recoveryBackup, changedAt);
				}
			}
		});

		// The session holding the old proxy has to go, or the account keeps using
		// the routing it was just moved off — including "none" after one was added.
		// This also drops the cookie jar and any cached access token, which is the
		// in-memory half of what `applyProxyChange` did to the stored token.
		if (changed) {
			onProxyChanged(steamId64);
			await tryRefreshRecoveryBackup(steamId64);
		}

		vault.touch();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.revocationReveal, async ({ steamId64, passphrase }) => {
		// Being unlocked is not enough. "Unlocked" means the machine was used
		// recently, not that the owner is at it — and recovery codes are the one
		// secret whose loss cannot be undone, so an unattended machine must not
		// surrender them.
		//
		// Verified against the FILE rather than a cached key, so this is a real
		// proof of knowledge and costs a full scrypt derivation. That cost is also
		// what makes guessing here pointless.
		await vault.verifyPassphrase(passphrase);

		const account = vault.read().accounts.find((a) => a.steamId64 === steamId64);
		if (!account) {
			throw new Error('no such account in this vault');
		}
		if (!account.revocationCode) {
			throw new Error(
				'this account has no revocation code on file. It was imported from a maFile that ' +
					'did not contain one, and it cannot be recovered without Steam Support.'
			);
		}

		// Recorded only once the code is genuinely about to be returned, so the
		// confirm step below cannot be reached without this having happened — and
		// recorded *with* the code, so confirming a different one later cannot ride
		// on this reveal.
		ceremony.recordReveal(steamId64, account.revocationCode);

		vault.touch();
		return { revocationCode: account.revocationCode };
	});

	registerHandler(CHANNELS.revocationConfirmBackup, async ({ steamId64 }) => {
		// The ceremony is show-then-confirm, and this is where that is enforced
		// rather than merely presented. Without it, one IPC call clears the warning
		// for an account whose code was never displayed to anybody.
		//
		// Checked against the code stored *now*: an import between the reveal and
		// this call can have replaced it, and the reveal said nothing about the
		// replacement.
		const current = vault.read().accounts.find((a) => a.steamId64 === steamId64);
		if (!current?.revocationCode || !ceremony.hasRevealed(steamId64, current.revocationCode)) {
			throw new Error('the recovery code has to be shown before it can be marked as written down');
		}

		// Completes §11 S12. Without this the ceremony had no ending: an imported
		// account with a code sat in `pendingRevocationBackup` permanently, and a
		// warning that can never be cleared is a warning people learn to look past.
		await vault.mutate((draft) => {
			markRevocationBackedUp(draft.accounts, steamId64, new Date());
		});

		vault.touch();
		return { ok: true as const };
	});
}

/**
 * Take one account out of the vault.
 *
 * Exported and tested directly, like every other decision in this file that
 * cannot be undone. Removing the wrong one, or removing more than one, is not a
 * failure a user gets to notice and correct.
 */
export function removeAccountFrom(accounts: { steamId64: string }[], steamId64: string): void {
	const index = accounts.findIndex((entry) => entry.steamId64 === steamId64);
	if (index < 0) {
		throw new Error('no such account in this vault');
	}
	// `splice`, not `filter`: the draft is the array the vault will write, and
	// replacing it wholesale would drop any field a newer build had added to the
	// other entries.
	accounts.splice(index, 1);
}

/**
 * Set or remove one account's routing.
 *
 * Exported and tested directly, because `null` and `''` meaning different things
 * is the kind of distinction that decays into a proxy field that looks empty and
 * is not. Removal **deletes** the key rather than storing an empty string.
 */
export function applyProxyChange(
	accounts: {
		steamId64: string;
		proxyUrl?: string | undefined;
		refreshToken?: string | undefined;
	}[],
	steamId64: string,
	proxyUrl: string | null
): boolean {
	const account = accounts.find((entry) => entry.steamId64 === steamId64);
	if (!account) {
		throw new Error('no such account in this vault');
	}

	const before = account.proxyUrl;
	if (proxyUrl === null) {
		delete account.proxyUrl;
	} else {
		account.proxyUrl = proxyUrl;
	}

	const changed = before !== account.proxyUrl;
	if (changed) {
		// **The saved Steam session goes with the route it was made on.**
		//
		// A refresh token was issued to a session Steam observed coming from one
		// address. Carrying it to a different one hands Valve — and both proxy
		// operators — the fact that those two addresses are the same person, which
		// is the entire thing routing exists to prevent. Cheaper to sign in again
		// than to quietly undo the anonymity the user asked for.
		delete account.refreshToken;
	}

	return changed;
}

/** The shape `markRevocationBackedUp` needs. Narrower than the full account. */
interface BackupTarget {
	steamId64: string;
	status: string;
	sharedSecret?: string | undefined;
	revocationCode?: string | undefined;
	revocationBackedUpAt?: string | undefined;
	recoveryBackup?: Account['recoveryBackup'];
}

function hasRecoverySecret(
	account: BackupTarget
): account is BackupTarget & { sharedSecret: string } {
	return typeof account.sharedSecret === 'string';
}

/**
 * Record the backup ceremony against one account.
 *
 * Exported and given its own tests rather than left inline in the handler: it
 * decides when an account stops being flagged as unprotected, and that decision
 * should not be reachable only by clicking through a live app.
 */
export function markRevocationBackedUp(
	accounts: BackupTarget[],
	steamId64: string,
	now: Date
): void {
	const account = accounts.find((entry) => entry.steamId64 === steamId64);
	if (!account) {
		throw new Error('no such account in this vault');
	}
	if (!account.revocationCode) {
		// Nothing to have written down. Marking it done would clear a warning that
		// is telling the truth — this account genuinely cannot be self-recovered.
		throw new Error('this account has no revocation code to back up');
	}

	// Dated against the code it was performed on. A later import bringing a
	// different code clears this again, because the paper the user is holding
	// would no longer match what is stored.
	const changedAt = now.toISOString();
	const previousRecovery = account.recoveryBackup;
	account.revocationBackedUpAt = changedAt;
	if (account.status === 'pendingRevocationBackup') {
		account.status = 'active';
	}
	// This timestamp and, ordinarily, the status are both serialized into the
	// recovery document. The paper-backup ceremony has succeeded regardless of
	// what the separate encrypted file does next, so record local repair debt in
	// the same vault mutation and let the account-row action finish it later.
	if (previousRecovery !== undefined && hasRecoverySecret(account)) {
		markRecoveryBackupNeeded(account, previousRecovery, changedAt);
	}
}

/**
 * Strip an account down to what the renderer may see.
 *
 * Exported for direct testing: this single function decides what crosses the
 * process boundary, so it deserves a test that hands it a fully-populated
 * account and checks that not one secret survives — rather than only being
 * exercised through a live Electron app.
 */
export function toSummary(
	account: {
		steamId64: string;
		accountName: string;
		sharedSecret?: string | undefined;
		status: string;
		revocationCode?: string | undefined;
		proxyUrl?: string | undefined;
		recoveryBackup?: { state: 'pending' | 'current' | 'stale' } | undefined;
		unresolvedOperation?:
			| {
					kind: 'activate' | 'deactivate';
					guidance: string;
					certain?: boolean;
					fingerprint?: string;
					operationId?: string;
					at: string;
			  }
			| undefined;
		autoConfirm: {
			marketListings: boolean;
			trades: boolean;
			pollIntervalSeconds: number;
			notify: { enabled: boolean; detail: NotifyDetail };
		};
	},
	routing?: RoutingStatus
): AccountSummary {
	const unresolvedIsUnidentified =
		account.unresolvedOperation !== undefined &&
		!isAuthenticatorFingerprint(account.unresolvedOperation.fingerprint);
	const unresolvedIsStale =
		account.unresolvedOperation !== undefined &&
		isAuthenticatorFingerprint(account.unresolvedOperation.fingerprint) &&
		account.sharedSecret !== undefined &&
		account.unresolvedOperation.fingerprint !== authenticatorFingerprint(account);
	const unresolvedToken =
		account.unresolvedOperation !== undefined &&
		isAuthenticatorFingerprint(account.unresolvedOperation.fingerprint)
			? operationRecordToken('vault', {
					steamId64: account.steamId64,
					...account.unresolvedOperation
				})
			: undefined;
	const summary: AccountSummary = {
		steamId64: account.steamId64,
		accountName: account.accountName,
		status: account.status as AccountSummary['status'],
		// Whether one exists — never the value.
		hasRevocationCode: account.revocationCode !== undefined,
		...(account.recoveryBackup?.state === 'pending' || account.recoveryBackup?.state === 'stale'
			? { recoveryBackup: account.recoveryBackup.state }
			: {}),
		// A fresh object rather than the stored reference, like everything else
		// that crosses to the renderer here.
		...(account.unresolvedOperation !== undefined
			? {
					unresolvedOperation: {
						kind: account.unresolvedOperation.kind,
						guidance: account.unresolvedOperation.guidance,
						at: account.unresolvedOperation.at,
						...(account.unresolvedOperation.certain !== undefined
							? { certain: account.unresolvedOperation.certain }
							: {}),
						...(!unresolvedIsStale && unresolvedToken !== undefined
							? { operationToken: unresolvedToken }
							: {}),
						...(unresolvedIsStale && unresolvedToken !== undefined
							? { stale: true, staleToken: unresolvedToken }
							: {}),
						...(unresolvedIsUnidentified ? { unidentified: true } : {})
					}
				}
			: {}),
		// Whether routing is configured — never the URL, which carries credentials.
		hasProxy: account.proxyUrl !== undefined,
		// What is *known*, which is deliberately not the same question. An account
		// with a proxy that nothing has connected through yet is `unverified`, not
		// routed — claiming otherwise is the reassurance this must never give.
		routing: account.proxyUrl === undefined ? 'off' : (routing?.state ?? 'unverified'),
		autoConfirm: {
			marketListings: account.autoConfirm.marketListings,
			trades: account.autoConfirm.trades,
			pollIntervalSeconds: account.autoConfirm.pollIntervalSeconds,
			// A fresh object, like everything else here. This one crosses to the
			// renderer, and handing out a reference into vault contents is how a
			// screen ends up able to write to the vault by assigning to what it was
			// shown.
			notify: {
				enabled: account.autoConfirm.notify.enabled,
				detail: account.autoConfirm.notify.detail
			}
		}
	};

	// Both come from the transport's own record, so they are already redacted —
	// `via` is `plan.redacted`, which replaces credentials rather than trimming
	// them.
	if (routing && routing.state !== 'off') summary.routedVia = routing.via;
	if (routing?.state === 'blocked') summary.routingProblem = routing.reason;

	return summary;
}
