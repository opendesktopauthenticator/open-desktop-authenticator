import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnrollmentService } from '../src/main/steam/enrollment';
import type { LoginSessionLike } from '../src/main/steam/login';
import type { StartedEnrollment } from '../src/main/steam/enroll';
import type { SteamTransportFactory } from '../src/main/net/transport';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

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
			isUnlocked: () => true,
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
	const PROXY = 'http://user:pass@10.0.0.1:1080';

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
			autoConfirm: newAutoConfirm()
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
			autoConfirm: newAutoConfirm()
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
				autoConfirm: newAutoConfirm(),
				...overrides
			}
		];
		const verified: string[] = [];
		const detachCalls: unknown[] = [];

		const vault = {
			isUnlocked: () => true,
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
			isUnlocked: () => true,
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

describe('the pause waiting for an emailed code', () => {
	/** A session that stops for an email code and records cancellation. */
	function pausing(): { session: LoginSessionLike; cancels: () => number } {
		let cancels = 0;
		const base = fakeSession();
		return {
			session: {
				...base,
				startWithCredentials: () =>
					Promise.resolve({ actionRequired: true, validActions: [{ type: 2 }] }),
				cancelLoginAttempt: () => {
					cancels += 1;
				}
			},
			cancels: () => cancels
		};
	}

	it('survives longer than the sign-in timeout', async () => {
		// `PENDING_TTL_MS` says this pause may last fifteen minutes. The sign-in
		// timeout armed in `begin` was never disarmed when the flow paused, so at
		// ninety seconds it cancelled the very session the user was about to submit
		// their code to — and the code then failed against a dead session.
		vi.useFakeTimers();
		try {
			const paused = pausing();
			const transports = {
				forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
			} as unknown as SteamTransportFactory;

			const service = new EnrollmentService(fakeVault().vault as never, transports, {
				now: () => NOW,
				loginSession: () => paused.session,
				startEnrollment: () => Promise.resolve(STARTED),
				finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
			});

			const outcome = await service.begin('trader', 'password');
			expect(outcome.state).toBe('needsEmailCode');

			// Well past ninety seconds, well inside the fifteen-minute TTL.
			await vi.advanceTimersByTimeAsync(5 * 60_000);

			expect(paused.cancels()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('the recovery file after activation', () => {
	it('stops saying the authenticator was never activated', async () => {
		// The file is written before activation — that is the window it exists to
		// survive — so it records `pendingActivation`. Nothing corrected it, so
		// restoring after an ordinary activate-then-remove produced an account the
		// app believed had never been activated: it offered to finish, and could
		// not, because the file carries no refresh token by design.
		const written: Account[] = [];
		const updated: Account[] = [];
		const { vault, accounts } = fakeVault();
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => fakeSession(),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const }),
			writeRecovery: (account) => written.push({ ...account }),
			updateRecovery: (account) => updated.push({ ...account })
		});

		await service.begin('trader', 'password');
		expect(written[0]?.status).toBe('pendingActivation');

		await service.activate(STEAM_ID, '12345');

		expect(updated).toHaveLength(1);
		// What the vault holds, not what enrollment had in hand.
		expect(updated[0]?.status).toBe(accounts[0]?.status);
		expect(updated[0]?.status).not.toBe('pendingActivation');
		// And the secrets are still there — a corrected file is still a backup.
		expect(updated[0]?.sharedSecret).toBe(SHARED);
		expect(updated[0]?.revocationCode).toBe('R12345');
	});

	it('does not fail an activation because the vault locked right after it was written', async () => {
		// `mutate` is awaited, so the vault can lock during it — and the read that
		// follows, to fetch the account for the recovery update, throws when locked.
		// Outside the guard that turned a fully successful activation into a
		// reported failure, sending the user back to a screen that would then tell
		// them the account is already activated.
		let locked = false;
		const accounts: Account[] = [];
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(
			{
				isUnlocked: () => !locked,
				read: () => {
					if (locked) {
						throw new Error('the vault is locked');
					}
					return { accounts };
				},
				mutate: (apply: (draft: { accounts: Account[] }) => void) => {
					apply({ accounts });
					return Promise.resolve();
				}
			} as never,
			transports,
			{
				now: () => NOW,
				loginSession: () => fakeSession(),
				startEnrollment: () => Promise.resolve(STARTED),
				finalizeEnrollment: () => {
					// The lock lands while the activation is in flight.
					locked = true;
					return Promise.resolve({ state: 'activated' as const });
				},
				writeRecovery: () => undefined,
				updateRecovery: () => undefined
			}
		);

		await service.begin('trader', 'password');
		locked = false;

		await expect(service.activate(STEAM_ID, '12345')).resolves.toBe('activated');
	});

	it('does not fail an activation Steam accepted just because the backup could not be rewritten', async () => {
		const { vault } = fakeVault();
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => fakeSession(),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const }),
			writeRecovery: () => undefined,
			updateRecovery: () => {
				throw new Error('disk is gone');
			}
		});

		await service.begin('trader', 'password');

		await expect(service.activate(STEAM_ID, '12345')).resolves.toBe('activated');
	});
});

