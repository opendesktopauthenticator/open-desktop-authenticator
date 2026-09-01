import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultService } from '../src/main/vault/service';

/**
 * **A rotation is two writes, and there is a gap between them.**
 *
 * The vault goes first, sealed under the new key; the backup is re-sealed under
 * the same key a moment later. Lose power in between and the vault opens with
 * the new passphrase while `vault.json.bak` still opens with the retired one.
 *
 * That is not a small window and it is not a small consequence. Re-sealing the
 * backup exists precisely because a copy readable with a passphrase the user has
 * just retired hands back every account in it, and the Settings screen promises
 * the opposite in as many words. Closing that at the write and leaving it open at
 * the crash boundary fixes the case nobody was worried about.
 *
 * So the rotation writes down what it owes before it does anything, and
 * `reconcile` pays the debt on the next start. The journal holds the finished
 * backup envelope, already sealed under the new key, so finishing needs nothing
 * the process no longer has — not the passphrase, not the old key, not the
 * plaintext.
 */

const state = vi.hoisted(() => ({
	crashAfterVaultWrite: false,
	backupAttempted: false,
	refuseBackupWrite: false,
	backupWrites: 0
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		openSync: (path: unknown, ...rest: unknown[]) => {
			/*
			 * **The on-disk state a crash between the two writes leaves.**
			 *
			 * A real power loss simply stops the process, which no test can do. What
			 * it leaves behind is a vault written under the new key and a backup that
			 * was not — and that is exactly the state the both-writes-failed branch
			 * produces, because the rollback cannot put the vault back either. So
			 * both the backup write and the restore fail here, and the journal has to
			 * survive it: this is the one path that does not clear it, for precisely
			 * this reason.
			 */
			if (typeof path === 'string' && path.endsWith('.bak.tmp')) {
				state.backupWrites += 1;
				if (state.refuseBackupWrite) {
					throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
				}
			}
			if (state.crashAfterVaultWrite && typeof path === 'string') {
				if (path.endsWith('.bak.tmp')) {
					state.backupAttempted = true;
					throw Object.assign(new Error('EIO: the machine went away'), { code: 'EIO' });
				}
				if (state.backupAttempted && path.endsWith('.tmp')) {
					throw Object.assign(new Error('EIO: the machine went away'), { code: 'EIO' });
				}
			}
			return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
		}
	};
});

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'oda-rotation-journal-'));
	file = join(dir, 'vault.json');
	state.crashAfterVaultWrite = false;
	state.backupAttempted = false;
	state.refuseBackupWrite = false;
	state.backupWrites = 0;
});

afterEach(() => {
	state.crashAfterVaultWrite = false;
	rmSync(dir, { recursive: true, force: true });
});

const OLD = 'the-passphrase-this-vault-was-made-with';
const NEW = 'a-different-passphrase-long-enough-too';

const service = () => new VaultService({ file });

async function vaultWithAnAccount(): Promise<VaultService> {
	const vault = service();
	await vault.create(OLD);
	await vault.mutate((draft) => {
		draft.accounts.push({
			steamId64: '76561199000000001',
			accountName: 'trader',
			sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
			identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
			status: 'active',
			addedAt: '2026-01-01T00:00:00.000Z'
		} as never);
	});
	return vault;
}

/** Rotate with the backup write failing, then throw the process away. */
async function interruptedRotation(): Promise<void> {
	const vault = await vaultWithAnAccount();
	state.crashAfterVaultWrite = true;
	await expect(vault.changePassphrase(OLD, NEW)).rejects.toThrow();
	state.crashAfterVaultWrite = false;
	state.backupAttempted = false;
}

describe('a rotation interrupted between its two writes', () => {
	it('leaves a journal saying what it still owes', async () => {
		await interruptedRotation();

		expect(
			existsSync(`${file}.rotating`),
			'nothing recorded that the backup was still owed, so the next start has no way to know'
		).toBe(true);
	});

	it('is finished by the next start', async () => {
		await interruptedRotation();

		// A fresh process, which is all a restart is here.
		const restarted = service();
		expect(restarted.reconcile(), 'the interrupted rotation was not noticed').toBe(true);

		const opened = service();
		await opened.unlock(NEW);
		opened.lock();
		await expect(
			opened.restoreFromBackup(NEW),
			'the backup was not re-sealed under the new passphrase, so it still opens with the one ' +
				'the user was told is retired'
		).resolves.not.toThrow();
	});

	/** The half that matters: the retired passphrase must stop opening it. */
	it('leaves no backup the retired passphrase opens', async () => {
		await interruptedRotation();
		service().reconcile();

		const opened = service();
		await expect(
			opened.restoreFromBackup(OLD),
			'the backup a rotation replaced still opens with the passphrase that rotation retired, ' +
				'and it holds every account in the vault'
		).rejects.toThrow();
	});

	it('clears the journal once it is done', async () => {
		await interruptedRotation();
		service().reconcile();

		expect(existsSync(`${file}.rotating`)).toBe(false);
	});

	it('does nothing the second time', async () => {
		await interruptedRotation();
		expect(service().reconcile()).toBe(true);
		expect(service().reconcile(), 'a finished rotation was finished again').toBe(false);
	});

	/*
	 * And an ordinary rotation leaves nothing behind: a journal that outlives a
	 * successful rotation would have every later start rewrite a backup nobody
	 * asked it to.
	 */
	it('is not left behind by a rotation that completed', async () => {
		const vault = await vaultWithAnAccount();
		await vault.changePassphrase(OLD, NEW);

		expect(existsSync(`${file}.rotating`)).toBe(false);
		expect(service().reconcile()).toBe(false);
	});

	/* And a vault that never rotated is untouched. */
	it('does nothing to a vault with no rotation in its past', async () => {
		await vaultWithAnAccount();
		expect(service().reconcile()).toBe(false);
	});
});

/**
 * **A debt that cannot be paid is not retried once a second.**
 *
 * `reconcile` is called from `backupAvailable`, which the status poll asks every
 * second. With a journal on disk and a backup write that cannot succeed — a
 * read-only directory, a share that has gone — that meant a parse, a failed
 * write and a log line every second for the life of the session.
 *
 * The journal stays on disk either way, so the next start still tries. What is
 * dropped is retrying that was never going to help.
 */
describe('an interrupted rotation whose backup still cannot be written', () => {
	it('is attempted once rather than on every poll', async () => {
		await interruptedRotation();

		const vault = service();
		state.refuseBackupWrite = true;
		state.backupWrites = 0;

		// Five ticks of the status poll, which is what asks this.
		for (let poll = 0; poll < 5; poll += 1) {
			vault.backupAvailable();
		}
		state.refuseBackupWrite = false;

		expect(
			state.backupWrites,
			'the status poll retried a backup write that cannot succeed, once per second, for the ' +
				'life of the session'
		).toBe(1);
	});

	it('leaves the journal for the next start', async () => {
		await interruptedRotation();
		const vault = service();
		state.refuseBackupWrite = true;
		vault.backupAvailable();
		state.refuseBackupWrite = false;

		expect(
			existsSync(`${file}.rotating`),
			'a failed attempt discarded the debt, so no later start can pay it'
		).toBe(true);
		// And a fresh process does try again.
		expect(service().reconcile()).toBe(true);
	});
});
