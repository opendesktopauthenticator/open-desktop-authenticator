import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CHANNELS } from '../src/shared/channels';
import { EnrollmentError } from '../src/main/steam/enroll';
import {
	authenticatorFingerprint,
	operationRecordToken
} from '../src/main/steam/authenticator-secrets';

/**
 * **A promise that lasted exactly as long as a React component.**
 *
 * An activation or a removal whose reply never arrived comes back as an outcome
 * rather than an error, so the screen stops offering the action and says the
 * application will not send the request again. That refusal lived in component
 * state. Close the screen — or restart — and "Finish activation" and "Remove"
 * were offered again, by an application that had just said in as many words that
 * they would not be.
 *
 * It is written to the account now, because the vault is the only thing here
 * that outlives both, and it is cleared by the user saying they have checked the
 * account: nothing local can settle what Steam did, and pretending otherwise is
 * how the first version of this went wrong.
 *
 * These drive the real handlers against a vault that records what was written,
 * so what is asserted is the durable record rather than a screen's state.
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
import { memoryOperationJournal, type OperationJournal } from '../src/main/steam/operation-journal';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const STEAM_ID = '76561198000000001';
const GUIDANCE = 'Steam was asked to remove the authenticator and did not answer.';

/** An account row the handlers can find and write to, as the vault holds it. */
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

/** A vault that keeps what a mutate wrote, which is the whole point here. */
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

beforeEach(() => {
	handlers.clear();
	__resetRouterForTests();
	setTrustedSender(() => true);
});

function register(vault: VaultService, overrides: Partial<EnrollmentService>): OperationJournal {
	const journal = memoryOperationJournal();
	registerEnrollmentHandlers(
		overrides as EnrollmentService,
		vault,
		{ show: () => Promise.resolve(undefined) },
		undefined,
		undefined,
		undefined,
		journal
	);
	return journal;
}

const REMOVE = {
	steamId64: STEAM_ID,
	passphrase: 'a passphrase long enough',
	acknowledgement: 'REMOVE STEAM GUARD'
};

describe('a removal whose outcome was never established', () => {
	it('is written to the account, not only to the screen', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		await handler(EVENT, REMOVE);

		expect(
			accounts[0]?.unresolvedOperation,
			'nothing outside the screen recorded it, so closing the screen or restarting offered ' +
				'the removal again — after the application said it would not send it a second time'
		).toMatchObject({ kind: 'deactivate', guidance: GUIDANCE });
	});

	it('records when Steam is known to have acted', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		await handler(EVENT, REMOVE);

		expect(accounts[0]?.unresolvedOperation?.certain).toBe(true);
	});

	/* An ordinary failure is not an unresolved operation. */
	it('is not recorded when the request never went', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), {
			deactivate: () => Promise.reject(new EnrollmentError('that code is wrong', false, false))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		await expect(handler(EVENT, REMOVE)).rejects.toThrow();

		expect(
			accounts[0]?.unresolvedOperation,
			'a refusal Steam never received left the account carrying a warning for ever'
		).toBeUndefined();
	});

	it('is not recorded by a successful removal', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), { deactivate: () => Promise.resolve() });
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		await handler(EVENT, REMOVE);

		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});
});

/**
 * **The record has to be about the authenticator the operation ran against.**
 *
 * The fingerprint was stamped from whatever row was there *after* the Steam
 * call failed, by SteamID alone. An import-replace landing during that call
 * therefore produced a record about the replacement — and the resolve guard
 * then compares the replacement against itself, agrees, and lets "yes, Steam
 * did it" act on an authenticator the operation never touched. For a removal
 * that is a splice of live secrets.
 *
 * It is not a lucky race: the import's own commit drops the account's routing,
 * which aborts the request in flight, so the replace is what *causes* the
 * uncertain outcome whose record is then mis-stamped.
 */
