import { describe, expect, it } from 'vitest';
import { ConfirmationsError, ConfirmationsService } from '../src/main/confirmations/service';
import { SteamLoginError } from '../src/main/steam/login';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

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
		autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
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
		account({ autoConfirm: { marketListings: true, trades: true, pollIntervalSeconds: 15 } });

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
