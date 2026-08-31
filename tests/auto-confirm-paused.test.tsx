import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoConfirm } from '../src/renderer/screens/AutoConfirm';
import { describeAutoConfirm } from '../src/renderer/screens/VaultHome';
import type { AccountSummary } from '../src/shared/ipc';

/**
 * **An account the poller has quietly stopped checking.**
 *
 * `Require proxies` is global, and `dueAccounts` skips an account with no proxy
 * under it. That silence is deliberate on the engine's side: routing the skip
 * through `onFailure` would spend the ten-strike halt on a policy refusal
 * rather than a fault, and the sweep runs every second, so it must not be
 * reported per beat either.
 *
 * But nothing anywhere else said so. The switch stayed on, the account row went
 * on reading "auto-confirm: trades, notifying", and the account had not been
 * checked since the setting was saved — an account its owner believes is
 * approving trades unattended and which is doing nothing at all.
 *
 * The global flip is the worse trigger. Turning the setting on strands **every**
 * unproxied account at once, with no screen changing and no activity entry, so
 * there is no moment at which anybody is told.
 */

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
	return {
		steamId64: '76561198000000001',
		accountName: 'trader',
		status: 'active',
		hasRevocationCode: true,
		hasProxy: false,
		routing: 'off',
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 15,
			notify: { enabled: false, detail: 'full' }
		},
		...overrides
	};
}

const ENABLED = [
	['approving trades', { trades: true, marketListings: false, notify: false }],
	['approving market listings', { trades: false, marketListings: true, notify: false }],
	['approving both', { trades: true, marketListings: true, notify: false }],
	['only watching', { trades: false, marketListings: false, notify: true }],
	['both and watching', { trades: true, marketListings: true, notify: true }]
] as const;

describe('what the account row says when the poller has stopped', () => {
	/*
	 * **Instead of the rest, not appended to it.** "auto-confirm: trades,
	 * notifying · paused" opens with a description of work that is not
	 * happening, and the first half is what gets read.
	 */
	it.each(ENABLED)('says it is paused for an account %s', (_what, shape) => {
		const said = describeAutoConfirm(
			{
				marketListings: shape.marketListings,
				trades: shape.trades,
				pollIntervalSeconds: 15,
				notify: { enabled: shape.notify, detail: 'full' }
			},
			true
		);

		expect(said, 'the row claims work that is not happening').toBe('paused — no proxy');
	});

	/*
	 * Nothing is switched on, so nothing is paused. Saying "paused" here would
	 * invent a problem out of an account whose owner has asked for nothing.
	 */
	it('says nothing about pausing when nothing was enabled', () => {
		expect(
			describeAutoConfirm(
				{
					marketListings: false,
					trades: false,
					pollIntervalSeconds: 15,
					notify: { enabled: false, detail: 'full' }
				},
				true
			)
		).toBe('auto-confirm: off');
	});

	it('is unchanged for an account that is actually being polled', () => {
		expect(
			describeAutoConfirm(
				{
					marketListings: true,
					trades: true,
					pollIntervalSeconds: 15,
					notify: { enabled: true, detail: 'full' }
				},
				false
			)
		).toBe('auto-confirm: trades + market, notifying');
	});
});

/**
 * And on the screen the switches live on, which is where somebody goes to work
 * out why nothing is happening.
 */
describe('the auto-confirm screen for a stranded account', () => {
	const render = (options: { requireProxies: boolean; hasProxy: boolean }): string =>
		renderToStaticMarkup(
			<AutoConfirm
				account={account({
					hasProxy: options.hasProxy,
					autoConfirm: {
						marketListings: false,
						trades: true,
						pollIntervalSeconds: 15,
						notify: { enabled: true, detail: 'full' }
					}
				})}
				accounts={[]}
				requireProxies={options.requireProxies}
				onSave={() => Promise.resolve()}
				onClose={() => undefined}
			/>
		);

	it('says the switches are doing nothing', () => {
		const html = render({ requireProxies: true, hasProxy: false });
		expect(html, 'the screen shows live switches for an account nothing is polling').toContain(
			'Paused'
		);
		expect(html, 'it does not say why').toMatch(/no proxy/i);
	});

	/*
	 * And names both ways out. This screen owns neither setting, so pointing at
	 * them is the most it can do — and a warning with no remedy on it is how a
	 * person concludes the application is broken.
	 */
	it('names both ways out of it', () => {
		const html = render({ requireProxies: true, hasProxy: false });
		expect(html, 'nothing points at the per-account fix').toMatch(/Routing/);
		expect(html, 'nothing points at the global setting').toMatch(/Require proxies/i);
	});

	it('says nothing when the account has a proxy', () => {
		expect(render({ requireProxies: true, hasProxy: true })).not.toContain('Paused');
	});

	it('says nothing when the rule is off', () => {
		expect(render({ requireProxies: false, hasProxy: false })).not.toContain('Paused');
	});
});

/**
 * **A machine that cannot show a notification, and a switch that says nothing.**
 *
 * A notify-only account — notifications on, both approve switches off — is
 * reported by a toast and by nothing else: a successful poll of that kind
 * writes no activity entry, only the confirm arm does. So on a machine with no
 * notification service, a held account-recovery confirmation produced no toast,
 * no record and no retry. It vanished, and the screen offering the switch said
 * nothing about it.
 *
 * The switch is still offered — the machine may gain a service, and the account
 * may later approve as well — but not silently.
 */
describe('the auto-confirm screen where notifications cannot be shown', () => {
	const render = (notificationsAvailable: boolean | undefined): string =>
		renderToStaticMarkup(
			<AutoConfirm
				account={account({
					autoConfirm: {
						marketListings: false,
						trades: false,
						pollIntervalSeconds: 15,
						notify: { enabled: true, detail: 'full' }
					}
				})}
				accounts={[]}
				requireProxies={false}
				notificationsAvailable={notificationsAvailable}
				onSave={() => Promise.resolve()}
				onClose={() => undefined}
			/>
		);

	it('says so, rather than offering the switch silently', () => {
		const html = render(false);
		expect(
			html,
			'the screen offers notifications on a machine that cannot show one, and says nothing'
		).toMatch(/cannot show desktop notifications/i);
	});

	/* And names the way out, because a warning with no remedy reads as breakage. */
	it('says what to switch on instead', () => {
		expect(render(false)).toMatch(/Activity/);
	});

	it('says nothing where notifications work', () => {
		expect(render(true)).not.toMatch(/cannot show desktop notifications/i);
	});

	/*
	 * And nothing before app info has answered: `undefined` is "not asked yet",
	 * and warning about a machine nobody has enquired about is worse than silence.
	 */
	it('says nothing before it has been told', () => {
		expect(render(undefined)).not.toMatch(/cannot show desktop notifications/i);
	});
});
