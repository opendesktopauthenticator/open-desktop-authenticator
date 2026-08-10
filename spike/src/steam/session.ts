import { createInterface } from 'node:readline';
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from 'steam-session';
import SteamCommunity from 'steamcommunity';
import * as SteamTotp from 'steam-totp';
import { log, mask, registerSecret } from '../redact';
import { jwtAudience, jwtExpiry, type ParsedMaFile } from '../mafile';
import {
	assertBothTransportsProxied,
	communityRequest,
	createAgents,
	loginSessionOptions,
	proxyForAccount,
	type LoginTransportOptions,
	type ProxyAgents,
	type ProxyConfig
} from '../proxy';
import { installEgressGuard } from '../egress';
import { persistTokens, reportWriteBack } from '../writeback';

/**
 * Set once per process by initNetworking(), then used by every transport so they
 * all share one agent instance (see proxy.ts and egress.ts).
 */
let activeProxy: ProxyConfig | undefined;
let activeAgents: ProxyAgents | undefined;
/** Distinct from `activeAgents`, which is legitimately undefined with no proxy. */
let networkingInitialised = false;

/**
 * Resolve routing for an account and lock the process onto it.
 *
 * MUST be called before anything touches the network — including the time sync,
 * which is the very first outbound request most commands make. Everything here
 * happens before any credential is typed, so a misconfiguration costs nothing.
 */
export function initNetworking(
	accountName: string,
	proxyFromMaFile?: string | undefined
): ProxyConfig | undefined {
	const requested = proxyForAccount(accountName, proxyFromMaFile);

	// The egress guard installs once per process and stays pinned to the agents it
	// was given. Re-initialising with different routing would leave the guard
	// pointing at the FIRST account's proxy while the transports use the second's
	// — and if the second account has no proxy at all, its traffic would silently
	// exit through the first account's proxy, linking the two accounts through a
	// shared IP. That is the exact outcome per-account routing exists to prevent,
	// so it is refused rather than risked.
	//
	// One account per process is the spike's model. Phase 1 needs a real answer
	// (Q14: worker-per-account, or owning the last mile).
	if (networkingInitialised) {
		const before = activeProxy?.url;
		const after = requested?.url;
		if (before !== after) {
			throw new Error(
				'networking is already initialised for different routing, and the egress guard ' +
					'cannot be re-pointed within a process. Run one account per invocation.'
			);
		}
		return activeProxy;
	}

	activeProxy = requested;
	activeAgents = activeProxy ? createAgents(activeProxy) : undefined;

	const loginOptions = loginSessionOptions(activeAgents);
	assertBothTransportsProxied(activeProxy, loginOptions, communityRequest(activeAgents));

	// Catches the bare https.request calls inside steam-totp — and inside the
	// steamcommunity functions that call it internally.
	//
	// The proxy's own host is bypassed: an HTTP proxy agent builds its tunnel by
	// making a request to the proxy, and routing that through the proxy agent
	// recurses until the stack blows.
	installEgressGuard(activeAgents, activeProxy ? { bypassHosts: [activeProxy.host] } : {});

	networkingInitialised = true;

	if (activeProxy) {
		log.info(`  routing all Steam traffic via ${activeProxy.display}`);
	}

	return activeProxy;
}

export function activeProxyConfig(): ProxyConfig | undefined {
	return activeProxy;
}

/**
 * The one place the spike talks to Steam's auth layer.
 *
 * Phase 1 turns this into `/src/main/steam/` (§10.4) — a single thin module so a
 * Valve change or a McKay-library API change is a one-module fix. Keeping that
 * shape here means the spike's findings transfer directly.
 *
 * Session handling: a successful login writes its refreshed tokens back into the
 * source maFile (see writeback.ts), so the password is needed only once the
 * refresh token expires.
 *
 * The spike creates no store of its own — the only file it ever writes is one the
 * user pointed it at, which already holds the same secrets. That is a weaker
 * claim than "writes nothing", and it is the accurate one. Proper refresh-token
 * storage is a vault concern (F1/§10.3).
 */

const LOGIN_TIMEOUT_MS = 90_000;

/** Cached for the process lifetime; Phase 1 re-syncs every 6 hours (§10.4). */
let cachedTimeOffset: number | undefined;

