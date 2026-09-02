import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportError, ImportService, type StagedFile } from '../src/main/import/service';
import { VaultLockedError, VaultService } from '../src/main/vault/service';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

/**
 * Import staging and commit (§12 F2).
 *
 * The rules worth testing here are the destructive ones. Importing a file the
 * user already has is the operation that can lose a revocation code — the one
 * secret whose loss cannot be undone — so most of this suite is about what a
 * replace must *not* throw away.
 *
 * Stubbed down to the accepted scrypt floor like the other vault suites; the
 * shipping parameters are asserted in `vault-crypto.test.ts`.
 */
vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const PASS = 'a sufficiently long passphrase';

/**
 * Twenty bytes, base64 — the shape Steam actually issues.
 *
 * These fixtures used to carry short placeholder strings and every test passed.
 * Validating the secret at import time failed the whole suite immediately, which
 * is the check doing its job: a secret that short could never produce a code.
 */
const SECRET = 'ASNFZ4mrze8BI0VniavN7wEjRWc=';
/* A second enrollment's secrets. Twenty bytes, like the first: a shorter
   string is rejected as unusable before any of this is reached. */
const SECOND_SECRET = 'ICEiIyQlJicoKSorLC0uLzAxMjM=';
const SECOND_IDENTITY = 'c2Vjb25kLWlkZW50aXR5LXNlY3I=';
const REPLACEMENT_SECRET = '/ty6mHZUMhD+3LqYdlQyEP7cupg=';
/** The same twenty bytes as SECRET, written the way some tools write them. */
const HEX_SECRET = '0123456789abcdef0123456789abcdef01234567';
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

let dir: string;
let clock: number;
let vault: VaultService;
let imports: ImportService;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'import-service-'));
	clock = NOW;
	vault = new VaultService({ file: join(dir, 'vault.json'), now: () => clock });
	await vault.create(PASS);
	imports = new ImportService(vault, { now: () => clock });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function file(overrides: Record<string, unknown> = {}, name = 'a.maFile'): StagedFile {
	return {
		name,
		text: JSON.stringify({
			shared_secret: SECRET,
			identity_secret: 'aWRlbnRpdHk=',
			account_name: 'trader',
			revocation_code: 'R12345',
			steamid: '76561198000000001',
			...overrides
		})
	};
}

/** Stage one file and return its id. */
function stageOne(staged: StagedFile): string {
	const report = imports.stage([staged]);
	const id = report.candidates[0]?.stagingId;
	if (!id) {
		throw new Error(`nothing staged: ${JSON.stringify(report.rejected)}`);
	}
	return id;
}

