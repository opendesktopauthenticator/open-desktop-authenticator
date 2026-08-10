import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnrollmentService } from '../src/main/steam/enrollment';
import type { LoginSessionLike } from '../src/main/steam/login';
import type { StartedEnrollment } from '../src/main/steam/enroll';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { Account } from '../src/shared/vault-schema';

/**
 * Enrolling a brand-new account (§12 F3).
 *
 * Two properties matter more than the happy path, and both were wrong first
 * time:
 *
 *  - **The secrets reach the vault before anything else happens.** Steam has
 *    already changed the account by then, so a crash after the write is
 *    recoverable and a crash before it is not.
 *  - **The account is routed from its very first request.** Enrolling unrouted
 *    and adding a proxy afterwards lets Steam link the user's real address to
 *    the proxy through the account, permanently.
 */

const STEAM_ID = '76561198000000001';
const NOW = Date.parse('2026-08-10T00:00:00Z');
const SHARED = 'ASNFZ4mrze8BI0VniavN7wEjRWc=';
const IDENTITY = '/ty6mHZUMhD+3LqYdlQyEP7cupg=';

function jwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ typ: 'JWT' })}.${encode(claims)}.sig`;
}

const MOBILE = jwt({ aud: ['web', 'mobile'], exp: Math.floor(NOW / 1000) + 86_400 });

const STARTED: StartedEnrollment = {
	sharedSecret: SHARED,
	identitySecret: IDENTITY,
	revocationCode: 'R12345',
	deviceId: 'android:abc',
	accountName: 'trader'
};

function fakeVault(): { vault: { read: () => { accounts: Account[] } }; accounts: Account[] } {
	const accounts: Account[] = [];
	return {
		accounts,
		vault: {
			read: () => ({ accounts }),
			mutate: async (apply: (draft: { accounts: Account[] }) => void) => {
				apply({ accounts });
				return Promise.resolve();
			}
		} as never
	};
}

/** Authenticates immediately, with no Guard challenge. */
function fakeSession(): LoginSessionLike {
	const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
	return {
		startWithCredentials: () => {
			queueMicrotask(() => listeners.authenticated?.forEach((fn) => fn()));
			return Promise.resolve({ actionRequired: false });
		},
		submitSteamGuardCode: () => Promise.resolve(),
		on: (event: string, listener: (arg?: unknown) => void) => {
			(listeners[event] ??= []).push(listener);
		},
		cancelLoginAttempt: () => undefined,
		refreshToken: MOBILE,
		accessToken: MOBILE,
		steamID: { getSteamID64: () => STEAM_ID }
	};
}

function harness(): {
	service: EnrollmentService;
	accounts: Account[];
	/** Proxy the LoginSession was built with. */
	loginProxy: () => string | undefined;
	/** Accounts the transport factory was asked for. */
	transportCalls: { steamId64: string; proxyUrl?: string | undefined }[];
} {
	const { vault, accounts } = fakeVault();
	let loginProxy: string | undefined;
	const transportCalls: { steamId64: string; proxyUrl?: string | undefined }[] = [];

	const transports = {
		forAccount: (account: { steamId64: string; proxyUrl?: string | undefined }) => {
			transportCalls.push(account);
			return Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }));
		}
	} as unknown as SteamTransportFactory;

	const service = new EnrollmentService(vault as never, transports, {
		now: () => NOW,
		loginSession: (proxyUrl) => {
			loginProxy = proxyUrl;
			return fakeSession();
		},
		startEnrollment: () => Promise.resolve(STARTED),
		finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
	});

	return { service, accounts, loginProxy: () => loginProxy, transportCalls };
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('enrolling', () => {
	it('writes the secrets to the vault before reporting success', async () => {
		const { service, accounts } = harness();

		const outcome = await service.begin('trader', 'a-password');

		expect(outcome.state).toBe('enrolled');
		// Not "will be saved" — saved, by the time the caller hears about it.
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.sharedSecret).toBe(SHARED);
		expect(accounts[0]?.revocationCode).toBe('R12345');
	});

	it('marks the account pendingActivation until Steam confirms', async () => {
		const { service, accounts } = harness();

		await service.begin('trader', 'a-password');

		expect(accounts[0]?.status).toBe('pendingActivation');
	});

	it('refuses an account already in the vault', async () => {
		const { service } = harness();
		await service.begin('trader', 'a-password');

		await expect(service.begin('trader', 'a-password')).rejects.toThrow(/already in the vault/);
	});
});

/**
 * Regression: enrollment ran unrouted, and routing was left for afterwards.
 *
 * Steam sees the address every request comes from. An account enrolled from the
 * user's own address and then routed through a proxy is linked to both, through
 * the account, and nothing configured later undoes the first request. The
 * founder spotted that the flow never even asked.
 */
describe('routing an enrollment', () => {
	const PROXY = 'socks5://user:pass@10.0.0.1:1080';

	it('signs in through the proxy, not around it', async () => {
		const { service, loginProxy } = harness();

		await service.begin('trader', 'a-password', PROXY);

		expect(loginProxy()).toBe(PROXY);
	});

	it('routes the AddAuthenticator call itself', async () => {
		const { service, transportCalls } = harness();

		await service.begin('trader', 'a-password', PROXY);

		expect(transportCalls[0]).toEqual({ steamId64: STEAM_ID, proxyUrl: PROXY });
	});

	it('stores the proxy on the account, so later requests keep the same exit', async () => {
		const { service, accounts } = harness();

		await service.begin('trader', 'a-password', PROXY);

		expect(accounts[0]?.proxyUrl).toBe(PROXY);
	});

	it('refuses an unusable proxy before the password goes anywhere', async () => {
		// The check has to happen while nothing has happened yet. Discovering it
		// after Steam attached an authenticator would mean the enrollment already
		// leaked the address the proxy existed to hide.
		const { service, loginProxy, accounts } = harness();

		await expect(service.begin('trader', 'a-password', 'ftp://nope:21')).rejects.toThrow();
		expect(loginProxy()).toBeUndefined();
		expect(accounts).toHaveLength(0);
	});

	it('leaves an unrouted enrollment unrouted', async () => {
		// Routing stays optional. An account with no proxy must not acquire one.
		const { service, accounts, loginProxy, transportCalls } = harness();

		await service.begin('trader', 'a-password');

		expect(loginProxy()).toBeUndefined();
		expect(transportCalls[0]?.proxyUrl).toBeUndefined();
		expect(accounts[0]?.proxyUrl).toBeUndefined();
	});

	it('treats an empty string as no proxy rather than as a broken one', async () => {
		const { service, accounts } = harness();

		await service.begin('trader', 'a-password', '   ');

		expect(accounts[0]?.proxyUrl).toBeUndefined();
	});
});

/**
 * Regression: activation could not be resumed.
 *
 * The access token was held only in memory, so a restart or a vault lock left
 * the account `pendingActivation` forever — with the authenticator already
 * attached on Steam's side. Recovering meant Steam Support for something the
 * app should simply be able to finish. The refresh token was already being
 * stored during enrollment; it just was not being used.
 */
describe('resuming an activation', () => {
	it('mints a fresh access token when the in-memory one is gone', async () => {
		const { vault, accounts } = fakeVault();
		accounts.push({
			steamId64: STEAM_ID,
			accountName: 'trader',
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			revocationCode: 'R12345',
			refreshToken: MOBILE,
			status: 'pendingActivation',
			addedAt: '2026-08-01T00:00:00.000Z',
			autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
		});

		const minted = jwt({ aud: ['mobile'], exp: Math.floor(NOW / 1000) + 3600 });
		const transports = {
			forAccount: () =>
				Promise.resolve(() =>
					Promise.resolve({
						status: 200,
						text: JSON.stringify({ response: { access_token: minted } })
					})
				)
		} as unknown as SteamTransportFactory;

		// A brand-new service: nothing cached, exactly as after a restart.
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		expect(await service.activate(STEAM_ID, '55555')).toBe('activated');
		expect(accounts[0]?.status).not.toBe('pendingActivation');
	});

	it('says what to do when there is no session to resume from', async () => {
		const { vault, accounts } = fakeVault();
		accounts.push({
			steamId64: STEAM_ID,
			accountName: 'trader',
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			revocationCode: 'R12345',
			status: 'pendingActivation',
			addedAt: '2026-08-01T00:00:00.000Z',
			autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
		});

		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, { now: () => NOW });

		// The authenticator exists on Steam either way, so the advice has to be
		// about the revocation code rather than "try again".
		await expect(service.activate(STEAM_ID, '55555')).rejects.toThrow(/revocation code/);
	});
});

/**
 * Detaching an authenticator from Steam (F-09, Q15).
 *
 * The most destructive operation in the application: it removes Steam Guard from
 * a real account, leaving it with no second factor until the owner adds one
 * elsewhere. F-09 named the consequence of getting the gating wrong — an
 * attacker holding an unlocked vault stripping 2FA from every account in one
 * pass — so most of what is tested here is refusal.
 */
describe('deactivating an authenticator', () => {
	function detachHarness(
		overrides: Partial<Account> = {},
		detach: (...args: never[]) => Promise<void> = () => Promise.resolve()
	): {
		service: EnrollmentService;
		accounts: Account[];
		verified: string[];
		detachCalls: unknown[];
	} {
		const accounts: Account[] = [
			{
				steamId64: STEAM_ID,
				accountName: 'trader',
				sharedSecret: SHARED,
				identitySecret: IDENTITY,
				revocationCode: 'R12345',
				refreshToken: MOBILE,
				status: 'active',
				addedAt: '2026-08-01T00:00:00.000Z',
				autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
				...overrides
			}
		];
		const verified: string[] = [];
		const detachCalls: unknown[] = [];

		const vault = {
			read: () => ({ accounts }),
			verifyPassphrase: (passphrase: string) => {
				verified.push(passphrase);
				if (passphrase !== 'correct') {
					return Promise.reject(new Error('that passphrase is not correct'));
				}
				return Promise.resolve();
			},
			mutate: async (apply: (draft: { accounts: Account[] }) => void) => {
				apply({ accounts });
				return Promise.resolve();
			}
		} as never;

		// Answers the token mint, which deactivation needs before it can talk to
		// Steam at all — the same path activation uses after a restart.
		const transports = {
			forAccount: () =>
				Promise.resolve(() =>
					Promise.resolve({
						status: 200,
						text: JSON.stringify({ response: { access_token: MOBILE } })
					})
				)
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(vault, transports, {
			now: () => NOW,
			removeAuthenticator: ((_t: never, options: unknown) => {
				detachCalls.push(options);
				return detach();
			}) as never
		});

		return { service, accounts, verified, detachCalls };
	}

	it('detaches from Steam, then forgets the account', async () => {
		const { service, accounts, detachCalls } = detachHarness();

		await service.deactivate(STEAM_ID, 'correct');

		expect(detachCalls).toHaveLength(1);
		expect(detachCalls[0]).toMatchObject({ steamId64: STEAM_ID, revocationCode: 'R12345' });
		expect(accounts).toHaveLength(0);
	});

	it('requires the passphrase, verified against the file', async () => {
		// Being unlocked means the machine was used recently, not that its owner is
		// at it. F-09's whole mitigation rests on this.
		const { service, accounts, detachCalls } = detachHarness();

		await expect(service.deactivate(STEAM_ID, 'wrong')).rejects.toThrow();
		expect(detachCalls).toHaveLength(0);
		expect(accounts).toHaveLength(1);
	});

	it('refuses an account with no revocation code, before touching Steam', async () => {
		// §12 F2 permits importing without one. Steam will not detach without it,
		// so the user is told why rather than watching Steam refuse.
		const { service, accounts, detachCalls } = detachHarness();
		delete accounts[0]?.revocationCode;

		await expect(service.deactivate(STEAM_ID, 'correct')).rejects.toThrow(/revocation code/);
		expect(detachCalls).toHaveLength(0);
		expect(accounts).toHaveLength(1);
	});

	it('keeps the account when Steam refuses', async () => {
		// Steam first, vault second. Removing locally on a failed detach would leave
		// an authenticator attached that nobody holds the secrets for — the same
		// unrecoverable state enrollment works hard to avoid, reached backwards.
		const { service, accounts } = detachHarness({}, () =>
			Promise.reject(new Error('Steam did not accept that revocation code'))
		);

		await expect(service.deactivate(STEAM_ID, 'correct')).rejects.toThrow(/revocation code/);
		expect(accounts).toHaveLength(1);
	});

	it('refuses an account that is not in the vault', async () => {
		const { service } = detachHarness();

		await expect(service.deactivate('76561198000000009', 'correct')).rejects.toThrow(
			/not in this vault/
		);
	});
});
