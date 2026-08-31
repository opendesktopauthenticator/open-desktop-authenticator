import { describe, expect, it } from 'vitest';
import { confirmationsTargetFor } from '../src/renderer/App';
import type { AccountSummary } from '../src/shared/ipc';

/**
 * **Which account a clicked notification opens.**
 *
 * The main process is the only sender and it pushes an id it already holds, so
 * this is not the last line of defence. It is still a lookup rather than a
 * trust: an id that is not in the list the renderer already has navigates
 * nowhere, and that costs nothing to guarantee.
 */

function account(steamId64: string): AccountSummary {
	return {
		steamId64,
		accountName: `acct-${steamId64.slice(-1)}`,
		status: 'active',
		hasRevocationCode: true,
		hasProxy: false,
		routing: 'off',
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: { enabled: true, detail: 'full' }
		}
	};
}

const first = account('76561198000000001');
const second = account('76561198000000002');

describe('the account a notification click opens', () => {
	it('finds the one it names', () => {
		expect(confirmationsTargetFor([first, second], second.steamId64)).toBe(second);
	});

	it('ignores an id the renderer does not have', () => {
		expect(
			confirmationsTargetFor([first, second], '76561198000000009'),
			'a click navigated to an account this window does not know about'
		).toBeUndefined();
	});

	it('ignores anything at all when there are no accounts', () => {
		expect(confirmationsTargetFor([], first.steamId64)).toBeUndefined();
	});

	/*
	 * Exact match, not a prefix or a substring. SteamIDs are 17 digits and
	 * neighbouring accounts differ in the last one.
	 */
	it('does not match a partial id', () => {
		expect(confirmationsTargetFor([first], '7656119800000000')).toBeUndefined();
		expect(confirmationsTargetFor([first], `${first.steamId64}0`)).toBeUndefined();
	});

	it('does not match an empty id', () => {
		expect(confirmationsTargetFor([first, second], '')).toBeUndefined();
	});
});