describe('staging', () => {
	it('requires an unlocked vault', () => {
		vault.lock();
		expect(() => imports.stage([file()])).toThrow(VaultLockedError);
	});

	it('reports a candidate without exposing any secret', () => {
		const report = imports.stage([file()]);
		const candidate = report.candidates[0];

		expect(candidate?.accountName).toBe('trader');
		expect(candidate?.steamId64).toBe('76561198000000001');
		expect(candidate?.hasRevocationCode).toBe(true);
		expect(candidate?.importable).toBe(true);

		// The whole report, serialised, must not contain a single stored secret.
		const serialised = JSON.stringify(report);
		expect(serialised).not.toContain(SECRET);
		expect(serialised).not.toContain('aWRlbnRpdHk=');
		expect(serialised).not.toContain('R12345');
	});

	it('rejects an unparseable file by name and reason, and keeps going', () => {
		const report = imports.stage([
			{ name: 'broken.maFile', text: 'nonsense' },
			file({}, 'good.maFile')
		]);

		expect(report.rejected).toHaveLength(1);
		expect(report.rejected[0]?.sourceName).toBe('broken.maFile');
		expect(report.candidates).toHaveLength(1);
	});

	it('writes a recovery file for an account it newly stored', () => {
		// Only enrollment wrote one, so importing a maFile and later deleting it left
		// the account with no safety net — and an imported account is the most likely
		// one to be removed and then wanted back.
		const stored: Account[] = [];
		const importing = new ImportService(vault, {
			now: () => clock,
			onAccountStored: (a) => stored.push(a)
		});
		const report = importing.stage([file()]);
		const id = report.candidates[0]?.stagingId ?? '';

		return importing
			.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }])
			.then(() => {
				expect(stored).toHaveLength(1);
				// From the stored account, so the backup holds what the vault holds.
				expect(stored[0]?.steamId64).toBe('76561198000000001');
				expect(stored[0]?.sharedSecret).toBe(SECRET);
				expect(stored[0]?.revocationCode).toBe('R12345');
			});
	});

	it('does not write one again when an import replaces an account', () => {
		// A recovery file already exists for it, `writeRecoveryFile` refuses to
		// overwrite one, and a copy per re-import would pile up files that make the
		// real one harder to identify.
		const stored: Account[] = [];
		const importing = new ImportService(vault, {
			now: () => clock,
			onAccountStored: (a) => stored.push(a)
		});

		const first = importing.stage([file()]);
		return importing
			.commit([
				{
					stagingId: first.candidates[0]?.stagingId ?? '',
					replaceExisting: false,
					adoptProxy: false
				}
			])
			.then(() => {
				const again = importing.stage([file()]);
				return importing.commit([
					{
						stagingId: again.candidates[0]?.stagingId ?? '',
						replaceExisting: true,
						adoptProxy: false
					}
				]);
			})
			.then(() => {
				expect(stored).toHaveLength(1);
			});
	});

	it('writes a fresh one when a replacement changes the secrets', () => {
		/*
		 * The gap the two tests above left between them.
		 *
		 * One asserted that a new account gets a recovery file; the other that a
		 * replace does not write a second one. Both were true and neither covered
		 * the case that matters: re-enrolling an account gives it *different*
		 * secrets, and importing that maFile replaced them in the vault while the
		 * recovery file on disk still held the old ones.
		 *
		 * Nothing failed. Recovery simply restored secrets Steam had already
		 * stopped accepting — the mechanism breaking at the only moment it is ever
		 * used, silently, months after the import that caused it.
		 */
		const stored: Account[] = [];
		const importing = new ImportService(vault, {
			now: () => clock,
			onAccountStored: (a) => stored.push(a)
		});

		const first = importing.stage([file()]);
		return importing
			.commit([
				{
					stagingId: first.candidates[0]?.stagingId ?? '',
					replaceExisting: false,
					adoptProxy: false
				}
			])
			.then(() => {
				// The same account, re-enrolled: new shared and identity secrets, new
				// revocation code.
				const reEnrolled = importing.stage([
					file({
						shared_secret: SECOND_SECRET,
						identity_secret: SECOND_IDENTITY,
						revocation_code: 'R54321'
					})
				]);
				return importing.commit([
					{
						stagingId: reEnrolled.candidates[0]?.stagingId ?? '',
						replaceExisting: true,
						adoptProxy: false
					}
				]);
			})
			.then(() => {
				expect(stored, 'the new secrets need a backup of their own').toHaveLength(2);
				// And it carries what the vault now holds, not what it used to.
				expect(stored[1]?.sharedSecret).toBe(SECOND_SECRET);
				expect(stored[1]?.revocationCode).toBe('R54321');
			});
	});

	it('writes a fresh one when a replacement brings a revocation code the first lacked', () => {
		// The revocation code on its own, because it is the field that decides
		// whether an account can be detached without Steam Support. A recovery file
		// written before the code was known is missing the single most valuable
		// thing in it, and the import that supplied it must produce a new one.
		const stored: Account[] = [];
		const importing = new ImportService(vault, {
			now: () => clock,
			onAccountStored: (a) => stored.push(a)
		});

		// The first file has no revocation code at all.
		const withoutCode = file();
		const parsed = JSON.parse(withoutCode.text) as Record<string, unknown>;
		delete parsed.revocation_code;
		withoutCode.text = JSON.stringify(parsed);

		const first = importing.stage([withoutCode]);
		return importing
			.commit([
				{
					stagingId: first.candidates[0]?.stagingId ?? '',
					replaceExisting: false,
					adoptProxy: false
				}
			])
			.then(() => {
				expect(stored[0]?.revocationCode).toBeUndefined();
				// The same secrets, but this time the file carries the code.
				const withCode = importing.stage([file()]);
				return importing.commit([
					{
						stagingId: withCode.candidates[0]?.stagingId ?? '',
						replaceExisting: true,
						adoptProxy: false
					}
				]);
			})
			.then(() => {
				expect(stored, 'the code is worth a backup of its own').toHaveLength(2);
				expect(stored[1]?.revocationCode).toBe('R12345');
			});
	});

	it('does not write one for a replacement that only renames the account', () => {
		// The other half of the same rule: a backup per re-import would pile up
		// files and make the one that matters harder to find.
		const stored: Account[] = [];
		const importing = new ImportService(vault, {
			now: () => clock,
			onAccountStored: (a) => stored.push(a)
		});

		const first = importing.stage([file()]);
		return importing
			.commit([
				{
					stagingId: first.candidates[0]?.stagingId ?? '',
					replaceExisting: false,
					adoptProxy: false
				}
			])
			.then(() => {
				const renamed = importing.stage([file({ account_name: 'trader-renamed' })]);
				return importing.commit([
					{
						stagingId: renamed.candidates[0]?.stagingId ?? '',
						replaceExisting: true,
						adoptProxy: false
					}
				]);
			})
			.then(() => {
				expect(stored).toHaveLength(1);
			});
	});

	it('still imports when the recovery file cannot be written', () => {
		const importing = new ImportService(vault, {
			now: () => clock,
			onAccountStored: () => {
				throw new Error('disk is gone');
			}
		});
		const report = importing.stage([file()]);

		return importing
			.commit([
				{
					stagingId: report.candidates[0]?.stagingId ?? '',
					replaceExisting: false,
					adoptProxy: false
				}
			])
			.then((outcomes) => {
				expect(outcomes[0]?.result).toBe('imported');
				expect(vault.read().accounts).toHaveLength(1);
			});
	});

	it('carries the fidelity fields Steam issued, so a round trip is not lossy', () => {
		// The vault stores these for export fidelity — its schema says a maFile
		// written without them "is a lossy copy of the one Steam handed us". Import
		// read none of them, so importing a file and exporting it again blanked
		// exactly the fields the vault was keeping to avoid that.
		const report = imports.stage([
			file({ token_gid: 'abc123', uri: 'otpauth://totp/Steam:trader?secret=X', secret_1: 's1' })
		]);
		const id = report.candidates[0]?.stagingId ?? '';

		return imports
			.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }])
			.then(() => {
				const stored = vault.read().accounts[0];
				expect(stored?.tokenGid).toBe('abc123');
				expect(stored?.uri).toBe('otpauth://totp/Steam:trader?secret=X');
				expect(stored?.secret1).toBe('s1');
			});
	});

	it('reads a nineteen-digit serial number without rounding it', () => {
		// Steam serials are past `Number.MAX_SAFE_INTEGER` and SDA writes them
		// unquoted, so `JSON.parse` hands back a rounded number — the F-01 hazard on
		// a field nobody looks at because, until now, nothing read it.
		const serial = '4370724135835866880';
		const text = `{"shared_secret":"${SECRET}","identity_secret":"aWRlbnRpdHk=","account_name":"trader","steamid":"76561198000000001","serial_number":${serial}}`;
		const report = imports.stage([{ name: 'a.maFile', text }]);
		const id = report.candidates[0]?.stagingId ?? '';

		return imports
			.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }])
			.then(() => {
				expect(vault.read().accounts[0]?.serialNumber).toBe(serial);
				// The check that matters: a naive parse produces a different serial.
				expect(String(Number(serial))).not.toBe(serial);
			});
	});

	it('warns when the identity secret is damaged, even though codes will work', () => {
		// The shared-secret gate exists so a damaged file is caught here rather than
		// discovered days later. The identity secret had no such check, so a file
		// with a broken one imported as a good account, generated codes correctly,
		// and failed at the first confirmation with nothing connecting the two.
		const report = imports.stage([file({ identity_secret: 'not-a-secret' })]);

		expect(report.candidates[0]?.warnings.join(' ')).toMatch(/confirmations/i);
		// Still importable: codes work, and an account that can generate them is
		// worth having. The two failures are not the same size.
		expect(report.candidates[0]?.importable).toBe(true);
	});

	it('marks a file with no SteamID as not importable rather than inventing one', () => {
		const report = imports.stage([
			{
				name: 'notes.maFile',
				text: JSON.stringify({ shared_secret: 's', identity_secret: 'i', account_name: 'a' })
			}
		]);

		expect(report.candidates[0]?.importable).toBe(false);
		expect(report.candidates[0]?.steamId64).toBeUndefined();
	});

	it('refuses a file whose shared secret cannot generate codes', () => {
		// Otherwise the import succeeds and the account sits on the list forever
		// as a row that never shows a number, with nothing explaining why.
		const report = imports.stage([file({ shared_secret: 'obviously not base64 !!' })]);

		expect(report.candidates[0]?.importable).toBe(false);
		expect(report.candidates[0]?.warnings.some((w) => w.includes('not usable'))).toBe(true);
	});

	it('accepts a hex shared secret, which some tools write', () => {
		const report = imports.stage([file({ shared_secret: HEX_SECRET })]);

		expect(report.candidates[0]?.importable).toBe(true);
	});

	it('marks an account already in the vault as a duplicate', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push(existingAccount());
		});

		const report = imports.stage([file()]);
		expect(report.candidates[0]?.duplicate).toBe('vault');
	});

	it('marks the second copy of the same account within one pick', () => {
		const report = imports.stage([file({}, 'one.maFile'), file({}, 'two.maFile')]);

		expect(report.candidates[0]?.duplicate).toBeUndefined();
		expect(report.candidates[1]?.duplicate).toBe('selection');
	});

	it('prefers the more complete file when one pick has the account twice', () => {
		// Order used to decide this, so a stripped working copy listed first beat a
		// backup that still had the revocation code — quietly discarding the one
		// field whose loss cannot be undone.
		const report = imports.stage([
			file({ revocation_code: undefined }, 'stripped.maFile'),
			file({}, 'backup.maFile')
		]);

		expect(report.candidates[0]?.sourceName).toBe('stripped.maFile');
		expect(report.candidates[0]?.duplicate).toBe('selection');
		expect(report.candidates[1]?.sourceName).toBe('backup.maFile');
		expect(report.candidates[1]?.duplicate).toBeUndefined();
		expect(report.candidates[1]?.hasRevocationCode).toBe(true);
	});

	it('still lists them in the order they were chosen', () => {
		const report = imports.stage([
			file({ revocation_code: undefined }, 'first.maFile'),
			file({}, 'second.maFile')
		]);

		expect(report.candidates.map((c) => c.sourceName)).toEqual(['first.maFile', 'second.maFile']);
	});

	it('refuses to stage anything while the vault is locked', () => {
		vault.lock();
		// The IPC layer calls this before it reads a single byte off disk: staging
		// discovers a locked vault only after every chosen file is already in memory,
		// and discarding the staging afterwards cannot un-read them.
		expect(() => imports.assertUnlocked()).toThrow(VaultLockedError);
	});

	it('replaces a previous staging rather than accumulating secrets', () => {
		imports.stage([file({}, 'one.maFile'), file({ steamid: '76561198000000002' }, 'two.maFile')]);
		expect(imports.stagedCount()).toBe(2);

		imports.stage([file({}, 'one.maFile')]);
		expect(imports.stagedCount()).toBe(1);
	});

	it('reports nothing staged once the staging has expired', () => {
		imports.stage([file()]);
		clock += 11 * 60_000;
		expect(imports.stagedCount()).toBe(0);
	});
});

