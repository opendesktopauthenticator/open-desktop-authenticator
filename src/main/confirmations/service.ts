import { ConfirmationsClient, buildSessionCookie, type ConfirmationAccount } from './client';
import { describeType, isAutoConfirmable, isSecurityCritical } from './policy';
import type { Confirmation, ConfirmationAction } from './protocol';
import { AccessTokenError, mintAccessToken } from '../steam/access-token';
import { signIn, SteamLoginError } from '../steam/login';
import { jwtExpiry } from '../steam-jwt';
import type { VaultService } from '../vault/service';
import type { SteamTransportFactory } from '../net/transport';
import type { ConfirmationSummary } from '../../shared/ipc';

/**
 * Confirmations, joined up (§12 F5).
 *
 * This is the only place that knows how the pieces fit: the vault holds the
 * secrets, the transport factory holds the routing, `mintAccessToken` turns a
 * stored refresh token into a session, and `ConfirmationsClient` speaks
 * mobileconf. None of those knows about any of the others.
 *
 * ## The renderer never sees a nonce
 *
 * Acting on a confirmation needs its `id` **and** its `nonce`. Only the id
 * crosses to the renderer; the nonce stays here, in the list this service
 * remembers from the last fetch. So the UI can ask to approve something it was
 * shown, and cannot ask to approve something it was not — which also means a
 * stale screen fails loudly instead of acting on a confirmation the user never
 * saw.
 *
 * ## Session material is cached, and dies with the unlock
 *
 * An access token lasts hours and minting one costs a round trip, so it is kept.
 * It is also a live credential, which is why `forget` exists and why the vault's
 * lock handler calls it.
 */

interface SessionState {
	accessToken: string;
	/** Epoch ms. Re-minted before this, not after it fails. */
	expiresAtMs: number;
}

export interface ConfirmationsServiceOptions {
	/** Injected for testability. Defaults to the wall clock. */
	now?: () => number;
	/** Shared with the codes, so both sign against one notion of Steam's time. */
	timeOffsetSeconds?: () => number;
}

/** Re-mint this long before expiry rather than discovering it mid-request. */
const RENEW_MARGIN_MS = 5 * 60_000;

/** What one automatic pass did, and what it deliberately did not. */
export interface AutoConfirmOutcome {
	/**
	 * What was approved, not how many. The activity log has to be able to say
	 * *which* trade went through while nobody was looking; a count cannot.
	 */
	approved: ConfirmationSummary[];
	/** Left for a human, each with the reason S16 refused it. */
	held: { confirmation: ConfirmationSummary; reason: string }[];
}

export class ConfirmationsError extends Error {
	/** True when the user has to sign in again; nothing else will fix it. */
	readonly needsSignIn: boolean;

	constructor(message: string, needsSignIn = false) {
		super(message);
		this.name = 'ConfirmationsError';
		this.needsSignIn = needsSignIn;
	}
}

export class ConfirmationsService {
	private readonly vault: VaultService;
	private readonly transports: SteamTransportFactory;
	private readonly now: () => number;
	private readonly offset: () => number;

	private readonly sessions = new Map<string, SessionState>();
	/**
	 * steamId64 → (confirmation id → what acting on it needs), from the last fetch.
	 *
	 * One map holding both the nonce and the type, rather than two keyed the same
	 * way. Parallel maps drift, and the consequence here would be `act` seeing the
	 * wrong type — which is what decides whether S16's batch rule applies to an
	 * account-recovery confirmation.
	 */
	private readonly pending = new Map<string, Map<string, { nonce: string; type: number }>>();

	/**
	 * Bumped by `forget`. Anything in flight when that happens is discarded.
	 *
	 * Clearing the maps is not enough on its own: a `list` that was already
	 * awaiting the network writes its result back **after** it returns, and a
	 * token mint does the same. Lock the vault mid-request and the response lands
	 * a moment later, quietly restoring a MobileApp access token and a set of
	 * nonces into a session that is supposed to be over.
	 */
	private generation = 0;

