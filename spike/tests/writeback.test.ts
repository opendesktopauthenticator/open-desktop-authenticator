import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistTokens, setSessionField } from '../src/writeback';
import { parseMaFile } from '../src/mafile';

/**
 * The maFile being written is often the only copy of an account's revocation
 * code. These tests are about not destroying it.
 */

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'spike-writeback-'));
	delete process.env.SPIKE_NO_WRITEBACK;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
	const p = join(dir, name);
	writeFileSync(p, content, 'utf8');
	return p;
}

/** SDA's real shape: unquoted big SteamID, fields our schema does not model. */
const SDA_STYLE = `{
  "shared_secret": "KrbnbF2lShuAa/mL6vPz1rs1ncY=",
  "identity_secret": "7TslCCxb+eOdtAzs4bMFAN5g+9Q=",
  "account_name": "writebacktest",
  "revocation_code": "R12345",
  "secret_1": "aGVsbG93b3JsZA==",
  "error_sch": null,
  "token_gid": "abcdef0123456789",
  "Session": {
    "SteamID": 76561199999999999,
    "RefreshToken": "old-refresh",
    "SessionID": "0123456789abcdef"
  }
}
`;

describe('token write-back', () => {
	it('does NOT corrupt an unquoted SteamID larger than MAX_SAFE_INTEGER', () => {
		const p = write('sda.maFile', SDA_STYLE);
		const result = persistTokens(p, { refreshToken: 'new-refresh' });

		expect(result.status).toBe('written');
		const after = readFileSync(p, 'utf8');
		// A JSON.parse/stringify round-trip would have rewritten this to
		// 76561200000000000 — a different account.
		expect(after).toContain('"SteamID": 76561199999999999');
		expect(parseMaFile(p).steamId64).toBe('76561199999999999');
	});

	it('preserves fields the schema does not model', () => {
		const p = write('sda.maFile', SDA_STYLE);
		persistTokens(p, { refreshToken: 'new-refresh' });

		const after = readFileSync(p, 'utf8');
		for (const field of ['secret_1', 'error_sch', 'token_gid', 'SessionID', 'revocation_code']) {
			expect(after, `${field} was dropped`).toContain(field);
		}
	});

	it('changes only the token, leaving the rest byte-identical', () => {
		const p = write('sda.maFile', SDA_STYLE);
		persistTokens(p, { refreshToken: 'new-refresh' });

		const after = readFileSync(p, 'utf8');
		expect(after).toBe(SDA_STYLE.replace('"old-refresh"', '"new-refresh"'));
	});

	it('inserts a field that was absent rather than silently doing nothing', () => {
		const p = write('sda.maFile', SDA_STYLE);
		const result = persistTokens(p, { accessToken: 'minted-access' });

		expect(result.status).toBe('written');
		const after = readFileSync(p, 'utf8');
		expect(after).toContain('"AccessToken": "minted-access"');
		expect(() => JSON.parse(after)).not.toThrow();
	});

	it('keeps a backup of the previous version', () => {
		const p = write('sda.maFile', SDA_STYLE);
		const result = persistTokens(p, { refreshToken: 'new-refresh' });

		expect(result.status).toBe('written');
		if (result.status === 'written') {
			expect(existsSync(result.backupPath)).toBe(true);
			expect(readFileSync(result.backupPath, 'utf8')).toBe(SDA_STYLE);
		}
	});

	it('leaves no temp file behind', () => {
		const p = write('sda.maFile', SDA_STYLE);
		persistTokens(p, { refreshToken: 'new-refresh' });
		expect(existsSync(`${p}.tmp`)).toBe(false);
	});

	it('reports unchanged rather than rewriting an identical value', () => {
		const p = write('sda.maFile', SDA_STYLE);
		expect(persistTokens(p, { refreshToken: 'old-refresh' }).status).toBe('unchanged');
		// No pointless backup churn either.
		expect(existsSync(`${p}.bak`)).toBe(false);
	});

	it('refuses to touch a file that is not plain JSON', () => {
		const p = write('encrypted.maFile', 'Ci8vbm90LWpzb24tYXQtYWxs\n');
		const result = persistTokens(p, { refreshToken: 'x' });
		expect(result.status).toBe('skipped');
		expect(readFileSync(p, 'utf8')).toBe('Ci8vbm90LWpzb24tYXQtYWxs\n');
	});

	it('refuses a file with no Session object', () => {
		const p = write(
			'bare.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c"}'
		);
		expect(persistTokens(p, { refreshToken: 'x' }).status).toBe('skipped');
	});

	it('honours SPIKE_NO_WRITEBACK', () => {
		process.env.SPIKE_NO_WRITEBACK = '1';
		const p = write('sda.maFile', SDA_STYLE);
		expect(persistTokens(p, { refreshToken: 'new-refresh' }).status).toBe('disabled');
		expect(readFileSync(p, 'utf8')).toBe(SDA_STYLE);
	});

	it('escapes a value that would otherwise break the JSON', () => {
		const p = write('sda.maFile', SDA_STYLE);
		const nasty = 'has"quote\\and\\backslash';
		persistTokens(p, { refreshToken: nasty });

		const after = readFileSync(p, 'utf8');
		expect(() => JSON.parse(after)).not.toThrow();
		expect(JSON.parse(after).Session.RefreshToken).toBe(nasty);
	});

	it('survives repeated writes without drift', () => {
		const p = write('sda.maFile', SDA_STYLE);
		for (let i = 0; i < 50; i++) {
			const result = persistTokens(p, { refreshToken: `token-${i}` });
			expect(result.status).toBe('written');
		}
		const after = readFileSync(p, 'utf8');
		expect(JSON.parse(after).Session.RefreshToken).toBe('token-49');
		// Structure must not have accumulated damage.
		expect(after).toContain('"SteamID": 76561199999999999');
		expect(after).toContain('"secret_1"');
		expect(parseMaFile(p).revocationCode).toBe('R12345');
	});
});