describe('commit', () => {
	it('writes an account into the vault', async () => {
		const id = stageOne(file());
		const outcomes = await imports.commit([
			{ stagingId: id, replaceExisting: false, adoptProxy: false }
		]);

		expect(outcomes[0]?.result).toBe('imported');

		const stored = vault.read().accounts[0];
		expect(stored?.steamId64).toBe('76561198000000001');
		expect(stored?.sharedSecret).toBe(SECRET);
		expect(stored?.revocationCode).toBe('R12345');
		expect(stored?.addedAt).toBe(new Date(NOW).toISOString());
	});

	it('lands in pendingRevocationBackup so the backup ceremony still happens', async () => {
		const id = stageOne(file());
		await imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }]);

		expect(vault.read().accounts[0]?.status).toBe('pendingRevocationBackup');
	});

	it('is active when there is no revocation code to back up', async () => {
		const id = stageOne(file({ revocation_code: undefined }));
		await imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }]);

		const stored = vault.read().accounts[0];
		// Nothing to back up, so `pendingRevocationBackup` would be a state it could
		// never leave. The missing code shows as a permanent flag instead.
		expect(stored?.status).toBe('active');
		expect(stored?.revocationCode).toBeUndefined();
	});

	it('is pendingActivation when the file says enrollment never finished', async () => {
		const id = stageOne(file({ fully_enrolled: false }));
		await imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }]);

		expect(vault.read().accounts[0]?.status).toBe('pendingActivation');
	});

	it('clears staging afterwards, so the secrets do not linger', async () => {
		const id = stageOne(file());
		await imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }]);

		expect(imports.stagedCount()).toBe(0);
	});

	it('skips a duplicate unless replacement was asked for', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push(existingAccount());
		});

		const id = stageOne(file());
		const outcomes = await imports.commit([
			{ stagingId: id, replaceExisting: false, adoptProxy: false }
		]);

		expect(outcomes[0]?.result).toBe('skipped');
		expect(vault.read().accounts).toHaveLength(1);
		expect(vault.read().accounts[0]?.accountName).toBe('original');
	});

	it('imports only one of two files describing the same account', async () => {
		const report = imports.stage([file({}, 'one.maFile'), file({}, 'two.maFile')]);
		const outcomes = await imports.commit(
			report.candidates.map((candidate) => ({
				stagingId: candidate.stagingId,
				replaceExisting: false,
				adoptProxy: false
			}))
		);

		expect(outcomes.map((outcome) => outcome.result)).toEqual(['imported', 'skipped']);
		expect(vault.read().accounts).toHaveLength(1);
	});

	it('refuses the whole commit when an id is stale, rather than importing a subset', async () => {
		const id = stageOne(file());
		imports.discard();

		await expect(
			imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }])
		).rejects.toThrow(ImportError);
		expect(vault.read().accounts).toHaveLength(0);
	});

	it('refuses an expired staging', async () => {
		const id = stageOne(file());
		clock += 11 * 60_000;

		await expect(
			imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }])
		).rejects.toThrow(/took too long/);
	});

	it('does not rewrite the vault at all when nothing was selected', async () => {
		stageOne(file());
		const before = vault.read().seq;
		await imports.commit([]);

		// Not merely "no account appeared": no save happened. A pointless save
		// re-seals the vault and rotates the backup, and the one file that must
		// never be lost should not be rewritten for nothing.
		expect(vault.read().accounts).toHaveLength(0);
		expect(vault.read().seq).toBe(before);
		expect(imports.stagedCount()).toBe(0);
	});

	it('refuses a damaged secret even if the renderer asks for it anyway', async () => {
		// `importable: false` is advice to the UI. The rule that keeps unusable
		// secrets out of the vault must not depend on the caller respecting it.
		const report = imports.stage([file({ shared_secret: 'obviously not base64 !!' })]);
		const id = report.candidates[0]?.stagingId ?? '';

		const outcomes = await imports.commit([
			{ stagingId: id, replaceExisting: false, adoptProxy: false }
		]);

		expect(outcomes[0]?.result).toBe('skipped');
		expect(outcomes[0]?.reason).toMatch(/damaged/);
		expect(vault.read().accounts).toHaveLength(0);
	});
});

