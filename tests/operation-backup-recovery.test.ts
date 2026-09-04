import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNELS } from '../src/shared/channels';

const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string) => handlers.delete(channel)
	},
	dialog: {},
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import { EnrollmentError } from '../src/main/steam/enroll';
import { fileOperationJournal } from '../src/main/steam/operation-journal';
import { ProxyConsent } from '../src/main/net/proxy-consent';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { VaultService } from '../src/main/vault/service';
import { VaultKeyOperationCoordinator } from '../src/main/vault/key-operation-coordinator';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';
import type { EnrollmentService } from '../src/main/steam/enrollment';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const PASS = 'a sufficiently long passphrase';
const STEAM_ID = '76561198000000001';

function account(): Account {
	return {
		steamId64: STEAM_ID,
		accountName: 'trader',
		sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
		identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
		status: 'pendingActivation',
		addedAt: '2026-01-01T00:00:00.000Z',
		autoConfirm: newAutoConfirm()
	};
}

function register(
	vault: VaultService,
	journal: ReturnType<typeof fileOperationJournal>,
	overrides: Partial<EnrollmentService>
): void {
	registerEnrollmentHandlers(
		overrides as EnrollmentService,
		vault,
		{ show: () => Promise.resolve(undefined) },
		() => undefined,
		{ pick: () => Promise.resolve(undefined) },
		new ProxyConsent(),
		journal,
		new VaultKeyOperationCoordinator()
	);
}

function handlerFor(channel: string): (event: unknown, request: unknown) => Promise<unknown> {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`${channel} was not registered`);
	return handler;
}

describe('restoring the vault backup after an uncertain Steam operation', () => {
	let dir: string;
	let vault: VaultService;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), 'oda-operation-backup-'));
		vault = new VaultService({ file: join(dir, 'vault.json') });
		await vault.create(PASS);
		await vault.mutate((draft) => draft.accounts.push(account()));
		handlers.clear();
		__resetRouterForTests();
		setTrustedSender(() => true);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		['activation', CHANNELS.enrollActivate, { steamId64: STEAM_ID, code: '12345' }, 'activate'],
		[
			'removal',
			CHANNELS.accountDeactivate,
			{
				steamId64: STEAM_ID,
				passphrase: PASS,
				acknowledgement: 'REMOVE STEAM GUARD'
			},
			'deactivate'
		]
	] as const)(
		'keeps the independent %s refusal after the pre-latch backup is restored',
		async (_label, channel, request, method) => {
			const journal = fileOperationJournal(dir);
			const first = vi.fn(() =>
				Promise.reject(
					new EnrollmentError('Steam received the request but did not answer.', true, true)
				)
			);
			register(vault, journal, { [method]: first });

			await expect(handlerFor(channel)(EVENT, request)).resolves.toMatchObject({
				state: 'uncertain',
				persisted: true
			});
			expect(vault.read().accounts[0]?.unresolvedOperation?.kind).toBe(method);
			expect(journal.readKind(STEAM_ID, method)).toBeDefined();

			vault.lock('manual');
			await vault.restoreFromBackup(PASS);
			expect(vault.read().accounts[0]?.unresolvedOperation).toBeUndefined();
			expect(journal.readKind(STEAM_ID, method)).toBeDefined();

			const repeated = vi.fn(() =>
				Promise.resolve((method === 'activate' ? 'activated' : undefined) as never)
			);
			handlers.clear();
			__resetRouterForTests();
			setTrustedSender(() => true);
			register(vault, journal, { [method]: repeated });
			await expect(handlerFor(channel)(EVENT, request)).resolves.toMatchObject({
				state: 'uncertain',
				kind: method
			});
			expect(
				repeated,
				'the restored backup re-offered the irreversible Steam request'
			).not.toHaveBeenCalled();
		}
	);
});
