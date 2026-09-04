import { describe, expect, it } from 'vitest';
import {
	authenticatorFingerprint,
	EnrollmentService,
	type OperationResolutionGuard
} from '../src/main/steam/enrollment';
import { operationRecordToken } from '../src/main/steam/authenticator-secrets';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

/**
 * **Reconciliation has to obey the rules the ordinary paths obey.**
 *
 * When the user comes back and says what Steam actually did, the vault is
 * brought into line with their answer. The first version of that was written
 * inside the IPC handler and restated the rules instead of calling the code
 * that owns them, so it got two of them wrong and skipped a third entirely:
 *
 *   - It set `active` outright. A real activation sets
 *     `pendingRevocationBackup` unless the revocation code has already been
 *     shown — the ceremony that stops somebody ending up with a live
 *     authenticator and no way to detach it.
 *   - It left the recovery file saying `pendingActivation`, which is what that
 *     file says until Steam confirms. The account is live and its emergency
 *     copy describes an account that never finished enrolling.
 *   - It deleted accounts with no passphrase at all, while the ordinary removal
 *     refuses to work without one, precisely so an unattended unlocked machine
 *     cannot destroy the only copy of a set of secrets.
 *
 * These drive the real service.
 */

const ID = '76561198000000001';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const JOURNAL_GUARD = { source: 'journal' } as const satisfies OperationResolutionGuard;

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: ID,
		accountName: 'trader',
		sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
		identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
		revocationCode: 'R12345',
		status: 'pendingActivation',
		addedAt: '2026-01-01T00:00:00.000Z',
		...overrides
	} as unknown as Account;
}

const transports = {} as unknown as SteamTransportFactory;

function vaultGuard(stored: Account): OperationResolutionGuard {
	const record = stored.unresolvedOperation;
	if (record === undefined) throw new Error('the test account has no unresolved operation');
	return {
		source: 'vault',
		operationToken: operationRecordToken('vault', { steamId64: stored.steamId64, ...record })
	};
}

/** A vault that keeps what a mutate wrote and records passphrase checks. */
function vaultHolding(accounts: Account[], options: { refuse?: boolean } = {}) {
	const checked: string[] = [];
	const vault = {
		read: () => ({ accounts }),
		verifyPassphrase: (passphrase: string) => {
			checked.push(passphrase);
			return options.refuse === true
				? Promise.reject(new Error('the passphrase is not correct'))
				: Promise.resolve(undefined);
		},
		mutate: (apply: (draft: { accounts: Account[] }) => void) => {
			apply({ accounts });
			return Promise.resolve();
		}
	} as unknown as VaultService;
	return { vault, checked };
}

