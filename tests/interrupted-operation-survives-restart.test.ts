import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNELS } from '../src/shared/channels';
import { EnrollmentError } from '../src/main/steam/enroll';

/**
 * **The stretch between asking Steam and hearing back.**
 *
 * An operation whose outcome nobody knows is written to the account row — but
 * by `latch`, which runs *after* Steam answers. So everything that can go wrong
 * in between left no trace at all: the vault locking on the idle timer while the
 * user is off finding an emailed code, a crash, a power cut, the machine being
 * shut down. On the next start the account looked ordinary, and the same button
 * offered the same irreversible call, having already made it once.
 *
 * The note is written before the request goes now, and outside the vault —
 * because the vault being sealed, or the write to it failing, is most of what
 * goes wrong here.
 *
 * The two failure directions are both tested, and the second matters as much as
 * the first: a note that outlives a perfectly ordinary mistyped code would leave
 * the account reporting an unfinished operation for ever, telling the user to go
 * and check Steam over nothing at all.
 */

const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string) => handlers.delete(channel)
	},
	dialog: {},
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import { authenticatorFingerprint } from '../src/main/steam/enrollment';
import {
	fileOperationJournal,
	type OperationJournal,
	type PendingOperation
} from '../src/main/steam/operation-journal';
import { ProxyConsent } from '../src/main/net/proxy-consent';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const STEAM_ID = '76561198000000001';

function account(): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
		identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
		status: 'pendingActivation',
		addedAt: '2026-01-01T00:00:00.000Z'
	} as unknown as Account;
}

function vaultHolding(accounts: Account[]): VaultService {
	return {
		isUnlocked: () => true,
		touch: () => undefined,
		read: () => ({ accounts }),
		mutate: (apply: (draft: { accounts: Account[] }) => void) => {
			apply({ accounts });
			return Promise.resolve();
		},
		settings: () => ({ requireProxies: false }),
		verifyPassphrase: () => Promise.resolve(undefined)
	} as unknown as VaultService;
}

/** The journal as a map, so a test can inspect it between "sessions". */
function memoryJournal(): OperationJournal & { entries: Map<string, PendingOperation> } {
	const entries = new Map<string, PendingOperation>();
	return {
		entries,
		record: (operation) => {
			entries.set(`${operation.steamId64}.${operation.kind}`, operation);
		},
		clear: (steamId64, kind) => {
			entries.delete(`${steamId64}.${kind}`);
		},
		read: (steamId64) =>
			entries.get(`${steamId64}.activate`) ?? entries.get(`${steamId64}.deactivate`)
	};
}

function register(
	vault: VaultService,
	overrides: Partial<EnrollmentService>,
	journal: OperationJournal
): void {
	registerEnrollmentHandlers(
		overrides as EnrollmentService,
		vault,
		{ show: () => Promise.resolve(undefined) },
		() => undefined,
		{ pick: () => Promise.resolve(undefined) },
		new ProxyConsent(),
		journal
	);
}

function handlerFor(channel: string): (event: unknown, request: unknown) => Promise<unknown> {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`${channel} was not registered`);
	return handler;
}

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

const ACTIVATE = { steamId64: STEAM_ID, code: '12345' };

describe('an activation that is about to be sent', () => {
	it('is written down before Steam is asked, not after it answers', async () => {
		const journal = memoryJournal();
		let noteDuringTheCall: PendingOperation | undefined;

		register(
			vaultHolding([account()]),
			{
				activate: () => {
					// Standing in for everything that can happen here: a lock, a crash, a
					// power cut. Whatever is on disk at this instant is all a later start
					// will have.
					noteDuringTheCall = journal.read(STEAM_ID);
					return Promise.reject(new EnrollmentError('no answer', true, true));
				}
			},
			journal
		);

		await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE);

		expect(
			noteDuringTheCall,
			'nothing was written down before the request went, so a lock or a crash while Steam ' +
				'was being waited on left no trace of an irreversible call that had already been made'
		).toMatchObject({ steamId64: STEAM_ID, kind: 'activate' });
	});

	it('names the authenticator it was about', async () => {
		const journal = memoryJournal();
		let noteDuringTheCall: PendingOperation | undefined;

		register(
			vaultHolding([account()]),
			{
				activate: () => {
					noteDuringTheCall = journal.read(STEAM_ID);
					return Promise.reject(new EnrollmentError('no answer', true, true));
				}
			},
			journal
		);
		await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE);

		expect(noteDuringTheCall?.fingerprint).toBe(authenticatorFingerprint(account()));
	});
});

/*
 * The payoff: a second session over the same account, with nothing in the vault,
 * because the vault write never happened.
 */
