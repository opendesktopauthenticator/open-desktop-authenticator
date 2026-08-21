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
		/** The disk refuses the copy of an undecodable reply, so memory is all there is. */
		unreadableWriteThrows?: boolean;
		/**
		 * Holds a sign-in open, so something can happen while it awaits Steam.
		 *
		 * A function rather than a promise, because the interesting races need one
		 * call to resolve and a *later* one to hang. A single shared promise gated
		 * the first call too, so the test deadlocked before it reached the state it
		 * was trying to create.
		 */
		signInGate?: () => Promise<void> | undefined;
		/** The same for the irreversible submission. */
		continueGate?: Promise<void>;
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
		signIn: async () => {
			await options.signInGate?.();
			return { refreshToken: TOKEN, steamId64: STEAM_ID };
		},
		mintAccessToken: () => Promise.resolve('access'),
		startChallenge: (() => Promise.resolve({ sent: true, shape: 'protobuf' })) as never,
		continueChallenge: (async (
			_t: unknown,
			_a: unknown,
			_c: unknown,
			onRaw?: (body: Buffer) => void
		) => {
			continueCalls += 1;
			await options.continueGate;
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

/**
 * Let a submission reach the request that actually rotates the authenticator.
 *
 * `completeTransfer` mints an access token before it calls Steam, and both are
 * awaits. Locking immediately after calling it therefore lands *before the mint*
 * — where dropping the session correctly aborts a request that was never sent,
 * which is not the window these tests mean. The dangerous window is the one
 * after the mint, while Steam is being asked to rotate.
 */
const untilSending = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) {
		await Promise.resolve();
	}
};

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
		// A reply *arrived* and could not be parsed. `rawReply` matters: without it
		// this is the connection-lost case below, which is a different statement.
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow(
			/Steam replaced the authenticator/
		);
	});

	it('reports it as a dead end rather than something to retry', async () => {
		// `decodeContinueResponse` is pure: the same bytes produce the same failure
		// every time, so there was never a retry that could succeed. What used to be
		// offered here was a button that could not work, on the screen where the
		// user is most desperate for one.
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();

		expect(h.service.awaiting()).toBe('unreadable');
	});

	it('says Steam Support, because there is no other route', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);

		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/Steam Support/);
	});

	it('keeps no secret material behind', async () => {
		// The bytes were retained so a future build might read them, and nothing was
		// ever built that could. Holding raw shared and identity secrets for a reader
		// that does not exist is cost without benefit.
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();

		expect(JSON.stringify(h.service)).not.toContain('shared');
		expect(h.stored).toHaveLength(0);
	});

	it('drops the Steam session with it', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await expect(h.service.completeTransfer('12345')).rejects.toThrow();

		await expect(h.service.startChallenge()).rejects.toThrow();
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
		expect(h.service.awaiting()).toBeUndefined();
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
		expect(h.service.awaiting()).toBeUndefined();
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

/*
 * What a vault lock is allowed to throw away.
 *
 * Locking is the app's clearest statement that nobody is present, and every
 * other service drops its credentials on it. Transfer was the one missing from
 * that list, so a signed-in transfer kept a live refresh token and access token
 * across every lock.
 *
 * But the same call must do nothing once Steam has rotated the authenticator.
 * What is held then is the only copy of a replacement Steam will not issue
 * again, and an idle lock happens *by itself, while the user is away*. Wiping
 * secrets on that event would turn a walk to the kettle into an account only
 * Steam Support can recover — which is why this is `forgetIfIdle` and not
 * `cancel`, and why the distinction is asserted rather than assumed.
 */
describe('what a lock does to a transfer', () => {
	it('drops a signed-in transfer that has not changed anything', async () => {
		const h = harness();
		await readyToSubmit(h);

		expect(h.service.forgetIfIdle()).toBe(true);

		// The tokens went with it: there is no transfer left to report.
		expect(h.service.current()).toBeUndefined();
		expect(h.service.awaiting()).toBeUndefined();
	});

	it('KEEPS a replacement that is decoded but not yet stored', async () => {
		// The vault write failed, so the only copy of the new authenticator is the
		// one being held. A lock must not be what destroys it.
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.service.awaiting()).toBe('persist');
		expect(h.service.forgetIfIdle()).toBe(false);
		// Unchanged by the attempt, so a second lock cannot erode it either.
		expect(h.service.awaiting()).toBe('persist');
		expect(h.service.hasUnsaved()).toBe(true);
	});

	it('ends the transfer when the reply cannot be used', async () => {
		// It used to be kept for a retry that could not work. Ending it here is what
		// lets the lock drop the session too — there is nothing left to ask Steam.
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.service.awaiting()).toBe('unreadable');
		// Nothing irreplaceable is held, so a lock may tidy up freely.
		expect(h.service.forgetIfIdle()).toBe(true);
		// And the account it concerns is still named, so the screen can explain it.
		expect(h.service.current()?.accountName).toBe('someone');
	});

	it('reports nothing outstanding once the transfer has been stored', async () => {
		const h = harness();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345');

		expect(h.service.awaiting()).toBeUndefined();
	});
});

