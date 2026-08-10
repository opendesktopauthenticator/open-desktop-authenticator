import type { Agent } from 'node:http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import Request from 'request';
import Stdlib from '@doctormckay/stdlib';
import { registerSecret } from './redact';

/**
 * Per-account proxy routing.
 *
 * NOT in the master plan — added at founder request. See docs/PHASE0_FINDINGS.md
 * F-08 for the positioning and threat-model issues this opens up, and §23 Q11.
 *
 * The correctness hazard this module exists to prevent:
 *
 *   `steam-session` supports httpProxy/socksProxy natively.
 *   `steamcommunity` supports NEITHER — only `localAddress`, or a `request`
 *   instance you pre-configure yourself.
 *
 * Wire up only the first one and you get a tool that proxies the login and then
 * fetches confirmations from the real IP. That is worse than no proxy support at
 * all, because the user believes they are covered. So: this module builds BOTH
 * transports from one config, and `assertBothTransportsProxied` fails closed if
 * either is missing.
 */

export type ProxyScheme = 'http' | 'https' | 'socks' | 'socks4' | 'socks5' | 'socks5h';

const SUPPORTED: ProxyScheme[] = ['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h'];

export interface ProxyConfig {
	/** Full URL including credentials. Registered as a secret on parse. */
	url: string;
	scheme: ProxyScheme;
	host: string;
	port: number;
	hasCredentials: boolean;
	/** Safe to print: credentials stripped. */
	display: string;
	isSocks: boolean;
}

export class ProxyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProxyError';
	}
}

/**
 * Register a credential in both its percent-encoded and decoded forms.
 *
 * Whichever one a library or an error message happens to print, the redaction
 * wrapper has to know about it.
 */
function registerBothForms(value: string): void {
	if (!value) {
		return;
	}
	registerSecret(value, { force: true });
	try {
		const decoded = decodeURIComponent(value);
		if (decoded !== value) {
			registerSecret(decoded, { force: true });
		}
	} catch {
		// Malformed escape sequence; the raw form is already registered.
	}
}

export function parseProxy(raw: string): ProxyConfig {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ProxyError(
			`could not parse "${raw}" as a proxy URL. ` +
				'Expected something like http://user:pass@host:8080 or socks5://user:pass@host:1080'
		);
	}

	const scheme = parsed.protocol.replace(':', '') as ProxyScheme;
	if (!SUPPORTED.includes(scheme)) {
		throw new ProxyError(
			`unsupported proxy scheme "${scheme}". Supported: ${SUPPORTED.join(', ')}.`
		);
	}

	if (!parsed.hostname) {
		throw new ProxyError('proxy URL has no host.');
	}

	const port = parsed.port ? Number(parsed.port) : scheme.startsWith('socks') ? 1080 : 8080;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ProxyError(`proxy port "${parsed.port}" is not a valid port number.`);
	}

	const hasCredentials = Boolean(parsed.username || parsed.password);

	// Proxy credentials are secrets (§11 S4). Register the whole URL only when it
	// actually carries credentials — for a bare host:port URL the full string is
	// identical to the display string, and registering it would scrub the proxy
	// out of our own status output.
	if (hasCredentials) {
		registerSecret(raw, { force: true });
		// `URL.password` and `URL.username` are returned still percent-encoded:
		// `p%40sswordX` for `p@sswordX`. Registering only that form leaves the
		// decoded one — which is what a library or an error message actually
		// prints — unscrubbed.
		registerBothForms(parsed.password);
		// Same dual registration as the password: `URL.username` is also returned
		// percent-encoded, so registering only that leaves `user@name` unscrubbed
		// for `user%40name`.
		registerBothForms(parsed.username);
	}

	return {
		url: raw,
		scheme,
		host: parsed.hostname,
		port,
		hasCredentials,
		display: `${scheme}://${hasCredentials ? '<credentials>@' : ''}${parsed.hostname}:${port}`,
		isSocks: scheme.startsWith('socks')
	};
}

/**
 * Resolve the proxy for an account, if any.
 * Per-account setting wins over the global one, so a multi-account run can route
 * each account differently — which is the entire point of the feature.
 */
