import { ConfirmationsClient, buildSessionCookie, type ConfirmationAccount } from './client';
import { describeType, isAutoConfirmable, isSecurityCritical } from './policy';
import { ConfirmationProtocolError } from './protocol';
import type { Confirmation, ConfirmationAction } from './protocol';
import { AccessTokenError, mintAccessToken } from '../steam/access-token';
import { PROXY_POLICY_STOPPED, signIn, SteamLoginError } from '../steam/login';
import { isUsableMobileToken, jwtExpiry } from '../steam-jwt';
import type { VaultService } from '../vault/service';
import type { SteamTransportFactory } from '../net/transport';
import type { BrowserRoute, ConfirmationSummary } from '../../shared/ipc';

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
	/**
	 * Performs the password sign-in. Injected purely so it can be tested.
	 *
	 * Without this the whole sign-in path — including what is done with the token
	 * it returns — was reachable only by talking to Steam with a real password,
	 * which means it was not covered at all. A caching rule nobody can exercise is
	 * a caching rule nobody can prove.
	 */
	signIn?: typeof signIn;
	/**
	 * Whether the vault refuses to talk to Steam without a proxy.
	 *
	 * Needed here and not only at the transport because this one path does not
	 * use a transport: `steam-session` speaks over Node's own HTTP stack, so the
	 * factory's refusal never sees it.
	 */
	requireProxies?: () => boolean;
}

/** Re-mint this long before expiry rather than discovering it mid-request. */
const RENEW_MARGIN_MS = 5 * 60_000;

/**
 * One account's pending confirmations, as the renderer receives them.
 *
 * `unreadable` travels with the list rather than being logged and dropped: a
 * screen showing three confirmations when Steam sent five is telling the user
 * something untrue, and the two entries it cannot describe are exactly the ones
 * it has no other way to warn about.
 */
export interface ConfirmationListing {
	confirmations: ConfirmationSummary[];
	/** Entries Steam sent that this version could not read. */
	unreadable: number;
}

/** What one automatic pass did, and what it deliberately did not. */
export interface AutoConfirmOutcome {
	/**
	 * What was approved, not how many. The activity log has to be able to say
	 * *which* trade went through while nobody was looking; a count cannot.
	 */
	approved: ConfirmationSummary[];
	/** Left for a human, each with the reason S16 refused it. */
	held: { confirmation: ConfirmationSummary; reason: string }[];
	/**
	 * Entries Steam sent that this build could not read.
	 *
	 * Reported rather than dropped, and that is the whole point of it being here.
	 * When entries stopped being parsed all-or-nothing, this path started
	 * discarding the count on the reasoning that the interactive list would show
	 * it — which is exactly backwards for a pass that runs unattended. Nobody is
	 * looking at a screen during automatic confirmation, and an unreadable entry
	 * may be the account-recovery confirmation this application exists to shout
	 * about.
	 */
	unreadable: number;
}

export class ConfirmationsError extends Error {
	/** True when the user has to sign in again; nothing else will fix it. */
	readonly needsSignIn: boolean;

	/**
	 * True when trying the same thing again cannot possibly work.
	 *
	 * Carried from `SteamLoginError.permanent`, which classified failures for
	 * exactly this purpose and was then dropped here — every login failure became
	 * an identical retryable one, so the screen went on offering a password box
	 * for cases like "Steam wants this approved on the device that holds the
	 * authenticator", where no password will ever help.
	 */
	readonly permanent: boolean;

	constructor(message: string, needsSignIn = false, permanent = false) {
		super(message);
		this.name = 'ConfirmationsError';
		this.needsSignIn = needsSignIn;
		this.permanent = permanent;
	}
}

export class ConfirmationsService {
	private readonly vault: VaultService;
	private readonly transports: SteamTransportFactory;
	private readonly now: () => number;
	private readonly offset: () => number;
	private readonly performSignIn: typeof signIn;
	private readonly requireProxies: () => boolean;

	private readonly sessions = new Map<string, SessionState>();