describe('a row replaced while the Steam call was failing', () => {
	it('is not what the record ends up describing', async () => {
		const accounts = [account()];
		const replaced = account();
		replaced.sharedSecret = 'YSBkaWZmZXJlbnQgc2VjcmV0';

		const journal = register(vaultHolding(accounts), {
			deactivate: () => {
				// The import lands while Steam is failing to answer.
				accounts[0] = replaced;
				return Promise.reject(new EnrollmentError(GUIDANCE, true, true));
			}
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(
			accounts[0]?.unresolvedOperation,
			'the record was stamped with the replacement authenticator, so resolving it would act ' +
				'on one the operation never touched'
		).toBeUndefined();
		expect(result.persisted).toBe(true);
		expect(journal.readKind(STEAM_ID, 'deactivate')?.fingerprint).not.toBe(
			createHash('sha256').update(replaced.sharedSecret).digest('hex').slice(0, 16)
		);
	});

	/* The ordinary case still records, against the row it really ran on. */
	it('still records when the row is the one it ran against', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(result.persisted).toBe(true);
		expect(accounts[0]?.unresolvedOperation?.fingerprint).toBe(
			createHash('sha256').update(accounts[0]!.sharedSecret).digest('hex').slice(0, 16)
		);
	});
});

describe('an activation whose outcome was never established', () => {
	it('is written to the account', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), {
			activate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		await handler(EVENT, { steamId64: STEAM_ID, code: '12345' });

		expect(accounts[0]?.unresolvedOperation).toMatchObject({ kind: 'activate' });
	});

	it('is not recorded by an ordinary activation', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), { activate: () => Promise.resolve('activated' as const) });
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		await handler(EVENT, { steamId64: STEAM_ID, code: '12345' });

		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});

	it('carries a recovery-backup warning across IPC without calling activation failed', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), {
			activateWithRecoveryStatus: () =>
				Promise.resolve({
					state: 'activated' as const,
					recoveryWarning: 'The encrypted recovery backup could not be updated.'
				})
		});
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		await expect(handler(EVENT, { steamId64: STEAM_ID, code: '12345' })).resolves.toEqual({
			state: 'activated',
			recoveryWarning: 'The encrypted recovery backup could not be updated.'
		});
		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});
});

/**
 * **And only the user can clear it.**
 *
 * Nothing in this process knows what Steam did, so there is no local event that
 * settles the record — which means without an explicit way out the account
 * carries the warning for ever, and a warning that never clears is one people
 * learn to ignore.
 */
/**
 * **Only the user can clear it - and only for the thing they were asked about.**
 *
 * The first version took a SteamID and a yes/no, read whichever record was
 * stored, and acted on it. Each of those was a way to act on the wrong thing:
 * an activation screen could resolve a left-over removal record, where "yes"
 * means "the removal succeeded" and deletes the account; a record about a
 * replaced authenticator matched its replacement, because a SteamID outlives
 * the authenticator attached to it; and an absent record answered ok for doing
 * nothing at all.
 *
 * They are refusals now, and these are mostly about what it declines to do.
 */