describe('an activation the user confirmed on Steam', () => {
	it('does not skip the revocation-code ceremony', async () => {
		const accounts = [account()];
		const { vault } = vaultHolding(accounts);
		const service = new EnrollmentService(vault, transports, {});

		await service.reconcileActivated(ID, authenticatorFingerprint(account()), JOURNAL_GUARD);

		expect(
			accounts[0]?.status,
			'the account was marked active without its revocation code ever being shown, which is ' +
				'the one step that stops somebody holding a live authenticator they cannot detach'
		).toBe('pendingRevocationBackup');
	});

	/* And where the ceremony is already done, it really is finished. */
	it('is active when the revocation code has already been backed up', async () => {
		const accounts = [account({ revocationBackedUpAt: '2026-01-01T00:00:00.000Z' })];
		const { vault } = vaultHolding(accounts);
		const service = new EnrollmentService(vault, transports, {});

		await service.reconcileActivated(ID, authenticatorFingerprint(account()), JOURNAL_GUARD);

		expect(accounts[0]?.status).toBe('active');
	});

	it('clears the record it was resolving', async () => {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind: 'activate',
			guidance: 'check the account',
			fingerprint: authenticatorFingerprint(accounts[0]!),
			operationId: OPERATION_ID,
			at: '2026-01-01T00:00:00.000Z'
		};
		const { vault } = vaultHolding(accounts);

		await new EnrollmentService(vault, transports, {}).reconcileActivated(
			ID,
			authenticatorFingerprint(account()),
			vaultGuard(accounts[0]!)
		);

		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});

	it('does not consume a vault record on behalf of an unrelated journal answer', async () => {
		const accounts = [account()];
		const fingerprint = authenticatorFingerprint(accounts[0]!);
		accounts[0]!.unresolvedOperation = {
			kind: 'activate',
			guidance: 'check the account',
			fingerprint,
			operationId: OPERATION_ID,
			at: '2026-01-01T00:00:00.000Z'
		};
		const record = accounts[0]!.unresolvedOperation;
		const { vault } = vaultHolding(accounts);

		const applied = await new EnrollmentService(vault, transports, {}).reconcileActivated(
			ID,
			fingerprint,
			JOURNAL_GUARD
		);

		expect(applied).toBe(false);
		expect(accounts[0]?.status).toBe('pendingActivation');
		expect(accounts[0]?.unresolvedOperation).toBe(record);
	});

	it('can reconcile a current journal answer while preserving identified stale vault evidence', async () => {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind: 'activate',
			guidance: 'older authenticator',
			fingerprint: '0123456789abcdef',
			operationId: OPERATION_ID,
			at: '2026-01-01T00:00:00.000Z'
		};
		const record = accounts[0]!.unresolvedOperation;
		const { vault } = vaultHolding(accounts);

		const applied = await new EnrollmentService(vault, transports, {}).reconcileActivated(
			ID,
			authenticatorFingerprint(accounts[0]!),
			JOURNAL_GUARD
		);

		expect(applied).toBe(true);
		expect(accounts[0]?.status).toBe('pendingRevocationBackup');
		expect(accounts[0]?.unresolvedOperation).toBe(record);
	});

	it("consumes a vault latch only when it is the journal record's exact companion", async () => {
		const accounts = [account()];
		const fingerprint = authenticatorFingerprint(accounts[0]!);
		const at = '2026-01-01T00:00:00.000Z';
		accounts[0]!.unresolvedOperation = {
			kind: 'activate',
			guidance: 'check the account',
			fingerprint,
			operationId: OPERATION_ID,
			at
		};
		const { vault } = vaultHolding(accounts);

		const applied = await new EnrollmentService(vault, transports, {}).reconcileActivated(
			ID,
			fingerprint,
			{
				source: 'journal',
				companion: { operationId: OPERATION_ID, kind: 'activate', fingerprint, at }
			}
		);

		expect(applied).toBe(true);
		expect(accounts[0]?.unresolvedOperation).toBeUndefined();
	});

	/**
	 * The recovery file says `pendingActivation` because that was true when it
	 * was written. An account that is live with an emergency copy describing one
	 * that never finished enrolling is exactly the state the update exists for.
	 */
	it('brings the recovery file with it', async () => {
		const accounts = [account()];
		const { vault } = vaultHolding(accounts);
		const updated: Account[] = [];
		const service = new EnrollmentService(vault, transports, {
			updateRecovery: (stored: Account) => {
				updated.push(stored);
			}
		});

		await service.reconcileActivated(ID, authenticatorFingerprint(account()), JOURNAL_GUARD);

		expect(
			updated.map((entry) => entry.status),
			'the vault moved on and the recovery file was left describing an account that never ' +
				'finished enrolling'
		).toEqual(['pendingRevocationBackup']);
	});

	it('reports that reconciliation succeeded when only its recovery correction failed', async () => {
		const accounts = [account()];
		const { vault } = vaultHolding(accounts);
		const service = new EnrollmentService(vault, transports, {
			updateRecovery: () => {
				throw new Error('disk unavailable');
			}
		});

		await expect(
			service.reconcileActivatedWithRecoveryStatus(
				ID,
				authenticatorFingerprint(account()),
				JOURNAL_GUARD
			)
		).resolves.toEqual({
			applied: true,
			recoveryWarning: expect.stringMatching(/recovery backup.*could not be updated/i)
		});
		expect(accounts[0]?.status).toBe('pendingRevocationBackup');
	});

	/* A missing account is not an error worth failing a reconciliation over. */
	it('does nothing for an account that is not there', async () => {
		const { vault } = vaultHolding([]);

		await expect(
			new EnrollmentService(vault, transports, {}).reconcileActivated(
				ID,
				authenticatorFingerprint(account()),
				JOURNAL_GUARD
			)
		).resolves.not.toThrow();
	});
});

