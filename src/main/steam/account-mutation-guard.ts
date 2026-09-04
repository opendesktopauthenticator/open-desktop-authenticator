import type { OperationJournal } from './operation-journal';
import type { WorkflowJournal } from './workflow-journal';
import { authenticatorFingerprint, isAuthenticatorFingerprint } from './authenticator-secrets';

interface AccountMutationVaultView {
	read(): {
		accounts: ReadonlyArray<{
			steamId64: string;
			sharedSecret: string;
			unresolvedOperation?: { fingerprint?: string | undefined } | undefined;
			recoveryBackup?: { state: 'pending' | 'current' | 'stale' } | undefined;
		}>;
	};
}

/**
 * Whether adding, replacing, restoring, or removing this account could overtake
 * Steam work that still owns its authenticator state.
 *
 * The three durable stores cover different failure windows: the encrypted
 * workflow journal retains enrollment/transfer secrets, the operation journal
 * records activate/deactivate intent before the request, and the vault carries
 * the richer outcome after Steam answers. Any unreadable source fails closed;
 * inability to prove the account is free is not permission to change it.
 */
export function accountMutationBlockedByDurableState(
	vault: AccountMutationVaultView,
	workflows: Pick<WorkflowJournal, 'enrollments' | 'transfers'>,
	operations: Pick<OperationJournal, 'readAll'>,
	steamId64: string,
	/** Process-only debt from a failed durability flush; inability to read it fails closed too. */
	processOnlyBlocked: (steamId64: string) => boolean = () => false
): boolean {
	try {
		if (processOnlyBlocked(steamId64)) return true;
		const account = vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		const operationNotes = operations.readAll(steamId64);
		const fingerprint = account === undefined ? undefined : authenticatorFingerprint(account);
		return (
			workflows.enrollments(steamId64).length !== 0 ||
			workflows.transfers(steamId64).length !== 0 ||
			(account !== undefined &&
				((account.recoveryBackup !== undefined && account.recoveryBackup.state !== 'current') ||
					(account.unresolvedOperation !== undefined &&
						(!isAuthenticatorFingerprint(account.unresolvedOperation.fingerprint) ||
							account.unresolvedOperation.fingerprint === fingerprint)) ||
					operationNotes.some((note) => note.fingerprint === fingerprint)))
		);
	} catch {
		return true;
	}
}