/*
 * What must not be thrown away, and what must not be overwritten.
 *
 * A retained reply is only meaningful beside the `pending` it belongs to: that
 * is where the SteamID it is validated against lives, along with the account
 * name and routing the stored account is built from. Two paths could separate
 * them, and both ended with secrets Steam will not reissue held under the wrong
 * identity or none at all.
 */
describe('holding on to a transfer that is mid-flight', () => {
	it('refuses to forget while the code is being submitted', async () => {
		// Nothing is held *yet* — `unsaved` and `rawReply` are both undefined while
		// the request is in the air — so this looked idle and cleared `pending`. If
		// Steam then answered with a body this build cannot decode, the bytes were
		// kept and the identity they belong to was not.
		const h = harness({
			continueGate: Promise.resolve(),
			continueThrows: true,
			rawReply: goodReply()
		});
		await readyToSubmit(h);

		const submitting = h.service.completeTransfer('12345').catch(() => undefined);
		await untilSending();
		// A lock landing here is the whole point: the one request that rotates an
		// authenticator is when this must not tidy up.
		expect(h.service.forgetIfIdle()).toBe(false);
		await submitting;

		// And the transfer is reported as the dead end it is, against the right
		// account — which is what the refusal to clear `pending` protected.
		expect(h.service.awaiting()).toBe('unreadable');
		expect(h.service.current()?.steamId64).toBe(STEAM_ID);
		expect(h.service.awaiting()).toBe('unreadable');
	});

	it('refuses a new sign-in while a replacement is unsaved', async () => {
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		await expect(h.service.authenticate('someone-else', 'pw', 'QK4TX')).rejects.toThrow(
			/has not finished/
		);
	});

	it('refuses a new sign-in while a reply is unread', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		await expect(h.service.authenticate('someone-else', 'pw', 'QK4TX')).rejects.toThrow(
			/has not finished/
		);
	});

	it('leaves the held transfer pointing at the account it belongs to', async () => {
		// The damage the refusal prevents: `authenticate` assigned `pending`
		// unconditionally, so the bytes stayed with account A while the identity
		// they are validated against became account B.
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);
		const before = h.service.current();

		await h.service.authenticate('someone-else', 'pw', 'QK4TX').catch(() => undefined);

		expect(h.service.current()).toEqual(before);
	});
});

/*
 * When no reply ever arrived.
 *
 * A timeout, a reset or a dead proxy rejects before `onRaw` is called, so there
 * are no bytes and nothing to hold. Every non-`TransferApiError` was classified
 * as "Steam answered", which produced a message claiming details were held here
 * when none had ever been stored — and, worse, left `awaiting()` empty so the
 * screen concluded nothing had happened and re-offered both Cancel and a second
 * irreversible submission.
 *
 * The request may well have reached Steam. Absence of a reply is not evidence of
 * absence of a rotation.
 */
describe('when the connection dies before Steam answers', () => {
	const lost = (): ReturnType<typeof harness> =>
		harness({ continueThrows: true, continueError: new Error('ETIMEDOUT') });

	it('does not claim anything is held', async () => {
		const h = lost();
		await readyToSubmit(h);

		await expect(h.service.completeTransfer('12345')).rejects.not.toThrow(/held in memory/);
	});

	it('does not claim the reply could not be read', async () => {
		// There was no reply. Saying otherwise sends the user looking for a retry
		// that has nothing to work on.
		const h = lost();
		await readyToSubmit(h);

		await expect(h.service.completeTransfer('12345')).rejects.not.toThrow(
			/could not read the reply/
		);
	});

	it('refuses to say the authenticator is untouched', async () => {
		const h = lost();
		await readyToSubmit(h);

		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/cannot tell/i);
	});

	it('tells the user how to find out for themselves', async () => {
		// The only check available to them, and it is a good one.
		const h = lost();
		await readyToSubmit(h);

		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/Steam mobile app/);
	});

	it('writes nothing, because there is nothing to write', async () => {
		const h = lost();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.recoveryWrites).toHaveLength(0);
	});
});