describe('replacing an existing account', () => {
	it('updates the secrets and the name', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push(existingAccount());
		});

		const id = stageOne(file({ shared_secret: REPLACEMENT_SECRET, account_name: 'renamed' }));
		const outcomes = await imports.commit([
			{ stagingId: id, replaceExisting: true, adoptProxy: false }
		]);

		expect(outcomes[0]?.result).toBe('replaced');
		const stored = vault.read().accounts[0];
		expect(stored?.sharedSecret).toBe(REPLACEMENT_SECRET);
		expect(stored?.accountName).toBe('renamed');
		expect(vault.read().accounts).toHaveLength(1);
	});

	it('NEVER drops a stored revocation code the incoming file lacks', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push(existingAccount());
		});

		// A file written by a tool that strips revocation codes. Overwriting would
		// destroy the only copy of it in existence.
		const id = stageOne(file({ revocation_code: undefined }));
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		expect(vault.read().accounts[0]?.revocationCode).toBe('R99999');
	});

	/*
	 * **And when the file carries the key with nothing in it, which is the form
	 * this application itself writes.**
	 *
	 * `export.ts` emits `revocation_code: account.revocationCode ?? ''` for an
	 * account that has no code, so exporting and re-importing produced exactly
	 * this file. The parser accepted `''` as a real code — while the warning
	 * beside it, which tests `!data.revocation_code`, had already said the file
	 * had none — and `mergeAccount` resolves with `??`, for which `''` is not
	 * nullish. So the stored code lost to an empty string: the one loss the
	 * merge docblock says a replace can never cause.
	 */
	it('NEVER drops a stored revocation code for an empty one in the file', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push(existingAccount());
		});

		const id = stageOne(file({ revocation_code: '' }));
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		expect(
			vault.read().accounts[0]?.revocationCode,
			'an empty string in the file overwrote the only copy of the revocation code in existence'
		).toBe('R99999');
	});

	it('NEVER drops a stored device id for an empty one in the file', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({ ...existingAccount(), deviceId: 'android:kept-device-id' });
		});
		const before = vault.read().accounts[0]?.deviceId;
		expect(before, 'the fixture carries no device id, so this asserts nothing').toBeDefined();

		const id = stageOne(file({ device_id: '' }));
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		expect(vault.read().accounts[0]?.deviceId).toBe(before);
	});

	it('keeps settings the user chose in the app', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({
				...existingAccount(),
				autoConfirm: { ...newAutoConfirm(), marketListings: true, pollIntervalSeconds: 30 },
				proxyUrl: 'http://kept:secret@127.0.0.1:1080'
			});
		});

		const id = stageOne(file());
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		const stored = vault.read().accounts[0];
		// `notify` is here because the schema materialises its default on write,
		// not because import chose it. Asserted in full rather than with
		// `objectContaining`: this test exists to prove import does not quietly
		// replace what the user set, and a partial match would stop noticing if a
		// later field started arriving with a value nobody asked for.
		expect(stored?.autoConfirm).toEqual({
			marketListings: true,
			trades: false,
			pollIntervalSeconds: 30,
			notify: { enabled: false, detail: 'full' }
		});
		expect(stored?.proxyUrl).toBe('http://kept:secret@127.0.0.1:1080');
		// The account was added when it was added; re-importing is not adding it.
		expect(stored?.addedAt).toBe('2026-08-01T00:00:00.000Z');
	});

	it('keeps unknown fields written by a newer build', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({ ...existingAccount(), somethingNewer: 'preserve me' });
		});

		const id = stageOne(file());
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		expect(vault.read().accounts[0]).toMatchObject({ somethingNewer: 'preserve me' });
	});

	it('keeps the backup as done when the revocation code is unchanged', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({
				...existingAccount(),
				revocationCode: 'R12345',
				revocationBackedUpAt: '2026-08-02T00:00:00.000Z',
				status: 'active'
			});
		});

		const id = stageOne(file());
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		const stored = vault.read().accounts[0];
		expect(stored?.revocationBackedUpAt).toBe('2026-08-02T00:00:00.000Z');
		expect(stored?.status).toBe('active');
	});

	it('demands the ceremony again when the file brings a different revocation code', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({
				...existingAccount(),
				revocationBackedUpAt: '2026-08-02T00:00:00.000Z',
				status: 'active'
			});
		});

		// The code the user wrote down is no longer the code that is stored.
		const id = stageOne(file({ revocation_code: 'R55555' }));
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		const stored = vault.read().accounts[0];
		expect(stored?.revocationCode).toBe('R55555');
		expect(stored?.revocationBackedUpAt).toBeUndefined();
		expect(stored?.status).toBe('pendingRevocationBackup');
	});

	/**
	 * Regression: a maFile carrying a proxy used to configure routing on import
	 * with no opt-in. It was found the first time real maFiles were imported — the
	 * files came from a trading setup and every one of them carried a proxy that
	 * had long since stopped working. Routing fails closed by design, so the
	 * result was accounts that could not reach Steam at all, reported as a raw
	 * `net::ERR_TUNNEL_CONNECTION_FAILED` from a proxy the user never chose.
	 */
	describe('a proxy inside a maFile', () => {
		it('is not adopted unless asked for', async () => {
			const id = stageOne(file({ Session: { proxy: 'http://user:secret@127.0.0.1:1080' } }));
			await imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }]);

			expect(vault.read().accounts[0]?.proxyUrl).toBeUndefined();
		});

		it('is adopted when asked for', async () => {
			const id = stageOne(file({ Session: { proxy: 'http://user:secret@127.0.0.1:1080' } }));
			await imports.commit([{ stagingId: id, replaceExisting: false, adoptProxy: true }]);

			expect(vault.read().accounts[0]?.proxyUrl).toBe('http://user:secret@127.0.0.1:1080');
		});

		/*
		 * **A first import, so there is nothing to tear down.** This used to import
		 * over an existing account and still expect silence, which was only true
		 * because the check compared the proxy alone — while the import replaced
		 * the account's shared and identity secrets. See the credentials test
		 * below for what that missed.
		 */
		/*
		 * **Rewritten around what it was actually for.** It asserted that the
		 * teardown hook stayed silent, which held only because the check compared
		 * the proxy alone — this same import replaces the account's shared and
		 * identity secrets, so the teardown is now correct and firing. The
		 * property the test exists to protect is that declining the file's proxy
		 * leaves the stored one alone, and that is asserted directly.
		 */
		it('leaves the stored proxy alone when the file proxy was declined', async () => {
			const id = stageOne(file({ Session: { proxy: 'http://user:secret@127.0.0.1:1080' } }));
			await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

			const stored = vault.read().accounts[0];
			expect(stored?.proxyUrl, "the file's proxy was adopted without being asked for").not.toBe(
				'http://user:secret@127.0.0.1:1080'
			);
		});

		it('declining does not clear routing the user set in the app', async () => {
			// "Do not adopt this file's proxy" is not "switch this account's routing
			// off". A re-import must not silently undo a setting made elsewhere.
			await vault.mutate((draft) => {
				draft.accounts.push({
					...existingAccount(),
					proxyUrl: 'http://chosen:secret@127.0.0.1:1080'
				});
			});

			const id = stageOne(file({ Session: { proxy: 'socks5://from-file@10.0.0.1:1080' } }));
			await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

			expect(vault.read().accounts[0]?.proxyUrl).toBe('http://chosen:secret@127.0.0.1:1080');
		});
	});

	it('notifies when a replace changes the stored proxy URL', async () => {
		const onRoutingChanged = vi.fn();
		imports = new ImportService(vault, { now: () => clock, onRoutingChanged });

		await vault.mutate((draft) => {
			draft.accounts.push({
				...existingAccount(),
				proxyUrl: 'http://old:secret@127.0.0.1:1080'
			});
		});

		const id = stageOne(
			file({
				Session: { proxy: 'http://new:secret@10.0.0.1:1080' }
			})
		);
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: true }]);

		expect(onRoutingChanged).toHaveBeenCalledWith('76561198000000001');
		expect(vault.read().accounts[0]?.proxyUrl).toBe('http://new:secret@10.0.0.1:1080');
	});

	/**
	 * **The teardown follows the account, not only the route.**
	 *
	 * This asserted silence when the proxy was unchanged — while the very same
	 * import replaced the account's shared and identity secrets. So a live access
	 * token, its pending nonces, its failure count and its ten-strike halt stayed
	 * attached to secrets the vault no longer held. A halted account remained
	 * halted after the replacement, which is the repair somebody performs to fix
	 * it.
	 */
	it('notifies when the authenticator was replaced, even on the same proxy', async () => {
		const onRoutingChanged = vi.fn();
		imports = new ImportService(vault, { now: () => clock, onRoutingChanged });

		await vault.mutate((draft) => {
			draft.accounts.push({
				...existingAccount(),
				proxyUrl: 'http://kept:secret@127.0.0.1:1080'
			});
		});

		// The staged file carries different secrets from `existingAccount`.
		const id = stageOne(file());
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		expect(
			onRoutingChanged,
			'the session and schedule stayed attached to secrets the vault no longer holds'
		).toHaveBeenCalledWith('76561198000000001');
	});

	/*
	 * And the case the original test was reaching for: a replacement that changes
	 * nothing must not drop a session that is still correct on both counts.
	 */
	it('does not notify when neither the route nor the secrets changed', async () => {
		const onRoutingChanged = vi.fn();
		imports = new ImportService(vault, { now: () => clock, onRoutingChanged });

		const same = file();
		const first = stageOne(same);
		await imports.commit([{ stagingId: first, replaceExisting: false, adoptProxy: false }]);
		onRoutingChanged.mockClear();

		// The identical file again, over the account it just created.
		const again = stageOne(same);
		await imports.commit([{ stagingId: again, replaceExisting: true, adoptProxy: false }]);

		expect(
			onRoutingChanged,
			'a re-import that changed nothing dropped a live session'
		).not.toHaveBeenCalled();
	});
});

