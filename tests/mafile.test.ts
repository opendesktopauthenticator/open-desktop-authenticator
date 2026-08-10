import { describe, expect, it } from 'vitest';
import { MaFileParseError, parseMaFile } from '../src/main/import/mafile';
import {
	countSessionObjects,
	membersNamed,
	outsideSession,
	sessionBody,
	topLevelMembers
} from '../src/main/import/jsonspan';

/**
 * maFile parsing (§12 F2).
 *
 * Every SteamID here is synthetic and every secret is a placeholder. Real
 * account material never enters this repository — the Phase 0 spike was
 * exercised against live accounts precisely so these tests do not have to be.
 *
 * The awkward cases below are not hypothetical. Each one was found in the spike
 * against files that exist in the wild, and each one silently produced the wrong
 * account before it was fixed.
 */

const NOW = Date.parse('2026-08-10T00:00:00Z');

/** A minimal, well-formed maFile. */
function maFile(extra: Record<string, unknown> = {}, session?: Record<string, unknown>): string {
	return JSON.stringify({
		shared_secret: 'c2hhcmVkLXNlY3JldA==',
		identity_secret: 'aWRlbnRpdHktc2VjcmV0',
		account_name: 'testaccount',
		revocation_code: 'R12345',
		device_id: 'android:00000000-0000-0000-0000-000000000000',
		fully_enrolled: true,
		...extra,
		...(session ? { Session: session } : {})
	});
}