describe('resolving an unresolved operation', () => {
	/** The digest the handler compares against, computed the same way it does. */
	const fingerprint = (secret: string): string =>
		createHash('sha256').update(secret).digest('hex').slice(0, 16);

	function latched(
		kind: 'activate' | 'deactivate',
		overrides: Record<string, unknown> = {}
	): Account[] {
		const held = [account()];
		held[0]!.unresolvedOperation = {
			kind,
			guidance: GUIDANCE,
			fingerprint: fingerprint(held[0]!.sharedSecret),
			at: '2026-01-01T00:00:00.000Z',
			...overrides
		};
		return held;
	}

	/** Records what the handler delegated, so the guards can be tested alone. */
	function serviceSpy() {
		const activated: string[] = [];
		const detached: { steamId64: string; passphrase: string }[] = [];
		return {
			activated,
			detached,
			overrides: {
				reconcileActivated: (steamId64: string) => {
					activated.push(steamId64);
					return Promise.resolve(true);
				},
				reconcileDetached: (steamId64: string, passphrase: string) => {
					detached.push({ steamId64, passphrase });
					return Promise.resolve(true);
				}
			} as Partial<EnrollmentService>
		};
	}

	function resolve(accounts: Account[], request: Record<string, unknown>) {
		const spy = serviceSpy();
		register(vaultHolding(accounts), spy.overrides);
		const handler = handlers.get(CHANNELS.accountResolveOperation);
		if (!handler) throw new Error('accountResolveOperation was not registered');
		const record = accounts[0]?.unresolvedOperation;
		const operationToken =
			record === undefined
				? '0'.repeat(64)
				: operationRecordToken('vault', { steamId64: STEAM_ID, ...record });
		return {
			spy,
			run: handler(EVENT, {
				steamId64: STEAM_ID,
				...(!('discardStale' in request) ? { operationToken } : {}),
				...request
			})
		};
	}

	it('lifts the refusal when Steam did nothing', async () => {
		const accounts = latched('deactivate');
		const { run } = resolve(accounts, { kind: 'deactivate', steamActed: false });

		expect(await run).toEqual({ ok: true });
		expect(accounts[0]?.unresolvedOperation, 'the refusal stayed, so no retry is possible').toBe(
			undefined
		);
		expect(accounts.length, 'an account Steam never touched was deleted').toBe(1);
	});

	/**
	 * **The one that deleted an account.** An activation screen answering "yes,
	 * Steam Guard is on" against a stored *removal* record meant "the removal
	 * succeeded" to the handler, which removed the account.
	 */
	it('refuses an answer about a different operation', async () => {
		const accounts = latched('deactivate');
		const { run, spy } = resolve(accounts, { kind: 'activate', steamActed: true });

		await expect(run).rejects.toThrow(/different unfinished operation/i);
		expect(accounts.length, 'the account was deleted by an answer about an activation').toBe(1);
		expect(spy.detached, 'a removal was reconciled from an activation answer').toEqual([]);
	});

	/**
	 * **And the one that acted on a replacement.** A SteamID outlives the
	 * authenticator attached to it, so a record about a removed authenticator
	 * matched the one imported to replace it.
	 */
	/**
	 * **A record about an authenticator that is gone is cleared, not refused.**
	 *
	 * Refusing it was the first attempt at this, and it was worse than the defect
	 * it closed: `heldBack` blocks every activation and removal while a record
	 * exists, and the only way out — the resolution — refused too. An account
	 * whose authenticator had been re-imported could not be used or unblocked by
	 * any route in the application. The message even claimed the record had been
	 * cleared while nothing cleared it.
	 */
	it('clears a record about an authenticator that has been replaced', async () => {
		const accounts = latched('activate', { fingerprint: fingerprint('a different secret') });
		const record = accounts[0]!.unresolvedOperation!;
		const { run, spy } = resolve(accounts, {
			kind: 'activate',
			discardStale: true,
			staleToken: operationRecordToken('vault', { steamId64: STEAM_ID, ...record })
		});

		expect(await run).toEqual({ ok: true });
		expect(
			spy.activated,
			'a replacement authenticator was marked active by a record about the one it replaced'
		).toEqual([]);
		expect(
			accounts[0]?.unresolvedOperation,
			'the record about a vanished authenticator survived, so the account stays blocked for ever'
		).toBeUndefined();
	});

	/*
	 * A record written before fingerprints existed cannot be matched. Treating a
	 * missing fingerprint as a mismatch made the destructive clear-old-record
	 * path available with no evidence that the record belonged to an older
	 * authenticator.
	 */
	it('refuses to clear or reconcile a record with no fingerprint at all', async () => {
		const accounts = latched('activate', { fingerprint: undefined });
		const record = accounts[0]!.unresolvedOperation!;
		const spy = serviceSpy();
		register(vaultHolding(accounts), spy.overrides);
		const handler = handlers.get(CHANNELS.accountResolveOperation);
		if (!handler) throw new Error('accountResolveOperation was not registered');

		await expect(
			handler(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: '0'.repeat(64),
				steamActed: true
			})
		).rejects.toThrow(/does not identify/i);
		await expect(
			handler(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				discardStale: true,
				staleToken: operationRecordToken('vault', { steamId64: STEAM_ID, ...record })
			})
		).rejects.toThrow(/does not identify/i);

		expect(spy.activated).toEqual([]);
		expect(accounts[0]?.unresolvedOperation).toBe(record);
	});

	it.each([
		'',
		'a'.repeat(15),
		'a'.repeat(17),
		'ABCDEF0123456789',
		'gggggggggggggggg',
		'a fingerprint from a different authenticator'
	])(
		'refuses to display, clear, or reconcile an unverifiable fingerprint (%j)',
		async (fingerprintValue) => {
			const accounts = latched('activate', { fingerprint: fingerprintValue });
			const record = accounts[0]!.unresolvedOperation!;
			const spy = serviceSpy();
			register(vaultHolding(accounts), spy.overrides);
			const operation = handlers.get(CHANNELS.enrollActivate);
			const resolver = handlers.get(CHANNELS.accountResolveOperation);
			if (!operation || !resolver) throw new Error('operation handlers were not registered');

			const displayed = (await operation(EVENT, {
				steamId64: STEAM_ID,
				code: '12345'
			})) as { state: string; staleToken?: string };
			expect(displayed.state).toBe('unidentifiedOperation');
			expect(displayed.staleToken).toBeUndefined();

			await expect(
				resolver(EVENT, {
					steamId64: STEAM_ID,
					kind: 'activate',
					operationToken: '0'.repeat(64),
					steamActed: true
				})
			).rejects.toThrow(/does not identify|cannot verify/i);
			await expect(
				resolver(EVENT, {
					steamId64: STEAM_ID,
					kind: 'activate',
					discardStale: true,
					staleToken: '0'.repeat(64)
				})
			).rejects.toThrow(/does not identify|cannot verify/i);

			expect(spy.activated).toEqual([]);
			expect(spy.detached).toEqual([]);
			expect(accounts[0]?.unresolvedOperation).toBe(record);
		}
	);

	it.each(['activate', 'deactivate'] as const)(
		'uses an applicable %s journal note before an unidentified legacy vault record',
		async (kind) => {
			const accounts = latched(kind, { fingerprint: undefined });
			let steamCalls = 0;
			const spy = serviceSpy();
			const journal = register(vaultHolding(accounts), {
				...spy.overrides,
				activate: () => {
					steamCalls += 1;
					return Promise.resolve('activated' as const);
				},
				deactivate: () => {
					steamCalls += 1;
					return Promise.resolve();
				}
			});
			journal.record({
				steamId64: STEAM_ID,
				kind,
				fingerprint: fingerprint(accounts[0]!.sharedSecret),
				at: '2026-01-02T00:00:00.000Z'
			});
			const operation = handlers.get(
				kind === 'activate' ? CHANNELS.enrollActivate : CHANNELS.accountDeactivate
			);
			if (!operation) throw new Error(`${kind} was not registered`);
			const displayed = (await operation(
				EVENT,
				kind === 'activate' ? { steamId64: STEAM_ID, code: '12345' } : REMOVE
			)) as { state: string; kind: string; operationToken: string };

			expect(displayed).toMatchObject({ state: 'uncertain', kind });
			expect(steamCalls).toBe(0);

			const resolver = handlers.get(CHANNELS.accountResolveOperation);
			if (!resolver) throw new Error('accountResolveOperation was not registered');
			expect(
				await resolver(EVENT, {
					steamId64: STEAM_ID,
					kind,
					operationToken: displayed.operationToken,
					steamActed: false
				})
			).toEqual({ ok: true });
			expect(journal.readKind(STEAM_ID, kind)).toBeUndefined();
			expect(accounts[0]?.unresolvedOperation).toBeDefined();
		}
	);

	/**
	 * **A no-op that reported success.** Where the record could not be written,
	 * the handler found nothing, changed nothing and answered ok - and the screen
	 * closed as though the account had been reconciled.
	 */
	it('refuses when there is no record to resolve', async () => {
		const { run } = resolve([account()], { kind: 'activate', steamActed: true });

		await expect(run).rejects.toThrow(/nothing recorded/i);
	});

	/**
	 * **A deletion is asked for like one.** `accountDeactivate` demands the
	 * passphrase because being unlocked is not enough to destroy the only copy of
	 * a set of secrets. This path destroys the same thing and asked for nothing.
	 */
	it('refuses to remove an account without the passphrase', async () => {
		const accounts = latched('deactivate');
		const { run, spy } = resolve(accounts, { kind: 'deactivate', steamActed: true });

		await expect(run).rejects.toThrow(/passphrase/i);
		expect(spy.detached, 'secrets were deleted with no passphrase checked at all').toEqual([]);
	});

	it('removes it once the passphrase is given', async () => {
		const accounts = latched('deactivate');
		const { run, spy } = resolve(accounts, {
			kind: 'deactivate',
			steamActed: true,
			passphrase: 'a passphrase long enough'
		});

		expect(await run).toEqual({ ok: true });
		expect(spy.detached).toEqual([{ steamId64: STEAM_ID, passphrase: 'a passphrase long enough' }]);
	});

	/*
	 * And the activation side delegates rather than restating the rules, which is
	 * where the revocation ceremony and the recovery file were lost.
	 */
	it('hands an activation to the service that owns what activated means', async () => {
		const accounts = latched('activate');
		const { run, spy } = resolve(accounts, { kind: 'activate', steamActed: true });

		expect(await run).toEqual({ ok: true });
		expect(spy.activated).toEqual([STEAM_ID]);
	});

	it('returns the recovery warning from an activation reconciliation', async () => {
		const accounts = latched('activate');
		register(vaultHolding(accounts), {
			reconcileActivatedWithRecoveryStatus: () =>
				Promise.resolve({
					applied: true,
					recoveryWarning: 'The encrypted recovery backup could not be updated.'
				})
		});
		const handler = handlers.get(CHANNELS.accountResolveOperation);
		if (!handler) throw new Error('accountResolveOperation was not registered');
		const record = accounts[0]!.unresolvedOperation!;

		await expect(
			handler(EVENT, {
				steamId64: STEAM_ID,
				kind: 'activate',
				operationToken: operationRecordToken('vault', { steamId64: STEAM_ID, ...record }),
				steamActed: true
			})
		).resolves.toEqual({
			ok: true,
			recoveryWarning: 'The encrypted recovery backup could not be updated.'
		});
	});
});

