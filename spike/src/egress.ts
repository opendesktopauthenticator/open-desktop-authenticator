import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import { log } from './redact';

/**
 * Egress guard — enforce "every Steam request goes through the proxy" at the
 * socket layer instead of trusting each library to honour its own config.
 *
 * Why this exists rather than just setting proxy options everywhere:
 *
 *   `steam-totp.getTimeOffset()` calls `require('https').request({...})` with no
 *   `agent` option at all. There is no API to proxy it. Worse, `steamcommunity`
 *   calls it *internally* from `finalizeTwoFactor()` (enrollment) and
 *   `acceptConfirmationForObject()` — so a config-only approach leaves holes
 *   inside library functions we do not control.
 *
 * Since `http(s).request` falls back to the module's global agent when none is
 * given, patching the module entry point catches every one of those calls,
 * including the ones buried inside dependencies.
 *
 * It also records what actually went out, so "all traffic was proxied" is a
 * statement we can verify rather than assert.
 */

export interface EgressRecord {
	host: string;
	protocol: 'http:' | 'https:';
	proxied: boolean;
	/** Set when a request supplied an agent that was not ours. */
	foreignAgent: boolean;
	/** The connection TO the proxy itself, i.e. the tunnel rather than traffic in it. */
	proxyLeg: boolean;
}

export interface EgressTotals {
	total: number;
	proxied: number;
	foreign: number;
	leg: number;
}

/**
 * Detail is capped; totals are not.
 *
 * The audit needs exact counts, but keeping every record forever is a leak: a
 * Phase 1 auto-confirm poller runs for days at one request per 15 seconds and
 * would accumulate records until the process died. So counts are aggregated per
 * host and only the most recent slice is kept for inspection.
 */
const MAX_DETAIL_RECORDS = 1000;
const records: EgressRecord[] = [];
const totals = new Map<string, EgressTotals>();
let installed = false;
let expectedHttpAgent: Agent | undefined;
let expectedHttpsAgent: Agent | undefined;
let strict = false;
/**
 * Hosts that must NOT be routed through the proxy agent, because reaching them
 * IS how the proxy agent works.
 *
 * An HTTP proxy agent establishes its tunnel by issuing its own request to the
 * proxy host. With the guard installed that request would be handed the proxy
 * agent again, which would issue another request, forever — a real stack
 * overflow, not a theoretical one. SOCKS agents open a raw socket and never hit
 * this, which is why the bug only appears on the HTTP path.
 */
let bypassHosts = new Set<string>();
/** Plain agents used for the proxy leg, so it cannot re-enter the proxy agent. */
const directHttpAgent = new http.Agent();
const directHttpsAgent = new https.Agent();

export class EgressViolation extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EgressViolation';
	}
}

type RequestArgs = unknown[];

/**
 * Normalise the several `http.request` call signatures down to the options
 * object, inserting one if the caller passed only a URL.
 */
function optionsFrom(args: RequestArgs): Record<string, unknown> | undefined {
	const first = args[0];

	if (typeof first === 'string' || first instanceof URL) {
		const second = args[1];
		if (typeof second === 'object' && second !== null) {
			return second as Record<string, unknown>;
		}
		// request(url, callback) → splice an options object into place
		const inserted: Record<string, unknown> = {};
		args.splice(1, 0, inserted);
		return inserted;
	}

	if (typeof first === 'object' && first !== null) {
		return first as Record<string, unknown>;
	}

	return undefined;
}

/**
 * Hostname only, never host:port.
 *
 * `new URL(...).host` includes the port but `options.hostname` does not, so the
 * two call signatures would file the same server under two different keys — and
 * an audit that splits one host across two rows, potentially showing it as both
 * proxied and direct, is worse than no audit.
 */
function hostFrom(args: RequestArgs, options: Record<string, unknown> | undefined): string {
	const first = args[0];

	if (typeof first === 'string' || first instanceof URL) {
		try {
			return new URL(first.toString()).hostname;
		} catch {
			return String(first);
		}
	}

	const hostname = options?.hostname;
	if (typeof hostname === 'string') {
		return hostname;
	}

	const host = options?.host;
	if (typeof host === 'string') {
		// `options.host` may carry a port; strip it, keeping IPv6 brackets intact.
		const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host);
		return match?.[1] ?? host;
	}

	return '<unknown>';
}

/**
 * Install the guard. Call once, before anything touches the network.
 *
 * @param agents The agents every outbound request must use, or undefined when
 *               no proxy is configured (guard then only records).
 * @param options.strict Throw on a request that cannot be routed through our
 *                       agent. Default true when a proxy is set — failing loudly
 *                       beats leaking quietly (§0.4).
 */