describe('the next start after an interrupted operation', () => {
	it('refuses to offer the irreversible call again', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(account()),
			at: '2026-01-01T00:00:00.000Z'
		});

		const activate = vi.fn(() => Promise.resolve('activated' as never));
		register(vaultHolding([account()]), { activate }, journal);

		const result = await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE);

		expect(
			activate,
			'the account looked ordinary after the restart and the request went to Steam a second time'
		).not.toHaveBeenCalled();
		expect(result).toMatchObject({ state: 'uncertain', persisted: true });
	});

	it('tells the user to go and look at the account', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(account()),
			at: '2026-01-01T00:00:00.000Z'
		});
		register(
			vaultHolding([account()]),
			{ activate: () => Promise.resolve('activated' as never) },
			journal
		);

		const result = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			guidance: string;
		};

		expect(result.guidance).toMatch(/check whether Steam Guard/i);
	});

	/*
	 * A note about an authenticator that has since been replaced does not apply to
	 * the one that took its place — the same rule the vault record follows, and
	 * for the same reason: refusing on it would block an account with nothing able
	 * to lift the refusal.
	 */
	it('ignores a note about an authenticator that has been replaced', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: 'a different authenticator',
			at: '2026-01-01T00:00:00.000Z'
		});

		const activate = vi.fn(() => Promise.resolve('activated' as never));
		register(vaultHolding([account()]), { activate }, journal);

		await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE);
		expect(activate).toHaveBeenCalled();
	});
});

describe('an operation that finished', () => {
	it('leaves no note behind when it succeeds', async () => {
		const journal = memoryJournal();
		register(
			vaultHolding([account()]),
			{ activate: () => Promise.resolve('activated' as never) },
			journal
		);

		await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE);

		expect(
			journal.read(STEAM_ID),
			'a completed activation left a note, so the next start reports an unfinished operation ' +
				'on an account that is perfectly fine'
		).toBeUndefined();
	});

	/*
	 * **The regression this whole mechanism invites.** A wrong code is Steam
	 * telling us plainly that nothing happened. Keeping the note would turn every
	 * typo into an account that reports an unfinished operation for ever.
	 */
	it('leaves no note behind when Steam refuses outright', async () => {
		const journal = memoryJournal();
		register(
			vaultHolding([account()]),
			{ activate: () => Promise.reject(new EnrollmentError('that code was not accepted', false)) },
			journal
		);

		await expect(handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)).rejects.toThrow();

		expect(
			journal.read(STEAM_ID),
			'a mistyped code left a note, so an ordinary typo makes the account report an ' +
				'unfinished operation and tells the user to go and check Steam over nothing at all'
		).toBeUndefined();
	});

	it('leaves no note behind once the user has resolved it', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(account()),
			at: '2026-01-01T00:00:00.000Z'
		});
		register(
			vaultHolding([account()]),
			{ reconcileActivated: () => Promise.resolve(true) },
			journal
		);

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			steamActed: true
		});

		expect(
			journal.read(STEAM_ID),
			'the answer was given and the note came back from disk anyway, which is how an account ' +
				'ends up refusing every operation with nothing able to lift it'
		).toBeUndefined();
	});
});

/**
 * The file-backed journal itself. Small, and the part that has to survive the
 * process going away mid-write.
 */
describe('the journal on disk', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'oda-journal-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const note: PendingOperation = {
		steamId64: STEAM_ID,
		kind: 'activate',
		fingerprint: 'abcdef0123456789',
		at: '2026-01-01T00:00:00.000Z'
	};

	it('reads back what a previous process wrote', () => {
		fileOperationJournal(dir).record(note);

		// A different instance, as the next start would build.
		expect(fileOperationJournal(dir).read(STEAM_ID)).toEqual(note);
	});

	it('forgets it once cleared', () => {
		const journal = fileOperationJournal(dir);
		journal.record(note);
		journal.clear(STEAM_ID, 'activate');

		expect(fileOperationJournal(dir).read(STEAM_ID)).toBeUndefined();
	});

	it('leaves no temporary file behind', () => {
		fileOperationJournal(dir).record(note);

		const stray = readdirSync(join(dir, 'pending-operations')).filter((name) =>
			name.endsWith('.tmp')
		);
		expect(stray, 'a half-written file was left at a name a later start could read').toEqual([]);
	});

	/*
	 * The filename is built from the SteamID, so a malformed one must not be able
	 * to name a path outside the directory.
	 */
	it('refuses to write an id that is not a SteamID', () => {
		fileOperationJournal(dir).record({ ...note, steamId64: '../../escaped' });

		// `<dir>/pending-operations/../../escaped...` resolves above the journal
		// directory entirely, so the check has to be for the escaped path itself —
		// an empty journal directory is also what a write that went elsewhere leaves.
		expect(
			existsSync(join(dir, '..', 'escaped.activate.json')),
			'a malformed id named a path outside the journal directory and the write followed it'
		).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it('does not fail when clearing something that was never there', () => {
		expect(() => fileOperationJournal(dir).clear(STEAM_ID, 'deactivate')).not.toThrow();
	});
});

/**
 * **A dependency that defaults to doing nothing has to be wired, and checked.**
 *
 * `registerEnrollmentHandlers` takes a journal that defaults to remembering
 * nothing, so the six existing call sites keep compiling. That default is also
 * exactly how `requireProxies` shipped as a field the schema stored, the
 * docblock described at length, and no code ever read — a whole security
 * setting that did nothing, with a green suite throughout.
 *
 * Asserted against the source because this is a wiring line in `index.ts`, and
 * there is no way to boot the main process in a unit test.
 */
