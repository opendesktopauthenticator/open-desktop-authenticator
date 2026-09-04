import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	existsSync,
	linkSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
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
import { authenticatorFingerprint, EnrollmentService } from '../src/main/steam/enrollment';
import { operationRecordToken } from '../src/main/steam/authenticator-secrets';
import {
	fileOperationJournal,
	memoryOperationJournal as createMemoryOperationJournal,
	type OperationJournal,
	type PendingOperation,
	type PendingOperationInput
} from '../src/main/steam/operation-journal';
import { ProxyConsent } from '../src/main/net/proxy-consent';
import { VaultKeyOperationCoordinator } from '../src/main/vault/key-operation-coordinator';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const STEAM_ID = '76561198000000001';

function journalToken(note: PendingOperation): string {
	return operationRecordToken('journal', note);
}

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
	const backing = createMemoryOperationJournal();
	const entries = new Map<string, PendingOperation>();
	return {
		entries,
		record: (operation) => {
			const recorded = backing.record(operation);
			entries.set(`${operation.steamId64}.${operation.kind}`, recorded);
			return recorded;
		},
		markCertain: (expected) => {
			const recorded = backing.markCertain(expected);
			entries.set(`${recorded.steamId64}.${recorded.kind}`, recorded);
			return recorded;
		},
		clear: (expected) => {
			const identity = 'identity' in expected ? expected.identity : expected;
			const result = backing.clear(expected);
			if (result === 'cleared') entries.delete(`${identity.steamId64}.${identity.kind}`);
			return result;
		},
		inspect: (expected) => backing.inspect(expected),
		readKind: (steamId64, kind) => backing.readKind(steamId64, kind),
		readAll: (steamId64) => backing.readAll(steamId64),
		read: (steamId64) => backing.read(steamId64)
	};
}