export function installEgressGuard(
	agents: { http: Agent; https: Agent } | undefined,
	options: { strict?: boolean; bypassHosts?: string[] } = {}
): void {
	if (installed) {
		return;
	}
	installed = true;
	expectedHttpAgent = agents?.http;
	expectedHttpsAgent = agents?.https;
	strict = options.strict ?? Boolean(agents);
	// Lower-cased on both sides. Hostnames are case-insensitive, and a caller
	// passing `options.hostname` in mixed case would otherwise miss the bypass —
	// producing exactly the HTTP-proxy recursion this bypass exists to prevent.
	bypassHosts = new Set((options.bypassHosts ?? []).map((host) => host.toLowerCase()));

	for (const [mod, protocol, expected] of [
		[http, 'http:' as const, () => expectedHttpAgent],
		[https, 'https:' as const, () => expectedHttpsAgent]
	] as const) {
		const originalRequest = mod.request.bind(mod);
		const originalGet = mod.get.bind(mod);

		const wrap =
			(original: (...a: never[]) => unknown) =>
			(...args: RequestArgs): unknown => {
				const opts = optionsFrom(args);
				const want = expected();
				const host = hostFrom(args, opts);

				let proxied = false;
				let foreignAgent = false;
				const proxyLeg = want !== undefined && bypassHosts.has(host.toLowerCase());

				if (proxyLeg && opts) {
					// This request IS the tunnel. Pin it to a plain agent so the proxy
					// agent cannot be handed its own connection and recurse.
					opts.agent = protocol === 'https:' ? directHttpsAgent : directHttpAgent;
					proxied = true;
				} else if (want && opts) {
					const current = opts.agent;
					if (!current) {
						// The common case: library made a bare request. Route it.
						opts.agent = want;
						proxied = true;
					} else if (current === want) {
						proxied = true;
					} else {
						// Something insisted on its own agent. We cannot know that it
						// is proxied, so treat it as a leak.
						foreignAgent = true;
					}
				}

				const entry = totals.get(host) ?? { total: 0, proxied: 0, foreign: 0, leg: 0 };
				entry.total++;
				if (proxied) entry.proxied++;
				if (foreignAgent) entry.foreign++;
				if (proxyLeg) entry.leg++;
				totals.set(host, entry);

				records.push({ host, protocol, proxied, foreignAgent, proxyLeg });
				if (records.length > MAX_DETAIL_RECORDS) {
					records.shift();
				}

				if (want && !proxied && strict) {
					throw new EgressViolation(
						`refused an outbound ${protocol}//${host} request that would not have used the ` +
							'configured proxy. Every Steam request must go through it, so this is a hard stop ' +
							'rather than a warning.'
					);
				}

				return original(...(args as never[]));
			};

		mod.request = wrap(originalRequest) as typeof mod.request;
		mod.get = wrap(originalGet) as typeof mod.get;
	}

	// Defence in depth: anything constructing its own request outside the two
	// entry points above still lands on the global agent.
	//
	// The cast is unavoidable and safe: a proxy agent (SocksProxyAgent, or
	// stdlib's) subclasses http.Agent and handles CONNECT for https targets, but
	// is not nominally an https.Agent. Node only ever calls the http.Agent
	// surface on it.
	if (agents) {
		http.globalAgent = agents.http;
		https.globalAgent = agents.https as unknown as https.Agent;
	}
}

/** The most recent requests, capped at MAX_DETAIL_RECORDS. */
export function egressRecords(): readonly EgressRecord[] {
	return records;
}

/** Exact per-host counts for the whole process lifetime. Never truncated. */
export function egressTotals(): ReadonlyMap<string, EgressTotals> {
	return totals;
}

/** Reset between tests. Not used at runtime. */
export function __resetEgressForTests(): void {
	records.length = 0;
	totals.clear();
}

/**
 * Print what actually left the machine. This is the evidence for the claim —
 * without it, "fully proxied" is just a sentence in a README.
 */
export function reportEgress(proxyConfigured: boolean): void {
	if (totals.size === 0) {
		return;
	}

	// Aggregated counts, not the capped detail list — the audit must stay exact
	// however long the process has been running.
	const byHost = totals;

	log.blank();
	log.info('── Egress audit');
	for (const [host, entry] of byHost) {
		const state = !proxyConfigured
			? 'direct (no proxy configured)'
			: entry.leg === entry.total
				? 'the proxy itself (tunnel)'
				: entry.proxied === entry.total
					? 'via proxy'
					: `${entry.total - entry.proxied} NOT PROXIED`;
		log.info(`  ${host.padEnd(28)} ${String(entry.total).padStart(3)} request(s)  ${state}`);
	}

	let seen = 0;
	let leaked = 0;
	for (const entry of totals.values()) {
		seen += entry.total;
		leaked += entry.total - entry.proxied;
	}

	if (proxyConfigured && leaked > 0) {
		log.error(`${leaked} request(s) did not use the proxy.`);
	} else if (proxyConfigured) {
		log.info(`  all ${seen} request(s) went through the proxy.`);
	}
}
