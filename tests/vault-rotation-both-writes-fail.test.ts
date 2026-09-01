import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultService } from '../src/main/vault/service';

/**
 * **A rotation whose backup write fails and whose rollback fails too.**
 *
 * The main vault has already been rewritten under the new key by then, and
 * cannot be put back. The error said exactly that — "Your vault now opens with
 * the NEW passphrase; the backup file still opens with the old one and should be
 * deleted" — and then wiped the new key and threw, leaving the still-unlocked
 * session holding the **retired** key and the pre-rotation contents.
 *
 * So the next ordinary save sealed with the old key and wrote it over the file,
 * and `writeEnvelope` copied the new-key file into `.bak` on its way past. Both
 * halves of that sentence inverted: the vault opened with the old passphrase
 * again, and the backup became the only file the new one opened. A user who did
 * exactly what they were told — start using the new passphrase, delete the
 * backup — was left with neither.
 *
 * No user action is needed to reach that save. The confirmation poller stores
 * refresh tokens through the same `mutate`.
 *
 * ## Why this file has its own filesystem mock
 *
 * `writeEnvelope` and `restoreEnvelopeInPlace` open the same temp path, so the
 * trick `vault-rotation-race.test.ts` uses — a directory where the temp file
 * goes — cannot fail the second without also failing the first, and the rotation
 * would abort before it ever reached the backup. The mock fails the backup's
 * temp and then, only afterwards, the vault's: the shape a disk that fills
 * between two writes in the same directory produces.
 */

const state = vi.hoisted(() => ({ armed: false, backupAttempted: false }));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		openSync: (path: unknown, ...rest: unknown[]) => {
			if (state.armed && typeof path === 'string') {
				if (path.endsWith('.bak.tmp')) {
					state.backupAttempted = true;
					throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
				}
				if (state.backupAttempted && path.endsWith('.tmp')) {
					throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
				}
			}
			return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
		}
	};
});

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'oda-rotation-both-'));
	file = join(dir, 'vault.json');
	state.armed = false;
	state.backupAttempted = false;
});

afterEach(() => {
	state.armed = false;
	state.backupAttempted = false;
	rmSync(dir, { recursive: true, force: true });
});

const OLD = 'the-passphrase-this-vault-was-made-with';
const NEW = 'a-different-passphrase-long-enough-too';

const service = () => new VaultService({ file });

function account(steamId64: string) {
	return {
		steamId64,
		accountName: `account-${steamId64}`,
		sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
		identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
		status: 'active',
		addedAt: '2026-01-01T00:00:00.000Z'
	};
}

async function withAccount(vault: VaultService, steamId64: string): Promise<void> {
	await vault.mutate((draft: { accounts: unknown[] }) => {
		draft.accounts.push(account(steamId64));
	});
}

/** Run a rotation with both writes failing, and return the still-open session. */
async function rotateWithBothFailing() {
	const vault = service();
	await vault.create(OLD);
	await withAccount(vault, '76561199000000001');

	state.armed = true;
	await expect(
		vault.changePassphrase(OLD, NEW),
		'the rotation did not reach the branch where both the backup and the rollback fail'
	).rejects.toThrow(/NEW passphrase/);
	state.armed = false;
	state.backupAttempted = false;

	return vault;
}

describe('when the backup write and the rollback both fail', () => {
	it('says the vault opens with the new passphrase, and it does', async () => {
		await rotateWithBothFailing();

		const reopened = service();
		await expect(
			reopened.unlock(NEW),
			'the message tells the user the vault now opens with the new passphrase, and it does not'
		).resolves.not.toThrow();
	});

	/**
	 * **The half that was wrong.** Nothing locks the session after the failure,
	 * and the save needs no user action: the confirmation poller stores refresh
	 * tokens through this same call.
	 */
	it('does not let the next ordinary save put the old passphrase back', async () => {
		const vault = await rotateWithBothFailing();

		await withAccount(vault, '76561199000000002');

		const reopened = service();
		await expect(
			reopened.unlock(NEW),
			'one save by the still-open session sealed the vault with the retired key again, so the ' +
				'passphrase the user was told to start using no longer opens their vault'
		).resolves.not.toThrow();
		expect(reopened.read().accounts.map((entry: { steamId64: string }) => entry.steamId64)).toEqual(
			['76561199000000001', '76561199000000002']
		);
	});

	it('does not leave the old passphrase working either', async () => {
		const vault = await rotateWithBothFailing();
		await withAccount(vault, '76561199000000002');

		const reopened = service();
		await expect(
			reopened.unlock(OLD),
			'the retired passphrase still opens the vault, so the rotation the user was told had ' +
				'happened did not'
		).rejects.toThrow();
	});

	/*
	 * And the session's own view matches the file. `seq` is documented as
	 * detecting a rolled-back write; two states shipping under the same number is
	 * that field failing at the one job it has.
	 */
	it('leaves the open session consistent with what is on disk', async () => {
		const vault = await rotateWithBothFailing();
		const inMemory = vault.read();

		const reopened = service();
		await reopened.unlock(NEW);
		expect(reopened.read().seq).toBe(inMemory.seq);
	});
});
