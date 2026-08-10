import { describe, expect, it } from 'vitest';
import {
	buildListUrl,
	buildOperationBody,
	ConfirmationProtocolError,
	operationUrl,
	parseListResponse,
	parseOperationResponse,
	tagForAction,
	type RequestIdentity
} from '../src/main/confirmations/protocol';

/**
 * The mobileconf wire format (§12 F5).
 *
 * Steam publishes none of this, so these shapes are what Phase 0 observed. The
 * tests that matter are the ones about being wrong: an authenticator that shows
 * "nothing pending" when it actually failed to ask is worse than one that says
 * it is broken, because the user believes it.
 */

const identity: RequestIdentity = {
	steamId64: '76561198000000001',
	deviceId: 'android:00000000-0000-0000-0000-000000000000',
	unixSeconds: 1_700_000_000,
	key: 'L/ffkbuB9f4s6uhxZ9AxRf3CSS4=',
	tag: 'list'
};

describe('the list request', () => {
	it('carries every parameter Steam expects', () => {
		const url = new URL(buildListUrl(identity));

		expect(url.origin + url.pathname).toBe('https://steamcommunity.com/mobileconf/getlist');
		expect(url.searchParams.get('p')).toBe(identity.deviceId);
		expect(url.searchParams.get('a')).toBe('76561198000000001');
		expect(url.searchParams.get('k')).toBe(identity.key);
		expect(url.searchParams.get('t')).toBe('1700000000');
		expect(url.searchParams.get('m')).toBe('react');
		expect(url.searchParams.get('tag')).toBe('list');
	});

	it('encodes a key containing URL-significant characters', () => {
		// Base64 routinely contains `+` and `/`. Unencoded, `+` becomes a space and
		// the signature silently stops matching.
		const url = new URL(buildListUrl({ ...identity, key: 'a+b/c=' }));
		expect(url.searchParams.get('k')).toBe('a+b/c=');
		expect(url.search).toContain('a%2Bb%2Fc%3D');
	});

	it('refuses a key that was signed for a different operation', () => {
		// The tag is what the key was signed over. Sending an accept-key under the
		// list tag is exactly the mistake the tag exists to prevent.
		expect(() => buildListUrl({ ...identity, tag: 'accept' })).toThrow(ConfirmationProtocolError);
	});
});

describe('the accept/deny request', () => {
	const acting: RequestIdentity = { ...identity, tag: 'accept' };
	const confirmations = [
		{ id: '111', nonce: 'aaa' },
		{ id: '222', nonce: 'bbb' }
	];

	it('posts to multiajaxop', () => {
		expect(operationUrl()).toBe('https://steamcommunity.com/mobileconf/multiajaxop');
	});

	it('pairs each id with its own nonce, in order', () => {
		const body = buildOperationBody(acting, 'allow', confirmations);

		expect(body.getAll('cid[]')).toEqual(['111', '222']);
		expect(body.getAll('ck[]')).toEqual(['aaa', 'bbb']);
		expect(body.get('op')).toBe('allow');
	});

	it('maps the action to the tag Steam requires', () => {
		expect(tagForAction('allow')).toBe('accept');
		expect(tagForAction('cancel')).toBe('reject');
	});

	it('refuses to act with a key signed for the other action', () => {
		// A key minted to approve must not be able to deny, or vice versa.
		expect(() => buildOperationBody(acting, 'cancel', confirmations)).toThrow(
			/reject.*not.*accept|not "accept"/
		);
		expect(() =>
			buildOperationBody({ ...identity, tag: 'reject' }, 'allow', confirmations)
		).toThrow(ConfirmationProtocolError);
	});

	it('refuses to send an operation that names nothing', () => {
		// An empty op is a request that could only ever be a bug, and Steam's
		// interpretation of one is not something to discover in production.
		expect(() => buildOperationBody(acting, 'allow', [])).toThrow(/names nothing/);
	});
});

