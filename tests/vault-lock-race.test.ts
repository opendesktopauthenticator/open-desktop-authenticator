import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
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
const CREATED_WITH = 'a-different-passphrase-for-the-create';

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

/*
 * **Two operations that replace the vault file, overlapping.**
 *
 * Restoring is deliberately slow — it derives a key from the backup — and the
 * only guard against something else touching the file during it was a check for
 * an *open session*. `adoptFrom` writes a vault and leaves it closed, so that
 * check sailed straight past: the restore then set the just-adopted vault aside
 * and installed the backup over it. Both operations returned success, and the
 * application opened the older of the two.
 *
 * Nothing is destroyed — the adopted file survives where the user picked it —
 * but they are told their vault was adopted while the app runs on different
 * accounts, which is the worst kind of wrong answer.
 */
describe('an adoption that lands during a restore', () => {
	/** A second vault, elsewhere, carrying a value the backup does not have. */
	async function elsewhere(marker: number): Promise<string> {
		const other = join(dir, 'adopt-me.json');
		const source = new VaultService({ file: other });
		await source.create(PASSPHRASE);
		await source.mutate((draft) => {
			draft.settings.autoLockMinutes = marker;
		});
		source.lock();
		return other;
	}

	/** A backup, and no main vault, which is the state restore is offered in. */
	async function backupOnly(marker: number): Promise<void> {
		const setup = service();
		await setup.create(PASSPHRASE);
		await setup.mutate((draft) => {
			draft.settings.autoLockMinutes = marker;
		});
		// A second write leaves the first as the backup.
		await setup.mutate((draft) => {
			draft.settings.autoLockMinutes = marker;
		});
		setup.lock();
		rmSync(file, { force: true });
	}

	/**
	 * **An ordinary save is as much a replacement of the file as an adoption is.**
	 *
	 * `fileGeneration` existed to catch a vault appearing under a restore, and it
	 * advanced only for adoptions and restores. So a *save* landing inside the
	 * backup's key derivation — which is slow on purpose — left the counter
	 * untouched, the restore's check agreed with itself, and the newer vault was
	 * moved aside and the older backup installed over it. The restore could then
	 * fail for an unrelated reason and report that nothing had happened, with the
	 * live vault already rolled back.
	 *
	 * One case per write path, because each was a separate line that did not
	 * bump the counter.
	 */
	/**
	 * **A save landing during a restore, raced deterministically after all.**
	 *
	 * I claimed this could not be done: `create`, `mutate` and `changePassphrase`
	 * all derive keys, so racing one against a restore's own derivation is
	 * decided by whichever finishes first, and my attempts passed and failed at
	 * random. The shape below is the one I missed, and it is deterministic:
	 *
	 *  1. `create` starts and begins its scrypt.
	 *  2. A short head start guarantees the restore captures `fileGeneration`
	 *     *before* create's write lands — create is still deriving.
	 *  3. The lock makes create fail its own install check, but only *after* it
	 *     has written the file and advanced the counter.
	 *  4. The restore then finds the counter moved and refuses.
	 *
	 * The load-bearing part is that a create's key derivation is far longer than
	 * the head start, so step 2 cannot lose. The ordinary-save case below uses a
	 * different deterministic shape: start the restore while open, save before
	 * its scrypt finishes, then lock before the restore reaches its open-state
	 * check. The AST guard below covers every remaining publication path.
	 */
	it('refuses rather than replacing a vault created while it derived', async () => {
		await backupOnly(17);

		const vault = service();
		const creating = vault.create(CREATED_WITH);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const restoring = vault.restoreFromBackup(PASSPHRASE);
		vault.lock('suspend');

		// The create wrote the file and then found itself locked out of it.
		await expect(creating).rejects.toThrow(LOCKED_DURING_OPEN);
		// And the restore noticed the write, rather than installing over it.
		await expect(restoring).rejects.toThrow(/another vault was put in place/i);
	});

	it('refuses rather than restoring over an ordinary save that lands while it derives', async () => {
		const vault = service();
		await vault.create(PASSPHRASE);
		await vault.mutate((draft) => {
			draft.settings.autoLockMinutes = 7;
		});
		// This leaves the 7-minute state in `.bak` and 9 in the main vault.
		await vault.mutate((draft) => {
			draft.settings.autoLockMinutes = 9;
		});

		// `restoreFromBackup` captures the file generation synchronously and then
		// yields to scrypt. A mutation needs no derivation once the vault is open,
		// so it deterministically lands before that restore can finish. Locking in
		// the same turn removes the independent "vault is open" refusal and leaves
		// the file-generation check as the only reason the restore can decline.
		const restoring = vault.restoreFromBackup(PASSPHRASE);
		await vault.mutate((draft) => {
			draft.settings.autoLockMinutes = 42;
		});
		vault.lock();

		await expect(restoring).rejects.toThrow(/another vault was put in place/i);
		await vault.unlock(PASSPHRASE);
		expect(vault.settings().autoLockMinutes).toBe(42);
	});

	it('allows exactly one of a concurrent restore and adoption to replace the vault', async () => {
		await backupOnly(17);
		const other = await elsewhere(42);

		const vault = service();
		const restoring = vault.restoreFromBackup(PASSPHRASE);
		const adopting = vault.adoptFrom(other, PASSPHRASE);
		const outcomes = await Promise.allSettled([restoring, adopting]);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

		// Whichever operation won is exactly the vault on disk; the losing slow
		// derivation cannot overwrite it afterwards.
		await vault.unlock(PASSPHRASE);
		const expectedMinutes = outcomes[1]?.status === 'fulfilled' ? 42 : 17;
		expect(
			vault.settings().autoLockMinutes,
			'the losing replacement overwrote the operation that completed first'
		).toBe(expectedMinutes);
	}, 20_000);

	it('still restores when nothing else touched the file', async () => {
		await backupOnly(17);

		const vault = service();
		await vault.restoreFromBackup(PASSPHRASE);
		await vault.unlock(PASSPHRASE);
		expect(vault.settings().autoLockMinutes).toBe(17);
	});
});