describe('a lock landing while the transport is being built', () => {
	it('never asks Steam to attach an authenticator it could not store', async () => {
		// `forAccount` is awaited immediately before the one irreversible request in
		// the application, and the idle timer does not pause for it. Without a check
		// after that await, Steam attaches an authenticator whose secrets the vault
		// is then unable to write — recoverable only through Steam Support.
		let unlocked = true;
		let attachments = 0;

		const transports = {
			forAccount: () => {
				// The vault locks while the session is being constructed.
				unlocked = false;
				return Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }));
			}
		} as unknown as SteamTransportFactory;

		const accounts: Account[] = [];
		const service = new EnrollmentService(
			{
				isUnlocked: () => unlocked,
				read: () => ({ accounts }),
				mutate: async (apply: (draft: { accounts: Account[] }) => void) => {
					apply({ accounts });
					return Promise.resolve();
				}
			} as never,
			transports,
			{
				now: () => NOW,
				loginSession: () => fakeSession(),
				startEnrollment: () => {
					attachments += 1;
					return Promise.resolve(STARTED);
				},
				finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
			}
		);

		await expect(service.begin('trader', 'password')).rejects.toThrow(/vault locked before/);

		expect(attachments).toBe(0);
		expect(accounts).toHaveLength(0);
	});
});

