import { describe, expect, it } from 'vitest';
import {
	claimRecoveryForeground,
	deliverRecoveryAttention,
	supersedeRecoveryForeground,
	type ForegroundRevision
} from '../src/renderer/recovery-navigation';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('recovery status settling around deliberate navigation', () => {
	it('takes over when recovery settles before the user leaves the untouched account home', async () => {
		const revision: ForegroundRevision = { current: 0 };
		const answer = deferred<void>();
		const claim = claimRecoveryForeground(revision);
		const events: string[] = [];

		const settlement = answer.promise.then(() =>
			deliverRecoveryAttention(
				revision,
				claim,
				true,
				() => events.push('opened recovery'),
				() => events.push('deferred recovery')
			)
		);
		answer.resolve();
		await settlement;

		expect(events).toEqual(['opened recovery']);
	});

	it('preserves typed state and defers recovery when navigation wins the race', async () => {
		const revision: ForegroundRevision = { current: 10 };
		const answer = deferred<void>();
		const claim = claimRecoveryForeground(revision);
		let typed = 'a passphrase already being entered';
		const events: string[] = [];

		const settlement = answer.promise.then(() =>
			deliverRecoveryAttention(
				revision,
				claim,
				false,
				() => {
					typed = '';
					events.push('opened recovery');
				},
				() => events.push('deferred recovery')
			)
		);

		supersedeRecoveryForeground(revision);
		answer.resolve();
		await settlement;

		expect(typed).toBe('a passphrase already being entered');
		expect(events).toEqual(['deferred recovery']);
	});

	it('defers when account home no longer owns the foreground even at the same revision', () => {
		const revision: ForegroundRevision = { current: 14 };
		const claim = claimRecoveryForeground(revision);
		let typed = 'the account overlay owns this passphrase';
		const events: string[] = [];

		// No supersede call here on purpose: this isolates the ownership conjunct.
		// Removing `accountHomeOwnsForeground` from the production condition must
		// fail even though the revision still equals the claim.
		deliverRecoveryAttention(
			revision,
			claim,
			false,
			() => {
				typed = '';
				events.push('opened recovery');
			},
			() => events.push('deferred recovery')
		);

		expect(revision.current).toBe(claim);
		expect(typed).toBe('the account overlay owns this passphrase');
		expect(events).toEqual(['deferred recovery']);
	});

	it('keeps an export mounted and its result renderable when recovery settles second', async () => {
		const revision: ForegroundRevision = { current: 20 };
		const recoveryAnswer = deferred<void>();
		const exportAnswer = deferred<string>();
		const recoveryClaim = claimRecoveryForeground(revision);
		let accountHomeOwnsForeground = true;
		let view: 'accounts' | 'enroll' = 'accounts';
		let visibleExportResult: string | undefined;
		const events: string[] = [];

		const recoverySettlement = recoveryAnswer.promise.then(() =>
			deliverRecoveryAttention(
				revision,
				recoveryClaim,
				accountHomeOwnsForeground,
				() => {
					view = 'enroll';
					events.push('opened recovery');
				},
				() => events.push('deferred recovery')
			)
		);

		// This is the synchronous part of App's Export handler. It happens before
		// the native dialog/write promise is created, so a status reply cannot slip
		// between the user's click and revocation of the old foreground claim.
		accountHomeOwnsForeground = false;
		supersedeRecoveryForeground(revision);
		const exportSettlement = exportAnswer.promise.then((result) => {
			if (view === 'accounts') visibleExportResult = result;
		});

		recoveryAnswer.resolve();
		await recoverySettlement;
		expect(view).toBe('accounts');
		expect(events).toEqual(['deferred recovery']);

		exportAnswer.resolve('Saved as account.maFile.');
		await exportSettlement;
		expect(visibleExportResult).toBe('Saved as account.maFile.');
	});

	it('does not let an answer from an older unlock claim a later account home', () => {
		const revision: ForegroundRevision = { current: 4 };
		const oldClaim = claimRecoveryForeground(revision);
		supersedeRecoveryForeground(revision);
		const newClaim = claimRecoveryForeground(revision);
		const events: string[] = [];

		deliverRecoveryAttention(
			revision,
			oldClaim,
			true,
			() => events.push('old opened'),
			() => events.push('old deferred')
		);
		deliverRecoveryAttention(
			revision,
			newClaim,
			true,
			() => events.push('new opened'),
			() => events.push('new deferred')
		);

		expect(events).toEqual(['old deferred', 'new opened']);
	});
});
