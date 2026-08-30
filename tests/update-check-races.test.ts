import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/channels';

/*
 * The update check against time and concurrency.
 *
 * Two defects lived here. The cache was only written when a request finished,
 * so simultaneous calls — which React Strict Mode makes the ordinary case in
 * development — each contacted GitHub. And consent was checked only before the
 * network round trip, so switching the check off while one was in the air
 * still delivered `updateAvailable`, putting the banner back up after the user
 * had just watched it come down.
 */

const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string) => handlers.delete(channel)
	}
}));

import { registerUpdateHandlers } from '../src/main/update/ipc';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const RELEASE = JSON.stringify({
	tag_name: 'v9.9.9',
	html_url:
		'https://github.com/opendesktopauthenticator/open-desktop-authenticator/releases/tag/v9.9.9',
	published_at: '2026-08-20T00:00:00Z'
});

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

function invoke(): (request?: unknown) => Promise<unknown> {
	const handler = handlers.get(CHANNELS.updateCheck);
	if (!handler) throw new Error('updateCheck was not registered');
	return (request = {}) => handler(EVENT, request);
}

describe('simultaneous checks', () => {
	it('share one request instead of each contacting GitHub', async () => {
		let fetches = 0;
		let release: ((text: string) => void) | undefined;
		registerUpdateHandlers({
			isEnabled: () => true,
			isStoreBuild: () => false,
			currentVersion: '0.1.0',
			fetchText: () => {
				fetches += 1;
				return new Promise((resolve) => {
					release = resolve;
				});
			}
		});

		const call = invoke();
		const first = call();
		const second = call();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release?.(RELEASE);

		await expect(first).resolves.toMatchObject({ state: 'updateAvailable' });
		await expect(second).resolves.toMatchObject({ state: 'updateAvailable' });
		expect(fetches).toBe(1);
	});
});

describe('consent withdrawn mid-flight', () => {
	it('answers disabled, not the result the request brought back', async () => {
		let enabled = true;
		let release: ((text: string) => void) | undefined;
		registerUpdateHandlers({
			isEnabled: () => enabled,
			isStoreBuild: () => false,
			currentVersion: '0.1.0',
			fetchText: () =>
				new Promise((resolve) => {
					release = resolve;
				})
		});

		const call = invoke();
		const pending = call();
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The user turns the check off while GitHub is still being awaited.
		enabled = false;
		release?.(RELEASE);

		await expect(pending).resolves.toMatchObject({ state: 'disabled' });
	});
});

describe('the renderer half of consent', () => {
	it('suppresses a result that lands after the setting went off', () => {
		const appSource = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
		/*
		 * The banner is only ever set through the staleness gate, and saving
		 * `updateCheck: false` closes it before clearing the banner.
		 *
		 * The gate used to be an inline `!updateBannerSuppressed.current`. It is
		 * now `updateAnswerIsCurrent`, which asks that question *and* whether a
		 * newer check has replaced this one — see `update-banner-race.test.tsx`,
		 * which exercises both. What this still pins is that `setUpdate` is
		 * reachable only through it.
		 */
		expect(appSource).toMatch(
			/if \(updateAnswerIsCurrent\([^)]*updateBannerSuppressed\.current\)\) \{\s*setUpdate\(result\);/
		);
		expect(appSource).toMatch(/updateBannerSuppressed\.current = !settings\.updateCheck;/);

		// And nowhere else. A second, ungated write would restore the bug this
		// gate exists for without touching the gate itself.
		expect(appSource.match(/setUpdate\(result\)/g) ?? []).toHaveLength(1);
	});
});

describe('the cache against a clock that moved backwards', () => {
	it('expires rather than becoming permanent', async () => {
		let at = 10 * 24 * 60 * 60 * 1000;
		let fetches = 0;
		registerUpdateHandlers({
			isEnabled: () => true,
			isStoreBuild: () => false,
			currentVersion: '0.1.0',
			now: () => at,
			fetchText: () => {
				fetches += 1;
				return Promise.resolve(RELEASE);
			}
		});
		const call = invoke();
		await call();
		expect(fetches).toBe(1);

		// A rollback: restored VM, manual correction, a large NTP step. Every
		// later `now() - previous.at` is negative, and negative is always under
		// the six-hour interval — so the cache never expired again.
		at = 0;
		for (let hour = 0; hour < 48; hour += 6) {
			at = hour * 60 * 60 * 1000;
			await call();
		}
		expect(fetches).toBeGreaterThan(1);
	});
});

/**
 * **A check the user's own setting stopped is not evidence about the network.**
 *
 * Failures are cached for six hours on purpose: retrying a broken network on
 * every mount is how a transient outage becomes a request storm. But the cache
 * was written *before* the consent re-check, so a request aborted by turning
 * `Require proxies` on arrived as `unknown` and was remembered as one — and
 * turning the policy back off could not retry, because the failure the policy
 * itself caused was sitting in the cache answering for it.
 */
