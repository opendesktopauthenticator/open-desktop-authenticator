import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, hooks } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
	hooks: {
		beforeWrite: undefined as (() => Promise<void>) | undefined,
		writeFailure: undefined as Error | undefined,
		afterWrite: undefined as (() => void) | undefined,
		afterPublish: undefined as (() => void | Promise<void>) | undefined,
		afterChmod: undefined as (() => Promise<void>) | undefined
	}
}));

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			const before = hooks.beforeWrite;
			hooks.beforeWrite = undefined;
			await before?.();
			const failure = hooks.writeFailure;
			hooks.writeFailure = undefined;
			if (failure !== undefined) throw failure;
			const result = await Reflect.apply(actual.writeFile, actual, args);
			const hook = hooks.afterWrite;
			hooks.afterWrite = undefined;
			hook?.();
			return result;
		},
		link: async (...args: Parameters<typeof actual.link>) => {
			const result = await Reflect.apply(actual.link, actual, args);
			const hook = hooks.afterPublish;
			hooks.afterPublish = undefined;
			await hook?.();
			return result;
		},
		chmod: async (...args: Parameters<typeof actual.chmod>) => {
			const result = await Reflect.apply(actual.chmod, actual, args);
			const hook = hooks.afterChmod;
			hooks.afterChmod = undefined;
			await hook?.();
			return result;
		},
		rename: async (...args: Parameters<typeof actual.rename>) => {
			const result = await Reflect.apply(actual.rename, actual, args);
			const [from] = args;
			if (typeof from === 'string' && from.endsWith('.tmp')) {
				const hook = hooks.afterPublish;
				hooks.afterPublish = undefined;
				await hook?.();
			}
			return result;
		}
	};
});

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	},
	dialog: {},
	BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] }
}));

import { setTrustedSender, __resetRouterForTests } from '../src/main/ipc/router';
import { toMaFile } from '../src/main/import/export';
import { memoryOperationJournal } from '../src/main/steam/operation-journal';
import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import { VaultKeyOperationCoordinator } from '../src/main/vault/key-operation-coordinator';
import { VaultService } from '../src/main/vault/service';
import { CHANNELS } from '../src/shared/channels';
import { DEACTIVATE_ACK } from '../src/shared/ipc';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

const EVENT = { senderFrame: { url: 'app://renderer' } };
const STEAM_ID = '76561198000000001';
const originalAccount: Account = {
	steamId64: STEAM_ID,
	accountName: 'trader',
	sharedSecret: Buffer.alloc(20, 1).toString('base64'),
	identitySecret: Buffer.alloc(20, 2).toString('base64'),
	revocationCode: 'R-ORIGINAL',
	deviceId: 'android:original',
	serialNumber: 'serial-original',
	tokenGid: 'gid-original',
	uri: 'otpauth://totp/Steam:trader?secret=ORIGINAL',
	secret1: 'secret-one',
	status: 'active',
	addedAt: '2026-09-03T00:00:00.000Z',
	autoConfirm: newAutoConfirm()
};

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'oda-export-status-race-'));
	handlers.clear();
	hooks.beforeWrite = undefined;
	hooks.writeFailure = undefined;
	hooks.afterWrite = undefined;
	hooks.afterPublish = undefined;
	hooks.afterChmod = undefined;
	__resetRouterForTests();
	setTrustedSender(() => true);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function cloneAccount(value: Account): Account {
	return {
		...value,
		autoConfirm: { ...value.autoConfirm, notify: { ...value.autoConfirm.notify } }
	};
}

