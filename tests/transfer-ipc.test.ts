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

function harness(options: { unlocked?: boolean; authenticate?: unknown } = {}): {
	transfer: { cancel: ReturnType<typeof vi.fn>; authenticate: ReturnType<typeof vi.fn> };
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
		current: vi.fn(() => ({ steamId64: STEAM_ID, accountName: 'someone' }))
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
