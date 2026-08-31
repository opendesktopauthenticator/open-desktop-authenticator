import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerTransferHandlers } from '../src/main/steam/transfer-ipc';
import { ProxyConsent, type ProxyConsentRequest } from '../src/main/net/proxy-consent';
import { TransferService } from '../src/main/steam/transfer';
import type { VaultService } from '../src/main/vault/service';

/*
 * The IPC surface of an authenticator transfer.
 *
 * What matters here is not that the calls work — the service's own tests cover
 * that — but what is allowed to cross. By the time `authenticate` answers, the
 * main process holds a refresh token and an access token for the account. The
 * renderer must learn which account it is looking at, and nothing else.
 */

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	}
}));

const STEAM_ID = '76561198000000001';

function harness(
	options: {
		unlocked?: boolean;
		/** Whether the vault refuses to talk to Steam without a proxy. */
		requireProxies?: boolean;
		authenticate?: unknown;
		/** What the service says it is still waiting on, if anything. */
		awaiting?: 'persist' | 'unanswered' | 'unreadable';
		/** Whether the user approves the proxy destination when asked. */
		approveProxy?: boolean;
	} = {}
): {
	transfer: {
		cancel: ReturnType<typeof vi.fn>;
		authenticate: ReturnType<typeof vi.fn>;
		awaiting: ReturnType<typeof vi.fn>;
	};
	touched: () => number;
	/** Every destination the gate put to the user, in order. */
	asked: ProxyConsentRequest[];
} {
	let touches = 0;
	const authenticate =
		options.authenticate ??
		vi.fn(() =>
			Promise.resolve({ state: 'authenticated', steamId64: STEAM_ID, accountName: 'someone' })
		);
	const transfer = {
		authenticate,
		cancel: vi.fn(),
		current: vi.fn(() => ({ steamId64: STEAM_ID, accountName: 'someone' })),
		awaiting: vi.fn(() => options.awaiting)
	};
	const vault = {
		isUnlocked: () => options.unlocked !== false,
		// Strict mode off unless a test says otherwise. A fake without this threw
		// on every transfer the moment `Require proxies` reached this handler.
		settings: () => ({ requireProxies: options.requireProxies === true }),
		touch: () => {
			touches += 1;
		}
	} as unknown as VaultService;

	/*
	 * **The destination gate.** The renderer names the proxy host on this call,
	 * and this call carries a password and a Steam Guard code. Approving by
	 * default keeps these cases about the policy they were written for; the
	 * refusal is asserted in its own describe.
	 */
	const approveProxy = options.approveProxy ?? true;
	const asked: ProxyConsentRequest[] = [];
	registerTransferHandlers(
		transfer as unknown as TransferService,
		vault,
		undefined,
		new ProxyConsent({
			ask: (request) => {
				asked.push(request);
				return Promise.resolve(approveProxy);
			}
		})
	);
	return { transfer: transfer as never, touched: () => touches, asked };
}

async function call(channel: string, request: unknown = {}): Promise<unknown> {
	const handler = handlers.get(channel);
	if (!handler) {
		throw new Error(`${channel} was never registered`);
	}
	return handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request);
}

const CREDENTIALS = {
	accountName: 'someone',
	password: 'hunter2',
	steamGuardCode: 'QK4TX'
};

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);
});

