import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../src/main/confirmations/activity';
import { registerConfirmationHandlers } from '../src/main/confirmations/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { CHANNELS } from '../src/shared/channels';
import type { ConfirmationsService } from '../src/main/confirmations/service';
import type { VaultService } from '../src/main/vault/service';
import { registerTransferHandlers } from '../src/main/steam/transfer-ipc';
import type { TransferService } from '../src/main/steam/transfer';

/**
 * What the activity log is willing to say while the vault is locked.
 *
 * The log deliberately survives a lock — it is what answers "what happened while
 * I was away", and it is held in memory rather than written anywhere. That
 * design made it the one thing in this application readable **without the
 * passphrase**: the handlers consulted no vault state, and both are on the
 * preload bridge, so anything with a renderer could read account names and their
 * trades, or clear the alert saying an account-recovery confirmation had been
 * held back, before the owner had unlocked anything.
 *
 * The log still survives the lock. It just stops answering until somebody has
 * proved they are the owner.
 */

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	}
}));

const NOW = Date.parse('2026-08-10T12:00:00Z');
const SENDER = { senderFrame: { url: 'file:///app/index.html' } };

const recovery = {
	id: '9',
	type: 6,
	typeName: 'Account recovery',
	securityCritical: true,
	autoConfirmable: false,
	hasIcon: false
};

let activity: ActivityLog;
let unlocked: boolean;

function setup(): void {
	__resetRouterForTests();
	setTrustedSender(() => true);
	activity = new ActivityLog(() => NOW);
	unlocked = true;

	const vault = {
		isUnlocked: () => unlocked,
		touch: () => undefined
	} as unknown as VaultService;

	registerConfirmationHandlers(
		{
			list: () => Promise.resolve({ confirmations: [], unreadable: 0 })
		} as unknown as ConfirmationsService,
		vault,
		activity
	);
}

const call = async (channel: string, request: unknown = {}): Promise<unknown> => {
	const handler = handlers.get(channel);
	if (!handler) {
		throw new Error(`no handler for ${channel}`);
	}
	return handler(SENDER, request);
};

beforeEach(() => {
	setup();
});

describe('reading activity while locked', () => {
	it('answers normally while unlocked', async () => {
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);

		await expect(call(CHANNELS.activityList)).resolves.toMatchObject({ urgent: true });
	});

	it('reveals nothing once the vault is locked', async () => {
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		unlocked = false;

		// Not an error — the renderer polls this to drive a badge, and a locked
		// window has no badge to draw. An empty answer is the honest one.
		await expect(call(CHANNELS.activityList)).resolves.toEqual({
			entries: [],
			urgent: false,
			seq: 0
		});
	});

	it('does not name an account while locked', async () => {
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		unlocked = false;

		expect(JSON.stringify(await call(CHANNELS.activityList))).not.toContain('76561198000000001');
	});

	it('still has the entries once unlocked again', async () => {
		// The log surviving a lock is the feature. Refusing to *answer* while locked
		// must not become throwing the log away.
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		unlocked = false;
		await call(CHANNELS.activityList);
		unlocked = true;

		await expect(call(CHANNELS.activityList)).resolves.toMatchObject({ urgent: true });
	});
});

describe('acknowledging activity while locked', () => {
	it('refuses outright', async () => {
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		unlocked = false;

		await expect(call(CHANNELS.activityAcknowledge)).rejects.toThrow();
	});

	it('leaves the alert standing', async () => {
		// The damage this prevents. Acknowledging is quiet and irreversible: it
		// clears the marker saying somebody may be taking the account, and clearing
		// it before the owner has unlocked means they never see it.
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);
		unlocked = false;
		await call(CHANNELS.activityAcknowledge).catch(() => undefined);
		unlocked = true;

		expect(activity.hasUrgent()).toBe(true);
	});

	it('works normally once unlocked', async () => {
		activity.recordPass('76561198000000001', [], [{ confirmation: recovery, reason: 'never' }]);

		await call(CHANNELS.activityAcknowledge, { upTo: activity.watermark() });

		expect(activity.hasUrgent()).toBe(false);
	});
});

/*
 * Cancelling a transfer while locked.
 *
 * Transfer status is deliberately silent while locked. `transferCancel` had no
 * equivalent check, and cancelling clears the unanswered-submission warning — so
 * code in a locked renderer could erase the one record telling the owner to go
 * and check their phone, before they ever unlocked to see it.
 */
describe('the transfer cancel channel is gated too', () => {
	it('refuses while locked', async () => {
		const cancel = vi.fn();
		__resetRouterForTests();
		setTrustedSender(() => true);
		registerTransferHandlers(
			{ cancel } as unknown as TransferService,
			{
				isUnlocked: () => false,
				touch: () => undefined
			} as unknown as VaultService
		);

		await expect(call(CHANNELS.transferCancel)).rejects.toThrow();
		expect(cancel).not.toHaveBeenCalled();
	});

	it('works once unlocked', async () => {
		const cancel = vi.fn();
		__resetRouterForTests();
		setTrustedSender(() => true);
		registerTransferHandlers(
			{ cancel } as unknown as TransferService,
			{
				isUnlocked: () => true,
				touch: () => undefined
			} as unknown as VaultService
		);

		await call(CHANNELS.transferCancel);
		expect(cancel).toHaveBeenCalled();
	});
});
