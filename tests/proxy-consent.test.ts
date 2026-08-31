import { describe, expect, it } from 'vitest';
import { ProxyConsent, type ProxyConsentRequest } from '../src/main/net/proxy-consent';
import { EgressError } from '../src/main/net/egress';

/**
 * **The renderer can ask the main process to open an outbound channel.**
 *
 * `docs/THREAT_MODEL.md` claims a renderer compromise cannot exfiltrate, on the
 * strength of the sandbox, no Node, and `connect-src 'none'`. Those close every
 * channel the renderer can open *itself*, and none of them touches the one it
 * can ask for: three IPC calls take a proxy address, and `planProxy` validates
 * the scheme, the port and the credentials while never looking at the host.
 *
 * So `http://<secret-as-a-label>.attacker.net` is resolved by the main process
 * and the label reaches whoever runs that zone. The connection need not
 * succeed — DNS alone is the channel — and everything the renderer can read
 * fits in a hostname.
 *
 * These are about the gate itself. That it is actually *on* each of the three
 * paths is asserted where those paths live, because a gate nothing calls is the
 * failure this whole class is meant to prevent.
 */

function harness(answer: boolean | ((request: ProxyConsentRequest) => boolean) = true): {
	consent: ProxyConsent;
	asked: ProxyConsentRequest[];
} {
	const asked: ProxyConsentRequest[] = [];
	const consent = new ProxyConsent({
		ask: (request) => {
			asked.push(request);
			return Promise.resolve(typeof answer === 'function' ? answer(request) : answer);
		}
	});
	return { consent, asked };
}

describe('a destination nobody has approved', () => {
	it('is put to the user, named by host and port', async () => {
		const { consent, asked } = harness();
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });

		expect(asked).toHaveLength(1);
		expect(asked[0]?.endpoint, 'the dialog cannot name what it is asking about').toBe(
			'10.0.0.9:8080'
		);
	});

	/*
	 * The port is part of the destination and part of the question: two ports on
	 * one host are two different operators as often as not.
	 */
	it('treats a different port as a different destination', async () => {
		const { consent, asked } = harness();
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		await consent.require('http://10.0.0.9:9090', { reason: 'route' });
		expect(asked).toHaveLength(2);
	});

	/**
	 * **Credentials ARE part of it, and reasoning otherwise was the hole.**
	 *
	 * This test used to assert the opposite, on the argument that credentials
	 * reach the proxy operator and never travel as a name, so rotating a password
	 * is not a new destination and asking again would train people to click
	 * through. The first half is true; the conclusion does not follow.
	 *
	 * A compromised renderer does not need a *new* destination. It saves the same
	 * approved endpoint with attacker-chosen username and password, matches on
	 * `host:port`, skips the dialog entirely — and the transport then sends those
	 * strings to the proxy on the next authentication. The credentials are the
	 * payload and the approved operator is the recipient: the same exfiltration
	 * channel this class exists to close, reached through the one field it
	 * ignored.
	 */
	it('asks again when the credentials change on an approved endpoint', async () => {
		const { consent, asked } = harness();
		await consent.require('http://alice:one@10.0.0.9:8080', { reason: 'route' });
		await consent.require('http://alice:two@10.0.0.9:8080', { reason: 'route' });
		expect(
			asked,
			'attacker-chosen credentials were sent to an approved proxy without a dialog'
		).toHaveLength(2);
	});

	it('asks again when credentials are added to an endpoint approved without any', async () => {
		const { consent, asked } = harness();
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		await consent.require('http://carrier:payload@10.0.0.9:8080', { reason: 'route' });
		expect(asked).toHaveLength(2);
	});

	/*
	 * And the scheme, for a plainer reason: http and socks5 to one address are two
	 * protocols reaching two listeners, and the user agreed to one of them.
	 */
	it('asks again when the scheme changes', async () => {
		const { consent, asked } = harness();
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		await consent.require('socks5://10.0.0.9:8080', { reason: 'route' });
		expect(asked).toHaveLength(2);
	});

	it('does not ask twice for the very same address', async () => {
		const { consent, asked } = harness();
		await consent.require('http://alice:one@10.0.0.9:8080', { reason: 'route' });
		await consent.require('http://alice:one@10.0.0.9:8080', { reason: 'signIn' });
		expect(asked, 'an unchanged address raised a dialog with no decision in it').toHaveLength(1);
	});

	it('never puts the credentials in the dialog', async () => {
		const { consent, asked } = harness();
		await consent.require('http://alice:hunter2@10.0.0.9:8080', { reason: 'route' });

		expect(
			JSON.stringify(asked),
			'the proxy password was printed in a dialog that appears over a lock screen'
		).not.toContain('hunter2');
	});

	it('refuses, and says so, when the answer is no', async () => {
		const { consent } = harness(false);
		await expect(
			consent.require('http://evil.example:8080', { reason: 'route' })
		).rejects.toBeInstanceOf(EgressError);
	});

	/*
	 * A no is about this attempt. Remembering it would turn one misclick into a
	 * proxy that cannot be set again without a restart.
	 */
	it('asks again after a refusal', async () => {
		let allow = false;
		const { consent, asked } = harness(() => allow);
		await expect(
			consent.require('http://10.0.0.9:8080', { reason: 'route' })
		).rejects.toBeInstanceOf(EgressError);

		allow = true;
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		expect(asked).toHaveLength(2);
	});

	it('asks once for a destination already approved', async () => {
		const { consent, asked } = harness();
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		await consent.require('http://10.0.0.9:8080', { reason: 'signIn' });
		expect(
			asked,
			'a prompt with no decision left in it teaches people to click Allow'
		).toHaveLength(1);
	});

	/*
	 * The address is checked before anyone is asked, so the dialog never quotes a
	 * host nothing could have connected to.
	 */
	it('refuses an unusable address without asking anybody', async () => {
		const { consent, asked } = harness();
		await expect(consent.require('not a url', { reason: 'route' })).rejects.toBeInstanceOf(
			EgressError
		);
		expect(asked).toEqual([]);
	});
});