describe('reading a list response', () => {
	it('reads a pending confirmation', () => {
		const conf = parseListResponse(
			JSON.stringify({
				success: true,
				conf: [
					{
						id: '7290123456789',
						nonce: '9876543210',
						type: 2,
						type_name: 'Trade Offer',
						creator_id: '4455667788',
						headline: 'Trade with someone',
						summary: ['You give: a knife', 'You get: nothing']
					}
				]
			})
		);

		expect(conf).toHaveLength(1);
		expect(conf[0]?.id).toBe('7290123456789');
		expect(conf[0]?.type).toBe(2);
		expect(conf[0]?.summary).toEqual(['You give: a knife', 'You get: nothing']);
	});

	it('REFUSES a numeric id rather than coercing one that is already mangled', () => {
		// The previous version accepted numbers and called String() on them, which
		// reads as tolerant and is F-01 in disguise: JSON.parse has already rounded
		// the value by then, so the coercion preserves a number that is no longer
		// the one Steam sent — and acting on a mangled id acts on the wrong
		// confirmation.
		expect(() =>
			parseListResponse(
				JSON.stringify({ success: true, conf: [{ id: 7290123456789, nonce: '1', type: 3 }] })
			)
		).toThrow(ConfirmationProtocolError);

		expect(() =>
			parseListResponse(
				JSON.stringify({ success: true, conf: [{ id: '1', nonce: 12345, type: 3 }] })
			)
		).toThrow(ConfirmationProtocolError);
	});

	it('drops a numeric creator id instead of showing a wrong one', () => {
		// A SteamID64 is past the safe-integer range, so a numeric one arrives
		// already corrupted. It is display-only, so losing it costs nothing; showing
		// the wrong counterparty would.
		// Written as raw JSON text: a literal that large cannot survive being typed
		// as a JavaScript number, which is precisely the problem under test.
		const conf = parseListResponse(
			'{"success":true,"conf":[{"id":"1","nonce":"n","type":2,"creator_id":76561198000000001}]}'
		);

		expect(conf[0]?.creator_id).toBeUndefined();
	});

	it('keeps a string creator id', () => {
		const conf = parseListResponse(
			JSON.stringify({
				success: true,
				conf: [{ id: '1', nonce: 'n', type: 2, creator_id: '76561198000000001' }]
			})
		);

		expect(conf[0]?.creator_id).toBe('76561198000000001');
	});

	it('reads an empty list as an empty list', () => {
		expect(parseListResponse(JSON.stringify({ success: true }))).toEqual([]);
		expect(parseListResponse(JSON.stringify({ success: true, conf: [] }))).toEqual([]);
	});

	it('caps text a counterparty controls', () => {
		// Not about injection — React escapes. About a counterparty being unable to
		// push a megabyte through the UI.
		const conf = parseListResponse(
			JSON.stringify({
				success: true,
				conf: [{ id: '1', nonce: 'n', type: 2, headline: 'x'.repeat(5000) }]
			})
		);

		expect((conf[0]?.headline ?? '').length).toBeLessThanOrEqual(513);
	});

	it('keeps a type it does not recognise rather than dropping it', () => {
		// S16 decides what may be *done* with a type. Losing the confirmation here
		// would hide it from the user entirely, which is the opposite of the point.
		const conf = parseListResponse(
			JSON.stringify({ success: true, conf: [{ id: '1', nonce: 'n', type: 6 }] })
		);
		expect(conf[0]?.type).toBe(6);
	});

	describe('does not mistake a failure for an empty list', () => {
		it('when Steam says needauth even though success is true', () => {
			// A dead session must not look like an empty inbox.
			expect(() => parseListResponse(JSON.stringify({ success: true, needauth: true }))).toThrow(
				/session/i
			);
		});

		it('when Steam says the session needs auth', () => {
			expect(() => parseListResponse(JSON.stringify({ success: false, needauth: true }))).toThrow(
				/session/i
			);
		});

		it('when Steam refuses with a message', () => {
			try {
				parseListResponse(JSON.stringify({ success: false, message: 'Nope' }));
				expect.unreachable('should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(ConfirmationProtocolError);
				expect((err as ConfirmationProtocolError).failure.kind).toBe('steamRefused');
			}
		});

		it('when Steam serves its sign-in page with a 200', () => {
			// The most common real failure, and the one most likely to be read as
			// "no confirmations" by a naive parser.
			try {
				parseListResponse('<!DOCTYPE html><html><body>Sign in</body></html>');
				expect.unreachable('should have thrown');
			} catch (err) {
				expect((err as ConfirmationProtocolError).failure.kind).toBe('sessionExpired');
			}
		});

		it('when the body is not JSON at all', () => {
			expect(() => parseListResponse('not json')).toThrow(ConfirmationProtocolError);
		});

		it('when the shape is unrecognisable', () => {
			expect(() => parseListResponse(JSON.stringify({ unexpected: true }))).toThrow(
				/does not understand/
			);
		});

		it('when a confirmation is missing what identifies it', () => {
			expect(() =>
				parseListResponse(JSON.stringify({ success: true, conf: [{ type: 2 }] }))
			).toThrow(ConfirmationProtocolError);
		});
	});
});

describe('reading an operation response', () => {
	it('accepts a success', () => {
		expect(() => parseOperationResponse(JSON.stringify({ success: true }))).not.toThrow();
	});

	it('reports a refusal with Steam own words', () => {
		expect(() =>
			parseOperationResponse(JSON.stringify({ success: false, message: 'Too soon' }))
		).toThrow(/Too soon/);
	});

	it('says plainly that the outcome is unknown when the reply is unreadable', () => {
		// The honest failure mode: we cannot claim it went through, and we must not
		// claim it did not.
		expect(() => parseOperationResponse('<html>oh dear</html>')).toThrow();
		expect(() => parseOperationResponse(JSON.stringify({ ok: 1 }))).toThrow(
			/may or may not have gone through/
		);
	});
});
