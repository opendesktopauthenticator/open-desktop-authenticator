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

/**
 * The unrecoverable window (§12 F3).
 *
 * Steam attaches the authenticator and issues secrets it will never reissue,
 * then this machine has to store them. Everything between those two points is
 * the only place in the application where a failure costs something no one can
 * put back: the account keeps an authenticator whose shared secret and
 * revocation code exist nowhere, and only Steam Support can undo it.
 */
describe('when the vault write fails after Steam has already attached', () => {
	/** A vault whose `mutate` always fails, as it would if it locked mid-write. */
	function brokenVault(): { read: () => { accounts: Account[] } } {
		return {
			read: () => ({ accounts: [] }),
			mutate: () =>
				Promise.reject(
					new Error("ENOSPC: no space left on device, open 'C:/Users/someone/AppData/vault.json'")
				)
		} as never;
	}

	function serviceWith(options: { recovery?: (account: Account) => void }): EnrollmentService {
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		return new EnrollmentService(brokenVault() as never, transports, {
			now: () => NOW,
			loginSession: () => fakeSession(),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const }),
			...(options.recovery ? { writeRecovery: options.recovery } : {})
		});
	}

	it('has already written the recovery file before the vault is touched', async () => {
		// The ordering is the entire fix. Written afterwards, a failed mutate left
		// the secrets nowhere; written first, they are on disk before anything can
		// go wrong, in a file the user can import back.
		const written: Account[] = [];
		const service = serviceWith({ recovery: (account) => written.push(account) });

		await expect(service.begin('trader', 'password')).rejects.toThrow();

		expect(written).toHaveLength(1);
		expect(written[0]?.sharedSecret).toBe(SHARED);
		expect(written[0]?.revocationCode).toBe('R12345');
	});

	it('says the authenticator is attached and points at the recovery file', async () => {
		// A generic failure would send the user round again against an account that
		// now has an authenticator they cannot use.
		const service = serviceWith({ recovery: () => undefined });

		await expect(service.begin('trader', 'password')).rejects.toThrow(
			/attached the authenticator.*recovery file was written/s
		);
	});

	it('never forwards the underlying error, which carries the vault path', async () => {
		// Node embeds the absolute path in every filesystem failure, so forwarding
		// it would put the user's home directory into the renderer — the same leak
		// the import path already had to fix once.
		const service = serviceWith({ recovery: () => undefined });

		const message = await service.begin('trader', 'password').catch((err: Error) => err.message);

		expect(message).not.toContain('AppData');
		expect(message).not.toContain('ENOSPC');
	});

	it('gives the revocation code when the recovery file failed too', async () => {
		// The one branch where it is the last copy in existence. The ceremony would
		// have put it on screen a moment later anyway, and the activity log is in
		// memory, so nothing of it reaches disk.
		const service = serviceWith({
			recovery: () => {
				throw new Error('disk is gone');
			}
		});

		const message = await service.begin('trader', 'password').catch((err: Error) => err.message);

		expect(message).toContain('R12345');
		expect(message).toMatch(/write this down now/i);
	});

	it('does not put the revocation code in the message when recovery succeeded', async () => {
		// It is not needed there, and a code shown in an error banner is a code in
		// one more place than it has to be.
		const service = serviceWith({ recovery: () => undefined });

		const message = await service.begin('trader', 'password').catch((err: Error) => err.message);

		expect(message).not.toContain('R12345');
	});
});

/**
 * Getting out of a sign-in that is going nowhere (§12 F3).
 *
 * The email-code step is the one genuine pause in the application, and it holds
 * a live `LoginSession` open across it. Both ways out of that pause were missing:
 * the screen offered no control, and nothing dropped the session when it was
 * abandoned.
 */