/**
 * **What the vault already holds is the user's own routing.**
 *
 * Without seeding, every stored proxy would raise a dialog on its first use
 * after each unlock — a prompt with no decision in it, several times a day.
 * That is precisely how people are trained to click Allow on the one that
 * matters.
 */
describe('the addresses already in the vault', () => {
	it('are approved without asking', async () => {
		const { consent, asked } = harness();
		consent.seed(['http://10.0.0.9:8080']);
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		expect(asked).toEqual([]);
	});

	it('does not approve anything else', async () => {
		const { consent, asked } = harness();
		consent.seed(['http://10.0.0.9:8080']);
		await consent.require('http://10.0.0.10:8080', { reason: 'route' });
		expect(asked, 'seeding one address approved a different one').toHaveLength(1);
	});

	/*
	 * This runs on unlock, and a vault written by an older build has to open. An
	 * address nothing can parse is also an address nothing will connect to.
	 */
	it('skips entries that are not usable addresses', () => {
		const { consent } = harness();
		expect(() => consent.seed(['', undefined, 'not a url', 'http://10.0.0.9:8080'])).not.toThrow();
		// `has` takes the whole address now: an approval is bound to the scheme and
		// the credentials as well, so a bare endpoint is no longer a question this
		// class can answer.
		expect(consent.has('http://10.0.0.9:8080')).toBe(true);
	});
});

/**
 * **Locking drops what a person agreed to while they were present.**
 *
 * The stored addresses come back on the next unlock via `seed`, so what this
 * actually forgets is approval for a destination that was never written to the
 * vault — which is the shape an exfiltration attempt has.
 */
describe('locking', () => {
	it('forgets an approval that was never stored', async () => {
		const { consent, asked } = harness();
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		consent.clear();
		await consent.require('http://10.0.0.9:8080', { reason: 'route' });
		expect(asked, 'an approval outlived the person who gave it').toHaveLength(2);
	});
});

/**
 * **A dialog outlives the lock that was supposed to stop it.**
 *
 * `clear()` dropped the approvals that existed. It said nothing about the
 * question being asked *right now* — and that question is an OS dialog a person
 * can leave sitting for as long as they like, while the vault locks on its own
 * schedule.
 *
 * Measured before the fix: hold the dialog, lock the vault (which calls
 * `clear()`), then approve. The approval was recorded and the caller carried on
 * — enrolment with a password, transfer with a password and a Steam Guard code
 * — through an endpoint approved by nobody who was present.
 */
describe('a consent dialog still on screen when the vault locks', () => {
	function pending(): {
		consent: ProxyConsent;
		answer: (allowed: boolean) => void;
	} {
		let settle: ((allowed: boolean) => void) | undefined;
		const consent = new ProxyConsent({
			ask: () =>
				new Promise<boolean>((resolve) => {
					settle = resolve;
				})
		});
		return {
			consent,
			answer: (allowed) => settle?.(allowed)
		};
	}

	it('refuses an approval given after the lock', async () => {
		const { consent, answer } = pending();
		const asking = consent.require('http://10.0.0.9:8080', { reason: 'signIn' });
		// Let the dialog reach the point of waiting.
		await Promise.resolve();

		consent.clear();
		answer(true);

		await expect(
			asking,
			'a password was about to go through an endpoint approved after the vault closed'
		).rejects.toBeInstanceOf(EgressError);
	});

	it('does not remember it either', async () => {
		const { consent, answer } = pending();
		const asking = consent.require('http://10.0.0.9:8080', { reason: 'signIn' });
		await Promise.resolve();
		consent.clear();
		answer(true);
		await expect(asking).rejects.toBeInstanceOf(EgressError);

		expect(
			consent.has('http://10.0.0.9:8080'),
			'the late approval was recorded, so the next attempt would not ask'
		).toBe(false);
	});

	it('still honours one given before it', async () => {
		const { consent, answer } = pending();
		const asking = consent.require('http://10.0.0.9:8080', { reason: 'route' });
		await Promise.resolve();
		answer(true);

		await expect(asking).resolves.toBeUndefined();
		expect(consent.has('http://10.0.0.9:8080')).toBe(true);
	});
});

/**
 * **A gate with no way to ask must refuse.**
 *
 * The default exists for wiring mistakes, and there is only one safe direction
 * for it to fail in: a permissive default would leave the hole open in exactly
 * the case nobody noticed — a caller constructed without a dialog — while every
 * test that passes one still went green.
 */
describe('a gate nothing gave a way to ask', () => {
	it('refuses rather than allowing', async () => {
		await expect(
			new ProxyConsent().require('http://10.0.0.9:8080', { reason: 'route' })
		).rejects.toBeInstanceOf(EgressError);
	});
});