describe('a removal the user confirmed on Steam', () => {
	it('will not delete anything without checking the passphrase', async () => {
		const accounts = [account({ status: 'active' })];
		const { vault, checked } = vaultHolding(accounts, { refuse: true });
		const service = new EnrollmentService(vault, transports, {});

		await expect(
			service.reconcileDetached(
				ID,
				'the wrong passphrase',
				authenticatorFingerprint(account()),
				JOURNAL_GUARD
			)
		).rejects.toThrow();

		expect(checked, 'the passphrase was never checked at all').toEqual(['the wrong passphrase']);
		expect(
			accounts.length,
			'the account was deleted despite the passphrase being refused — and this path destroys ' +
				'the only copy of its secrets'
		).toBe(1);
	});

	it('removes it once the passphrase is accepted', async () => {
		const accounts = [account({ status: 'active' })];
		const { vault, checked } = vaultHolding(accounts);

		await new EnrollmentService(vault, transports, {}).reconcileDetached(
			ID,
			'a passphrase long enough',
			authenticatorFingerprint(account()),
			JOURNAL_GUARD
		);

		expect(checked).toEqual(['a passphrase long enough']);
		expect(accounts.length).toBe(0);
	});

	it('leaves other accounts alone', async () => {
		const other = account({ steamId64: '76561198000000002' });
		const accounts = [account({ status: 'active' }), other];
		const { vault } = vaultHolding(accounts);

		await new EnrollmentService(vault, transports, {}).reconcileDetached(
			ID,
			'a passphrase long enough',
			authenticatorFingerprint(account()),
			JOURNAL_GUARD
		);

		expect(accounts.map((entry) => entry.steamId64)).toEqual(['76561198000000002']);
	});

	it('can remove the current authenticator from a journal answer despite identified stale vault evidence', async () => {
		const accounts = [account({ status: 'active' })];
		accounts[0]!.unresolvedOperation = {
			kind: 'activate',
			guidance: 'older authenticator',
			fingerprint: '0123456789abcdef',
			operationId: OPERATION_ID,
			at: '2026-01-01T00:00:00.000Z'
		};
		const { vault } = vaultHolding(accounts);

		const applied = await new EnrollmentService(vault, transports, {}).reconcileDetached(
			ID,
			'a passphrase long enough',
			authenticatorFingerprint(accounts[0]!),
			JOURNAL_GUARD
		);

		expect(applied).toBe(true);
		expect(accounts).toEqual([]);
	});

	it('does not delete an account when the displayed vault record token no longer matches', async () => {
		const accounts = [account({ status: 'active' })];
		const fingerprint = authenticatorFingerprint(accounts[0]!);
		accounts[0]!.unresolvedOperation = {
			kind: 'deactivate',
			guidance: 'check whether Steam Guard is still on',
			fingerprint,
			operationId: OPERATION_ID,
			at: '2026-01-01T00:00:00.000Z'
		};
		const record = accounts[0]!.unresolvedOperation;
		const { vault } = vaultHolding(accounts);

		const applied = await new EnrollmentService(vault, transports, {}).reconcileDetached(
			ID,
			'a passphrase long enough',
			fingerprint,
			{ source: 'vault', operationToken: '0'.repeat(64) }
		);

		expect(applied).toBe(false);
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.unresolvedOperation).toBe(record);
	});
});

/**
 * **Identity at the moment of the write, not at the moment of the check.**
 *
 * The IPC handler checks the fingerprint before calling in, and then there are
 * awaits — a passphrase derivation for the removal, the mutate itself — before
 * anything is written. A row replaced inside that window is a different
 * authenticator wearing the same SteamID, and matching on the SteamID alone
 * would act on it.
 *
 * `deactivateOnce` has always matched on identity inside its own mutate for
 * exactly this reason. These reconciliations did not, which put the
 * replaced-authenticator defect back through a door one step further along
 * from the one that was closed.
 */
