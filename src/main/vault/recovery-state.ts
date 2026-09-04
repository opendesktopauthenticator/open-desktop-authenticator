import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { Account } from '../../shared/vault-schema';
import { authenticatorFingerprint } from '../steam/authenticator-secrets';
import { isRecoveryFileNameForAuthenticator } from './recovery';
import type { VaultService } from './service';

export const RECOVERY_PUBLICATION_WARNING =
	'This authenticator is stored in the vault, but its separate encrypted recovery backup is not current. Repair the application data folder and choose “Finish recovery backup”; Steam will not be contacted.';

export type RecoveryBackup = NonNullable<Account['recoveryBackup']>;

/**
 * Atomically pair a recovery obligation with the account mutation that caused it.
 *
 * The exact filename remains usable only when the authenticator fingerprint is
 * unchanged. A status-only change makes that owned file stale; a replacement
 * authenticator needs a fresh no-clobber publication and starts pending.
 */
export function markRecoveryBackupNeeded(
	account: Pick<Account, 'sharedSecret' | 'recoveryBackup'>,
	previous: Account['recoveryBackup'],
	changedAt: string
): RecoveryBackup {
	const fingerprint = authenticatorFingerprint(account);
	const ownsSameAuthenticator =
		previous !== undefined &&
		previous.authenticatorFingerprint === fingerprint &&
		previous.fileName !== undefined &&
		(previous.state === 'current' || previous.state === 'stale');
	const next: RecoveryBackup = ownsSameAuthenticator
		? {
				version: 1,
				id: randomUUID(),
				authenticatorFingerprint: fingerprint,
				state: 'stale',
				fileName: previous.fileName,
				changedAt
			}
		: {
				version: 1,
				id: randomUUID(),
				authenticatorFingerprint: fingerprint,
				state: 'pending',
				changedAt
			};
	account.recoveryBackup = next;
	return next;
}

export function recoveryBackupNeedsAttention(account: Account): boolean {
	return account.recoveryBackup?.state === 'pending' || account.recoveryBackup?.state === 'stale';
}

export type RecoveryCompletion = 'current' | 'missing' | 'ambiguous' | 'moved';

/**
 * Complete only local recovery-file work for one committed account.
 *
 * The generation and authenticator are rechecked both before filesystem work
 * and inside the completing vault mutation. A delayed result can therefore
 * never mark a replacement authenticator current. `writeRecovery` returns the
 * actual no-clobber path it used; only its basename crosses into the vault.
 */
export async function finishRecoveryBackup(
	vault: VaultService,
	input: {
		steamId64: string;
		expectedId?: string;
		writeRecovery?: (account: Account) => unknown;
		updateRecovery?: (account: Account) => unknown;
		now?: () => number;
	}
): Promise<RecoveryCompletion> {
	const account = vault.read().accounts.find((entry) => entry.steamId64 === input.steamId64);
	const marker = account?.recoveryBackup;
	if (account === undefined || marker === undefined) return 'moved';
	if (input.expectedId !== undefined && marker.id !== input.expectedId) return 'moved';
	if (marker.authenticatorFingerprint !== authenticatorFingerprint(account)) return 'moved';
	if (marker.state === 'current') return 'current';

	let fileName: string | undefined;
	if (marker.state === 'pending') {
		if (input.writeRecovery === undefined) return 'missing';
		const written = input.writeRecovery(account);
		if (typeof written !== 'string' || written.length === 0) return 'missing';
		fileName = basename(written);
		if (!isRecoveryFileNameForAuthenticator(account, fileName)) return 'missing';
	} else {
		if (input.updateRecovery === undefined) return 'missing';
		const result = input.updateRecovery(account);
		if (result === 'ambiguous') return result;
		if (result === 'updated') {
			fileName = marker.fileName;
		} else if (result === 'missing') {
			// The marker proves which exact file used to belong to this authenticator,
			// but a deleted file leaves nothing that can be updated. Publish a fresh
			// no-clobber copy and persist the path it actually received. Never take this
			// route for ambiguity: another possible owner must remain a hard refusal.
			if (input.writeRecovery === undefined) return 'missing';
			const written = input.writeRecovery(account);
			if (typeof written !== 'string' || written.length === 0) return 'missing';
			fileName = basename(written);
			if (!isRecoveryFileNameForAuthenticator(account, fileName)) return 'missing';
		} else {
			return 'missing';
		}
	}
	if (fileName === undefined) return 'missing';

	let completed = false;
	await vault.mutate((draft) => {
		const current = draft.accounts.find((entry) => entry.steamId64 === input.steamId64);
		if (
			current === undefined ||
			current.recoveryBackup?.id !== marker.id ||
			current.recoveryBackup.authenticatorFingerprint !== marker.authenticatorFingerprint ||
			authenticatorFingerprint(current) !== marker.authenticatorFingerprint
		) {
			return;
		}
		current.recoveryBackup = {
			...current.recoveryBackup,
			state: 'current',
			fileName,
			changedAt: new Date((input.now ?? Date.now)()).toISOString()
		};
		completed = true;
	});
	return completed ? 'current' : 'moved';
}
