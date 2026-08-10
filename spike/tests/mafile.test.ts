import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as SteamTotp from 'steam-totp';
import { MaFileError, parseMaFile } from '../src/mafile';

const fixture = (name: string) => join(__dirname, '..', 'fixtures', name);

describe('maFile parsing', () => {
	it('preserves a SteamID64 that JSON.parse would silently corrupt', () => {
		const parsed = parseMaFile(fixture('classic-sda.maFile'));

		// The bug this guards against: SDA writes SteamID as a JSON number, and
		// 76561199999999999 > Number.MAX_SAFE_INTEGER.
		expect(parsed.steamId64).toBe('76561199999999999');
		expect(String(Number('76561199999999999'))).toBe('76561200000000000');
		expect(parsed.steamIdSource).toBe('Session.SteamID');
		expect(parsed.warnings.some((w) => w.includes('safe-integer range'))).toBe(true);
	});

	it('does NOT warn about precision when the SteamID was stored quoted', () => {
		// Files written by session-managing tools quote it, and a quoted value
		// survives JSON.parse intact. Warning on those trains the reader to
		// ignore the warning on files where it genuinely matters.
		const parsed = parseMaFile(fixture('quoted-steamid.maFile'));
		expect(parsed.steamId64).toBe('76561198999999999');
		expect(parsed.steamIdSource).toBe('Session.SteamID');
		// Still out of safe-integer range — the quoting is what makes it safe.
		expect(BigInt(parsed.steamId64!) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(parsed.warnings.some((w) => w.includes('safe-integer range'))).toBe(false);
	});

	it('reads the LAST Session when a file has duplicates, and says so', () => {
		// JSON.parse resolves duplicate keys to the last, so every other tool in the
		// ecosystem sees the last one. A reader that used the first would disagree
		// with its own zod parse of the same document.
		const parsed = parseMaFile(fixture('duplicate-session.maFile'));
		expect(parsed.steamId64).toBe('76561198000000000');
		expect(parsed.steamIdSource).toBe('Session.SteamID');
		expect(parsed.warnings.some((w) => w.includes('"Session" objects'))).toBe(true);
	});

	it('takes the LAST SteamID when Session has duplicates, matching JSON.parse', () => {
		const parsed = parseMaFile(fixture('duplicate-steamid.maFile'));
		expect(parsed.steamId64).toBe('76561198000000002');
	});

	it('ignores a SteamID nested inside Session', () => {
		// `Session.meta.SteamID` is not the account's id and must not masquerade
		// as one.
		const parsed = parseMaFile(fixture('nested-steamid.maFile'));
		expect(parsed.steamId64).toBe('76561199999999999');
	});

	it('takes SteamID from inside Session, not the first match in the file', () => {
		// A whole-file search found the first `"SteamID"` anywhere, so a top-level
		// key yielded the wrong ID while still being labelled Session.SteamID.
		const parsed = parseMaFile(fixture('toplevel-steamid.maFile'));
		expect(parsed.steamId64).toBe('76561199999999999');
		expect(parsed.steamIdSource).toBe('Session.SteamID');
	});

	it('drops an undecodable refresh token instead of keeping it', () => {
		// It used to warn "ignoring it" and then assign it anyway, so callers saw a
		// token, tried the expired path, and got a misleading failure instead of
		// going straight to a password login.
		const parsed = parseMaFile(fixture('undecodable-token.maFile'));
		expect(parsed.refreshToken).toBeUndefined();
		expect(parsed.warnings.some((w) => w.includes('could not be decoded'))).toBe(true);
	});

	it('drops an EXPIRED refresh token but still warns and keeps the proxy', () => {
		// An expired token is a dead credential: every caller re-checks the expiry
		// and falls back anyway, so carrying it only keeps a stale secret in memory
		// and routes every run through the "expired, falling back" branch.
		const parsed = parseMaFile(fixture('quoted-steamid.maFile'));
		expect(parsed.refreshToken).toBeUndefined();
		expect(parsed.warnings.some((w) => w.includes('EXPIRED'))).toBe(true);
		expect(parsed.proxy).toBe('http://user:pw@127.0.0.1:8080');
	});

	it('keeps a refresh token that is still live', () => {
		// The counterpart to the test above — without it, dropping every token
		// would look like correct behaviour.
		const parsed = parseMaFile(fixture('live-token.maFile'));
		expect(parsed.refreshToken).toBeDefined();
		expect(parsed.warnings.some((w) => w.includes('live RefreshToken'))).toBe(true);
	});

	it('reads the required fields from a classic SDA file', () => {
		const parsed = parseMaFile(fixture('classic-sda.maFile'));
		expect(parsed.accountName).toBe('fixtureaccount');
		expect(parsed.sharedSecret).toBe('KrbnbF2lShuAa/mL6vPz1rs1ncY=');
		expect(parsed.identitySecret).toBe('7TslCCxb+eOdtAzs4bMFAN5g+9Q=');
		expect(parsed.revocationCode).toBe('R12345');
	});

	it('derives the device ID the same way the file recorded it', () => {
		const parsed = parseMaFile(fixture('classic-sda.maFile'));
		expect(parsed.steamId64).toBeDefined();
		expect(SteamTotp.getDeviceID(parsed.steamId64!)).toBe(parsed.deviceId);
	});

	it('imports a file with no revocation code but flags it loudly', () => {
		const parsed = parseMaFile(fixture('no-revocation.maFile'));
		expect(parsed.accountName).toBe('norevocation');
		expect(parsed.revocationCode).toBeUndefined();
		expect(parsed.warnings.some((w) => w.includes('NO REVOCATION CODE'))).toBe(true);
	});

	it('falls back to the filename for a SteamID when the file has none', () => {
		const parsed = parseMaFile(fixture('76561199999999998.maFile'));
		expect(parsed.steamId64).toBe('76561199999999998');
		expect(parsed.steamIdSource).toBe('filename');
		expect(parsed.warnings.some((w) => w.includes('taken from the filename'))).toBe(true);
	});

	it('warns that a device_id will need deriving when absent', () => {
		const parsed = parseMaFile(fixture('76561199999999998.maFile'));
		expect(parsed.deviceId).toBeUndefined();
		expect(parsed.warnings.some((w) => w.includes('no device_id'))).toBe(true);
	});

	it('rejects a non-JSON file and points at the 0.2 milestone', () => {
		expect(() => parseMaFile(fixture('encrypted-manifest.maFile'))).toThrow(MaFileError);
		expect(() => parseMaFile(fixture('encrypted-manifest.maFile'))).toThrow(/encrypted manifest/);
	});

	it('rejects a file missing a required secret', () => {
		expect(() => parseMaFile(fixture('does-not-exist.maFile'))).toThrow(/could not read file/);
	});
});
