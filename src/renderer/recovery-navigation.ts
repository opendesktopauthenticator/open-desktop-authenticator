/** A mutable monotonic ticket for ownership of the foreground. */
export interface ForegroundRevision {
	current: number;
}

/** Claim the account-home foreground for one recovery-status request. */
export function claimRecoveryForeground(revision: ForegroundRevision): number {
	revision.current += 1;
	return revision.current;
}

/** Synchronously revoke every recovery claim made before this navigation. */
export function supersedeRecoveryForeground(revision: ForegroundRevision): void {
	revision.current += 1;
}

/** Deliver a recovery answer either to the untouched home or to its visible queue. */
export function deliverRecoveryAttention(
	revision: ForegroundRevision,
	claim: number,
	accountHomeOwnsForeground: boolean,
	takeOver: () => void,
	defer: () => void
): void {
	if (revision.current === claim && accountHomeOwnsForeground) {
		takeOver();
		return;
	}
	defer();
}
