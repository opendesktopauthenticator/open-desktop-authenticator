import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	RECOVERY_EXTENSION,
	readRecoveryFile,
	RecoveryError,
	recoveryContents,
	recoveryDirectory,
	recoveryFilesFor,
	recoveryPathFor,
	updateRecoveryFile,
	writeRecoveryFile
} from '../src/main/vault/recovery';
import { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

/**
 * The per-account recovery file (§12 F2).
 *
 * The accident it exists for: remove an account from the vault, then discover
 * the revocation code was never written down. The authenticator is still on
 * Steam, the secrets are gone, and Steam Support is the only route left.
 *
 * That makes this the one feature where a silent failure is worse than the
 * feature not existing — somebody who believes they have a backup takes risks
 * they otherwise would not. So these tests are about it being **readable when it
 * is needed**, on a different machine, after the vault it came from is gone.
 */

vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const PASS = 'a sufficiently long passphrase';
const NOW_ISO = '2026-08-10T00:00:00.000Z';

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: '76561199999999999',
		accountName: 'trader',
		sharedSecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
		identitySecret: '/ty6mHZUMhD+3LqYdlQyEP7cupg=',
		revocationCode: 'R12345',
		deviceId: 'android:abc',
		refreshToken: 'a-live-credential',
		status: 'active',
		addedAt: NOW_ISO,
		autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
		...overrides
	};
}

let dir: string;
let vault: VaultService;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'recovery-'));
	vault = new VaultService({ file: join(dir, 'vault.json') });
	await vault.create(PASS);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('what goes into a recovery file', () => {
	it('carries everything needed to restore the authenticator', () => {
		const parsed = JSON.parse(recoveryContents(account(), NOW_ISO)) as {
			account: Account;
			steamId64: string;
		};

		expect(parsed.account.sharedSecret).toBe('ASNFZ4mrze8BI0VniavN7wEjRWc=');
		expect(parsed.account.identitySecret).toBe('/ty6mHZUMhD+3LqYdlQyEP7cupg=');
		expect(parsed.account.revocationCode).toBe('R12345');
		// F-01: the SteamID is a string end to end and must not become a number.
		expect(parsed.steamId64).toBe('76561199999999999');
	});

	it('never carries the refresh token', () => {
		// A recovery file restores an authenticator; it does not resume a session.
		// One that also logs somebody in is a materially worse thing to leave on a
		// disk for months.
		const text = recoveryContents(account(), NOW_ISO);

		expect(text).not.toContain('a-live-credential');
		expect(text).not.toContain('refreshToken');
	});
});

describe('sealing and opening', () => {
	it('opens with the passphrase, on its own, with no vault present', async () => {
		// The whole point. The envelope carries its own salt and KDF parameters, so
		// the file survives the vault it came from being deleted — which is the
		// situation it exists for.
		const envelope = vault.sealForBackup(recoveryContents(account(), NOW_ISO));
		const path = recoveryPathFor(dir, '76561199999999999');
		writeRecoveryFile(path, envelope);

		// Everything about the original vault is gone.
		rmSync(join(dir, 'vault.json'), { force: true });

		const recovered = await readRecoveryFile(readFileSync(path, 'utf8'), PASS);

		expect(recovered.accountName).toBe('trader');
		expect(recovered.account.sharedSecret).toBe('ASNFZ4mrze8BI0VniavN7wEjRWc=');
		expect(recovered.account.revocationCode).toBe('R12345');
	});

	it('refuses a wrong passphrase, loudly', async () => {
		// GCM is authenticated, so this is a clear failure rather than garbage.
		// SDA's AES-CBC would have produced bytes that may or may not parse — the
		// reason this does not use that format.
		const envelope = vault.sealForBackup(recoveryContents(account(), NOW_ISO));

		await expect(readRecoveryFile(JSON.stringify(envelope), 'not the passphrase')).rejects.toThrow(
			RecoveryError
		);
	});

	it('says the same thing for a wrong passphrase and a damaged file', async () => {
		// Distinguishing them tells somebody probing the file which of the two they
		// are up against. The vault behaves the same way.
		const envelope = vault.sealForBackup(recoveryContents(account(), NOW_ISO));
		const damaged = { ...envelope, ciphertext: 'AAAA' };

		const wrongPass = await readRecoveryFile(JSON.stringify(envelope), 'wrong').catch(
			(err: Error) => err.message
		);
		const corrupt = await readRecoveryFile(JSON.stringify(damaged), PASS).catch(
			(err: Error) => err.message
		);

		expect(wrongPass).toBe(corrupt);
	});

	it('refuses something that is not a recovery file at all', async () => {
		await expect(readRecoveryFile('not json', PASS)).rejects.toThrow(RecoveryError);
		await expect(readRecoveryFile('{"a":1}', PASS)).rejects.toThrow(RecoveryError);
	});

	it('refuses a valid vault sealed under the same key but holding something else', async () => {
		// Decrypting is not the same as being what we asked for. A whole vault
		// sealed with this key opens fine and is not an account recovery file.
		const notRecovery = vault.sealForBackup(JSON.stringify({ accounts: [] }));

		await expect(readRecoveryFile(JSON.stringify(notRecovery), PASS)).rejects.toThrow(
			/not an account recovery file/
		);
	});

	it('refuses to seal while the vault is locked', () => {
		vault.lock();
		expect(() => vault.sealForBackup('{}')).toThrow();
	});
});

