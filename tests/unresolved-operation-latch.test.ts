import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CHANNELS } from '../src/shared/channels';
import { EnrollmentError } from '../src/main/steam/enroll';

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

function register(vault: VaultService, overrides: Partial<EnrollmentService>): void {
	registerEnrollmentHandlers(overrides as EnrollmentService, vault, {
		show: () => Promise.resolve(undefined)
	});
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
					return Promise.resolve();
				},
				reconcileDetached: (steamId64: string, passphrase: string) => {
					detached.push({ steamId64, passphrase });
					return Promise.resolve();
				}
			} as Partial<EnrollmentService>
		};
	}

	function resolve(accounts: Account[], request: Record<string, unknown>) {
		const spy = serviceSpy();
		register(vaultHolding(accounts), spy.overrides);
		const handler = handlers.get(CHANNELS.accountResolveOperation);
		if (!handler) throw new Error('accountResolveOperation was not registered');
		return { spy, run: handler(EVENT, { steamId64: STEAM_ID, ...request }) };
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
		const { run, spy } = resolve(accounts, { kind: 'activate', steamActed: true });

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
	 * A record written before fingerprints existed cannot be matched, so it is
	 * refused rather than assumed to be about whatever is there now.
	 */
	/* Written before fingerprints existed: it cannot be matched, so it is cleared
	 * rather than left blocking the account for ever. */
	it('clears a record with no fingerprint at all', async () => {
		const accounts = latched('activate', { fingerprint: undefined });
		const { run, spy } = resolve(accounts, { kind: 'activate', steamActed: true });

		expect(await run).toEqual({ ok: true });
		expect(spy.activated).toEqual([]);
		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});

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
		const { calls } = withLatch('activate');
		const resolve = handlers.get(CHANNELS.accountResolveOperation);
		const activate = handlers.get(CHANNELS.enrollActivate);
		if (!resolve || !activate) throw new Error('handlers were not registered');

		await resolve(EVENT, { steamId64: STEAM_ID, kind: 'activate', steamActed: false });
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
describe('an outcome whose latch could not be written', () => {
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

	it('does not claim to have been saved', async () => {
		register(unwritable([account()]), {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { state?: string; persisted?: boolean };

		expect(result.state, 'the guidance has to reach the user either way').toBe('uncertain');
		expect(
			result.persisted,
			'the write failed and the outcome still said the refusal would outlive the window, so ' +
				'the screen promised something nothing had recorded'
		).toBe(false);
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
	it('does not claim to have been saved when the write fails after the change', async () => {
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

		register(vault, {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(
			result.persisted,
			'the flag was set inside the callback, so a write that failed straight afterwards still ' +
				'reported the refusal as saved'
		).toBe(false);
	});

	it('says so for an activation too', async () => {
		register(unwritable([account()]), {
			activate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.enrollActivate);
		if (!handler) throw new Error('enrollActivate was not registered');

		const result = (await handler(EVENT, { steamId64: STEAM_ID, code: '12345' })) as {
			persisted?: boolean;
		};

		expect(result.persisted).toBe(false);
	});

	/*
	 * A vault write that succeeds but finds no row is the same outcome as one
	 * that throws: nothing was recorded, and the promise is just as empty.
	 */
	it('does not claim to have been saved when the account is not there', async () => {
		register(vaultHolding([]), {
			deactivate: () => Promise.reject(new EnrollmentError(GUIDANCE, true, true))
		});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(
			result.persisted,
			'the mutate succeeded and wrote nothing, which reads as success unless the write itself ' +
				'reports what it did'
		).toBe(false);
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
	it('does not block an authenticator the record was never about', async () => {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind: 'deactivate',
			guidance: GUIDANCE,
			fingerprint: 'a fingerprint from a different authenticator',
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

		await handler(EVENT, REMOVE);

		expect(
			sent,
			'a record about an authenticator that is gone refused an operation on the one that ' +
				'replaced it, and nothing in the application could clear it'
		).toBe(1);
	});
});