/** A JWT with the given claims. Unsigned — nothing here verifies a signature. */
function token(claims: Record<string, unknown>): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ typ: 'JWT', alg: 'EdDSA' })}.${encode(claims)}.c2ln`;
}

const mobileToken = (expSeconds: number): string =>
	token({ aud: ['web', 'renew', 'derive', 'mobile'], exp: expSeconds });

describe('parseMaFile', () => {
	it('reads a well-formed file', () => {
		const parsed = parseMaFile(maFile({ steamid: '76561198000000001' }), 'x.maFile', NOW);

		expect(parsed.accountName).toBe('testaccount');
		expect(parsed.sharedSecret).toBe('c2hhcmVkLXNlY3JldA==');
		expect(parsed.identitySecret).toBe('aWRlbnRpdHktc2VjcmV0');
		expect(parsed.revocationCode).toBe('R12345');
		expect(parsed.steamId64).toBe('76561198000000001');
		expect(parsed.steamIdSource).toBe('steamid');
	});

	it('rejects a file missing a required secret', () => {
		const text = JSON.stringify({ account_name: 'x', identity_secret: 'y' });
		expect(() => parseMaFile(text, 'x.maFile', NOW)).toThrow(MaFileParseError);
	});

	it('rejects an SDA encrypted manifest with an explanation, not a JSON error', () => {
		expect(() => parseMaFile('BASE64GIBBERISH==', 'x.maFile', NOW)).toThrow(/encrypted manifest/);
	});

	it('tolerates a UTF-8 BOM, which SDA sometimes writes', () => {
		const parsed = parseMaFile(
			'\uFEFF' + maFile({ steamid: '76561198000000001' }),
			'x.maFile',
			NOW
		);
		expect(parsed.accountName).toBe('testaccount');
	});

	describe('SteamID recovery (F-01)', () => {
		it('reads an unquoted SteamID beyond safe-integer range without corrupting it', () => {
			// Deliberately hand-written: JSON.stringify cannot produce an unquoted
			// integer this large without going through a Number first, which is the
			// exact corruption under test.
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","Session":{"SteamID":76561199999999999}}`;

			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561199999999999');
			expect(parsed.steamIdSource).toBe('Session.SteamID');
			// The whole point: JSON.parse would have produced a different account.
			expect(
				String((JSON.parse(text) as { Session: { SteamID: number } }).Session.SteamID)
			).not.toBe('76561199999999999');
			expect(parsed.warnings.some((w) => w.includes('different account'))).toBe(true);
		});

		it('does not warn about precision when the SteamID is quoted', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","Session":{"SteamID":"76561199999999999"}}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561199999999999');
			expect(parsed.warnings.some((w) => w.includes('different account'))).toBe(false);
		});

		it('prefers Session.SteamID over a top-level steamid', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","steamid":"76561198000000002","Session":{"SteamID":"76561198000000001"}}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000001');
			expect(parsed.steamIdSource).toBe('Session.SteamID');
		});

		it('does not mistake a top-level SteamID for the session one', () => {
			// A whole-document regex found this decoy first and still labelled it
			// `Session.SteamID`: wrong value, wrong label, no warning.
			const text = `{"SteamID":"76561198000000009","shared_secret":"s","identity_secret":"i","account_name":"a","steamid":"76561198000000002"}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000002');
			expect(parsed.steamIdSource).toBe('steamid');
		});

		it('does not let a nested Session.meta.SteamID masquerade as the real one', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","Session":{"meta":{"SteamID":"76561198000000009"},"SteamID":"76561198000000001"}}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000001');
		});

		it('resolves duplicate Session objects the way JSON.parse does — the last one', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","Session":{"SteamID":"76561198000000001"},"Session":{"SteamID":"76561198000000002"}}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000002');
			expect(String((JSON.parse(text) as { Session: { SteamID: string } }).Session.SteamID)).toBe(
				parsed.steamId64
			);
			expect(parsed.warnings.some((w) => w.includes('malformed'))).toBe(true);
		});

		it('resolves duplicate TOP-LEVEL steamid keys the way JSON.parse does', () => {
			// The mirror of the Session case, and it was missed: a first-match regex
			// took the first key while every JSON parser takes the last, so the
			// account was stored under a different account's ID with no warning.
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","steamid":"76561198000000001","steamid":"76561198000000002"}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000002');
			expect(String((JSON.parse(text) as { steamid: string }).steamid)).toBe(parsed.steamId64);
		});

		it('ignores a steamid nested inside some other top-level object', () => {
			// Direct members only: depth matters as much as order.
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","meta":{"steamid":"76561198000000009"},"steamid":"76561198000000001"}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000001');
		});

		it('does not take a nested steamid when there is no top-level one', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","meta":{"steamid":"76561198000000009"}}`;
			const parsed = parseMaFile(text, 'notes.maFile', NOW);

			expect(parsed.steamId64).toBeUndefined();
		});

		it('resolves duplicate keys inside one Session the way JSON.parse does', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","Session":{"SteamID":"76561198000000001","SteamID":"76561198000000002"}}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000002');
		});

		it('falls back to the file name, and says that it did', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a"}`;
			const parsed = parseMaFile(text, '76561198000000001.maFile', NOW);

			expect(parsed.steamId64).toBe('76561198000000001');
			expect(parsed.steamIdSource).toBe('filename');
			expect(parsed.warnings.some((w) => w.includes('file name'))).toBe(true);
		});

		it('reports no SteamID rather than inventing one', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a"}`;
			const parsed = parseMaFile(text, 'notes.maFile', NOW);

			expect(parsed.steamId64).toBeUndefined();
			expect(parsed.warnings.some((w) => w.includes('no SteamID'))).toBe(true);
		});

		it('ignores a SteamID that is not shaped like one', () => {
			const text = `{"shared_secret":"s","identity_secret":"i","account_name":"a","Session":{"SteamID":"12345"}}`;
			const parsed = parseMaFile(text, 'x.maFile', NOW);
			expect(parsed.steamId64).toBeUndefined();
		});
	});

	describe('revocation code', () => {
		it('warns loudly when there is none', () => {
			const text = JSON.stringify({
				shared_secret: 's',
				identity_secret: 'i',
				account_name: 'a',
				steamid: '76561198000000001'
			});
			const parsed = parseMaFile(text, 'x.maFile', NOW);

			expect(parsed.revocationCode).toBeUndefined();
			expect(parsed.warnings.some((w) => w.startsWith('NO REVOCATION CODE'))).toBe(true);
		});
	});

	describe('stored session tokens (F-13)', () => {
		const future = Math.floor(NOW / 1000) + 86_400;
		const past = Math.floor(NOW / 1000) - 86_400;

		it('keeps a live MobileApp refresh token', () => {
			const parsed = parseMaFile(
				maFile({ steamid: '76561198000000001' }, { RefreshToken: mobileToken(future) }),
				'x.maFile',
				NOW
			);
			expect(parsed.refreshToken).toBeDefined();
			expect(parsed.warnings.some((w) => w.includes('no password will be needed'))).toBe(true);
		});

		it('discards an expired token', () => {
			const parsed = parseMaFile(
				maFile({ steamid: '76561198000000001' }, { RefreshToken: mobileToken(past) }),
				'x.maFile',
				NOW
			);
			expect(parsed.refreshToken).toBeUndefined();
			expect(parsed.warnings.some((w) => w.includes('expired'))).toBe(true);
		});

		it('discards a web-scoped token, which would fail only at the first confirmation', () => {
			const webToken = token({ aud: ['client', 'web'], exp: future });
			const parsed = parseMaFile(
				maFile({ steamid: '76561198000000001' }, { RefreshToken: webToken }),
				'x.maFile',
				NOW
			);

			expect(parsed.refreshToken).toBeUndefined();
			expect(parsed.warnings.some((w) => w.includes('scoped for the Steam website'))).toBe(true);
		});

		it('discards an undecodable token instead of storing rubbish', () => {
			const parsed = parseMaFile(
				maFile({ steamid: '76561198000000001' }, { RefreshToken: 'not.a.jwt' }),
				'x.maFile',
				NOW
			);
			expect(parsed.refreshToken).toBeUndefined();
			expect(parsed.warnings.some((w) => w.includes('could not be read'))).toBe(true);
		});

		it('never carries the access token or the web cookie into the vault', () => {
			const parsed = parseMaFile(
				maFile(
					{ steamid: '76561198000000001' },
					{
						AccessToken: mobileToken(future),
						SteamLoginSecure: '76561198000000001%7C%7Ctoken'
					}
				),
				'x.maFile',
				NOW
			);

			// Both are short-lived and re-mintable from the refresh token. Storing
			// them would mean holding a credential the vault has no way to refresh.
			expect(JSON.stringify(parsed)).not.toContain('SteamLoginSecure');
			expect(Object.keys(parsed)).not.toContain('accessToken');
		});
	});

	describe('proxy carried by the file (F-11)', () => {
		it('keeps a usable proxy URL', () => {
			const parsed = parseMaFile(
				maFile({ steamid: '76561198000000001' }, { proxy: 'socks5://user:pass@127.0.0.1:1080' }),
				'x.maFile',
				NOW
			);
			expect(parsed.proxyUrl).toBe('socks5://user:pass@127.0.0.1:1080');
		});

		it('drops one we would not route through, rather than storing it', () => {
			for (const bad of ['not a url', 'file:///etc/passwd', 'javascript:alert(1)']) {
				const parsed = parseMaFile(
					maFile({ steamid: '76561198000000001' }, { proxy: bad }),
					'x.maFile',
					NOW
				);
				expect(parsed.proxyUrl).toBeUndefined();
				expect(parsed.warnings.some((w) => w.includes('not a usable proxy URL'))).toBe(true);
			}
		});
	});

	it('flags a file that was never activated', () => {
		const parsed = parseMaFile(
			maFile({ steamid: '76561198000000001', fully_enrolled: false }),
			'x.maFile',
			NOW
		);
		expect(parsed.fullyEnrolled).toBe(false);
		expect(parsed.warnings.some((w) => w.includes('fully_enrolled'))).toBe(true);
	});
});