export function proxyForAccount(
	accountName: string,
	fromMaFile?: string | undefined
): ProxyConfig | undefined {
	const perAccountKey = `SPIKE_PROXY_${accountName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	// Env wins over the file, so a proxy can be overridden without editing secrets.
	const raw = process.env[perAccountKey] ?? process.env.SPIKE_PROXY ?? fromMaFile;
	if (!raw || raw.trim() === '') {
		return undefined;
	}
	return parseProxy(raw.trim());
}

/**
 * Options handed to `new LoginSession(platformType, options)`.
 *
 * Typed rather than `Record<string, unknown>` so a mistyped key is a compile
 * error instead of a silently-ignored option — steam-session would accept
 * `{ agnet: ... }` and quietly connect direct.
 */
export interface LoginTransportOptions {
	agent?: Agent;
}

/**
 * We pass `agent` rather than `socksProxy`/`httpProxy` so steam-session uses the
 * same instance as everything else. Its options are mutually exclusive, so this
 * is one or the other regardless.
 */
export function loginSessionOptions(agents: ProxyAgents | undefined): LoginTransportOptions {
	return agents ? { agent: agents.https } : {};
}

export interface ProxyAgents {
	http: Agent;
	https: Agent;
}

/**
 * Build the ONE agent pair the whole process routes through.
 *
 * Everything — steam-session, steamcommunity, and the bare `https.request` calls
 * buried inside steam-totp — is pointed at these exact instances. That identity
 * is what lets the egress guard tell "went through our proxy" apart from "used
 * some other agent that may or may not be proxied".
 *
 * We deliberately do NOT use `request`'s own `proxy` option: it constructs its
 * own tunnelling agent internally, which would be indistinguishable from a leak.
 */
export function createAgents(proxy: ProxyConfig): ProxyAgents {
	if (proxy.isSocks) {
		// SocksProxyAgent handles both http and https targets, so one instance
		// covers everything.
		const agent = new SocksProxyAgent(proxy.url) as unknown as Agent;
		return { http: agent, https: agent };
	}

	// McKay's stdlib is what steam-session itself uses for httpProxy support, so
	// this is the same code path — no new package, same behaviour.
	return {
		http: Stdlib.HTTP.getProxyAgent(false, proxy.url) as Agent,
		https: Stdlib.HTTP.getProxyAgent(true, proxy.url) as Agent
	};
}

/** A `request` instance plus an honest statement of whether it is proxied. */
export interface CommunityTransport {
	instance: unknown;
	/** How the proxy was applied, or null if this transport is unproxied. */
	appliedVia: 'shared-agent' | null;
}

/**
 * Build the `request` instance steamcommunity will use.
 *
 * `pool: false` because `forever: true` would install request's own keep-alive
 * agent and replace ours.
 */
export function communityRequest(agents: ProxyAgents | undefined): CommunityTransport {
	if (!agents) {
		return { instance: Request.defaults({ forever: true }), appliedVia: null };
	}
	return {
		instance: Request.defaults({ agent: agents.https, pool: false }),
		appliedVia: 'shared-agent'
	};
}

/**
 * Fail closed (§0.4).
 *
 * If a proxy was configured but either transport reports itself unproxied, we
 * refuse to touch Steam rather than leak the real IP from half the requests.
 * This is a genuine check on what the builders actually did, not a formality —
 * it is what catches a future edit that adds a code path returning
 * `appliedVia: null` while a proxy is set.
 */
export function assertBothTransportsProxied(
	proxy: ProxyConfig | undefined,
	loginOptions: LoginTransportOptions,
	community: CommunityTransport
): void {
	if (!proxy) {
		return;
	}

	const unproxied: string[] = [];
	if (!loginOptions.agent) {
		unproxied.push('the login transport (steam-session)');
	}
	if (community.appliedVia === null) {
		unproxied.push('the confirmation transport (steamcommunity)');
	}

	if (unproxied.length > 0) {
		throw new ProxyError(
			`proxy ${proxy.display} was configured but is not applied to ${unproxied.join(' and ')}. ` +
				'Refusing to continue — a half-proxied session sends your real IP on every request ' +
				'the proxy does not cover, which is worse than running with no proxy at all.'
		);
	}
}
