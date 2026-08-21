import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerTransferHandlers } from '../src/main/steam/transfer-ipc';
import type { TransferService } from '../src/main/steam/transfer';
import type { VaultService } from '../src/main/vault/service';

/*
 * The IPC surface of an authenticator transfer.
 *
 * What matters here is not that the calls work — the service's own tests cover
 * that — but what is allowed to cross. By the time `authenticate` answers, the
 * main process holds a refresh token and an access token for the account. The
 * renderer must learn which account it is looking at, and nothing else.
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

const STEAM_ID = '76561198000000001';

function harness(
	options: {
		unlocked?: boolean;
		authenticate?: unknown;
		/** What the service says it is still waiting on, if anything. */
		awaiting?: 'persist' | 'unanswered' | 'unreadable';
	} = {}
): {
	transfer: {
		cancel: ReturnType<typeof vi.fn>;
		authenticate: ReturnType<typeof vi.fn>;
		awaiting: ReturnType<typeof vi.fn>;
	};
	touched: () => number;
} {
	let touches = 0;
	const authenticate =
		options.authenticate ??
		vi.fn(() =>
			Promise.resolve({ state: 'authenticated', steamId64: STEAM_ID, accountName: 'someone' })
		);
	const transfer = {
		authenticate,
		cancel: vi.fn(),
		current: vi.fn(() => ({ steamId64: STEAM_ID, accountName: 'someone' })),
		awaiting: vi.fn(() => options.awaiting)
	};
	const vault = {
		isUnlocked: () => options.unlocked !== false,
		touch: () => {
			touches += 1;
		}
	} as unknown as VaultService;

	registerTransferHandlers(transfer as unknown as TransferService, vault);
	return { transfer: transfer as never, touched: () => touches };
}

async function call(channel: string, request: unknown = {}): Promise<unknown> {
	const handler = handlers.get(channel);
	if (!handler) {
		throw new Error(`${channel} was never registered`);
	}
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

const CREDENTIALS = {
	accountName: 'someone',
	password: 'hunter2',
	steamGuardCode: 'QK4TX'
};

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);
});

describe('signing in for a transfer over IPC', () => {
	it('registers all three channels', () => {
		harness();
		expect(handlers.has(CHANNELS.transferAuthenticate)).toBe(true);
		expect(handlers.has(CHANNELS.transferStatus)).toBe(true);
		expect(handlers.has(CHANNELS.transferCancel)).toBe(true);
	});

	it('answers with the account and nothing more', async () => {
		harness();
		const answer = await call(CHANNELS.transferAuthenticate, CREDENTIALS);
		expect(answer).toEqual({
			state: 'authenticated',
			steamId64: STEAM_ID,
			accountName: 'someone'
		});
	});

	/*
	 * The service holds tokens for this account the moment this resolves. A
	 * response that grew a `refreshToken` field would be a serious regression and
	 * would still look perfectly reasonable in a diff.
	 */
	it('never lets a token cross', async () => {
		const authenticate = vi.fn(() =>
			Promise.resolve({
				state: 'authenticated',
				steamId64: STEAM_ID,
				accountName: 'someone',
				refreshToken: 'eyJhbGciOiJub25lIn0.token',
				accessToken: 'access-token'
			})
		);
		harness({ authenticate });
		const answer = await call(CHANNELS.transferAuthenticate, CREDENTIALS).catch(
			(err: unknown) => err
		);
		expect(JSON.stringify(answer)).not.toContain('token');
	});

	it('refuses when the vault is locked, before any password is spent', async () => {
		const { transfer } = harness({ unlocked: false });
		await expect(call(CHANNELS.transferAuthenticate, CREDENTIALS)).rejects.toThrow();
		expect(transfer.authenticate).not.toHaveBeenCalled();
	});

	/*
	 * A transfer waits on a text message. That pause is invisible to an idle
	 * timer, and a vault that locked through it would strand a rotation Steam had
	 * already performed.
	 */
	it('counts the sign-in as activity so the vault does not lock mid-transfer', async () => {
		const h = harness();
		await call(CHANNELS.transferAuthenticate, CREDENTIALS);
		expect(h.touched()).toBe(1);
	});
});

describe('status and cancellation', () => {
	it('reports the transfer in progress', async () => {
		harness();
		await expect(call(CHANNELS.transferStatus)).resolves.toEqual({
			transfer: { steamId64: STEAM_ID, accountName: 'someone' }
		});
	});

	it('abandons on request', async () => {
		const { transfer } = harness();
		await expect(call(CHANNELS.transferCancel)).resolves.toEqual({});
		expect(transfer.cancel).toHaveBeenCalledOnce();
	});
});

/*
 * Telling the renderer that a retry is owed.
 *
 * Every vault lock reloads the window, and the knowledge that a transfer was
 * waiting to be saved lived only in that document's React state. Steam has
 * already rotated the authenticator by then, so what the reload stranded was the
 * only copy of a replacement Steam will not issue again — held in the main
 * process, unreachable, until the process exited and took it with it.
 *
 * `awaiting` is what closes that: it names a step, carries no secret, and is the
 * one signal that survives the reload.
 */
describe('reporting an outstanding retry', () => {
	it('says nothing is owed on an ordinary pending transfer', async () => {
		const { transfer } = harness();
		await expect(call(CHANNELS.transferStatus, {})).resolves.toEqual({
			transfer: { steamId64: STEAM_ID, accountName: 'someone' }
		});
		expect(transfer.awaiting).toHaveBeenCalled();
	});

	it('reports a decoded authenticator waiting to be written', async () => {
		harness({ awaiting: 'persist' });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toMatchObject({
			awaiting: 'persist'
		});
	});

	it('reports a transfer that ended without a usable authenticator', async () => {
		harness({ awaiting: 'unreadable' });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toMatchObject({
			awaiting: 'unreadable'
		});
	});

	it('carries no secret with it', async () => {
		harness({ awaiting: 'persist' });
		const status = await call(CHANNELS.transferStatus, {});
		// It names a step. Everything else about the held secrets stays where it is.
		expect(Object.keys(status as object).sort()).toEqual(['awaiting', 'transfer']);
	});
});

/*
 * The status channel while the vault is locked.
 *
 * The lock handler deliberately keeps a transfer that is holding replacement
 * material — correct, and the reason it exists. But this channel then answered a
 * locked renderer with the account name, the SteamID and whether secrets were
 * outstanding. The activity log was gated for exactly this reason; this surface
 * is newer and was missed.
 */
describe('transfer status while locked', () => {
	it('answers normally while unlocked', async () => {
		harness({ awaiting: 'persist' });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toMatchObject({
			awaiting: 'persist'
		});
	});

	it('says nothing at all while locked', async () => {
		harness({ awaiting: 'persist', unlocked: false });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toEqual({});
	});

	it('does not name the account while locked', async () => {
		harness({ awaiting: 'unreadable', unlocked: false });
		expect(JSON.stringify(await call(CHANNELS.transferStatus, {}))).not.toContain(STEAM_ID);
	});

	it('does not ask the service anything while locked', async () => {
		// The gate is ahead of the read, so a locked renderer cannot even learn that
		// a transfer exists by timing the answer.
		const { transfer } = harness({ awaiting: 'persist', unlocked: false });
		await call(CHANNELS.transferStatus, {});
		expect(transfer.awaiting).not.toHaveBeenCalled();
	});
});
