import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	SteamTransportFactory,
	type ElectronNetworking,
	type ProxyCapableSession
} from '../src/main/net/transport';
import { TransferService } from '../src/main/steam/transfer';
import {
	fileWorkflowJournal,
	type TransferWorkflowRecord,
	type WorkflowJournal
} from '../src/main/steam/workflow-journal';
import { openBytesWithKey, sealBytesWithKey } from '../src/main/vault/crypto';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';
import type { Kdf } from '../src/shared/vault-format';

const STEAM_ID = '76561198000000001';
const NOW = Date.parse('2026-09-02T00:00:00Z');
const PROXY_URL = 'http://127.0.0.1:8080';
const TOKEN = 'eyJhbGciOiJub25lIn0.eyJhdWQiOlsibW9iaWxlIl0sImV4cCI6MjAwMDAwMDAwMH0.';
const KEY = Buffer.alloc(32, 7);
const KDF: Kdf = {
	type: 'scrypt',
	N: 16384,
	r: 8,
	p: 1,
	salt: Buffer.alloc(32, 8).toString('base64')
};

function fakeVault(): VaultService {
	const accounts: Account[] = [];
	return {
		isUnlocked: () => true,
		read: () => ({ accounts }),
		mutate: (change: (draft: { accounts: Account[] }) => void) => {
			change({ accounts });
			return Promise.resolve();
		},
		sealScopedKey: (plaintext: Buffer) => sealBytesWithKey(plaintext, KEY, KDF),
		openScopedEnvelope: (envelope: unknown) => openBytesWithKey(envelope, KEY, KDF)
	} as unknown as VaultService;
}

interface NetworkProbe {
	requests: number;
	ends: number;
	proxyRules: string | undefined;
	errors: Error[];
	journalAtEnd: TransferWorkflowRecord[][];
}

function failingElectron(journal: WorkflowJournal, probe: NetworkProbe): ElectronNetworking {
	const session = {
		setProxy: (config: { proxyRules?: string }) => {
			probe.proxyRules = config.proxyRules;
			return Promise.resolve();
		},
		resolveProxy: () => Promise.resolve('PROXY 127.0.0.1:8080'),
		clearStorageData: () => Promise.resolve()
	} as unknown as ProxyCapableSession;

	return {
		sessionFromPartition: () => session,
		request: () => {
			probe.requests += 1;
			const listeners = new Map<string, Array<(...args: never[]) => void>>();
			return {
				setHeader: () => undefined,
				write: () => undefined,
				end: () => {
					probe.ends += 1;
					probe.journalAtEnd.push(journal.transfers());
					const error = new Error('net::ERR_PROXY_CONNECTION_FAILED');
					probe.errors.push(error);
					queueMicrotask(() => {
						for (const listener of listeners.get('error') ?? []) {
							(listener as unknown as (error: Error) => void)(error);
						}
					});
				},
				abort: () => undefined,
				on: (event: string, listener: (...args: never[]) => void) => {
					const registered = listeners.get(event) ?? [];
					registered.push(listener);
					listeners.set(event, registered);
				}
			};
		}
	};
}

function service(
	vault: VaultService,
	journal: WorkflowJournal,
	probe: NetworkProbe
): TransferService {
	const transports = new SteamTransportFactory(failingElectron(journal, probe), () => NOW);
	return new TransferService(vault, transports, () => 0, {
		now: () => NOW,
		workflowJournal: journal,
		signIn: () => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }),
		mintAccessToken: () => Promise.resolve('access')
		// Deliberately no continueChallenge override: the request passes through the
		// real transfer API and the real Electron-backed Steam transport.
	});
}

describe('a proxy failure after Chromium accepts the transfer request', () => {
	it('keeps durable uncertainty and blocks a fresh irreversible attempt', async () => {
		const userData = mkdtempSync(join(tmpdir(), 'oda-transfer-preorigin-'));
		const journal = fileWorkflowJournal(userData);
		const probe: NetworkProbe = {
			requests: 0,
			ends: 0,
			proxyRules: undefined,
			errors: [],
			journalAtEnd: []
		};
		const vault = fakeVault();
		const first = service(vault, journal, probe);

		await first.authenticate('trader', 'password', 'QK4TX', PROXY_URL);
		await expect(first.completeTransfer('12345')).rejects.toThrow(/cannot tell/i);

		// The irreversible path really reached ClientRequest.end() through the default
		// transfer API, and its durable sending intent existed before Electron failed.
		expect(probe.requests).toBe(1);
		expect(probe.ends).toBe(1);
		expect(probe.proxyRules).toBe(PROXY_URL);
		expect(probe.errors).toHaveLength(1);
		expect(probe.errors[0]?.constructor).toBe(Error);
		expect(probe.journalAtEnd).toHaveLength(1);
		expect(probe.journalAtEnd[0]).toHaveLength(1);
		expect(probe.journalAtEnd[0]?.[0]).toMatchObject({
			kind: 'transfer',
			steamId64: STEAM_ID,
			state: 'sending'
		});

		// `end()` handed the body to Chromium. A surfaced proxy code can belong to
		// an internal replay after an earlier connection delivered the POST, so it
		// cannot erase the intent or make the operation safe to repeat.
		expect(journal.transfers()).toHaveLength(1);
		expect(journal.transfers()[0]).toMatchObject({ state: 'unanswered' });
		expect(first.awaiting()).toBe('unanswered');
		const restartedJournal = fileWorkflowJournal(userData);
		const restarted = service(vault, restartedJournal, probe);
		expect(restarted.awaiting()).toBe('unanswered');
		await expect(restarted.authenticate('trader', 'password', 'QK4TX', PROXY_URL)).rejects.toThrow(
			/unresolved safety record/i
		);
		expect(probe.requests).toBe(1);
		expect(probe.ends).toBe(1);
		expect(restartedJournal.transfers()).toHaveLength(1);
	}, 15_000);
});
