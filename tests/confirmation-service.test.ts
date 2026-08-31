import { describe, expect, it } from 'vitest';
import { ConfirmationsError, ConfirmationsService } from '../src/main/confirmations/service';
import { SteamLoginError } from '../src/main/steam/login';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

/**
 * Confirmations, joined up to the vault and the network.
 *
 * The behaviour under test is mostly about what the renderer is *not* trusted
 * with. It sends ids; the nonce that makes acting on a confirmation possible,
 * and the type that decides whether S16 permits it, both come from what Steam
 * actually sent — remembered here, never round-tripped through the UI.
 */

const NOW = Date.parse('2026-08-10T00:00:00Z');
const IDENTITY = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';

function jwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ typ: 'JWT' })}.${encode(claims)}.sig`;
}

const REFRESH = jwt({
	aud: ['web', 'renew', 'derive', 'mobile'],
	exp: Math.floor(NOW / 1000) + 86_400
});
const ACCESS = jwt({ aud: ['mobile'], exp: Math.floor(NOW / 1000) + 3600 });

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: '76561198000000001',
		accountName: 'trader',
		sharedSecret: IDENTITY,
		identitySecret: IDENTITY,
		refreshToken: REFRESH,
		status: 'active',
		addedAt: '2026-08-01T00:00:00.000Z',
		autoConfirm: newAutoConfirm(),
		...overrides
	};
}

/**
 * A vault that holds exactly what the test put in it.
 *
 * `mutate` is real enough to matter: the sign-in path writes the refresh token
 * back through it, so a stub that only reads makes that whole path untestable —
 * which is how the token-caching rule went uncovered.
 */
function fakeVault(accounts: Account[]): VaultService {
	return {
		read: () => ({ accounts }),
		mutate: async (apply: (draft: { accounts: Account[] }) => void) => {
			apply({ accounts });
			return Promise.resolve();
		}
	} as unknown as VaultService;
}

const TRADE = { id: '11', nonce: 'n-trade', type: 2 };
const RECOVERY = { id: '33', nonce: 'n-recovery', type: 6 };

/** Answers the token endpoint and mobileconf, recording everything. */
function fakeNetwork(confirmations: object[] = [TRADE, RECOVERY]): {
	transports: SteamTransportFactory;
	sent: SteamRequest[];
} {
	const sent: SteamRequest[] = [];
	const transport = (request: SteamRequest): Promise<SteamResponse> => {
		sent.push(request);
		if (request.url.includes('GenerateAccessTokenForApp')) {
			return Promise.resolve({
				status: 200,
				text: JSON.stringify({ response: { access_token: ACCESS } })
			});
		}
		if (request.url.includes('getlist')) {
			return Promise.resolve({
				status: 200,
				text: JSON.stringify({ success: true, conf: confirmations })
			});
		}
		return Promise.resolve({ status: 200, text: JSON.stringify({ success: true }) });
	};

	return {
		sent,
		transports: {
			forAccount: () => Promise.resolve(transport)
		} as unknown as SteamTransportFactory
	};
}

function service(vault: VaultService, transports: SteamTransportFactory): ConfirmationsService {
	return new ConfirmationsService(vault, transports, { now: () => NOW });
}

describe('listing', () => {
	it('never hands the renderer a nonce', async () => {
		const { transports } = fakeNetwork();
		const { confirmations: listed } = await service(fakeVault([account()]), transports).list(
			'76561198000000001'
		);

		// The nonce is the credential half of acting on a confirmation. The UI has
		// no use for it and therefore never gets it.
		expect(JSON.stringify(listed)).not.toContain('n-trade');
		expect(JSON.stringify(listed)).not.toContain('nonce');
	});

	it('names the type itself, and keeps Steam label in a separate field', async () => {
		// A name the server chooses is a name an attacker can choose, and this is
		// the text a user reads before approving something. Steam's label is
		// forwarded — it is real information and the UI shows it — but it lives in
		// its own field, attributed to Steam, and can never occupy `typeName`.
		// A confirmation whose type is 6 must read "Account recovery" however
		// reassuringly its `type_name` is worded.
		const { transports } = fakeNetwork([{ ...TRADE, type: 6, type_name: 'Totally Safe Thing' }]);
		const { confirmations: listed } = await service(fakeVault([account()]), transports).list(
			'76561198000000001'
		);

		expect(listed[0]?.typeName).toBe('Account recovery');
		expect(listed[0]?.steamTypeName).toBe('Totally Safe Thing');
		// The classification the app acts on comes from `type`, never from text.
		expect(listed[0]?.securityCritical).toBe(true);
		expect(listed[0]?.autoConfirmable).toBe(false);
	});

	it('flags an account-recovery confirmation as security critical', async () => {
		const { transports } = fakeNetwork();
		const { confirmations: listed } = await service(fakeVault([account()]), transports).list(
			'76561198000000001'
		);

		const recovery = listed.find((entry) => entry.id === '33');
		expect(recovery?.typeName).toBe('Account recovery');
		expect(recovery?.securityCritical).toBe(true);
		expect(recovery?.autoConfirmable).toBe(false);
	});

	it('mints a session from the stored refresh token, once', async () => {
		const { transports, sent } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);

		await confirmations.list('76561198000000001');
		await confirmations.list('76561198000000001');

		const mints = sent.filter((request) => request.url.includes('GenerateAccessTokenForApp'));
		expect(mints).toHaveLength(1);
		// And the session cookie carries the minted token, not the refresh token.
		const listCalls = sent.filter((request) => request.url.includes('getlist'));
		expect(listCalls[0]?.cookie).toContain(ACCESS);
		expect(listCalls[0]?.cookie).not.toContain(REFRESH);
	});

	it('says to sign in when the account has no saved session', async () => {
		const { transports } = fakeNetwork();
		const without = account();
		delete without.refreshToken;

		await expect(
			service(fakeVault([without]), transports).list('76561198000000001')
		).rejects.toMatchObject({ needsSignIn: true });
	});

	it('refuses an account it does not hold', async () => {
		const { transports } = fakeNetwork();
		await expect(
			service(fakeVault([account()]), transports).list('76561198000000009')
		).rejects.toThrow(/no such account/);
	});
});

describe('acting', () => {
	it('resolves an id back to the nonce Steam sent', async () => {
		const { transports, sent } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);

		await confirmations.list('76561198000000001');
		await confirmations.act('76561198000000001', 'allow', ['11']);

		const op = sent.find((request) => request.url.includes('multiajaxop'));
		expect(op?.body?.getAll('cid[]')).toEqual(['11']);
		expect(op?.body?.getAll('ck[]')).toEqual(['n-trade']);
	});

	it('refuses the whole batch when an id is not from the last fetch', async () => {
		// A stale screen must fail loudly rather than act on a subset the user
		// never saw.
		const { transports } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);
		await confirmations.list('76561198000000001');

		await expect(confirmations.act('76561198000000001', 'allow', ['11', '99'])).rejects.toThrow(
			/out of date/
		);
	});

	it('refuses to act before anything has been listed', async () => {
		const { transports } = fakeNetwork();
		await expect(
			service(fakeVault([account()]), transports).act('76561198000000001', 'allow', ['11'])
		).rejects.toThrow(/out of date/);
	});

	it('applies the S16 batch rule using the type STEAM sent, not one the caller claims', async () => {
		// The renderer only ever sends ids. The type comes from the remembered
		// fetch, so a caller cannot slip an account-recovery confirmation through by
		// describing it as a trade.
		const { transports, sent } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);
		await confirmations.list('76561198000000001');

		await expect(confirmations.act('76561198000000001', 'allow', ['11', '33'])).rejects.toThrow(
			/one at a time/
		);

		expect(sent.filter((request) => request.url.includes('multiajaxop'))).toHaveLength(0);
	});

	it('allows a security-critical confirmation on its own', async () => {
		const { transports, sent } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);
		await confirmations.list('76561198000000001');

		await confirmations.act('76561198000000001', 'cancel', ['33']);

		const op = sent.find((request) => request.url.includes('multiajaxop'));
		expect(op?.body?.get('op')).toBe('cancel');
	});

	it('does not let the same confirmation be acted on twice', async () => {
		const { transports } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);
		await confirmations.list('76561198000000001');

		await confirmations.act('76561198000000001', 'allow', ['11']);

		// Steam has already closed it; sending again would be acting on nothing.
		await expect(confirmations.act('76561198000000001', 'allow', ['11'])).rejects.toThrow(
			/out of date/
		);
	});

	it('rejects an empty selection', async () => {
		const { transports } = fakeNetwork();
		await expect(
			service(fakeVault([account()]), transports).act('76561198000000001', 'allow', [])
		).rejects.toThrow(/nothing was selected/);
	});
});

describe('forgetting', () => {
	it('drops the cached session and the pending list', async () => {
		const { transports, sent } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);
		await confirmations.list('76561198000000001');

		confirmations.forget();

		// Nothing left to act on...
		await expect(confirmations.act('76561198000000001', 'allow', ['11'])).rejects.toThrow(
			/out of date/
		);

		// ...and the next fetch mints a fresh session rather than reusing a token
		// that outlived the unlock.
		await confirmations.list('76561198000000001');
		expect(
			sent.filter((request) => request.url.includes('GenerateAccessTokenForApp'))
		).toHaveLength(2);
	});
});

/** A transport whose responses can be held open, so a lock can land mid-flight. */
function pausableNetwork(): {
	transports: SteamTransportFactory;
	release: () => void;
	sent: SteamRequest[];
} {
	const sent: SteamRequest[] = [];
	let gate: () => void = () => undefined;
	const waited = new Promise<void>((resolve) => {
		gate = resolve;
	});

	const transport = async (request: SteamRequest): Promise<SteamResponse> => {
		sent.push(request);
		if (request.url.includes('getlist')) {
			await waited;
			return { status: 200, text: JSON.stringify({ success: true, conf: [TRADE] }) };
		}
		if (request.url.includes('GenerateAccessTokenForApp')) {
			return { status: 200, text: JSON.stringify({ response: { access_token: ACCESS } }) };
		}
		return { status: 200, text: JSON.stringify({ success: true }) };
	};

	return {
		sent,
		release: () => gate(),
		transports: { forAccount: () => Promise.resolve(transport) } as unknown as SteamTransportFactory
	};
}

describe('a lock cancels what is already in flight', () => {
	it('does not let a list landing after the lock restore the nonces', async () => {
		// Clearing the maps is not enough on its own: the response writes back
		// *after* it returns, so a lock mid-request used to be undone a moment later
		// by the very request it was supposed to end.
		const { transports, release } = pausableNetwork();
		const confirmations = service(fakeVault([account()]), transports);

		const inFlight = confirmations.list('76561198000000001');
		confirmations.forget();
		release();

		await expect(inFlight).rejects.toThrow(/locked while this was loading/);

		// And nothing was left behind for a later act to use.
		await expect(confirmations.act('76561198000000001', 'allow', ['11'])).rejects.toThrow(
			/out of date/
		);
	});

	it('does not let a token minted before the lock stay cached', async () => {
		const { transports, release, sent } = pausableNetwork();
		const confirmations = service(fakeVault([account()]), transports);

		const inFlight = confirmations.list('76561198000000001');
		confirmations.forget();
		release();
		await inFlight.catch(() => undefined);

		// A fresh listing must mint again rather than reuse a credential that
		// outlived the session it belonged to.
		release();
		await confirmations.list('76561198000000001').catch(() => undefined);

		expect(
			sent.filter((request) => request.url.includes('GenerateAccessTokenForApp')).length
		).toBeGreaterThan(1);
	});
});

describe('operations on one account do not interleave', () => {
	it('cannot replay an operation when a list lands during it', async () => {
		// `act` used to hold the pending map across its await. A `list` completing in
		// that window replaced it, so the removal hit an orphan while the live map
		// still held the nonce — and the same confirmation could be sent twice.
		const { transports } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);
		await confirmations.list('76561198000000001');

		const first = confirmations.act('76561198000000001', 'allow', ['11']);
		const second = confirmations.act('76561198000000001', 'allow', ['11']);

		await first;
		await expect(second).rejects.toThrow(/out of date/);
	});

	it('serialises a list issued while an act is running', async () => {
		const { transports, sent } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);
		await confirmations.list('76561198000000001');

		await Promise.all([
			confirmations.act('76561198000000001', 'allow', ['11']),
			confirmations.list('76561198000000001')
		]);

		// One operation reached Steam, not two racing ones.
		expect(sent.filter((request) => request.url.includes('multiajaxop'))).toHaveLength(1);
	});
});

/**
 * Regressions found in the round-7 audit.
 *
 * Both are about state surviving something that was supposed to end it: an
 * in-flight call writing back after a routing change, and a token cached without
 * the check that decides whether it can work at all.
 */
describe('what a routing change invalidates', () => {
	it('refuses an in-flight call that finishes after forgetAccount', async () => {
		// `forget` (lock) bumped the generation; `forgetAccount` (routing change)
		// only cleared the maps. So a mint or a list already awaiting the network
		// happily wrote its result back afterwards — repopulating a session
		// established over the *previous* route, which is the exact linkage the
		// routing change exists to break.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const transport = async (request: SteamRequest): Promise<SteamResponse> => {
			if (request.url.includes('getlist')) {
				await gate;
				return { status: 200, text: JSON.stringify({ success: true, conf: [TRADE] }) };
			}
			return {
				status: 200,
				text: JSON.stringify({ response: { access_token: ACCESS } })
			};
		};
		const transports = {
			forAccount: () => Promise.resolve(transport)
		} as unknown as SteamTransportFactory;

		const confirmations = service(fakeVault([account()]), transports);
		const pending = confirmations.list('76561198000000001');

		confirmations.forgetAccount('76561198000000001');
		release();

		await expect(pending).rejects.toThrow();
	});
});

describe('classifying a sign-in failure', () => {
	it('carries `permanent` through, so the UI can stop offering a password', async () => {
		// `SteamLoginError.permanent` exists to say that retrying cannot help —
		// Steam wanting the approval on the device that holds the authenticator, or
		// an account using emailed codes this app cannot answer. It was assigned,
		// unit-tested, and then flattened away here: every login failure became an
		// identical retryable one on the way to the renderer.
		const { transports } = fakeNetwork();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: () => {
				throw new SteamLoginError('approve this on the device that holds the authenticator', true);
			}
		});

		const failure = await confirmations
			.signIn('76561198000000001', 'a-password')
			.catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(ConfirmationsError);
		expect((failure as ConfirmationsError).permanent).toBe(true);
	});

	it('leaves a retryable failure retryable', async () => {
		const { transports } = fakeNetwork();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: () => {
				throw new SteamLoginError('Steam is rate-limiting sign-ins from this address', false);
			}
		});

		const failure = await confirmations
			.signIn('76561198000000001', 'a-password')
			.catch((err: unknown) => err);

		expect((failure as ConfirmationsError).permanent).toBe(false);
	});
});

describe('the access token a sign-in returns', () => {
	const signInReturning = (accessToken: string) => () =>
		Promise.resolve({ refreshToken: REFRESH, accessToken });

	it('is cached when it is mobile-scoped and usable', async () => {
		const { transports, sent } = fakeNetwork();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: signInReturning(ACCESS)
		});

		await confirmations.signIn('76561198000000001', 'a-password');
		await confirmations.list('76561198000000001');

		// Cached, so listing did not have to mint one.
		expect(sent.some((request) => request.url.includes('GenerateAccessTokenForApp'))).toBe(false);
	});

	it('is NOT cached when it is web-scoped', async () => {
		// The mint path checks this; the login path did not. A web-scoped token
		// caches perfectly and then fails every confirmation, which reads as the
		// app being broken rather than as the token being wrong (F-13). Caching
		// nothing is strictly better: the next call mints through the path that
		// does validate.
		const webScoped = jwt({ aud: ['web'], exp: Math.floor(NOW / 1000) + 3600 });
		const { transports, sent } = fakeNetwork();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: signInReturning(webScoped)
		});

		await confirmations.signIn('76561198000000001', 'a-password');
		await confirmations.list('76561198000000001');

		expect(sent.some((request) => request.url.includes('GenerateAccessTokenForApp'))).toBe(true);
		expect(sent.some((request) => request.cookie?.includes(webScoped))).toBe(false);
	});

	it('is NOT cached when it has already expired', async () => {
		const expired = jwt({ aud: ['mobile'], exp: Math.floor(NOW / 1000) - 60 });
		const { transports, sent } = fakeNetwork();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: signInReturning(expired)
		});

		await confirmations.signIn('76561198000000001', 'a-password');
		await confirmations.list('76561198000000001');

		expect(sent.some((request) => request.url.includes('GenerateAccessTokenForApp'))).toBe(true);
	});
});

/*
 * The per-account queue map is not allowed to grow forever.
 *
 * Every operation wrote an entry keyed by SteamID and nothing ever removed one —
 * not completion, not account removal, not a routing change, not a vault lock.
 * A process that adds, uses and removes accounts over a long session accumulated
 * one settled promise per SteamID it had ever touched, for as long as it ran.
 */
describe('the account queue map drains', () => {
	/** The map is private; its size is the only thing under test. */
	const sizeOf = (svc: ConfirmationsService): number =>
		(svc as unknown as { queues: Map<string, unknown> }).queues.size;

	it('holds nothing once an operation has finished', async () => {
		const { transports } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);

		await confirmations.list('76561198000000001');

		expect(sizeOf(confirmations)).toBe(0);
	});

	it('holds nothing after a failed operation either', async () => {
		// A rejection still settles the chain, and a failure is exactly when an
		// entry would be most tempting to leave behind.
		const { transports } = fakeNetwork();
		const confirmations = service(fakeVault([]), transports);

		await confirmations.list('76561198000000001').catch(() => undefined);

		expect(sizeOf(confirmations)).toBe(0);
	});

	it('does not grow across many accounts used in turn', async () => {
		const { transports } = fakeNetwork();
		const confirmations = service(
			fakeVault([account(), { ...account(), steamId64: '76561198000000002' }]),
			transports
		);

		await confirmations.list('76561198000000001');
		await confirmations.list('76561198000000002');
		await confirmations.list('76561198000000001');

		expect(sizeOf(confirmations)).toBe(0);
	});

	it('still serialises two overlapping operations on one account', async () => {
		// The cleanup must not become a way for a second call to start a chain
		// beside a running one — the ordering guarantee is the reason the map
		// exists at all.
		const { transports } = fakeNetwork();
		const confirmations = service(fakeVault([account()]), transports);

		const both = Promise.all([
			confirmations.list('76561198000000001'),
			confirmations.list('76561198000000001')
		]);
		// While they are in flight the entry is present; that is the point of it.
		expect(sizeOf(confirmations)).toBe(1);

		await both;

		expect(sizeOf(confirmations)).toBe(0);
	});
});

/*
 * An unreadable entry during an *unattended* pass.
 *
 * When entries stopped being all-or-nothing, this path dropped the count on the
 * reasoning that the interactive list already warns. That is backwards for the
 * one pass that runs while nobody is watching: an entry that failed to parse has
 * no type, so it cannot be ruled out as the account-recovery confirmation, and
 * the automatic pass was the only thing that would ever have seen it.
 */
describe('what an automatic pass reports about entries it could not read', () => {
	const enabled = (): Account =>
		account({ autoConfirm: { ...newAutoConfirm(), marketListings: true, trades: true } });

	it('carries the count out of the pass', async () => {
		const { transports } = fakeNetwork([TRADE, { id: '77', nonce: 'n', type: '6' }]);
		const outcome = await service(fakeVault([enabled()]), transports).runAutoConfirm(
			'76561198000000001'
		);

		expect(outcome.unreadable).toBe(1);
	});

	it('reports it even when nothing readable was left', async () => {
		// The worst case, and the one that used to be completely silent: the only
		// entry Steam sent was one this build cannot parse.
		const { transports } = fakeNetwork([{ id: '77', nonce: 'n', type: '6' }]);
		const outcome = await service(fakeVault([enabled()]), transports).runAutoConfirm(
			'76561198000000001'
		);

		expect(outcome.approved).toHaveLength(0);
		expect(outcome.held).toHaveLength(0);
		// Without this the pass records nothing at all, and the account-recovery
		// confirmation it skipped is never mentioned to anybody.
		expect(outcome.unreadable).toBe(1);
	});

	it('reports zero when everything parsed', async () => {
		const { transports } = fakeNetwork();
		const outcome = await service(fakeVault([enabled()]), transports).runAutoConfirm(
			'76561198000000001'
		);

		expect(outcome.unreadable).toBe(0);
	});
});

/*
 * Turning a permission off applies to the pass already in flight.
 *
 * `connect` copies the account's auto-confirm settings before the list request
 * goes out, and the list takes as long as Steam takes. Approving from that copy
 * meant "disable trades" saved, the screen said off, and the trade already being
 * fetched was approved anyway. The settings are re-read from the vault after the
 * list returns, immediately before anything is approved.
 */
describe('a permission disabled while the list is in flight', () => {
	const enabled = (): Account =>
		account({ autoConfirm: { ...newAutoConfirm(), marketListings: true, trades: true } });

	it('holds the trade instead of approving it from the stale copy', async () => {
		const accounts = [enabled()];
		let releaseList: (() => void) | undefined;
		const listGate = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		let listStarted: (() => void) | undefined;
		const listRequested = new Promise<void>((resolve) => {
			listStarted = resolve;
		});

		const sent: SteamRequest[] = [];
		const transport = async (request: SteamRequest): Promise<SteamResponse> => {
			sent.push(request);
			if (request.url.includes('GenerateAccessTokenForApp')) {
				return {
					status: 200,
					text: JSON.stringify({ response: { access_token: ACCESS } })
				};
			}
			if (request.url.includes('getlist')) {
				// Held open until the test has changed the settings underneath it —
				// the window in which a real user opens Settings and turns trades off.
				// Signalled first, so the test flips the settings only once `connect`
				// has demonstrably taken its copy: flipping earlier hits the ordinary
				// "nothing enabled" early return and proves nothing.
				listStarted?.();
				await listGate;
				return { status: 200, text: JSON.stringify({ success: true, conf: [TRADE] }) };
			}
			return { status: 200, text: JSON.stringify({ success: true }) };
		};
		const transports = {
			forAccount: () => Promise.resolve(transport)
		} as unknown as SteamTransportFactory;

		const pass = service(fakeVault(accounts), transports).runAutoConfirm('76561198000000001');

		// Saved while the list request is provably in the air.
		await listRequested;
		(accounts[0] as Account).autoConfirm = newAutoConfirm();
		releaseList?.();

		const outcome = await pass;

		expect(outcome.approved).toHaveLength(0);
		// Nothing that approves may have gone out after the disable.
		expect(sent.some((request) => request.url.includes('ajaxop'))).toBe(false);
	});

	it('approves nothing for an account removed while the list was loading', async () => {
		const accounts = [enabled()];
		let releaseList: (() => void) | undefined;
		const listGate = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		let listStarted: (() => void) | undefined;
		const listRequested = new Promise<void>((resolve) => {
			listStarted = resolve;
		});

		const sent: SteamRequest[] = [];
		const transport = async (request: SteamRequest): Promise<SteamResponse> => {
			sent.push(request);
			if (request.url.includes('GenerateAccessTokenForApp')) {
				return {
					status: 200,
					text: JSON.stringify({ response: { access_token: ACCESS } })
				};
			}
			if (request.url.includes('getlist')) {
				listStarted?.();
				await listGate;
				return { status: 200, text: JSON.stringify({ success: true, conf: [TRADE] }) };
			}
			return { status: 200, text: JSON.stringify({ success: true }) };
		};
		const transports = {
			forAccount: () => Promise.resolve(transport)
		} as unknown as SteamTransportFactory;

		const pass = service(fakeVault(accounts), transports).runAutoConfirm('76561198000000001');

		await listRequested;
		accounts.length = 0;
		releaseList?.();

		const outcome = await pass;

		expect(outcome.approved).toHaveLength(0);
		expect(sent.some((request) => request.url.includes('ajaxop'))).toBe(false);
	});
});

/*
 * A routing change on one account must not disown another's in-flight work.
 *
 * `forgetAccount` used to bump the service-wide generation, so account B's
 * auto-confirm POST could succeed on Steam's side and then be reported as
 * *failed* because account A's proxy was saved while B's reply was in the air —
 * a false failure on an accepted, irreversible action, counted toward B's
 * ten-strike halt.
 */
describe('a routing change during another account’s pass', () => {
	const second = (): Account =>
		account({
			steamId64: '76561198000000002',
			accountName: 'other',
			autoConfirm: { ...newAutoConfirm(), marketListings: true, trades: true }
		});

	function gatedNetwork(): {
		transports: SteamTransportFactory;
		releaseOp: () => void;
		opRequested: Promise<void>;
	} {
		let releaseOp: (() => void) | undefined;
		const opGate = new Promise<void>((resolve) => {
			releaseOp = resolve;
		});
		let opStarted: (() => void) | undefined;
		const opRequested = new Promise<void>((resolve) => {
			opStarted = resolve;
		});
		const transport = async (request: SteamRequest): Promise<SteamResponse> => {
			if (request.url.includes('GenerateAccessTokenForApp')) {
				return { status: 200, text: JSON.stringify({ response: { access_token: ACCESS } }) };
			}
			if (request.url.includes('getlist')) {
				return { status: 200, text: JSON.stringify({ success: true, conf: [TRADE] }) };
			}
			// The approval POST: signalled, then held until the test releases it.
			opStarted?.();
			await opGate;
			return { status: 200, text: JSON.stringify({ success: true }) };
		};
		return {
			transports: {
				forAccount: () => Promise.resolve(transport)
			} as unknown as SteamTransportFactory,
			releaseOp: () => releaseOp?.(),
			opRequested
		};
	}

	it('keeps the accepted approval instead of reporting it failed', async () => {
		const { transports, releaseOp, opRequested } = gatedNetwork();
		const confirmations = service(fakeVault([second()]), transports);

		const pass = confirmations.runAutoConfirm('76561198000000002');
		await opRequested;

		// Account A's routing changes while B's approval POST is on the wire.
		confirmations.forgetAccount('76561198000000001');
		releaseOp();

		const outcome = await pass;
		expect(outcome.approved).toHaveLength(1);
	});

	it('still refuses when the change was this account’s own', async () => {
		const { transports, releaseOp, opRequested } = gatedNetwork();
		const confirmations = service(fakeVault([second()]), transports);

		const pass = confirmations.runAutoConfirm('76561198000000002');
		await opRequested;

		confirmations.forgetAccount('76561198000000002');
		releaseOp();

		await expect(pass).rejects.toThrow(/routing changed|locked/i);
	});
});

/*
 * Consent must hold at the POST, not merely shortly before it.
 *
 * The pass rereads the vault after listing — but the approval request then
 * awaits proxy-route verification inside the transport before a byte goes out,
 * and a user turning automatic confirmation off during *that* await still had
 * their trade approved. The check now runs inside the transport, after routing
 * is verified and immediately before the request is built.
 */
describe('consent withdrawn during route verification', () => {
	const enabled = (): Account =>
		account({ autoConfirm: { ...newAutoConfirm(), marketListings: true, trades: true } });

	it('sends no approval when the setting went off during the routing await', async () => {
		const accounts = [enabled()];
		let releaseRouting: (() => void) | undefined;
		const routingGate = new Promise<void>((resolve) => {
			releaseRouting = resolve;
		});
		let routingReached: (() => void) | undefined;
		const atRouting = new Promise<void>((resolve) => {
			routingReached = resolve;
		});

		const sent: SteamRequest[] = [];
		// A transport that models the real one: it awaits routing verification
		// before honouring the request, and calls `beforeSend` after that await.
		const transport = async (request: SteamRequest): Promise<SteamResponse> => {
			if (request.url.includes('GenerateAccessTokenForApp')) {
				return { status: 200, text: JSON.stringify({ response: { access_token: ACCESS } }) };
			}
			if (request.url.includes('getlist')) {
				return { status: 200, text: JSON.stringify({ success: true, conf: [TRADE] }) };
			}
			routingReached?.();
			await routingGate;
			request.beforeSend?.();
			sent.push(request);
			return { status: 200, text: JSON.stringify({ success: true }) };
		};
		const transports = {
			forAccount: () => Promise.resolve(transport)
		} as unknown as SteamTransportFactory;

		const pass = service(fakeVault(accounts), transports).runAutoConfirm('76561198000000001');
		await atRouting;

		// Saved while the approval request is verifying its route.
		(accounts[0] as Account).autoConfirm = newAutoConfirm();
		releaseRouting?.();

		await expect(pass).rejects.toThrow(/switched off/i);
		expect(sent).toHaveLength(0);
	});

	it('still approves when consent is untouched', async () => {
		const accounts = [enabled()];
		const sent: SteamRequest[] = [];
		const transport = (request: SteamRequest): Promise<SteamResponse> => {
			if (request.url.includes('GenerateAccessTokenForApp')) {
				return Promise.resolve({
					status: 200,
					text: JSON.stringify({ response: { access_token: ACCESS } })
				});
			}
			if (request.url.includes('getlist')) {
				return Promise.resolve({
					status: 200,
					text: JSON.stringify({ success: true, conf: [TRADE] })
				});
			}
			request.beforeSend?.();
			sent.push(request);
			return Promise.resolve({ status: 200, text: JSON.stringify({ success: true }) });
		};
		const transports = {
			forAccount: () => Promise.resolve(transport)
		} as unknown as SteamTransportFactory;

		const outcome = await service(fakeVault(accounts), transports).runAutoConfirm(
			'76561198000000001'
		);
		expect(outcome.approved).toHaveLength(1);
		expect(sent).toHaveLength(1);
	});
});

/*
 * A missing account is not consent.
 *
 * The last-moment hook returned early when the vault row was gone, treating
 * "the account no longer exists" as "nothing to check" — so a trade could
 * still be signed after the account was removed.
 */
describe('the account removed while the approval is being prepared', () => {
	it('sends nothing', async () => {
		const accounts = [
			account({ autoConfirm: { ...newAutoConfirm(), marketListings: true, trades: true } })
		];
		let releaseRouting: (() => void) | undefined;
		const routingGate = new Promise<void>((resolve) => {
			releaseRouting = resolve;
		});
		let routingReached: (() => void) | undefined;
		const atRouting = new Promise<void>((resolve) => {
			routingReached = resolve;
		});

		const sent: SteamRequest[] = [];
		const transport = async (request: SteamRequest): Promise<SteamResponse> => {
			if (request.url.includes('GenerateAccessTokenForApp')) {
				return { status: 200, text: JSON.stringify({ response: { access_token: ACCESS } }) };
			}
			if (request.url.includes('getlist')) {
				return { status: 200, text: JSON.stringify({ success: true, conf: [TRADE] }) };
			}
			routingReached?.();
			await routingGate;
			request.beforeSend?.();
			sent.push(request);
			return { status: 200, text: JSON.stringify({ success: true }) };
		};
		const transports = {
			forAccount: () => Promise.resolve(transport)
		} as unknown as SteamTransportFactory;

		const pass = service(fakeVault(accounts), transports).runAutoConfirm('76561198000000001');
		await atRouting;

		// Removed while the approval request is verifying its route.
		accounts.length = 0;
		releaseRouting?.();

		await expect(pass).rejects.toThrow(/removed from the vault/i);
		expect(sent).toHaveLength(0);
	});
});

/*
 * **The lock stopped the answer and not the question.**
 *
 * `forget` bumped the generation so a token arriving after a lock was thrown
 * away — the important half, and the only half there was. Underneath,
 * `steam-session` kept polling Steam over the account's proxy, with the user's
 * password alive in a closure, until Steam answered or the ninety-second
 * timeout fired. Everything else in `forget` stops work; this went on doing it.
 */
describe('a sign-in caught by the lock', () => {
	/** A sign-in that hangs until it is cancelled, like a real slow one. */
	const stalling = () => {
		let stop: (() => void) | undefined;
		let cancels = 0;
		const signIn = (
			_request: unknown,
			_proxyUrl: unknown,
			_factory: unknown,
			_now: unknown,
			onAttempt?: (cancel: () => void) => void
		): Promise<never> =>
			new Promise((_resolve, reject) => {
				stop = () => {
					cancels += 1;
					reject(new SteamLoginError('The vault locked before Steam finished signing in.', false));
				};
				onAttempt?.(stop);
			});
		return { signIn, cancels: () => cancels, started: () => stop !== undefined };
	};

	it('is cancelled when the vault locks', async () => {
		const { transports } = fakeNetwork();
		const attempt = stalling();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: attempt.signIn
		});

		const pending = confirmations.signIn('76561198000000001', 'a-password');
		// Let the queued work reach the sign-in.
		await Promise.resolve();
		await Promise.resolve();
		expect(attempt.started(), 'the sign-in never started').toBe(true);

		confirmations.forget();

		await expect(pending).rejects.toBeInstanceOf(ConfirmationsError);
		expect(attempt.cancels(), 'Steam was still being polled after the lock').toBe(1);
	});

	it('is cancelled when the account’s routing changes underneath it', async () => {
		const { transports } = fakeNetwork();
		const attempt = stalling();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: attempt.signIn
		});

		const pending = confirmations.signIn('76561198000000001', 'a-password');
		await Promise.resolve();
		await Promise.resolve();

		confirmations.forgetAccount('76561198000000001');

		await expect(pending).rejects.toBeInstanceOf(ConfirmationsError);
		expect(attempt.cancels()).toBe(1);
	});

	it('leaves nothing behind to cancel twice', async () => {
		const { transports } = fakeNetwork();
		const attempt = stalling();
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: attempt.signIn
		});

		const pending = confirmations.signIn('76561198000000001', 'a-password');
		await Promise.resolve();
		await Promise.resolve();

		confirmations.forget();
		await expect(pending).rejects.toBeInstanceOf(ConfirmationsError);
		// A second lock, or a routing change after one, must not reach into a
		// sign-in that has already ended.
		confirmations.forget();
		confirmations.forgetAccount('76561198000000001');

		expect(attempt.cancels()).toBe(1);
	});
});

/*
 * **A sign-in queued behind another had nothing to cancel.**
 *
 * `forget` stops attempts that are already running, and the grant captured at
 * the call refuses the *token* once one comes back. Neither reaches a request
 * still sitting in the per-account queue: it holds a password captured before
 * the lock, no session exists yet to cancel, so the lock passed straight over
 * it — and when the queue drained it went on to authenticate against Steam. The
 * answer was thrown away afterwards, by which point Steam had been asked.
 */
describe('a sign-in still queued when the vault locks', () => {
	it('never reaches Steam', async () => {
		const { transports } = fakeNetwork();
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const attempts: string[] = [];

		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: async (request: { password: string }) => {
				attempts.push(request.password);
				await held;
				return { refreshToken: REFRESH, accessToken: ACCESS };
			}
		});

		// One in flight, one queued behind it on the same account.
		const first = confirmations.signIn('76561198000000001', 'first-password');
		const queued = confirmations.signIn('76561198000000001', 'second-password');
		await Promise.resolve();
		expect(attempts).toEqual(['first-password']);

		// The lock lands while the second is still waiting its turn.
		confirmations.forget();
		release?.();

		await first.catch(() => undefined);
		await expect(queued).rejects.toBeInstanceOf(ConfirmationsError);

		expect(attempts, 'a queued password was sent to Steam after the lock').toEqual([
			'first-password'
		]);
	});

	it('still runs a sign-in queued after the lock', async () => {
		const { transports } = fakeNetwork();
		const attempts: string[] = [];
		const confirmations = new ConfirmationsService(fakeVault([account()]), transports, {
			now: () => NOW,
			signIn: (request: { password: string }) => {
				attempts.push(request.password);
				return Promise.resolve({ refreshToken: REFRESH, accessToken: ACCESS });
			}
		});

		confirmations.forget();
		await confirmations.signIn('76561198000000001', 'after-the-lock');

		expect(attempts).toEqual(['after-the-lock']);
	});
});

/*
 * **Re-authentication has to leave by the route the window will.**
 *
 * When Steam declines a saved session the user is asked to sign in again — and
 * that sign-in went through the account's stored proxy whatever they had
 * chosen. *Direct* exists because that proxy is rate-limited, blocked or dead,
 * so the fallback failed at exactly the step it was picked to get past.
 */
describe('the route a re-authentication takes', () => {
	const routed = () =>
		account({ steamId64: '76561198000000001', proxyUrl: 'http://10.0.0.9:8080' });

	function harness() {
		const { transports } = fakeNetwork();
		const routes: (string | undefined)[] = [];
		const confirmations = new ConfirmationsService(fakeVault([routed()]), transports, {
			now: () => NOW,
			signIn: (_request: unknown, proxyUrl: string | undefined) => {
				routes.push(proxyUrl);
				return Promise.resolve({ refreshToken: REFRESH, accessToken: ACCESS });
			}
		});
		return { confirmations, routes };
	}

	it('uses the account’s proxy by default', async () => {
		const { confirmations, routes } = harness();
		await confirmations.signIn('76561198000000001', 'a-password');
		expect(routes).toEqual(['http://10.0.0.9:8080']);
	});

	it('uses it when the proxy was explicitly chosen', async () => {
		const { confirmations, routes } = harness();
		await confirmations.signIn('76561198000000001', 'a-password', 'proxy');
		expect(routes).toEqual(['http://10.0.0.9:8080']);
	});

	/*
	 * **"Steam only" is a proxied route, not a half-direct one.**
	 *
	 * The sign-in this performs *is* a Steam request — it is the one that puts
	 * the account's address on record with Steam's login servers. Reading the
	 * name as "less proxying" and skipping the proxy here would hand Steam this
	 * machine's address at the single moment the user most wanted routed, and
	 * would do it invisibly: the window that opened afterwards would be routed
	 * correctly and look completely normal.
	 */
	it('uses it for Steam-only too, because a sign-in is a Steam request', async () => {
		const { confirmations, routes } = harness();
		await confirmations.signIn('76561198000000001', 'a-password', 'steam-only');
		expect(routes, 'Steam-only signed in to Steam without the proxy').toEqual([
			'http://10.0.0.9:8080'
		]);
	});

	it('goes without one when Direct was chosen', async () => {
		const { confirmations, routes } = harness();
		await confirmations.signIn('76561198000000001', 'a-password', 'direct');
		expect(routes, 'Direct signed in through the proxy it was avoiding').toEqual([undefined]);
	});
});

/**
 * **The sign-in is the one Steam path with no transport behind it.**
 *
 * `steam-session` speaks over Node's own HTTP stack, so the refusal that
 * `SteamTransportFactory` performs for every other request never sees this one
 * — and what travels here is a password.
 *
 * The IPC handler above it refuses a `route` of `direct`, and that was not
 * enough twice over. The Confirmations screen sends no route at all, so the
 * check saw `undefined` and passed; and the account being signed in might have
 * no proxy stored, in which case the route was never what made it unrouted.
 */
describe('signing in under Require proxies', () => {
	function harness(stored: Account, requireProxies = true) {
		const routes: (string | undefined)[] = [];
		const { transports } = fakeNetwork();
		const confirmations = new ConfirmationsService(fakeVault([stored]), transports, {
			now: () => NOW,
			requireProxies: () => requireProxies,
			signIn: (_request: unknown, proxyUrl: string | undefined) => {
				routes.push(proxyUrl);
				return Promise.resolve({ refreshToken: REFRESH, accessToken: ACCESS });
			}
		});
		return { confirmations, routes };
	}

	const unrouted = account();
	const routed = account({ proxyUrl: 'http://10.0.0.9:8080' });

	/**
	 * The exact shape the audit's probe reproduced: `requireProxies: true`, no
	 * route argument, an account with no proxy — and the sign-in went through
	 * with `proxyUrl: undefined` and returned success.
	 */
	it('refuses an account with no proxy when no route is given at all', async () => {
		const { confirmations, routes } = harness(unrouted);
		await expect(confirmations.signIn('76561198000000001', 'a-password')).rejects.toThrow(
			/require proxies/i
		);
		expect(routes, 'the password was sent unrouted').toEqual([]);
	});

	it('refuses it however the route is spelled', async () => {
		for (const route of ['proxy', 'steam-only', 'direct'] as const) {
			const { confirmations, routes } = harness(unrouted);
			await expect(confirmations.signIn('76561198000000001', 'a-password', route)).rejects.toThrow(
				/require proxies/i
			);
			expect(routes).toEqual([]);
		}
	});

	/*
	 * A routed account is still refused on the two routes that are not fully
	 * proxied — the same rule the browser applies, for the same reason.
	 */
	it('refuses a routed account on a partially direct route', async () => {
		for (const route of ['steam-only', 'direct'] as const) {
			const { confirmations, routes } = harness(routed);
			await expect(confirmations.signIn('76561198000000001', 'a-password', route)).rejects.toThrow(
				/require proxies/i
			);
			expect(routes).toEqual([]);
		}
	});

	it('allows a routed account on the fully proxied route', async () => {
		const { confirmations, routes } = harness(routed);
		await confirmations.signIn('76561198000000001', 'a-password', 'proxy');
		expect(routes).toEqual(['http://10.0.0.9:8080']);
	});

	it('allows the default route, which is the fully proxied one', async () => {
		const { confirmations, routes } = harness(routed);
		await confirmations.signIn('76561198000000001', 'a-password');
		expect(routes).toEqual(['http://10.0.0.9:8080']);
	});

	it('changes nothing when the setting is off', async () => {
		const { confirmations, routes } = harness(unrouted, false);
		await confirmations.signIn('76561198000000001', 'a-password');
		expect(routes).toEqual([undefined]);
	});
});

/**
 * **Turning the rule on has to stop the password already on the wire.**
 *
 * The guard in `signIn` refuses new attempts. One already talking to Steam was
 * untouched, so a password kept travelling unrouted from a vault that had just
 * been told never to allow that — and the switch reported success.
 */
describe('cancelling unrouted sign-ins when the policy changes', () => {
	function harness(stored: Account[]) {
		const cancelled: string[] = [];
		/** Why each cancellation said it happened. */
		const reasons: (string | undefined)[] = [];
		const { transports } = fakeNetwork();
		const confirmations = new ConfirmationsService(fakeVault(stored), transports, {
			now: () => NOW,
			signIn: (request: unknown, _proxyUrl, _a, _b, onCancel?: (cancel: () => void) => void) => {
				const name = (request as { accountName: string }).accountName;
				onCancel?.((reason?: string) => {
					cancelled.push(name);
					reasons.push(reason);
				});
				// Never settles: the point is what happens to it mid-flight.
				return new Promise(() => undefined);
			}
		});
		return { confirmations, cancelled, reasons };
	}

	const unrouted = account({ steamId64: '76561198000000001', accountName: 'plain' });
	const routed = account({
		steamId64: '76561198000000002',
		accountName: 'routed',
		proxyUrl: 'http://10.0.0.9:8080'
	});

	it('cancels a sign-in for an account with no proxy', async () => {
		const { confirmations, cancelled } = harness([unrouted]);
		void confirmations.signIn('76561198000000001', 'a-password');
		await Promise.resolve();

		confirmations.cancelUnroutedSignIns();

		expect(cancelled, 'the password kept going after the rule was turned on').toEqual(['plain']);
	});

	/*
	 * And leaves the proxied one alone. A sign-in through the account's own proxy
	 * satisfies the new rule; cancelling it would make enabling the setting
	 * destroy exactly the work it exists to protect.
	 */
	it('leaves a sign-in that is already routed running', async () => {
		const { confirmations, cancelled } = harness([routed]);
		void confirmations.signIn('76561198000000002', 'a-password');
		await Promise.resolve();

		confirmations.cancelUnroutedSignIns();

		expect(cancelled).toEqual([]);
	});

	it('sorts them when both are running', async () => {
		const { confirmations, cancelled } = harness([unrouted, routed]);
		void confirmations.signIn('76561198000000001', 'a-password');
		void confirmations.signIn('76561198000000002', 'a-password');
		await Promise.resolve();

		confirmations.cancelUnroutedSignIns();

		expect(cancelled).toEqual(['plain']);
	});

	/**
	 * **The route the sign-in is taking, not the proxy the account has stored.**
	 *
	 * These are different questions, and the first implementation asked the
	 * second. A Direct sign-in on a routed account is unrouted — the whole point
	 * of Direct is that the stored proxy is skipped — so consulting the vault
	 * found a proxy and left it running. Started before the switch was flipped
	 * (which is the only way to start one), it carried a password unrouted for
	 * as long as Steam took to answer, on a vault that by then forbade it.
	 */
	it('cancels a Direct sign-in even when the account has a proxy stored', async () => {
		const { confirmations, cancelled } = harness([routed]);
		void confirmations.signIn('76561198000000002', 'a-password', 'direct');
		await Promise.resolve();

		confirmations.cancelUnroutedSignIns();

		expect(cancelled, 'a Direct sign-in survived because the account had a proxy').toEqual([
			'routed'
		]);
	});

	/*
	 * Steam-only is a proxied route for a sign-in — `service.ts` refuses it under
	 * strict mode, but one begun beforehand did go through the proxy, so it is
	 * not what this sweep is for.
	 */
	it('cancels a Steam-only sign-in, which is not fully proxied either', async () => {
		const { confirmations, cancelled } = harness([routed]);
		void confirmations.signIn('76561198000000002', 'a-password', 'steam-only');
		await Promise.resolve();

		confirmations.cancelUnroutedSignIns();

		expect(cancelled).toEqual(['routed']);
	});

	/**
	 * **And it says why, rather than blaming the vault.**
	 *
	 * The cancellation callback in `login.ts` hard-coded "The vault locked before
	 * Steam finished signing in" — the only sentence it could produce, written
	 * when a lock was the only thing that cancelled. The policy sweep now uses
	 * the same callback, so a user who turned `Require proxies` on was told
	 * their vault had locked: an explanation that is false, and one that sends
	 * them to unlock a vault that is already open.
	 */
	it('tells the user the policy stopped it, not that the vault locked', async () => {
		const { confirmations, reasons } = harness([unrouted]);
		void confirmations.signIn('76561198000000001', 'a-password');
		await Promise.resolve();

		confirmations.cancelUnroutedSignIns();

		expect(reasons[0], 'the user was told the wrong thing').toMatch(/require proxies/i);
		expect(reasons[0]).not.toMatch(/vault locked/i);
	});

	it('does nothing when no sign-in is running', () => {
		const { confirmations, cancelled } = harness([unrouted]);
		expect(() => confirmations.cancelUnroutedSignIns()).not.toThrow();
		expect(cancelled).toEqual([]);
	});
});
