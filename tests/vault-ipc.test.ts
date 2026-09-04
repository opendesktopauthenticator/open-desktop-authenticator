import { describe, expect, it } from 'vitest';
import { newAutoConfirm } from '../src/shared/vault-schema';
import {
	applyProxyChange,
	markRevocationBackedUp,
	removeAccountFrom,
	RevocationCeremony,
	toSummary
} from '../src/main/vault/ipc';
import { authenticatorFingerprint } from '../src/main/steam/authenticator-secrets';
import { accountSummary, CHANNELS, IPC_CONTRACT } from '../src/shared/ipc';

/**
 * `toSummary` is the whole boundary between stored accounts and the renderer.
 * Everything else in the vault can be right and one careless spread here would
 * hand every secret to the UI.
 */

/** A fully-populated account — every optional field present. */
const account = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	sharedSecret: 'SHARED-SECRET-VALUE',
	identitySecret: 'IDENTITY-SECRET-VALUE',
	revocationCode: 'R12345',
	deviceId: 'android:aaaa-bbbb',
	refreshToken: 'REFRESH-TOKEN-VALUE',
	proxyUrl: 'socks5h://user:PROXY-PASSWORD@host:1080',
	status: 'active',
	addedAt: '2026-08-08T00:00:00.000Z',
	autoConfirm: { ...newAutoConfirm(), marketListings: true, pollIntervalSeconds: 20 }
};

/** Every string reachable in a value. */
function values(node: unknown, found: string[] = []): string[] {
	if (typeof node === 'string') {
		found.push(node);
	} else if (Array.isArray(node)) {
		node.forEach((item) => values(item, found));
	} else if (node && typeof node === 'object') {
		Object.values(node).forEach((item) => values(item, found));
	}
	return found;
}

