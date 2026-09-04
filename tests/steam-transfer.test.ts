import { describe, expect, it, vi } from 'vitest';
import { TransferError, TransferService } from '../src/main/steam/transfer';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';

/*
 * The first step of moving an authenticator off the Steam mobile app.
 *
 * Everything here stops short of asking Steam to change anything. That is the
 * property most worth holding on to: a user can start this, abandon it, and
 * find their phone exactly as they left it.
 */

const TOKEN = 'eyJhbGciOiJub25lIn0.eyJhdWQiOlsibW9iaWxlIl0sImV4cCI6MjAwMDAwMDAwMH0.';

function vaultHolding(steamIds: string[] = []): VaultService {
	return {
		read: () => ({ accounts: steamIds.map((steamId64) => ({ steamId64 })) })
	} as unknown as VaultService;
}

const transports = { forAccount: vi.fn() } as unknown as SteamTransportFactory;

function service(options: {
	signIn?: unknown;
	held?: string[];
	now?: () => number;
	monotonicNow?: () => number;
}): TransferService {
	const signIn =
		options.signIn ??
		(() =>
			Promise.resolve({
				refreshToken: TOKEN,
				accessToken: 'access',
				steamId64: '76561198000000001'
			}));
	return new TransferService(vaultHolding(options.held), transports, () => 0, {
		now: options.now ?? (() => 1_000_000),
		...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
		signIn: signIn as never
	});
}

describe('authenticating an account whose authenticator is being moved', () => {
	it('sends the Guard code the user read off the phone', async () => {
		const signIn = vi.fn((request: { steamGuardCode?: string }) => {
			void request;
			return Promise.resolve({ refreshToken: TOKEN, steamId64: '76561198000000001' });
		});
		await service({ signIn }).authenticate('someone', 'pw', 'qk4tx');
		expect(signIn.mock.calls[0]?.[0]).toMatchObject({ steamGuardCode: 'QK4TX' });
	});

	it('does not derive a code, because there is no secret to derive one from', async () => {
		const signIn = vi.fn((request: { sharedSecret?: string }) => {
			void request;
			return Promise.resolve({ refreshToken: TOKEN, steamId64: '76561198000000001' });
		});
		await service({ signIn }).authenticate('someone', 'pw', 'QK4TX');
		expect(signIn.mock.calls[0]?.[0]).not.toHaveProperty('sharedSecret');
	});

	it('reports the account it authenticated', async () => {
		const outcome = await service({}).authenticate('someone', 'pw', 'QK4TX');
		expect(outcome).toEqual({
			state: 'authenticated',
			steamId64: '76561198000000001',
			accountName: 'someone'
		});
	});

	it('refuses an empty code without spending a sign-in', async () => {
		const signIn = vi.fn();
		await expect(service({ signIn }).authenticate('someone', 'pw', '  ')).rejects.toThrow(
			TransferError
		);
		expect(signIn).not.toHaveBeenCalled();
	});

	/*
	 * Steam rotates the authenticator the instant the SMS code is accepted. A
	 * collision found after that point leaves the user holding secrets nothing
	 * saved, so it has to be found here.
	 */
	it('refuses an account this app already holds, before anything irreversible', async () => {
		await expect(
			service({ held: ['76561198000000001'] }).authenticate('someone', 'pw', 'QK4TX')
		).rejects.toThrow(/already holds an authenticator/);
	});

	it('keeps no pending transfer when the duplicate check refuses', async () => {
		const svc = service({ held: ['76561198000000001'] });
		await expect(svc.authenticate('someone', 'pw', 'QK4TX')).rejects.toThrow();
		expect(svc.current()).toBeUndefined();
	});

	it('refuses when Steam does not say which account signed in', async () => {
		const signIn = vi.fn(() => Promise.resolve({ refreshToken: TOKEN }));
		await expect(service({ signIn }).authenticate('someone', 'pw', 'QK4TX')).rejects.toThrow(
			/which account/
		);
	});
});

describe('what the transfer never exposes', () => {
	it('keeps tokens off everything a caller can reach', async () => {
		const svc = service({});
		await svc.authenticate('someone', 'pw', 'QK4TX');
		const visible = JSON.stringify(svc.current());
		expect(visible).not.toContain(TOKEN);
		expect(visible).not.toContain('access');
	});

	it('never puts the password or the code into the error it raises', async () => {
		const signIn = vi.fn(() =>
			Promise.reject(new Error('Steam refused: password=hunter2 code=QK4TX'))
		);
		const err = await service({ signIn })
			.authenticate('someone', 'hunter2', 'QK4TX')
			.then(() => undefined)
			.catch((e: unknown) => e as Error);
		expect(err?.message).not.toContain('hunter2');
		expect(err?.message).not.toContain('QK4TX');
	});
});

describe('the pending transfer', () => {
	it('lapses rather than lingering', async () => {
		let wall = 1_000_000;
		let elapsed = 10_000;
		const svc = service({ now: () => wall, monotonicNow: () => elapsed });
		await svc.authenticate('someone', 'pw', 'QK4TX');
		expect(svc.current()).toBeDefined();

		// Wall time is timestamp provenance, not credential age. An operating-system
		// clock correction must not silently discard or prolong the signed-in session.
		wall += 24 * 60 * 60_000;
		expect(svc.current()).toBeDefined();

		elapsed += 16 * 60_000;
		expect(svc.current()).toBeUndefined();
	});

	it('can be abandoned, leaving the phone untouched', async () => {
		const svc = service({});
		await svc.authenticate('someone', 'pw', 'QK4TX');
		svc.cancel();
		expect(svc.current()).toBeUndefined();
	});

	it('refuses a second sign-in while one is in flight', async () => {
		let release = (): void => {};
		const signIn = vi.fn(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ refreshToken: TOKEN, steamId64: '76561198000000001' });
				})
		);
		const svc = service({ signIn });
		const first = svc.authenticate('someone', 'pw', 'QK4TX');
		await expect(svc.authenticate('someone', 'pw', 'QK4TX')).rejects.toThrow(/already in progress/);
		release();
		await first;
	});
});