describe('when Steam has acted and the vault write fails', () => {
	function brokenAfter(accounts: Account[]): { read: () => { accounts: Account[] } } {
		let writes = 0;
		return {
			isUnlocked: () => true,
			read: () => ({ accounts }),
			mutate: (apply: (draft: { accounts: Account[] }) => void) => {
				writes += 1;
				// The enrollment write succeeds; the one after it does not.
				if (writes > 1) {
					return Promise.reject(
						new Error("EACCES: permission denied, open 'C:/Users/someone/vault.json'")
					);
				}
				apply({ accounts });
				return Promise.resolve();
			}
		} as never;
	}

	it('says the authenticator is activated even though the vault disagrees', async () => {
		// Steam finalized. The vault still reads `pendingActivation`, so the app will
		// keep offering to finish something already finished — and finalizing an
		// activated authenticator fails in a way that looks like a wrong code.
		const accounts: Account[] = [];
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(brokenAfter(accounts) as never, transports, {
			now: () => NOW,
			loginSession: () => fakeSession(),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		await service.begin('trader', 'password');

		await expect(service.activate(STEAM_ID, '12345')).rejects.toThrow(
			/Steam activated the authenticator/
		);
	});

	it('never forwards the filesystem error, which carries the vault path', async () => {
		const accounts: Account[] = [];
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;

		const service = new EnrollmentService(brokenAfter(accounts) as never, transports, {
			now: () => NOW,
			loginSession: () => fakeSession(),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});
		await service.begin('trader', 'password');

		const message = await service.activate(STEAM_ID, '12345').catch((err: Error) => err.message);

		expect(message).not.toContain('vault.json');
		expect(message).not.toContain('EACCES');
	});
});

/*
 * Two overlapping email-code submissions.
 *
 * `submitEmailCode` had no in-progress guard: both calls captured the same
 * pending login, both awaited the same authentication, and both entered
 * `enrol` — whose vault duplicate check runs before its first await, so both
 * passed it and `AddAuthenticator` went to Steam twice for one account. The
 * second call must be refused at the door, before it can touch Steam.
 */
describe('a double-pressed email-code button', () => {
	it('sends AddAuthenticator exactly once', async () => {
		let starts = 0;
		let releaseAuth: (() => void) | undefined;
		const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
		const session: LoginSessionLike = {
			startWithCredentials: () =>
				Promise.resolve({
					actionRequired: true,
					validActions: [{ type: 2, detail: 'example.com' }]
				}),
			// Authenticates only when the test says so, holding both submissions in
			// the window the guard has to cover.
			submitSteamGuardCode: () => {
				queueMicrotask(() => {
					releaseAuth = () => listeners.authenticated?.forEach((fn) => fn());
				});
				return Promise.resolve();
			},
			on: (event: string, listener: (arg?: unknown) => void) => {
				(listeners[event] ??= []).push(listener);
			},
			cancelLoginAttempt: () => undefined,
			refreshToken: MOBILE,
			accessToken: MOBILE,
			steamID: { getSteamID64: () => STEAM_ID }
		};

		const { vault } = fakeVault();
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => session,
			startEnrollment: () => {
				starts += 1;
				return Promise.resolve(STARTED);
			},
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		await service.begin('trader', 'a-password');

		const first = service.submitEmailCode('12345');
		const second = service.submitEmailCode('12345').then(
			() => 'resolved',
			(err: Error) => err.message
		);

		// Give both a chance to reach the authentication wait, then let it finish.
		await new Promise((resolve) => setTimeout(resolve, 0));
		releaseAuth?.();

		await first;
		await expect(second).resolves.toMatch(/already being checked/i);
		expect(starts).toBe(1);
	});
});

/*
 * `begin` during an in-flight email-code submission.
 *
 * `beginOnce` starts by discarding the pending login, so a begin arriving while
 * a code submission was mid-air cancelled the very session that submission was
 * riding — then opened a second one, with both able to reach `enrol`. The
 * mirror of the guard `submitEmailCode` itself carries.
 */
describe('begin while an email code is being checked', () => {
	it('is refused instead of cancelling the submission underneath', async () => {
		let starts = 0;
		let releaseAuth: (() => void) | undefined;
		const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
		const session: LoginSessionLike = {
			startWithCredentials: () =>
				Promise.resolve({
					actionRequired: true,
					validActions: [{ type: 2, detail: 'example.com' }]
				}),
			submitSteamGuardCode: () => {
				queueMicrotask(() => {
					releaseAuth = () => listeners.authenticated?.forEach((fn) => fn());
				});
				return Promise.resolve();
			},
			on: (event: string, listener: (arg?: unknown) => void) => {
				(listeners[event] ??= []).push(listener);
			},
			cancelLoginAttempt: () => undefined,
			refreshToken: MOBILE,
			accessToken: MOBILE,
			steamID: { getSteamID64: () => STEAM_ID }
		};

		const { vault } = fakeVault();
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => session,
			startEnrollment: () => {
				starts += 1;
				return Promise.resolve(STARTED);
			},
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		await service.begin('trader', 'a-password');
		const submission = service.submitEmailCode('12345');

		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(service.begin('other', 'a-password')).rejects.toThrow(/already in progress/);

		releaseAuth?.();
		await submission;
		expect(starts).toBe(1);
	});
});

/*
 * A double-pressed removal.
 *
 * `deactivate` starts with a passphrase check that is deliberately slow, so a
 * second press landed a second `RemoveAuthenticator` — answered for an
 * authenticator already gone, surfacing an error for an operation that had in
 * fact succeeded.
 */
describe('deactivating twice at once', () => {
	it('refuses the second call while the first is in flight', async () => {
		const { vault, accounts } = fakeVault();
		accounts.push({
			steamId64: STEAM_ID,
			accountName: 'trader',
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			revocationCode: 'R12345',
			refreshToken: MOBILE,
			status: 'active',
			addedAt: '2026-08-08T00:00:00.000Z',
			autoConfirm: newAutoConfirm()
		});
		(vault as { verifyPassphrase?: unknown }).verifyPassphrase = () =>
			new Promise((resolve) => setTimeout(resolve, 10));

		let removals = 0;
		const transports = {
			forAccount: () =>
				Promise.resolve(() =>
					Promise.resolve({
						status: 200,
						text: JSON.stringify({ response: { access_token: MOBILE } })
					})
				)
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			removeAuthenticator: () => {
				removals += 1;
				return Promise.resolve();
			},
			// Minting is bypassed by the cached-token path being empty; supply the
			// pieces the flow needs without any network.
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		const first = service.deactivate(STEAM_ID, 'correct');
		await expect(service.deactivate(STEAM_ID, 'correct')).rejects.toThrow(/already being removed/);
		await first;
		expect(removals).toBe(1);
	});
});

/*
 * An insert landing during the AddAuthenticator round trip.
 *
 * The duplicate check runs before Steam is awaited — it has to, refusing is
 * only free before the irreversible call — so an import or recovery inserting
 * the same SteamID during that window met a persist that pushed
 * unconditionally: two rows for one identity, with every later `find` seeing
 * only the first. The fresh enrollment is the live authenticator on Steam's
 * side, so it replaces rather than duplicates.
 */
describe('an account inserted while Steam is enrolling it', () => {
	it('ends with exactly one row, holding the fresh secrets', async () => {
		const { vault, accounts } = fakeVault();
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => fakeSession(),
			startEnrollment: async () => {
				await startGate;
				return STARTED;
			},
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		const enrolling = service.begin('trader', 'a-password');
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The same identity arrives by another door mid-flight.
		accounts.push({
			steamId64: STEAM_ID,
			accountName: 'trader',
			sharedSecret: 'b2xkLXNlY3JldC1mcm9tLWltcG9ydA==',
			identitySecret: IDENTITY,
			status: 'active',
			addedAt: '2026-08-01T00:00:00.000Z',
			autoConfirm: newAutoConfirm()
		});
		releaseStart?.();
		await enrolling;

		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.sharedSecret).toBe(SHARED);
	});
});

/*
 * Activation success must mean durable local state.
 *
 * The status mutate quietly no-opped when the row was gone — removed while
 * `finalizeEnrollment` was in the air — and 'activated' was reported for an
 * account this vault no longer stores. Steam's side is live; the honest answer
 * names the recovery file.
 */
describe('activation with the row removed mid-flight', () => {
	it('refuses to call it activated', async () => {
		const { vault, accounts } = fakeVault();
		accounts.push({
			steamId64: STEAM_ID,
			accountName: 'trader',
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			refreshToken: MOBILE,
			status: 'pendingActivation',
			addedAt: '2026-08-01T00:00:00.000Z',
			autoConfirm: newAutoConfirm()
		});
		let releaseFinalize: (() => void) | undefined;
		const finalizeGate = new Promise<void>((resolve) => {
			releaseFinalize = resolve;
		});
		const transports = {
			forAccount: () =>
				Promise.resolve(() =>
					Promise.resolve({
						status: 200,
						text: JSON.stringify({ response: { access_token: MOBILE } })
					})
				)
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			finalizeEnrollment: async () => {
				await finalizeGate;
				return { state: 'activated' as const };
			}
		});

		const activating = service.activate(STEAM_ID, '12345');
		await new Promise((resolve) => setTimeout(resolve, 0));
		accounts.length = 0;
		releaseFinalize?.();

		await expect(activating).rejects.toThrow(/no longer holds the authenticator/);
	});
});

/*
 * A continuation may only touch the row it was actually about.
 *
 * Activation and detachment snapshot an account, ask Steam about *those*
 * secrets, and then found the row again by SteamID alone. An import-replace or
 * a transfer persist landing during that await puts a different authenticator
 * under the same identity — so activation marked somebody else's secrets
 * activated, and deactivation deleted them for a removal that was never about
 * them.
 */
describe('a row replaced while Steam is answering', () => {
	const SHARED_B = 'ICEiIyQlJicoKSorLC0uLzAxMjM=';

	function harnessFor(gate: Promise<void>, kind: 'activate' | 'deactivate') {
		const { vault, accounts } = fakeVault();
		accounts.push({
			steamId64: STEAM_ID,
			accountName: 'trader',
			sharedSecret: SHARED,
			identitySecret: IDENTITY,
			revocationCode: 'R12345',
			refreshToken: MOBILE,
			status: kind === 'activate' ? 'pendingActivation' : 'active',
			addedAt: '2026-08-01T00:00:00.000Z',
			autoConfirm: newAutoConfirm()
		});
		(vault as { verifyPassphrase?: unknown }).verifyPassphrase = () => Promise.resolve();
		const transports = {
			forAccount: () =>
				Promise.resolve(() =>
					Promise.resolve({
						status: 200,
						text: JSON.stringify({ response: { access_token: MOBILE } })
					})
				)
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			finalizeEnrollment: async () => {
				await gate;
				return { state: 'activated' as const };
			},
			removeAuthenticator: async () => {
				await gate;
			}
		});
		return { service, accounts };
	}

	/** The replacement an import or a transfer would write. */
	const replace = (accounts: Account[]) => {
		accounts[0] = {
			...(accounts[0] as Account),
			sharedSecret: SHARED_B,
			revocationCode: 'R99999'
		};
	};

	it('does not mark a replacement activated', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { service, accounts } = harnessFor(gate, 'activate');

		const activating = service.activate(STEAM_ID, '12345');
		await new Promise((resolve) => setTimeout(resolve, 0));
		replace(accounts);
		release?.();

		await expect(activating).rejects.toThrow(/no longer holds the authenticator/);
		// The replacement is untouched — still its own secrets, still unactivated.
		expect(accounts[0]?.sharedSecret).toBe(SHARED_B);
	});

	/**
	 * **Survival was only half of it, and the discarded promise hid the rest.**
	 *
	 * This test used to end `.catch(() => undefined)`, so it could see that the
	 * replacement lived and not that the caller was told the account had been
	 * removed. Steam had detached the old authenticator, the vault still listed
	 * the new one, and the screen closed as though both were done — leaving an
	 * account that is still shown, still generating codes, for an authenticator
	 * Steam no longer honours.
	 */
	it('does not delete a replacement it never detached', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { service, accounts } = harnessFor(gate, 'deactivate');

		const removing = service.deactivate(STEAM_ID, 'correct');
		// The rejection is the point; attach the handler before releasing so the
		// run does not see an unhandled one.
		const outcome = removing.then(
			() => undefined,
			(err: unknown) => err
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		replace(accounts);
		release?.();

		const err = await outcome;
		expect(
			err,
			'the caller was told an account had been removed while it was still listed'
		).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/different authenticator/i);

		// Steam detached the OLD authenticator. The replacement's secrets survive.
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.sharedSecret).toBe(SHARED_B);
	});

	/**
	 * **The branch the revocation-code guard could not see.**
	 *
	 * A replacement that carries no revocation code of its own inherits the
	 * previous one through the import merge. It therefore matched a guard keyed
	 * on `steamId64 + revocationCode` exactly, and its new shared and identity
	 * secrets — a working authenticator Steam still honours — were deleted for a
	 * removal that was never about it.
	 *
	 * The secrets are what the detach was about, so they are what the guard has
	 * to compare.
	 */
	it('does not delete a replacement that inherited the old revocation code', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { service, accounts } = harnessFor(gate, 'deactivate');
		const inheritedCode = accounts[0]?.revocationCode;

		const removing = service.deactivate(STEAM_ID, 'correct');
		const outcome = removing.then(
			() => undefined,
			(err: unknown) => err
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// A re-import with no code of its own: new secrets, the old code kept.
		accounts[0] = {
			...(accounts[0] as Account),
			sharedSecret: SHARED_B,
			identitySecret: SHARED_B,
			...(inheritedCode === undefined ? {} : { revocationCode: inheritedCode })
		};
		release?.();

		await outcome;

		expect(
			accounts,
			'a working authenticator was deleted by a detach it had no part in'
		).toHaveLength(1);
		expect(accounts[0]?.sharedSecret).toBe(SHARED_B);
	});

	/*
	 * And the ordinary case still works: nothing replaced it, so it goes.
	 */
	it('removes the account it actually detached', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { service, accounts } = harnessFor(gate, 'deactivate');

		const removing = service.deactivate(STEAM_ID, 'correct');
		release?.();
		await expect(removing).resolves.toBeUndefined();
		expect(accounts).toHaveLength(0);
	});
});

