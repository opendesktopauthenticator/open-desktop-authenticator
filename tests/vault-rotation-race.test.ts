import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultService } from '../src/main/vault/service';

/**
 * A save that completes while a passphrase rotation is deriving its key.
 *
 * Rotation is two writes that have to succeed or fail together: the vault under
 * the new key, and the backup re-sealed under it as well. Between the caller
 * asking and either write happening sits `deriveKey` — scrypt at the shipping
 * work factor, the better part of a second, deliberately. Anything the
 * application does in that second completes in full: an account enrolled, a
 * refresh token stored, an import committed.
 *
 * `contents` was already read after the derivation for exactly that reason. The
 * other two values the transaction depends on were not, and nothing said so:
 *
 *   - the plaintext written into the backup, so a successful rotation left a
 *     backup one save older than the state it claimed to be preserving;
 *   - **the envelope the rollback restores.** That one is not a staleness
 *     problem, it is data loss. A backup write that failed put the
 *     pre-derivation file back over a vault that had moved on, destroying the
 *     save that completed in between — under a message that says in as many
 *     words "Nothing was altered — try again."
 *
 * Both are driven here through the real service with real scrypt, interleaving
 * the save the way the application does rather than mocking the timing. `mutate`
 * has no await in it, so starting the rotation and then saving without awaiting
 * it puts the save inside the derivation window every time.
 */

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'oda-rotation-race-'));
	file = join(dir, 'vault.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OLD = 'the-passphrase-this-vault-was-made-with';
const NEW = 'a-different-passphrase-long-enough-too';

const service = () => new VaultService({ file });

/** Enough of an account to be stored and counted. */
function account(steamId64: string) {
	return {
		steamId64,
		accountName: `account-${steamId64}`,
		sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
		identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
		revocationCode: 'R12345',
		serialNumber: '1234567890',
		uri: `otpauth://totp/Steam:${steamId64}?secret=AAAA&issuer=Steam`,
		addedAt: '2026-01-01T00:00:00.000Z',
		status: 'active'
	};
}

async function withAccount(vault: VaultService, steamId64: string): Promise<void> {
	await vault.mutate((draft) => {
		draft.accounts.push(account(steamId64) as never);
	});
}

const ids = (vault: VaultService): string[] =>
	vault
		.read()
		.accounts.map((entry) => entry.steamId64)
		.sort();

describe('a save that lands during a rotation key derivation', () => {
	it('survives a successful rotation', async () => {
		const vault = service();
		await vault.create(OLD);
		await withAccount(vault, '76561199000000001');

		// Not awaited: the save below runs inside the scrypt.
		const rotating = vault.changePassphrase(OLD, NEW);
		await withAccount(vault, '76561199000000002');
		await rotating;

		expect(
			ids(vault),
			'the account enrolled during the derivation is gone from the open vault'
		).toEqual(['76561199000000001', '76561199000000002']);

		// And on disk, under the new passphrase.
		const reopened = service();
		await reopened.unlock(NEW);
		expect(ids(reopened)).toEqual(['76561199000000001', '76561199000000002']);
	});

	/**
	 * The backup is re-sealed under the new key rather than copied, because a copy
	 * is still readable with the passphrase being retired. What it should hold is
	 * the vault as it stood when the rotation began — which includes anything that
	 * completed while the key was being derived.
	 */
	it('is in the backup the rotation writes', async () => {
		const vault = service();
		await vault.create(OLD);
		await withAccount(vault, '76561199000000001');

		const rotating = vault.changePassphrase(OLD, NEW);
		await withAccount(vault, '76561199000000002');
		await rotating;

		// Restoring replaces the live vault, so it refuses while one is open.
		const restored = service();
		await restored.unlock(NEW);
		restored.lock();
		await restored.restoreFromBackup(NEW);
		await restored.unlock(NEW);

		expect(
			ids(restored),
			'the backup preserved a state one save older than the vault it was taken from, so ' +
				'restoring it silently discards an account the user had already enrolled'
		).toEqual(['76561199000000001', '76561199000000002']);
	});

	/**
	 * **The one that loses data.**
	 *
	 * A directory where the backup file goes makes `writeBackupEnvelope` fail
	 * after the main vault has already been rewritten, which is the branch that
	 * rolls back. The rollback must put back the vault as it is *now*, not as it
	 * was before the derivation — and it must say nothing was altered only if
	 * nothing was.
	 */
	it('survives a rotation that rolls back because the backup could not be written', async () => {
		const vault = service();
		await vault.create(OLD);
		await withAccount(vault, '76561199000000001');

		/*
		 * A directory where `writeBackupEnvelope` opens its temp file, so that write
		 * fails and nothing else does. Blocking `.bak` itself would be wrong: the
		 * main vault write copies the old file there on its way past, so it would
		 * fail first and the rollback branch would never be reached.
		 */
		mkdirSync(`${file}.bak.tmp`, { recursive: true });

		const rotating = vault.changePassphrase(OLD, NEW);
		await withAccount(vault, '76561199000000002');
		await expect(rotating).rejects.toThrow(/passphrase was not changed|could not be put back/);

		rmSync(`${file}.bak.tmp`, { recursive: true, force: true });

		const reopened = service();
		// The rotation was undone, so the old passphrase is the one that works.
		await reopened.unlock(OLD);
		expect(
			ids(reopened),
			'the rollback restored the file as it was before the key derivation and destroyed the ' +
				'account enrolled during it — while telling the user nothing had been altered'
		).toEqual(['76561199000000001', '76561199000000002']);
	});
});
