import { EgressError, planProxy } from './egress';

/**
 * **The renderer may not open an outbound channel on its own say-so.**
 *
 * `docs/THREAT_MODEL.md` claims, in the decisions table, that "a renderer
 * compromise cannot exfiltrate" — on the strength of the sandbox, no Node, and
 * `connect-src 'none'`. Those close every channel the renderer can open
 * *itself*. They do nothing about the one it can ask the main process to open
 * for it.
 *
 * Three IPC calls take a proxy address from the renderer — `accountSetProxy`,
 * `enrollmentBegin`, `transferAuthenticate` — and `planProxy` validates the
 * scheme, the port and the credentials but never the host. So a compromised
 * renderer sets a proxy of `http://<secret-encoded-as-a-label>.attacker.net`
 * and the main process resolves it, which hands the secret to whoever runs that
 * zone's nameserver. The connection does not need to succeed. DNS alone is the
 * channel, and everything the renderer can read — a Guard code, an account
 * name, the vault's shape — fits in a hostname.
 *
 * That is the exfiltration route the table says does not exist, and it defeats
 * the whole point of keeping long-term secrets out of the renderer: what the
 * renderer *can* see becomes sendable.
 *
 * **So a new destination needs a person.** Consent is asked for by the main
 * process, in an OS dialog the renderer cannot draw, dismiss or read, and it
 * names the host. It is asked once per destination, not once per request:
 * routing an account through a proxy it already uses prompts nobody, and the
 * addresses already in the vault are seeded as approved on unlock, because the
 * user established those already.
 *
 * It is not a complete answer — a person can be talked into approving a
 * plausible-looking hostname — but it converts a silent, unlimited channel into
 * one that is visible, consented, and rate-limited by human attention.
 */

/** Why a destination is being introduced, which changes what the dialog says. */
export type ProxyConsentReason = 'route' | 'signIn';

export interface ProxyConsentRequest {
	/** `host:port`, the thing actually connected to. */
	endpoint: string;
	/** The scheme and host with any credentials starred out, for display. */
	redacted: string;
	/** Whose traffic this is about, when there is an account to name. */
	accountName?: string;
	reason: ProxyConsentReason;
}

/** Put the question to the user. Resolves true only for a deliberate yes. */
export type ProxyConsentAsk = (request: ProxyConsentRequest) => Promise<boolean>;

/**
 * Refused destinations are not remembered.
 *
 * A no is about this attempt. Caching it would turn one misclick into a proxy
 * the user can never set without restarting, and the whole point is that the
 * decision is cheap to make again.
 */
export class ProxyConsent {
	private readonly approved = new Set<string>();
	private readonly ask: ProxyConsentAsk;

	constructor(options: { ask?: ProxyConsentAsk } = {}) {
		// Refusing by default matters: a wiring mistake that left this unset would
		// otherwise approve everything silently, which is the state being fixed.
		this.ask = options.ask ?? ((): Promise<boolean> => Promise.resolve(false));
	}

	/**
	 * Treat these addresses as already the user's own routing.
	 *
	 * Called on unlock with what the vault holds. Without it every stored proxy
	 * would ask again after each lock, which is a prompt with no decision in it —
	 * and a prompt with no decision in it is how people learn to click Allow.
	 *
	 * Unparseable entries are skipped rather than thrown on: this runs on unlock,
	 * and a vault written by an older build must still open.
	 */
	seed(proxyUrls: Iterable<string | undefined>): void {
		for (const proxyUrl of proxyUrls) {
			if (proxyUrl === undefined || proxyUrl === '') {
				continue;
			}
			try {
				this.approved.add(planProxy(proxyUrl).endpoint);
			} catch {
				// Not a usable address, so nothing will ever connect to it.
			}
		}
	}

	/** Already approved, so no dialog is raised for it. */
	has(endpoint: string): boolean {
		return this.approved.has(endpoint);
	}

	/**
	 * Ask, unless this destination is already approved.
	 *
	 * @throws EgressError when the user says no, worded so the renderer can show
	 * it as an ordinary refusal — there is nothing secret in "you declined".
	 */
	async require(
		proxyUrl: string,
		context: { accountName?: string; reason: ProxyConsentReason }
	): Promise<void> {
		// Throws for an unusable address before anything is asked, so the dialog
		// never quotes a host that could not be connected to anyway.
		const plan = planProxy(proxyUrl);
		if (this.approved.has(plan.endpoint)) {
			return;
		}

		const allowed = await this.ask({
			endpoint: plan.endpoint,
			redacted: plan.redacted,
			...(context.accountName === undefined ? {} : { accountName: context.accountName }),
			reason: context.reason
		});
		if (!allowed) {
			throw new EgressError(
				`sending this account's traffic through ${plan.endpoint} was not approved`
			);
		}
		this.approved.add(plan.endpoint);
	}

	/**
	 * Forget every approval. Called when the vault locks.
	 *
	 * The approvals describe what the person at the machine agreed to while they
	 * were there. Locking is the statement that they may not be, and `seed` puts
	 * back the ones the vault itself vouches for on the next unlock — so what is
	 * actually dropped is consent for a destination that was never stored, which
	 * is precisely the shape of an exfiltration attempt.
	 */
	clear(): void {
		this.approved.clear();
	}
}