describe('a row replaced while the reconciliation was in flight', () => {
	/** A vault whose row is swapped for a different authenticator mid-call. */
	function swappingVault(accounts: Account[]) {
		return {
			read: () => ({ accounts }),
			verifyPassphrase: () => {
				// The long await in the middle. By the time it resolves, the account
				// has been replaced — an import, or a fresh enrolment.
				accounts[0] = account({ sharedSecret: 'YSBkaWZmZXJlbnQgc2VjcmV0', status: 'active' });
				return Promise.resolve(undefined);
			},
			mutate: (apply: (draft: { accounts: Account[] }) => void) => {
				apply({ accounts });
				return Promise.resolve();
			}
		} as unknown as VaultService;
	}

	/**
	 * **And it says it did nothing, rather than reporting success.**
	 *
	 * The identity re-check makes the write conditional. A method that returns the
	 * same way either side of it tells the caller a reconciliation happened when
	 * the row had moved on — the record stays, the account stays blocked, the
	 * session is torn down for a removal that did not occur, and the screen closes
	 * as though it were sorted. That is the same silent-success defect this whole
	 * mechanism keeps producing, one level further down.
	 */
	it('reports that it changed nothing', async () => {
		const accounts = [account({ status: 'active' })];
		const expected = authenticatorFingerprint(accounts[0]!);
		const vault = swappingVault(accounts);

		const applied = await new EnrollmentService(vault, transports, {}).reconcileDetached(
			ID,
			'a passphrase long enough',
			expected,
			JOURNAL_GUARD
		);

		expect(applied, 'a removal that deleted nothing was reported as done').toBe(false);
	});

	it('reports the same for an activation that matched nothing', async () => {
		const accounts = [account()];
		const expected = authenticatorFingerprint(accounts[0]!);
		accounts[0] = account({ sharedSecret: 'YSBkaWZmZXJlbnQgc2VjcmV0' });
		const { vault } = vaultHolding(accounts);

		const applied = await new EnrollmentService(vault, transports, {}).reconcileActivated(
			ID,
			expected,
			JOURNAL_GUARD
		);

		expect(applied).toBe(false);
	});

	/* And a reconciliation that really did apply says so. */
	it('reports success when it did apply', async () => {
		const accounts = [account()];
		const { vault } = vaultHolding(accounts);

		expect(
			await new EnrollmentService(vault, transports, {}).reconcileActivated(
				ID,
				authenticatorFingerprint(accounts[0]!),
				JOURNAL_GUARD
			)
		).toBe(true);
	});

	it('does not delete the authenticator that replaced the one it was about', async () => {
		const accounts = [account({ status: 'active' })];
		const expected = authenticatorFingerprint(accounts[0]!);
		const vault = swappingVault(accounts);

		await new EnrollmentService(vault, transports, {}).reconcileDetached(
			ID,
			'a passphrase long enough',
			expected,
			JOURNAL_GUARD
		);

		expect(
			accounts.length,
			'the row was replaced between the check and the delete, and the delete matched on the ' +
				'SteamID alone — so it destroyed the authenticator that had taken its place'
		).toBe(1);
		expect(accounts[0]?.sharedSecret).toBe('YSBkaWZmZXJlbnQgc2VjcmV0');
	});

	it('does not mark a replacement active either', async () => {
		const accounts = [account()];
		const expected = authenticatorFingerprint(accounts[0]!);
		accounts[0] = account({ sharedSecret: 'YSBkaWZmZXJlbnQgc2VjcmV0' });
		const { vault } = vaultHolding(accounts);

		await new EnrollmentService(vault, transports, {}).reconcileActivated(
			ID,
			expected,
			JOURNAL_GUARD
		);

		expect(
			accounts[0]?.status,
			'a record about one authenticator marked a different one active, because the write ' +
				'matched on the SteamID rather than on which authenticator it was about'
		).toBe('pendingActivation');
	});
});

/**
 * **One authenticator, one irreversible operation at a time.**
 *
 * Activation and removal had a mutex each. Each refused a second of its own
 * kind and neither could see the other — and they concern the same
 * authenticator. Both could reach Steam at once, and when both came back
 * uncertain the second record overwrote the first, losing the durable warning
 * about the operation that started earlier.
 *
 * Reachable without contrivance: a notification click navigates away from the
 * activation screen while it is still waiting on Steam, and Remove is available
 * from the account list the moment it lands.
 */
/**
 * A token the service will accept, and a transport that hands one back.
 *
 * The file-level `transports` is an empty object, which is fine for the
 * reconciliations above — they never reach Steam. These do.
 */
