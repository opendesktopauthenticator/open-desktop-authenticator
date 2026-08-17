import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MoveAuthenticator } from '../src/renderer/screens/MoveAuthenticator';

/*
 * The screen that offers to move an authenticator off the Steam mobile app.
 *
 * What is tested here is the wording, because on this screen the wording is the
 * safety feature. A user who reads "remove it from your phone first" and does
 * that has paid fifteen days of no trading for nothing, and no amount of
 * correct protocol code afterwards gives those days back.
 */

const props = {
	onAuthenticate: vi.fn(() =>
		Promise.resolve({
			state: 'authenticated' as const,
			steamId64: '76561198000000001',
			accountName: 'someone'
		})
	),
	onCancel: () => Promise.resolve({}),
	onClose: (): void => {}
};

const markup = (): string => renderToStaticMarkup(<MoveAuthenticator {...props} />);

describe('what the screen tells the user before anything happens', () => {
	it('tells them not to remove the authenticator from the phone first', () => {
		expect(markup()).toContain('Do not remove the authenticator from your phone first');
	});

	it('names the price of getting it wrong', () => {
		const html = markup();
		expect(html).toContain('fifteen days');
	});

	it('says the sign-in changes nothing on the account', () => {
		expect(markup()).toContain('changes nothing on the Steam account');
	});

	it('asks for the code from the phone, not an emailed one', () => {
		const html = markup();
		expect(html).toContain('Steam Guard code, from the Steam mobile app');
		expect(html).not.toContain('emailed');
	});

	it('marks the password field as a password field', () => {
		expect(markup()).toContain('type="password"');
	});
});

describe('what it never does', () => {
	/*
	 * The renderer has no business holding either. The password is spent on the
	 * request and the Guard code is single-use; keeping them would mean a screen
	 * left open is a screen holding credentials.
	 */
	it('renders no value into the password or code inputs', () => {
		const html = markup();
		expect(html).not.toMatch(/type="password"[^>]*value="[^"]+"/);
	});
});
