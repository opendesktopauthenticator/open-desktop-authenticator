import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
	refuseJournalStat: false,
	backupWrites: 0
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		statSync: (path: unknown, ...rest: unknown[]) => {
			/*
			 * A journal the process is not allowed to look at. `existsSync` gives the same
			 * false for this as for a path with nothing at it, which is the whole
			 * point of the case below.
			 */
			if (state.refuseJournalStat && typeof path === 'string' && path.endsWith('.rotating')) {
				throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
			}
			return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest);
		},
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
	state.refuseJournalStat = false;
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

/**
 * **The journal says a rotation started, not which side of the gap it stopped
 * on.**
 *
 * It is written before either write. A crash *before* the vault write leaves the
 * file under the OLD key — and installing the journal's backup then puts a
 * new-key copy beside an old-key vault, which is a backup the user's passphrase
 * cannot open. Reconciliation installed it in both cases.
 *
 * The envelopes decide it: both were sealed under the same fresh salt in the same
 * rotation, so a vault carrying that salt is exactly the statement "the main
 * write landed".
 */
describe('a rotation that stopped before the vault was written', () => {
	it('is discarded rather than finished', async () => {
		const vault = await vaultWithAnAccount();
		const before = readFileSync(file, 'utf8');

		// A journal for a rotation whose vault write never happened: the salt in it
		// belongs to a key nothing on disk was sealed with.
		writeFileSync(
			`${file}.rotating`,
			readFileSync(`${file}.bak`, 'utf8').replace(/"salt": "[^"]*"/, '"salt": "b3RoZXItc2FsdA=="')
		);

		expect(
			service().reconcile(),
			'a backup was installed for a rotation that never reached the vault, so the copy on disk ' +
				'is one the vault passphrase cannot open'
		).toBe(false);
		expect(existsSync(`${file}.rotating`), 'the journal was left to be replayed forever').toBe(
			false
		);
		expect(readFileSync(file, 'utf8'), 'the vault itself was touched').toBe(before);
		void vault;
	});
});

/**
 * **A backup that cannot be vouched for is not offered.**
 *
 * The file is still there and still parses, which is why every check said yes.
 * Being there is not the question: if the rotation could not be finished, that
 * file may still open with the passphrase the user replaced, and restoring it
 * would undo the change they made.
 */
describe('a backup an interrupted rotation could not replace', () => {
	it('is not offered while the write keeps failing', async () => {
		await interruptedRotation();

		const vault = service();
		state.refuseBackupWrite = true;
		const offered = vault.backupAvailable();
		state.refuseBackupWrite = false;

		expect(
			offered,
			'the unlock screen offered a backup that still opens with the retired passphrase'
		).toBeUndefined();
	});

	it('cannot be restored while the write keeps failing', async () => {
		await interruptedRotation();

		const vault = service();
		state.refuseBackupWrite = true;
		await expect(
			vault.restoreFromBackup(OLD),
			'restoring installed a vault the replaced passphrase opens, undoing the rotation'
		).rejects.toThrow(/interrupted/);
		state.refuseBackupWrite = false;
	});

	/**
	 * And the same when what the rotation left cannot be read at all — the shape a
	 * crash produces alongside the crash the journal is for. This read as "no
	 * rotation was interrupted", which is the worst of the three answers.
	 */
	it('is not offered when the journal itself is truncated', async () => {
		await interruptedRotation();
		writeFileSync(`${file}.rotating`, '{ "version": 1, "kdf');

		const vault = service();
		expect(
			vault.backupAvailable(),
			'a truncated journal read as no journal, so the backup went on being offered'
		).toBeUndefined();
		await expect(vault.restoreFromBackup(OLD)).rejects.toThrow(/interrupted/);
	});

	/* And once it is finished, the backup is offered again. */
	it('is offered again once the rotation is finished', async () => {
		await interruptedRotation();
		const vault = service();
		expect(vault.reconcile()).toBe(true);
		expect(vault.backupAvailable()).toBeDefined();
	});
});