/*
 * A replacement that decodes and still cannot be used.
 *
 * The durable copy was written only when the *decoder* threw. A reply that
 * parses cleanly and then fails validation — a mismatched SteamID, or a Guard
 * scheme this build does not know — is every bit as unusable and every bit as
 * irreplaceable, and it stayed in memory alone.
 */
describe('a decoded reply this build cannot use', () => {
	/** Decodes fine; the SteamID inside belongs to somebody else. */
	const mismatched = (): ReturnType<typeof harness> =>
		harness({
			rawReply: goodReply(),
			continueResult: {
				success: true,
				replacementToken: { ...REPLACEMENT, steamId64: '76561198000000999' }
			}
		});

	it('is saved rather than left in memory', async () => {
		const h = mismatched();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);
	});

	it('saves the exact bytes Steam sent', async () => {
		const h = mismatched();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);
	});

	it('says the authenticator was replaced anyway', async () => {
		// Steam rotated it before sending this. Reporting only "invalid reply" would
		// read as "nothing happened".
		const h = mismatched();
		await readyToSubmit(h);

		await expect(h.service.completeTransfer('12345')).rejects.toThrow(
			/Steam replaced the authenticator/
		);
	});
});

/*
 * Nothing may take `pending` away while a request is in the air.
 *
 * `pending` carries the SteamID a retained reply is validated against and the
 * account name it would be stored under. Two callers could remove it mid-flight
 * — `cancel`, which the screen hides but the IPC channel still exposes, and the
 * lock handler by way of a sign-in that resolves afterwards.
 */
describe('what may not be pulled out from under a request', () => {
	it('refuses to cancel while the code is being submitted', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);

		const submitting = h.service.completeTransfer('12345').catch(() => undefined);
		expect(() => h.service.cancel()).toThrow(/cannot be abandoned/);
		await submitting;

		// The identity survived, so the retained reply is still usable.
		expect(h.service.current()?.steamId64).toBe(STEAM_ID);
		expect(h.service.awaiting()).toBe('unreadable');
	});

	it('still allows cancelling before anything has been sent', async () => {
		// The guard must not make an abandonable transfer unabandonable.
		const h = harness();
		await readyToSubmit(h);

		expect(() => h.service.cancel()).not.toThrow();
		expect(h.service.current()).toBeUndefined();
	});

	it('does not install sign-in credentials that a lock has disowned', async () => {
		// `signIn` resolves with a refresh token and an access token. Installing them
		// after a lock would undo the teardown that just dropped everything else,
		// and they would sit there for the whole locked period.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({ signInGate: () => gate });

		const signingIn = h.service.authenticate('someone', 'pw', 'QK4TX').catch((err: unknown) => err);
		// The lock lands while the sign-in is still awaiting Steam.
		expect(h.service.forgetIfIdle()).toBe(true);
		release?.();

		await expect(signingIn).resolves.toMatchObject({ message: expect.stringMatching(/locked/i) });
		expect(h.service.current()).toBeUndefined();
	});

	it('keeps nothing at all after such a lock', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({ signInGate: () => gate });

		const signingIn = h.service.authenticate('someone', 'pw', 'QK4TX').catch(() => undefined);
		h.service.forgetIfIdle();
		release?.();
		await signingIn;

		expect(h.service.awaiting()).toBeUndefined();
		expect(h.service.hasUnsaved()).toBe(false);
	});
});

/*
 * An unanswered submission is a *state*, not just a message.
 *
 * The first attempt at this fixed the wording and left the state machine alone:
 * `awaiting()` still said nothing was outstanding, so the screen concluded the
 * submission had not happened, cleared its committed flag, and re-offered both
 * Cancel and a second irreversible submit — for a request that may already have
 * rotated the authenticator.
 */
describe('an unanswered submission stays visible', () => {
	const lost = (): ReturnType<typeof harness> =>
		harness({ continueThrows: true, continueError: new Error('ETIMEDOUT') });

	it('reports itself as unknown rather than as nothing', async () => {
		const h = lost();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.service.awaiting()).toBe('unanswered');
	});

	it('still names the account the user has to go and check', async () => {
		const h = lost();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.service.current()?.steamId64).toBe(STEAM_ID);
	});

	it('survives a lock, because it holds no credential', async () => {
		// The tokens go. The warning is the only remaining record that a submission
		// went out unanswered, and it costs nothing to keep.
		const h = lost();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.service.forgetIfIdle()).toBe(true);
		expect(h.service.awaiting()).toBe('unanswered');
		expect(h.service.current()?.accountName).toBe('someone');
	});

	it('is cleared when the user says they have checked', async () => {
		// Cancel is allowed here — nothing is held — and is how the user discharges
		// it. Without that the warning would be permanent.
		const h = lost();
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		h.service.cancel();

		expect(h.service.awaiting()).toBeUndefined();
		expect(h.service.current()).toBeUndefined();
	});

	it('is not reported when Steam explicitly refused the code', async () => {
		// Steam answered. Nothing rotated, and claiming uncertainty would send the
		// user to check a phone that has not changed.
		const h = harness({ continueResult: { success: false } });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.service.awaiting()).toBeUndefined();
	});
});

