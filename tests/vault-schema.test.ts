import { describe, expect, it } from 'vitest';
import {
	accountSchema,
	AUTO_CONFIRM_DEFAULTS,
	emptyVault,
	MIN_PASSPHRASE_LENGTH,
	newAutoConfirm,
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

/*
 * The unknown-field promise, at every level it applies to.
 *
 * The file header says a vault written by a newer build must survive an older
 * one, but only `accountSchema` had `.passthrough()`. Unknown settings,
 * auto-confirm fields and top-level fields were stripped by the very next
 * `mutate()`, which validates and writes the stripped object — deleting data a
 * newer build stored, silently, on the first save an older build made.
 */
describe('unknown fields from a newer build', () => {
	it('survive validation at the top level, in settings, and in auto-confirm', () => {
		const parsed = vaultContentsSchema.parse({
			seq: 3,
			accounts: [
				{
					steamId64: '76561198000000001',
					accountName: 'trader',
					sharedSecret: 'c2hhcmVk',
					identitySecret: 'aWRlbnRpdHk=',
					status: 'active',
					addedAt: '2026-08-08T00:00:00.000Z',
					autoConfirm: {
						marketListings: false,
						trades: false,
						pollIntervalSeconds: 15,
						futureAutoConfirmField: 'kept'
					},
					futureAccountField: 'kept'
				}
			],
			settings: {
				autoLockMinutes: 10,
				clipboardClearSeconds: 20,
				convenienceUnlock: false,
				launchAtStartup: false,
				startMinimised: false,
				updateCheck: true,
				futureSetting: 'kept'
			},
			createdAt: '2026-08-08T00:00:00.000Z',
			updatedAt: '2026-08-08T00:00:00.000Z',
			futureTopLevelField: 'kept'
		}) as Record<string, unknown>;

		expect(parsed.futureTopLevelField).toBe('kept');
		expect((parsed.settings as Record<string, unknown>).futureSetting).toBe('kept');
		const account = (parsed.accounts as Record<string, unknown>[])[0] as Record<string, unknown>;
		expect(account.futureAccountField).toBe('kept');
		expect((account.autoConfirm as Record<string, unknown>).futureAutoConfirmField).toBe('kept');
	});
});

describe('one Steam identity, one stored account', () => {
	it('refuses a vault listing the same account twice', () => {
		const entry = {
			steamId64: '76561198000000001',
			accountName: 'trader',
			sharedSecret: 'c2hhcmVk',
			identitySecret: 'aWRlbnRpdHk=',
			status: 'active',
			addedAt: '2026-08-08T00:00:00.000Z',
			autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
		};
		const result = vaultContentsSchema.safeParse({
			seq: 1,
			accounts: [entry, { ...entry, accountName: 'trader-again' }],
			createdAt: '2026-08-08T00:00:00.000Z',
			updatedAt: '2026-08-08T00:00:00.000Z'
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			// Named, because the person holding this file needs to know which
			// account to deduplicate — "not valid" alone is a lockout.
			expect(JSON.stringify(result.error.issues)).toContain('76561198000000001');
		}
	});
});

/**
 * **Confirmation notifications, and what has to survive a round trip.**
 *
 * The defaults here are a security decision, not a preference: notifications
 * are off until somebody switches them on for one account, and the disclosure
 * about what `full` prints sits beside that switch. A default that drifted to
 * `enabled: true` would put trade partners and item names on a lock screen
 * nobody had agreed to.
 */
describe('notification settings', () => {
	it('defaults to off, and to full detail', () => {
		const parsed = accountSchema.parse(account);
		expect(parsed.autoConfirm.notify.enabled, 'notifications defaulted to on').toBe(false);
		expect(parsed.autoConfirm.notify.detail).toBe('full');
	});

	it('accepts an account written before the field existed', () => {
		const parsed = accountSchema.parse({
			...account,
			autoConfirm: { marketListings: true, trades: false, pollIntervalSeconds: 30 }
		});
		expect(parsed.autoConfirm.notify).toEqual({ enabled: false, detail: 'full' });
		// The fields that were there are not disturbed by the one that was not.
		expect(parsed.autoConfirm.pollIntervalSeconds).toBe(30);
		expect(parsed.autoConfirm.marketListings).toBe(true);
	});

	/*
	 * Not covered by the two tests above, and mutation testing is how that came
	 * out: an account with no `autoConfirm` at all takes the *outer* default,
	 * and one with `autoConfirm` but no `notify` takes `notify`'s object
	 * default. Neither ever consults `detail`'s own default, so changing it to
	 * `'type'` left the suite green. This is the shape that reaches it — a
	 * partial `notify`, which is what a newer build writing only `enabled`
	 * would leave behind.
	 */
	it('fills in full when notify exists without a detail', () => {
		const parsed = accountSchema.parse({
			...account,
			autoConfirm: { ...AUTO_CONFIRM_DEFAULTS, notify: { enabled: true } }
		});
		expect(parsed.autoConfirm.notify.detail).toBe('full');
		expect(parsed.autoConfirm.notify.enabled).toBe(true);
	});

	it('refuses a detail outside the enum', () => {
		expect(() =>
			accountSchema.parse({
				...account,
				autoConfirm: { ...AUTO_CONFIRM_DEFAULTS, notify: { enabled: true, detail: 'everything' } }
			})
		).toThrow();
	});

	it('accepts exactly the floor', () => {
		// Without this, raising `min(10)` to `min(30)` refuses every interval the
		// UI offers between the two and the suite stays green.
		const parsed = accountSchema.parse({
			...account,
			autoConfirm: { ...AUTO_CONFIRM_DEFAULTS, pollIntervalSeconds: 10 }
		});
		expect(parsed.autoConfirm.pollIntervalSeconds).toBe(10);
	});

	it('still enforces the ten-second interval floor', () => {
		expect(() =>
			accountSchema.parse({
				...account,
				autoConfirm: { ...AUTO_CONFIRM_DEFAULTS, pollIntervalSeconds: 9 }
			})
		).toThrow();
	});

	/*
	 * The outer `autoConfirmSchema` has a `.passthrough()`, which protects a
	 * sibling key called `notify` — it does not protect keys *inside* it. An
	 * earlier draft of this test pointed at the outer object, where it passed
	 * without testing the thing that can actually be lost.
	 */
	it('keeps an unknown key from inside notify', () => {
		const parsed = accountSchema.parse({
			...account,
			autoConfirm: {
				...AUTO_CONFIRM_DEFAULTS,
				notify: { enabled: false, detail: 'full', sound: 'chime' }
			}
		}) as unknown as { autoConfirm: { notify: Record<string, unknown> } };
		expect(parsed.autoConfirm.notify.sound, 'a newer build lost a setting inside notify').toBe(
			'chime'
		);
	});
});

/**
 * **Two accounts added in one session must not share one `notify` object.**
 *
 * `AUTO_CONFIRM_DEFAULTS` used to be flat, so every call site spread it and
 * that was safe. `notify` made it nested, and a shallow spread copies the
 * reference — while `vault/ipc.ts` mutates `account.autoConfirm` in place. The
 * two together mean switching notifications on for one account switches them
 * on for every account added beside it, and the vault is written that way.
 */
describe('newAutoConfirm', () => {
	it('gives each account its own notify object', () => {
		const first = newAutoConfirm();
		const second = newAutoConfirm();
		first.notify.enabled = true;
		expect(second.notify.enabled, 'two accounts shared one notify object').toBe(false);
	});

	it('does not write through to the shared defaults', () => {
		newAutoConfirm().notify.enabled = true;
		expect(AUTO_CONFIRM_DEFAULTS.notify.enabled, 'the defaults themselves were mutated').toBe(
			false
		);
	});

	it('matches the schema defaults', () => {
		expect(newAutoConfirm()).toEqual(accountSchema.parse(account).autoConfirm);
	});
});

/**
 * **Nothing may hand out the module constant itself.**
 *
 * These are reference assertions, deliberately, and the reason is that the
 * value-equality version of them passed while the bug was live. zod resolves a
 * `.default()` with a *shallow* clone: the outer `autoConfirm` came back fresh
 * and the nested `notify` was the exported constant. Two accounts parsed
 * without an `autoConfirm` — a legacy vault, a hand-edited one, a recovery file
 * — therefore shared one `notify` with each other and with the defaults, so a
 * single in-place write flipped notifications on for all of them *and* for
 * every account created afterwards, for the life of the process.
 *
 * That is precisely the "off by default quietly becomes on" failure the
 * docblock above `AUTO_CONFIRM_DEFAULTS` names, so `toEqual` is not a strong
 * enough assertion to be worth writing here.
 */
describe('the defaults are never handed out by reference', () => {
	const other = { ...account, steamId64: '76561198000000002' };

	it('gives two defaulted accounts separate notify objects', () => {
		const a = accountSchema.parse(account);
		const b = accountSchema.parse(other);
		expect(a.autoConfirm.notify, 'two accounts share one notify').not.toBe(b.autoConfirm.notify);
	});

	it('never returns the exported constant itself', () => {
		const parsed = accountSchema.parse(account);
		expect(parsed.autoConfirm).not.toBe(AUTO_CONFIRM_DEFAULTS);
		expect(parsed.autoConfirm.notify, 'a parse handed back the module constant').not.toBe(
			AUTO_CONFIRM_DEFAULTS.notify
		);
	});

	it('does not let one account written to reach another, or the next parse', () => {
		const a = accountSchema.parse(account);
		a.autoConfirm.notify.enabled = true;
		expect(accountSchema.parse(other).autoConfirm.notify.enabled).toBe(false);
		expect(AUTO_CONFIRM_DEFAULTS.notify.enabled, 'the defaults were rewritten').toBe(false);
	});

	/*
	 * The backstop, in case a future default is added by value again. Freezing
	 * turns a silent process-wide corruption into a thrown error at the write.
	 */
	it('freezes the constant, nested object included', () => {
		expect(Object.isFrozen(AUTO_CONFIRM_DEFAULTS)).toBe(true);
		expect(Object.isFrozen(AUTO_CONFIRM_DEFAULTS.notify), 'the nested object is writable').toBe(
			true
		);
	});

	it('gives the partial-notify path a fresh object too', () => {
		// This one takes `notify`'s own default rather than `autoConfirm`'s.
		const a = accountSchema.parse({
			...account,
			autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
		});
		const b = accountSchema.parse({
			...other,
			autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
		});
		expect(a.autoConfirm.notify).not.toBe(b.autoConfirm.notify);
		expect(a.autoConfirm.notify).not.toBe(AUTO_CONFIRM_DEFAULTS.notify);
	});
});
