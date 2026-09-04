/** Error classes a scanner/indexer can report while briefly holding a pathname. */
const TRANSIENT_REPLACEMENT_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** 1.13 s total: bounded, but long enough for a Windows scanner to release its handle. */
const RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 500] as const;

/**
 * Retry one atomic rename without changing its commit semantics.
 *
 * Do not replace this with unlink-then-rename or a copy fallback: both introduce
 * states in which the destination is missing or only partly written. Persistent
 * failures propagate to the caller's existing rollback/reconciliation path.
 */
export function renameWithTransientRetry(
	rename: (from: string, to: string) => void,
	from: string,
	to: string
): void {
	for (let attempt = 0; ; attempt += 1) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (!TRANSIENT_REPLACEMENT_ERRORS.has(code ?? '') || attempt >= RETRY_DELAYS_MS.length) {
				throw error;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAYS_MS[attempt]);
		}
	}
}