	/**
	 * One operation at a time per account.
	 *
	 * `act` reads the pending list, talks to Steam, then removes what it acted on.
	 * A `list` completing in that window used to replace the map underneath it, so
	 * the removal landed on an orphan while the live map still held the nonce —
	 * and the same confirmation could be sent again. Serialising removes the
	 * window rather than trying to detect it.
	 */
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(
		vault: VaultService,
		transports: SteamTransportFactory,
		options: ConfirmationsServiceOptions = {}
	) {
		this.vault = vault;
		this.transports = transports;
		this.now = options.now ?? (() => Date.now());
		this.offset = options.timeOffsetSeconds ?? ((): number => 0);
	}

	/** Pending confirmations for one account, as the renderer may see them. */
	async list(steamId64: string): Promise<ConfirmationSummary[]> {
		// Captured here, at the call, rather than inside the queued work. Work that
		// has not started yet was still *requested* before the lock, and reading the
		// generation once it finally runs would read the value the lock already
		// changed — making the guard agree with itself and catch nothing.
		const generation = this.generation;

		return this.serialise(steamId64, async () => {
			const { account, client, cookie } = await this.connect(steamId64, generation);
			const confirmations = await client.list(account, cookie);

			// Checked *after* the await, before anything is written back. If the vault
			// locked while this was in flight, these nonces are no longer ours to keep.
			this.requireGeneration(generation);

			// Remembered so `act` can resolve an id back to its nonce and type without
			// the renderer ever holding either.
			this.pending.set(
				steamId64,
				new Map(confirmations.map((entry) => [entry.id, { nonce: entry.nonce, type: entry.type }]))
			);

			return confirmations.map(toSummary);
		});
	}

	/**
	 * Approve or deny confirmations the user selected.
	 *
	 * Ids are resolved against the last fetch. An id that is not in it means the
	 * screen is out of date — refused outright rather than partially applied,
	 * because "act on the ones I recognise" would act on a subset the user never
	 * chose.
	 */
	async act(steamId64: string, action: ConfirmationAction, ids: readonly string[]): Promise<void> {
		if (ids.length === 0) {
			throw new ConfirmationsError('nothing was selected');
		}

		const generation = this.generation;

		return this.serialise(steamId64, async () => {
			const resolved: Confirmation[] = [];
			for (const id of ids) {
				const entry = this.pending.get(steamId64)?.get(id);
				if (entry === undefined) {
					throw new ConfirmationsError('this list is out of date. Refresh it and choose again.');
				}
				// The type comes from what Steam actually sent, not from the renderer —
				// so S16's batch rule cannot be sidestepped by a caller claiming a
				// recovery confirmation is a trade.
				resolved.push({ id, nonce: entry.nonce, type: entry.type });
			}

			const { account, client, cookie } = await this.connect(steamId64, generation);
			await client.act(account, cookie, action, resolved);

			this.requireGeneration(generation);

			// Acted on, so no longer pending. Read fresh rather than held across the
			// await: a map captured beforehand could have been replaced, leaving the
			// removal to land on an orphan while the live one still held the nonce.
			const current = this.pending.get(steamId64);
			for (const id of ids) {
				current?.delete(id);
			}
		});
	}

	/**
	 * One automatic pass for an account (§12 F6, invariant S16).
	 *
	 * Fetches, then approves **only** what the policy permits — which is decided
	 * inside `ConfirmationsClient.autoConfirm`, at the boundary that sends, not
	 * here. Everything held back is returned so the caller can surface it; an
	 * account-recovery confirmation sitting unapproved is the single most urgent
	 * thing this application can show anybody, and a poller that silently dropped
	 * it would be worse than no poller.
	 *
	 * Goes through the same queue and generation guard as everything else, so a
	 * timer firing during a manual action, or during a lock, cannot interleave.
	 */
	async runAutoConfirm(steamId64: string): Promise<AutoConfirmOutcome> {
		const generation = this.generation;

		return this.serialise(steamId64, async () => {
			const { account, client, cookie } = await this.connect(steamId64, generation);

			// Nothing enabled means nothing to do, and no reason to have asked Steam.
			if (!account.autoConfirm.marketListings && !account.autoConfirm.trades) {
				return { approved: [], held: [] };
			}

			const confirmations = await client.list(account, cookie);
			this.requireGeneration(generation);

			const { approved, held } = await client.autoConfirm(account, cookie, confirmations);
			this.requireGeneration(generation);

			// The full list is remembered so the UI can act on what was held back
			// without fetching again, minus anything just approved.
			const remaining = new Map(
				confirmations
					.filter((entry) => !approved.some((done) => done.id === entry.id))
					.map((entry) => [entry.id, { nonce: entry.nonce, type: entry.type }])
			);
			this.pending.set(steamId64, remaining);

			return {
				approved: approved.map(toSummary),
				held: held.map((entry) => ({
					confirmation: toSummary(entry.confirmation),
					reason: entry.reason
				}))
			};
		});
	}