describe('account summaries carry no secrets', () => {
	it('drops every secret-bearing field', () => {
		const summary = toSummary(account);
		const strings = values(summary);

		for (const secret of [
			account.sharedSecret,
			account.identitySecret,
			account.revocationCode,
			account.refreshToken,
			account.proxyUrl,
			'PROXY-PASSWORD'
		]) {
			expect(strings, `leaked ${secret}`).not.toContain(secret);
		}
		// And nothing merely containing them either.
		expect(JSON.stringify(summary)).not.toMatch(/SECRET|TOKEN|PROXY-PASSWORD|R12345/);
	});

	it('reports whether a revocation code exists, not the code', () => {
		expect(toSummary(account).hasRevocationCode).toBe(true);
		const { revocationCode: _omitted, ...without } = account;
		expect(toSummary(without).hasRevocationCode).toBe(false);
	});

	it('reports whether routing is configured, not the proxy URL', () => {
		// The URL carries credentials, so even showing it read-only would leak.
		expect(toSummary(account).hasProxy).toBe(true);
		const { proxyUrl: _omitted, ...without } = account;
		expect(toSummary(without).hasProxy).toBe(false);
	});

	it('keeps the fields the UI genuinely needs', () => {
		const summary = toSummary(account);
		expect(summary.steamId64).toBe('76561198000000001');
		expect(summary.accountName).toBe('trader');
		expect(summary.status).toBe('active');
		expect(summary.autoConfirm).toEqual({
			marketListings: true,
			trades: false,
			pollIntervalSeconds: 20,
			notify: { enabled: false, detail: 'full' }
		});
	});

	/*
	 * **The other half of the round trip.** The screen renders its controls from
	 * this summary, so a value the vault holds and this drops is a control that
	 * silently shows the default — and saving from that screen then writes the
	 * default back over what the user had chosen.
	 *
	 * Asserted on a non-default value, because projecting a hard-coded default
	 * would pass against a fixture that used the default.
	 */
	it('carries the notification settings the vault actually holds', () => {
		const summary = toSummary({
			...account,
			autoConfirm: {
				...account.autoConfirm,
				notify: { enabled: true, detail: 'count' }
			}
		});
		expect(summary.autoConfirm.notify, 'the screen would render a stale control').toEqual({
			enabled: true,
			detail: 'count'
		});
	});

	/*
	 * A fresh object, like everything else that crosses. Handing out a reference
	 * into vault contents is how a screen ends up able to write to the vault by
	 * assigning to what it was shown.
	 */
	it('does not hand out a reference into the vault', () => {
		const source = {
			...account,
			autoConfirm: { ...account.autoConfirm, notify: { enabled: true, detail: 'count' as const } }
		};
		const summary = toSummary(source);
		summary.autoConfirm.notify.enabled = false;
		expect(source.autoConfirm.notify.enabled, 'the renderer wrote into the vault').toBe(true);
	});

	it('produces something the response schema accepts', () => {
		// If these ever disagree, the router rejects the response at runtime and
		// the account list silently breaks.
		expect(accountSummary.safeParse(toSummary(account)).success).toBe(true);
	});

	it('keeps the SteamID a string', () => {
		expect(typeof toSummary(account).steamId64).toBe('string');
	});

	it('marks a stale vault record with an opaque exact-record token without exposing its fingerprint', () => {
		const oldFingerprint = authenticatorFingerprint({ sharedSecret: 'OLDER-SECRET-VALUE' });
		const summary = toSummary({
			...account,
			unresolvedOperation: {
				kind: 'activate' as const,
				guidance: 'old record',
				fingerprint: oldFingerprint,
				at: '2026-01-01T00:00:00.000Z'
			}
		});

		expect(summary.unresolvedOperation).toMatchObject({ stale: true });
		expect(summary.unresolvedOperation?.staleToken).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(summary)).not.toContain(oldFingerprint);
	});

	it('gives an applicable record an opaque token without exposing its internal identity', () => {
		const currentFingerprint = authenticatorFingerprint(account);
		const operationId = '11111111-1111-4111-8111-111111111111';
		const summary = toSummary({
			...account,
			unresolvedOperation: {
				kind: 'activate' as const,
				guidance: 'check Steam',
				fingerprint: currentFingerprint,
				operationId,
				at: '2026-01-01T00:00:00.000Z'
			}
		});

		expect(summary.unresolvedOperation?.operationToken).toMatch(/^[a-f0-9]{64}$/);
		expect(summary.unresolvedOperation?.staleToken).toBeUndefined();
		expect(JSON.stringify(summary)).not.toContain(currentFingerprint);
		expect(JSON.stringify(summary)).not.toContain(operationId);
		expect(accountSummary.safeParse(summary).success).toBe(true);
	});

	it.each([
		'',
		'a'.repeat(15),
		'a'.repeat(17),
		'ABCDEF0123456789',
		'gggggggggggggggg',
		'fingerprint-for-an-older-authenticator'
	])(
		'fails an unverifiable fingerprint closed without making it discardable (%j)',
		(fingerprint) => {
			const summary = toSummary({
				...account,
				unresolvedOperation: {
					kind: 'activate' as const,
					guidance: 'unverifiable record',
					fingerprint,
					at: '2026-01-01T00:00:00.000Z'
				}
			});

			expect(summary.unresolvedOperation).toMatchObject({ unidentified: true });
			expect(summary.unresolvedOperation?.stale).toBeUndefined();
			expect(summary.unresolvedOperation?.staleToken).toBeUndefined();
			expect(accountSummary.safeParse(summary).success).toBe(true);
		}
	);

	it('fails a legacy record closed without presenting it as discardable', () => {
		const summary = toSummary({
			...account,
			unresolvedOperation: {
				kind: 'deactivate' as const,
				guidance: 'legacy record',
				at: '2026-01-01T00:00:00.000Z'
			}
		});

		expect(summary.unresolvedOperation).toMatchObject({ unidentified: true });
		expect(summary.unresolvedOperation?.stale).toBeUndefined();
		expect(summary.unresolvedOperation?.staleToken).toBeUndefined();
	});
});