function register(
	vault: VaultService,
	overrides: Partial<EnrollmentService>,
	journal: OperationJournal,
	coordinator: VaultKeyOperationCoordinator = new VaultKeyOperationCoordinator(),
	accountMutationBlocked: (steamId64: string) => boolean = () => false,
	onRemoved: (steamId64: string, removed: true) => void = () => undefined
): void {
	registerEnrollmentHandlers(
		overrides as EnrollmentService,
		vault,
		{ show: () => Promise.resolve(undefined) },
		onRemoved,
		{ pick: () => Promise.resolve(undefined) },
		new ProxyConsent(),
		journal,
		coordinator,
		accountMutationBlocked
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

describe('the process-wide activation and removal reservation', () => {
	it.each([
		['activation', CHANNELS.enrollActivate, ACTIVATE, 'activate', 'activated'],
		[
			'removal',
			CHANNELS.accountDeactivate,
			{
				steamId64: STEAM_ID,
				passphrase: 'a passphrase long enough',
				acknowledgement: 'REMOVE STEAM GUARD'
			},
			'deactivate',
			undefined
		]
	] as const)(
		'holds the shared boundary for the complete %s request',
		async (_label, channel, request, method, answer) => {
			const coordinator = new VaultKeyOperationCoordinator();
			const journal = memoryJournal();
			let entered: (() => void) | undefined;
			let release: (() => void) | undefined;
			const atSteam = new Promise<void>((resolve) => (entered = resolve));
			const steamGate = new Promise<void>((resolve) => (release = resolve));
			const operation = vi.fn(async () => {
				entered?.();
				await steamGate;
				return answer as never;
			});
			register(vaultHolding([account()]), { [method]: operation }, journal, coordinator);

			const running = handlerFor(channel)(EVENT, request);
			await atSteam;
			expect(() => coordinator.beginAccountMutation()).toThrow(
				/protected authenticator operation/i
			);
			await expect(coordinator.duringVaultReplacement(() => undefined)).rejects.toThrow(
				/protected authenticator operation/i
			);

			release?.();
			await expect(running).resolves.toBeDefined();
			const releaseAfterward = coordinator.beginAccountMutation();
			releaseAfterward();
		}
	);

	it('releases the boundary when the pre-send journal write fails', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const journal = memoryJournal();
		journal.record = () => {
			throw new Error('journal disk full');
		};
		const activate = vi.fn(() => Promise.resolve('activated' as never));
		register(vaultHolding([account()]), { activate }, journal, coordinator);

		await expect(handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)).rejects.toThrow(
			/journal disk full/i
		);
		expect(activate).not.toHaveBeenCalled();
		const releaseAfterward = coordinator.beginAccountMutation();
		releaseAfterward();
	});

	it('does not let a resolution answer an operation that is still in flight', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const journal = memoryJournal();
		const row = account();
		const note = journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});
		const reconcileActivated = vi.fn(() => Promise.resolve(true));
		register(vaultHolding([row]), { reconcileActivated }, journal, coordinator);
		const releaseLiveActivation = coordinator.beginActivation(STEAM_ID);

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: journalToken(note),
				steamActed: true
			})
		).rejects.toThrow(/authenticator activation.*in progress/i);
		expect(reconcileActivated).not.toHaveBeenCalled();
		expect(journal.readKind(STEAM_ID, 'activate')).toBeDefined();

		releaseLiveActivation();
		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: journalToken(note),
				steamActed: true
			})
		).resolves.toEqual({ ok: true });
		expect(reconcileActivated).toHaveBeenCalledOnce();
		const releaseAfterward = coordinator.beginDeactivation(STEAM_ID);
		releaseAfterward();
	});

	it.each([
		['activation', CHANNELS.enrollActivate, ACTIVATE, 'activate'],
		[
			'removal',
			CHANNELS.accountDeactivate,
			{
				steamId64: STEAM_ID,
				passphrase: 'a passphrase long enough',
				acknowledgement: 'REMOVE STEAM GUARD'
			},
			'deactivate'
		]
	] as const)(
		'refuses %s before writing a note or contacting Steam when durable work owns the account',
		async (_label, channel, request, method) => {
			const coordinator = new VaultKeyOperationCoordinator();
			const journal = memoryJournal();
			const operation = vi.fn();
			const blocked = vi.fn((steamId64: string) => steamId64 === STEAM_ID);
			register(vaultHolding([account()]), { [method]: operation }, journal, coordinator, blocked);

			await expect(handlerFor(channel)(EVENT, request)).rejects.toThrow(
				/saved authenticator workflow/i
			);
			expect(blocked).toHaveBeenCalledWith(STEAM_ID);
			expect(operation).not.toHaveBeenCalled();
			expect(journal.readAll(STEAM_ID)).toEqual([]);

			const releaseAfterward = coordinator.beginAccountMutation();
			releaseAfterward();
		}
	);
});

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
	it('clears a note about a replaced authenticator explicitly before retrying', async () => {
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint({ sharedSecret: 'a different authenticator' }),
			at: '2026-01-01T00:00:00.000Z'
		});

		const activate = vi.fn(() => Promise.resolve('activated' as never));
		register(vaultHolding([account()]), { activate }, journal);

		const displayed = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			state: string;
			kind: 'activate' | 'deactivate';
			staleToken: string;
		};
		expect(displayed.state).toBe('staleOperation');
		expect(activate).not.toHaveBeenCalled();
		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: displayed.kind,
			discardStale: true,
			staleToken: displayed.staleToken
		});
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
		const note = journal.record({
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
			operationToken: journalToken(note),
			steamActed: true
		});

		expect(
			journal.read(STEAM_ID),
			'the answer was given and the note came back from disk anyway, which is how an account ' +
				'ends up refusing every operation with nothing able to lift it'
		).toBeUndefined();
	});

	it('clears the matching vault latch and note together, then permits a later attempt', async () => {
		const journal = memoryJournal();
		const row = account();
		const fingerprint = authenticatorFingerprint(row);
		const note = journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint,
			at: '2026-01-01T00:00:00.000Z'
		});
		row.unresolvedOperation = {
			kind: 'activate',
			guidance: 'Steam did not answer.',
			fingerprint,
			at: note.at,
			operationId: note.identity.recordId
		};
		const activate = vi.fn(() => Promise.resolve('activated' as never));
		register(vaultHolding([row]), { activate }, journal);

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			operationToken: operationRecordToken('vault', {
				steamId64: STEAM_ID,
				...row.unresolvedOperation
			}),
			steamActed: false
		});

		expect(row.unresolvedOperation).toBeUndefined();
		expect(journal.readKind(STEAM_ID, 'activate')).toBeUndefined();
		await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE);
		expect(activate).toHaveBeenCalledOnce();
	});

	it('keeps a known activation result known when cleanup fails', async () => {
		const stored = memoryJournal();
		const journal: OperationJournal = {
			...stored,
			clear: () => {
				throw new Error('busy');
			}
		};
		register(
			vaultHolding([account()]),
			{ activate: () => Promise.resolve('activated' as never) },
			journal
		);

		await expect(handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)).rejects.toThrow(
			/Steam answered the activation request.*safety record could not be cleared/i
		);
		expect(stored.readKind(STEAM_ID, 'activate')).toBeDefined();
	});

	it('keeps a known activation refusal known when cleanup fails', async () => {
		const stored = memoryJournal();
		const journal: OperationJournal = {
			...stored,
			clear: () => {
				throw new Error('busy');
			}
		};
		register(
			vaultHolding([account()]),
			{ activate: () => Promise.reject(new EnrollmentError('that code was refused', false)) },
			journal
		);

		await expect(handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)).rejects.toThrow(
			/did not change Steam.*safety record could not be cleared/i
		);
		expect(stored.readKind(STEAM_ID, 'activate')).toBeDefined();
	});

	it('keeps a known deactivation result known when cleanup fails', async () => {
		const stored = memoryJournal();
		const journal: OperationJournal = {
			...stored,
			clear: () => {
				throw new Error('busy');
			}
		};
		register(vaultHolding([account()]), { deactivate: () => Promise.resolve() }, journal);

		await expect(handlerFor(CHANNELS.accountDeactivate)(EVENT, REMOVE)).rejects.toThrow(
			/Steam removed the authenticator.*safety record could not be cleared/i
		);
		expect(stored.readKind(STEAM_ID, 'deactivate')).toBeDefined();
	});

	it('marks a known deactivation as a deletion when tearing down account state', async () => {
		const removed = vi.fn();
		register(
			vaultHolding([account()]),
			{ deactivate: () => Promise.resolve() },
			memoryJournal(),
			undefined,
			undefined,
			removed
		);

		await handlerFor(CHANNELS.accountDeactivate)(EVENT, REMOVE);

		expect(removed).toHaveBeenCalledWith(STEAM_ID, true);
	});

	it('does not report an explicit resolution as successful while its note remains', async () => {
		const stored = memoryJournal();
		const note = stored.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(account()),
			at: '2026-01-01T00:00:00.000Z'
		});
		const journal: OperationJournal = {
			...stored,
			clear: () => {
				throw new Error('busy');
			}
		};
		register(
			vaultHolding([account()]),
			{ reconcileActivated: () => Promise.resolve(true) },
			journal
		);

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: journalToken(note),
				steamActed: true
			})
		).rejects.toThrow(/busy/);
		expect(stored.readKind(STEAM_ID, 'activate')).toBeDefined();
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

	const note: PendingOperationInput = {
		steamId64: STEAM_ID,
		kind: 'activate',
		fingerprint: 'abcdef0123456789',
		at: '2026-01-01T00:00:00.000Z'
	};

	it('reads back what a previous process wrote', () => {
		const recorded = fileOperationJournal(dir).record(note);

		// A different instance, as the next start would build.
		expect(fileOperationJournal(dir).read(STEAM_ID)).toEqual(recorded);
	});

	it('retains a known Steam acceptance on the exact operation across a restart', () => {
		const firstProcess = fileOperationJournal(dir);
		const recorded = firstProcess.record(note);
		const certain = firstProcess.markCertain(recorded);

		expect(certain).toMatchObject({ identity: recorded.identity, certain: true });
		expect(fileOperationJournal(dir).read(STEAM_ID)).toMatchObject({
			identity: recorded.identity,
			certain: true
		});
		expect(fileOperationJournal(dir).markCertain(recorded)).toMatchObject({ certain: true });
	});

	it('will not attach certainty to a different or already-cleared operation', () => {
		const journal = fileOperationJournal(dir);
		const recorded = journal.record(note);

		expect(() => journal.markCertain({ ...recorded.identity, digest: '0'.repeat(64) })).toThrow(
			/known outcome could not be written/i
		);
		journal.clear(recorded);
		expect(() => journal.markCertain(recorded)).toThrow(/known outcome could not be written/i);
	});

	it('keeps a known Steam acceptance when the vault latch fails, then enforces it after restart', async () => {
		const row = account();
		const baseVault = vaultHolding([row]);
		const failingVault = {
			...baseVault,
			mutate: () => Promise.reject(new Error('vault write failed'))
		} as unknown as VaultService;
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			register(
				failingVault,
				{
					activate: () =>
						Promise.reject(
							new EnrollmentError(
								'Steam accepted the activation, but saving failed.',
								true,
								true,
								true
							)
						)
				},
				fileOperationJournal(dir)
			);

			const first = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
				certain?: boolean;
				persisted?: boolean;
			};
			expect(first).toMatchObject({ certain: true, persisted: true });
			expect(fileOperationJournal(dir).readKind(STEAM_ID, 'activate')).toMatchObject({
				certain: true
			});

			handlers.clear();
			__resetRouterForTests();
			setTrustedSender(() => true);
			register(vaultHolding([row]), {}, fileOperationJournal(dir));
			const blocked = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
				certain?: boolean;
				operationToken: string;
			};
			expect(blocked).toMatchObject({ certain: true });
			await expect(
				handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
					steamId64: STEAM_ID,
					kind: 'activate',
					operationToken: blocked.operationToken,
					steamActed: false
				})
			).rejects.toThrow(/known to have accepted/i);
		} finally {
			logged.mockRestore();
		}
	});

	it('uses the vault certainty latch when the journal certainty upgrade fails', async () => {
		const row = account();
		const journal = memoryJournal();
		journal.markCertain = () => {
			throw new Error('journal certainty write failed');
		};
		const activate = vi.fn(() =>
			Promise.reject(
				new EnrollmentError('Steam accepted the activation, but saving failed.', true, true, true)
			)
		);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			register(vaultHolding([row]), { activate }, journal);

			const first = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
				certain?: boolean;
				persisted?: boolean;
				operationToken: string;
			};

			expect(first).toMatchObject({ certain: true, persisted: true });
			expect(row.unresolvedOperation).toMatchObject({
				kind: 'activate',
				certain: true
			});
			expect(journal.readKind(STEAM_ID, 'activate')?.certain).not.toBe(true);
			await expect(
				handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
					steamId64: STEAM_ID,
					kind: 'activate',
					operationToken: first.operationToken,
					steamActed: false
				})
			).rejects.toThrow(/known to have accepted/i);
			expect(activate).toHaveBeenCalledOnce();
		} finally {
			logged.mockRestore();
		}
	});

	it('keeps the pre-send refusal when both certainty stores fail', async () => {
		const row = account();
		const baseVault = vaultHolding([row]);
		const vault = {
			...baseVault,
			mutate: () => Promise.reject(new Error('vault certainty write failed'))
		} as unknown as VaultService;
		const journal = memoryJournal();
		journal.markCertain = () => {
			throw new Error('journal certainty write failed');
		};
		const activate = vi.fn(() =>
			Promise.reject(
				new EnrollmentError('Steam accepted the activation, but saving failed.', true, true, true)
			)
		);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			register(vault, { activate }, journal);

			await expect(handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)).rejects.toThrow(
				/neither durable certainty record could be written/i
			);
			expect(journal.readKind(STEAM_ID, 'activate')).toMatchObject({
				kind: 'activate',
				fingerprint: authenticatorFingerprint(row)
			});

			const blocked = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
				state: string;
				persisted?: boolean;
			};
			expect(blocked).toMatchObject({ state: 'uncertain', persisted: true });
			expect(activate).toHaveBeenCalledOnce();
		} finally {
			logged.mockRestore();
		}
	});

	it('forgets it once cleared', () => {
		const journal = fileOperationJournal(dir);
		const recorded = journal.record(note);
		journal.clear(recorded);

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
		expect(() => fileOperationJournal(dir).record({ ...note, steamId64: '../../escaped' })).toThrow(
			/invalid.*no Steam request was sent/i
		);

		// `<dir>/pending-operations/../../escaped...` resolves above the journal
		// directory entirely, so the check has to be for the escaped path itself —
		// an empty journal directory is also what a write that went elsewhere leaves.
		expect(
			existsSync(join(dir, '..', 'escaped.activate.json')),
			'a malformed id named a path outside the journal directory and the write followed it'
		).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it('refuses a fabricated clear handle', () => {
		const journal = fileOperationJournal(dir);
		const recorded = journal.record(note);
		expect(() => journal.clear({ ...recorded.identity, digest: '0'.repeat(64) })).toThrow(
			/could not be cleared durably/i
		);
	});

	it('refuses to overwrite malformed final evidence for the exact operation', () => {
		const journalDir = join(dir, 'pending-operations');
		mkdirSync(journalDir, { recursive: true });
		const path = join(journalDir, `${STEAM_ID}.activate.json`);
		writeFileSync(path, '{not valid json', 'utf8');

		expect(() => fileOperationJournal(dir).record(note)).toThrow(
			/could not be written and verified/i
		);
		expect(readFileSync(path, 'utf8')).toBe('{not valid json');
	});

	it('does not hide malformed final evidence under another account', () => {
		const journalDir = join(dir, 'pending-operations');
		mkdirSync(journalDir, { recursive: true });
		writeFileSync(join(journalDir, '76561198000000002.activate.json'), '{not valid json', 'utf8');

		expect(() => fileOperationJournal(dir).readAll(STEAM_ID)).toThrow(/cannot understand/i);
	});

	it("refuses a future record stored under today's exact filename", () => {
		const journalDir = join(dir, 'pending-operations');
		mkdirSync(journalDir, { recursive: true });
		const path = join(journalDir, `${STEAM_ID}.activate.json`);
		const future = JSON.stringify({ ...note, version: 2 });
		writeFileSync(path, future, 'utf8');

		expect(() => fileOperationJournal(dir).readKind(STEAM_ID, 'activate')).toThrow(
			/cannot understand/i
		);
		expect(() => fileOperationJournal(dir).record(note)).toThrow(
			/could not be written and verified/i
		);
		expect(readFileSync(path, 'utf8')).toBe(future);
	});

	it('refuses a newer-looking final record instead of treating it as absent', () => {
		const journalDir = join(dir, 'pending-operations');
		mkdirSync(journalDir, { recursive: true });
		writeFileSync(
			join(journalDir, `${STEAM_ID}.activate.v2.json`),
			JSON.stringify({ ...note, version: 2 }),
			'utf8'
		);

		expect(() => fileOperationJournal(dir).record(note)).toThrow(
			/could not be written and verified/i
		);
		expect(existsSync(join(journalDir, `${STEAM_ID}.activate.json`))).toBe(false);
	});

	it('does not delete the winner when exclusive creation loses a race', () => {
		const winnerFingerprint = 'fedcba9876543210';
		const journal = fileOperationJournal(dir, {
			linkFinal: (stage, path) => {
				if (!path.endsWith('.pending.json')) {
					linkSync(stage, path);
					return;
				}
				const winner = JSON.parse(readFileSync(stage, 'utf8')) as Record<string, unknown>;
				winner.fingerprint = winnerFingerprint;
				writeFileSync(path, JSON.stringify(winner), { flag: 'wx', mode: 0o600 });
				throw Object.assign(new Error('another process won'), { code: 'EEXIST' });
			}
		});

		expect(() => journal.record(note)).toThrow(/could not be written and verified/i);
		const final = readdirSync(join(dir, 'pending-operations', 'v2')).find((name) =>
			name.endsWith('.pending.json')
		);
		expect(final).toBeDefined();
		expect(
			JSON.parse(readFileSync(join(dir, 'pending-operations', 'v2', final!), 'utf8')).fingerprint
		).toBe(winnerFingerprint);
	});

	it('makes a tombstone publication failure observable and leaves the record blocking', () => {
		const written = fileOperationJournal(dir);
		const recorded = written.record(note);
		const cannotDelete = fileOperationJournal(dir, {
			linkFinal: () => {
				throw Object.assign(new Error('busy'), { code: 'EBUSY' });
			}
		});

		expect(() => cannotDelete.clear(recorded)).toThrow(/remains blocked/i);
		expect(fileOperationJournal(dir).readKind(STEAM_ID, 'activate')).toEqual(recorded);
	});
});

