import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemoveAccount } from '../src/renderer/screens/RemoveAccount';
import type { AccountSummary } from '../src/shared/ipc';

/**
 * **"Nothing here can tell whether Steam acted", said about a removal Steam is
 * known to have performed.**
 *
 * The main process distinguishes the two: a lost reply, and a detach that
 * succeeded where only the local write failed. The second carries
 * `certain: true`, and this screen threw it away — the result was cast to
 * `{ state?, guidance? }` one line before it was read — so somebody whose
 * account definitely has no second factor left was told nobody could be sure.
 *
 * That is the worst direction for this particular sentence to be wrong in. A
 * user who believes the outcome is unknown waits and checks; a user whose
 * Steam Guard is actually off needs to add one somewhere else now.
 *
 * Rendered rather than asserted on state, because the copy is the defect.
 */

const account: AccountSummary = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	status: 'active',
	hasRevocationCode: true,
	hasProxy: false,
	routing: 'off',
	autoConfirm: {
		marketListings: false,
		trades: false,
		pollIntervalSeconds: 30,
		notify: { enabled: false, detail: 'count' }
	}
} as unknown as AccountSummary;

const GUIDANCE =
	'Steam Guard has been removed on Steam, but the account could not be removed here.';

/** The screen as it renders for an account carrying a stored outcome. */
function rendered(certain: boolean | undefined): string {
	const summary = {
		...account,
		unresolvedOperation: {
			kind: 'deactivate' as const,
			guidance: GUIDANCE,
			at: '2026-01-01T00:00:00.000Z',
			...(certain !== undefined ? { certain } : {})
		}
	} as unknown as AccountSummary;

	return renderToStaticMarkup(
		<RemoveAccount
			account={summary}
			onRemove={() => Promise.resolve()}
			onDeactivate={() => Promise.resolve({})}
			onResolve={() => Promise.resolve()}
			onClose={() => undefined}
		/>
	);
}

describe('a removal Steam is known to have performed', () => {
	const html = rendered(true);

	it('does not say nobody can tell', () => {
		expect(
			html,
			'the account has no second factor left and the screen said the outcome was unknowable, ' +
				'which is the direction this sentence must never be wrong in'
		).not.toContain('Nothing here can tell whether Steam acted');
	});

	it('says Steam already did it', () => {
		expect(html).toContain('Steam has already removed this');
	});

	it('says the account is now without a second factor', () => {
		expect(html).toMatch(/no second factor/i);
	});

	it('still shows the guidance from the main process', () => {
		expect(html).toContain(GUIDANCE);
	});
});

describe('a removal whose reply was lost', () => {
	const html = rendered(undefined);

	it('still says nobody can tell, because nobody can', () => {
		expect(html).toContain('Nothing here can tell whether Steam acted');
	});

	it('does not claim Steam acted', () => {
		expect(html).not.toContain('Steam has already removed this');
		expect(html).toContain('This may already have happened');
	});
});

/**
 * **A control that can only fail is not an offer.**
 *
 * When the record could not be written there is no stored operation for the
 * handler to act on, so either answer comes back refused — the previous version
 * of this returned a cheerful `ok` and closed the screen, and the version after
 * that showed an error for a button nobody should have been given. The
 * paragraph above already says the warning will not survive the window; the
 * buttons that pretend otherwise are gone.
 */
describe('an outcome whose record was saved', () => {
	it('offers the resolution', () => {
		const html = rendered(false);

		expect(html).toContain('Steam Guard is off — remove this account here');
		expect(html, 'the passphrase this path requires is not asked for').toContain(
			'resolve-passphrase'
		);
	});
});

/**
 * **What this harness cannot reach, said plainly.**
 *
 * When the record could not be written there is no stored operation for the
 * handler to act on, so either answer comes back refused — and the controls are
 * hidden rather than offered. **That gating is not covered by a test.** The
 * unsaved state arrives only from a live `onDeactivate` result, and this project
 * renders screens with `renderToStaticMarkup` and has no runner that can click.
 * A test built from a stored record always seeds `persisted: true`, so it would
 * assert the opposite branch while claiming to cover this one.
 *
 * The main-process half of it — that a resolution with no stored record is
 * refused rather than reported as success — is covered, in
 * `unresolved-operation-latch.test.ts`.
 */
