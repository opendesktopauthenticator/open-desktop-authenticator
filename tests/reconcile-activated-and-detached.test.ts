import { describe, expect, it } from 'vitest';
import { authenticatorFingerprint, EnrollmentService } from '../src/main/steam/enrollment';
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

		await service.reconcileActivated(ID, authenticatorFingerprint(account()));

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

		await service.reconcileActivated(ID, authenticatorFingerprint(account()));

		expect(accounts[0]?.status).toBe('active');
	});

	it('clears the record it was resolving', async () => {
		const accounts = [account()];
		accounts[0]!.unresolvedOperation = {
			kind: 'activate',
			guidance: 'check the account',
			at: '2026-01-01T00:00:00.000Z'
		};
		const { vault } = vaultHolding(accounts);

		await new EnrollmentService(vault, transports, {}).reconcileActivated(
			ID,
			authenticatorFingerprint(account())
		);

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

		await service.reconcileActivated(ID, authenticatorFingerprint(account()));

		expect(
			updated.map((entry) => entry.status),
			'the vault moved on and the recovery file was left describing an account that never ' +
				'finished enrolling'
		).toEqual(['pendingRevocationBackup']);
	});

	/* A missing account is not an error worth failing a reconciliation over. */
	it('does nothing for an account that is not there', async () => {
		const { vault } = vaultHolding([]);

		await expect(
			new EnrollmentService(vault, transports, {}).reconcileActivated(
				ID,
				authenticatorFingerprint(account())
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
			service.reconcileDetached(ID, 'the wrong passphrase', authenticatorFingerprint(account()))
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
			authenticatorFingerprint(account())
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
			authenticatorFingerprint(account())
		);

		expect(accounts.map((entry) => entry.steamId64)).toEqual(['76561198000000002']);
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
			expected
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
			expected
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
				authenticatorFingerprint(accounts[0]!)
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
			expected
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

		await new EnrollmentService(vault, transports, {}).reconcileActivated(ID, expected);

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
describe('an activation and a removal for the same authenticator', () => {
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
