import type { VaultService } from './service';
import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { planProxy } from '../net/egress';
import type { RoutingStatus } from '../net/transport';
import type { AccountSummary } from '../../shared/ipc';

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
 * Which accounts have actually had their revocation code shown, this unlock.
 *
 * §11 S12's ceremony is *show the code, then confirm you wrote it down*. The UI
 * presents it that way, but the UI is not what enforces it — the renderer is
 * untrusted, and a `confirmRevocationBackup` call on its own would clear the
 * warning for an account whose code nobody ever saw. Marking a backup done that
 * did not happen is worse than nagging, because it is the one warning standing
 * between a user and an unrecoverable account.
 *
 * Reset on lock: an unlock is a new sitting, and the ceremony is per sitting.
 */
export class RevocationCeremony {
	private readonly revealed = new Set<string>();

	recordReveal(steamId64: string): void {
		this.revealed.add(steamId64);
	}

	hasRevealed(steamId64: string): boolean {
		return this.revealed.has(steamId64);
	}

	forget(): void {
		this.revealed.clear();
	}
}

/**
 * @param onProxyChanged told when an account's routing changed, so the network
 * layer can drop the session that still holds the old one. Injected rather than
 * imported: the vault has no business knowing what a socket is.
 * @param ceremony tracks which revocation codes have been shown this unlock.
 * @param onUnlocked fired after a successful create/unlock so the Steam clock
 * can be checked before the user is staring at codes.
 */
