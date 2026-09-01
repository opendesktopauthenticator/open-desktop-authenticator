import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS, type BrowserRoute } from '../src/shared/ipc';
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
	/** Which generation each open was told it belonged to. */
	const generations: number[] = [];
	/** And which routing epoch, which is the per-account half of the same idea. */
	const epochs: number[] = [];
	let generation = 0;
	let epoch = 0;
	const browsers = {
		// Read before the token is minted, so a lock during that round trip is
		// caught by the same counter as a lock during the open itself.
		generationNow: () => generation,
		// The same, per account: a proxy change or a removal during the mint.
		epochNow: () => epoch,
		open: (options: unknown, since?: number, sinceEpoch?: number) => {
			if (openFails) {
				return Promise.reject(openFails);
			}
			generations.push(since ?? -1);
			epochs.push(sinceEpoch ?? -1);
			opened.push(options);
			return Promise.resolve();
		}
	} as unknown as AccountBrowsers;

	const touch = vi.fn();
	/** How each mint was routed, so the route choice can be checked end to end. */
	const minted: BrowserRoute[] = [];
	const base = {
		browsers,
		account: (): BrowserAccount | undefined => ACCOUNT,
		mintToken: (_id: string, _token: string, route: BrowserRoute) => {
			minted.push(route);
			return Promise.resolve('minted-access-token');
		},
		isUnlocked: () => true,
		requireProxies: () => false,
		touch
	};
	return {
		deps: { ...base, ...overrides },
		opened,
		touch,
		minted,
		generations,
		epochs,
		/** Stand in for a routing change or a removal: what it does to the epoch. */
		changeRouting: () => {
			epoch += 1;
		},
		/** Stand in for a lock: what `closeAll` does to the counter. */
		lock: () => {
			generation += 1;
		}
	};
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

		await invoke({ steamId64: '76561198000000001', route: 'proxy' });

		expect(opened).toEqual([
			{
				steamId64: '76561198000000001',
				accountName: 'demo_trader',
				proxyUrl: 'http://10.0.0.9:8080',
				// The renderer's choice reaches the window layer intact. It says
				// whether to use the stored address, never which address to use.
				route: 'proxy',
				accessToken: 'minted-access-token'
			}
		]);
	});

	it('refuses while the vault is locked', async () => {
		const { deps: d, opened } = deps({ isUnlocked: () => false });
		registerBrowserHandlers(d);

		await expect(invoke({ steamId64: '76561198000000001', route: 'proxy' })).rejects.toThrow(
			/unlock/i
		);
		expect(opened, 'a window was opened for a locked vault').toHaveLength(0);
	});

	it('refuses an account this vault does not have', async () => {
		const { deps: d, opened } = deps({ account: () => undefined });
		registerBrowserHandlers(d);

		await expect(invoke({ steamId64: '76561198000000009', route: 'proxy' })).rejects.toThrow(
			/not in this vault/i
		);
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

		const result = await invoke({ steamId64: '76561198000000001', route: 'proxy' });

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

		expect(await invoke({ steamId64: '76561198000000001', route: 'proxy' })).toMatchObject({
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

		await expect(invoke({ steamId64: '76561198000000001', route: 'proxy' })).rejects.toThrow(
			/PROXY/
		);
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

		expect(await invoke({ steamId64: '76561198000000001', route: 'proxy' })).toMatchObject({
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

		await expect(invoke({ steamId64: '76561198000000001', route: 'proxy' })).rejects.toThrow();
		expect(touch).not.toHaveBeenCalled();
	});

	it('treats a successful open as activity', async () => {
		const { deps: d, touch } = deps();
		registerBrowserHandlers(d);
		expect(await invoke({ steamId64: '76561198000000001', route: 'proxy' })).toMatchObject({
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
			invoke({
				steamId64: '76561198000000001',
				route: 'proxy',
				url: 'https://not-steam.example/login'
			})
		).rejects.toThrow();
		expect(opened).toHaveLength(0);
	});
});

/*
 * **The lock check answered a question that had since changed.**
 *
 * `isUnlocked()` at the top of the handler is a fact about the moment the
 * button was pressed. Minting a Steam token is a round trip with a
 * thirty-second timeout behind it, and the idle timer, a suspend or a closing
 * lid all fit comfortably inside one — so a browser signed in to a Steam
 * account opened for a vault that had locked while it waited.
 */
describe('a vault that locks while the token is being minted', () => {
	it('does not open a browser afterwards', async () => {
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let unlocked = true;

		const harness = deps({
			isUnlocked: () => unlocked,
			mintToken: async () => {
				await held;
				return 'minted-access-token';
			}
		});
		registerBrowserHandlers(harness.deps);

		const request = invoke({ steamId64: '76561198000000001', route: 'proxy' });
		// The lock lands while the mint is in the air.
		unlocked = false;
		harness.lock();
		release?.();

		await expect(request).rejects.toThrow(/unlock the vault/i);
		expect(harness.opened, 'a browser opened for a locked vault').toHaveLength(0);
	});

	/*
	 * And the counter travels with the request, so a lock landing *after* the
	 * handler's own re-check is still caught — by `AccountBrowsers`, which reads
	 * the same one after every await inside the open.
	 */
	it('hands the open the generation the request began in', async () => {
		const harness = deps();
		registerBrowserHandlers(harness.deps);

		await invoke({ steamId64: '76561198000000001', route: 'proxy' });

		expect(harness.generations, 'the open was not told when the request began').toEqual([0]);
	});
});

/*
 * **Direct has to mean direct all the way through.**
 *
 * The choice reached the browser window and stopped there: the token was always
 * minted through the account's stored proxy. That broke the feature in both
 * directions. Picking Direct because the proxy is rate-limited or dead still
 * failed at the token, so the fallback could not fall back and the window
 * simply never opened. And with a working proxy, the token arrived over the
 * proxy while the browser it unlocked went out directly — two addresses for one
 * sign-in, the exact correlation routing exists to prevent.
 */
describe('the routing choice and the token', () => {
	it('mints through the proxy when the proxy was chosen', async () => {
		const harness = deps();
		registerBrowserHandlers(harness.deps);

		await invoke({ steamId64: '76561198000000001', route: 'proxy' });

		expect(harness.minted).toEqual(['proxy']);
	});

	it('mints directly when Direct was chosen', async () => {
		const harness = deps();
		registerBrowserHandlers(harness.deps);

		await invoke({ steamId64: '76561198000000001', route: 'direct' });

		expect(harness.minted, 'Direct still minted through the proxy it was avoiding').toEqual([
			'direct'
		]);
	});

	it('sends the same choice to the window it sent to the token', async () => {
		const harness = deps();
		registerBrowserHandlers(harness.deps);

		await invoke({ steamId64: '76561198000000001', route: 'direct' });

		expect(harness.minted[0]).toBe('direct');
		expect(harness.opened[0]).toMatchObject({ route: 'direct' });
	});
});

/*
 * **The wiring, which the fakes above cannot see.**
 *
 * Everything else in this file proves the handler passes `useProxy` down. What
 * it cannot prove is that the application then *does* anything different with
 * it — `mintToken` is injected, and the injected one is in `index.ts`. That is
 * where the bug actually lived: the choice arrived and the token was minted
 * through the account's proxy regardless, so Direct could not get past a proxy
 * that was down and a working one issued the cookie to one address for a window
 * that spent it from another.
 */
describe('how the application mints the token behind the window', () => {
	const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
	const mint = MAIN.slice(MAIN.indexOf('mintToken: async (steamId64, refreshToken, route)'));
	const body = mint.slice(0, mint.indexOf('isUnlocked:'));

	it('reads the choice at all', () => {
		expect(body).toContain('route');
	});

	it('uses a factory of its own when Direct was chosen', () => {
		expect(body).toContain('directTransports.forAccount');
		// And the account's own factory for the routed cases, or the choice
		// changes nothing.
		expect(body).toContain('transports.forAccount({ steamId64, proxyUrl: stored })');
	});

	/*
	 * **Direct is the exception, not "not fully proxied".**
	 *
	 * There are three routes and only one of them skips the proxy, so the test
	 * that matters here is which way the condition is written. `route ===
	 * 'proxy' ? transports : directTransports` typechecks, reads naturally, and
	 * mints the Steam-only window's token from this machine's own address —
	 * handing Steam the real address in the login call while every request the
	 * window then makes goes through the proxy, so nothing on screen is wrong.
	 */
	it('mints through the proxy for Steam-only, not around it', () => {
		expect(body).toContain("route === 'direct'");
		expect(body, 'only the fully proxied route was minting through the proxy').not.toMatch(
			/route === 'proxy'\s*\?/
		);
	});

	/*
	 * A separate factory rather than an unrouted call into the account's.
	 * Electron returns the same session object for the same partition name, so
	 * sharing one would reconfigure the account's own session and every later
	 * confirmation would be refused by `assertRouted` — correctly, and for no
	 * reason the user could see.
	 */
	it('gives that factory its own partition prefix', () => {
		expect(MAIN).toContain("'steam-direct-'");
		expect(MAIN).toContain('const directTransports = new SteamTransportFactory(');
	});

	it('sweeps it wherever the account transport is swept', () => {
		expect(MAIN).toContain('directTransports.forget(steamId64)');
		expect(MAIN).toContain('directTransports.forgetAll()');
	});
});

/**
 * **`Require proxies`, which was a field in a schema and nothing else.**
 *
 * It shipped as a setting the vault stored, the docblock described in detail,
 * and no code read. A vault carrying `requireProxies: true` offered the Direct
 * button, opened unrouted windows, and checked for updates over the machine's
 * own connection — the three things the setting exists to stop. Nothing failed,
 * because nothing was asked.
 */
describe('a vault that requires proxies', () => {
	function ask(route: BrowserRoute, overrides: Record<string, unknown> = {}) {
		const harness = deps({ requireProxies: () => true, ...overrides });
		registerBrowserHandlers(harness.deps);
		return { harness, run: () => invoke({ steamId64: '76561198000000001', route }) };
	}

	it('refuses to open a window that would not use one', async () => {
		const { run } = ask('direct');
		await expect(run()).rejects.toThrow(/require proxies/i);
	});

	/**
	 * **Before the token, not after.**
	 *
	 * `mintToken` on a direct route reaches Steam over this machine's own
	 * network. A guard that ran after it would let the request the setting
	 * exists to prevent happen first, and then report it — the refusal would be
	 * a message about a leak that had already occurred.
	 */
	it('refuses before anything is minted', async () => {
		const { harness, run } = ask('direct');
		await expect(run()).rejects.toThrow();
		expect(harness.minted, 'a token was minted over the route being refused').toEqual([]);
	});

	it('still opens the routed window', async () => {
		const { harness, run } = ask('proxy');
		await expect(run()).resolves.toMatchObject({ signInRequired: false });
		expect(harness.opened[0]).toMatchObject({ route: 'proxy' });
	});

	/**
	 * **Steam-only is refused, and this test used to require the opposite.**
	 *
	 * The reasoning it encoded was that "Steam only" is a routed choice, because
	 * Steam always goes through the proxy. That is true and it is not what the
	 * setting says. The mode sends a short list of third-party sites straight out
	 * from this machine — a deliberate direct request, made by the route, which
	 * is the thing being forbidden. Reading the switch as "Steam is routed"
	 * rather than "everything is routed" quietly narrows it to something its own
	 * description does not claim.
	 */
	it('refuses Steam-only, which sends some sites out directly', async () => {
		const { harness, run } = ask('steam-only');
		await expect(run()).rejects.toThrow(/require proxies/i);
		expect(harness.opened, 'a partially direct window was opened').toEqual([]);
	});

	it('refuses it before minting, like the direct route', async () => {
		const { harness, run } = ask('steam-only');
		await expect(run()).rejects.toThrow();
		expect(harness.minted).toEqual([]);
	});

	/*
	 * An account with no proxy has no route at all under this setting. Opening
	 * it "as best we can" is the quiet fallback the setting rules out, so it is
	 * refused — and the message names both ways out, because a dead end on the
	 * account list with no explanation is how a user concludes the app is
	 * broken.
	 */
	it.each([['proxy' as const], ['steam-only' as const], ['direct' as const]])(
		'refuses an account with no proxy, even when %s was pressed',
		async (route) => {
			// One `ask` per case: the router refuses a second registration on the
			// same channel, so a loop inside one test would fail on its own
			// scaffolding rather than on the behaviour.
			const { run } = ask(route, {
				account: () => ({ accountName: 'demo', refreshToken: 'refresh' })
			});
			await expect(run()).rejects.toThrow(/require proxies/i);
		}
	);

	it('says how to get out of it', async () => {
		const { run } = ask('direct');
		await expect(run()).rejects.toThrow(/Settings/);
		// Names the button that does work, rather than only what does not.
		await expect(run()).rejects.toThrow(/routed button/i);
	});

	/**
	 * **The policy is read again after the token is minted.**
	 *
	 * The check before the mint is a fact about the moment the button was
	 * pressed. Minting is a Steam round trip with a thirty-second timeout behind
	 * it, and the switch can be turned on inside that window — after which a
	 * Direct window opened anyway, signed in, and kept making requests on a vault
	 * that by then forbade exactly that. The vault lock had always been re-read
	 * here; the policy had not.
	 */
	it('refuses a window whose policy changed while the token was minting', async () => {
		let strict = false;
		const harness = deps({
			requireProxies: () => strict,
			mintToken: () => {
				// The switch is flipped mid-flight, which is the whole scenario.
				strict = true;
				return Promise.resolve('minted-access-token');
			}
		});
		registerBrowserHandlers(harness.deps);

		await expect(invoke({ steamId64: '76561198000000001', route: 'direct' })).rejects.toThrow(
			/require proxies/i
		);
		expect(harness.opened, 'the window opened under a rule that now forbids it').toEqual([]);
	});

	it('changes nothing when it is off', async () => {
		const harness = deps({ requireProxies: () => false });
		registerBrowserHandlers(harness.deps);
		await expect(
			invoke({ steamId64: '76561198000000001', route: 'direct' })
		).resolves.toMatchObject({ signInRequired: false });
	});
});

/**
 * The update check is the other half, and it is not about any account.
 *
 * It goes to GitHub, from this machine, over whatever route the machine has —
 * no account's proxy applies to it. A vault whose owner has said "everything
 * goes through a proxy" has said something this request cannot honour, so it
 * must not run rather than running unrouted.
 */
describe('the update check under Require proxies', () => {
	const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
	const enabled = MAIN.slice(
		MAIN.indexOf('isEnabled: () =>'),
		MAIN.indexOf('isEnabled: () =>') + 400
	);

	it('is gated on the setting, not only on updateCheck', () => {
		expect(enabled).toContain('updateCheck');
		expect(enabled, 'the check runs unrouted on a vault that forbids that').toContain(
			'!vault.settings().requireProxies'
		);
	});
});

/**
 * **The account's routing epoch, captured at the press rather than read after
 * the mint.**
 *
 * The vault's global lock counter travelled with this request from the start.
 * The per-account one did not, so `open` fell back to its default — which reads
 * the epoch *now*, after Steam has answered. A proxy change or an account
 * removal during the mint bumps that epoch, and the default then compared the
 * new value with itself and agreed: a signed-in Steam window opened on routing
 * the user had just replaced, or for an account no longer in the vault.
 */
describe('a routing change while the token is being minted', () => {
	it('hands the open the epoch the request began in', async () => {
		const harness = deps({
			mintToken: () => {
				// The proxy is changed, or the account removed, mid-flight.
				harness.changeRouting();
				return Promise.resolve('minted-access-token');
			}
		});
		registerBrowserHandlers(harness.deps);

		await invoke({ steamId64: '76561198000000001', route: 'proxy' });

		expect(
			harness.epochs[0],
			'the open was told the epoch that the routing change had already moved on to'
		).toBe(0);
	});

	it('passes an epoch at all, rather than letting open read its own', async () => {
		const harness = deps();
		registerBrowserHandlers(harness.deps);

		await invoke({ steamId64: '76561198000000001', route: 'proxy' });

		// -1 is the fake's stand-in for "nothing was passed", which is the state
		// that let `open` default to a value read after the wait.
		expect(harness.epochs[0]).not.toBe(-1);
	});

	it('still hands over the generation as well', async () => {
		const harness = deps();
		registerBrowserHandlers(harness.deps);
		await invoke({ steamId64: '76561198000000001', route: 'proxy' });
		expect(harness.generations[0]).toBe(0);
	});
});

/**
 * **What the policy transition actually calls, which no fake can see.**
 *
 * The cancellations live on four different services and are wired together in
 * `index.ts`. Each has its own test proving it cancels the right work; none of
 * them can prove the transition *invokes* it, and a callback that stops calling
 * one is exactly the regression that leaves a password on the wire.
 */
describe('what enabling Require proxies tears down', () => {
	const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
	// Forward from the first statement rather than back from a later name:
	// `registerImportHandlers` is imported at the top of the file, so an
	// `indexOf` for it ends the slice before it begins.
	const start = MAIN.indexOf('void browsers.closeNotFullyRouted();');
	/*
	 * **To the end of the callback, not a fixed number of characters.**
	 *
	 * This was `start + 2500`, which silently stopped covering the tail of the
	 * handler the moment a comment was added above it — so an assertion about a
	 * line that is still there failed, and one about a line that had been deleted
	 * would have passed. A slice that measures the file rather than the block is
	 * a check whose reach depends on prose.
	 */
	const end = MAIN.indexOf('\n\t\t\t}', start);
	const callback = MAIN.slice(start, end === -1 ? start + 4000 : end);

	it('closes the windows the rule forbids', () => {
		expect(callback).toContain('browsers.closeNotFullyRouted()');
	});

	it('drops every cached transport, on both factories', () => {
		expect(callback).toContain('transports.forgetAll()');
		expect(callback).toContain('directTransports.forgetAll()');
	});

	/*
	 * The three that never build a transport, so nothing above reaches them:
	 * `steam-session` speaks over Node's own stack.
	 */
	/*
	 * The aborts above reach the engine as ordinary errors, so the polls they
	 * kill have to be disowned or the user's own settings save is scored against
	 * the accounts the setting exists to protect.
	 */
	it('disowns the polls those aborts are about to fail', () => {
		expect(
			callback,
			'turning the rule on logged a failure against every correctly-routed account'
		).toContain('autoConfirm.forgetAccount(account.steamId64)');
	});

	it('cancels the sign-ins that no transport covers', () => {
		expect(callback).toContain('confirmations.cancelUnroutedSignIns()');
		expect(callback).toContain('enrollment.forgetUnrouted()');
		expect(callback, 'a transfer authentication kept sending a password').toContain(
			'transfer.cancelUnroutedAuthentication()'
		);
	});

	it('aborts the update request rather than discarding its answer', () => {
		expect(callback).toContain('updatePolicyAbort.abort()');
		// Replaced, or every later check is refused for the life of the process.
		expect(callback).toContain('new AbortController()');
		/*
		 * And the generation moves. Aborting alone left the request on the wire:
		 * a caller arriving after the policy was turned back off joined it, and
		 * the abort was then cached as an ordinary failure for six hours.
		 */
		expect(callback, 'the aborted attempt can still be joined and cached').toContain(
			'updatePolicyGeneration += 1'
		);
	});
});

/**
 * **What a failed mint is still allowed to answer.**
 *
 * `mintToken` is a Steam round trip with a thirty-second timeout behind it, and
 * inside that window the vault can lock, `Require proxies` can be switched on,
 * the account's routing can change, and the account itself can be removed. Every
 * one of those was re-checked after the mint — on the success path. The
 * `needsSignIn` branch returned above all of it.
 *
 * `signInRequired` is not an inert answer. It is what makes the renderer offer a
 * sign-in, so removing an account mid-mint produced an offer to sign in to an
 * account the vault no longer held. A failure to mint is not a reason to skip the
 * questions; it is the path least likely to have been thought about.
 */
describe('a mint that fails while the world changes underneath it', () => {
	const expired = () => Promise.reject(new AccessTokenError('that session has expired', true));

	it('does not ask for a sign-in for an account that was removed', async () => {
		const harness = deps({
			mintToken: () => {
				harness.changeRouting();
				return expired();
			}
		});
		registerBrowserHandlers(harness.deps);

		await expect(
			invoke({ steamId64: '76561198000000001', route: 'proxy' }),
			'the handler offered a sign-in for an account that had gone while Steam was answering'
		).rejects.toThrow(/changed while it was opening/);
	});

	it('does not ask for a sign-in on a vault that locked during the mint', async () => {
		let unlocked = true;
		const harness = deps({
			isUnlocked: () => unlocked,
			mintToken: () => {
				unlocked = false;
				return expired();
			}
		});
		registerBrowserHandlers(harness.deps);

		await expect(invoke({ steamId64: '76561198000000001', route: 'proxy' })).rejects.toThrow(
			/unlock the vault/i
		);
	});

	it('does not ask for a sign-in once Require proxies has been switched on', async () => {
		let strict = false;
		const harness = deps({
			requireProxies: () => strict,
			mintToken: () => {
				strict = true;
				return expired();
			}
		});
		registerBrowserHandlers(harness.deps);

		await expect(invoke({ steamId64: '76561198000000001', route: 'direct' })).rejects.toThrow(
			/proxies/i
		);
	});

	/*
	 * And the answer the branch exists to give, which has to survive: an expired
	 * refresh token with nothing else wrong is still "sign in again".
	 */
	it('still asks for a sign-in when nothing else changed', async () => {
		const harness = deps({ mintToken: expired });
		registerBrowserHandlers(harness.deps);

		const result = (await invoke({
			steamId64: '76561198000000001',
			route: 'proxy'
		})) as { signInRequired: boolean };

		expect(result.signInRequired).toBe(true);
	});
});

/**
 * **And the other way out with `signInRequired` on it.**
 *
 * `open` builds a window, wipes a session and offers a cookie Steam can refuse —
 * seconds during which the vault can lock, `Require proxies` can be switched on,
 * and the account can be removed or rerouted. The mint's branch was given those
 * checks and this one was not, so a stale sign-in prompt still reached the
 * renderer for an account the vault no longer holds.
 */
describe('a sign-in that Steam demands during the open itself', () => {
	const refused = () => Promise.reject(new BrowserSignInRequired('that session has expired'));

	it('does not ask for a sign-in for an account that was removed', async () => {
		const harness = deps({}, undefined);
		registerBrowserHandlers({
			...harness.deps,
			browsers: {
				...harness.deps.browsers,
				open: () => {
					harness.changeRouting();
					return refused();
				}
			} as unknown as AccountBrowsers
		});

		await expect(
			invoke({ steamId64: '76561198000000001', route: 'proxy' }),
			'a sign-in was offered for an account that had gone while the window was opening'
		).rejects.toThrow(/changed while it was opening/);
	});

	it('does not ask for a sign-in on a vault that locked during the open', async () => {
		let unlocked = true;
		const harness = deps({ isUnlocked: () => unlocked });
		registerBrowserHandlers({
			...harness.deps,
			browsers: {
				...harness.deps.browsers,
				open: () => {
					unlocked = false;
					return refused();
				}
			} as unknown as AccountBrowsers
		});

		await expect(invoke({ steamId64: '76561198000000001', route: 'proxy' })).rejects.toThrow(
			/unlock the vault/i
		);
	});

	/* And the answer the branch exists to give, which has to survive. */
	it('still asks for a sign-in when nothing else changed', async () => {
		const harness = deps({}, new BrowserSignInRequired('that session has expired'));
		registerBrowserHandlers(harness.deps);

		const result = (await invoke({ steamId64: '76561198000000001', route: 'proxy' })) as {
			signInRequired: boolean;
		};
		expect(result.signInRequired).toBe(true);
	});
});