/**
 * **"Not there" and "could not look" were the same answer.**
 *
 * The journal check was `existsSync`, which returns false for a path it is not
 * allowed to stat exactly as it does for a path with nothing at it. A rotation
 * that was interrupted then read as no rotation at all, the suspicion on the
 * backup was cleared, and the unlock screen went back to offering a copy that
 * may still open with the passphrase the user had just retired.
 *
 * Every other failure in that reader already lands on `unreadable`, which
 * refuses to offer it. This was the one branch that failed the other way.
 */
describe('a journal the process cannot look at', () => {
	it('is not read as no journal', async () => {
		await interruptedRotation();

		const vault = service();
		state.refuseJournalStat = true;
		const offered = vault.backupAvailable();
		state.refuseJournalStat = false;

		expect(
			offered,
			'a stat that failed read as "no rotation was interrupted", so the backup went on being ' +
				'offered while it still opens with the retired passphrase'
		).toBeUndefined();
	});

	it('is not restorable either', async () => {
		await interruptedRotation();

		const vault = service();
		state.refuseJournalStat = true;
		await expect(vault.restoreFromBackup(OLD)).rejects.toThrow(/interrupted/);
		state.refuseJournalStat = false;
	});

	/* And a vault with no journal at all is still perfectly ordinary. */
	it('does not make an untouched vault suspicious', async () => {
		await vaultWithAnAccount();

		expect(service().backupAvailable()).toBeDefined();
	});
});

/**
 * **A journal that outlived its rotation, and no backup left to compare it to.**
 *
 * `clearRotationJournal` unlinks and swallows the failure. The salt cannot see
 * the difference — a finished rotation leaves the vault carrying exactly the
 * salt the journal names, and so does every ordinary save after it — so the
 * backup on disk was made the discriminator: already under the current key
 * means the debt was paid.
 *
 * That needs a backup to look at. Take it away and the fallback was to pay a
 * debt already paid, writing a rotation-era copy over whatever later saves had
 * produced.
 *
 * The vault's nonce settles it without `.bak` at all: every seal gets a fresh
 * one, so a vault still carrying the rotation's own nonce is the statement
 * "nothing has been written since".
 */
describe('a stale journal whose backup has gone missing', () => {
	it('is not replayed over a vault that has moved on', async () => {
		const vault = await vaultWithAnAccount();
		await vault.changePassphrase(OLD, NEW);

		/*
		 * Exactly what a failed unlink leaves behind: the journal this rotation
		 * wrote, still on disk after the rotation completed. Rebuilt from the state
		 * the rotation produced rather than by stubbing `unlinkSync`, so the case
		 * does not depend on how the deletion happens to be written.
		 */
		const staleJournal = JSON.stringify({
			backup: JSON.parse(readFileSync(`${file}.bak`, 'utf8')) as unknown,
			vaultNonce: (JSON.parse(readFileSync(file, 'utf8')) as { cipher: { nonce: string } }).cipher
				.nonce
		});

		// Two ordinary saves after the rotation, then the backup goes missing.
		await vault.mutate((draft) => {
			draft.accounts.push({
				steamId64: '76561199000000002',
				accountName: 'second',
				sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
				identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
				status: 'active',
				addedAt: '2026-01-02T00:00:00.000Z'
			} as never);
		});
		await vault.mutate((draft) => {
			draft.settings.autoLockMinutes = 15;
		});
		rmSync(`${file}.bak`, { force: true });
		writeFileSync(`${file}.rotating`, staleJournal);

		expect(
			service().reconcile(),
			'a journal that outlived its rotation was replayed once the backup it would have been ' +
				'compared against was gone, so a rotation-era copy stood in for two later saves'
		).toBe(false);
		expect(
			existsSync(`${file}.bak`),
			'and an obsolete backup was fabricated where there had been none'
		).toBe(false);
	});

	/*
	 * And the debt that is genuinely owed is still paid, even with no readable
	 * backup to compare against — which is the case a blanket refusal would get
	 * wrong.
	 */
	it('still finishes a rotation that really was interrupted', async () => {
		await interruptedRotation();
		writeFileSync(`${file}.bak`, '{ "version": 1, "kdf');

		expect(service().reconcile(), 'a real debt went unpaid because the backup was damaged').toBe(
			true
		);
		expect(existsSync(`${file}.bak.previous`), 'a set-aside copy was left behind').toBe(false);
	});
});
