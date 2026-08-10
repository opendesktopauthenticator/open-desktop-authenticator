import { describe, expect, it } from 'vitest';
import {
	accountSchema,
	AUTO_CONFIRM_DEFAULTS,
	emptyVault,
	MIN_PASSPHRASE_LENGTH,
	passphraseProblem,
	steamId64Schema,
	vaultContentsSchema,
	VAULT_SETTINGS_DEFAULTS
} from '../src/shared/vault-schema';

const account = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	sharedSecret: 'c2hhcmVk',
	identitySecret: 'aWRlbnRpdHk=',
	status: 'active' as const,
	addedAt: '2026-08-08T00:00:00.000Z'
};

describe('SteamID64 is a string, always', () => {
	it('accepts a well-formed id', () => {
		expect(steamId64Schema.safeParse('76561198000000001').success).toBe(true);
	});

	it('rejects a number, which is how the corruption starts', () => {
		// Built with Number() rather than a literal: the literal form is itself
		// lossy, which is precisely the hazard — lint flags it, and by the time the
		// value reaches a schema it has ALREADY been rewritten. Accepting a number
		// here would mean accepting a different account's id (F-01).
		const lossy = Number('76561198000000001');
		expect(String(lossy)).not.toBe('76561198000000001');
		expect(steamId64Schema.safeParse(lossy).success).toBe(false);
	});

	it('rejects ids that are not individual SteamID64s', () => {
		for (const bad of ['', '123', '86561198000000001', '7656119800000000', 'not-an-id']) {
			expect(steamId64Schema.safeParse(bad).success, bad).toBe(false);
		}
	});
});

describe('account records', () => {
	it('defaults auto-confirm to OFF for both switches', () => {
		const parsed = accountSchema.parse(account);
		expect(parsed.autoConfirm.marketListings).toBe(false);
		expect(parsed.autoConfirm.trades).toBe(false);
		expect(AUTO_CONFIRM_DEFAULTS.marketListings).toBe(false);
		expect(AUTO_CONFIRM_DEFAULTS.trades).toBe(false);
	});

	it('refuses a poll interval below the floor', () => {
		expect(
			accountSchema.safeParse({ ...account, autoConfirm: { pollIntervalSeconds: 1 } }).success
		).toBe(false);
	});

	it('allows an account with no revocation code, since real maFiles lack them', () => {
		const parsed = accountSchema.parse(account);
		expect(parsed.revocationCode).toBeUndefined();
	});

	it('preserves fields written by a newer build', () => {
		// Dropping an unrecognised field on the next save could mean dropping a
		// secret a newer version added.
		const parsed = accountSchema.parse({ ...account, futureField: 'keep me' }) as Record<
			string,
			unknown
		>;
		expect(parsed.futureField).toBe('keep me');
	});

	it('requires a status, so an account cannot be implicitly active', () => {
		const { status: _dropped, ...withoutStatus } = account;
		expect(accountSchema.safeParse(withoutStatus).success).toBe(false);
	});

	it('knows the pre-activation states from §11 S12 and §12 F3', () => {
		for (const status of ['pendingRevocationBackup', 'pendingActivation', 'active']) {
			expect(accountSchema.safeParse({ ...account, status }).success, status).toBe(true);
		}
		expect(accountSchema.safeParse({ ...account, status: 'whatever' }).success).toBe(false);
	});
});

describe('vault contents', () => {
	it('creates an empty vault with sane defaults', () => {
		const vault = emptyVault();
		expect(vault.seq).toBe(0);
		expect(vault.accounts).toEqual([]);
		expect(vault.settings.autoLockMinutes).toBe(VAULT_SETTINGS_DEFAULTS.autoLockMinutes);
		expect(vault.settings.convenienceUnlock).toBe(false);
	});

	it('defaults convenience unlock to off (§10.3)', () => {
		expect(VAULT_SETTINGS_DEFAULTS.convenienceUnlock).toBe(false);
	});

	it('round-trips through JSON without losing anything', () => {
		const vault = emptyVault();
		vault.accounts.push(accountSchema.parse(account));
		const reparsed = vaultContentsSchema.parse(JSON.parse(JSON.stringify(vault)));
		expect(reparsed).toEqual(vault);
	});

	it('keeps the SteamID exact through a JSON round trip', () => {
		const vault = emptyVault();
		vault.accounts.push(accountSchema.parse({ ...account, steamId64: '76561199999999999' }));
		const reparsed = vaultContentsSchema.parse(JSON.parse(JSON.stringify(vault)));
		expect(reparsed.accounts[0]?.steamId64).toBe('76561199999999999');
	});

	it('rejects a negative sequence number', () => {
		expect(vaultContentsSchema.safeParse({ ...emptyVault(), seq: -1 }).success).toBe(false);
	});
});

describe('passphrase policy', () => {
	it('requires length and says there is no recovery', () => {
		const problem = passphraseProblem('short');
		expect(problem).toBeDefined();
		expect(problem).toContain('no way to recover');
	});

	it('accepts a long passphrase with no composition rules', () => {
		// Composition rules push people toward `Passw0rd!` and away from long
		// passphrases, which is the wrong direction when there is no recovery.
		expect(passphraseProblem('all lowercase words with spaces')).toBeUndefined();
		expect(passphraseProblem('a'.repeat(MIN_PASSPHRASE_LENGTH))).toBeUndefined();
	});

	it('rejects exactly one character below the minimum', () => {
		expect(passphraseProblem('a'.repeat(MIN_PASSPHRASE_LENGTH - 1))).toBeDefined();
	});
});