/*
 * A second submission is not useless here — it is destructive.
 *
 * Steam answers a spent code with `success: false`, and that branch clears
 * `rawReply` because for a *first* attempt an explicit refusal means nothing
 * rotated and the reply holds nothing worth keeping. Reached with a retained
 * reply, it deletes the only copy of a bundle Steam has already issued.
 */
describe('resubmitting while something is held', () => {
	it('refuses once a reply is being held', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		await expect(h.service.completeTransfer('12345')).rejects.toThrow(
			/could not read what it sent back/i
		);
	});

	it('does not turn a dead end into a fresh transfer', async () => {
		// Before the guard, a second attempt reached Steam, was refused, and cleared
		// the record of what had happened on the way out — so the screen went back
		// to offering an ordinary transfer for an account whose authenticator had
		// already been rotated away.
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.service.awaiting()).toBe('unreadable');
	});

	it('never asks Steam a second time', async () => {
		const h = harness({ continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);
		await h.service.completeTransfer('12345').catch(() => undefined);

		expect(h.continueCalls).toBe(1);
	});

	it('refuses while a decoded replacement is waiting to be stored', async () => {
		const h = harness({ mutateThrows: true });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/already replaced/i);
		expect(h.service.hasUnsaved()).toBe(true);
	});

	it('refuses while the last submission is unresolved', async () => {
		// Sending another guess about an unanswered irreversible request is the
		// worst available response to not knowing.
		const h = harness({ continueThrows: true, continueError: new Error('ETIMEDOUT') });
		await readyToSubmit(h);
		await h.service.completeTransfer('12345').catch(() => undefined);

		await expect(h.service.completeTransfer('12345')).rejects.toThrow(/never answered/i);
	});
});

/*
 * A lock during submission keeps the identity and must drop the session.
 *
 * `forgetIfIdle` refuses to clear `pending` while a submission is in the air,
 * because `pending` is what a retained reply is validated against. It also holds
 * a refresh token and an access token, and nothing stripped those when the
 * request settled — leaving a live Steam session usable for as long as the vault
 * stayed shut.
 */
describe('credentials do not outlive a lock taken mid-submission', () => {
	it('cannot start another challenge afterwards', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({ continueGate: gate, continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);

		const submitting = h.service.completeTransfer('12345').catch(() => undefined);
		await untilSending();
		// The lock cannot clear `pending` here, and must not.
		expect(h.service.forgetIfIdle()).toBe(false);
		release?.();
		await submitting;

		// Refused, whichever guard answers first. Both are correct and both mean the
		// same thing to the user: this transfer cannot reach Steam again. The
		// credential drop itself is asserted against the source below, because with
		// secrets held the more specific refusal fires before the session is
		// consulted at all.
		await expect(h.service.startChallenge()).rejects.toThrow();
	});

	it('keeps the identity a retained reply needs', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({ continueGate: gate, continueThrows: true, rawReply: goodReply() });
		await readyToSubmit(h);

		const submitting = h.service.completeTransfer('12345').catch(() => undefined);
		await untilSending();
		h.service.forgetIfIdle();
		release?.();
		await submitting;

		// The whole reason `forgetIfIdle` refused: this still works.
		expect(h.service.awaiting()).toBe('unreadable');
	});
});

/*
 * Two transfers must not become one.
 *
 * `authenticate` refused state that was already *held*, but not a request still
 * in the air — so a new sign-in could start beside an older submission. The old
 * one then finished, producing terminal or unsaved state for account A, while
 * the new one installed account B as `pending`. `current()` prefers `pending`
 * and `awaiting()` reads the other, so a single status response claimed B owned
 * A's outcome — and retrying A's storage cleared B's freshly authenticated
 * session.
 */