describe('Session scoping (regression)', () => {
	/**
	 * A whole-file regex matched the FIRST occurrence of a key name anywhere in
	 * the document. With a decoy key outside Session, the write landed on the
	 * decoy and the verification step — reading the same wrong place — reported
	 * success.
	 */
	const DECOY = `{
  "shared_secret": "a", "identity_secret": "b", "account_name": "c",
  "RefreshToken": "DECOY-TOP-LEVEL",
  "Session": { "SteamID": "76561199999999999", "RefreshToken": "REAL-IN-SESSION" }
}`;

	it('writes into Session, never a same-named key elsewhere', () => {
		const p = write('decoy.maFile', DECOY);
		const result = persistTokens(p, { refreshToken: 'NEWVALUE' });
		expect(result.status).toBe('written');

		const after = JSON.parse(readFileSync(p, 'utf8')) as {
			RefreshToken: string;
			Session: { RefreshToken: string };
		};
		expect(after.Session.RefreshToken).toBe('NEWVALUE');
		expect(after.RefreshToken).toBe('DECOY-TOP-LEVEL');
	});

	it('reads the Session value, not the decoy, when deciding what changed', () => {
		const p = write('decoy2.maFile', DECOY);
		// Matches the decoy but NOT the Session value, so a write is still required.
		expect(persistTokens(p, { refreshToken: 'DECOY-TOP-LEVEL' }).status).toBe('written');
		const after = JSON.parse(readFileSync(p, 'utf8')) as { Session: { RefreshToken: string } };
		expect(after.Session.RefreshToken).toBe('DECOY-TOP-LEVEL');
	});

	it('inserts into an empty Session without producing invalid JSON', () => {
		// The naive insert emitted `{ "X": "v", }` — a trailing comma with nothing
		// after it — so the write was always rejected for such files.
		const p = write(
			'emptysession.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c","Session":{}}'
		);
		const result = persistTokens(p, { refreshToken: 'X' });
		expect(result.status).toBe('written');
		const after = readFileSync(p, 'utf8');
		expect(() => JSON.parse(after)).not.toThrow();
		expect((JSON.parse(after) as { Session: { RefreshToken: string } }).Session.RefreshToken).toBe(
			'X'
		);
	});

	it('replaces a NON-string value instead of inserting a duplicate key', () => {
		// Matching only quoted values meant `"RefreshToken": 123` fell through to the
		// insert branch, producing a second key. Verification read the first (our new
		// string) and reported success, while JSON.parse resolved the duplicate to
		// the last one and still returned 123.
		const p = write(
			'numeric.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c","Session":{"RefreshToken":123}}'
		);
		expect(persistTokens(p, { refreshToken: 'NEWTOKEN' }).status).toBe('written');

		const after = readFileSync(p, 'utf8');
		expect((JSON.parse(after) as { Session: { RefreshToken: string } }).Session.RefreshToken).toBe(
			'NEWTOKEN'
		);
		// Exactly one key, not two.
		expect(after.match(/"RefreshToken"/g)).toHaveLength(1);
	});

	it('refuses to rewrite a key holding an object or array', () => {
		const p = write(
			'objvalue.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c","Session":{"RefreshToken":{"nested":1}}}'
		);
		expect(persistTokens(p, { refreshToken: 'x' }).status).toBe('skipped');
	});

	it('refuses a document with duplicate Session objects', () => {
		// We would edit the first; JSON.parse resolves to the last. Rather than
		// guess which one the user means, refuse — otherwise the write reports
		// success against an object nobody reads.
		const p = write(
			'dupsession.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c",' +
				'"Session":{"RefreshToken":"FIRST"},"Session":{"RefreshToken":"SECOND"}}'
		);
		const result = persistTokens(p, { refreshToken: 'NEWTOKEN' });
		expect(result.status).toBe('skipped');
		expect(readFileSync(p, 'utf8')).toContain('"SECOND"');
	});

	it('refuses duplicate keys INSIDE one Session', () => {
		// `String.replace` with a non-global regex rewrites the FIRST match while
		// JSON.parse resolves to the LAST. Rewriting the first reported success
		// against a value no consumer reads — the same trap as duplicate Session
		// objects, one level down.
		const p = write(
			'dupkey.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c",' +
				'"Session":{"RefreshToken":"FIRST","RefreshToken":"SECOND"}}'
		);
		const result = persistTokens(p, { refreshToken: 'NEW' });
		expect(result.status).toBe('skipped');

		const after = readFileSync(p, 'utf8');
		expect(after).not.toContain('NEW');
		expect((JSON.parse(after) as { Session: { RefreshToken: string } }).Session.RefreshToken).toBe(
			'SECOND'
		);
	});

	it('refuses duplicate keys even when the FIRST already holds the new value', () => {
		// The nastiest shape: `currentValue` read the first occurrence, saw it
		// already matched, and reported `unchanged` — while JSON.parse resolved to
		// the stale second one. The write silently never happened AND the caller
		// was told nothing needed doing.
		const p = write(
			'dupfirstmatch.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c",' +
				'"Session":{"RefreshToken":"NEW","RefreshToken":"OLD"}}'
		);
		const result = persistTokens(p, { refreshToken: 'NEW' });
		expect(result.status).toBe('skipped');
		expect(
			(JSON.parse(readFileSync(p, 'utf8')) as { Session: { RefreshToken: string } }).Session
				.RefreshToken
		).toBe('OLD');
	});

	it('ignores a same-named key nested inside Session', () => {
		// Scope alone was not enough — depth matters too. Matching anywhere in the
		// Session body hit `Session.meta.RefreshToken`, rewrote that, and reported
		// success while `Session.RefreshToken` stayed absent entirely.
		const p = write(
			'nested.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c",' +
				'"Session":{"meta":{"RefreshToken":"nested"},"SteamID":"76561199999999999"}}'
		);
		expect(persistTokens(p, { refreshToken: 'NEW' }).status).toBe('written');

		const after = JSON.parse(readFileSync(p, 'utf8')) as {
			Session: { RefreshToken: string; meta: { RefreshToken: string } };
		};
		expect(after.Session.RefreshToken).toBe('NEW');
		expect(after.Session.meta.RefreshToken).toBe('nested');
	});

	it('refuses a file whose Session braces are unbalanced', () => {
		const p = write('broken.maFile', '{"Session":{"RefreshToken":"x"');
		expect(persistTokens(p, { refreshToken: 'y' }).status).toBe('skipped');
	});

	it('is not confused by braces inside string values', () => {
		const p = write(
			'braces.maFile',
			'{"shared_secret":"a","identity_secret":"b","account_name":"c",' +
				'"Session":{"WebCookie":"has}brace{inside","RefreshToken":"old"}}'
		);
		expect(persistTokens(p, { refreshToken: 'new' }).status).toBe('written');
		const after = JSON.parse(readFileSync(p, 'utf8')) as {
			Session: { RefreshToken: string; WebCookie: string };
		};
		expect(after.Session.RefreshToken).toBe('new');
		expect(after.Session.WebCookie).toBe('has}brace{inside');
	});
});

describe('setSessionField', () => {
	it('returns the text unchanged when there is no Session object', () => {
		const raw = '{"a":1}';
		expect(setSessionField(raw, 'RefreshToken', 'x')).toBe(raw);
	});

	it('replaces an empty string value', () => {
		const raw = '{"Session":{"RefreshToken":""}}';
		expect(setSessionField(raw, 'RefreshToken', 'v')).toBe('{"Session":{"RefreshToken":"v"}}');
	});

	it('tolerates whitespace variants around the colon', () => {
		const raw = '{"Session":{"RefreshToken"   :    "old"}}';
		expect(JSON.parse(setSessionField(raw, 'RefreshToken', 'v')).Session.RefreshToken).toBe('v');
	});
});