describe('the main process', () => {
	const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

	it('gives the enrolment handlers a journal that writes to disk', () => {
		expect(
			main,
			'the handlers were left with the journal that remembers nothing, so every note this ' +
				'mechanism writes is discarded and an interrupted operation is invisible again'
		).toContain("fileOperationJournal(app.getPath('userData'))");
	});
});

const REMOVE = {
	steamId64: STEAM_ID,
	passphrase: 'a passphrase long enough',
	acknowledgement: 'REMOVE STEAM GUARD'
};

/**
 * **An answer that could not be acted on has not been acted on.**
 *
 * The note was cleared as soon as the three identity checks agreed the answer
 * was about this record — before the work. Every branch after that point can
 * fail without changing anything: a mistyped vault passphrase rejects inside
 * `reconcileDetached`, and both reconciliations return false when the
 * authenticator has moved on. Each of those deliberately leaves the vault's
 * record standing so the refusal survives, and the note had already gone.
 *
 * Where the note is the only record — which is the case it exists for, the one
 * where `latch`'s vault write never happened — a single typo destroyed the
 * durable refusal, and the next attempt sent the irreversible request again.
 */
describe('resolving an operation that then fails', () => {
	it('keeps the note when the passphrase is refused', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'deactivate',
			fingerprint: authenticatorFingerprint(account()),
			at: '2026-01-01T00:00:00.000Z'
		});

		register(
			vaultHolding([account()]),
			{ reconcileDetached: () => Promise.reject(new Error('that passphrase was not accepted')) },
			journal
		);

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'deactivate',
				steamActed: true,
				passphrase: 'a passphrase long enough'
			})
		).rejects.toThrow();

		expect(
			journal.read(STEAM_ID),
			'one typo in the vault passphrase destroyed the only durable record that an irreversible ' +
				'request had already gone to Steam, so the next attempt sends it again'
		).toBeDefined();
	});

	it('keeps the note when the authenticator has moved on', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(account()),
			at: '2026-01-01T00:00:00.000Z'
		});

		register(
			vaultHolding([account()]),
			{ reconcileActivated: () => Promise.resolve(false) },
			journal
		);

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				steamActed: true
			})
		).rejects.toThrow();

		expect(
			journal.read(STEAM_ID),
			'nothing was reconciled and the record went anyway'
		).toBeDefined();
	});

	it('clears it once the answer is actually acted on', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(account()),
			at: '2026-01-01T00:00:00.000Z'
		});

		register(
			vaultHolding([account()]),
			{ reconcileActivated: () => Promise.resolve(true) },
			journal
		);

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			steamActed: true
		});

		expect(journal.read(STEAM_ID)).toBeUndefined();
	});
});

/**
 * **A stale vault record must not hide a note about the authenticator in hand.**
 *
 * `recordFor` consulted the note only when the account row carried no
 * `unresolvedOperation` at all. But a record whose fingerprint no longer matches
 * is treated everywhere else as no record — so an account holding a left-over
 * one masked a note about the authenticator it holds *now*, and the irreversible
 * call went straight through. That is the single case the note exists for.
 *
 * Stale records persist rather than being rare: `mergeAccount` in the import
 * service spreads the existing row and never clears `unresolvedOperation`, so a
 * Replace-existing import leaves one behind indefinitely.
 */
describe('a note about the current authenticator', () => {
	/** The row as an import-replace leaves it: new secret, old record. */
	function replacedAccount(): Account {
		const row = account() as Account & {
			unresolvedOperation?: Record<string, unknown>;
		};
		row.unresolvedOperation = {
			kind: 'activate',
			guidance: 'an older operation, about an authenticator that has since been replaced',
			fingerprint: 'the authenticator that used to be here',
			at: '2025-01-01T00:00:00.000Z'
		};
		return row;
	}

	it('is still enforced when the row carries a stale record', async () => {
		const journal = memoryJournal();
		const row = replacedAccount();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'deactivate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});

		const deactivate = vi.fn(() => Promise.resolve());
		register(vaultHolding([row]), { deactivate }, journal);

		const result = await handlerFor(CHANNELS.accountDeactivate)(EVENT, REMOVE);

		expect(
			deactivate,
			'a left-over record about a replaced authenticator hid the note about the current one, ' +
				'so RemoveAuthenticator went to Steam a second time for an operation whose outcome ' +
				'nobody knows'
		).not.toHaveBeenCalled();
		expect(result).toMatchObject({ state: 'uncertain' });
	});

	/*
	 * And the stale record is still clearable, which is what gives the account
	 * back rather than refusing it forever.
	 */
	it('still lets a stale record be resolved away', async () => {
		const journal = memoryJournal();
		const row = replacedAccount();
		register(vaultHolding([row]), {}, journal);

		const result = await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			steamActed: false
		});

		expect(result).toEqual({ ok: true });
	});
});