describe('a journal that cannot publish its pre-send record', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'oda-journal-refusal-'));
		writeFileSync(join(dir, 'pending-operations'), 'this path is not a directory', 'utf8');
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		[CHANNELS.enrollActivate, ACTIVATE, 'activate'],
		[CHANNELS.accountDeactivate, REMOVE, 'deactivate']
	] as const)('refuses %s before its Steam service is called', async (channel, request, method) => {
		const activate = vi.fn(() => Promise.resolve('activated' as never));
		const deactivate = vi.fn(() => Promise.resolve());
		register(vaultHolding([account()]), { activate, deactivate }, fileOperationJournal(dir));

		await expect(handlerFor(channel)(EVENT, request)).rejects.toThrow(/no request was sent/i);
		expect(method === 'activate' ? activate : deactivate).not.toHaveBeenCalled();
	});

	it.each([
		[CHANNELS.enrollActivate, ACTIVATE, 'activate'],
		[CHANNELS.accountDeactivate, REMOVE, 'deactivate']
	] as const)(
		'refuses %s when a POSIX-style directory flush fails',
		async (channel, request, method) => {
			const clean = mkdtempSync(join(tmpdir(), 'oda-journal-fsync-'));
			const activate = vi.fn(() => Promise.resolve('activated' as never));
			const deactivate = vi.fn(() => Promise.resolve());
			const journal = fileOperationJournal(clean, {
				syncDirectory: () => {
					throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' });
				}
			});
			try {
				register(vaultHolding([account()]), { activate, deactivate }, journal);
				await expect(handlerFor(channel)(EVENT, request)).rejects.toThrow(
					/(?:no request|nothing) was sent/i
				);
				expect(method === 'activate' ? activate : deactivate).not.toHaveBeenCalled();
			} finally {
				rmSync(clean, { recursive: true, force: true });
			}
		}
	);
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
		const note = journal.record({
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
				operationToken: journalToken(note),
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
		const note = journal.record({
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
				operationToken: journalToken(note),
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
		const note = journal.record({
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
			operationToken: journalToken(note),
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
			fingerprint: authenticatorFingerprint({
				sharedSecret: 'the authenticator that used to be here'
			}),
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

	it('lets the live deactivation note win over a newer leftover activation note', async () => {
		const journal = memoryJournal();
		const row = account();
		const fingerprint = authenticatorFingerprint(row);
		journal.record({
			steamId64: STEAM_ID,
			kind: 'deactivate',
			fingerprint,
			at: '2026-01-01T00:00:00.000Z'
		});
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint,
			at: '2026-02-01T00:00:00.000Z'
		});
		const deactivate = vi.fn(() => Promise.resolve());
		register(vaultHolding([row]), { deactivate }, journal);

		const result = await handlerFor(CHANNELS.accountDeactivate)(EVENT, REMOVE);

		expect(deactivate, 'RemoveAuthenticator was sent again').not.toHaveBeenCalled();
		expect(result).toMatchObject({ state: 'uncertain', kind: 'deactivate' });
		expect((result as { guidance: string }).guidance).toMatch(/asked Steam to remove/i);
	});

	it.each([
		['activate', 'deactivate', true],
		['activate', 'deactivate', false],
		['deactivate', 'activate', true],
		['deactivate', 'activate', false]
	] as const)(
		'does not erase a vault %s debt while resolving a disk %s note (Steam acted: %s)',
		async (vaultKind, diskKind, steamActed) => {
			const journal = memoryJournal();
			const row = account();
			const fingerprint = authenticatorFingerprint(row);
			row.unresolvedOperation = {
				kind: vaultKind,
				guidance: `unresolved ${vaultKind}`,
				fingerprint,
				at: '2026-02-01T00:00:00.000Z'
			};
			const note = journal.record({
				steamId64: STEAM_ID,
				kind: diskKind,
				fingerprint,
				at: '2026-01-01T00:00:00.000Z'
			});
			const reconcileActivated = vi.fn(() => Promise.resolve(true));
			const reconcileDetached = vi.fn(() => Promise.resolve(true));
			register(vaultHolding([row]), { reconcileActivated, reconcileDetached }, journal);

			const answer = handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: diskKind,
				operationToken: journalToken(note),
				steamActed,
				passphrase: 'a passphrase long enough'
			});
			if (steamActed) await expect(answer).rejects.toThrow(/unfinished|changed/i);
			else await expect(answer).resolves.toEqual({ ok: true });

			expect(row.unresolvedOperation?.kind).toBe(vaultKind);
			if (steamActed) expect(journal.readKind(STEAM_ID, diskKind)).toBeDefined();
			else expect(journal.readKind(STEAM_ID, diskKind)).toBeUndefined();
			expect(reconcileActivated).not.toHaveBeenCalled();
			expect(reconcileDetached).not.toHaveBeenCalled();
		}
	);

	it('makes an activation note on an active row resolvable through the removal screen path', async () => {
		const journal = memoryJournal();
		const row = account();
		row.status = 'active';
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});
		const reconcileActivated = vi.fn(() => Promise.resolve(true));
		const deactivate = vi.fn(() => Promise.resolve());
		register(vaultHolding([row]), { deactivate, reconcileActivated }, journal);

		const blocked = (await handlerFor(CHANNELS.accountDeactivate)(EVENT, REMOVE)) as {
			state: string;
			kind: 'activate' | 'deactivate';
			operationToken: string;
		};
		expect(blocked).toMatchObject({ state: 'uncertain', kind: 'activate' });
		expect(deactivate).not.toHaveBeenCalled();
		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			operationToken: blocked.operationToken,
			steamActed: true
		});
		expect(reconcileActivated).toHaveBeenCalledWith(
			STEAM_ID,
			authenticatorFingerprint(row),
			expect.objectContaining({ source: 'journal' })
		);
		expect(journal.readKind(STEAM_ID, 'activate')).toBeUndefined();
	});

	/*
	 * And the stale record is still clearable, which is what gives the account
	 * back rather than refusing it forever.
	 */
	it('still lets a stale record be resolved away', async () => {
		const journal = memoryJournal();
		const row = replacedAccount();
		const activate = vi.fn(() => Promise.resolve('activated' as never));
		register(vaultHolding([row]), { activate }, journal);
		const displayed = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			state: string;
			kind: 'activate' | 'deactivate';
			staleToken: string;
		};
		expect(displayed.state).toBe('staleOperation');
		expect(activate).not.toHaveBeenCalled();

		const result = await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: displayed.kind,
			discardStale: true,
			staleToken: displayed.staleToken
		});

		expect(result).toEqual({ ok: true });
	});
});