describe('the file on disk', () => {
	it('is owner-only', () => {
		// Encrypted, so this is defence in depth — but there is no reason another
		// user on the machine should be able to copy it and attack the passphrase
		// offline at their leisure.
		const path = recoveryPathFor(dir, '76561199999999999');
		writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)));

		if (process.platform !== 'win32') {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(statSync(path).isFile()).toBe(true);
	});

	it('contains no plaintext secret', () => {
		const path = recoveryPathFor(dir, '76561199999999999');
		writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)));

		const raw = readFileSync(path, 'utf8');
		expect(raw).not.toContain('ASNFZ4mrze8BI0VniavN7wEjRWc=');
		expect(raw).not.toContain('R12345');
		expect(raw).not.toContain('trader');
	});

	it('is named so it cannot be mistaken for a maFile', () => {
		// A file that looks like a maFile invites being fed to SDA, which cannot
		// read it, and to our own importer, which would reject it confusingly.
		expect(recoveryPathFor(dir, '76561199999999999')).toContain(RECOVERY_EXTENSION);
		expect(RECOVERY_EXTENSION).not.toContain('maFile');
	});

	it('updates in place without ever leaving a half-written file', () => {
		// The correction applied after activation. It overwrites on purpose — unlike
		// `writeRecoveryFile` — so it has to be atomic: a truncated recovery file is
		// worse than a stale one, and this is the file somebody reaches for when
		// everything else has already gone wrong.
		const path = recoveryPathFor(dir, '76561199999999999');
		const written = writeRecoveryFile(
			path,
			vault.sealForBackup(recoveryContents(account(), NOW_ISO))
		);
		expect(written).toBe(path);

		updateRecoveryFile(
			written,
			vault.sealForBackup(recoveryContents(account({ status: 'active' }), NOW_ISO))
		);

		return readRecoveryFile(readFileSync(path, 'utf8'), PASS).then((recovered) => {
			expect(recovered.account.status).toBe('active');
			// One file, not two: this is a correction, not a second backup.
			expect(
				readdirSync(recoveryDirectory(dir)).filter((name) => name.endsWith(RECOVERY_EXTENSION))
			).toHaveLength(1);
			// And no temp file left behind.
			expect(readdirSync(recoveryDirectory(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
		});
	});

	it('finds the one file for an account written by an earlier run', () => {
		// The correction after activation normally happens in a *later* process than
		// the enrollment — a crash between the two is the case the recovery file
		// exists for. The in-memory record of where the file went is gone by then,
		// so the file has to be found on disk.
		const path = recoveryPathFor(dir, '76561199999999999');
		writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)));

		expect(recoveryFilesFor(dir, '76561199999999999')).toEqual([path]);
	});

	it('reports both when an earlier enrollment left one behind', () => {
		// Two files means the caller must not act: nothing here can say which of
		// them belongs to the account being activated, and rewriting the wrong one
		// destroys a backup for an authenticator that account no longer has.
		const path = recoveryPathFor(dir, '76561199999999999');
		writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)));
		writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)));

		expect(recoveryFilesFor(dir, '76561199999999999')).toHaveLength(2);
	});

	it('does not confuse one account with another whose id is a prefix', () => {
		writeRecoveryFile(
			recoveryPathFor(dir, '76561199999999999'),
			vault.sealForBackup(recoveryContents(account(), NOW_ISO))
		);

		expect(recoveryFilesFor(dir, '7656119999999999')).toHaveLength(0);
	});

	it('answers with nothing when the directory does not exist yet', () => {
		expect(recoveryFilesFor(join(dir, 'nope'), '76561199999999999')).toEqual([]);
	});

	it('reports the path it actually used when one already exists', () => {
		// The caller needs this to correct the right file later. Updating the
		// primary path when the write landed beside it would overwrite an older
		// enrollment's only copy.
		const path = recoveryPathFor(dir, '76561199999999999');
		writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)));

		const second = writeRecoveryFile(
			path,
			vault.sealForBackup(recoveryContents(account(), NOW_ISO))
		);

		expect(second).not.toBe(path);
		expect(second).toContain(RECOVERY_EXTENSION);
	});

	it('never replaces a recovery file that is already there', () => {
		// This is the one file in the application whose whole purpose is to still be
		// there later. Enrolling the same account twice aims at the same path, so
		// overwriting would silently swap a backup of the previous authenticator for
		// one of the new one — destroying the copy somebody may be about to need.
		const path = recoveryPathFor(dir, '76561199999999999');
		writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)));
		const first = readFileSync(path, 'utf8');

		writeRecoveryFile(
			path,
			vault.sealForBackup(recoveryContents(account({ revocationCode: 'R99999' }), NOW_ISO))
		);

		// The original is untouched, and the second one landed beside it.
		expect(readFileSync(path, 'utf8')).toBe(first);
		const siblings = readdirSync(recoveryDirectory(dir)).filter((name) =>
			name.endsWith(RECOVERY_EXTENSION)
		);
		expect(siblings).toHaveLength(2);
	});

	it('creates its directory rather than failing when it is missing', () => {
		const path = join(dir, 'does', 'not', 'exist', `1${RECOVERY_EXTENSION}`);
		expect(() =>
			writeRecoveryFile(path, vault.sealForBackup(recoveryContents(account(), NOW_ISO)))
		).not.toThrow();
	});
});