describe('jsonspan', () => {
	it('counts Session objects', () => {
		expect(countSessionObjects('{}')).toBe(0);
		expect(countSessionObjects('{"Session":{}}')).toBe(1);
		expect(countSessionObjects('{"Session":{},"Session":{}}')).toBe(2);
	});

	it('is string-aware, so a brace inside a value does not end the object', () => {
		const body = sessionBody('{"Session":{"SteamLoginSecure":"a}b","SteamID":"7"}}');
		expect(body).toContain('SteamID');
	});

	it('returns undefined on unbalanced braces rather than guessing', () => {
		expect(sessionBody('{"Session":{"a":1')).toBeUndefined();
	});

	it('lists only direct members', () => {
		const members = topLevelMembers('"a":1,"b":{"a":2}');
		expect(members?.map((m) => m.key)).toEqual(['a', 'b']);
		expect(membersNamed('"a":1,"b":{"a":2}', 'a')).toHaveLength(1);
	});

	it('refuses a malformed member list', () => {
		expect(topLevelMembers('"a" 1')).toBeUndefined();
		expect(topLevelMembers('a:1')).toBeUndefined();
	});

	it('blanks every Session body, including a duplicate one', () => {
		const masked = outsideSession('{"Session":{"SteamID":1},"Session":{"SteamID":2}}');
		expect(masked).not.toContain('SteamID');
		// Length is preserved so offsets in the masked copy still line up.
		expect(masked).toHaveLength('{"Session":{"SteamID":1},"Session":{"SteamID":2}}'.length);
	});
});
