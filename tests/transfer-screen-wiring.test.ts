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
		expect(SCREEN).toContain('Do not close this window until it is saved.');
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
		expect(APP).toMatch(/if \(!cancelled && transfer\.awaiting\) \{\s*setView\('move'\);/);
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
		expect(ENROLL).toMatch(/catch \{[\s\S]{0,200}could not be written to that location/);
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

	it('has exactly one place that drops them', () => {
		// Two mechanisms for one rule is how the halves drift apart.
		expect(TRANSFER.match(/this\.dropCredentials\(\);/g) ?? []).toHaveLength(1);
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
		const next = SCREEN.indexOf("if (awaiting === 'unanswered' && !done)", start);
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

	it('names Steam Support rather than implying a way back here', () => {
		expect(flat(deadEndView())).toContain('Steam Support is the route back into the account');
	});

	it('leaves a way off the screen', () => {
		// `cancel` is what discharges a terminal transfer. Guarding it the way the
		// unsaved-secrets case is guarded would trap the user on a screen whose only
		// button calls it.
		expect(deadEndView()).toContain('onCancel()');
	});

	it('keeps the storage retry, which is the one that can still work', () => {
		expect(SCREEN).toContain("{busy ? 'Working…' : 'Save it now'}");
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
		for (const state of ['unreadable', 'unanswered', 'persist']) {
			const needle = `if (awaiting === '${state}'`;
			expect(SCREEN.split(needle).length - 1, state).toBe(1);
		}
	});

	it('never promises held secrets on a screen where none are held', () => {
		const dead = SCREEN.slice(
			at("if (awaiting === 'unreadable' && !done)"),
			at("if (awaiting === 'unanswered' && !done)")
		);
		expect(dead).not.toContain('Do not close this window until it is saved');
		expect(dead).not.toContain('retrySave');
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
