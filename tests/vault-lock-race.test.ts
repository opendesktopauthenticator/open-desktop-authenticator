import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCKED_DURING_OPEN, VaultService } from '../src/main/vault/service';

/**
 * A lock that arrives while the vault is being opened.
 *
 * Opening a vault is deliberately slow: the key derivation is the one thing
 * standing between a stolen file and its contents, so it is meant to take real
 * time. For those seconds the vault is not yet unlocked and no state is
 * installed — and `lock()` returned early in exactly that window.
 *
 * So a machine suspending mid-unlock cancelled nothing. The derivation finished
 * a second later, installed an unlocked vault, and left every secret readable
 * behind the operating system's lock screen. The user had done everything right
 * and the vault was open anyway.
 *
 * These drive the real service with real derivation, interleaving the lock the
 * way `powerMonitor` does rather than mocking the timing.
 */

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'oda-lock-race-'));
	file = join(dir, 'vault.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PASSPHRASE = 'a-passphrase-long-enough-to-be-accepted';

const service = (onLock?: (reason: string) => void) => new VaultService({ file, onLock });

describe('a lock during key derivation wins', () => {
	it('leaves the vault locked when the machine suspends mid-unlock', async () => {
		const setup = service();
		await setup.create(PASSPHRASE);
		setup.lock();

		const vault = service();
		// Start the unlock, then suspend before it can finish. No await between
		// them: this is the interleaving powerMonitor produces.
		const opening = vault.unlock(PASSPHRASE);
		vault.lock('suspend');

		await expect(opening).rejects.toThrow(LOCKED_DURING_OPEN);
		expect(vault.isUnlocked(), 'the vault must not be open behind a lock screen').toBe(false);
	});

	it('leaves it locked when the suspend lands mid-create', async () => {
		const vault = service();
		const creating = vault.create(PASSPHRASE);
		vault.lock('suspend');

		await expect(creating).rejects.toThrow(LOCKED_DURING_OPEN);
		expect(vault.isUnlocked()).toBe(false);

		// The file was still written — the vault exists and the passphrase opens
		// it. What the lock cancelled is leaving it open, not the creation.
		expect(vault.exists()).toBe(true);
		await vault.unlock(PASSPHRASE);
		expect(vault.isUnlocked()).toBe(true);
	});

	it('leaves it locked when the suspend lands mid-restore', async () => {
		const setup = service();
		await setup.create(PASSPHRASE);
		await setup.mutate((draft) => {
			draft.settings.autoLockMinutes = 7;
		});
		// A second write leaves the first as the backup.
		await setup.mutate((draft) => {
			draft.settings.autoLockMinutes = 9;
		});
		setup.lock();

		const vault = service();
		const restoring = vault.restoreFromBackup(PASSPHRASE);
		vault.lock('suspend');

		await expect(restoring).rejects.toThrow(LOCKED_DURING_OPEN);
		expect(vault.isUnlocked()).toBe(false);
	});

	it('does not announce a lock that did not happen', async () => {
		// `lock()` on an already-locked vault bumps the generation but must not
		// tell listeners the vault just locked — post-lock work would run twice,
		// or run when nothing changed.
		const reasons: string[] = [];
		const vault = service((reason) => reasons.push(reason));

		vault.lock('suspend');
		expect(reasons, 'nothing was open, so nothing locked').toEqual([]);

		await vault.create(PASSPHRASE);
		vault.lock('manual');
		expect(reasons).toEqual(['manual']);
	});

	it('still opens normally when nothing interrupts it', async () => {
		// The guard must not make ordinary unlocking fail.
		const setup = service();
		await setup.create(PASSPHRASE);
		setup.lock();

		const vault = service();
		await vault.unlock(PASSPHRASE);
		expect(vault.isUnlocked()).toBe(true);
	});

	it('survives a lock arriving after the unlock has completed', async () => {
		const setup = service();
		await setup.create(PASSPHRASE);
		setup.lock();

		const vault = service();
		await vault.unlock(PASSPHRASE);
		vault.lock('idle');
		expect(vault.isUnlocked()).toBe(false);

		// And the next unlock works — the generation is a counter, not a latch.
		await vault.unlock(PASSPHRASE);
		expect(vault.isUnlocked()).toBe(true);
	});
});