describe('recording the revocation backup ceremony (§11 S12)', () => {
	const NOW = new Date('2026-08-10T12:00:00.000Z');

	function pending(): {
		steamId64: string;
		status: string;
		revocationCode?: string | undefined;
		revocationBackedUpAt?: string | undefined;
	} {
		return {
			steamId64: '76561198000000001',
			status: 'pendingRevocationBackup',
			revocationCode: 'R12345'
		};
	}

	it('clears the warning and dates the backup', () => {
		// Before this existed the ceremony had no ending: an imported account with a
		// code stayed `pendingRevocationBackup` forever, and a warning nobody can
		// clear is one people learn to look past.
		const accounts = [pending()];
		markRevocationBackedUp(accounts, '76561198000000001', NOW);

		expect(accounts[0]?.status).toBe('active');
		expect(accounts[0]?.revocationBackedUpAt).toBe('2026-08-10T12:00:00.000Z');
	});

	it('refuses an account with no code to write down', () => {
		// The warning on such an account is telling the truth — it genuinely cannot
		// be self-recovered — so there is nothing here to mark as done.
		const accounts = [{ steamId64: '76561198000000001', status: 'active' }];
		expect(() => markRevocationBackedUp(accounts, '76561198000000001', NOW)).toThrow(
			/no revocation code/
		);
	});

	it('refuses an unknown account', () => {
		expect(() => markRevocationBackedUp([pending()], '76561198000000009', NOW)).toThrow(
			/no such account/
		);
	});

	it('leaves a status that is pending for another reason alone', () => {
		// An authenticator that was never activated is not made active by writing
		// its recovery code down.
		const accounts = [{ ...pending(), status: 'pendingActivation' }];
		markRevocationBackedUp(accounts, '76561198000000001', NOW);

		expect(accounts[0]?.status).toBe('pendingActivation');
		expect(accounts[0]?.revocationBackedUpAt).toBe('2026-08-10T12:00:00.000Z');
	});

	it('touches only the account named', () => {
		const accounts = [pending(), { ...pending(), steamId64: '76561198000000002' }];
		markRevocationBackedUp(accounts, '76561198000000001', NOW);

		expect(accounts[1]?.status).toBe('pendingRevocationBackup');
		expect(accounts[1]?.revocationBackedUpAt).toBeUndefined();
	});
});

describe('routing is optional, and removable', () => {
	function accounts(): { steamId64: string; proxyUrl?: string | undefined }[] {
		return [
			{ steamId64: '76561198000000001', proxyUrl: 'socks5://old:pass@10.0.0.1:1080' },
			{ steamId64: '76561198000000002' }
		];
	}

	it('adds routing to an account that had none', () => {
		const list = accounts();
		applyProxyChange(list, '76561198000000002', 'http://10.0.0.9:8080');

		expect(list[1]?.proxyUrl).toBe('http://10.0.0.9:8080');
	});

	it('replaces routing that came in with an imported maFile', () => {
		const list = accounts();
		applyProxyChange(list, '76561198000000001', 'socks5://new:pass@10.0.0.2:1080');

		expect(list[0]?.proxyUrl).toBe('socks5://new:pass@10.0.0.2:1080');
	});

	it('REMOVES the key rather than storing an empty string', () => {
		// `''` and "unset" being the same value is how a control that looks cleared
		// leaves something behind — and here that something decides whether the
		// account can reach Steam at all.
		const list = accounts();
		applyProxyChange(list, '76561198000000001', null);

		expect(list[0]?.proxyUrl).toBeUndefined();
		expect(Object.keys(list[0] as object)).not.toContain('proxyUrl');
	});

	it('leaves every other account alone', () => {
		const list = accounts();
		applyProxyChange(list, '76561198000000001', null);

		expect(list[1]?.proxyUrl).toBeUndefined();
		expect(list).toHaveLength(2);
	});

	it('refuses an account it does not know', () => {
		expect(() => applyProxyChange(accounts(), '76561198000000009', null)).toThrow(
			/no such account/
		);
	});
});

describe('the backup ceremony cannot be short-circuited', () => {
	const CODE = 'R12345';

	it('refuses to mark a backup done before the code was shown', () => {
		// The UI presents reveal-then-confirm, but the renderer is untrusted. One
		// IPC call must not clear the warning for an account whose code nobody saw —
		// that warning is the last thing standing between a user and an
		// unrecoverable account.
		const ceremony = new RevocationCeremony();
		expect(ceremony.hasRevealed('76561198000000001', CODE)).toBe(false);
	});

	it('allows it once the code has genuinely been revealed', () => {
		const ceremony = new RevocationCeremony();
		ceremony.recordReveal('76561198000000001', CODE);

		expect(ceremony.hasRevealed('76561198000000001', CODE)).toBe(true);
		// And only for that account.
		expect(ceremony.hasRevealed('76561198000000002', CODE)).toBe(false);
	});

	it('forgets on lock, so an unlock has to show the code again', () => {
		const ceremony = new RevocationCeremony();
		ceremony.recordReveal('76561198000000001', CODE);

		ceremony.forget();

		expect(ceremony.hasRevealed('76561198000000001', CODE)).toBe(false);
	});
});