	/**
	 * Exchange a password for a saved Steam session (§12 F3).
	 *
	 * The password is used inside this call and dropped. What is kept is the
	 * MobileApp refresh token, which lasts months and is what every later request
	 * is built from — so this runs once per account, not once per session, and
	 * never again unless the token expires or the routing changes.
	 *
	 * The access token that comes back is kept **in memory only**. It expires in
	 * hours and re-minting it costs one request, so writing a short-lived
	 * credential to disk would add exposure and buy a saved round trip after a
	 * restart.
	 */
	async signIn(steamId64: string, password: string): Promise<void> {
		const generation = this.generation;

		return this.serialise(steamId64, async () => {
			const stored = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
			if (!stored) {
				throw new ConfirmationsError('no such account in this vault');
			}

			// No transport is built here. `steam-session` speaks to Steam over Node's
			// own HTTP stack, so it takes the proxy URL directly and authenticates to
			// the proxy itself — the Electron transport is for confirmations, which
			// are still ours.
			let result;
			try {
				result = await signIn(
					{
						accountName: stored.accountName,
						password,
						sharedSecret: stored.sharedSecret,
						unixSeconds: Math.floor(this.now() / 1000) + this.offset()
					},
					stored.proxyUrl
				);
			} catch (err) {
				throw err instanceof SteamLoginError ? new ConfirmationsError(err.message, true) : err;
			}

			this.requireGeneration(generation);

			await this.vault.mutate((draft) => {
				const account = draft.accounts.find((entry) => entry.steamId64 === steamId64);
				if (!account) {
					throw new ConfirmationsError('no such account in this vault');
				}
				account.refreshToken = result.refreshToken;
			});

			if (result.accessToken) {
				this.sessions.set(steamId64, {
					accessToken: result.accessToken,
					expiresAtMs: jwtExpiry(result.accessToken)?.getTime() ?? this.now() + 15 * 60_000
				});
			}
		});
	}

	/**
	 * Drop one account's cached session and pending list.
	 *
	 * Called when its routing changes. The stored refresh token is discarded at
	 * the same moment by `applyProxyChange`; this is the in-memory half, and
	 * leaving it would let the old session keep working over the new route.
	 */
	forgetAccount(steamId64: string): void {
		this.sessions.delete(steamId64);
		this.pending.delete(steamId64);
	}

	/** Drop cached sessions and lists. Called when the vault locks. */
	forget(): void {
		// Bumped first, so anything already awaiting the network is refused when it
		// tries to write its result back rather than repopulating what was cleared.
		this.generation++;
		this.sessions.clear();
		this.pending.clear();
	}

	/**
	 * Run `work` after anything already queued for this account.
	 *
	 * Per account rather than globally: two accounts have nothing to serialise
	 * against each other, and making them wait would turn one slow proxy into a
	 * stall for everybody.
	 */
	private serialise<T>(steamId64: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(steamId64) ?? Promise.resolve();
		// The predecessor's failure is its caller's problem, not a reason to skip
		// this one — hence swallowing it here and only here.
		const next = previous.then(work, work);
		this.queues.set(
			steamId64,
			next.then(
				() => undefined,
				() => undefined
			)
		);
		return next;
	}

	/** Refuse to keep anything produced before a lock. */
	private requireGeneration(generation: number): void {
		if (this.generation !== generation) {
			throw new ConfirmationsError(
				'the vault locked while this was loading. Unlock and try again.'
			);
		}
	}