describe('abandoning a sign-in', () => {
	it('cancels the live session behind an abandoned email-code step', async () => {
		// The state the screen leaves behind when someone mistypes an account name
		// and walks away: Steam has emailed a code, a LoginSession is open, and
		// nothing has been attached. `forget` is what the new Cancel button reaches,
		// and it has to actually stop that session rather than drop the reference.
		let cancelled = 0;
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(fakeVault().vault as never, transports, {
			now: () => NOW,
			loginSession: () => ({
				// Pauses for an emailed code, which is what makes this step a pause.
				startWithCredentials: () =>
					Promise.resolve({ actionRequired: true, validActions: [{ type: 2 }] }),
				submitSteamGuardCode: () => Promise.resolve(),
				on: () => undefined,
				cancelLoginAttempt: () => {
					cancelled += 1;
				},
				refreshToken: MOBILE,
				accessToken: MOBILE,
				steamID: { getSteamID64: () => STEAM_ID }
			}),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		const outcome = await service.begin('trader', 'password');
		expect(outcome.state).toBe('needsEmailCode');

		service.forget();

		expect(cancelled).toBe(1);
		// And the code that was emailed is no longer accepted, because the session
		// it belonged to is gone.
		await expect(service.submitEmailCode('12345')).rejects.toThrow();
	});

	it('gives up on a sign-in Steam never finishes', async () => {
		// The library's `timeout` event is not guaranteed to fire. `login.ts`
		// backstops it with a timer of its own for every other sign-in; enrollment
		// did not, so a hung sign-in left the screen on "Talking to Steam…" with its
		// Cancel button disabled — no timeout, no error, nothing to press.
		vi.useFakeTimers();
		try {
			const transports = {
				forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
			} as unknown as SteamTransportFactory;

			const service = new EnrollmentService(fakeVault().vault as never, transports, {
				now: () => NOW,
				// Never authenticates, and never emits `timeout` either.
				loginSession: () => ({
					startWithCredentials: () => Promise.resolve({ actionRequired: false }),
					submitSteamGuardCode: () => Promise.resolve(),
					on: () => undefined,
					cancelLoginAttempt: () => undefined,
					refreshToken: MOBILE,
					accessToken: MOBILE,
					steamID: { getSteamID64: () => STEAM_ID }
				}),
				startEnrollment: () => Promise.resolve(STARTED),
				finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
			});

			const attempt = service.begin('trader', 'password');
			const settled = attempt.then(
				() => 'resolved',
				(err: Error) => err.message
			);

			await vi.advanceTimersByTimeAsync(91_000);

			await expect(settled).resolves.toMatch(/did not finish the sign-in in time/);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('activating twice', () => {
	it('refuses an account that is already activated', async () => {
		// `finalizeEnrollment` changes state on Steam's side. A stale screen or a
		// double submission could push an already-active account back through it,
		// for no possible benefit.
		const { service, accounts } = harness();
		await service.begin('trader', 'password');
		const account = accounts[0];
		if (!account) throw new Error('the enrollment did not store an account');
		account.status = 'active';

		await expect(service.activate(STEAM_ID, '12345')).rejects.toThrow(/already activated/);
	});

	it('refuses a second activation while the first is in flight', async () => {
		// Two `finalizeEnrollment` calls racing on one account send Steam two codes
		// for the same window, and the loser's failure is indistinguishable from a
		// wrong code.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const { vault, accounts } = fakeVault();

		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => fakeSession(),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: async () => {
				await gate;
				return { state: 'activated' as const };
			}
		});

		await service.begin('trader', 'password');
		expect(accounts[0]?.status).toBe('pendingActivation');

		const first = service.activate(STEAM_ID, '12345');
		await expect(service.activate(STEAM_ID, '67890')).rejects.toThrow(/already being activated/);

		release?.();
		await first;
	});
});

describe('one sign-in at a time', () => {
	it('refuses a second begin while the first is still running', async () => {
		// The class documents "one at a time, deliberately", and `discardPending`
		// could not deliver it: `pendingLogin` is not assigned until after
		// `startWithCredentials` has been awaited, so two overlapping calls both
		// found nothing pending, both opened a LoginSession, and both could reach
		// `enrol`.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		let opened = 0;
		const service = new EnrollmentService(fakeVault().vault as never, transports, {
			now: () => NOW,
			loginSession: () => {
				opened += 1;
				const base = fakeSession();
				return {
					...base,
					startWithCredentials: async () => {
						await gate;
						return base.startWithCredentials({ accountName: '', password: '' });
					}
				};
			},
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		const first = service.begin('trader', 'password');
		await expect(service.begin('trader', 'password')).rejects.toThrow(/already in progress/);

		release?.();
		await first;

		// Exactly one session was ever opened, which is the property that matters:
		// the second call must not have left one running with nobody holding it.
		expect(opened).toBe(1);
	});

	it('cancels a session that is still live when the vault locks', async () => {
		// `pendingLogin` covers only the pause waiting for an emailed code. On the
		// password-only path it is never set at all, so from `begin` through `enrol`
		// there was no reference a lock could reach.
		let cancelled = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transports = {
			forAccount: async () => {
				await gate;
				return () => Promise.resolve({ status: 200, text: '{}' });
			}
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(fakeVault().vault as never, transports, {
			now: () => NOW,
			loginSession: () => ({
				...fakeSession(),
				cancelLoginAttempt: () => {
					cancelled += 1;
				}
			}),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		// Parked inside `enrol`, past the point where `pendingLogin` exists.
		const enrolling = service.begin('trader', 'password');
		await new Promise((resolve) => setTimeout(resolve, 0));

		service.forget();
		expect(cancelled).toBe(1);

		release?.();
		await enrolling.catch(() => undefined);
	});
});