	/**
	 * Sign-ins currently talking to Steam, and how to stop each one.
	 *
	 * **Refusing a result is not the same as stopping the work.** `forget` bumps
	 * the generation, so a token that arrives after a lock is thrown away — and
	 * that was the whole of it. A sign-in takes as long as Steam takes, up to the
	 * ninety-second timeout, and the vault can lock in the middle of one by the
	 * idle timer alone. Underneath, `steam-session` polls; the closure holding
	 * the user's password stays alive with it. So the account went on
	 * authenticating over its proxy, with a password in memory, for up to a
	 * minute and a half after the user had locked the vault — which is the exact
	 * shape of thing every other `forget` in this file exists to prevent.
	 */
	private readonly signingIn = new Map<
		string,
		{ cancel: (reason?: string) => void; routed: boolean }
	>();
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
	 * Per-account invalidation, bumped when *that* account's routing changes.
	 *
	 * Separate from `generation`, which is service-wide and belongs to locks.
	 * `forgetAccount` used to bump the global counter, and the cost was not "a
	 * few re-fetches": account B's auto-confirm POST could succeed on Steam's
	 * side and then be *reported as failed* because account A's proxy was saved
	 * while the reply was in the air — a false failure on an accepted,
	 * irreversible action, feeding B's backoff and the ten-strike halt.
	 */
	private readonly epochs = new Map<string, number>();

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
		this.performSignIn = options.signIn ?? signIn;
		this.requireProxies = options.requireProxies ?? (() => false);
	}

	/** Pending confirmations for one account, as the renderer may see them. */
	/**
	 * Run work that talks to Steam, translating an expired session on the way out.
	 *
	 * **Steam signals expiry with an HTTP status, and nothing was reading it.**
	 * A real 401 or 403 becomes `ConfirmationProtocolError({ kind:
	 * 'sessionExpired' })` in the client, while both consumers ask only about
	 * `ConfirmationsError.needsSignIn`. So the one condition a person can
	 * actually fix arrived as an anonymous error: the confirmations screen
	 * printed a generic message instead of the password form, and the poller
	 * counted it as an ordinary failure — backing off, and halting the account
	 * after ten of them.
	 *
	 * Translated here rather than at each call site, and rather than in the
	 * client: the client's job is to say what Steam sent, and this is the
	 * boundary where that becomes something the rest of the app acts on. It
	 * mirrors what already happens one layer down for `AccessTokenError`.
	 */
	private async translating<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (err) {
			if (err instanceof ConfirmationProtocolError && err.failure.kind === 'sessionExpired') {
				throw new ConfirmationsError(err.failure.message, true);
			}
			throw err;
		}
	}

	async list(steamId64: string): Promise<ConfirmationListing> {
		// Captured here, at the call, rather than inside the queued work. Work that
		// has not started yet was still *requested* before the lock, and reading the
		// generation once it finally runs would read the value the lock already
		// changed — making the guard agree with itself and catch nothing.
		const grant = this.grantFor(steamId64);

		return this.translating(() =>
			this.serialise(steamId64, async () => {
				const { account, client, cookie } = await this.connect(steamId64, grant);
				const { confirmations, unreadable } = await client.list(account, cookie);

				// Checked *after* the await, before anything is written back. If the vault
				// locked while this was in flight, these nonces are no longer ours to keep.
				this.requireGrant(steamId64, grant);

				// Remembered so `act` can resolve an id back to its nonce and type without
				// the renderer ever holding either.
				this.pending.set(
					steamId64,
					new Map(
						confirmations.map((entry) => [entry.id, { nonce: entry.nonce, type: entry.type }])
					)
				);

				return { confirmations: confirmations.map(toSummary), unreadable };
			})
		);
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

		const grant = this.grantFor(steamId64);

		return this.translating(() =>
			this.serialise(steamId64, async () => {
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

				const { account, client, cookie } = await this.connect(steamId64, grant);
				await client.act(account, cookie, action, resolved);

				this.requireGrant(steamId64, grant);

				// Acted on, so no longer pending. Read fresh rather than held across the
				// await: a map captured beforehand could have been replaced, leaving the
				// removal to land on an orphan while the live one still held the nonce.
				const current = this.pending.get(steamId64);
				for (const id of ids) {
					current?.delete(id);
				}
			})
		);
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
		const grant = this.grantFor(steamId64);

		return this.translating(() =>
			this.serialise(steamId64, async () => {
				const { account, client, cookie } = await this.connect(steamId64, grant);

				// Nothing enabled means nothing to do, and no reason to have asked Steam.
				if (!account.autoConfirm.marketListings && !account.autoConfirm.trades) {
					return { approved: [], held: [], unreadable: 0 };
				}

				// `unreadable` travels with the outcome. It has no `ConfirmationSummary` to
				// attach to and must not go through `onFailure`, which counts toward the
				// ten-strike halt — so the activity log gets an entry kind of its own.
				//
				// It was briefly dropped here, on the reasoning that the interactive list
				// already warns. That is the wrong way round for this path: automatic
				// confirmation is the one that runs while nobody is watching, and an entry
				// that failed to parse could be the account-recovery confirmation. Silence
				// is the one response that cannot be right.
				const { confirmations, unreadable } = await client.list(account, cookie);
				this.requireGrant(steamId64, grant);

				// **The settings are re-read here, after the await.** `connect` copied
				// them before the list request went out, and that request takes as long
				// as Steam takes — long enough for somebody to open Settings and turn
				// automatic confirmation off. Approving from the copy meant "disable"
				// did not apply to the pass already in flight: the toggle saved, the
				// screen said off, and the trade was approved anyway. Reading the vault
				// again costs nothing and makes the setting mean what it says.
				const fresh = this.vault
					.read()
					.accounts.find((entry) => entry.steamId64 === steamId64)?.autoConfirm;
				if (fresh === undefined) {
					// Removed from the vault while the list was loading. Nothing may be
					// approved for an account that no longer exists here.
					return { approved: [], held: [], unreadable };
				}
				account.autoConfirm = {
					marketListings: fresh.marketListings,
					trades: fresh.trades
				};

				const { approved, held } = await client.autoConfirm(
					account,
					cookie,
					confirmations,
					// Read from the vault each time it is asked, so the answer is the
					// setting as it stands at the moment the request goes out — not the
					// copy taken when the pass began, nor even the reread above.
					() =>
						this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64)?.autoConfirm
				);
				this.requireGrant(steamId64, grant);

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
					})),
					unreadable
				};
			})
		);
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
	async signIn(steamId64: string, password: string, route: BrowserRoute = 'proxy'): Promise<void> {
		const grant = this.grantFor(steamId64);

		return this.serialise(steamId64, async () => {
			/*
			 * **Before Steam is contacted, not only before the answer is kept.**
			 *
			 * The grant is captured at the call and checked after the sign-in
			 * returns, which refuses the *token* — and `forget` cancels attempts
			 * that are already running. Neither reaches one still sitting in this
			 * queue behind another request: it had no session to cancel, so a lock
			 * passed straight over it, and when the queue drained it went on to
			 * authenticate against Steam with a password captured before the vault
			 * closed. The result was thrown away afterwards, by which point Steam
			 * had been asked.
			 *
			 * Checked here, one line inside the queue, so work that was queued
			 * before a lock never starts after one.
			 */
			this.requireGrant(steamId64, grant);

			const stored = this.vault.read().accounts.find((entry) => entry.steamId64 === steamId64);
			if (!stored) {
				throw new ConfirmationsError('no such account in this vault');
			}

			/*
			 * **`Require proxies`, on the one Steam path that has no transport.**
			 *
			 * The IPC handler above this refuses a `route` of `direct`, and that is
			 * not enough twice over. The Confirmations screen sends no route at all,
			 * so the check saw `undefined` and passed — and the account it was
			 * signing in might have no proxy stored, in which case the route was
			 * never the thing that made it unrouted.
			 *
			 * So the stored account is what decides, and the route only adds to it.
			 * What travels on this request is a password, which makes it the worst
			 * of the paths that were unguarded.
			 */
			if (this.requireProxies() && (route !== 'proxy' || !stored.proxyUrl)) {
				throw new ConfirmationsError(
					'this vault is set to require proxies, so this account cannot sign in to Steam ' +
						'without one. Give the account a proxy, or turn off "Require proxies" in ' +
						'Settings.'
				);
			}

			// No transport is built here. `steam-session` speaks to Steam over Node's
			// own HTTP stack, so it takes the proxy URL directly and authenticates to
			// the proxy itself — the Electron transport is for confirmations, which
			// are still ours.
			let result;
			try {
				result = await this.performSignIn(
					{
						accountName: stored.accountName,
						password,
						sharedSecret: stored.sharedSecret,
						unixSeconds: Math.floor(this.now() / 1000) + this.offset()
					},
					/*
					 * The account's route, unless the caller asked for the machine's.
					 *
					 * Only the browser's *Direct* option asks, and only because the
					 * stored proxy is the thing it is trying to get past — so a re-auth
					 * that insisted on it failed at exactly the step Direct was chosen
					 * to avoid. Defaulting to `true` keeps every other caller, and
					 * every stored account, on its own routing.
					 */
					// Both proxied routes mint through the account's proxy: "Steam only"
					// still sends every Steam request that way, and a sign-in is one.
					route === 'direct' ? undefined : stored.proxyUrl,
					undefined,
					undefined,
					/*
					 * Kept only while this attempt is in the air. See `signingIn`.
					 *
					 * **With the route it is actually taking**, which is not the same
					 * question as whether the account has a proxy stored. A Direct
					 * sign-in on a routed account is unrouted, and a cancellation that
					 * consulted the vault saw the stored proxy and left it running —
					 * so turning `Require proxies` on mid-flight did nothing about the
					 * one sign-in it most needed to stop.
					 */
					(cancel) =>
						this.signingIn.set(steamId64, {
							cancel,
							routed: route === 'proxy' && !!stored.proxyUrl
						})
				);
			} catch (err) {
				throw err instanceof SteamLoginError
					? new ConfirmationsError(err.message, true, err.permanent)
					: err;
			} finally {
				this.signingIn.delete(steamId64);
			}

			this.requireGrant(steamId64, grant);

			await this.vault.mutate((draft) => {
				const account = draft.accounts.find((entry) => entry.steamId64 === steamId64);
				if (!account) {
					throw new ConfirmationsError('no such account in this vault');
				}
				account.refreshToken = result.refreshToken;
			});

			// Checked the same way the mint path checks it, which this path was not
			// doing. A truthy string is not a usable session: a web-scoped or
			// already-expired access token caches perfectly and then fails every
			// confirmation, which reads as the app being broken rather than as the
			// token being wrong (F-13). Caching nothing is strictly better — the
			// next call mints a fresh one through the path that does validate.
			if (result.accessToken && isUsableMobileToken(result.accessToken, this.now())) {
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
		// Bumped for the same reason `forget` bumps the generation, and it was
		// missing here: clearing the maps does nothing to a mint or a list already
		// awaiting the network, which happily writes its result back afterwards —
		// repopulating `sessions` with a session established over the *previous*
		// route, which is exactly the linkage a routing change exists to break.
		//
		// **Per-account, not global.** An earlier version bumped the service-wide
		// generation, and the cost was not "a few re-fetches": account B's
		// auto-confirm POST could succeed on Steam and then be reported as failed
		// because account A's proxy was saved while B's reply was in the air — a
		// false failure on an accepted, irreversible action, counted toward B's
		// ten-strike halt.
		this.epochs.set(steamId64, (this.epochs.get(steamId64) ?? 0) + 1);
		this.sessions.delete(steamId64);
		this.pending.delete(steamId64);
		// A sign-in still in the air is being authenticated over the route that
		// just stopped being this account's. Stopping it is the point.
		this.cancelSignIn(steamId64);
	}

	/** Drop cached sessions and lists. Called when the vault locks. */
	forget(): void {
		// Bumped first, so anything already awaiting the network is refused when it
		// tries to write its result back rather than repopulating what was cleared.
		this.generation++;
		this.sessions.clear();
		this.pending.clear();
		// And anything still talking to Steam is told to stop, rather than merely
		// having its answer discarded when it eventually arrives.
		for (const steamId64 of [...this.signingIn.keys()]) {
			this.cancelSignIn(steamId64);
		}
	}

	/**
	 * Abandon sign-ins that `Require proxies` has just forbidden.
	 *
	 * **Turning the rule on has to stop what is already on the wire.** The guard
	 * in `signIn` refuses new attempts; an attempt already talking to Steam was
	 * untouched, so a password kept travelling unrouted from a vault that had
	 * just been told never to allow that, and the switch reported success.
	 *
	 * Targeted rather than a `forget()`: a sign-in through the account's own
	 * proxy still satisfies the new rule, and cancelling it would make enabling
	 * the setting destroy exactly the work it exists to protect.
	 */
	cancelUnroutedSignIns(): void {
		for (const [steamId64, attempt] of [...this.signingIn]) {
			if (!attempt.routed) {
				// Named, or the user is told their vault locked — which it did not,
				// and which sends them to unlock something already open.
				this.cancelSignIn(steamId64, PROXY_POLICY_STOPPED);
			}
		}
	}

	/**
	 * Abandon a sign-in that is still running, if there is one.
	 *
	 * Swallowing is deliberate: this is called from lock handling, where every
	 * other step is synchronous and unconditional, and a library that has already
	 * finished is not a problem worth reporting to somebody who just locked their
	 * vault.
	 */
	private cancelSignIn(steamId64: string, reason?: string): void {
		const attempt = this.signingIn.get(steamId64);
		this.signingIn.delete(steamId64);
		try {
			attempt?.cancel(reason);
		} catch {
			// Already finished, or never started.
		}
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
		const tail = next.then(
			() => undefined,
			() => undefined
		);
		this.queues.set(steamId64, tail);

		// Dropped once nothing is waiting behind it. Entries were only ever added,
		// so the map kept one settled promise per SteamID the process had ever
		// touched — through account removal, re-routing and vault locks alike.
		//
		// The identity check is what makes this safe: if another operation queued
		// while this chain was still running, `queues` already holds *its* tail, and
		// deleting then would let a later call start a second chain alongside a
		// running one. `tail` swallows both outcomes, so this can never reject.
		void tail.finally(() => {
			if (this.queues.get(steamId64) === tail) {
				this.queues.delete(steamId64);
			}
		});

		// Dropped once nothing is waiting behind it. Entries were only ever added,
		// so the map kept one settled promise per SteamID the process had ever
		// touched — through account removal, re-routing and vault locks alike.
		//
		// The identity check is what makes this safe: if another operation queued
		// while this chain was still running, `queues` already holds *its* tail, and
		// deleting then would let a later call start a second chain alongside a
		// running one. `tail` swallows both outcomes, so this can never reject.

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

	/** This account's permission as it stands right now. */
	private grantFor(steamId64: string): { generation: number; epoch: number } {
		return { generation: this.generation, epoch: this.epochs.get(steamId64) ?? 0 };
	}

	/**
	 * Refuse to keep anything produced before a lock — or before *this*
	 * account's routing changed. Another account's change is not a reason.
	 */
	private requireGrant(steamId64: string, grant: { generation: number; epoch: number }): void {
		this.requireGeneration(grant.generation);
		if ((this.epochs.get(steamId64) ?? 0) !== grant.epoch) {
			throw new ConfirmationsError(
				"this account's routing changed while the request was in the air. Try again."
			);
		}
	}

	/** The account, a routed client, and a live session cookie. */
	private async connect(
		steamId64: string,
		grant: { generation: number; epoch: number }
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
			grant
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
		grant: { generation: number; epoch: number }
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

		// A mint is a network round trip, so the vault may have locked during it —
		// or this account's own routing may have changed. Caching the token now
		// would put a live Steam credential back into a session that has already
		// ended, or one established over the route the change was breaking.
		this.requireGrant(steamId64, grant);

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