const jwt = (claims: Record<string, unknown>): string => {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ typ: 'JWT' })}.${encode(claims)}.sig`;
};
const TOKEN = jwt({ aud: ['web', 'mobile'], exp: Math.floor(Date.now() / 1000) + 86_400 });
const live = {
	forAccount: () =>
		Promise.resolve(() =>
			Promise.resolve({
				status: 200,
				text: JSON.stringify({ response: { access_token: TOKEN } })
			})
		)
} as unknown as SteamTransportFactory;

/**
 * A service whose activation hangs inside Steam until released.
 *
 * `atSteam` resolves when `finalizeEnrollment` is actually entered, which is
 * several awaits after `activate` is called — the token mint happens first.
 * Releasing before that point leaves the activation hanging for ever, which
 * is how the first version of these timed out rather than asserting.
 */
function hanging() {
	// `activate` refuses anything but pendingActivation before it reaches the
	// mutex, so an active account would never engage the guard under test.
	const accounts = [account({ status: 'pendingActivation', refreshToken: TOKEN })];
	let releaseFinalize: (() => void) | undefined;
	let arrived: () => void = () => undefined;
	const atSteam = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const service = new EnrollmentService(vaultHolding(accounts).vault, live, {
		finalizeEnrollment: () =>
			new Promise((resolve) => {
				releaseFinalize = () => resolve({ state: 'activated' as const });
				arrived();
			}),
		removeAuthenticator: () => Promise.resolve()
	});
	return { service, accounts, atSteam, release: () => releaseFinalize?.() };
}

describe('an activation and a removal for the same authenticator', () => {
	it('cannot both be in flight at once', async () => {
		const { service, release, atSteam } = hanging();

		// The activation reaches Steam and hangs there.
		const activating = service.activate(ID, '12345');
		await atSteam;

		await expect(
			service.deactivate(ID, 'a passphrase long enough'),
			'the removal reached Steam while the activation was still waiting on it, and the record ' +
				'the second one wrote overwrote the first'
		).rejects.toThrow(/being activated/i);

		release();
		await activating.catch(() => undefined);
	});

	/* And the refusal says which operation is holding it. */
	it('says what is already running', async () => {
		const { service, release, atSteam } = hanging();
		const activating = service.activate(ID, '12345');
		await atSteam;

		const err = await service.deactivate(ID, 'a passphrase long enough').catch((e: unknown) => e);

		expect((err as Error).message).toMatch(/wait for that to finish/i);
		release();
		await activating.catch(() => undefined);
	});

	/* And once it settles, the other operation is allowed. */
	it('lets the other one run once the first has finished', async () => {
		const { service, release, atSteam } = hanging();
		const activating = service.activate(ID, '12345');
		await atSteam;
		release();
		await activating.catch(() => undefined);

		await expect(service.deactivate(ID, 'a passphrase long enough')).resolves.not.toThrow();
	});
});

/**
 * **A lock does not stop the request, so it must not release the claim.**
 *
 * The shared mutex was cleared wholesale on lock, on the reasoning that nobody
 * is waiting after a lock and a stale marker would refuse the next retry. But
 * the promise is still running and Steam is still going to answer — so
 * unlocking admitted a second irreversible operation against the same
 * authenticator, and when the first settled its unconditional delete removed
 * the *second's* marker and admitted a third.
 *
 * Reproduced exactly that way: activation A in flight, lock and unlock admits
 * removal B, A settles and admits removal C while B is still running.
 */
describe('the claim on an authenticator across a lock', () => {
	it('survives a lock while the request is still in the air', async () => {
		const { service, release, atSteam } = hanging();
		const activating = service.activate(ID, '12345');
		await atSteam;

		// The vault locks and is unlocked again. The Steam request is untouched by
		// either: it is still running.
		service.forget();

		await expect(
			service.deactivate(ID, 'a passphrase long enough'),
			'the lock released a claim on an operation Steam had not answered yet, so a second ' +
				'irreversible request went out beside the first'
		).rejects.toThrow(/being activated/i);

		release();
		await activating.catch(() => undefined);
	});

	/**
	 * And an operation is allowed again once the first has really settled.
	 *
	 * **The token comparison itself is not covered, and cannot be.** It is the
	 * second half of the reported defect: a settled attempt deleting whatever
	 * marker is there, which after the lock cleared the map was somebody else's.
	 * With the lock no longer clearing, two simultaneous claims cannot be
	 * produced through any public path — the guard and the set are synchronous
	 * with no await between them — so nothing can drive `releaseInFlight` into
	 * the case it exists for. Removing the comparison leaves every test green.
	 *
	 * It stays as defence: the state is unreachable today because of one line in
	 * `forget`, and that is a thin thing to rest an irreversible operation on.
	 */
	it('does not release a claim that belongs to another attempt', async () => {
		const { service, release, atSteam } = hanging();
		const activating = service.activate(ID, '12345');
		await atSteam;
		service.forget();

		// B is refused, as above. Now A settles.
		await service.deactivate(ID, 'a passphrase long enough').catch(() => undefined);
		release();
		await activating.catch(() => undefined);

		// With the claim correctly released by A, an operation may start again —
		// what must not happen is A releasing a claim it does not own while a
		// different operation holds it.
		await expect(service.deactivate(ID, 'a passphrase long enough')).resolves.not.toThrow();
	});
});