export function registerVaultHandlers(
	vault: VaultService,
	onProxyChanged: (steamId64: string) => void = () => undefined,
	ceremony: RevocationCeremony = new RevocationCeremony(),
	onUnlocked: () => Promise<void> | void = () => undefined,
	onAutoConfirmChanged: (steamId64: string) => void = () => undefined,
	// A lookup rather than the transport factory itself: this module has no other
	// business with the network layer, and the account list only needs an answer.
	routingStatus: (steamId64: string) => RoutingStatus | undefined = () => undefined
): void {
	registerHandler(CHANNELS.vaultStatus, () => ({
		exists: vault.exists(),
		unlocked: vault.isUnlocked(),
		msUntilAutoLock: vault.msUntilAutoLock() ?? null,
		backupAvailable: vault.backupAvailable() !== undefined
	}));

	registerHandler(CHANNELS.vaultCreate, async ({ passphrase }) => {
		await vault.create(passphrase);
		await onUnlocked?.();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.vaultUnlock, async ({ passphrase }) => {
		await vault.unlock(passphrase);
		await onUnlocked?.();
		return { ok: true as const };
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
		await vault.changePassphrase(current, next);
		return { ok: true as const };
	});

	registerHandler(CHANNELS.accountsList, () => ({
		// Routing is asked of the transport rather than read off the account: the
		// account knows what was configured, and only the transport knows what
		// Chromium actually did with it.
		accounts: vault
			.read()
			.accounts.map((account) => toSummary(account, routingStatus(account.steamId64)))
	}));

	registerHandler(CHANNELS.settingsGet, () => {
		// `settings()` rather than `read()`: the latter deep-clones every secret in
		// the vault to hand back two numbers.
		const settings = vault.settings();
		return {
			autoLockMinutes: settings.autoLockMinutes,
			clipboardClearSeconds: settings.clipboardClearSeconds
		};
	});

	registerHandler(CHANNELS.settingsUpdate, async ({ autoLockMinutes, clipboardClearSeconds }) => {
		await vault.mutate((draft) => {
			// Assigned field by field, not spread. Spreading the request would let a
			// future field arrive here without anyone deciding it should be writable,
			// and `convenienceUnlock` is exactly the sort of thing that must not be
			// settable by accident.
			draft.settings.autoLockMinutes = autoLockMinutes;
			draft.settings.clipboardClearSeconds = clipboardClearSeconds;
		});

		// Lengthening the timeout should take effect now, not after the current one
		// expires. The auto-lock poll reads the setting each tick, so this only has
		// to survive the write — but touching also stops a save from counting as
		// idle time.
		vault.touch();
		return { ok: true as const };
	});

	registerHandler(CHANNELS.accountRemove, async ({ steamId64, passphrase }) => {
		// Gated exactly as the revocation reveal is, and for a heavier reason: that
		// one shows a secret, this one destroys it. Verified against the file, so it
		// is a real proof of knowledge rather than "the session happens to be open".
		await vault.verifyPassphrase(passphrase);

		await vault.mutate((draft) => {
			removeAccountFrom(draft.accounts, steamId64);
		});

		// Everything that account had in memory goes with it — its cookie jar, its
		// cached Steam session, its pending confirmations. Leaving those behind
		// would mean a removed account could still reach Steam until the next lock.
		onProxyChanged(steamId64);

		vault.touch();
		return { ok: true as const };
	});

	registerHandler(
		CHANNELS.accountSetAutoConfirm,
		async ({ steamId64, marketListings, trades, pollIntervalSeconds }) => {
			await vault.mutate((draft) => {
				const account = draft.accounts.find((entry) => entry.steamId64 === steamId64);
				if (!account) {
					throw new Error('no such account in this vault');
				}
				// Field by field again. This structure decides what gets approved
				// without a human present, and it is not one to populate by spread.
				account.autoConfirm.marketListings = marketListings;
				account.autoConfirm.trades = trades;
				account.autoConfirm.pollIntervalSeconds = pollIntervalSeconds;
			});

			onAutoConfirmChanged(steamId64);
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
		}

		let changed = false;
		await vault.mutate((draft) => {
			changed = applyProxyChange(draft.accounts, steamId64, proxyUrl);
		});

		// The session holding the old proxy has to go, or the account keeps using
		// the routing it was just moved off — including "none" after one was added.
		// This also drops the cookie jar and any cached access token, which is the
		// in-memory half of what `applyProxyChange` did to the stored token.
		if (changed) {
			onProxyChanged(steamId64);
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
		// confirm step below cannot be reached without this having happened.
		ceremony.recordReveal(steamId64);

		vault.touch();
		return { revocationCode: account.revocationCode };
	});

	registerHandler(CHANNELS.revocationConfirmBackup, async ({ steamId64 }) => {
		// The ceremony is show-then-confirm, and this is where that is enforced
		// rather than merely presented. Without it, one IPC call clears the warning
		// for an account whose code was never displayed to anybody.
		if (!ceremony.hasRevealed(steamId64)) {
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
	revocationCode?: string | undefined;
	revocationBackedUpAt?: string | undefined;
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
	account.revocationBackedUpAt = now.toISOString();
	if (account.status === 'pendingRevocationBackup') {
		account.status = 'active';
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
		status: string;
		revocationCode?: string | undefined;
		proxyUrl?: string | undefined;
		autoConfirm: { marketListings: boolean; trades: boolean; pollIntervalSeconds: number };
	},
	routing?: RoutingStatus
): AccountSummary {
	const summary: AccountSummary = {
		steamId64: account.steamId64,
		accountName: account.accountName,
		status: account.status as AccountSummary['status'],
		// Whether one exists — never the value.
		hasRevocationCode: account.revocationCode !== undefined,
		// Whether routing is configured — never the URL, which carries credentials.
		hasProxy: account.proxyUrl !== undefined,
		// What is *known*, which is deliberately not the same question. An account
		// with a proxy that nothing has connected through yet is `unverified`, not
		// routed — claiming otherwise is the reassurance this must never give.
		routing: account.proxyUrl === undefined ? 'off' : (routing?.state ?? 'unverified'),
		autoConfirm: {
			marketListings: account.autoConfirm.marketListings,
			trades: account.autoConfirm.trades,
			pollIntervalSeconds: account.autoConfirm.pollIntervalSeconds
		}
	};

	// Both come from the transport's own record, so they are already redacted —
	// `via` is `plan.redacted`, which replaces credentials rather than trimming
	// them.
	if (routing && routing.state !== 'off') summary.routedVia = routing.via;
	if (routing?.state === 'blocked') summary.routingProblem = routing.reason;

	return summary;
}
