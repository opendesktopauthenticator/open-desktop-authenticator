import { toMaFile } from '../import/export';
import type { Account } from '../../shared/vault-schema';

type ProtectedOperation =
	| 'transfer submission'
	| 'enrollment submission'
	| 'transfer recovery'
	| 'enrollment recovery'
	| 'authenticator activation'
	| 'authenticator removal';

/**
 * Serialises vault-key replacement and account identity changes with every
 * irreversible Steam submission.
 *
 * This is deliberately process-local. Durable workflow records cover crashes;
 * this coordinator closes the smaller in-process race where a passphrase change
 * starts before the transfer has written its wrapped-key record, or a restore
 * swaps the key while Steam's reply is still in flight.
 */
export class VaultKeyOperationCoordinator {
	private steamOperation: { kind: ProtectedOperation; steamId64: string } | undefined;
	private vaultReplacement = false;
	private accountMutation: { steamIds: ReadonlySet<string> | undefined } | undefined;
	private readonly accountSnapshots = new Map<string, number>();

	private snapshotBlocks(steamId64: string): boolean {
		return this.accountSnapshots.has(steamId64);
	}

	/**
	 * Reserve the current vault key for one complete irreversible submission.
	 * The returned release is idempotent so every error path can call it safely.
	 */
	private beginSteamOperation(kind: ProtectedOperation, steamId64: string): () => void {
		if (this.accountMutation) {
			throw new Error(
				'An account is currently being imported, replaced, or removed. Wait for that change to finish before starting an authenticator operation.'
			);
		}
		if (this.vaultReplacement) {
			throw new Error(
				`The vault is currently being created, restored, adopted, or re-keyed. Wait for that to finish before starting authenticator ${kind}.`
			);
		}
		if (this.steamOperation !== undefined) {
			throw new Error(
				`A protected authenticator operation (${this.steamOperation.kind}) is already in progress. Wait for it to finish first.`
			);
		}
		if (this.snapshotBlocks(steamId64)) {
			throw new Error(
				'This account is currently being exported. Wait for the export to finish before changing its authenticator.'
			);
		}
		this.steamOperation = { kind, steamId64 };
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.steamOperation = undefined;
		};
	}

	beginTransferSubmission(steamId64: string): () => void {
		return this.beginSteamOperation('transfer submission', steamId64);
	}

	beginEnrollmentSubmission(steamId64: string): () => void {
		return this.beginSteamOperation('enrollment submission', steamId64);
	}

	beginTransferRecovery(steamId64: string): () => void {
		return this.beginSteamOperation('transfer recovery', steamId64);
	}

	beginEnrollmentRecovery(steamId64: string): () => void {
		return this.beginSteamOperation('enrollment recovery', steamId64);
	}

	beginActivation(steamId64: string): () => void {
		return this.beginSteamOperation('authenticator activation', steamId64);
	}

	beginDeactivation(steamId64: string): () => void {
		return this.beginSteamOperation('authenticator removal', steamId64);
	}

	/**
	 * Hold one account's exported bytes stable while a maFile is being committed.
	 * Readers are counted rather than made exclusive: two exports are both reads,
	 * and a writer may proceed only after the last one releases its snapshot.
	 */
	beginAccountSnapshot(steamId64: string): () => void {
		const operation = this.steamOperation;
		if (operation !== undefined && operation.steamId64 === steamId64) {
			throw new Error(
				`A protected authenticator operation (${operation.kind}) is changing this account. Wait for it to finish before exporting.`
			);
		}
		const mutation = this.accountMutation;
		if (
			mutation !== undefined &&
			(mutation.steamIds === undefined || mutation.steamIds.has(steamId64))
		) {
			throw new Error(
				'This account is currently being imported, replaced, or removed. Wait for that change to finish before exporting.'
			);
		}

		this.accountSnapshots.set(steamId64, (this.accountSnapshots.get(steamId64) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (this.accountSnapshots.get(steamId64) ?? 1) - 1;
			if (remaining === 0) this.accountSnapshots.delete(steamId64);
			else this.accountSnapshots.set(steamId64, remaining);
		};
	}

	/** Refuse a vault commit which would make any active export snapshot stale. */
	assertAccountSnapshotsUnchanged(before: readonly Account[], after: readonly Account[]): void {
		for (const steamId64 of this.accountSnapshots.keys()) {
			const oldAccount = before.find((account) => account.steamId64 === steamId64);
			const newAccount = after.find((account) => account.steamId64 === steamId64);
			if (
				oldAccount === undefined ||
				newAccount === undefined ||
				toMaFile(oldAccount) !== toMaFile(newAccount)
			) {
				throw new Error(
					'This account is currently being exported. Wait for the export to finish before changing it.'
				);
			}
		}
	}

	/** Whole-vault replacement cannot commit while any account snapshot is live. */
	assertNoAccountSnapshots(): void {
		if (this.accountSnapshots.size !== 0) {
			throw new Error(
				'An account export is still finishing. Wait for it before replacing or restoring the vault.'
			);
		}
	}

	/**
	 * Reserve account identity/secrets against an irreversible Steam operation.
	 *
	 * Account removal and import replacement must share the same boundary as the
	 * workflow that can later write that account. Otherwise removal can land
	 * while token minting is still ahead of the durable journal write, or an
	 * import can replace secrets that a recovery record is about to restore.
	 */
	beginAccountMutation(steamIds?: string | readonly string[]): () => void {
		if (this.accountMutation) {
			throw new Error('Another account import, replacement, or removal is already in progress.');
		}
		if (this.vaultReplacement) {
			throw new Error(
				'The vault is currently being created, restored, adopted, or re-keyed. Wait for that to finish before changing an account.'
			);
		}
		if (this.steamOperation !== undefined) {
			throw new Error(
				`A protected authenticator operation (${this.steamOperation.kind}) is in progress. Wait for it to finish before importing, replacing, or removing an account.`
			);
		}
		const affected =
			steamIds === undefined
				? undefined
				: new Set(typeof steamIds === 'string' ? [steamIds] : steamIds);
		if (
			affected === undefined
				? this.accountSnapshots.size !== 0
				: [...affected].some((steamId64) => this.accountSnapshots.has(steamId64))
		) {
			throw new Error(
				'An affected account is currently being exported. Wait for the export to finish before importing, replacing, or removing it.'
			);
		}
		this.accountMutation = { steamIds: affected };
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.accountMutation = undefined;
		};
	}

	/**
	 * Hold out new transfer submissions for the complete key/file operation.
	 * The check and reservation are synchronous, so no promise can settle in the
	 * gap between them.
	 */
	async duringVaultReplacement<T>(operation: () => Promise<T> | T): Promise<T> {
		if (this.vaultReplacement) {
			throw new Error(
				'Another vault create, restore, adoption, or passphrase change is already in progress.'
			);
		}
		if (this.steamOperation !== undefined) {
			throw new Error(
				`A protected authenticator operation (${this.steamOperation.kind}) is in progress. Wait for it to finish before changing or restoring the vault.`
			);
		}
		if (this.accountMutation) {
			throw new Error(
				'An account import, replacement, or removal is in progress. Wait for it to finish before changing or restoring the vault.'
			);
		}
		this.vaultReplacement = true;
		try {
			return await operation();
		} finally {
			this.vaultReplacement = false;
		}
	}
}