describe('signing in for a transfer over IPC', () => {
	it('registers all three channels', () => {
		harness();
		expect(handlers.has(CHANNELS.transferAuthenticate)).toBe(true);
		expect(handlers.has(CHANNELS.transferStatus)).toBe(true);
		expect(handlers.has(CHANNELS.transferCancel)).toBe(true);
	});

	it('answers with the account and nothing more', async () => {
		harness();
		const answer = await call(CHANNELS.transferAuthenticate, CREDENTIALS);
		expect(answer).toEqual({
			state: 'authenticated',
			steamId64: STEAM_ID,
			accountName: 'someone'
		});
	});

	/*
	 * The service holds tokens for this account the moment this resolves. A
	 * response that grew a `refreshToken` field would be a serious regression and
	 * would still look perfectly reasonable in a diff.
	 */
	it('never lets a token cross', async () => {
		const authenticate = vi.fn(() =>
			Promise.resolve({
				state: 'authenticated',
				steamId64: STEAM_ID,
				accountName: 'someone',
				refreshToken: 'eyJhbGciOiJub25lIn0.token',
				accessToken: 'access-token'
			})
		);
		harness({ authenticate });
		const answer = await call(CHANNELS.transferAuthenticate, CREDENTIALS).catch(
			(err: unknown) => err
		);
		expect(JSON.stringify(answer)).not.toContain('token');
	});

	it('refuses when the vault is locked, before any password is spent', async () => {
		const { transfer } = harness({ unlocked: false });
		await expect(call(CHANNELS.transferAuthenticate, CREDENTIALS)).rejects.toThrow();
		expect(transfer.authenticate).not.toHaveBeenCalled();
	});

	/*
	 * A transfer waits on a text message. That pause is invisible to an idle
	 * timer, and a vault that locked through it would strand a rotation Steam had
	 * already performed.
	 */
	it('counts the sign-in as activity so the vault does not lock mid-transfer', async () => {
		const h = harness();
		await call(CHANNELS.transferAuthenticate, CREDENTIALS);
		expect(h.touched()).toBe(1);
	});
});

describe('status and cancellation', () => {
	it('reports the transfer in progress', async () => {
		harness();
		await expect(call(CHANNELS.transferStatus)).resolves.toEqual({
			transfer: { steamId64: STEAM_ID, accountName: 'someone' }
		});
	});

	it('abandons on request', async () => {
		const { transfer } = harness();
		await expect(call(CHANNELS.transferCancel)).resolves.toEqual({});
		expect(transfer.cancel).toHaveBeenCalledOnce();
	});
});

/*
 * Telling the renderer that a retry is owed.
 *
 * Every vault lock reloads the window, and the knowledge that a transfer was
 * waiting to be saved lived only in that document's React state. Steam has
 * already rotated the authenticator by then, so what the reload stranded was the
 * only copy of a replacement Steam will not issue again — held in the main
 * process, unreachable, until the process exited and took it with it.
 *
 * `awaiting` is what closes that: it names a step, carries no secret, and is the
 * one signal that survives the reload.
 */
describe('reporting an outstanding retry', () => {
	it('says nothing is owed on an ordinary pending transfer', async () => {
		const { transfer } = harness();
		await expect(call(CHANNELS.transferStatus, {})).resolves.toEqual({
			transfer: { steamId64: STEAM_ID, accountName: 'someone' }
		});
		expect(transfer.awaiting).toHaveBeenCalled();
	});

	it('reports a decoded authenticator waiting to be written', async () => {
		harness({ awaiting: 'persist' });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toMatchObject({
			awaiting: 'persist'
		});
	});

	it('reports a transfer that ended without a usable authenticator', async () => {
		harness({ awaiting: 'unreadable' });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toMatchObject({
			awaiting: 'unreadable'
		});
	});

	it('carries no secret with it', async () => {
		harness({ awaiting: 'persist' });
		const status = await call(CHANNELS.transferStatus, {});
		// It names a step. Everything else about the held secrets stays where it is.
		expect(Object.keys(status as object).sort()).toEqual(['awaiting', 'transfer']);
	});
});

/*
 * The status channel while the vault is locked.
 *
 * The lock handler deliberately keeps a transfer that is holding replacement
 * material — correct, and the reason it exists. But this channel then answered a
 * locked renderer with the account name, the SteamID and whether secrets were
 * outstanding. The activity log was gated for exactly this reason; this surface
 * is newer and was missed.
 */