function existingAccount(): Account {
	return {
		steamId64: '76561198000000001',
		accountName: 'original',
		sharedSecret: 'b2xk',
		identitySecret: 'b2xkLWlkZW50aXR5',
		revocationCode: 'R99999',
		status: 'active',
		addedAt: '2026-08-01T00:00:00.000Z',
		autoConfirm: newAutoConfirm()
	};
}

/**
 * Regression: a re-import that adopted a different proxy kept the refresh token.
 *
 * `applyProxyChange` in Settings already deletes it when routing changes — an
 * import adopting a new proxy is the same event through a different door, and it
 * was keeping the session. Steam can link the old exit address to the new one
 * through that one long-lived token, which is exactly what per-account routing
 * exists to prevent.
 */
describe('a session across a routing change', () => {
	it('discards the stored refresh token when an import adopts a different proxy', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({
				...existingAccount(),
				proxyUrl: 'http://old:secret@127.0.0.1:1080',
				refreshToken: 'token-minted-over-the-old-route'
			});
		});

		const id = stageOne(file({ Session: { proxy: 'http://new:secret@10.0.0.1:1080' } }));
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: true }]);

		const stored = vault.read().accounts[0];
		expect(stored?.proxyUrl).toBe('http://new:secret@10.0.0.1:1080');
		expect(stored?.refreshToken).toBeUndefined();
	});

	it('keeps the token when the route is unchanged', async () => {
		// Re-importing the same account over the same route is not a routing event,
		// and forcing a password re-entry for it would be friction for nothing.
		await vault.mutate((draft) => {
			draft.accounts.push({
				...existingAccount(),
				proxyUrl: 'http://same:secret@127.0.0.1:1080',
				refreshToken: 'still-valid'
			});
		});

		const id = stageOne(file({ Session: { proxy: 'http://same:secret@127.0.0.1:1080' } }));
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: true }]);

		expect(vault.read().accounts[0]?.refreshToken).toBe('still-valid');
	});

	it('keeps the token when the file brings no proxy and none is adopted', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({ ...existingAccount(), refreshToken: 'unrouted-and-fine' });
		});

		const id = stageOne(file());
		await imports.commit([{ stagingId: id, replaceExisting: true, adoptProxy: false }]);

		expect(vault.read().accounts[0]?.refreshToken).toBe('unrouted-and-fine');
	});
});