describe('an old file-backed note about a replaced authenticator', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'oda-stale-operation-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const cases = [
		['activation', CHANNELS.enrollActivate, ACTIVATE, 'activate', 'activated'],
		['removal', CHANNELS.accountDeactivate, REMOVE, 'deactivate', undefined]
	] as const;

	function oldNote(
		journal: OperationJournal,
		kind: 'activate' | 'deactivate',
		fingerprint = authenticatorFingerprint({
			sharedSecret: 'the authenticator that used to be here'
		}),
		at = '2026-01-01T00:00:00.000Z'
	): void {
		journal.record({ steamId64: STEAM_ID, kind, fingerprint, at });
	}

	it.each(cases)(
		'replaces the live %s form with an exact cleanup prompt and does not contact Steam',
		async (_label, channel, request, kind, answer) => {
			const journal = fileOperationJournal(dir);
			oldNote(journal, kind);
			const operation = vi.fn(() => Promise.resolve(answer as never));
			register(vaultHolding([account()]), { [kind]: operation }, journal);

			const result = (await handlerFor(channel)(EVENT, request)) as {
				state: string;
				kind: string;
				staleToken?: string;
			};

			expect(result).toMatchObject({ state: 'staleOperation', kind });
			expect(result.staleToken).toMatch(/^[a-f0-9]{64}$/);
			expect(operation).not.toHaveBeenCalled();
			expect(journal.readKind(STEAM_ID, kind)).toBeDefined();
		}
	);

	it.each(cases)(
		'clears the displayed %s note without reconciliation, then lets a retry reach Steam',
		async (_label, channel, request, kind, answer) => {
			const journal = fileOperationJournal(dir);
			oldNote(journal, kind);
			const operation = vi.fn(() => Promise.resolve(answer as never));
			const reconcileActivated = vi.fn(() => Promise.resolve(true));
			const reconcileDetached = vi.fn(() => Promise.resolve(true));
			register(
				vaultHolding([account()]),
				{ [kind]: operation, reconcileActivated, reconcileDetached },
				journal
			);

			const displayed = (await handlerFor(channel)(EVENT, request)) as {
				kind: 'activate' | 'deactivate';
				staleToken: string;
			};
			await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: displayed.kind,
				discardStale: true,
				staleToken: displayed.staleToken
			});

			expect(journal.readKind(STEAM_ID, kind)).toBeUndefined();
			expect(reconcileActivated).not.toHaveBeenCalled();
			expect(reconcileDetached).not.toHaveBeenCalled();
			await expect(handlerFor(channel)(EVENT, request)).resolves.toBeDefined();
			expect(operation).toHaveBeenCalledOnce();
		}
	);

	it('clears only the exact source and kind that the prompt displayed', async () => {
		const journal = fileOperationJournal(dir);
		oldNote(journal, 'activate');
		oldNote(
			journal,
			'deactivate',
			authenticatorFingerprint({ sharedSecret: 'another old authenticator' })
		);
		register(vaultHolding([account()]), { activate: vi.fn() }, journal);
		const displayed = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			kind: 'activate' | 'deactivate';
			staleToken: string;
		};

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: displayed.kind,
			discardStale: true,
			staleToken: displayed.staleToken
		});

		expect(journal.readKind(STEAM_ID, 'activate')).toBeUndefined();
		expect(journal.readKind(STEAM_ID, 'deactivate')).toBeDefined();
	});

	it('refuses a cleanup token after the displayed note was replaced', async () => {
		const journal = fileOperationJournal(dir);
		oldNote(journal, 'activate');
		register(vaultHolding([account()]), { activate: vi.fn() }, journal);
		const displayed = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			kind: 'activate' | 'deactivate';
			staleToken: string;
		};
		journal.clear(journal.readKind(STEAM_ID, 'activate')!);
		oldNote(
			journal,
			'activate',
			authenticatorFingerprint({ sharedSecret: 'a different old authenticator' }),
			'2026-02-01T00:00:00.000Z'
		);

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: displayed.kind,
				discardStale: true,
				staleToken: displayed.staleToken
			})
		).rejects.toThrow(/changed while.*resolved|changed or is no longer present/i);
		expect(journal.readKind(STEAM_ID, 'activate')?.at).toBe('2026-02-01T00:00:00.000Z');
	});

	it('preserves a note that became applicable before cleanup', async () => {
		const journal = fileOperationJournal(dir);
		const row = account();
		const replacement = account();
		replacement.sharedSecret = 'YSBmdXR1cmUgYXV0aGVudGljYXRvcg==';
		oldNote(journal, 'activate', authenticatorFingerprint(replacement));
		register(vaultHolding([row]), { activate: vi.fn() }, journal);
		const displayed = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			kind: 'activate' | 'deactivate';
			staleToken: string;
		};
		row.sharedSecret = replacement.sharedSecret;

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: displayed.kind,
				discardStale: true,
				staleToken: displayed.staleToken
			})
		).rejects.toThrow(/changed while.*resolved|changed or is no longer present/i);
		expect(journal.readKind(STEAM_ID, 'activate')).toBeDefined();
	});

	it('keeps the record and refuses when its deletion fails', async () => {
		const normal = fileOperationJournal(dir);
		oldNote(normal, 'activate');
		const journal = fileOperationJournal(dir, {
			linkFinal: () => {
				throw new Error('busy');
			}
		});
		const activate = vi.fn();
		register(vaultHolding([account()]), { activate }, journal);
		const displayed = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			kind: 'activate' | 'deactivate';
			staleToken: string;
		};

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: displayed.kind,
				discardStale: true,
				staleToken: displayed.staleToken
			})
		).rejects.toThrow(/could not be cleared/i);
		expect(journal.readKind(STEAM_ID, 'activate')).toBeDefined();
		expect(activate).not.toHaveBeenCalled();
	});
});