describe('a check stopped by the policy', () => {
	it('is not cached, so re-enabling can retry', async () => {
		let enabled = true;
		let fetches = 0;
		let fail: ((err: Error) => void) | undefined;
		registerUpdateHandlers({
			isEnabled: () => enabled,
			isStoreBuild: () => false,
			currentVersion: '0.1.0',
			fetchText: () => {
				fetches += 1;
				return new Promise((_resolve, reject) => {
					fail = reject;
				});
			}
		});

		const call = invoke();

		// The check starts, then the policy turns on and aborts it.
		const aborted = call();
		await Promise.resolve();
		enabled = false;
		fail?.(new Error('aborted by the proxy policy'));
		await expect(aborted).resolves.toEqual({ state: 'disabled' });
		expect(fetches).toBe(1);

		// The user turns the policy back off. This must reach the network again.
		enabled = true;
		const retry = call();
		await Promise.resolve();
		expect(fetches, 'the aborted check was cached and suppressed the retry for six hours').toBe(2);
		fail?.(new Error('still offline'));
		await retry;
	});

	/*
	 * And an ordinary network failure still is cached — that is the behaviour
	 * this one had to be carved out of, not replaced.
	 */
	it('still caches a failure that was not the policy', async () => {
		let fetches = 0;
		let fail: ((err: Error) => void) | undefined;
		registerUpdateHandlers({
			isEnabled: () => true,
			isStoreBuild: () => false,
			currentVersion: '0.1.0',
			fetchText: () => {
				fetches += 1;
				return new Promise((_resolve, reject) => {
					fail = reject;
				});
			}
		});

		const call = invoke();
		const first = call();
		await Promise.resolve();
		fail?.(new Error('the network is down'));
		await first;
		expect(fetches).toBe(1);

		await call();
		expect(fetches, 'a broken network was retried on the next mount').toBe(1);
	});
});

/**
 * **The abort that outlived its own policy state.**
 *
 * Not caching while disabled was only half of it. The aborted request is still
 * *on the wire* — `inFlight` holds it — so a caller arriving after the user
 * turned the policy back off joined that attempt instead of starting one. When
 * it finally settled, `isEnabled()` was true again, the "don't cache while
 * disabled" guard let it through, and the abort was written to the cache as an
 * ordinary `unknown` for six hours.
 *
 * The user's retry was answered by the failure their own setting had caused,
 * and nothing they could do would clear it before the interval expired.
 */
describe('an aborted check that settles after the policy is restored', () => {
	it('does not answer the retry, and is not cached', async () => {
		let enabled = true;
		let generation = 0;
		let fetches = 0;
		const pending: ((body: string) => void)[] = [];
		const failures: ((err: Error) => void)[] = [];
		registerUpdateHandlers({
			isEnabled: () => enabled,
			isStoreBuild: () => false,
			currentVersion: '0.1.0',
			policyGeneration: () => generation,
			fetchText: () => {
				fetches += 1;
				return new Promise((resolve, reject) => {
					pending.push(resolve);
					failures.push(reject);
				});
			}
		});
		const call = invoke();

		// A check is running when `Require proxies` is switched on.
		const aborted = call();
		await Promise.resolve();
		expect(fetches).toBe(1);
		enabled = false;
		generation += 1;

		// The user turns it back off before the abort has settled.
		enabled = true;
		generation += 1;

		// A fresh caller must not be handed the attempt from the old policy state.
		const retry = call();
		await Promise.resolve();
		expect(fetches, 'the retry joined the aborted attempt instead of asking').toBe(2);

		// The retry settles first and caches the real answer.
		pending[1]?.(RELEASE);
		await expect(retry).resolves.toMatchObject({ state: 'updateAvailable' });

		/*
		 * Then the abort settles — *after* — which is the ordering that matters.
		 * It belongs to a policy state that has moved on, so it must not touch the
		 * cache. Writing it here would overwrite a good answer with the failure
		 * the policy caused, and the next six hours would serve that.
		 */
		failures[0]?.(new Error('aborted by the proxy policy'));
		await aborted;

		await expect(
			call(),
			'a stale abort overwrote the answer it had already been beaten by'
		).resolves.toMatchObject({ state: 'updateAvailable' });
	});

	/*
	 * Callers from the *same* policy state still share one request. That is what
	 * the in-flight map is for, and Strict Mode makes the pair the ordinary case.
	 */
	it('still shares a request between callers of the same policy state', async () => {
		let fetches = 0;
		let release: ((body: string) => void) | undefined;
		registerUpdateHandlers({
			isEnabled: () => true,
			isStoreBuild: () => false,
			currentVersion: '0.1.0',
			policyGeneration: () => 7,
			fetchText: () => {
				fetches += 1;
				return new Promise((resolve) => {
					release = resolve;
				});
			}
		});
		const call = invoke();

		const first = call();
		const second = call();
		await Promise.resolve();
		expect(fetches, 'two callers in one policy state asked twice').toBe(1);

		release?.(RELEASE);
		await Promise.all([first, second]);
	});
});