/**
 * **Every write to the vault file advances the counter a restore checks.**
 *
 * `fileGeneration` was bumped only by adoptions and restores. A restore derives
 * a key from the backup's passphrase — slow on purpose — and re-checks the
 * counter before swapping the files. An ordinary save landing inside that
 * window left it untouched, so the check agreed and the restore moved the
 * *newer* vault aside and installed the older backup over it. It could then
 * fail for an unrelated reason and report that nothing had happened, with the
 * live vault already rolled back.
 *
 * **Asserted on the source rather than by racing.** The existing adoption case
 * above can be raced deterministically because `adoptFrom` is synchronous;
 * `create`, `mutate` and `changePassphrase` all derive keys of their own, so a
 * race against them is decided by whichever derivation finishes first and the
 * test passes or fails at random. A flaky gate is worse than none. What is
 * deterministic — and what actually regresses — is a write path added without
 * the bump, so that is what is checked.
 */
describe('the vault-file revision', () => {
	const source = readFileSync(join(__dirname, '../src/main/vault/service.ts'), 'utf8');
	const file = ts.createSourceFile(
		'service.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);

	type MainWrite = {
		method: string;
		statement: ts.ExpressionStatement;
		body: ts.Block;
	};

	const isFileGenerationAdvance = (statement: ts.Statement): boolean =>
		ts.isExpressionStatement(statement) &&
		ts.isBinaryExpression(statement.expression) &&
		statement.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
		statement.expression.left.getText(file) === 'this.fileGeneration' &&
		statement.expression.right.getText(file) === '1';

	const writes: MainWrite[] = [];
	const findWrites = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && node.body !== undefined) {
			const method = node.name.getText(file);
			const visit = (child: ts.Node): void => {
				if (
					ts.isCallExpression(child) &&
					ts.isIdentifier(child.expression) &&
					child.expression.text === 'writeEnvelope' &&
					child.arguments[0]?.getText(file) === 'this.file'
				) {
					let statement: ts.Node = child;
					while (!ts.isExpressionStatement(statement)) statement = statement.parent;
					writes.push({ method, statement, body: node.body! });
				}
				ts.forEachChild(child, visit);
			};
			ts.forEachChild(node.body, visit);
			return;
		}
		ts.forEachChild(node, findWrites);
	};
	findWrites(file);

	const successfulContinuation = ({ statement, body }: MainWrite): ts.Statement[] => {
		const continuation: ts.Statement[] = [];
		let cursor: ts.Node = statement;
		while (cursor !== body) {
			const parent = cursor.parent;
			if (ts.isBlock(parent)) {
				const index = parent.statements.findIndex((candidate) => candidate === cursor);
				if (index >= 0) continuation.push(...parent.statements.slice(index + 1));
			}
			cursor = parent;
		}
		return continuation;
	};

	it('pairs every successful main-vault publication with an unconditional advance', () => {
		expect(writes.map((write) => write.method)).toEqual([
			'create',
			'mutate',
			'changePassphraseOnce',
			'adoptFrom',
			'restoreFromBackup'
		]);

		for (const write of writes) {
			const continuation = successfulContinuation(write);
			expect(
				continuation.some(isFileGenerationAdvance),
				`${write.method} publishes the main vault without advancing fileGeneration on its success path`
			).toBe(true);
		}
	});
});