/** Coalesces concurrent first calls so one process makes one time request. */
let timeOffsetInFlight: Promise<number> | undefined;

export async function getTimeOffset(): Promise<number> {
	if (cachedTimeOffset !== undefined) {
		return cachedTimeOffset;
	}
	if (timeOffsetInFlight) {
		return timeOffsetInFlight;
	}

	timeOffsetInFlight = new Promise<number>((resolve) => {
		SteamTotp.getTimeOffset((err, offset, latency) => {
			// The cache is populated before the in-flight slot is released, so the
			// two are never observably out of step. (Not a live bug — JavaScript is
			// single-threaded and nothing can run between those two statements — but
			// ordering them this way makes the invariant self-evident rather than
			// something a reader has to derive.)
			if (err) {
				timeOffsetInFlight = undefined;
				// Deliberately NOT cached. Caching a failed sync as 0 would make one
				// transient network blip permanently disable clock correction for the
				// rest of the process — a skewed machine would then emit wrong codes
				// indefinitely, with the warning shown only once.
				log.warn(
					`could not reach Steam's time endpoint (${err.message}); using the local clock ` +
						'for this call and retrying on the next one. Codes will be wrong if this machine ' +
						'is more than ~30s off.'
				);
				resolve(0);
				return;
			}
			cachedTimeOffset = offset;
			timeOffsetInFlight = undefined;
			log.info(`  time offset vs Steam: ${offset}s (round-trip ${latency}ms)`);
			resolve(offset);
		});
	});

	return timeOffsetInFlight;
}

export async function generateCode(sharedSecret: string): Promise<string> {
	const offset = await getTimeOffset();
	return SteamTotp.generateAuthCode(sharedSecret, offset);
}

/** Seconds remaining in the current 30-second Steam Guard window. */
export async function secondsRemaining(): Promise<number> {
	const offset = await getTimeOffset();
	return 30 - (SteamTotp.time(offset) % 30);
}