/*
 * The TTL actually drops the material.
 *
 * `expired()` was only ever consulted: the counts reported zero, the next
 * action refused — and the parsed shared secrets sat in the arrays regardless,
 * until another import ran or the screen unmounted. `enforceExpiry` is polled
 * from the same once-a-second sweep as the vault's idle lock, and discards.
 */
describe('staging expiry enforcement', () => {
	it('drops staged secrets once the TTL passes', () => {
		imports.stage([file()]);
		expect(imports.enforceExpiry()).toBe(false);

		clock += 11 * 60_000;
		expect(imports.enforceExpiry()).toBe(true);

		// Actually gone, not merely reported as zero. This reaches into the
		// service because the defect was precisely a divergence between what the
		// counts said and what memory held.
		const internals = imports as unknown as { staged: unknown[]; locked: unknown[] };
		expect(internals.staged).toHaveLength(0);
		expect(internals.locked).toHaveLength(0);
	});

	it('reading a count is enough to trigger the drop', () => {
		imports.stage([file()]);
		clock += 11 * 60_000;
		expect(imports.stagedCount()).toBe(0);

		const internals = imports as unknown as { staged: unknown[] };
		expect(internals.staged).toHaveLength(0);
	});

	it('explains an expiry-swept staging as expired, not as never chosen', async () => {
		imports.stage([file()]);
		clock += 11 * 60_000;
		imports.enforceExpiry();

		// Without the flag, the emptied arrays answered "none of the chosen files
		// are encrypted" — true of the arrays, a lie about what happened.
		await expect(
			imports.commit([{ stagingId: 'any', replaceExisting: false, adoptProxy: false }])
		).rejects.toThrow(/took too long/);
	});
});
