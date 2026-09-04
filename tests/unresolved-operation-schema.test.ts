import { describe, expect, it } from 'vitest';
import { accountSchema } from '../src/shared/vault-schema';

/**
 * **A promise the account object keeps and its nested objects did not.**
 *
 * `accountSchema` is `.passthrough()`, and the comment on it says why: "Preserve
 * fields written by a newer build rather than dropping them on the next save.
 * Losing an unrecognised field could mean losing a secret."
 *
 * `unresolvedOperation` was added as a plain nested object, so that rule stopped
 * at the boundary. Zod strips what a plain object does not declare, and the next
 * ordinary save writes the stripped version back — which means an older build
 * merely *opening* a vault destroys whatever a newer one recorded there. That is
 * the exact failure the outer `.passthrough()` exists to prevent, one level
 * down, on the record that decides whether an irreversible Steam operation may
 * be attempted again.
 */

const base = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
	identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
	status: 'active',
	addedAt: '2026-01-01T00:00:00.000Z'
};

describe('an unresolved operation written by a newer build', () => {
	it('keeps a field this build does not know about', () => {
		const parsed = accountSchema.parse({
			...base,
			unresolvedOperation: {
				kind: 'activate',
				guidance: 'check the account',
				at: '2026-01-01T00:00:00.000Z',
				// Whatever a later build decides it needs — a resolution the user
				// chose, a Steam-side confirmation, an attempt counter.
				resolvedBy: 'the-user-said-steam-did-it'
			}
		});

		expect(
			(parsed.unresolvedOperation as Record<string, unknown> | undefined)?.resolvedBy,
			'an older build opening the vault silently deleted what a newer one recorded, and the ' +
				'next save wrote the loss to disk'
		).toBe('the-user-said-steam-did-it');
	});

	/* The fields this build does rely on are still parsed and still required. */
	it('still refuses one that is missing what the code reads', () => {
		expect(() =>
			accountSchema.parse({
				...base,
				unresolvedOperation: { kind: 'activate', at: '2026-01-01T00:00:00.000Z' }
			})
		).toThrow();
	});

	it('still refuses a kind it cannot act on', () => {
		expect(() =>
			accountSchema.parse({
				...base,
				unresolvedOperation: {
					kind: 'reticulate',
					guidance: 'g',
					at: '2026-01-01T00:00:00.000Z'
				}
			})
		).toThrow();
	});

	/* And the outer promise it is copying still holds, so this is a pair. */
	it('keeps an unknown field on the account itself', () => {
		const parsed = accountSchema.parse({ ...base, somethingNewer: 'kept' });

		expect((parsed as Record<string, unknown>).somethingNewer).toBe('kept');
	});
});