function promptHidden(question: string): Promise<string> {
	if (!process.stdin.isTTY) {
		throw new Error(
			'stdin is not a terminal, so the password cannot be prompted for securely. ' +
				'Set SPIKE_STEAM_PASSWORD in your gitignored .env instead.'
		);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	// Print the prompt, then swallow the echo of everything typed after it.
	const internals = rl as unknown as {
		_writeToOutput?: (s: string) => void;
		output: NodeJS.WriteStream;
	};

	// `_writeToOutput` is a private readline hook and there is no public API for
	// hidden input. If a Node upgrade removes it, the failure mode would be the
	// password echoing to the screen — so refuse outright rather than risk that.
	if (typeof internals._writeToOutput !== 'function') {
		rl.close();
		throw new Error(
			'this Node build does not expose the readline hook used to hide typed input, and echoing ' +
				'a password is not an acceptable fallback. Set SPIKE_STEAM_PASSWORD in your gitignored ' +
				'.env instead.'
		);
	}

	const originalWrite = internals._writeToOutput.bind(rl);
	let muted = false;
	internals._writeToOutput = (s: string) => {
		if (!muted) {
			originalWrite(s);
		}
	};

	return new Promise<string>((resolve) => {
		rl.question(question, (answer) => {
			process.stdout.write('\n');
			rl.close();
			resolve(answer);
		});
		muted = true;
	});
}

/**
 * Find the password for an account (§11 S8: used in memory, then dropped).
 *
 * Order: per-account env var, then generic env var, then interactive prompt.
 * The prompt is the default because a password that is never written down
 * cannot leak from a file.
 */
async function getPassword(accountName: string): Promise<string> {
	const perAccountKey = `SPIKE_PASSWORD_${accountName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	const fromEnv = process.env[perAccountKey] ?? process.env.SPIKE_STEAM_PASSWORD;
	if (fromEnv) {
		log.info(
			`  using password from ${process.env[perAccountKey] ? perAccountKey : 'SPIKE_STEAM_PASSWORD'}`
		);
		// Forced for the same reason as the prompted path: a short password is still
		// a password, and the default 8-character floor would let it through.
		registerSecret(fromEnv, { force: true });
		return fromEnv;
	}
	const typed = await promptHidden(`  password for ${accountName} (not echoed, not stored): `);
	// Forced: a short password is still a password, and the default threshold
	// would let it through unscrubbed.
	registerSecret(typed, { force: true });
	return typed;
}

export interface AuthenticatedSession {
	session: LoginSession;
	steamId64: string;
	accountName: string;
	refreshToken: string;
}

/**
 * Establish a session from a stored refresh token — no password, no TOTP step.
 *
 * This is the path the real app takes on every launch after the first login
 * (§10.4). Note it therefore does NOT exercise the credentials + Steam Guard
 * handshake, so it cannot answer finding F-07.
 */
async function loginWithRefreshToken(
	account: ParsedMaFile,
	refreshToken: string,
	loginOptions: LoginTransportOptions
): Promise<AuthenticatedSession> {
	registerSecret(refreshToken);

	// Cast is unavoidable and safe: a proxy agent subclasses http.Agent and
	// handles CONNECT for https targets, but is not nominally an https.Agent.
	// steam-session only ever uses the http.Agent surface of it.
	const session = new LoginSession(
		EAuthTokenPlatformType.MobileApp,
		// Cast is unavoidable and safe: a proxy agent subclasses http.Agent and
		// handles CONNECT for https targets, but is not nominally an https.Agent.
		// steam-session only uses the http.Agent surface of it. Derived from the
		// constructor rather than importing from the package's dist internals.
		loginOptions as ConstructorParameters<typeof LoginSession>[1]
	);
	// steamID is populated as soon as a well-formed refresh token is assigned.
	session.refreshToken = refreshToken;

	log.info('  using the refresh token from the maFile (no password needed)');
	await session.refreshAccessToken();
	registerSecret(session.accessToken);

	const steamId64 = session.steamID.getSteamID64();
	if (account.steamId64 && account.steamId64 !== steamId64) {
		log.warn(
			`the maFile claims SteamID ${account.steamId64} but the token belongs to ${steamId64}.`
		);
	}

	return { session, steamId64, accountName: account.accountName, refreshToken };
}

/**
 * Log in with account name + password + a TOTP code derived from the maFile.
 *
 * Because we hold the shared_secret, the Steam Guard step is satisfied without
 * any human interaction — which is exactly the loop Phase 0 exists to prove.
 */
export async function login(account: ParsedMaFile): Promise<AuthenticatedSession> {
	// Commands call initNetworking first; this keeps login() correct when called
	// on its own. Testing activeAgents would not work — it is legitimately
	// undefined when no proxy is configured.
	if (!networkingInitialised) {
		initNetworking(account.accountName, account.proxy);
	}
	const loginOptions = loginSessionOptions(activeAgents);

	// A live refresh token means we never touch the password at all — strictly
	// better than prompting for one (§11 S8), and it is what the real app does
	// after first login (§10.4).
	if (account.refreshToken && !process.env.SPIKE_FORCE_PASSWORD) {
		const expiry = jwtExpiry(account.refreshToken);
		if (expiry && expiry.getTime() > Date.now()) {
			return loginWithRefreshToken(account, account.refreshToken, loginOptions);
		}
		log.warn('stored refresh token is expired; falling back to a password login.');
	}

	const password = await getPassword(account.accountName);
	const steamGuardCode = await generateCode(account.sharedSecret);

	// Cast is unavoidable and safe: a proxy agent subclasses http.Agent and
	// handles CONNECT for https targets, but is not nominally an https.Agent.
	// steam-session only ever uses the http.Agent surface of it.
	const session = new LoginSession(
		EAuthTokenPlatformType.MobileApp,
		// Cast is unavoidable and safe: a proxy agent subclasses http.Agent and
		// handles CONNECT for https targets, but is not nominally an https.Agent.
		// steam-session only uses the http.Agent surface of it. Derived from the
		// constructor rather than importing from the package's dist internals.
		loginOptions as ConstructorParameters<typeof LoginSession>[1]
	);
	session.loginTimeout = LOGIN_TIMEOUT_MS;

	const authenticated = new Promise<void>((resolve, reject) => {
		session.on('authenticated', () => resolve());
		session.on('error', (err: Error) => reject(err));
		session.on('timeout', () =>
			reject(new Error('login timed out waiting for Steam to confirm the session'))
		);
	});
	// Mark it handled up front. If we bail out below without awaiting it (the
	// F-07 path), a later 'error' or 'timeout' would otherwise surface as an
	// unhandled rejection and bury the real error. Awaiting it later still
	// receives the rejection normally.
	authenticated.catch(() => undefined);

	const start = await session.startWithCredentials({
		accountName: account.accountName,
		password,
		steamGuardCode
	});

	// Report what Steam offered regardless of outcome. This single run is what
	// settles finding F-07, so a bare "it worked" would waste it.
	const offered = (start.validActions ?? []).map(
		(a) => EAuthSessionGuardType[a.type] ?? String(a.type)
	);
	log.info(`  actionRequired : ${start.actionRequired}`);
	log.info(`  guards offered : ${offered.length > 0 ? offered.join(', ') : '(none reported)'}`);

	const deviceConfirmation = offered.includes('DeviceConfirmation');

	if (start.actionRequired) {
		// Steam wants the *official mobile app* to approve. A desktop authenticator
		// cannot do that — and a user migrating away from that app may not have it.
		// This is a finding worth recording, not a crash.
		//
		// Abandon the session cleanly so its listeners cannot fire against a login
		// attempt nobody is waiting on any more.
		session.cancelLoginAttempt();
		session.removeAllListeners();
		throw new Error(
			`F-07 CONFIRMED: Steam still requires action after a valid TOTP code was supplied. ` +
				`Guards: ${offered.join(', ') || 'unknown'}. ` +
				'MobileApp logins are not purely code-driven for this account — this needs a design ' +
				'answer before Phase 1. Record in docs/PHASE0_FINDINGS.md.'
		);
	}

	if (deviceConfirmation) {
		log.warn(
			'Steam listed DeviceConfirmation as an available guard but accepted the TOTP code ' +
				'anyway. Worth noting in F-07: the prompt exists but is not mandatory here.'
		);
	}

	await authenticated;

	const refreshToken = session.refreshToken;
	registerSecret(refreshToken);

	const steamId64 = session.steamID.getSteamID64();

	if (account.steamId64 && account.steamId64 !== steamId64) {
		log.warn(
			`the maFile claims SteamID ${account.steamId64} but Steam authenticated ${steamId64}. ` +
				'Trust the authenticated value.'
		);
	}

	return { session, steamId64, accountName: session.accountName, refreshToken };
}

/**
 * Turn an authenticated session into a steamcommunity instance that can read
 * and act on mobile confirmations.
 */
export async function communityFor(
	auth: AuthenticatedSession
): Promise<{ community: SteamCommunity; cookies: string[] }> {
	const cookies = await auth.session.getWebCookies();
	for (const cookie of cookies) {
		registerSecret(cookie);
	}

	// Same agent instance as the login, or steamcommunity dials out from the real IP.
	const transport = communityRequest(activeAgents);
	const community = new SteamCommunity({ request: transport.instance });
	community.setCookies(cookies);

	// getWebCookies() refreshes the access token internally for MobileApp, so this
	// is populated by now. steamcommunity needs it for the newer mobileconf calls.
	const accessToken = auth.session.accessToken;
	if (accessToken) {
		registerSecret(accessToken);
		community.setMobileAppAccessToken(accessToken);
	} else {
		log.warn('no access token available after getWebCookies(); confirmations may fail.');
	}

	return { community, cookies };
}

/**
 * Save whatever the session just minted back into the maFile it came from.
 *
 * This is what makes the password prompt a once-per-expiry event rather than a
 * once-per-run one: a password login yields a fresh refresh token, we store it,
 * and every later run derives an access token from it without asking.
 */
function saveSession(account: ParsedMaFile, auth: AuthenticatedSession, cookies: string[]): void {
	// Steam's web cookie is `steamLoginSecure=<steamid>||<token>`; the maFile
	// stores just the value.
	const cookie = cookies.find((c) => c.trim().startsWith('steamLoginSecure='));
	const steamLoginSecure = cookie?.split('=').slice(1).join('=').split(';')[0];

	const result = persistTokens(account.sourcePath, {
		refreshToken: auth.refreshToken,
		accessToken: auth.session.accessToken,
		steamLoginSecure
	});
	reportWriteBack(account.sourcePath, result);
}

/**
 * Why a stored web session cannot be used, or undefined if it can.
 *
 * Kept as one function so the reason reported to the user is always the real
 * one — an earlier version printed "expired" for a token that was merely
 * wrong-scoped, contradicting the warning printed immediately above it.
 */
export function storedSessionUnusableReason(accessToken: string): string | undefined {
	const expiry = jwtExpiry(accessToken);
	if (!expiry) {
		return 'the access token could not be decoded';
	}
	if (expiry.getTime() <= Date.now()) {
		return `the access token expired on ${expiry.toISOString()}`;
	}
	const audience = jwtAudience(accessToken);
	if (!audience.includes('mobile')) {
		return (
			`the access token is scoped [${audience.join(', ') || 'none'}] — mobile confirmations ` +
			'need a token scoped for `mobile` (F-13)'
		);
	}
	return undefined;
}

export interface OpenCommunityResult {
	community: SteamCommunity;
	accountName: string;
	steamId64: string;
	via: 'refresh-token' | 'stored-cookie' | 'password';
}

/**
 * Get a mobileconf-capable session by the cheapest route available.
 *
 * Order matters:
 *   1. refresh token  — robust, mints fresh cookies, survives a stale file
 *   2. stored cookie  — zero auth traffic, but dies with the token (~24h)
 *   3. password       — prompts; last resort (§11 S8)
 *
 * Some files in the wild carry a session but no refresh token, which is why
 * route 2 exists at all (F-11).
 */
export async function openCommunity(account: ParsedMaFile): Promise<OpenCommunityResult> {
	if (!networkingInitialised) {
		initNetworking(account.accountName, account.proxy);
	}

	if (account.refreshToken && !process.env.SPIKE_FORCE_PASSWORD) {
		const expiry = jwtExpiry(account.refreshToken);
		if (expiry && expiry.getTime() > Date.now()) {
			const auth = await login(account);
			const { community, cookies } = await communityFor(auth);
			// The access token is freshly minted here; persist it so the next run
			// can use the stored-session path with no auth traffic at all.
			saveSession(account, auth, cookies);
			return {
				community,
				accountName: auth.accountName,
				steamId64: auth.steamId64,
				via: 'refresh-token'
			};
		}
		log.warn(
			`the stored refresh token expired on ${expiry?.toISOString() ?? 'an undecodable date'}; ` +
				'a password login is needed to mint a new one.'
		);
	}

	if (account.steamLoginSecure && account.accessToken && !process.env.SPIKE_FORCE_PASSWORD) {
		const reason = storedSessionUnusableReason(account.accessToken);
		if (reason) {
			log.warn(`stored web session unusable: ${reason}. Falling back.`);
		} else {
			const expiry = jwtExpiry(account.accessToken);
			log.info(
				`  using the stored web session from the maFile (valid until ${expiry?.toISOString()})`
			);
			const transport = communityRequest(activeAgents);
			const community = new SteamCommunity({ request: transport.instance });
			// setCookies parses the SteamID out of the cookie value.
			community.setCookies([`steamLoginSecure=${account.steamLoginSecure}`]);
			community.setMobileAppAccessToken(account.accessToken);

			const steamId64 = community.steamID?.getSteamID64();
			if (!steamId64) {
				throw new Error('the stored cookie did not yield a SteamID; it is malformed.');
			}
			return { community, accountName: account.accountName, steamId64, via: 'stored-cookie' };
		}
	}

	const auth = await login(account);
	const { community, cookies } = await communityFor(auth);
	// The whole point of the write-back: pay the password prompt once, not once
	// per run.
	saveSession(account, auth, cookies);
	return {
		community,
		accountName: auth.accountName,
		steamId64: auth.steamId64,
		via: 'password'
	};
}

export function describeToken(token: string): string {
	// Steam tokens are JWTs; the expiry is public metadata, the signature is not.
	const parts = token.split('.');
	if (parts.length !== 3 || !parts[1]) {
		return mask(token);
	}
	try {
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
			exp?: number;
			iss?: string;
		};
		const expiry = payload.exp ? new Date(payload.exp * 1000).toISOString() : 'unknown';
		return `${mask(token)} (issuer=${payload.iss ?? '?'}, expires ${expiry})`;
	} catch {
		return mask(token);
	}
}