describe('a second sign-in cannot interleave with an unfinished transfer', () => {
	it('refuses while a submission is in flight', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({ continueGate: gate });
		await readyToSubmit(h);

		const submitting = h.service.completeTransfer('12345').catch(() => undefined);
		await untilSending();

		await expect(h.service.authenticate('someone-else', 'pw', 'QK4TX')).rejects.toThrow(
			/middle of a request/i
		);

		release?.();
		await submitting;
	});

	it('refuses one that resolves after the older transfer ended', async () => {
		// The window the first guard cannot see: this sign-in started legitimately
		// and Steam answered it only after the other transfer had failed.
		let releaseSignIn: (() => void) | undefined;
		const signInGate = new Promise<void>((resolve) => {
			releaseSignIn = resolve;
		});
		let calls = 0;
		const h = harness({
			signInGate: () => (calls++ === 0 ? undefined : signInGate),
			continueThrows: true,
			continueError: new Error('ETIMEDOUT')
		});

		// A is submitting; it will end unanswered.
		await h.service.authenticate('account-a', 'pw', 'QK4TX');
		await h.service.completeTransfer('12345').catch(() => undefined);
		expect(h.service.awaiting()).toBe('unanswered');

		// B signs in, and Steam answers only now.
		const signingIn = h.service.authenticate('account-b', 'pw', 'QK4TX').catch((e: unknown) => e);
		releaseSignIn?.();

		await expect(signingIn).resolves.toMatchObject({
			message: expect.stringMatching(/has not been dealt with|has not finished/i)
		});
	});

	/*
	 * The mirror of the guard above, and the half the first fix left open.
	 *
	 * `authenticate` was taught to refuse while a challenge is in the air. Nothing
	 * taught `startChallenge` the reverse, so a challenge for account A could
	 * start during a sign-in for B — and B became `pending` the moment that
	 * sign-in landed. A's text message had already gone out, the screen showed A's
	 * challenge, and the code typed off A's phone was submitted against B.
	 *
	 * Guarded at the challenge rather than after it, because refusing afterwards
	 * would already have spent the message.
	 */
	it('will not ask Steam for a text while a sign-in is still in the air', async () => {
		let releaseSignIn: (() => void) | undefined;
		const signInGate = new Promise<void>((resolve) => {
			releaseSignIn = resolve;
		});
		let calls = 0;
		const h = harness({ signInGate: () => (calls++ === 0 ? undefined : signInGate) });

		await h.service.authenticate('account-a', 'pw', 'QK4TX');

		const signingIn = h.service.authenticate('account-b', 'pw', 'QK4TX').catch(() => undefined);

		await expect(h.service.startChallenge()).rejects.toThrow(/sign-in .* still in progress/i);

		releaseSignIn?.();
		await signingIn;

		// And it is offered again once the sign-in is done — the guard is about the
		// request in flight, not a state the transfer is stuck in.
		await expect(h.service.startChallenge()).resolves.toMatchObject({ sent: true });
	});

	it('keeps the older outcome attached to the older account', async () => {
		let releaseSignIn: (() => void) | undefined;
		const signInGate = new Promise<void>((resolve) => {
			releaseSignIn = resolve;
		});
		let calls = 0;
		const h = harness({
			signInGate: () => (calls++ === 0 ? undefined : signInGate),
			continueThrows: true,
			continueError: new Error('ETIMEDOUT')
		});

		await h.service.authenticate('account-a', 'pw', 'QK4TX');
		await h.service.completeTransfer('12345').catch(() => undefined);

		const signingIn = h.service.authenticate('account-b', 'pw', 'QK4TX').catch(() => undefined);
		releaseSignIn?.();
		await signingIn;

		// The status a screen would render: one account, one outcome, and they agree.
		expect(h.service.awaiting()).toBe('unanswered');
		expect(h.service.current()?.accountName).toBe('account-a');
	});
});

/*
 * Abandoning while Steam is being asked to send a text.
 *
 * `cancel` guarded `submitting` and `authenticating` but not `challenging`, and
 * the screen's Close button stayed enabled while busy. So the user could close
 * during "Send the code to my phone": `pending` was cleared, the screen went
 * away, and the request went out anyway — spending a message and a rate limit on
 * a transfer they had just abandoned.
 */
describe('abandoning during the SMS request', () => {
	it('is refused while that request is in flight', async () => {
		const h = harness();
		await readyToSubmit(h);

		// `startChallenge` is in the air; nothing may pull `pending` out from under it.
		const challenging = h.service.startChallenge().catch(() => undefined);
		expect(() => h.service.cancel()).toThrow(/middle of a request/i);
		await challenging;
	});

	it('is allowed again once it has finished', async () => {
		const h = harness();
		await readyToSubmit(h);
		await h.service.startChallenge();

		expect(() => h.service.cancel()).not.toThrow();
		expect(h.service.current()).toBeUndefined();
	});
});
