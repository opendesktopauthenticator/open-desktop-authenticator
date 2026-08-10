/**
 * Redaction wrapper (§11 S4).
 *
 * Every line the spike prints goes through here. Secrets are registered the
 * moment they are parsed, and any registered value is scrubbed from output --
 * even if some future call site is careless enough to interpolate one.
 *
 * This is the spike's proof-of-concept for the product's logging boundary.
 * Phase 1 promotes this idea into `/src/main` and forbids raw console.log of
 * Steam-layer objects (§24.4).
 */

/** Values that must never reach stdout/stderr verbatim. */
const registered = new Set<string>();

/** Below this, scrubbing does more damage to output than it prevents. */
const DEFAULT_MIN_LENGTH = 8;
/** Hard floor even for forced registration — a 3-character token would shred logs. */
const ABSOLUTE_MIN_LENGTH = 4;

/**
 * Register a value as secret.
 *
 * Short values are ignored by default: scrubbing a 3-character string would
 * corrupt unrelated output, and nothing that short is a real secret.
 *
 * `force` lowers the bar for values that ARE secret despite being short. The
 * motivating case is the revocation code: the classic `R#####` form is six
 * characters, so the default threshold silently let it through — and it is the
 * one secret whose loss cannot be recovered from.
 */
export function registerSecret(
	value: string | undefined | null,
	options: { force?: boolean } = {}
): void {
	if (typeof value !== 'string') {
		return;
	}
	const minimum = options.force ? ABSOLUTE_MIN_LENGTH : DEFAULT_MIN_LENGTH;
	if (value.length >= minimum) {
		registered.add(value);
	}
}

export function clearRegisteredSecrets(): void {
	registered.clear();
}

/**
 * Mask a value for display: keep a short prefix so a human can eyeball
 * "yes, that's the token I expected" without the value being usable.
 */
export function mask(value: string | undefined | null, keep = 6): string {
	if (!value) {
		return '<empty>';
	}
	if (value.length <= keep) {
		return '*'.repeat(value.length);
	}
	return `${value.slice(0, keep)}…[${value.length - keep} more chars redacted]`;
}

/** Replace every registered secret found anywhere in `text`. */
export function scrub(text: string): string {
	let out = text;
	for (const secret of registered) {
		if (secret && out.includes(secret)) {
			out = out.split(secret).join('[REDACTED]');
		}
	}
	return out;
}

function render(parts: unknown[]): string {
	return scrub(
		parts
			.map((p) => {
				if (typeof p === 'string') {
					return p;
				}
				if (p instanceof Error) {
					return p.message;
				}
				try {
					return JSON.stringify(p);
				} catch {
					return String(p);
				}
			})
			.join(' ')
	);
}

export const log = {
	info(...parts: unknown[]): void {
		process.stdout.write(`${render(parts)}\n`);
	},
	warn(...parts: unknown[]): void {
		process.stderr.write(`! ${render(parts)}\n`);
	},
	error(...parts: unknown[]): void {
		process.stderr.write(`✗ ${render(parts)}\n`);
	},
	blank(): void {
		process.stdout.write('\n');
	}
};