describe('an operation attempted while one is still unresolved', () => {
	function withLatch(kind: 'activate' | 'deactivate'): {
		accounts: Account[];
		calls: { activate: number; deactivate: number };
	} {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind,
			guidance: GUIDANCE,
			// The handler refuses a record it cannot tie to the authenticator now in
			// the vault, so the fixture has to carry the same digest it computes.
			fingerprint: createHash('sha256')
				.update(accounts[0]!.sharedSecret)
				.digest('hex')
				.slice(0, 16),
			at: '2026-01-01T00:00:00.000Z'
		};
		const calls = { activate: 0, deactivate: 0 };
		register(vaultHolding(accounts), {
			activate: () => {
				calls.activate += 1;
				return Promise.resolve('activated' as const);
			},
			deactivate: () => {
				calls.deactivate += 1;
				return Promise.resolve();
			}
		});
		return { accounts, calls };
	}

	it('is refused rather than sent to Steam', async () => {
		const { calls } = withLatch('activate');
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		const result = (await handler(EVENT, { steamId64: STEAM_ID, code: '12345' })) as {
			state: string;
			guidance?: string;
		};

		expect(
			calls.activate,
			'the handler sent an irreversible request for an account whose last one was never ' +
				'resolved, because the only thing refusing was the screen'
		).toBe(0);
		expect(result.state).toBe('uncertain');
		expect(result.guidance, 'and the reason was not repeated back').toBe(GUIDANCE);
	});

	it('refuses a removal the same way', async () => {
		const { calls } = withLatch('deactivate');
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { state?: string };

		expect(calls.deactivate, 'the most destructive operation here was sent anyway').toBe(0);
		expect(result.state).toBe('uncertain');
	});

	/*
	 * What is unknown is the account's state on Steam, not one verb's outcome:
	 * "should I detach this?" is not answerable while "did the activation land?"
	 * is still open.
	 */
	it('refuses the other operation too', async () => {
		const { calls } = withLatch('activate');
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		await handler(EVENT, REMOVE);

		expect(calls.deactivate).toBe(0);
	});

	/* And once the user has said they checked, the account works normally again. */
	it('lets the operation through once it has been resolved', async () => {
		const { calls, accounts } = withLatch('activate');
		const resolve = handlers.get(CHANNELS.accountResolveOperation);
		const activate = handlers.get(CHANNELS.enrollActivate);
		if (!resolve || !activate) throw new Error('handlers were not registered');
		const record = accounts[0]!.unresolvedOperation!;

		await resolve(EVENT, {
			steamId64: STEAM_ID,
			kind: 'activate',
			operationToken: operationRecordToken('vault', { steamId64: STEAM_ID, ...record }),
			steamActed: false
		});
		const result = (await activate(EVENT, { steamId64: STEAM_ID, code: '12345' })) as {
			state: string;
		};

		expect(calls.activate, 'the account was left permanently unusable').toBe(1);
		expect(result.state).toBe('activated');
	});

	/* And an account with nothing outstanding is untouched by any of this. */
	it('does not refuse an account with no unresolved operation', async () => {
		const accounts = [account()];
		const calls = { activate: 0 };
		register(vaultHolding(accounts), {
			activate: () => {
				calls.activate += 1;
				return Promise.resolve('activated' as const);
			}
		});
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		await handler(EVENT, { steamId64: STEAM_ID, code: '12345' });

		expect(calls.activate).toBe(1);
	});
});

