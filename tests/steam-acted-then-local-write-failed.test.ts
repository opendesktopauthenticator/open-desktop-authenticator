import { describe, expect, it } from 'vitest';
import { EnrollmentService } from '../src/main/steam/enrollment';
import { EnrollmentError } from '../src/main/steam/enroll';
import type { SteamTransportFactory } from '../src/main/net/transport';
import type { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

/**
 * **Steam did it, and the local write is what failed.**
 *
 * Four branches sit after a Steam call that succeeded: an activation Steam
 * finalized that the vault could not record, an activation whose row went away
 * while Steam was answering, a Steam Guard removal the vault could not apply,
 * and one where the vault had since been given a different authenticator for
 * that account.
 *
 * All four threw a bare `EnrollmentError`, which defaults to
 * `committed: false` — "the request never reached Steam". That is the opposite
 * of what happened in every one of them. The consequence is not cosmetic now
 * that the flag decides behaviour: a non-committed error crosses IPC as an
 * ordinary failure, so the screen clears itself, re-enables the control, and
 * records nothing — for an operation Steam has already carried out. The
 * activation branch even said so in its own message, promising the application
 * "will keep offering to finish activation", which is precisely what it must
 * not do: `finalizeEnrollment` on an activated authenticator fails in a way
 * that reads as a wrong code.
 *
 * These drive the real service with the Steam half stubbed to succeed and the
 * vault stubbed to fail, which is the only interesting shape here.
 */

const ID = '76561198000000001';

/**
 * A refresh token the service will actually accept.
 *
 * The mobile audience matters: a token scoped for the Steam website cannot
 * approve confirmations, and the service refuses one before it gets anywhere
 * near the branches this file is about — which is how the first version of
 * these tests failed on `AccessTokenError` while claiming to measure a commit
 * flag.
 */
function jwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ typ: 'JWT' })}.${encode(claims)}.sig`;
}

const TOKEN = jwt({ aud: ['web', 'mobile'], exp: Math.floor(Date.now() / 1000) + 86_400 });

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: ID,
		accountName: 'trader',
		sharedSecret: 'c2hhcmVkLXNlY3JldC1ieXRlcw==',
		identitySecret: 'aWRlbnRpdHktc2VjcmV0LWJ5dGVz',
		revocationCode: 'R12345',
		refreshToken: TOKEN,
		status: 'pendingActivation',
		addedAt: '2026-01-01T00:00:00.000Z',
		...overrides
	} as unknown as Account;
}

/** A transport that hands back an access token and nothing else. */
const transports = {
	forAccount: () =>
		Promise.resolve(() =>
			Promise.resolve({
				status: 200,
				text: JSON.stringify({ response: { access_token: TOKEN } })
			})
		)
} as unknown as SteamTransportFactory;

/** A vault that reads fine and cannot be written to. */
function unwritableVault(accounts: Account[]): VaultService {
	return {
		read: () => ({ accounts }),
		verifyPassphrase: () => Promise.resolve(undefined),
		mutate: () => Promise.reject(new Error('ENOSPC: no space left on device'))
	} as unknown as VaultService;
}

async function errorFrom(run: () => Promise<unknown>): Promise<EnrollmentError> {
	try {
		await run();
	} catch (err) {
		expect(err, 'the call did not fail the way this test is about').toBeInstanceOf(EnrollmentError);
		return err as EnrollmentError;
	}
	throw new Error('the call succeeded, so there is nothing to check');
}

describe('an activation Steam accepted that could not be saved', () => {
	const service = (accounts: Account[]) =>
		new EnrollmentService(unwritableVault(accounts), transports, {
			finalizeEnrollment: () => Promise.resolve({ state: 'activated' as const })
		});

	it('says the request reached Steam', async () => {
		const err = await errorFrom(() => service([account()]).activate(ID, '12345'));

		expect(
			err.committed,
			'Steam activated the authenticator and this was reported as a request that never went, ' +
				'so the screen cleared itself and offered to finish the activation again'
		).toBe(true);
	});

	it('says Steam is known to have acted, not that it might have', async () => {
		const err = await errorFrom(() => service([account()]).activate(ID, '12345'));

		expect(err.certain, 'a certainty was reported as a maybe').toBe(true);
	});

	/*
	 * The message promised the retry loop the flag now prevents. A sentence that
	 * describes behaviour the application no longer has is its own defect.
	 */
	it('no longer promises to keep offering the activation', async () => {
		const err = await errorFrom(() => service([account()]).activate(ID, '12345'));

		expect(err.message.toLowerCase()).not.toContain('keep offering to finish activation');
		expect(err.message).toMatch(/will not ask Steam to activate it again/i);
	});
});

describe('a removal Steam performed that could not be applied locally', () => {
	const service = (accounts: Account[]) =>
		new EnrollmentService(unwritableVault(accounts), transports, {
			removeAuthenticator: () => Promise.resolve()
		});

	it('says the request reached Steam', async () => {
		const err = await errorFrom(() =>
			service([account({ status: 'active' })]).deactivate(ID, 'a passphrase long enough')
		);

		expect(
			err.committed,
			'Steam Guard was removed from the account and this was reported as a request that never ' +
				'went, so the screen offered the removal again'
		).toBe(true);
	});

	it('says Steam is known to have acted', async () => {
		const err = await errorFrom(() =>
			service([account({ status: 'active' })]).deactivate(ID, 'a passphrase long enough')
		);

		expect(err.certain).toBe(true);
	});

	/* And it still says the thing the user most needs to know. */
	it('still says the account is unprotected', async () => {
		const err = await errorFrom(() =>
			service([account({ status: 'active' })]).deactivate(ID, 'a passphrase long enough')
		);

		expect(err.message).toMatch(/no longer protected/i);
	});
});
