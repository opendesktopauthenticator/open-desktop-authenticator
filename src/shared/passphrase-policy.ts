/**
 * Passphrase policy, with no runtime dependencies.
 *
 * Separate from `vault-schema.ts` for the same reason `channels.ts` is separate
 * from `ipc.ts`: the renderer needs these rules to give feedback as the user
 * types, and importing them from the schema module would pull zod into the
 * renderer bundle for two constants.
 *
 * Both sides import from here, so the rule the UI shows and the rule the vault
 * enforces cannot drift apart.
 */

/** §10.3. Length is the only hard requirement. */
export const MIN_PASSPHRASE_LENGTH = 12;

/**
 * Why a passphrase is unacceptable, or undefined if it is fine.
 *
 * Deliberately no composition rules. Requiring a digit and a symbol pushes people
 * toward `Passw0rd!` and away from long passphrases, which is the wrong direction
 * for a secret with no recovery path.
 */
export function passphraseProblem(passphrase: string): string | undefined {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		return `Use at least ${MIN_PASSPHRASE_LENGTH} characters. There is no way to recover this vault if you forget it.`;
	}
	// Not a composition rule — a rejection of something nobody means to type.
	// Twelve spaces satisfied the length test and created a vault whose passphrase
	// is invisible, unmemorable and unrecoverable. This catches a held-down space
	// bar or a paste that went wrong, and refuses nothing a person would choose.
	if (passphrase.trim().length === 0) {
		return 'That is only whitespace. Use words you will remember — there is no way to recover this vault.';
	}
	return undefined;
}

/**
 * Whether vault creation may proceed.
 *
 * A pure function rather than a pile of `&&` inside JSX, because this is the
 * gate on the no-recovery ceremony — the one piece of UI logic where being wrong
 * means someone creates a vault they cannot open. Testable without a DOM.
 */
export function canCreateVault(input: {
	passphrase: string;
	confirmation: string;
	acknowledged: boolean;
}): boolean {
	if (!input.acknowledged) {
		return false;
	}
	if (passphraseProblem(input.passphrase) !== undefined) {
		return false;
	}
	// Compared, not merely both-non-empty: a typo in a secret with no recovery
	// path is unrecoverable, which is the entire reason for asking twice.
	return input.passphrase === input.confirmation;
}

export type PassphraseStrength = 'tooShort' | 'short' | 'reasonable' | 'good';

/**
 * Coarse, honest feedback — not a strength score.
 *
 * A meter that rates `Password123!` as "Strong" actively misleads, because it
 * scores character classes rather than guessability. This reports length bands
 * and says what actually helps: more words. It never tells someone a short
 * passphrase is safe.
 */
export function passphraseStrength(passphrase: string): PassphraseStrength {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		return 'tooShort';
	}
	if (passphrase.length < 16) {
		return 'short';
	}
	if (passphrase.length < 24) {
		return 'reasonable';
	}
	return 'good';
}

export const STRENGTH_ADVICE: Record<PassphraseStrength, string> = {
	tooShort: `Too short — at least ${MIN_PASSPHRASE_LENGTH} characters.`,
	short: 'Acceptable. Several unrelated words would be much stronger than a short complex one.',
	reasonable: 'Reasonable length.',
	good: 'Good length.'
};
