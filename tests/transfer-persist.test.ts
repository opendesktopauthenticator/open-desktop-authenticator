import { describe, expect, it, vi } from 'vitest';
import { TransferService } from '../src/main/steam/transfer';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

/*
 * What happens after Steam has rotated the authenticator.
 *
 * Every test here lives in the window where the user's phone has already
 * stopped working. The only thing that matters is that the secrets Steam issued
 * once end up on disk, or that the failure says so loudly enough to act on.
 */

const STEAM_ID = '76561198000000001';
const TOKEN = 'eyJhbGciOiJub25lIn0.eyJhdWQiOlsibW9iaWxlIl0sImV4cCI6MjAwMDAwMDAwMH0.';

const REPLACEMENT = {
	sharedSecret: 'c2hhcmVk',
	identitySecret: 'aWRlbnRpdHk=',
	revocationCode: 'R55555',
	serverTime: '1700000000',
	steamId64: STEAM_ID
};

function harness(
	options: {
		continueResult?: unknown;
		mutateThrows?: boolean;
		readsBackWrong?: boolean;
		writeRecoveryThrows?: boolean;
	} = {}
): {
	service: TransferService;
	stored: Account[];
	recoveryWrites: Account[];
	continueCalls: number;
} {
	const stored: Account[] = [];
	const recoveryWrites: Account[] = [];
	let continueCalls = 0;

	const vault = {
		read: () => ({
			accounts: options.readsBackWrong
				? stored.map((a) => ({ ...a, sharedSecret: 'something-else' }))
				: stored
		}),
		mutate: (change: (draft: { accounts: Account[] }) => void) => {
			if (options.mutateThrows) {
				return Promise.reject(new Error('disk is full'));
			}
			change({ accounts: stored });
			return Promise.resolve();
		}
	} as unknown as VaultService;

	const transports = {
		forAccount: () => Promise.resolve(vi.fn())
	} as unknown as SteamTransportFactory;

	const service = new TransferService(vault, transports, () => 0, {
		now: () => 1_700_000_000_000,
		signIn: () => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }),
		mintAccessToken: () => Promise.resolve('access'),
		startChallenge: (() => Promise.resolve({ sent: true, shape: 'protobuf' })) as never,
		continueChallenge: (() => {
			continueCalls += 1;
			return Promise.resolve(
				options.continueResult ?? { success: true, replacementToken: REPLACEMENT }
			);
		}) as never,
		writeRecovery: (account: Account) => {
			if (options.writeRecoveryThrows) {
				throw new Error('cannot write');
			}
			recoveryWrites.push(account);
		}
	});

	return {
		service,
		stored,
		recoveryWrites,
		get continueCalls(): number {
			return continueCalls;
		}
	};
}

async function readyToSubmit(h: { service: TransferService }): Promise<void> {
	await h.service.authenticate('someone', 'pw', 'QK4TX');
}

describe('storing a replacement Steam has issued', () => {
	it('writes the recovery file before the vault', async () => {
		const h = harness();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345');
		expect(h.recoveryWrites).toHaveLength(1);
		expect(h.recoveryWrites[0]?.revocationCode).toBe('R55555');
		expect(h.stored).toHaveLength(1);
	});

	it('reports the recovery code so the screen can show it', async () => {
		const h = harness();
		await readyToSubmit(h);
		const result = await h.service.completeTransfer('12345');
		expect(result.revocationCode).toBe('R55555');
		expect(result.steamId64).toBe(STEAM_ID);
	});

	it('keeps every field Steam sent', async () => {
		const h = harness();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345');
		expect(h.stored[0]?.sharedSecret).toBe('c2hhcmVk');
		expect(h.stored[0]?.identitySecret).toBe('aWRlbnRpdHk=');
		expect(h.stored[0]?.deviceId).toBeTruthy();
	});

	it('stores it as needing the recovery code written down', async () => {
		const h = harness();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345');
		expect(h.stored[0]?.status).toBe('pendingRevocationBackup');
	});
});

describe('when storing fails after Steam has already rotated', () => {
	it('does not report success', async () => {
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/could not be saved/);
	});

	it('says a recovery file exists when one does', async () => {
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/recovery file was written/);
	});

	/*
	 * The worst case: Steam has rotated, the vault will not take it, and the
	 * backup could not be written either. The code is then the only copy in
	 * existence and belongs on screen, not in a log.
	 */
	it('puts the recovery code in the error when nothing else holds it', async () => {
		const h = harness({ mutateThrows: true, writeRecoveryThrows: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/R55555/);
	});

	it('keeps the secrets so storage can be retried without asking Steam again', async () => {
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();
		expect(h.service.hasUnsaved()).toBe(true);
	});

	it('never asks Steam a second time', async () => {
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();
		await expect(h.service.retryPersist()).rejects.toThrow();
		expect(h.continueCalls).toBe(1);
	});
});

describe('when the vault takes it but does not give it back', () => {
	/*
	 * "The write did not throw" and "the secrets are on disk and decryptable" are
	 * different claims. Only the second is safe to tell somebody whose phone has
	 * just stopped being their authenticator.
	 */
	it('refuses to call a bad read-back a success', async () => {
		const h = harness({ readsBackWrong: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/does not read back/);
		expect(h.service.hasUnsaved()).toBe(true);
	});
});

describe('what it refuses before touching Steam', () => {
	it('rejects a replacement issued for a different account', async () => {
		const h = harness({
			continueResult: {
				success: true,
				replacementToken: { ...REPLACEMENT, steamId64: '76561198000000999' }
			}
		});
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/different account/);
	});

	it('rejects a replacement with no login secret', async () => {
		const h = harness({
			continueResult: {
				success: true,
				replacementToken: { ...REPLACEMENT, sharedSecret: undefined }
			}
		});
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/no login secret/);
	});

	it('rejects an empty code without spending anything', async () => {
		const h = harness();
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('   ')).rejects.toThrow();
		expect(h.continueCalls).toBe(0);
	});

	it('reports a refusal from Steam as unchanged', async () => {
		const h = harness({ continueResult: { success: false } });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/Nothing has changed/);
	});
});