describe('exact operation identity at the resolution boundary', () => {
	it('rejects an answer from an older screen after the vault record is replaced', async () => {
		const row = account();
		const current = authenticatorFingerprint(row);
		row.unresolvedOperation = {
			kind: 'activate',
			guidance: 'first operation',
			fingerprint: current,
			at: '2026-01-01T00:00:00.000Z',
			operationId: '11111111-1111-4111-8111-111111111111'
		};
		register(
			vaultHolding([row]),
			{ reconcileActivated: () => Promise.resolve(true) },
			memoryJournal()
		);
		const first = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			operationToken: string;
		};
		row.unresolvedOperation = {
			kind: 'activate',
			guidance: 'replacement operation',
			fingerprint: current,
			at: '2026-01-02T00:00:00.000Z',
			operationId: '22222222-2222-4222-8222-222222222222'
		};

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: first.operationToken,
				steamActed: false
			})
		).rejects.toThrow(/exact operation|changed|resolved/i);
		expect(row.unresolvedOperation.guidance).toBe('replacement operation');
	});

	it('does not infer companions from equal fields when operation ids differ', async () => {
		const row = account();
		const journal = memoryJournal();
		const note = journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});
		row.unresolvedOperation = {
			kind: note.kind,
			guidance: 'vault copy',
			fingerprint: note.fingerprint,
			at: note.at,
			operationId: '33333333-3333-4333-8333-333333333333'
		};
		register(vaultHolding([row]), {}, journal);
		const shown = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			operationToken: string;
		};

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			operationToken: shown.operationToken,
			steamActed: false
		});

		expect(row.unresolvedOperation).toBeUndefined();
		expect(journal.readKind(STEAM_ID, 'activate')).toEqual(note);
	});

	it('clears vault and journal together only when their operation id and fields match', async () => {
		const row = account();
		const journal = memoryJournal();
		const note = journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});
		row.unresolvedOperation = {
			kind: note.kind,
			guidance: 'vault copy',
			fingerprint: note.fingerprint,
			at: note.at,
			operationId: note.identity.recordId
		};
		register(vaultHolding([row]), {}, journal);
		const shown = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			operationToken: string;
		};

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			operationToken: shown.operationToken,
			steamActed: false
		});

		expect(row.unresolvedOperation).toBeUndefined();
		expect(journal.readKind(STEAM_ID, 'activate')).toBeUndefined();
	});

	it('can clear an exact stale vault record while preserving the applicable journal note', async () => {
		const row = account();
		const journal = memoryJournal();
		const note = journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-02T00:00:00.000Z'
		});
		row.unresolvedOperation = {
			kind: 'activate',
			guidance: 'old authenticator',
			fingerprint: '0123456789abcdef',
			at: '2026-01-01T00:00:00.000Z',
			operationId: '44444444-4444-4444-8444-444444444444'
		};
		const staleToken = operationRecordToken('vault', {
			steamId64: STEAM_ID,
			...row.unresolvedOperation
		});
		register(vaultHolding([row]), {}, journal);
		const shown = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			operationToken: string;
		};
		expect(shown.operationToken).toBe(journalToken(note));

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			discardStale: true,
			staleToken
		});

		expect(row.unresolvedOperation).toBeUndefined();
		expect(journal.readKind(STEAM_ID, 'activate')).toEqual(note);
	});

	it('reconciles a current activation note without consuming stale vault evidence', async () => {
		const row = account();
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-02T00:00:00.000Z'
		});
		row.unresolvedOperation = {
			kind: 'deactivate',
			guidance: 'older authenticator',
			fingerprint: '0123456789abcdef',
			at: '2026-01-01T00:00:00.000Z'
		};
		const vault = vaultHolding([row]);
		register(vault, new EnrollmentService(vault, {} as SteamTransportFactory, {}), journal);
		const shown = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			operationToken: string;
		};

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			operationToken: shown.operationToken,
			steamActed: true
		});

		expect(row.status).toBe('active');
		expect(row.unresolvedOperation?.guidance).toBe('older authenticator');
		expect(journal.readKind(STEAM_ID, 'activate')).toBeUndefined();
	});

	it('reconciles a current removal note despite stale vault evidence and tears down the account', async () => {
		const row = account();
		row.status = 'active';
		const accounts = [row];
		const journal = memoryJournal();
		journal.record({
			steamId64: STEAM_ID,
			kind: 'deactivate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-02T00:00:00.000Z'
		});
		row.unresolvedOperation = {
			kind: 'activate',
			guidance: 'older authenticator',
			fingerprint: '0123456789abcdef',
			at: '2026-01-01T00:00:00.000Z'
		};
		const vault = vaultHolding(accounts);
		const removed = vi.fn();
		register(
			vault,
			new EnrollmentService(vault, {} as SteamTransportFactory, {}),
			journal,
			undefined,
			undefined,
			removed
		);
		const shown = (await handlerFor(CHANNELS.accountDeactivate)(EVENT, {
			...REMOVE
		})) as { operationToken: string };

		await handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
			steamId64: STEAM_ID,
			kind: 'deactivate',
			operationToken: shown.operationToken,
			steamActed: true,
			passphrase: 'a passphrase long enough'
		});

		expect(accounts).toEqual([]);
		expect(journal.readKind(STEAM_ID, 'deactivate')).toBeUndefined();
		expect(removed).toHaveBeenCalledWith(STEAM_ID, true);
	});

	it('does not let a known Steam success be answered as though Steam did nothing', async () => {
		const row = account();
		row.unresolvedOperation = {
			kind: 'activate',
			guidance: 'Steam accepted the request',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z',
			certain: true,
			operationId: '55555555-5555-4555-8555-555555555555'
		};
		register(vaultHolding([row]), {}, memoryJournal());
		const shown = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			operationToken: string;
		};

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: shown.operationToken,
				steamActed: false
			})
		).rejects.toThrow(/known to have accepted/i);
		expect(row.unresolvedOperation?.certain).toBe(true);
	});

	it('enforces certainty when an exact journal token names the paired vault record', async () => {
		const row = account();
		const journal = memoryJournal();
		const note = journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});
		row.unresolvedOperation = {
			kind: note.kind,
			guidance: 'Steam accepted the request',
			fingerprint: note.fingerprint,
			at: note.at,
			operationId: note.identity.recordId,
			certain: true
		};
		register(vaultHolding([row]), {}, journal);

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: journalToken(note),
				steamActed: false
			})
		).rejects.toThrow(/known to have accepted/i);
		expect(row.unresolvedOperation?.certain).toBe(true);
		expect(journal.readKind(STEAM_ID, 'activate')).toEqual(note);
	});

	it('displays certainty from an exact journal companion when the preferred vault copy lacks it', async () => {
		const row = account();
		const journal = memoryJournal();
		const note = journal.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});
		journal.markCertain(note);
		row.unresolvedOperation = {
			kind: note.kind,
			guidance: 'The vault copy did not yet know whether Steam acted.',
			fingerprint: note.fingerprint,
			at: note.at,
			operationId: note.identity.recordId
		};
		const activate = vi.fn();
		register(vaultHolding([row]), { activate }, journal);

		const shown = (await handlerFor(CHANNELS.enrollActivate)(EVENT, ACTIVATE)) as {
			certain?: boolean;
			guidance: string;
			operationToken: string;
		};

		expect(shown.certain).toBe(true);
		expect(shown.guidance).toMatch(/Steam accepted/i);
		expect(activate).not.toHaveBeenCalled();
		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: shown.operationToken,
				steamActed: false
			})
		).rejects.toThrow(/known to have accepted/i);
	});

	it('tears down the session even when journal cleanup fails after local deletion', async () => {
		const row = account();
		const stored = memoryJournal();
		const note = stored.record({
			steamId64: STEAM_ID,
			kind: 'deactivate',
			fingerprint: authenticatorFingerprint(row),
			at: '2026-01-01T00:00:00.000Z'
		});
		const journal: OperationJournal = {
			...stored,
			clear: () => {
				throw new Error('disk busy');
			}
		};
		const removed = vi.fn();
		register(
			vaultHolding([row]),
			{ reconcileDetached: () => Promise.resolve(true) },
			journal,
			undefined,
			undefined,
			removed
		);

		await expect(
			handlerFor(CHANNELS.accountResolveOperation)(EVENT, {
				steamId64: STEAM_ID,
				kind: 'deactivate',
				operationToken: journalToken(note),
				steamActed: true,
				passphrase: 'a passphrase long enough'
			})
		).rejects.toThrow(/disk busy/i);
		expect(removed).toHaveBeenCalledWith(STEAM_ID, true);
	});
});