/**
 * **Cancelling an enrolment that `Require proxies` has just forbidden.**
 *
 * The IPC guard refuses a *new* proxyless enrolment. One already running was
 * untouched, so a password kept travelling unrouted after the user turned the
 * rule on — and enrolling is precisely when an account's address is first shown
 * to Steam.
 *
 * **`pendingLogin` was the wrong thing to read.** It is assigned only after
 * `startWithCredentials` has been awaited, which is exactly the window in which
 * the password is on the wire. A policy change landing there found nothing
 * pending and cancelled nothing. `liveSessions` is registered the moment the
 * session exists, for that same reason.
 */
describe('forgetting an unrouted enrolment', () => {
	function stalled(): {
		service: EnrollmentService;
		cancelled: () => number;
	} {
		const { vault } = fakeVault();
		let cancelled = 0;
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => ({
				...fakeSession(),
				// Never settles: the sign-in is still talking to Steam, which is the
				// only moment this method exists for.
				startWithCredentials: () => new Promise(() => undefined),
				cancelLoginAttempt: () => {
					cancelled += 1;
				}
			}),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});
		return { service, cancelled: () => cancelled };
	}

	it('cancels one that is still signing in, before any pendingLogin exists', async () => {
		const { service, cancelled } = stalled();
		void service.begin('trader', 'a-password');
		await Promise.resolve();
		await Promise.resolve();

		service.forgetUnrouted();

		expect(cancelled(), 'the password was still going out unrouted').toBe(1);
	});

	/*
	 * And leaves a proxied one alone. An enrolment through a proxy satisfies the
	 * new rule, and enrolling is an attended act with a code arriving on a phone
	 * — cancelling it because an unrelated switch moved is a poor trade for a
	 * leak that is not happening.
	 */
	it('leaves one that named a proxy running', async () => {
		const { service, cancelled } = stalled();
		void service.begin('trader', 'a-password', 'socks5://10.0.0.1:1080');
		await Promise.resolve();
		await Promise.resolve();

		service.forgetUnrouted();

		expect(cancelled()).toBe(0);
	});

	/**
	 * **And the set empties as sessions end.**
	 *
	 * It is a second registry beside `liveSessions`, so it has to be cleared on
	 * both of the paths that stop tracking a session — the cancel and the
	 * successful release. Missed, it grows for the life of the process and a
	 * later sweep reaches into finished sign-ins: harmless in effect, because
	 * cancelling a completed session is swallowed, and a leak either way.
	 */
	it('stops tracking an enrolment that finished', async () => {
		const { vault } = fakeVault();
		let cancelled = 0;
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
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

		await service.begin('trader', 'a-password');
		service.forgetUnrouted();

		expect(cancelled, 'a finished sign-in was still being tracked as in flight').toBe(0);
	});

	/*
	 * The other half of the same cleanup: a session this sweep has already
	 * cancelled must leave the set too, or a second sweep reaches back into it.
	 * Two registries kept in step is exactly the arrangement that drifts.
	 */
	it('does not cancel the same enrolment twice', async () => {
		const { service, cancelled } = stalled();
		void service.begin('trader', 'a-password');
		await Promise.resolve();
		await Promise.resolve();

		service.forgetUnrouted();
		service.forgetUnrouted();

		expect(cancelled(), 'a cancelled sign-in stayed on the in-flight list').toBe(1);
	});

	/**
	 * **Ours or Steam's?**
	 *
	 * A cancelled `startWithCredentials` rejects, and the catch reported "Steam
	 * refused the sign-in" — true of a rejected password, false of every
	 * cancellation. Enrolment does not use the callback `login.ts` threads a
	 * reason through, so it had no way to say which had happened: a user who had
	 * just switched `Require proxies` on was told Steam had turned them away.
	 */
	it('says the policy stopped it, not that Steam refused', async () => {
		const { vault } = fakeVault();
		let reject: ((err: Error) => void) | undefined;
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => ({
				...fakeSession(),
				startWithCredentials: () =>
					new Promise((_resolve, fail) => {
						reject = fail;
					}),
				// What the library does when the attempt is abandoned.
				cancelLoginAttempt: () => reject?.(new Error('LoginSession was cancelled'))
			}),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		const enrolling = service.begin('trader', 'a-password');
		await Promise.resolve();
		await Promise.resolve();
		service.forgetUnrouted();

		await expect(enrolling).rejects.toThrow(/require proxies/i);
		await expect(enrolling).rejects.not.toThrow(/Steam refused/i);
	});

	it('still says Steam refused when Steam actually did', async () => {
		const { vault } = fakeVault();
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => ({
				...fakeSession(),
				startWithCredentials: () => Promise.reject(new Error('InvalidPassword'))
			}),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		await expect(service.begin('trader', 'wrong')).rejects.toThrow(/Steam refused/i);
	});

	it('does nothing when no enrolment is running', () => {
		const { service, cancelled } = stalled();
		expect(() => service.forgetUnrouted()).not.toThrow();
		expect(cancelled()).toBe(0);
	});
});

