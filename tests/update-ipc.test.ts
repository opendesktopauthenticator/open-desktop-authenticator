import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import {
	__resetRouterForTests,
	registeredChannels,
	setTrustedSender
} from '../src/main/ipc/router';
import { registerUpdateHandlers } from '../src/main/update/ipc';
import { branding } from '../src/shared/branding';

/**
 * The update handler (§11 S11).
 *
 * `checker.ts` is tested separately for version comparison and parsing. What is
 * tested here is the handler's own behaviour: respecting the setting, not
 * hammering GitHub, and — the property worth guarding hardest — never putting
 * anything downloadable in front of the renderer.
 */

/**
 * Handlers are captured from the mock rather than reached for directly.
 *
 * `registerHandler` installs a wrapper around every handler — sender check,
 * request validation, **response validation against the contract**. Invoking
 * through that wrapper is what makes these tests meaningful: a handler that
 * returned a download URL would be rejected by the schema here exactly as it
 * would be at runtime.
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

const RELEASE_URL = `${branding.repository}/releases/tag/v9.9.9`;

/** Invoke the registered handler the way the router would at runtime. */
async function invoke(): Promise<Record<string, unknown>> {
	const handler = handlers.get(CHANNELS.updateCheck);
	if (!handler) {
		throw new Error('update:check was never registered');
	}
	return (await handler(
		{ senderFrame: { url: 'file:///app/out/renderer/index.html' } },
		{}
	)) as Record<string, unknown>;
}

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	// The reset deliberately leaves the router trusting nobody. These tests are
	// about the handler, not the sender check, so the caller is declared trusted.
	setTrustedSender(() => true);
});

describe('the update handler', () => {
	it('registers the channel', () => {
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText: () => Promise.resolve('{}')
		});

		expect(registeredChannels().has(CHANNELS.updateCheck)).toBe(true);
	});

	it('asks nothing at all when the setting is off', async () => {
		const fetchText = vi.fn(() => Promise.resolve('{}'));
		registerUpdateHandlers({ isEnabled: () => false, currentVersion: '0.1.0', fetchText });

		expect(await invoke()).toEqual({ state: 'disabled' });
		// The point of the switch: off means no request, not a request whose answer
		// is discarded.
		expect(fetchText).not.toHaveBeenCalled();
	});

	it('re-reads the setting on every call, so switching it off takes effect', async () => {
		let enabled = true;
		const fetchText = vi.fn(() =>
			Promise.resolve(JSON.stringify({ tag_name: 'v9.9.9', html_url: RELEASE_URL }))
		);
		registerUpdateHandlers({ isEnabled: () => enabled, currentVersion: '0.1.0', fetchText });

		expect((await invoke()).state).toBe('updateAvailable');
		enabled = false;
		expect((await invoke()).state).toBe('disabled');
	});

	it('reports an available release as a version and a link', async () => {
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText: () =>
				Promise.resolve(
					JSON.stringify({ tag_name: 'v9.9.9', html_url: RELEASE_URL, published_at: '2026-09-01' })
				)
		});

		expect(await invoke()).toEqual({
			state: 'updateAvailable',
			version: 'v9.9.9',
			url: RELEASE_URL,
			publishedAt: '2026-09-01'
		});
	});

	it('caches, so opening a screen repeatedly does not hammer GitHub', async () => {
		// Without this, mounting Settings a few times earns a 403 from GitHub's
		// rate limiter, which then surfaces to the user as "could not check".
		const fetchText = vi.fn(() =>
			Promise.resolve(JSON.stringify({ tag_name: 'v0.1.0', html_url: RELEASE_URL }))
		);
		let clock = 0;
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText,
			now: () => clock
		});

		await invoke();
		await invoke();
		await invoke();
		expect(fetchText).toHaveBeenCalledTimes(1);

		// Past the window, it asks again.
		clock = 7 * 60 * 60 * 1000;
		await invoke();
		expect(fetchText).toHaveBeenCalledTimes(2);
	});

	it('caches a failure too, so an outage is not turned into a request storm', async () => {
		const fetchText = vi.fn(() => Promise.reject(new Error('ENOTFOUND')));
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText,
			now: () => 0
		});

		expect((await invoke()).state).toBe('unknown');
		await invoke();
		expect(fetchText).toHaveBeenCalledTimes(1);
	});

	it('never resolves to up-to-date when it could not ask', async () => {
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText: () => Promise.reject(new Error('offline'))
		});

		const result = await invoke();
		expect(result.state).toBe('unknown');
		expect(result.state).not.toBe('upToDate');
	});

	it('does not reject, whatever happens', async () => {
		// Background work the user did not ask for must not be able to take down
		// the screen they are using.
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText: () => Promise.reject(new Error('boom'))
		});

		await expect(invoke()).resolves.toBeDefined();
	});

	it('hands the renderer nothing it could download', async () => {
		// The guarantee this whole module exists to keep. A release *page* can only
		// be opened in a browser; an asset URL could be fetched.
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText: () =>
				Promise.resolve(
					JSON.stringify({
						tag_name: 'v9.9.9',
						html_url: RELEASE_URL,
						assets: [
							{
								browser_download_url: `${branding.repository}/releases/download/v9.9.9/oda-setup.exe`
							}
						],
						tarball_url: 'https://api.github.com/x/tarball/v9.9.9'
					})
				)
		});

		const serialised = JSON.stringify(await invoke());
		expect(serialised).not.toMatch(/\.exe|\.msi|\.AppImage|\.zip/);
		expect(serialised).not.toContain('releases/download');
		expect(serialised).not.toContain('tarball');
	});
});

