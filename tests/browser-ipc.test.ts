import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerBrowserHandlers, type BrowserAccount } from '../src/main/browser/ipc';
import type { AccountBrowsers } from '../src/main/browser/window';

/**
 * The three refusals in front of the browser window.
 *
 * Each exists because the alternative is worse than a failed click. Opening on
 * a locked vault acts without consent; opening without a saved session lands
 * the user on a Steam login page inside a window this application drew, which
 * is the exact thing every other page on the site tells them to refuse.
 */

/**
 * Handlers are captured from the mock and invoked through the router wrapper,
 * the same way `update-ipc.test.ts` does — so request validation runs here
 * exactly as it would at runtime. That matters for the last test in this file:
 * the schema is what stops a URL crossing this channel, not the handler.
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

const ACCOUNT: BrowserAccount = {
	accountName: 'demo_trader',
	refreshToken: 'eyJhbGciOiJFZERTQSJ9.refresh.signature',
	proxyUrl: 'http://10.0.0.9:8080'
};

async function invoke(request: unknown): Promise<unknown> {
	const handler = handlers.get(CHANNELS.accountOpenBrowser);
	if (!handler) {
		throw new Error('account:openBrowser was never registered');
	}
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

function deps(overrides: Partial<Parameters<typeof registerBrowserHandlers>[0]> = {}) {
	const opened: unknown[] = [];
	const browsers = {
		open: (options: unknown) => {
			opened.push(options);
			return Promise.resolve();
		}
	} as unknown as AccountBrowsers;

	const touch = vi.fn();
	const base = {
		browsers,
		account: (): BrowserAccount | undefined => ACCOUNT,
		mintToken: () => Promise.resolve('minted-access-token'),
		isUnlocked: () => true,
		touch
	};
	return { deps: { ...base, ...overrides }, opened, touch };
}

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	// These tests are about the handler, not the sender check.
	setTrustedSender(() => true);
});

describe('opening a browser for an account', () => {
	it('passes the account’s routing and a minted token through', async () => {
		const { deps: d, opened } = deps();
		registerBrowserHandlers(d);

		await invoke({ steamId64: '76561198000000001' });

		expect(opened).toEqual([
			{
				steamId64: '76561198000000001',
				accountName: 'demo_trader',
				proxyUrl: 'http://10.0.0.9:8080',
				accessToken: 'minted-access-token'
			}
		]);
	});

	it('refuses while the vault is locked', async () => {
		const { deps: d, opened } = deps({ isUnlocked: () => false });
		registerBrowserHandlers(d);

		await expect(invoke({ steamId64: '76561198000000001' })).rejects.toThrow(/unlock/i);
		expect(opened, 'a window was opened for a locked vault').toHaveLength(0);
	});

	it('refuses an account this vault does not have', async () => {
		const { deps: d, opened } = deps({ account: () => undefined });
		registerBrowserHandlers(d);

		await expect(invoke({ steamId64: '76561198000000009' })).rejects.toThrow(/not in this vault/i);
		expect(opened).toHaveLength(0);
	});

	/*
	 * The refusal that matters most.
	 *
	 * Without a session the window lands on Steam's login page, and a user typing
	 * their Steam password into a window this application opened is precisely the
	 * behaviour the rest of the site warns against. So the error says "sign in",
	 * which is a different instruction from "try again".
	 */
	it('refuses when the account has no saved session, and says so', async () => {
		const { deps: d, opened } = deps({ account: () => ({ accountName: 'demo_trader' }) });
		registerBrowserHandlers(d);

		await expect(invoke({ steamId64: '76561198000000001' })).rejects.toThrow(/sign in/i);
		expect(opened).toHaveLength(0);
	});

	it('does not extend the auto-lock when the request failed', async () => {
		const { deps: d, touch } = deps({ isUnlocked: () => false });
		registerBrowserHandlers(d);

		await expect(invoke({ steamId64: '76561198000000001' })).rejects.toThrow();
		expect(touch).not.toHaveBeenCalled();
	});

	it('treats a successful open as activity', async () => {
		const { deps: d, touch } = deps();
		registerBrowserHandlers(d);
		await invoke({ steamId64: '76561198000000001' });
		expect(touch).toHaveBeenCalledOnce();
	});

	/*
	 * The renderer cannot choose the destination. A URL on this channel would aim
	 * a signed-in Steam session at whatever reached the renderer, so the schema is
	 * `.strict()` and carries one field — and this test runs through the router
	 * wrapper so the schema is what refuses it, not the handler.
	 */
	it('rejects any field beyond the account id', async () => {
		const { deps: d, opened } = deps();
		registerBrowserHandlers(d);

		await expect(
			invoke({ steamId64: '76561198000000001', url: 'https://not-steam.example/login' })
		).rejects.toThrow();
		expect(opened).toHaveLength(0);
	});
});