describe('transfer status while locked', () => {
	it('answers normally while unlocked', async () => {
		harness({ awaiting: 'persist' });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toMatchObject({
			awaiting: 'persist'
		});
	});

	it('says nothing at all while locked', async () => {
		harness({ awaiting: 'persist', unlocked: false });
		await expect(call(CHANNELS.transferStatus, {})).resolves.toEqual({});
	});

	it('does not name the account while locked', async () => {
		harness({ awaiting: 'unreadable', unlocked: false });
		expect(JSON.stringify(await call(CHANNELS.transferStatus, {}))).not.toContain(STEAM_ID);
	});

	it('does not ask the service anything while locked', async () => {
		// The gate is ahead of the read, so a locked renderer cannot even learn that
		// a transfer exists by timing the answer.
		const { transfer } = harness({ awaiting: 'persist', unlocked: false });
		await call(CHANNELS.transferStatus, {});
		expect(transfer.awaiting).not.toHaveBeenCalled();
	});
});

/*
 * **The checkbox on the completion screen used to lead nowhere.**
 *
 * A transfer stores the account as `pendingRevocationBackup` deliberately; the
 * screen shows the code Steam will never issue again and asks the user to
 * confirm they wrote it down. Done only closed the screen. The account stayed
 * pending and the home screen went on warning that the code had never been
 * backed up — about the code the user had just been shown and had just
 * confirmed keeping.
 *
 * The confirm channel refuses unless the code was *revealed*, which is right: one
 * IPC call must not clear that warning for an account nobody ever showed. A
 * completed transfer is a reveal, and nothing was recording it.
 */
describe('a completed transfer and the recovery-code ceremony', () => {
	const completed = {
		steamId64: STEAM_ID,
		accountName: 'someone',
		revocationCode: 'R12345',
		timeOffsetSeconds: 0
	};

	/** A ceremony that reports what it was told, without reaching a vault. */
	function watchedCeremony() {
		const revealed: { steamId64: string; code: string }[] = [];
		return {
			ceremony: {
				recordReveal: (steamId64: string, code: string) => revealed.push({ steamId64, code }),
				hasRevealed: (steamId64: string, code: string) =>
					revealed.some((entry) => entry.steamId64 === steamId64 && entry.code === code),
				forget: () => revealed.splice(0)
			},
			revealed
		};
	}

	function transferHarness(result: typeof completed) {
		const { ceremony, revealed } = watchedCeremony();
		const transfer = {
			authenticate: vi.fn(),
			cancel: vi.fn(),
			current: vi.fn(() => ({ steamId64: STEAM_ID, accountName: 'someone' })),
			awaiting: vi.fn(() => undefined),
			completeTransfer: vi.fn(() => Promise.resolve(result)),
			retryPersist: vi.fn(() => Promise.resolve(result))
		};
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			settings: () => ({ requireProxies: false })
		} as unknown as VaultService;
		registerTransferHandlers(transfer as unknown as TransferService, vault, ceremony as never);
		return { revealed };
	}

	it('counts finishing the transfer as having shown the code', async () => {
		const { revealed } = transferHarness(completed);

		await call(CHANNELS.transferComplete, { smsCode: '12345' });

		expect(revealed, 'the confirm will refuse for a code it was never told about').toEqual([
			{ steamId64: STEAM_ID, code: 'R12345' }
		]);
	});

	/*
	 * The retry shows the same code on the same screen. A transfer whose storage
	 * failed the first time must not end up in the one state where the
	 * acknowledgement cannot be recorded.
	 */
	it('counts a retried persist the same way', async () => {
		const { revealed } = transferHarness(completed);

		await call(CHANNELS.transferRetryPersist);

		expect(revealed).toEqual([{ steamId64: STEAM_ID, code: 'R12345' }]);
	});

	it('records the code itself, so a confirm cannot ride on it for another', async () => {
		const { revealed } = transferHarness(completed);
		await call(CHANNELS.transferComplete, { smsCode: '12345' });

		// The reveal handler in `vault/ipc.ts` checks the stored code against what
		// was shown. Recording the account alone would let a code imported after
		// this point be marked as backed up by a reveal that never included it.
		expect(revealed[0]?.code).toBe(completed.revocationCode);
	});

	it('still answers the renderer with the completed transfer', async () => {
		transferHarness(completed);
		expect(await call(CHANNELS.transferComplete, { smsCode: '12345' })).toMatchObject({
			steamId64: STEAM_ID,
			revocationCode: 'R12345'
		});
	});
});

