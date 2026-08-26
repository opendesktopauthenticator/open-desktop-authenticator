import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerBrowserHandlers, type BrowserAccount } from '../src/main/browser/ipc';
import { BrowserSignInRequired, type AccountBrowsers } from '../src/main/browser/window';
import { AccessTokenError } from '../src/main/steam/access-token';

/**
 * What stands in front of the browser window, and what comes back instead.
 *
 * Two of these are refusals, because the alternative is worse than a failed
 * click: opening on a locked vault acts without consent, and opening for an
 * account this vault does not hold is a request nothing asked for.
 *
 * The third is **not** a refusal, and the difference is the point of half this
 * file. "You need to sign in" is a step the user can take, so it comes back as
 * a state the screen can act on rather than as a throw the screen can only
 * print — the same shape confirmations already use. Three unrelated causes land
 * on it, because they are one answer to the person reading it.
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

function deps(
	overrides: Partial<Parameters<typeof registerBrowserHandlers>[0]> = {},
	openFails?: Error
) {
	const opened: unknown[] = [];
	const browsers = {
		open: (options: unknown) => {
			if (openFails) {
				return Promise.reject(openFails);
			}
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
	 * The case that matters most, and the one that must not be a throw.
	 *
	 * Without a session the window would land on Steam's login page, and a user
	 * typing their Steam password into a window this application opened is
	 * precisely the behaviour the rest of the site warns against. So no window
	 * opens — but the answer is a state, because the fix is one step away and the
	 * screen can offer it. Thrown, the renderer could only print a sentence about
	 * a sign-in it had no way to start.
	 */
	it('reports a missing session as a state, not an error', async () => {
		const { deps: d, opened } = deps({ account: () => ({ accountName: 'demo_trader' }) });
		registerBrowserHandlers(d);

		const result = await invoke({ steamId64: '76561198000000001' });

		expect(result).toMatchObject({ signInRequired: true });
		expect((result as { reason: string }).reason).toMatch(/demo_trader/);
		expect(opened, 'a window was opened without a session').toHaveLength(0);
	});

	/*
	 * The same answer for a different cause. A refresh token Steam has finished
	 * with is common after months away, and to the person reading it it is
	 * indistinguishable from never having signed in — so it must not arrive as a
	 * raw error about a token.
	 */
	it('reports an expired refresh token the same way', async () => {
		const { deps: d, opened } = deps({
			mintToken: () => Promise.reject(new AccessTokenError('that session has expired', true))
		});
		registerBrowserHandlers(d);

		expect(await invoke({ steamId64: '76561198000000001' })).toMatchObject({
			signInRequired: true,
			reason: 'that session has expired'
		});
		expect(opened).toHaveLength(0);
	});

	/*
	 * And **not** for causes a sign-in cannot fix. A proxy that is down would
	 * otherwise send the user to type their Steam password, which fixes nothing
	 * and costs them the one secret this application is built to keep away from
	 * windows it drew.
	 */
	it('does not blame the user’s session for a failure that is not theirs', async () => {
		const { deps: d } = deps({
			mintToken: () => Promise.reject(new AccessTokenError('ERR_PROXY_CONNECTION_FAILED'))
		});
		registerBrowserHandlers(d);

		await expect(invoke({ steamId64: '76561198000000001' })).rejects.toThrow(/PROXY/);
	});

	/*
	 * The third cause, and the only one that can be known after the window is
	 * already up: Steam declined the cookie. `window.ts` has closed it and wiped
	 * the session by the time this runs; what is left is to say the useful thing.
	 */
	it('reports a session Steam declined as the same state', async () => {
		const { deps: d, touch } = deps(
			{},
			new BrowserSignInRequired('Steam did not accept the saved session for demo_trader.')
		);
		registerBrowserHandlers(d);

		expect(await invoke({ steamId64: '76561198000000001' })).toMatchObject({
			signInRequired: true
		});
		// Nothing opened, so nothing here was the user being present.
		expect(
			touch,
			'the auto-lock was extended by a window that never opened'
		).not.toHaveBeenCalled();
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
		expect(await invoke({ steamId64: '76561198000000001' })).toMatchObject({
			signInRequired: false
		});
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