function exportHarness(
	initial: Account,
	phase: 'write' | 'publish',
	mutate: (account: Account) => void,
	withPrevious = false
): { destination: string; before: string; call: () => Promise<unknown> } {
	const accounts = [cloneAccount(initial)];
	const before = toMaFile(accounts[0] as Account);
	const destination = join(root, 'out.maFile');
	if (withPrevious) writeFileSync(destination, 'the previous export');
	const vault = {
		isUnlocked: () => true,
		touch: () => undefined,
		// Real VaultService reads are detached. Preserve that property so a mutation
		// cannot retroactively alter the snapshot the handler already serialized.
		read: () => ({ accounts: accounts.map(cloneAccount) })
	} as unknown as VaultService;

	registerEnrollmentHandlers({} as EnrollmentService, vault, {
		show: () => Promise.resolve(destination)
	});
	const change = () => mutate(accounts[0] as Account);
	if (phase === 'write') hooks.afterWrite = change;
	else hooks.afterPublish = change;

	const handler = handlers.get(CHANNELS.accountExport);
	if (handler === undefined) throw new Error('accountExport was not registered');
	return {
		destination,
		before,
		call: () => handler(EVENT, { steamId64: STEAM_ID })
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function lateCleanupHarness(
	initial: Account,
	phase: 'publish' | 'chmod' | 'write-failure',
	withPrevious: boolean
): {
	accounts: Account[];
	before: string;
	destination: string;
	reachedLateCleanup: Promise<void>;
	releaseLateCleanup: () => void;
	exportAccount: () => Promise<unknown>;
	activate: () => Promise<unknown>;
	deactivate: () => Promise<unknown>;
} {
	const accounts = [cloneAccount(initial)];
	const before = toMaFile(accounts[0] as Account);
	const destination = join(root, 'out.maFile');
	if (withPrevious) writeFileSync(destination, 'the previous export');

	const reached = deferred();
	const release = deferred();
	const pause = async (): Promise<void> => {
		reached.resolve();
		await release.promise;
	};
	if (phase === 'publish') hooks.afterPublish = pause;
	else if (phase === 'chmod') hooks.afterChmod = pause;
	else {
		hooks.beforeWrite = pause;
		hooks.writeFailure = new Error('the test drive rejected the staged write');
	}

	const vault = {
		isUnlocked: () => true,
		touch: () => undefined,
		read: () => ({ accounts: accounts.map(cloneAccount) })
	} as unknown as VaultService;
	const enrollment = {
		activate: () => {
			const account = accounts.find((entry) => entry.steamId64 === STEAM_ID);
			if (account === undefined) throw new Error('account disappeared before activation');
			account.status = 'active';
			return Promise.resolve('activated' as const);
		},
		deactivate: () => {
			const index = accounts.findIndex((entry) => entry.steamId64 === STEAM_ID);
			if (index < 0) throw new Error('account disappeared before removal');
			accounts.splice(index, 1);
			return Promise.resolve();
		}
	} as unknown as EnrollmentService;
	const coordinator = new VaultKeyOperationCoordinator();
	registerEnrollmentHandlers(
		enrollment,
		vault,
		{ show: () => Promise.resolve(destination) },
		undefined,
		undefined,
		undefined,
		memoryOperationJournal(),
		coordinator
	);

	const exportHandler = handlers.get(CHANNELS.accountExport);
	const activateHandler = handlers.get(CHANNELS.enrollActivate);
	const deactivateHandler = handlers.get(CHANNELS.accountDeactivate);
	if (
		exportHandler === undefined ||
		activateHandler === undefined ||
		deactivateHandler === undefined
	) {
		throw new Error('the enrollment handlers were not registered');
	}
	return {
		accounts,
		before,
		destination,
		reachedLateCleanup: reached.promise,
		releaseLateCleanup: release.resolve,
		exportAccount: () => exportHandler(EVENT, { steamId64: STEAM_ID }),
		activate: () => activateHandler(EVENT, { steamId64: STEAM_ID, code: '12345' }),
		deactivate: () =>
			deactivateHandler(EVENT, {
				steamId64: STEAM_ID,
				passphrase: 'a sufficiently long passphrase',
				acknowledgement: DEACTIVATE_ACK
			})
	};
}

async function outcome(promise: Promise<unknown>): Promise<{ ok: boolean }> {
	return promise.then(
		() => ({ ok: true }),
		() => ({ ok: false })
	);
}

describe('accountExport compares the exact serialized snapshot', () => {
	it('rejects without publishing when activation completes during the write', async () => {
		const { call, destination } = exportHarness(
			{ ...originalAccount, status: 'pendingActivation' },
			'write',
			(account) => {
				account.status = 'active';
			}
		);

		await expect(call()).rejects.toThrow(/replaced while it was being exported/i);
		expect(existsSync(destination)).toBe(false);
	});

	it('rolls publication back when activation completes during the no-clobber publish', async () => {
		const { call, destination } = exportHarness(
			{ ...originalAccount, status: 'pendingActivation' },
			'publish',
			(account) => {
				account.status = 'active';
			}
		);

		await expect(call()).rejects.toThrow(/replaced while it was being exported/i);
		expect(existsSync(destination)).toBe(false);
	});

	it('allows a status transition whose serialized maFile bytes are unchanged', async () => {
		const { call, destination, before } = exportHarness(
			{ ...originalAccount, status: 'pendingRevocationBackup' },
			'write',
			(account) => {
				account.status = 'active';
			},
			false
		);

		await expect(call()).resolves.toMatchObject({ state: 'saved' });
		expect(readFileSync(destination, 'utf8')).toBe(before);
		expect(JSON.parse(before).fully_enrolled).toBe(true);
	});

	it('allows changes only to proxy, token, and automatic-confirmation preferences', async () => {
		const { call, destination, before } = exportHarness(
			originalAccount,
			'write',
			(account) => {
				account.proxyUrl = 'socks5://user:password@127.0.0.1:1080';
				account.refreshToken = 'a-new-live-token';
				account.autoConfirm.marketListings = true;
				account.autoConfirm.notify.enabled = true;
			},
			false
		);

		await expect(call()).resolves.toMatchObject({ state: 'saved' });
		expect(readFileSync(destination, 'utf8')).toBe(before);
	});

	it('rejects a non-secret exported field changing during the write', async () => {
		const { call, destination } = exportHarness(originalAccount, 'write', (account) => {
			account.deviceId = 'android:replacement';
		});

		await expect(call()).rejects.toThrow(/replaced while it was being exported/i);
		expect(existsSync(destination)).toBe(false);
	});

	it('rolls back when exported metadata changes during publication', async () => {
		const { call, destination } = exportHarness(originalAccount, 'publish', (account) => {
			account.accountName = 'renamed-after-snapshot';
		});

		await expect(call()).rejects.toThrow(/replaced while it was being exported/i);
		expect(existsSync(destination)).toBe(false);
	});

	it('keeps activation behind the snapshot until no-clobber publication finishes', async () => {
		const current = lateCleanupHarness(
			{ ...originalAccount, status: 'pendingActivation' },
			'publish',
			false
		);
		const exporting = current.exportAccount();
		await current.reachedLateCleanup;

		const firstActivation = outcome(current.activate());
		await Promise.resolve();
		await Promise.resolve();
		const statusDuringCleanup = current.accounts[0]?.status;

		current.releaseLateCleanup();
		const [exportResult, activationResult] = await Promise.all([exporting, firstActivation]);
		expect(
			statusDuringCleanup,
			'activation overtook export after its last serialized-account check'
		).toBe('pendingActivation');
		expect(exportResult).toMatchObject({ state: 'saved' });
		if (!activationResult.ok)
			await expect(current.activate()).resolves.toMatchObject({
				state: 'activated'
			});
		expect(current.accounts[0]?.status).toBe('active');
		expect(readFileSync(current.destination, 'utf8')).toBe(current.before);
	});

	it('keeps removal behind the snapshot until permission hardening finishes', async () => {
		const current = lateCleanupHarness(originalAccount, 'chmod', false);
		const exporting = current.exportAccount();
		await current.reachedLateCleanup;

		const firstRemoval = outcome(current.deactivate());
		await Promise.resolve();
		await Promise.resolve();
		const accountPresentDuringCleanup = current.accounts.some(
			(account) => account.steamId64 === STEAM_ID
		);

		current.releaseLateCleanup();
		const [exportResult, removalResult] = await Promise.all([exporting, firstRemoval]);
		expect(
			accountPresentDuringCleanup,
			'removal overtook export after its last serialized-account check'
		).toBe(true);
		expect(exportResult).toMatchObject({ state: 'saved' });
		if (!removalResult.ok) await expect(current.deactivate()).resolves.toEqual({ ok: true });
		expect(current.accounts).toEqual([]);
		expect(readFileSync(current.destination, 'utf8')).toBe(current.before);
	});

	it('releases a failed snapshot without exposing the previous destination', async () => {
		const current = lateCleanupHarness(
			{ ...originalAccount, status: 'pendingActivation' },
			'write-failure',
			false
		);
		const exporting = outcome(current.exportAccount());
		await current.reachedLateCleanup;

		const firstActivation = outcome(current.activate());
		await Promise.resolve();
		await Promise.resolve();
		const statusDuringFailedWrite = current.accounts[0]?.status;

		current.releaseLateCleanup();
		const [exportResult, activationResult] = await Promise.all([exporting, firstActivation]);
		expect(
			statusDuringFailedWrite,
			'activation overtook an export which still owned its failing snapshot'
		).toBe('pendingActivation');
		expect(exportResult.ok).toBe(false);
		expect(existsSync(current.destination)).toBe(false);
		if (!activationResult.ok)
			await expect(current.activate()).resolves.toMatchObject({
				state: 'activated'
			});
		expect(current.accounts[0]?.status).toBe('active');
	});

	it('allows two read-only exports to hold snapshots at the same time', async () => {
		const accounts = [cloneAccount(originalAccount)];
		const destinations = [join(root, 'first.maFile'), join(root, 'second.maFile')];
		let picked = 0;
		const vault = {
			isUnlocked: () => true,
			touch: () => undefined,
			read: () => ({ accounts: accounts.map(cloneAccount) })
		} as unknown as VaultService;
		registerEnrollmentHandlers(
			{} as EnrollmentService,
			vault,
			{ show: () => Promise.resolve(destinations[picked++]) },
			undefined,
			undefined,
			undefined,
			memoryOperationJournal(),
			new VaultKeyOperationCoordinator()
		);
		const handler = handlers.get(CHANNELS.accountExport);
		if (handler === undefined) throw new Error('accountExport was not registered');

		await expect(
			Promise.all([
				handler(EVENT, { steamId64: STEAM_ID }),
				handler(EVENT, { steamId64: STEAM_ID })
			])
		).resolves.toEqual([
			{ state: 'saved', fileName: 'first.maFile' },
			{ state: 'saved', fileName: 'second.maFile' }
		]);
		expect(destinations.map((path) => readFileSync(path, 'utf8'))).toEqual([
			toMaFile(originalAccount),
			toMaFile(originalAccount)
		]);
	});
});

describe('the exported-account snapshot reservation', () => {
	it('is reference-counted and permits projection-neutral and other-account writes', () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const other = {
			...cloneAccount(originalAccount),
			steamId64: '76561198000000002',
			accountName: 'other'
		};
		const before = [cloneAccount(originalAccount), other];
		const releaseFirst = coordinator.beginAccountSnapshot(STEAM_ID);
		const releaseSecond = coordinator.beginAccountSnapshot(STEAM_ID);

		const neutral = before.map(cloneAccount);
		neutral[0]!.proxyUrl = 'socks5://127.0.0.1:1080';
		neutral[0]!.refreshToken = 'new token';
		neutral[0]!.autoConfirm.notify.enabled = true;
		neutral[1]!.accountName = 'changed other account';
		expect(() => coordinator.assertAccountSnapshotsUnchanged(before, neutral)).not.toThrow();

		const changed = before.map(cloneAccount);
		changed[0]!.deviceId = 'android:changed';
		expect(() => coordinator.assertAccountSnapshotsUnchanged(before, changed)).toThrow(
			/currently being exported/i
		);

		releaseFirst();
		expect(() => coordinator.assertAccountSnapshotsUnchanged(before, changed)).toThrow(
			/currently being exported/i
		);
		releaseFirst();
		expect(() => coordinator.assertAccountSnapshotsUnchanged(before, changed)).toThrow(
			/currently being exported/i
		);
		releaseSecond();
		expect(() => coordinator.assertAccountSnapshotsUnchanged(before, changed)).not.toThrow();
	});

	it.each([
		[
			'transfer submission',
			(value: VaultKeyOperationCoordinator, id: string) => value.beginTransferSubmission(id)
		],
		[
			'enrollment submission',
			(value: VaultKeyOperationCoordinator, id: string) => value.beginEnrollmentSubmission(id)
		],
		[
			'transfer recovery',
			(value: VaultKeyOperationCoordinator, id: string) => value.beginTransferRecovery(id)
		],
		[
			'enrollment recovery',
			(value: VaultKeyOperationCoordinator, id: string) => value.beginEnrollmentRecovery(id)
		],
		['activation', (value: VaultKeyOperationCoordinator, id: string) => value.beginActivation(id)],
		['removal', (value: VaultKeyOperationCoordinator, id: string) => value.beginDeactivation(id)]
	] as const)(
		'blocks matching %s work in both orderings without blocking another account',
		(_kind, begin) => {
			const otherId = '76561198000000002';
			const coordinator = new VaultKeyOperationCoordinator();
			const releaseSnapshot = coordinator.beginAccountSnapshot(STEAM_ID);
			expect(() => begin(coordinator, STEAM_ID)).toThrow(/currently being exported/i);

			const releaseOther = begin(coordinator, otherId);
			releaseOther();
			releaseSnapshot();

			const releaseWriter = begin(coordinator, STEAM_ID);
			expect(() => coordinator.beginAccountSnapshot(STEAM_ID)).toThrow(/operation.*changing/i);
			const releaseOtherSnapshot = coordinator.beginAccountSnapshot(otherId);
			releaseOtherSnapshot();
			releaseWriter();
		}
	);

	it('guards a real VaultService commit and preserves rejected state', async () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const vault = new VaultService({
			file: join(root, 'vault.json'),
			beforeMutationCommit: (current, next) =>
				coordinator.assertAccountSnapshotsUnchanged(current.accounts, next.accounts)
		});
		await vault.create('a sufficiently long passphrase');
		await vault.mutate((draft) => {
			draft.accounts.push({ ...cloneAccount(originalAccount), status: 'pendingActivation' });
			draft.accounts.push({
				...cloneAccount(originalAccount),
				steamId64: '76561198000000002',
				accountName: 'other'
			});
		});

		const releaseSnapshot = coordinator.beginAccountSnapshot(STEAM_ID);
		await expect(
			vault.mutate((draft) => {
				draft.accounts[0]!.proxyUrl = 'socks5://127.0.0.1:1080';
				draft.accounts[1]!.accountName = 'changed other account';
			})
		).resolves.toBeUndefined();
		await expect(
			vault.mutate((draft) => {
				draft.accounts[0]!.status = 'active';
			})
		).rejects.toThrow(/currently being exported/i);
		expect(vault.read().accounts[0]?.status).toBe('pendingActivation');
		expect(vault.read().accounts[1]?.accountName).toBe('changed other account');

		releaseSnapshot();
		await expect(
			vault.mutate((draft) => {
				draft.accounts[0]!.status = 'active';
			})
		).resolves.toBeUndefined();
		expect(vault.read().accounts[0]?.status).toBe('active');
	});

	it('keeps whole-vault replacement blocked until every snapshot releases', () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const releaseFirst = coordinator.beginAccountSnapshot(STEAM_ID);
		const releaseSecond = coordinator.beginAccountSnapshot('76561198000000002');
		expect(() => coordinator.assertNoAccountSnapshots()).toThrow(/export is still finishing/i);
		releaseFirst();
		expect(() => coordinator.assertNoAccountSnapshots()).toThrow(/export is still finishing/i);
		releaseSecond();
		expect(() => coordinator.assertNoAccountSnapshots()).not.toThrow();
	});

	it('allows an unrelated account mutation but excludes the snapshotted account', () => {
		const coordinator = new VaultKeyOperationCoordinator();
		const otherId = '76561198000000002';
		const releaseSnapshot = coordinator.beginAccountSnapshot(STEAM_ID);
		const releaseOtherMutation = coordinator.beginAccountMutation(otherId);
		releaseOtherMutation();
		expect(() => coordinator.beginAccountMutation(STEAM_ID)).toThrow(/affected account/i);
		releaseSnapshot();

		const releaseMutation = coordinator.beginAccountMutation(STEAM_ID);
		expect(() => coordinator.beginAccountSnapshot(STEAM_ID)).toThrow(/currently being.*removed/i);
		const releaseOtherSnapshot = coordinator.beginAccountSnapshot(otherId);
		releaseOtherSnapshot();
		releaseMutation();
	});
});
