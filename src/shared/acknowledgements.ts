/**
 * The acknowledgement phrases and their matcher — deliberately zod-free.
 *
 * These are the only *values* the renderer needs from the IPC contract, and
 * they used to live inside `ipc.ts` — which imports zod. Two screens importing
 * two constants therefore pulled the entire schema library into the renderer
 * bundle: 327 KB of validator, in a process that validates nothing, to compare
 * two strings. The contract re-exports everything here so the main process
 * keeps one import path and the wording still cannot drift between the field
 * and the check.
 */

/**
 * The words a user must type to switch automatic trade confirmation on.
 *
 * Enforced by the main process; the screen imports this same constant so the
 * two cannot drift — a gate whose wording differs between the field and the
 * check is a gate that silently opens.
 */
export const TRADES_ACK = 'APPROVE TRADES';

/**
 * The words a user must type to detach an authenticator from Steam.
 *
 * Names the consequence rather than confirming an intent — "REMOVE STEAM GUARD"
 * is what actually happens, and somebody typing it cannot later say they thought
 * it only affected this app.
 */
export const DEACTIVATE_ACK = 'REMOVE STEAM GUARD';

/**
 * Whether what the user typed counts as the acknowledgement.
 *
 * Internal whitespace is collapsed. The first version compared after `trim()`
 * only, so `APPROVE  TRADES` was refused: a person typing two words is not
 * making a security decision about how many spaces sit between them.
 */
export function matchesTradesAck(typed: string | undefined): boolean {
	return matchesAck(typed, TRADES_ACK);
}

/** The same rule for the deactivation phrase. */
export function matchesDeactivateAck(typed: string | undefined): boolean {
	return matchesAck(typed, DEACTIVATE_ACK);
}

function matchesAck(typed: string | undefined, phrase: string): boolean {
	return typed !== undefined && typed.trim().replace(/\s+/g, ' ').toUpperCase() === phrase;
}