/**
 * **Transfer carries a password and a Steam Guard code, and had no guard.**
 *
 * `Require proxies` is enforced at `SteamTransportFactory.forAccount`, which
 * every Steam request crosses — except the ones that never build a transport.
 * `steam-session` speaks over Node's own stack, so this call sent both secrets
 * to Steam from the machine's own address on a vault that forbade it, and
 * returned `{ state: 'authenticated' }` as though nothing were wrong.
 *
 * There is no stored account to read a proxy from; this is the call that
 * authenticates one for import. The field on the form is the only route there
 * is, and empty means refused.
 */
describe('transferring under Require proxies', () => {
	it('refuses an authenticate with no proxy', async () => {
		const { transfer } = harness({ requireProxies: true });

		await expect(
			call(CHANNELS.transferAuthenticate, {
				accountName: 'alice',
				password: 'secret',
				steamGuardCode: 'ABCDE'
			})
		).rejects.toThrow(/require proxies/i);

		expect(
			transfer.authenticate,
			'the password and Guard code were sent anyway'
		).not.toHaveBeenCalled();
	});

	it('refuses one whose proxy field is empty', async () => {
		const { transfer } = harness({ requireProxies: true });
		await expect(
			call(CHANNELS.transferAuthenticate, {
				accountName: 'alice',
				password: 'secret',
				steamGuardCode: 'ABCDE',
				proxyUrl: ''
			})
		).rejects.toThrow(/require proxies/i);
		expect(transfer.authenticate).not.toHaveBeenCalled();
	});

	it('allows one that names a proxy', async () => {
		const { transfer } = harness({ requireProxies: true });
		await call(CHANNELS.transferAuthenticate, {
			accountName: 'alice',
			password: 'secret',
			steamGuardCode: 'ABCDE',
			proxyUrl: 'http://10.0.0.9:8080'
		});
		expect(transfer.authenticate).toHaveBeenCalledWith(
			'alice',
			'secret',
			'ABCDE',
			'http://10.0.0.9:8080'
		);
	});

	/**
	 * **And the address is put to the user, because the renderer chose it.**
	 *
	 * Nothing validates the hostname — `planProxy` checks the scheme, the port
	 * and the credentials — so this channel was an outbound connection to any
	 * name the renderer liked, which is the exfiltration route the threat model
	 * says a compromised renderer does not have. This call is the worst one to
	 * leave open: the traffic it sends through the chosen host carries a password
	 * *and* a Steam Guard code.
	 */
	it('puts the destination to the user before the credentials go down it', async () => {
		const { asked } = harness({ requireProxies: true });
		await call(CHANNELS.transferAuthenticate, {
			accountName: 'alice',
			password: 'secret',
			steamGuardCode: 'ABCDE',
			proxyUrl: 'http://10.0.0.9:8080'
		});
		expect(asked, 'the destination was used without anyone being asked').toHaveLength(1);
		expect(asked[0]?.endpoint).toBe('10.0.0.9:8080');
		expect(asked[0]?.reason).toBe('signIn');
	});

	it('stops the transfer when the answer is no', async () => {
		const { transfer } = harness({ requireProxies: true, approveProxy: false });
		await expect(
			call(CHANNELS.transferAuthenticate, {
				accountName: 'alice',
				password: 'secret',
				steamGuardCode: 'ABCDE',
				proxyUrl: 'http://evil.example:8080'
			})
		).rejects.toThrow(/not approved/);
		expect(
			transfer.authenticate,
			'a refused destination still received the password and the Guard code'
		).not.toHaveBeenCalled();
	});

	it('changes nothing when the setting is off', async () => {
		const { transfer } = harness();
		await call(CHANNELS.transferAuthenticate, {
			accountName: 'alice',
			password: 'secret',
			steamGuardCode: 'ABCDE'
		});
		expect(transfer.authenticate).toHaveBeenCalled();
	});
});

