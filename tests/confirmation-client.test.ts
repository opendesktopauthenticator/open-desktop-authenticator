import { describe, expect, it } from 'vitest';
import {
	buildSessionCookie,
	ConfirmationsClient,
	type ConfirmationAccount,
	type SteamRequest,
	type SteamResponse
} from '../src/main/confirmations/client';
import { ConfirmationProtocolError } from '../src/main/confirmations/protocol';
import { generateConfirmationKey } from '../src/main/confirmations/key';

/**
 * Fetching and acting on confirmations.
 *
 * The transport is a fake, which is the point of injecting it: every rule worth
 * testing here is about *what request would be sent*, and none of them need a
 * socket, an account, or Steam being up.
 *
 * The tests that matter most are the refusals. An account-recovery confirmation
 * that this client auto-approves is somebody's account gone.
 */

const IDENTITY_SECRET = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
const COOKIE = 'steamLoginSecure=76561198000000001%7C%7Ctoken';
const NOW_MS = 1_700_000_000_000;

function account(overrides: Partial<ConfirmationAccount> = {}): ConfirmationAccount {
	return {
		steamId64: '76561198000000001',
		identitySecret: IDENTITY_SECRET,
		autoConfirm: { marketListings: false, trades: false },
		...overrides
	};
}

/** Records every request and replies with whatever it was handed. */
function fakeTransport(...replies: (SteamResponse | Error)[]): {
	transport: (request: SteamRequest) => Promise<SteamResponse>;
	sent: SteamRequest[];
} {
	const sent: SteamRequest[] = [];
	let index = 0;
	return {
		sent,
		transport: (request) => {
			sent.push(request);
			const reply = replies[index++] ?? { status: 200, text: JSON.stringify({ success: true }) };
			return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
		}
	};
}

function client(transport: (request: SteamRequest) => Promise<SteamResponse>): ConfirmationsClient {
	return new ConfirmationsClient({ transport, now: () => NOW_MS });
}

const trade = { id: '1', nonce: 'n1', type: 2 };
const listing = { id: '2', nonce: 'n2', type: 3 };
const recovery = { id: '3', nonce: 'n3', type: 6 };

describe('listing', () => {
	it('signs the request with a list-tagged key', () => {
		const { transport, sent } = fakeTransport({
			status: 200,
			text: JSON.stringify({ success: true, conf: [trade] })
		});

		return client(transport)
			.list(account(), COOKIE)
			.then(({ confirmations }) => {
				expect(confirmations).toHaveLength(1);

				const url = new URL(sent[0]?.url ?? '');
				expect(sent[0]?.method).toBe('GET');
				expect(sent[0]?.cookie).toBe(COOKIE);
				expect(url.searchParams.get('tag')).toBe('list');
				// The key is genuinely derived, not a placeholder.
				expect(url.searchParams.get('k')).toBe(
					generateConfirmationKey(IDENTITY_SECRET, 1_700_000_000, 'list')
				);
			});
	});

	it('derives the device id rather than requiring one to be stored', () => {
		const { transport, sent } = fakeTransport({
			status: 200,
			text: JSON.stringify({ success: true })
		});

		return client(transport)
			.list(account(), COOKIE)
			.then(() => {
				expect(new URL(sent[0]?.url ?? '').searchParams.get('p')).toMatch(/^android:[0-9a-f-]+$/);
			});
	});

	it('reports an expired session rather than an empty list', async () => {
		const { transport } = fakeTransport({ status: 401, text: '' });

		await expect(client(transport).list(account(), COOKIE)).rejects.toThrow(/Sign in again/);
	});

	it('reports a server error rather than an empty list', async () => {
		const { transport } = fakeTransport({ status: 503, text: 'unavailable' });

		await expect(client(transport).list(account(), COOKIE)).rejects.toThrow(/HTTP 503/);
	});

	it('lets a transport failure surface instead of swallowing it', async () => {
		const { transport } = fakeTransport(new Error('ECONNREFUSED via proxy'));

		await expect(client(transport).list(account(), COOKIE)).rejects.toThrow(/ECONNREFUSED/);
	});
});