describe('changing routing discards the session made on the old route', () => {
	function accounts(): {
		steamId64: string;
		proxyUrl?: string | undefined;
		refreshToken?: string | undefined;
	}[] {
		return [
			{ steamId64: '76561198000000001', proxyUrl: 'socks5://a@10.0.0.1:1080', refreshToken: 'tok' }
		];
	}

	it('drops the saved Steam session when the proxy changes', () => {
		// The token was issued to a session Steam saw arriving from one address.
		// Carrying it to another tells Valve — and both proxy operators — that the
		// two addresses are the same person, which is the whole thing routing
		// exists to prevent.
		const list = accounts();
		const changed = applyProxyChange(list, '76561198000000001', 'socks5://b@10.0.0.2:1080');

		expect(changed).toBe(true);
		expect(list[0]?.refreshToken).toBeUndefined();
	});

	it('drops it when routing is removed entirely', () => {
		const list = accounts();
		applyProxyChange(list, '76561198000000001', null);

		expect(list[0]?.refreshToken).toBeUndefined();
	});

	it('keeps the session when the address did not actually change', () => {
		// Re-saving the same proxy should not cost the user a sign-in.
		const list = accounts();
		const changed = applyProxyChange(list, '76561198000000001', 'socks5://a@10.0.0.1:1080');

		expect(changed).toBe(false);
		expect(list[0]?.refreshToken).toBe('tok');
	});
});

describe('removing an account', () => {
	function accounts(): { steamId64: string; accountName: string }[] {
		return [
			{ steamId64: '76561198000000001', accountName: 'first' },
			{ steamId64: '76561198000000002', accountName: 'second' },
			{ steamId64: '76561198000000003', accountName: 'third' }
		];
	}

	it('removes exactly the one named', () => {
		const list = accounts();
		removeAccountFrom(list, '76561198000000002');

		expect(list.map((entry) => entry.accountName)).toEqual(['first', 'third']);
	});

	it('refuses an account it does not hold rather than removing nothing quietly', () => {
		// Silently succeeding would tell the user an account was deleted when it was
		// not, and they would go looking for it somewhere else.
		const list = accounts();
		expect(() => removeAccountFrom(list, '76561198000000009')).toThrow(/no such account/);
		expect(list).toHaveLength(3);
	});

	it('keeps fields a newer build may have added to the others', () => {
		// Splicing the draft rather than replacing it with a filtered copy: the
		// account schema is passthrough precisely so an older build does not drop
		// what a newer one wrote.
		const list = [
			{ steamId64: '76561198000000001', accountName: 'first', somethingNewer: 'keep' },
			{ steamId64: '76561198000000002', accountName: 'second' }
		];
		removeAccountFrom(list, '76561198000000002');

		expect(list[0]).toMatchObject({ somethingNewer: 'keep' });
	});
});

describe('the removal contract', () => {
	const { request } = IPC_CONTRACT[CHANNELS.accountRemove];

	it('demands the passphrase', () => {
		expect(
			request.safeParse({
				steamId64: '76561198000000001',
				passphrase: 'a sufficiently long passphrase'
			}).success
		).toBe(true);
	});

	it('refuses an acknowledgement flag, because it never meant anything', () => {
		// There used to be an `acknowledged: z.literal(true)` here, and a test
		// asserting that a caller which skipped the warning could not construct a
		// valid request. That was never true: the preload wrote the literal itself,
		// so every call carried it and none could fail to, and the main process
		// never read it.
		//
		// The schema is strict, so the field is now actively refused rather than
		// quietly ignored — a caller still sending it is working from a contract
		// that no longer exists, and should be told so.
		expect(
			request.safeParse({
				steamId64: '76561198000000001',
				passphrase: 'a sufficiently long passphrase',
				acknowledged: true
			}).success
		).toBe(false);
	});

	it('refuses a request with no passphrase', () => {
		expect(request.safeParse({ steamId64: '76561198000000001' }).success).toBe(false);
	});
});

