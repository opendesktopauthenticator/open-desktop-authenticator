import { describe, expect, it, vi } from 'vitest';
import { TransferService } from '../src/main/steam/transfer';
import { TransferApiError } from '../src/main/steam/transfer-api';
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

/** A real encoded reply, so the retry path decodes rather than pretends. */
function goodReply(): Buffer {
	const token = Buffer.concat([
		Buffer.from([0x0a, 0x06]),
		Buffer.from('shared', 'utf8'),
		Buffer.from([0x1a, 0x06]),
		Buffer.from('R55555', 'utf8'),
		// server_time (field 5) is uint64 — a varint, not a length-delimited field.
		// Getting that wrong produced a body protobufjs read past the end of.
		Buffer.from([0x28, 0x80, 0xe2, 0xcf, 0xaa, 0x06]),
		Buffer.from([0x42, 0x08]),
		Buffer.from('identity', 'utf8'),
		(() => {
			const b = Buffer.alloc(9);
			b[0] = 0x61;
			b.writeBigUInt64LE(76561198000000001n, 1);
			return b;
		})()
	]);
	return Buffer.concat([Buffer.from([0x08, 0x01]), Buffer.from([0x12, token.length]), token]);
}

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
		continueThrows?: boolean;
		continueError?: Error;
		rawReply?: Buffer;
		now?: () => number;
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
		now: options.now ?? (() => 1_700_000_000_000),
		signIn: () => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }),
		mintAccessToken: () => Promise.resolve('access'),
		startChallenge: (() => Promise.resolve({ sent: true, shape: 'protobuf' })) as never,
		continueChallenge: ((_t: unknown, _a: unknown, _c: unknown, onRaw?: (body: Buffer) => void) => {
			continueCalls += 1;
			if (options.rawReply) {
				onRaw?.(options.rawReply);
			}
			if (options.continueThrows) {
				return Promise.reject(options.continueError ?? new Error('unreadable'));
			}
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

describe('when Steam answers but the reply cannot be read', () => {
	/*
	 * The most dangerous branch in the feature. Steam did not refuse, so the
	 * authenticator has very likely rotated — and the only copy of what replaced
	 * it is the bytes that just failed to parse. Losing them costs the account.
	 */
	it('does not say it failed, because it probably did not', async () => {
		const h = harness({ continueThrows: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(
			/probably been replaced already/
		);
	});

	it('keeps the reply so it can be read again', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();
		expect(h.service.hasUnreadReply()).toBe(true);
	});

	it('can decode and store it on a second attempt, without asking Steam', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();

		const result = await h.service.retryDecode();
		expect(result.revocationCode).toBe('R55555');
		expect(h.stored).toHaveLength(1);
		expect(h.continueCalls).toBe(1);
	});
});

describe('bugs found by reading the flow rather than exercising it', () => {
	/*
	 * A retry after a bad read-back must not store the account twice.
	 *
	 * `persist` pushes unconditionally. If the vault write succeeds and only the
	 * read-back check fails, the account is already in the vault — and `unsaved`
	 * is deliberately kept so the user can retry. Pressing "try again" then
	 * pushes the same SteamID a second time.
	 *
	 * Two records for one account is not cosmetic: they hold the same secrets,
	 * every list shows the account twice, and removing "the" account leaves a
	 * copy of live authenticator secrets behind.
	 */
	it('does not store the account twice when a retry follows a bad read-back', async () => {
		let faithful = false;
		const stored: Account[] = [];
		const vault = {
			read: () => ({
				// Fails the read-back the first time, passes the second.
				accounts: faithful ? stored : stored.map((a) => ({ ...a, sharedSecret: 'wrong' }))
			}),
			mutate: (change: (draft: { accounts: Account[] }) => void) => {
				change({ accounts: stored });
				return Promise.resolve();
			}
		} as unknown as VaultService;

		const service = new TransferService(
			vault,
			{ forAccount: () => Promise.resolve(vi.fn()) } as unknown as SteamTransportFactory,
			() => 0,
			{
				now: () => 1_700_000_000_000,
				signIn: () => Promise.resolve({ refreshToken: TOKEN, steamId64: STEAM_ID }),
				mintAccessToken: () => Promise.resolve('access'),
				continueChallenge: () => Promise.resolve({ success: true, replacementToken: REPLACEMENT }),
				writeRecovery: () => undefined
			}
		);

		await service.authenticate('someone', 'pw', 'QK4TX');
		await expect(service.completeTransfer('12345')).rejects.toThrow(/does not read back/);

		faithful = true;
		await service.retryPersist();

		expect(stored.filter((a) => a.steamId64 === STEAM_ID)).toHaveLength(1);
	});

	/*
	 * The pending record must not lapse while secrets are unstored.
	 *
	 * `live()` drops the pending transfer once the TTL passes, and `retryDecode`
	 * needs it for the SteamID it validates against. The status channel calls
	 * `current()`, which calls `live()` — so a poll fifteen minutes after a failed
	 * decode silently destroys the ability to read a reply whose secrets exist
	 * nowhere else. The authenticator has already rotated by then.
	 */
	it('keeps the transfer alive while an unread reply is held', async () => {
		let clock = 1_700_000_000_000;
		const h = harness({ continueThrows: true, rawReply: goodReply(), now: () => clock });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();

		// The user reads the error, finds their phone, comes back.
		clock += 20 * 60_000;
		h.service.current();

		expect(h.service.hasUnreadReply()).toBe(true);
		await expect(h.service.retryDecode()).resolves.toMatchObject({ revocationCode: 'R55555' });
	});

	it('keeps the transfer alive while unsaved secrets are held', async () => {
		let clock = 1_700_000_000_000;
		const h = harness({ mutateThrows: true, now: () => clock });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();

		clock += 20 * 60_000;
		h.service.current();

		expect(h.service.hasUnsaved()).toBe(true);
	});
});

describe('when Steam refuses the request outright', () => {
	/*
	 * A non-200 is Steam declining to act: rate limit, expired token, malformed
	 * request. Nothing rotated. Reporting that as "your authenticator has
	 * probably been replaced, do not close this window" is false, and frightening
	 * in a way that invites exactly the wrong reaction.
	 */
	it('does not claim the authenticator was replaced', async () => {
		const h = harness({
			continueThrows: true,
			continueError: new TransferApiError(
				'Steam is rate-limiting these requests. Wait several minutes before asking again.',
				429
			)
		});
		await readyToSubmit(h);
		const err = await h.service
			.completeTransfer('12345')
			.then(() => undefined)
			.catch((e: unknown) => e as Error);

		expect(err?.message).toMatch(/rate-limiting/);
		expect(err?.message).not.toMatch(/probably been replaced/);
	});

	it('holds nothing, because nothing was issued', async () => {
		const h = harness({
			continueThrows: true,
			continueError: new TransferApiError('Steam refused the code (HTTP 401).', 401)
		});
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();
		expect(h.service.hasUnsaved()).toBe(false);
		expect(h.service.hasUnreadReply()).toBe(false);
	});
});

describe('the guards around holding secrets', () => {
	it('refuses to abandon a transfer whose secrets are unsaved', async () => {
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();
		// The renderer can reach this channel whenever it likes.
		expect(() => h.service.cancel()).toThrow(/cannot be abandoned/);
		expect(h.service.hasUnsaved()).toBe(true);
	});

	it('abandons freely before Steam has been asked', async () => {
		const h = harness();
		await readyToSubmit(h);
		expect(() => h.service.cancel()).not.toThrow();
		expect(h.service.current()).toBeUndefined();
	});

	/*
	 * A refusal from Steam leaves nothing worth keeping. Holding the reply would
	 * make the session immortal and offer to re-read a body with nothing in it.
	 */
	it('drops the reply when Steam rejects the code', async () => {
		const h = harness({
			continueResult: { success: false },
			rawReply: Buffer.from([0x08, 0x00])
		});
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/did not accept/);
		expect(h.service.hasUnreadReply()).toBe(false);
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