/**
 * **The one transfer stage that is safe to abandon.**
 *
 * Cancelling a transfer mid-flight is refused by design: past the challenge,
 * Steam may have rotated the authenticator and `pending` holds the only route
 * back to secrets it will not reissue. That reasoning was applied to the whole
 * of `TransferService`, and it is too broad — `authenticate` changes nothing on
 * Steam and its own docblock says so. It also carries a password *and* a Steam
 * Guard code, so leaving it running was the most expensive exception of the
 * lot: turning `Require proxies` on did nothing about it for as long as the
 * sign-in timeout allowed.
 */
describe('cancelling a transfer authentication the policy forbids', () => {
	function stalled(proxyUrl?: string) {
		let cancelled = 0;
		const transfer = new TransferService({} as never, {} as never, () => 0, {
			signIn: (
				_request: unknown,
				_proxyUrl: string | undefined,
				_factory: unknown,
				_now: unknown,
				onAttempt?: (cancel: () => void) => void
			) => {
				onAttempt?.(() => {
					cancelled += 1;
				});
				// Never settles: still talking to Steam, which is the only moment
				// this method exists for.
				return new Promise(() => undefined);
			}
		} as never);
		void transfer.authenticate('alice', 'secret', 'ABCDE', proxyUrl).catch(() => undefined);
		return { transfer, cancelled: () => cancelled };
	}

	it('cancels one that named no proxy', async () => {
		const { transfer, cancelled } = stalled();
		await Promise.resolve();

		transfer.cancelUnroutedAuthentication();

		expect(cancelled(), 'the password and Guard code kept going out').toBe(1);
	});

	it('leaves one that named a proxy running', async () => {
		const { transfer, cancelled } = stalled('http://10.0.0.9:8080');
		await Promise.resolve();

		transfer.cancelUnroutedAuthentication();

		expect(cancelled()).toBe(0);
	});

	it('does not cancel the same authentication twice', async () => {
		const { transfer, cancelled } = stalled();
		await Promise.resolve();

		transfer.cancelUnroutedAuthentication();
		transfer.cancelUnroutedAuthentication();

		expect(cancelled()).toBe(1);
	});

	/*
	 * And the record does not outlive the stage. Left behind, a later sweep
	 * reaches into a sign-in that has already finished — harmless in effect,
	 * because a second cancel is swallowed, and a stale handle to a closure that
	 * held a password either way.
	 */
	it('stops tracking an authentication that has finished', async () => {
		let cancelled = 0;
		const transfer = new TransferService({} as never, {} as never, () => 0, {
			signIn: (
				_request: unknown,
				_proxyUrl: string | undefined,
				_factory: unknown,
				_now: unknown,
				onAttempt?: (cancel: () => void) => void
			) => {
				onAttempt?.(() => {
					cancelled += 1;
				});
				return Promise.reject(new Error('Steam said no'));
			}
		});

		await transfer.authenticate('alice', 'secret', 'ABCDE').catch(() => undefined);
		transfer.cancelUnroutedAuthentication();

		expect(cancelled, 'a finished sign-in was still tracked as in flight').toBe(0);
	});

	it('does nothing when no authentication is running', () => {
		const transfer = new TransferService({} as never, {} as never, () => 0);
		expect(() => transfer.cancelUnroutedAuthentication()).not.toThrow();
	});
});
