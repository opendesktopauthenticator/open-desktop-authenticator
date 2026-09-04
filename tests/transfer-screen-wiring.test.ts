import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The transfer screen's most dangerous claims, asserted against its source.
 *
 * `move-authenticator.test.tsx` renders the screen, which is the better kind of
 * test — but it renders statically, and every stage past the sign-in form is
 * reached by interaction or by asking the main process. So the stages where this
 * screen can rotate somebody's authenticator are exactly the ones no rendered
 * assertion reaches.
 *
 * A `.ts` file rather than `.tsx`: `tsconfig.web.json` covers the `.tsx` tests
 * and carries no Node types, so `node:fs` cannot be read from one.
 */

const SCREEN = readFileSync(
	join(__dirname, '..', 'src', 'renderer', 'screens', 'MoveAuthenticator.tsx'),
	'utf8'
);
const APP = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

/**
 * The same source with every run of whitespace collapsed.
 *
 * Prose in JSX is wrapped by the formatter, so where a sentence breaks is
 * Prettier's decision and not a fact worth asserting. Two of these tests matched
 * across a line break and failed the next time the file was reformatted, which
 * is a test being brittle rather than a screen being wrong.
 */
const flat = (source: string): string => source.replace(/\s+/g, ' ');

/*
 * The screen used to say, on the same view as a working "Replace the
 * authenticator" button and a notice reading "Submitting the code cannot be
 * undone", that submitting the code "is not built yet, so nothing further will
 * happen to this account."
 *
 * It was true while the flow was half-built and became false when it was
 * finished. The half that survived was the reassuring one, next to the button
 * that irreversibly rotates a real account's authenticator.
 */