/**
 * **A promise about a record that does not exist.**
 *
 * The latch write can fail — a full disk, a vault that locked while Steam was
 * being waited on, a row that is no longer there — and it was caught, logged
 * and swallowed. The handler then returned the same terminal outcome as ever,
 * and the screen went on saying "this application will not send the request
 * again": a promise about a record nothing wrote. Close the window and the
 * account looks ordinary, with the same button offering the same irreversible
 * call.
 *
 * The outcome carries whether it was actually written down, so the sentence can
 * be true either way.
 */
describe('an outcome whose vault latch could not be written', () => {
	/** A vault that reads fine and refuses every write. */
	function unwritable(accounts: Account[]): VaultService {
		return {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts }),
			mutate: () => Promise.reject(new Error('ENOSPC: no space left on device')),
			settings: () => ({ requireProxies: false })
		} as unknown as VaultService;
	}

	it('reports the pre-send journal that still makes the refusal durable', async () => {
		const journal = register(unwritable([account()]), {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { state?: string; persisted?: boolean };

		expect(result.state, 'the guidance has to reach the user either way').toBe('uncertain');
		expect(result.persisted).toBe(true);
		expect(journal.readKind(STEAM_ID, 'deactivate')).toBeDefined();
	});

	/**
	 * **And a write that fails after the callback has run.**
	 *
	 * `mutate` applies the change to a clone and installs it only once the vault
	 * write returns, so a failure after the callback discards the draft entirely.
	 * A flag set inside that callback is therefore a statement about the draft,
	 * not about the disk — and it claimed the refusal had been saved when the
	 * write had just failed, which is the same false promise one level down.
	 */
	it('falls back to the pre-send journal when the vault write fails after the change', async () => {
		const stored = [account()];
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: stored }),
			settings: () => ({ requireProxies: false }),
			mutate: (apply: (draft: { accounts: Account[] }) => void) => {
				// The row is found and the draft is changed, and then the write fails —
				// so nothing reaches disk and the draft is thrown away.
				apply({ accounts: structuredClone(stored) });
				return Promise.reject(new Error('ENOSPC: no space left on device'));
			}
		} as unknown as VaultService;

		const journal = register(vault, {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(result.persisted).toBe(true);
		expect(journal.readKind(STEAM_ID, 'deactivate')).toBeDefined();
	});

	it('protects an activation through the pre-send journal too', async () => {
		const journal = register(unwritable([account()]), {
			activate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		const result = (await handler(EVENT, { steamId64: STEAM_ID, code: '12345' })) as {
			persisted?: boolean;
		};

		expect(result.persisted).toBe(true);
		expect(journal.readKind(STEAM_ID, 'activate')).toBeDefined();
	});

	/*
	 * A vault write that succeeds but finds no row is the same outcome as one
	 * that throws: nothing was recorded, and the promise is just as empty.
	 */
	it('refuses before Steam when the account row is not there', async () => {
		let sent = 0;
		const journal = register(vaultHolding([]), {
			deactivate: () => {
				sent += 1;
				return Promise.reject(new EnrollmentError(GUIDANCE, true, true));
			}
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		await expect(handler(EVENT, REMOVE)).rejects.toThrow(/not in this vault/i);
		expect(sent).toBe(0);
		expect(journal.readKind(STEAM_ID, 'deactivate')).toBeUndefined();
	});

	/* And it does say so when it really was written. */
	it('says it was saved when it was', async () => {
		const accounts = [account()];
		register(vaultHolding(accounts), {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(result.persisted).toBe(true);
		expect(accounts[0]?.unresolvedOperation).toBeDefined();
	});

	/* A refusal read back out of the vault is durable by construction. */
	it('says so for a refusal that came from the vault', async () => {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind: 'deactivate',
			guidance: GUIDANCE,
			fingerprint: createHash('sha256')
				.update(accounts[0]!.sharedSecret)
				.digest('hex')
				.slice(0, 16),
			at: '2026-01-01T00:00:00.000Z'
		};
		register(vaultHolding(accounts), {});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(result.persisted).toBe(true);
	});

	/**
	 * **And a record about a replaced authenticator does not block the new one.**
	 *
	 * `heldBack` refuses every activation and removal while a record exists. Read
	 * without checking which authenticator it concerns, a leftover record made
	 * the replacement unusable — the exact account-bricking the fingerprint was
	 * added to prevent, arriving through the guard itself.
	 */
	it('makes an old record explicitly clearable before allowing the replacement operation', async () => {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind: 'deactivate',
			guidance: GUIDANCE,
			fingerprint: authenticatorFingerprint({ sharedSecret: 'a different authenticator' }),
			at: '2026-01-01T00:00:00.000Z'
		};
		let sent = 0;
		register(vaultHolding(accounts), {
			deactivate: () => {
				sent += 1;
				return Promise.resolve();
			}
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const displayed = (await handler(EVENT, REMOVE)) as {
			state: string;
			kind: 'activate' | 'deactivate';
			staleToken: string;
		};
		expect(displayed.state).toBe('staleOperation');
		expect(sent).toBe(0);
		const resolve = handlers.get(CHANNELS.accountResolveOperation);
		if (!resolve) throw new Error('accountResolveOperation was not registered');
		await resolve(EVENT, {
			steamId64: STEAM_ID,
			kind: displayed.kind,
			discardStale: true,
			staleToken: displayed.staleToken
		});
		await handler(EVENT, REMOVE);

		expect(
			sent,
			'an explicitly cleared record about an older authenticator still blocked its replacement'
		).toBe(1);
	});
});
