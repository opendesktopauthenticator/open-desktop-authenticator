import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/channels';
import type { Account } from '../src/shared/vault-schema';

/*
 * Exporting an account that vanished while the save dialog was open.
 *
 * The account was copied out of the vault *before* the dialog, and a save
 * dialog sits open for as long as the user browses. Re-checking only the lock
 * left the stale copy: an account removed during the dialog was still written
 * out — plaintext secrets, for an account the user had just chosen to be rid
 * of. The handler re-reads the vault after the dialog and refuses.
 */

const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();

/**
 * When set, `writeFile` to exactly this path empties the real file and throws —
 * the observable shape of a write that failed after truncation. The fix writes
 * to a temp name and renames, so the destination itself is never opened for
 * writing and the sabotage never fires against it.
 */
let sabotageWriteTo: string | undefined;

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		writeFile: async (
			path: Parameters<typeof actual.writeFile>[0],
			data: Parameters<typeof actual.writeFile>[1],
			options?: Parameters<typeof actual.writeFile>[2]
		) => {
			if (sabotageWriteTo !== undefined && typeof path === 'string' && path === sabotageWriteTo) {
				const { writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
				writeFileSync(sabotageWriteTo, '');
				throw new Error('ENOSPC: disk full');
			}
			return actual.writeFile(path, data, options);
		}
	};
});

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string) => handlers.delete(channel)
	},
	dialog: {},
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { VaultService } from '../src/main/vault/service';

const EVENT = { senderFrame: { url: 'app://renderer' } };

const account: Account = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	sharedSecret: 'c2hhcmVk',
	identitySecret: 'aWRlbnRpdHk=',
	status: 'active',
	addedAt: '2026-08-08T00:00:00.000Z',
	autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'export-stale-'));
	handlers.clear();
	sabotageWriteTo = undefined;
	__resetRouterForTests();
	setTrustedSender(() => true);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('accountExport after the dialog', () => {
	it('refuses when the account was removed while the dialog was open', async () => {
		const accounts: Account[] = [account];
		const destination = join(dir, 'out.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [...accounts] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			// The removal lands while the dialog is open — modelled by emptying the
			// vault inside the dialog itself.
			show: () => {
				accounts.length = 0;
				return Promise.resolve(destination);
			}
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).rejects.toThrow(
			/no longer in this vault/
		);
		expect(existsSync(destination)).toBe(false);
	});

	it('still exports normally when the account is present', async () => {
		const destination = join(dir, 'out.maFile');
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;

		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});

		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		await expect(handler(EVENT, { steamId64: account.steamId64 })).resolves.toMatchObject({
			state: 'saved'
		});
		expect(existsSync(destination)).toBe(true);
	});
});

/*
 * A failed re-export must leave the previous maFile as it was.
 *
 * Writing straight to the destination opens it for truncation before a byte
 * lands, so a write that then failed — disk full, drive unplugged — had
 * already emptied the file it was replacing. Re-exporting over an existing
 * backup is the ordinary case; the export goes to a temp name and is renamed
 * into place, like every other secret-bearing write in the application.
 */
describe('a failing export over an existing file', () => {
	it('leaves the previous export intact', async () => {
		const destination = join(dir, 'out.maFile');
		const previous = '{"the previous, perfectly good backup": true}';
		writeFileSync(destination, previous);
		sabotageWriteTo = destination;

		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: [account] })
		} as unknown as VaultService;
		registerEnrollmentHandlers({} as EnrollmentService, vault, {
			show: () => Promise.resolve(destination)
		});
		const handler = handlers.get(CHANNELS.accountExport);
		if (!handler) throw new Error('accountExport was not registered');

		// With the fix, the write goes to `${destination}.tmp` — the sabotage
		// never fires, the rename replaces the file whole, and the export
		// SUCCEEDS. What matters either way: the destination is never an empty
		// husk. (Reverted to a direct write, the sabotage fires: the handler
		// rejects and the previous content is gone.)
		await handler(EVENT, { steamId64: account.steamId64 }).catch(() => undefined);
		const after = readFileSync(destination, 'utf8');
		expect(after).not.toBe('');
	});
});
