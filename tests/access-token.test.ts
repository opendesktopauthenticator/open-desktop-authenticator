import { describe, expect, it } from 'vitest';
import { AccessTokenError, mintAccessToken } from '../src/main/steam/access-token';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';

/**
 * Minting a web session from a stored refresh token (§12 F5, §11 S8).
 *
 * The behaviour worth protecting is the distinction between "this went wrong"
 * and "your saved session is finished, sign in again". They call for completely
 * different things from the user, and a layer that blurs them produces an app
 * that appears broken when it is merely asking to be logged into.
 */

const NOW = Date.parse('2026-08-10T00:00:00Z');

/** An unsigned JWT with the given claims. Nothing here verifies a signature. */
function token(claims: Record<string, unknown>): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ typ: 'JWT' })}.${encode(claims)}.sig`;
}

const mobileToken = (expSeconds: number): string =>
	token({ aud: ['web', 'renew', 'derive', 'mobile'], exp: expSeconds });

const LIVE = mobileToken(Math.floor(NOW / 1000) + 86_400);
/**
 * The access token Steam mints is validated too — it must be mobile-scoped and
 * unexpired, or the session cookie built from it looks fine and cannot drive
 * mobileconf. So the fixture has to be a real token rather than a placeholder
 * string, exactly as a stored secret has to be a real secret.
 */
const MINTED = mobileToken(Math.floor(NOW / 1000) + 3600);

function transportReturning(reply: SteamResponse): {
	transport: (request: SteamRequest) => Promise<SteamResponse>;
	sent: SteamRequest[];
} {
	const sent: SteamRequest[] = [];
	return {
		sent,
		transport: (request) => {
			sent.push(request);
			return Promise.resolve(reply);
		}
	};
}

describe('minting an access token', () => {
	it('returns the token Steam issued', async () => {
		const { transport, sent } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { access_token: MINTED } })
		});

		const result = await mintAccessToken(transport, '76561198000000001', LIVE, NOW);

		expect(result).toBe(MINTED);
		expect(sent[0]?.method).toBe('POST');
		expect(sent[0]?.url).toContain('GenerateAccessTokenForApp');
		expect(sent[0]?.body?.get('refresh_token')).toBe(LIVE);
		expect(sent[0]?.body?.get('steamid')).toBe('76561198000000001');
	});

	it('sends no cookie, because this is what we call when there is no session', async () => {
		const { transport, sent } = transportReturning({
			status: 200,
			text: JSON.stringify({ response: { access_token: MINTED } })
		});

		await mintAccessToken(transport, '76561198000000001', LIVE, NOW);
		expect(sent[0]?.cookie).toBe('');
	});

	describe('says "sign in again" only when that is the real answer', () => {
		it('for an expired refresh token, without spending a request', async () => {
			const { transport, sent } = transportReturning({ status: 200, text: '{}' });
			const expired = mobileToken(Math.floor(NOW / 1000) - 10);

			await expect(
				mintAccessToken(transport, '76561198000000001', expired, NOW)
			).rejects.toMatchObject({ needsSignIn: true });
			// Checked locally: Steam's answer to a dead token is opaque, and asking
			// costs a round trip to learn nothing.
			expect(sent).toHaveLength(0);
		});

		it('for a web-scoped token, which would fail later and mysteriously', async () => {
			// F-13. It looks perfectly valid and cannot drive confirmations.
			const { transport } = transportReturning({ status: 200, text: '{}' });
			const webScoped = token({ aud: ['client', 'web'], exp: Math.floor(NOW / 1000) + 86_400 });

			await expect(
				mintAccessToken(transport, '76561198000000001', webScoped, NOW)
			).rejects.toMatchObject({ needsSignIn: true });
		});

		it('when Steam rejects the token outright', async () => {
			const { transport } = transportReturning({ status: 401, text: '' });

			await expect(
				mintAccessToken(transport, '76561198000000001', LIVE, NOW)
			).rejects.toMatchObject({ needsSignIn: true });
		});

		it('when Steam answers 200 with an empty response, which is how it says no', async () => {
			const { transport } = transportReturning({
				status: 200,
				text: JSON.stringify({ response: {} })
			});

			await expect(
				mintAccessToken(transport, '76561198000000001', LIVE, NOW)
			).rejects.toMatchObject({ needsSignIn: true });
		});

		it('when the minted access token is web-scoped (F-13 on the output)', async () => {
			const webAccess = token({ aud: ['client', 'web'], exp: Math.floor(NOW / 1000) + 3600 });
			const { transport } = transportReturning({
				status: 200,
				text: JSON.stringify({ response: { access_token: webAccess } })
			});

			await expect(
				mintAccessToken(transport, '76561198000000001', LIVE, NOW)
			).rejects.toMatchObject({ needsSignIn: true });
		});

		it('when the minted access token is already expired', async () => {
			const expiredAccess = token({ aud: ['mobile'], exp: Math.floor(NOW / 1000) - 10 });
			const { transport } = transportReturning({
				status: 200,
				text: JSON.stringify({ response: { access_token: expiredAccess } })
			});

			await expect(
				mintAccessToken(transport, '76561198000000001', LIVE, NOW)
			).rejects.toMatchObject({ needsSignIn: true });
		});
	});

	describe('does NOT say "sign in again" for problems a sign-in would not fix', () => {
		it('on a server error', async () => {
			const { transport } = transportReturning({ status: 503, text: 'later' });

			await expect(
				mintAccessToken(transport, '76561198000000001', LIVE, NOW)
			).rejects.toMatchObject({ needsSignIn: false });
		});

		it('on an unreadable body', async () => {
			const { transport } = transportReturning({ status: 200, text: '<html>proxy error</html>' });

			const error = await mintAccessToken(transport, '76561198000000001', LIVE, NOW).catch(
				(err: unknown) => err
			);
			expect(error).toBeInstanceOf(AccessTokenError);
			expect((error as AccessTokenError).needsSignIn).toBe(false);
		});
	});

	it('lets a transport failure through rather than calling it a sign-in problem', async () => {
		// A dead proxy is not an expired session, and telling the user to sign in
		// again would send them chasing the wrong thing.
		const transport = (): Promise<SteamResponse> =>
			Promise.reject(new Error('net::ERR_PROXY_CONNECTION_FAILED'));

		await expect(mintAccessToken(transport, '76561198000000001', LIVE, NOW)).rejects.toThrow(
			/ERR_PROXY_CONNECTION_FAILED/
		);
	});

	it('never puts the refresh token in an error message', async () => {
		const { transport } = transportReturning({ status: 500, text: 'boom' });

		const error = await mintAccessToken(transport, '76561198000000001', LIVE, NOW).catch(
			(err: unknown) => err
		);
		expect((error as Error).message).not.toContain(LIVE);
	});
});
