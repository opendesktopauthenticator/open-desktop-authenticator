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
		// The banner state is only ever set through the suppression gate, and
		// saving `updateCheck: false` closes the gate before clearing the banner.
		expect(appSource).toMatch(/if \(!updateBannerSuppressed\.current\) \{\s*setUpdate\(result\);/);
		expect(appSource).toMatch(/updateBannerSuppressed\.current = !settings\.updateCheck;/);
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