describe('the screen never tells the user the irreversible step is inert', () => {
	it('does not claim the submission is unimplemented', () => {
		expect(SCREEN).not.toMatch(/not built yet/i);
		expect(SCREEN).not.toMatch(/nothing further will happen to this account/i);
	});

	it('stops claiming the phone is in charge once the transfer is committed', () => {
		// The reassurance is true right up until the code is submitted, and the
		// screen keeps saying it there. What it must not do is go on saying it in the
		// same branch that renders after a submission failed to save — beside a retry
		// for an authenticator Steam has already rotated.
		expect(SCREEN).toMatch(
			/\{committed \? \([\s\S]{0,400}Steam has already replaced the authenticator/
		);
		expect(SCREEN).toMatch(/\) : \([\s\S]{0,300}still the one in charge/);
	});

	it('still warns that submitting cannot be undone', () => {
		expect(SCREEN).toContain('Submitting the code cannot be undone.');
	});
});

/*
 * Picking the transfer back up after a lock reloaded the window.
 *
 * Locking reloads the renderer, which destroys every piece of state on this
 * screen. Steam may already have rotated the authenticator by then, and the only
 * copy of the replacement is held in the main process — so without a way to ask,
 * the reload stranded it there until the process exited.
 */
describe('an interrupted transfer is recoverable after unlocking', () => {
	it('asks the main process what is outstanding, on mount', () => {
		expect(SCREEN).toContain('statusRef');
		expect(SCREEN).toMatch(/statusRef\s*\n?\s*\.current\(\)/);
	});

	it('renders a recovery view when something is owed and the document has forgotten', () => {
		// Ahead of `done` and `authenticated`, because neither survives the reload —
		// placed after them, the screen would offer a fresh sign-in form instead.
		const recovery = SCREEN.indexOf("if (awaiting === 'persist' && !done)");
		expect(recovery).toBeGreaterThan(-1);
		expect(recovery).toBeLessThan(SCREEN.indexOf('\tif (done) {'));
	});

	it('tells the user not to close the window while secrets are unsaved', () => {
		expect(SCREEN).toContain('Do not close this window or quit the app until it is saved.');
	});

	it('distinguishes recoverable local state from a memory-only replacement', () => {
		const persist = SCREEN.slice(
			SCREEN.indexOf("if (awaiting === 'persist' && !done)"),
			SCREEN.indexOf('\tif (done) {')
		);
		expect(persist).toContain("const durableRecovery = recovery?.state === 'replacement';");
		expect(flat(persist)).toMatch(
			/durableRecovery \? \([\s\S]*exact replacement is available from this vault or its encrypted safety record[\s\S]*\) : \([\s\S]*only usable copy is[\s\S]*held in memory; a restart will lose it/
		);
	});

	it('decides what to show from the main process, not from an error message', () => {
		// Matching on prose was all there was, and prose does not survive a reload.
		expect(SCREEN).toContain("awaiting === 'unanswered'");
		expect(SCREEN).toContain("awaiting === 'unreadable'");
	});

	it('is opened for the user rather than waiting to be found', () => {
		// Recovering only when the screen happens to be opened is not enough: nothing
		// would tell the user there was anything to come back to.
		//
		// Matched on the branch itself rather than on "these two strings appear near
		// each other" — the loose version passed with the navigation deleted, because
		// it paired the `onStatus` prop with the unrelated `onMove` handler ten lines
		// below it.
		const recoveryDelivery = APP.slice(
			APP.indexOf('const attention: DeferredRecovery'),
			APP.indexOf('\n\t\t\t})', APP.indexOf('const attention: DeferredRecovery'))
		);
		expect(recoveryDelivery).toContain("destination: enrollmentNeedsAttention ? 'enroll' : 'move'");
		expect(recoveryDelivery).toContain('deliverRecoveryAttention(');
		expect(recoveryDelivery).toContain('setView(attention.destination);');
	});

	it('passes the status channel down to the screen', () => {
		expect(APP).toContain('onStatus={() => api.getTransferStatus()}');
	});
});

/*
 * A rejected code is not a committed transfer.
 *
 * `committed` is set before the request on purpose — a timeout may still have
 * rotated the authenticator, so the pessimistic assumption is the safe one. What
 * was missing was taking it back when Steam answered plainly that it had
 * refused: the screen hid Close, announced the authenticator had been replaced,
 * and offered a retry that throws "There is no unsaved authenticator to store."
 * All of that over a mistyped SMS code.
 */
describe('a refused code releases the screen', () => {
	it('re-checks what is actually held after a failed submission', () => {
		const submit = SCREEN.slice(
			SCREEN.indexOf('const submitCode'),
			SCREEN.indexOf('const retrySave')
		);
		expect(submit).toContain('statusRef.current()');
		expect(submit).toContain('setStatusProblem(status.problem)');
		expect(submit).toContain('setRecovery(status.recovery)');
		expect(submit).toContain('setAwaiting(status.awaiting)');
		expect(submit).toContain('setCommitted(false)');
	});

	it('only releases it when nothing is held', () => {
		const submit = SCREEN.slice(
			SCREEN.indexOf('const submitCode'),
			SCREEN.indexOf('const retrySave')
		);
		expect(submit).toContain('if (!status.awaiting)');
	});

	it('keeps the pessimistic state when the check itself fails', () => {
		// Leaving `committed` set costs a Close button. Clearing it wrongly offers to
		// abandon a transfer that really did go through.
		const submit = SCREEN.slice(
			SCREEN.indexOf('const submitCode'),
			SCREEN.indexOf('const retrySave')
		);
		expect(submit).not.toMatch(/catch\s*\{\s*setCommitted\(false\)/);
	});
});

describe('an unreadable safety-record retry refreshes the mounted screen', () => {
	it('re-reads authoritative status even when retryPersist rejects', () => {
		const retry = SCREEN.slice(
			SCREEN.indexOf('const retrySave'),
			SCREEN.indexOf('const resolveRecovery')
		);
		const failed = retry.slice(retry.indexOf('catch (err)'));
		expect(failed).toContain('await statusRef.current()');
		expect(failed).toContain('setRecovery(status.recovery)');
		expect(failed).toContain('setAwaiting(status.awaiting)');
	});
});

describe('recovery asks for the vault passphrase only when an old row will change', () => {
	it('keeps the harmless no-row and not-replaced paths usable without a passphrase', () => {
		const cleanup = SCREEN.slice(
			SCREEN.indexOf("if (awaiting === 'cleanup' && !done)"),
			SCREEN.indexOf("if (awaiting === 'unreadablePersist' && !done)")
		);
		const unanswered = SCREEN.slice(
			SCREEN.indexOf("if (awaiting === 'unanswered' && !done)"),
			SCREEN.indexOf("if (awaiting === 'persist' && !done)")
		);
		expect(cleanup).not.toContain('Vault passphrase');
		const choice = unanswered.indexOf("onClick={() => void resolveRecovery('notReplaced')}");
		expect(choice).toBeGreaterThan(-1);
		const button = unanswered.slice(unanswered.lastIndexOf('<button', choice), choice);
		expect(button).toContain('disabled={recoveryBusy}');
		expect(button).not.toContain('resolutionPassphrase');
	});

	it('shows and enforces the passphrase control from the authoritative status flag', () => {
		const recoveryScreens = SCREEN.slice(
			SCREEN.indexOf("if (awaiting === 'unreadable' && !done)"),
			SCREEN.indexOf('\n\tif (done) {')
		);
		// Three recovery branches render the proof field. The fourth reference in
		// this region belongs to the persist button's empty-proof gate below.
		expect(recoveryScreens.match(/recovery\?\.requiresPassphrase \? \(/g) ?? []).toHaveLength(3);
		expect(recoveryScreens).toContain('recovery.requiresPassphrase === true');
		expect(recoveryScreens).toContain('resolutionPassphrase.length === 0');
		expect(SCREEN).toContain('onRetryPersist(resolutionPassphrase || undefined)');
	});

	it('re-reads authoritative status after both a successful and a rejected resolution', () => {
		const resolve = SCREEN.slice(
			SCREEN.indexOf('const resolveRecovery'),
			SCREEN.indexOf('if (statusProblem !== undefined)')
		);
		expect(resolve.match(/await statusRef\.current\(\)/g) ?? []).toHaveLength(2);
		expect(resolve).not.toContain("setRecovery({ ...recovery, state: 'unreadable' })");
	});
});

/*
 * That the lock handler actually calls it.
 *
 * `forgetIfIdle` is tested directly in `transfer-persist.test.ts`, but a method
 * nothing invokes protects nothing. Transfer was the one service missing from
 * this teardown list, which is how a signed-in transfer's refresh and access
 * tokens outlived every lock.
 */
describe('the lock handler tears a transfer down', () => {
	const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

	it('calls forgetIfIdle on lock', () => {
		expect(MAIN).toContain('transfer.forgetIfIdle();');
	});

	it('never calls cancel there', () => {
		// `cancel` throws once secrets are held, and an idle lock is not a mistake to
		// report — it is simply not a reason to discard anything.
		expect(MAIN).not.toMatch(/transfer\.cancel\(\)/);
	});
});

/*
 * Guarantees this project states in one place and has now broken in two.
 *
 * The vault file's permissions were fixed by adding a mode and a `chmod`; the
 * maFile export, which carries the *same* secrets with none of the encryption,
 * kept `mode` alone — and POSIX applies that only when the file is created, so a
 * second export over an existing file left it at whatever it already was.
 *
 * The no-paths-across-IPC rule is stated at the top of `enrollment-ipc.ts` and
 * was enforced for the values it returns, while raw `ENOENT`/`EACCES` messages —
 * which quote the absolute path — travelled through untouched.
 */
describe('an export is owner-only however it was written', () => {
	const ENROLL = readFileSync(
		join(__dirname, '..', 'src', 'main', 'steam', 'enrollment-ipc.ts'),
		'utf8'
	);

	it('narrows the file after writing, not only on creation', () => {
		expect(ENROLL).toMatch(/await chmod\(destination, 0o600\)/);
	});

	it('still asks for the mode on creation', () => {
		// Both, not either. The chmod closes the overwrite case; the mode means the
		// file is never briefly readable between creation and the chmod.
		expect(ENROLL).toContain('mode: 0o600');
	});
});

describe('no filesystem path crosses IPC', () => {
	const ENROLL = readFileSync(
		join(__dirname, '..', 'src', 'main', 'steam', 'enrollment-ipc.ts'),
		'utf8'
	);
	const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

	it('does not let a failed export throw the destination path', () => {
		/*
		 * Asserted on what is thrown rather than on the shape of the `catch`.
		 *
		 * The refusal moved into a helper when the write and the rename were split
		 * apart — so a pattern anchored on `catch {` was checking punctuation, not
		 * the rule. The rule is that the message names the *file the user asked
		 * for* and never the path the OS dialog chose, and that is what these two
		 * lines say.
		 */
		expect(ENROLL).toMatch(/`\$\{suggested\} could not be written to that location\.`/);
		expect(ENROLL, 'a full path can reach the renderer in an error').not.toMatch(
			/throw new Error\(`\$\{(destination|temp)\}/
		);
	});

	/*
	 * The one exception, and it is not a path: a lock is reported as a lock.
	 * Wrapping it in "could not be written to that location" would send somebody
	 * to check their drive over a vault that timed out while they watched.
	 */
	it('reports a lock during the write as a lock', () => {
		const write = ENROLL.slice(ENROLL.indexOf('const temp = `${destination}'));
		// Thrown from outside the write's own catch, so it can never be dressed up
		// as a disk problem and send somebody to check their drive.
		expect(write).toMatch(/if \(!vault\.isUnlocked\(\)\) \{[\s\S]{0,200}new VaultLockedError\(\)/);
	});

	it('does not let a failed recovery read throw the chosen path', () => {
		expect(MAIN).toMatch(/catch \{[\s\S]{0,160}recovery file could not be read/);
	});
});

/*
 * The Steam session does not outlive a lock, in any of its shapes.
 *
 * The first version dropped it only when a lock landed *during* a submission.
 * The adjacent case — a lock arriving while a decoded replacement waits to be
 * stored — keeps `pending` on purpose, because that is the identity a retry
 * needs, and kept the refresh token with it. `startChallenge` then succeeded,
 * and spent an SMS, with the vault locked.
 *
 * Asserted here because the more specific refusals now answer first, so the drop
 * is no longer observable through the public API in the states a lock can leave
 * behind.
 */
describe('a lock always drops the transfer session', () => {
	const TRANSFER = readFileSync(
		join(__dirname, '..', 'src', 'main', 'steam', 'transfer.ts'),
		'utf8'
	);

	it('drops credentials before deciding whether to clear anything', () => {
		const forget = TRANSFER.slice(TRANSFER.indexOf('forgetIfIdle(): boolean {'));
		const drop = forget.indexOf('this.dropCredentials();');
		const refusal = forget.indexOf('if (this.submitting ||');
		expect(drop).toBeGreaterThan(-1);
		expect(drop).toBeLessThan(refusal);
	});

	it('uses one credential-erasure mechanism at both lifecycle boundaries', () => {
		// A lock and a completed Steam replacement are separate lifecycle boundaries,
		// but both must go through the same erasure primitive. Direct token writes in
		// either caller would let their behavior drift apart again.
		expect(TRANSFER.match(/private dropCredentials\(\): void/g) ?? []).toHaveLength(1);
		expect(TRANSFER.match(/pending\.refreshToken = undefined;/g) ?? []).toHaveLength(1);
		expect(TRANSFER).not.toContain('pending.accessToken');
		expect(TRANSFER.match(/this\.dropCredentials\(\);/g) ?? []).toHaveLength(2);
		const response = TRANSFER.slice(
			TRANSFER.indexOf('if (result.success !== true && result.replacementToken === undefined)'),
			TRANSFER.indexOf('const held: HeldReplacement', TRANSFER.indexOf('validateReplacement('))
		);
		expect(response.indexOf('this.dropCredentials();')).toBeGreaterThan(-1);
		expect(response.indexOf('this.dropCredentials();')).toBeLessThan(
			response.indexOf('validateReplacement(')
		);
	});

	it('refuses to reach Steam without a session rather than discovering undefined', () => {
		expect(TRANSFER).toContain('requireSession(pending.refreshToken)');
		expect(TRANSFER.match(/requireSession\(pending\.refreshToken\)/g) ?? []).toHaveLength(2);
	});
});

/*
 * The reply that cannot be used is a dead end, and the screen says so.
 *
 * It used to be retained for a "try again" that ran the same pure decoder over
 * the same bytes, and written to an encrypted file nothing anywhere could read.
 * Both were removed: an offered recovery that cannot recover is worse than a
 * plainly stated one that does not exist.
 */
describe('a transfer that cannot be completed says so', () => {
	/** Just this branch, bounded by the one that follows it. */
	const deadEndView = (): string => {
		const start = SCREEN.indexOf("if (awaiting === 'unreadable' && !done)");
		const next = SCREEN.indexOf("if (awaiting === 'cleanup' && !done)", start);
		expect(start).toBeGreaterThan(-1);
		expect(next).toBeGreaterThan(start);
		return SCREEN.slice(start, next);
	};

	it('has its own view, separate from the one that can still be saved', () => {
		expect(SCREEN).toContain("if (awaiting === 'unreadable' && !done)");
	});

	it('offers no retry there', () => {
		// Bounded by the *next* branch, not by `if (done)`. The dead-end view moved
		// above the recoverable one, so slicing to `done` swept up the persist screen
		// — which legitimately has a retry — and the assertion stopped meaning
		// anything about this view at all.
		expect(deadEndView()).not.toContain('retrySave');
	});

	it('distinguishes retained ciphertext from a reply for which no secrets survived', () => {
		const view = flat(deadEndView());
		expect(view).toContain('recovery?.retained');
		expect(view).toContain('The exact reply is retained in an encrypted safety record.');
		expect(view).toContain('No usable replacement secrets could be retained here.');
		expect(view).not.toContain('nothing here holds it');
	});

	it('leaves a way off the screen', () => {
		// Closing the screen must not discharge the durable record. The user can leave
		// safely and return after resolving the account with Steam Support.
		expect(deadEndView()).toContain('onClick={closeRecovery}');
		expect(deadEndView()).toContain('disabled={recoveryBusy}');
	});

	it('keeps the storage retry, which is the one that can still work', () => {
		expect(SCREEN).toContain("{recoveryBusy ? 'Working…' : 'Finish recovery'}");
	});

	it('does not promise the safety record survived an ambiguous post-delete flush', () => {
		expect(SCREEN).not.toContain(
			'The encrypted recovery record keeps these secrets across a restart.'
		);
		expect(SCREEN).toContain(
			'The exact replacement is available from this vault or its encrypted safety record.'
		);
	});
});

/*
 * Nothing writes Steam's reply to disk any more.
 *
 * The sealed copy was durable and unreadable: there was no importer, and the
 * decoder that had already failed was the only thing that could have read it.
 * Keeping raw shared and identity secrets on disk for a reader that does not
 * exist is cost without benefit.
 */
describe('the undecodable-reply file is gone', () => {
	const RECOVERY = readFileSync(
		join(__dirname, '..', 'src', 'main', 'vault', 'recovery.ts'),
		'utf8'
	);
	const TRANSFER = readFileSync(
		join(__dirname, '..', 'src', 'main', 'steam', 'transfer.ts'),
		'utf8'
	);
	const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

	it('leaves no writer behind', () => {
		expect(RECOVERY).not.toContain('writeUnreadableReply');
		expect(RECOVERY).not.toContain('UNREADABLE_EXTENSION');
	});

	it('leaves no hook to call one', () => {
		expect(TRANSFER).not.toContain('writeUnreadable');
		expect(MAIN).not.toContain('writeUnreadable');
	});

	it('does not retain the bytes either', () => {
		// A boolean records that a body arrived, which is the distinction that
		// matters; the body itself bought nothing.
		expect(TRANSFER).not.toContain('rawReply');
		expect(TRANSFER).toContain('bodyArrived');
	});
});

/*
 * Each outstanding state reaches its own screen.
 *
 * Asserting that a branch *exists* is not the same as asserting it is *reached*.
 * The persist branch was a truthy check — `awaiting && !authenticated` — so it
 * swallowed `unreadable` whenever `authenticated` was undefined, which is every
 * case after the reload a lock causes. A transfer that had ended unusably landed
 * on the screen saying secrets were held and would be lost on quit, offering a
 * "Save it now" that throws "There is no unsaved authenticator to store".
 *
 * Exactly the trap removing the decode retry was meant to close, reintroduced by
 * the order the branches sit in.
 */
describe('every outstanding state reaches its own screen', () => {
	const at = (needle: string): number => {
		const i = SCREEN.indexOf(needle);
		expect(i, needle).toBeGreaterThan(-1);
		return i;
	};

	it('matches persist exactly, never as a truthy catch-all', () => {
		expect(SCREEN).toContain("if (awaiting === 'persist' && !done)");
		expect(SCREEN).not.toContain('if (awaiting && !authenticated && !done)');
	});

	it('puts the two dead ends ahead of the recoverable one', () => {
		// Order is load-bearing while any branch is narrower than the one above it.
		expect(at("if (awaiting === 'unreadable' && !done)")).toBeLessThan(
			at("if (awaiting === 'persist'")
		);
		expect(at("if (awaiting === 'unanswered' && !done)")).toBeLessThan(
			at("if (awaiting === 'persist'")
		);
	});

	it('gives each of the three a distinct branch', () => {
		// Counted by splitting on a literal rather than by a constructed regex: the
		// escaping in a built pattern is one more thing to get wrong, and this only
		// needs to count an exact string.
		for (const state of ['unreadable', 'unreadablePersist', 'unanswered', 'cleanup', 'persist']) {
			const needle = `if (awaiting === '${state}'`;
			expect(SCREEN.split(needle).length - 1, state).toBe(1);
		}
	});

	it('never promises held secrets on a screen where none are held', () => {
		const dead = SCREEN.slice(
			at("if (awaiting === 'unreadable' && !done)"),
			at("if (awaiting === 'cleanup' && !done)")
		);
		expect(dead).not.toContain('Do not close this window until it is saved');
		expect(dead).not.toContain('retrySave');
	});

	it('does not describe a diagnostic safety-record retry as usable vault storage', () => {
		const start = at("if (awaiting === 'unreadablePersist' && !done)");
		const end = at("if (awaiting === 'unanswered' && !done)");
		const safety = SCREEN.slice(start, end);
		expect(safety).toContain('Save safety record now');
		expect(safety).toContain('will not add a usable');
		expect(safety).toContain('Steam Support is still required');
		expect(safety).not.toContain('The new authenticator was read successfully');
		expect(safety).not.toContain('only usable copy');
	});
});

/*
 * Recovery decrypts only while somebody is present.
 *
 * The handler checked the vault, opened a native picker, and decrypted whatever
 * came back. The picker stays open for as long as the user browses, and the
 * vault auto-locks on its own schedule — so a shared secret, an identity secret
 * and a revocation code could be pulled into memory with nobody there. The
 * `vault.read()` further down throws, far too late to un-read them.
 *
 * The maFile import path has guarded exactly this window since it was written,
 * with a comment saying why. Recovery did not.
 */
describe('a recovery file is not decrypted after the vault locks', () => {
	const ENROLL = readFileSync(
		join(__dirname, '..', 'src', 'main', 'steam', 'enrollment-ipc.ts'),
		'utf8'
	);

	it('re-checks the vault after the picker resolves', () => {
		const recover = ENROLL.slice(ENROLL.indexOf('CHANNELS.accountRecover'));
		const afterPick = recover.slice(recover.indexOf('await recoveryDialog.pick()'));
		expect(afterPick).toMatch(/requireUnlocked\(\);/);
	});

	it('does the re-check before anything is decrypted', () => {
		const recover = ENROLL.slice(ENROLL.indexOf('CHANNELS.accountRecover'));
		const pick = recover.indexOf('await recoveryDialog.pick()');
		const check = recover.indexOf('requireUnlocked();', pick);
		const decrypt = recover.indexOf('readRecoveryFile(');
		expect(check).toBeGreaterThan(pick);
		expect(check).toBeLessThan(decrypt);
	});
});

/*
 * **A checkbox that led nowhere.**
 *
 * The completion screen shows the recovery code Steam will never issue again
 * and asks the user to confirm they wrote it down, above a Done button that
 * only closed the screen. The account stayed `pendingRevocationBackup` and the
 * home screen went on warning that the code had never been backed up — about a
 * code the user had just been shown and had just confirmed keeping. The only
 * way to clear it was a second ceremony re-revealing the same code behind the
 * passphrase, which teaches people the warning means nothing.
 */
describe('the recovery-code acknowledgement on the completion screen', () => {
	it('is recorded, not only used to enable the button', () => {
		expect(SCREEN).toMatch(/onAcknowledgeBackup\(done\.steamId64\)/);
	});

	it('still requires the box to be ticked first', () => {
		expect(SCREEN).toMatch(/disabled=\{!savedCode/);
	});

	/*
	 * **This assertion used to require the failure to be silent.**
	 *
	 * It read `.finally(onClose)` and called that deliberate: the account is
	 * stored, the standalone ceremony can clear the warning later, so closing
	 * regardless seemed kinder than trapping somebody on the screen. It is not.
	 * A vault lock, a storage error or an IPC failure meant the user ticked the
	 * box, pressed Done, and the home screen went on saying the recovery code
	 * had never been backed up — with nothing anywhere explaining why. That is
	 * the "you asked for something and it did not happen" shape the rest of this
	 * application is written against, and the test was holding it in place.
	 *
	 * The code is still on screen at that moment, which is the one point where
	 * retrying costs nothing at all.
	 */
	it('closes only when the acknowledgement was actually recorded', () => {
		expect(SCREEN).not.toMatch(/\.finally\(onClose\)/);
		expect(SCREEN).toMatch(/onAcknowledgeBackup\(done\.steamId64\)\s*\.then\(/);
		expect(SCREEN).toMatch(/setAcknowledgeError\(messageOf\(err\)\)/);
	});

	it('says what went wrong, and offers a way out that does not pretend', () => {
		expect(SCREEN).toMatch(/acknowledgeError !== undefined/);
		expect(flat(SCREEN)).toMatch(/<DynamicError> \{acknowledgeError\}/);
		// Somebody whose vault locked mid-press cannot record anything from here,
		// and holding them on this screen would be its own trap.
		expect(SCREEN).toMatch(/Close without recording it/);
	});

	it('is wired to the same channel the standalone ceremony uses', () => {
		expect(APP).toMatch(/onAcknowledgeBackup=\{\(steamId64\) => api\.confirmRevocationBackup/);
	});
});
