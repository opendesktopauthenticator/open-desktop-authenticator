import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
	abandonPendingSignIns,
	claimBrowserOpenContinuation,
	openBrowserAfterSignIn
} from '../src/renderer/App';
import { BrowserOpenRetry } from '../src/renderer/screens/BrowserOpenRetry';

describe('opening the account browser after Steam accepted a sign-in', () => {
	it('classifies a window-open rejection as browser work, not another sign-in failure', async () => {
		const open = vi.fn(() => Promise.reject(new Error('Chromium could not create the window')));

		await expect(openBrowserAfterSignIn(open)).resolves.toEqual({
			opened: false,
			reason: 'Chromium could not create the window'
		});
		expect(open).toHaveBeenCalledTimes(1);
	});

	it('keeps a stored-session refusal on the password-free browser retry path', async () => {
		await expect(
			openBrowserAfterSignIn(() =>
				Promise.resolve({
					signInRequired: true,
					reason: 'Steam did not accept the stored session.'
				})
			)
		).resolves.toEqual({
			opened: false,
			reason: 'Steam did not accept the stored session.'
		});
	});

	it('finishes when the browser opens', async () => {
		await expect(
			openBrowserAfterSignIn(() => Promise.resolve({ signInRequired: false }))
		).resolves.toEqual({ opened: true });
	});

	it('invalidates a late browser settlement when navigation takes the foreground', async () => {
		let release!: (result: { signInRequired: false }) => void;
		const gate = new Promise<{ signInRequired: false }>((resolve) => {
			release = resolve;
		});
		const current = claimBrowserOpenContinuation();
		const settlement = openBrowserAfterSignIn(() => gate).then((result) =>
			current() ? result : undefined
		);

		abandonPendingSignIns();
		release({ signInRequired: false });
		await expect(settlement).resolves.toBeUndefined();
	});

	it('retries only the browser after one successful sign-in', async () => {
		const signIn = vi.fn(() => Promise.resolve({ ok: true as const }));
		const open = vi
			.fn<() => Promise<{ signInRequired: false }>>()
			.mockRejectedValueOnce(new Error('Chromium could not create the window'))
			.mockResolvedValueOnce({ signInRequired: false });

		await expect(signIn()).resolves.toEqual({ ok: true });
		await expect(openBrowserAfterSignIn(open)).resolves.toMatchObject({ opened: false });
		await expect(openBrowserAfterSignIn(open)).resolves.toEqual({ opened: true });
		expect(signIn).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledTimes(2);
	});
});

describe('the browser-only retry screen', () => {
	it('says the sign-in succeeded and offers no password field', () => {
		const html = renderToStaticMarkup(
			<BrowserOpenRetry
				accountName="trader"
				busy={false}
				error="Chromium could not create the window"
				onRetry={() => undefined}
				onCancel={() => undefined}
			/>
		);

		expect(html).toContain('Steam signed in, but the browser did not open');
		expect(html).toContain('You do not need to enter the password again');
		expect(html).toContain('Try opening the browser again');
		expect(html).toContain('Chromium could not create the window');
		expect(html).not.toContain('type="password"');
	});

	it('locks both navigation controls while a browser attempt owns the screen', () => {
		const html = renderToStaticMarkup(
			<BrowserOpenRetry
				accountName="trader"
				busy
				onRetry={() => undefined}
				onCancel={() => undefined}
			/>
		);

		expect(html.match(/disabled=""/g)).toHaveLength(2);
		expect(html).toContain('Opening…');
	});
});
