/**
 * Strip Electron's IPC wrapper from an error message.
 *
 * `invoke` rejects with `Error invoking remote method 'channel': <real message>`.
 * Showing that prefix teaches the user nothing and makes every failure look like
 * an Electron bug rather than the reason the main process gave.
 */
export function messageOf(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
}
