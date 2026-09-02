import { beforeEach, describe, expect, it, vi } from 'vitest';
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
		settings: () => ({ requireProxies: false })
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
describe('resolving an unresolved operation', () => {
	it('clears the record', async () => {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind: 'deactivate',
			guidance: GUIDANCE,
			at: '2026-01-01T00:00:00.000Z'
		};
		register(vaultHolding(accounts), {});
		const handler = handlers.get(CHANNELS.accountResolveOperation);
		if (!handler) throw new Error('accountResolveOperation was not registered');

		expect(await handler(EVENT, { steamId64: STEAM_ID, steamActed: false })).toEqual({ ok: true });
		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});

	it('leaves other accounts alone', async () => {
		const other = account();
		other.steamId64 = '76561198000000002';
		other.unresolvedOperation = {
			kind: 'activate',
			guidance: GUIDANCE,
			at: '2026-01-01T00:00:00.000Z'
		};
		const accounts = [account(), other];
		register(vaultHolding(accounts), {});
		const handler = handlers.get(CHANNELS.accountResolveOperation);
		if (!handler) throw new Error('accountResolveOperation was not registered');

		await handler(EVENT, { steamId64: STEAM_ID, steamActed: false });

		expect(
			accounts[1]?.unresolvedOperation,
			'clearing one account cleared another account/s record'
		).toBeDefined();
	});
});

/**
 * **A refusal the renderer honours is a convention; one the handler honours is
 * a rule.**
 *
 * Writing the unresolved operation to the vault made it outlive the screen, and
 * both screens read it and stop offering the action. That is not the same as
 * the request being refused: the handler went on accepting it from anything
 * that asked, and a stale account list is enough to get past a renderer-side
 * check — as is a renderer compromised by the Steam content it renders, which
 * is the threat the process boundary exists for.
 *
 * This file already argues the point about the removal acknowledgement, in its
 * own words: a phrase enforced only in the renderer is a convention.
 */
describe('an operation attempted while one is still unresolved', () => {
	function withLatch(kind: 'activate' | 'deactivate'): {
		accounts: Account[];
		calls: { activate: number; deactivate: number };
	} {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind,
			guidance: GUIDANCE,
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

		await resolve(EVENT, { steamId64: STEAM_ID, steamActed: false });
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
			at: '2026-01-01T00:00:00.000Z'
		};
		register(vaultHolding(accounts), {});
		const handler = handlers.get(CHANNELS.accountDeactivate);
		if (!handler) throw new Error('accountDeactivate was not registered');

		const result = (await handler(EVENT, REMOVE)) as { persisted?: boolean };

		expect(result.persisted).toBe(true);
	});
});

/**
 * **"I have checked" is not an outcome, and it was being treated as one.**
 *
 * Clearing the record on its own left the account exactly as the interrupted
 * operation had left it, which puts the same offer straight back on the screen:
 * an activation Steam completed still reads `pendingActivation`, so "Finish
 * activation" returns and fails in a way that looks like a wrong code; a removal
 * Steam performed leaves the account listed and still generating codes for an
 * authenticator that is no longer attached to anything.
 *
 * Three outcomes, needing opposite things, behind one generic button. The
 * resolution carries what the user found now.
 */
describe('reconciling an account against what the user found', () => {
	function withLatch(kind: 'activate' | 'deactivate', accounts = [account()]): Account[] {
		accounts[0]!.unresolvedOperation = {
			kind,
			guidance: GUIDANCE,
			at: '2026-01-01T00:00:00.000Z'
		};
		return accounts;
	}

	const resolve = async (accounts: Account[], steamActed: boolean): Promise<void> => {
		register(vaultHolding(accounts), {});
		const handler = handlers.get(CHANNELS.accountResolveOperation);
		if (!handler) throw new Error('accountResolveOperation was not registered');
		await handler(EVENT, { steamId64: STEAM_ID, steamActed });
	};

	it('marks an activation Steam completed as active', async () => {
		const accounts = withLatch('activate');
		await resolve(accounts, true);

		expect(
			accounts[0]?.status,
			'the account still read pendingActivation, so the screen offered to finish an activation ' +
				'Steam had already finished — which fails in a way that looks like a wrong code'
		).toBe('active');
		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});

	it('removes an account whose authenticator Steam detached', async () => {
		const accounts = withLatch('deactivate');
		await resolve(accounts, true);

		expect(
			accounts.length,
			'the account stayed in the vault, listed and still generating codes for an authenticator ' +
				'that is no longer attached to anything'
		).toBe(0);
	});

	it('leaves the account alone when Steam did nothing', async () => {
		const accounts = withLatch('deactivate');
		await resolve(accounts, false);

		expect(accounts.length, 'an account Steam never touched was deleted').toBe(1);
		expect(accounts[0]?.status, 'and its state was changed for no reason').toBe(
			'pendingActivation'
		);
		expect(accounts[0]?.unresolvedOperation, 'but the refusal is lifted, so a retry can run').toBe(
			undefined
		);
	});

	it('does not mark an account active because a removal was resolved', async () => {
		const accounts = withLatch('deactivate');
		await resolve(accounts, false);

		expect(accounts[0]?.status).toBe('pendingActivation');
	});

	/* And the other accounts are untouched by any of it. */
	it('touches only the account it was asked about', async () => {
		const other = account();
		other.steamId64 = '76561198000000002';
		const accounts = withLatch('deactivate', [account(), other]);
		await resolve(accounts, true);

		expect(accounts.map((entry) => entry.steamId64)).toEqual(['76561198000000002']);
	});
});