describe('auto-confirm applies S16 at the boundary that sends', () => {
	it('never approves account recovery, even with everything switched on', async () => {
		const { transport, sent } = fakeTransport();
		const result = await client(transport).autoConfirm(
			account({ autoConfirm: { marketListings: true, trades: true } }),
			COOKIE,
			[recovery]
		);

		// The finding, expressed as the only assertion that really matters here:
		// nothing was sent at all.
		expect(sent).toHaveLength(0);
		expect(result.approved).toEqual([]);
		expect(result.held[0]?.reason).toContain('Account recovery');
	});

	it('sends only the permitted types when a batch is mixed', async () => {
		const { transport, sent } = fakeTransport();
		const result = await client(transport).autoConfirm(
			account({ autoConfirm: { marketListings: true, trades: true } }),
			COOKIE,
			[trade, recovery, listing, { id: '4', nonce: 'n4', type: 99 }]
		);

		expect(result.approved.map((c) => c.id)).toEqual(['1', '2']);
		expect(result.held.map((h) => h.confirmation.id)).toEqual(['3', '4']);

		// And the wire agrees with the decision.
		const body = sent[0]?.body;
		expect(body?.getAll('cid[]')).toEqual(['1', '2']);
		expect(body?.get('op')).toBe('allow');
	});

	it('sends nothing when the user has enabled nothing, which is the default', async () => {
		const { transport, sent } = fakeTransport();
		const result = await client(transport).autoConfirm(account(), COOKIE, [trade, listing]);

		expect(sent).toHaveLength(0);
		expect(result.approved).toEqual([]);
		expect(result.held).toHaveLength(2);
	});

	it('does not let the market switch approve a trade', async () => {
		const { transport, sent } = fakeTransport();
		const result = await client(transport).autoConfirm(
			account({ autoConfirm: { marketListings: true, trades: false } }),
			COOKIE,
			[trade]
		);

		expect(sent).toHaveLength(0);
		expect(result.approved).toEqual([]);
	});

	it('signs the operation with an accept-tagged key', async () => {
		const { transport, sent } = fakeTransport();
		await client(transport).autoConfirm(
			account({ autoConfirm: { marketListings: true, trades: true } }),
			COOKIE,
			[trade]
		);

		expect(sent[0]?.method).toBe('POST');
		expect(sent[0]?.body?.get('tag')).toBe('accept');
		expect(sent[0]?.body?.get('k')).toBe(
			generateConfirmationKey(IDENTITY_SECRET, 1_700_000_000, 'accept')
		);
	});

	it('surfaces a refusal from Steam rather than reporting success', async () => {
		const { transport } = fakeTransport({
			status: 200,
			text: JSON.stringify({ success: false, message: 'Rate limited' })
		});

		await expect(
			client(transport).autoConfirm(
				account({ autoConfirm: { marketListings: true, trades: true } }),
				COOKIE,
				[trade]
			)
		).rejects.toThrow(/Rate limited/);
	});
});

describe('acting on the user own choice', () => {
	it('approves what the user selected', async () => {
		const { transport, sent } = fakeTransport();
		await client(transport).act(account(), COOKIE, 'allow', [trade, listing]);

		expect(sent[0]?.body?.getAll('cid[]')).toEqual(['1', '2']);
		expect(sent[0]?.body?.get('op')).toBe('allow');
	});

	it('denies with a reject-tagged key', async () => {
		const { transport, sent } = fakeTransport();
		await client(transport).act(account(), COOKIE, 'cancel', [trade]);

		expect(sent[0]?.body?.get('op')).toBe('cancel');
		expect(sent[0]?.body?.get('tag')).toBe('reject');
	});

	it('allows a security-critical confirmation on its own', async () => {
		// Someone recovering their own account has every right to approve it.
		const { transport, sent } = fakeTransport();
		await client(transport).act(account(), COOKIE, 'allow', [recovery]);

		expect(sent).toHaveLength(1);
	});

	it('refuses to sweep a security-critical confirmation up in a batch', async () => {
		// A "select all" the user did not read must not be how an account-recovery
		// confirmation gets approved.
		const { transport, sent } = fakeTransport();

		await expect(
			client(transport).act(account(), COOKIE, 'allow', [trade, recovery])
		).rejects.toThrow(/one at a time/);
		expect(sent).toHaveLength(0);
	});
});

describe('the session cookie', () => {
	it('builds the form Steam expects', () => {
		expect(buildSessionCookie('76561198000000001', 'abc123')).toBe(
			'steamLoginSecure=76561198000000001%7C%7Cabc123'
		);
	});

	it('encodes a token containing URL-significant characters', () => {
		expect(buildSessionCookie('76561198000000001', 'a+b/c=')).toContain('a%2Bb%2Fc%3D');
	});

	it('refuses a token that would terminate the cookie early', () => {
		// A semicolon would silently send a different session than intended.
		for (const bad of ['', 'has;semicolon', 'has space', 'has\nnewline']) {
			expect(() => buildSessionCookie('76561198000000001', bad)).toThrow(ConfirmationProtocolError);
		}
	});

	it('refuses a SteamID that is not one', () => {
		expect(() => buildSessionCookie('not-an-id', 'abc')).toThrow(ConfirmationProtocolError);
	});
});