describe('the settings contract', () => {
	const { request } = IPC_CONTRACT[CHANNELS.settingsUpdate];
	const { response } = IPC_CONTRACT[CHANNELS.settingsGet];

	it('accepts values inside the schema bounds', () => {
		expect(
			request.safeParse({
				requireProxies: false,
				autoLockMinutes: 30,
				clipboardClearSeconds: 45,
				updateCheck: true
			}).success
		).toBe(true);
	});

	it('refuses an auto-lock outside 1–240', () => {
		// A zero or negative timeout would mean "lock immediately, forever"; an
		// unbounded one is indistinguishable from switching locking off, which is
		// the outcome the setting exists to make unnecessary.
		for (const autoLockMinutes of [0, -5, 241, 1.5, Number.NaN]) {
			expect(
				request.safeParse({
					requireProxies: false,
					autoLockMinutes,
					clipboardClearSeconds: 30,
					updateCheck: true
				}).success,
				`${autoLockMinutes}`
			).toBe(false);
		}
	});

	it('refuses a clipboard delay outside 5–300', () => {
		for (const clipboardClearSeconds of [0, 4, 301, -1]) {
			expect(
				request.safeParse({
					requireProxies: false,
					autoLockMinutes: 10,
					clipboardClearSeconds,
					updateCheck: true
				}).success,
				`${clipboardClearSeconds}`
			).toBe(false);
		}
	});

	it('refuses a field the user is not allowed to set', () => {
		// `convenienceUnlock` lives in the vault schema and is deliberately not
		// writable here. Strict mode is what stops it arriving anyway.
		expect(
			request.safeParse({
				requireProxies: false,
				autoLockMinutes: 10,
				clipboardClearSeconds: 30,
				updateCheck: true,
				convenienceUnlock: true
			}).success
		).toBe(false);
	});

	it('returns only the settings a user can change, never a secret', () => {
		// The list is exhaustive on purpose. A new field arriving in the vault
		// schema must not reach the renderer just because someone added it there —
		// `convenienceUnlock` is the standing example, and it stays out.
		const parsed = response.parse({
			requireProxies: true,
			autoLockMinutes: 10,
			clipboardClearSeconds: 30,
			updateCheck: true,
			sharedSecret: 'LEAKED',
			convenienceUnlock: true
		});

		expect(Object.keys(parsed)).toEqual([
			'requireProxies',
			'autoLockMinutes',
			'clipboardClearSeconds',
			'updateCheck'
		]);
		expect(JSON.stringify(parsed)).not.toContain('LEAKED');
	});
});

/*
 * The ceremony is about a code, not about an account.
 *
 * It was a `Set` of SteamIDs, which cannot express that. Reveal code A, import a
 * maFile carrying a different code B for the same account, and confirming marked
 * B written down on the strength of having shown A — while `mergeAccount` had
 * already cleared `revocationBackedUpAt` for exactly that case, with a comment
 * saying the ceremony is owed again. The two halves disagreed, and the half that
 * won was the one that silences the warning.
 *
 * What is at stake is the last warning standing between a user and an account
 * only Steam Support can recover.
 */
describe('the ceremony is bound to the code that was shown', () => {
	const ID = '76561198000000001';

	it('refuses a code that was never displayed, even for a revealed account', () => {
		const ceremony = new RevocationCeremony();
		ceremony.recordReveal(ID, 'R11111');

		// What an import between reveal and confirm leaves behind.
		expect(ceremony.hasRevealed(ID, 'R22222')).toBe(false);
	});

	it('still accepts the code that was displayed', () => {
		const ceremony = new RevocationCeremony();
		ceremony.recordReveal(ID, 'R11111');

		expect(ceremony.hasRevealed(ID, 'R11111')).toBe(true);
	});

	it('accepts a re-reveal of the new code', () => {
		// The way out is the ceremony itself: show the new code, confirm the new
		// code. Nothing here should make that harder than it is.
		const ceremony = new RevocationCeremony();
		ceremony.recordReveal(ID, 'R11111');
		ceremony.recordReveal(ID, 'R22222');

		expect(ceremony.hasRevealed(ID, 'R22222')).toBe(true);
		// And the superseded one is no longer good enough.
		expect(ceremony.hasRevealed(ID, 'R11111')).toBe(false);
	});

	it('does not keep the code in memory in readable form', () => {
		// Only ever compared, never read back, so there is nothing to gain from a
		// second plaintext copy of a secret whose loss cannot be undone.
		const ceremony = new RevocationCeremony();
		ceremony.recordReveal(ID, 'R11111');

		expect(JSON.stringify(ceremony)).not.toContain('R11111');
	});
});
