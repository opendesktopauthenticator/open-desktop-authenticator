import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VaultHome } from '../src/renderer/screens/VaultHome';
import {
	accountListOperationBusy,
	claimConfirmationClick,
	finishRecoveryBackupWithRefresh,
	runRecoveryBackupAttempt
} from '../src/renderer/App';
import { notificationMayTakeOver } from '../src/shared/notification-click';
import { accountSummary, type AccountSummary } from '../src/shared/ipc';

const STEAM_ID = '76561198000000001';
const noop = (): void => undefined;

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function summary(recoveryBackup?: 'pending' | 'stale'): AccountSummary {
	return accountSummary.parse({
		steamId64: STEAM_ID,
		accountName: 'someone',
		status: 'active',
		hasRevocationCode: true,
		hasProxy: false,
		routing: 'off',
		...(recoveryBackup === undefined ? {} : { recoveryBackup }),
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 30,
			notify: { enabled: false, detail: 'full' }
		}
	});
}

function render(
	account: AccountSummary,
	state: {
		finishingRecovery?: ReadonlySet<string>;
		recoveryErrors?: ReadonlyMap<string, string>;
	} = {}
): string {
	return renderToStaticMarkup(
		<VaultHome
			accounts={[account]}
			codes={undefined}
			msUntilAutoLock={null}
			onCopyCode={() => Promise.resolve({ clipboardClearsInSeconds: 30 })}
			onBackUpRevocationCode={noop}
			onChangeRouting={noop}
			onShowConfirmations={noop}
			requireProxies={false}
			onOpenBrowser={() => Promise.resolve({ signInRequired: false })}
			onRemoveAccount={noop}
			onChangeAutoConfirm={noop}
			onImport={noop}
			onRecover={noop}
			onEnrol={noop}
			onMove={noop}
			onFinishActivation={noop}
			onFinishRecoveryBackup={noop}
			{...state}
			onExport={noop}
			onSettings={noop}
			onAbout={noop}
			onActivity={noop}
			activityUrgent={false}
			onLock={noop}
		/>
	);
}

describe('the recovery-backup action exposed to the user', () => {
	it('blocks parent navigation while either account-list disk operation is active', () => {
		expect(accountListOperationBusy(0, 1)).toBe(true);
		expect(accountListOperationBusy(1, 0)).toBe(true);
		expect(accountListOperationBusy(0, 0)).toBe(false);
	});

	it.each([
		['pending', 'not finished'],
		['stale', 'out of date']
	] as const)('keeps %s debt visible with a local-only action', (state, explanation) => {
		const html = render(summary(state));
		expect(html).toContain(`backup is ${explanation}`);
		expect(html).toContain('Steam is not contacted');
		expect(html).toContain('Finish recovery backup');
	});

	it('does not show the action when no recovery work remains', () => {
		expect(render(summary())).not.toContain('Finish recovery backup');
	});

	it('renders app-owned busy and failure state on the affected account', () => {
		const html = render(summary('pending'), {
			finishingRecovery: new Set([STEAM_ID]),
			recoveryErrors: new Map([[STEAM_ID, 'The recovery drive is unavailable.']])
		});

		expect(html).toContain('Finishing…');
		expect(html).toContain('disabled=""');
		expect(html).toContain('The recovery drive is unavailable.');
	});

	it('keeps an app-owned failure visible across an account-list remount', () => {
		const retained = new Map([[STEAM_ID, 'The recovery drive is unavailable.']]);

		expect(render(summary('pending'), { recoveryErrors: retained })).toContain(
			'The recovery drive is unavailable.'
		);
		expect(render(summary('pending'), { recoveryErrors: retained })).toContain(
			'The recovery drive is unavailable.'
		);
	});

	it('does not turn a completed backup into a failure when its follow-up refresh fails', async () => {
		const refreshErrors: string[] = [];
		await expect(
			finishRecoveryBackupWithRefresh(
				() => Promise.resolve({ ok: true as const }),
				() => Promise.reject(new Error('account list is temporarily unavailable')),
				(message) => refreshErrors.push(message)
			)
		).resolves.toEqual({ ok: true });
		expect(refreshErrors).toEqual(['account list is temporarily unavailable']);
	});

	it('still reports a real backup-publication failure and does not refresh', async () => {
		let refreshes = 0;
		const refreshErrors: string[] = [];
		await expect(
			finishRecoveryBackupWithRefresh(
				() => Promise.reject(new Error('disk is full')),
				() => {
					refreshes += 1;
					return Promise.resolve();
				},
				(message) => refreshErrors.push(message)
			)
		).rejects.toThrow('disk is full');
		expect(refreshes).toBe(0);
		expect(refreshErrors).toEqual([]);
	});

	it('retains a notification click while a failed backup settles, then preserves both results', async () => {
		const gate = deferred<{ ok: true }>();
		const inFlight = new Set<string>();
		let busy = new Set<string>();
		const errors = new Map<string, string>();
		const claims = { newestObserved: undefined, handled: undefined };
		const attempt = runRecoveryBackupAttempt({
			steamId64: STEAM_ID,
			inFlight,
			finish: () => gate.promise,
			refresh: () => Promise.resolve(),
			onRefreshError: noop,
			onBusy: (accounts) => {
				busy = new Set(accounts);
			},
			onError: (steamId64, message) => {
				if (message === undefined) errors.delete(steamId64);
				else errors.set(steamId64, message);
			},
			onStart: noop
		});
		const navigate = (): boolean =>
			notificationMayTakeOver({
				view: 'accounts',
				overlayOpen: false,
				signInOpen: false,
				accountListBusy: accountListOperationBusy(0, busy.size)
			});

		expect(claimConfirmationClick(claims, 41, navigate)).toBe(false);
		expect(claims).toEqual({ newestObserved: 41, handled: undefined });
		gate.reject(new Error('recovery drive is unavailable'));
		await expect(attempt).resolves.toBe(false);
		expect(busy.size).toBe(0);
		expect(errors.get(STEAM_ID)).toBe('recovery drive is unavailable');
		// The failed first claim was observed, not consumed. The same click can now
		// navigate while the app-owned row error remains available after remount.
		expect(claimConfirmationClick(claims, 41, navigate)).toBe(true);
		expect(errors.get(STEAM_ID)).toBe('recovery drive is unavailable');
	});

	it('publishes and refreshes before a later notification can take the screen', async () => {
		const gate = deferred<{ ok: true }>();
		const inFlight = new Set<string>();
		let busy = new Set<string>();
		let refreshes = 0;
		const errors = new Map<string, string>();
		const attempt = runRecoveryBackupAttempt({
			steamId64: STEAM_ID,
			inFlight,
			finish: () => gate.promise,
			refresh: () => {
				refreshes += 1;
				return Promise.resolve();
			},
			onRefreshError: noop,
			onBusy: (accounts) => {
				busy = new Set(accounts);
			},
			onError: (steamId64, message) => {
				if (message === undefined) errors.delete(steamId64);
				else errors.set(steamId64, message);
			},
			onStart: noop
		});

		gate.resolve({ ok: true });
		await expect(attempt).resolves.toBe(true);
		expect(refreshes).toBe(1);
		expect(busy.size).toBe(0);
		expect(errors.size).toBe(0);
		const claims = { newestObserved: undefined, handled: undefined };
		expect(
			claimConfirmationClick(claims, 42, () =>
				notificationMayTakeOver({
					view: 'accounts',
					overlayOpen: false,
					signInOpen: false,
					accountListBusy: accountListOperationBusy(0, busy.size)
				})
			)
		).toBe(true);
	});
});