/**
 * The Microsoft Store build asks nothing.
 *
 * The same binary ships through two Windows channels and must behave
 * differently in one of them — a difference easy to write and easy to leave
 * untested, since there is no Store to install from in CI and
 * `process.windowsStore` is undefined on every machine this suite runs on. So
 * the channel is injected.
 *
 * Two properties, and the second matters more than it looks. No request,
 * because Windows already fetches and verifies the package and this is the one
 * request the application makes that is not to Steam. And no offer: telling a
 * Store user a release exists invites them to install a second, unmanaged copy
 * beside the managed one, and two installs of an authenticator means two vaults
 * — with an account in only one of them being an account they cannot produce a
 * code for.
 */
describe('a build installed from the Microsoft Store', () => {
	const newerRelease = () =>
		vi.fn(() => Promise.resolve(JSON.stringify({ tag_name: 'v9.9.9', html_url: RELEASE_URL })));

	it('answers storeManaged and reaches no network', async () => {
		const fetchText = vi.fn(() => Promise.reject(new Error('must not ask GitHub')));
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText,
			isStoreBuild: () => true
		});

		expect(await invoke()).toEqual({ state: 'storeManaged' });
		expect(fetchText, 'no request may be made at all').not.toHaveBeenCalled();
	});

	it('says so even when update checks are switched off', async () => {
		// `disabled` is a preference; this is not. Reporting the setting would
		// imply there is something here to switch back on.
		registerUpdateHandlers({
			isEnabled: () => false,
			currentVersion: '0.1.0',
			fetchText: vi.fn(() => Promise.resolve('{}')),
			isStoreBuild: () => true
		});

		expect(await invoke()).toEqual({ state: 'storeManaged' });
	});

	it('never offers a release, however new the one on GitHub is', async () => {
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText: newerRelease(),
			isStoreBuild: () => true
		});

		expect(await invoke()).not.toMatchObject({ state: 'updateAvailable' });
	});

	it('leaves the direct-download build asking as it always did', async () => {
		// The guard must be a branch, not a change of behaviour for everyone.
		const fetchText = newerRelease();
		registerUpdateHandlers({
			isEnabled: () => true,
			currentVersion: '0.1.0',
			fetchText,
			isStoreBuild: () => false
		});

		expect(await invoke()).toMatchObject({ state: 'updateAvailable', version: 'v9.9.9' });
		expect(fetchText).toHaveBeenCalledTimes(1);
	});
});