	/** The account, a routed client, and a live session cookie. */
	private async connect(
		steamId64: string,
		generation: number
	): Promise<{
		account: ConfirmationAccount;
		client: ConfirmationsClient;
		cookie: string;
	}> {
		const stored = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
		if (!stored) {
			throw new ConfirmationsError('no such account in this vault');
		}

		const transport = await this.transports.forAccount({
			steamId64: stored.steamId64,
			proxyUrl: stored.proxyUrl
		});

		const accessToken = await this.accessTokenFor(
			stored.steamId64,
			stored.refreshToken,
			transport,
			generation
		);

		return {
			account: {
				steamId64: stored.steamId64,
				identitySecret: stored.identitySecret,
				autoConfirm: {
					marketListings: stored.autoConfirm.marketListings,
					trades: stored.autoConfirm.trades
				}
			},
			client: new ConfirmationsClient({
				transport,
				now: this.now,
				timeOffsetSeconds: this.offset
			}),
			cookie: buildSessionCookie(stored.steamId64, accessToken)
		};
	}

	private async accessTokenFor(
		steamId64: string,
		refreshToken: string | undefined,
		transport: Awaited<ReturnType<SteamTransportFactory['forAccount']>>,
		generation: number
	): Promise<string> {
		const cached = this.sessions.get(steamId64);
		if (cached && cached.expiresAtMs - RENEW_MARGIN_MS > this.now()) {
			return cached.accessToken;
		}

		if (refreshToken === undefined) {
			throw new ConfirmationsError(
				'this account has no saved Steam session. Sign in to use confirmations.',
				true
			);
		}

		let accessToken: string;
		try {
			accessToken = await mintAccessToken(transport, steamId64, refreshToken, this.now());
		} catch (err) {
			if (err instanceof AccessTokenError) {
				throw new ConfirmationsError(err.message, err.needsSignIn);
			}
			throw err;
		}

		// A mint is a network round trip, so the vault may have locked during it.
		// Caching the token now would put a live Steam credential back into a
		// session that has already ended.
		this.requireGeneration(generation);

		// The token says when it expires; trusting it beats guessing an hour.
		const expiry = jwtExpiry(accessToken);
		this.sessions.set(steamId64, {
			accessToken,
			expiresAtMs: expiry?.getTime() ?? this.now() + 15 * 60_000
		});

		return accessToken;
	}
}

/**
 * A confirmation as the renderer may see it.
 *
 * No nonce — that is the credential half of acting on one, and the UI has no use
 * for it. `typeName` is **ours**, from S16's table, rather than the label Steam
 * sent: a name the server controls is a name an attacker can choose.
 */
function toSummary(confirmation: Confirmation): ConfirmationSummary {
	const summary: ConfirmationSummary = {
		id: confirmation.id,
		type: confirmation.type,
		typeName: describeType(confirmation.type),
		securityCritical: isSecurityCritical(confirmation.type),
		autoConfirmable: isAutoConfirmable(confirmation.type),
		// The boolean, never the URL. See `icon` in protocol.ts: handing the
		// renderer a Steam CDN address invites an unproxied request from the one
		// process that must not make them.
		hasIcon: typeof confirmation.icon === 'string' && confirmation.icon.length > 0
	};
	if (confirmation.headline !== undefined) summary.headline = confirmation.headline;
	if (confirmation.summary !== undefined) summary.summary = confirmation.summary;
	if (confirmation.creator_id !== undefined) summary.creatorId = confirmation.creator_id;
	if (confirmation.type_name !== undefined) summary.steamTypeName = confirmation.type_name;
	if (confirmation.multi !== undefined) summary.multi = confirmation.multi;

	// Normalised to milliseconds here rather than in the renderer, which has no
	// business knowing that Steam sends seconds — sometimes as a string.
	const created =
		typeof confirmation.creation_time === 'string'
			? Number.parseInt(confirmation.creation_time, 10)
			: confirmation.creation_time;
	if (created !== undefined && Number.isFinite(created) && created > 0) {
		summary.createdAtMs = created * 1000;
	}

	return summary;
}