/**
 * **A sign-in that fails must still let go of the session.**
 *
 * `release(session)` sat in a `finally` around the enrolment, and `await
 * authenticated` sat above it. So a rejected authentication — a wrong password,
 * a refused Steam Guard code, a proxy that dropped — threw straight past the
 * `finally` and the live session was never released. It holds an open connection
 * to Steam and, on a routed account, a proxy socket; leaking one per failed
 * attempt is the shape a user retrying a mistyped password produces.
 */
describe('a sign-in that fails to authenticate', () => {
	/** A session that reports failure the way steam-session does, and records it. */
	function failingSession(cancelled: { count: number }): LoginSessionLike {
		const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
		return {
			startWithCredentials: () => {
				queueMicrotask(() => listeners.error?.forEach((fn) => fn(new Error('InvalidPassword'))));
				return Promise.resolve({ actionRequired: false });
			},
			submitSteamGuardCode: () => Promise.resolve(),
			on: (event: string, listener: (arg?: unknown) => void) => {
				(listeners[event] ??= []).push(listener);
			},
			cancelLoginAttempt: () => {
				cancelled.count += 1;
			},
			refreshToken: MOBILE,
			accessToken: MOBILE,
			steamID: { getSteamID64: () => STEAM_ID }
		};
	}

	it('leaves nothing for the next lock to clean up', async () => {
		const cancelled = { count: 0 };
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const { vault } = fakeVault();

		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => failingSession(cancelled),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		await expect(service.begin('trader', 'wrong password')).rejects.toThrow();

		/*
		 * `release` untracks; it does not cancel. So the leak is only visible
		 * through what still holds a reference — and `forget`, which the vault lock
		 * calls, cancels every session in `liveSessions`. Nothing should be left
		 * there: this sign-in is over.
		 */
		service.forget();

		expect(
			cancelled.count,
			'a failed authentication left its Steam session tracked as live, holding an open ' +
				'connection and, on a routed account, a proxy socket — until the next vault lock ' +
				'happened to sweep it up'
		).toBe(0);
	});

	/* And a second attempt is not refused as "one at a time" by a leaked first. */
	it('lets the next attempt start', async () => {
		const cancelled = { count: 0 };
		const transports = {
			forAccount: () => Promise.resolve(() => Promise.resolve({ status: 200, text: '{}' }))
		} as unknown as SteamTransportFactory;
		const { vault } = fakeVault();
		let fail = true;

		const service = new EnrollmentService(vault as never, transports, {
			now: () => NOW,
			loginSession: () => (fail ? failingSession(cancelled) : fakeSession()),
			startEnrollment: () => Promise.resolve(STARTED),
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

		await expect(service.begin('trader', 'wrong password')).rejects.toThrow();
		fail = false;
		await expect(service.begin('trader', 'the right one')).resolves.toBeDefined();
	});
});
