import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportError, ImportService, type StagedFile } from '../src/main/import/service';
import { VaultLockedError, VaultService } from '../src/main/vault/service';

/**
 * Importing an encrypted SDA install (§12 F2).
 *
 * The flow, not the arithmetic — `sda-crypto.test.ts` covers the cipher, and its
 * header explains why none of this proves compatibility with a real SDA install.
 * What is tested here is everything around it, which is where the five
 * enrollment defects all turned out to live: whether the user is told the right
 * thing, whether there is a way forward from each state, and whether a mistake
 * is recoverable without starting the import again.
 *
 * The specific failures being guarded against:
 *
 *  - an encrypted file reported as "damaged" instead of "needs a passphrase";
 *  - a missing `manifest.json` reported as a wrong passphrase, sending the user
 *    to look for a password when the fix is to pick another file;
 *  - a typo throwing away every file, so the whole selection must be made again;
 *  - the manifest itself listed as an account.
 */
/**
 * Counts real decryptions, so "did it decrypt before checking the vault?" can be
 * answered by observation rather than by reading the code and hoping.
 */
let decryptions = 0;

vi.mock('../src/main/import/sda-crypto', async () => {
	const actual = await vi.importActual<typeof import('../src/main/import/sda-crypto')>(
		'../src/main/import/sda-crypto'
	);
	return {
		...actual,
		decryptSdaMaFile: (options: Parameters<typeof actual.decryptSdaMaFile>[0]) => {
			decryptions += 1;
			return actual.decryptSdaMaFile(options);
		}
	};
});

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
const SDA_PASS = 'the sda password';
const SECRET = 'ASNFZ4mrze8BI0VniavN7wEjRWc=';
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

let dir: string;
let clock: number;
let vault: VaultService;
let imports: ImportService;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'import-sda-'));
	clock = NOW;
	vault = new VaultService({ file: join(dir, 'vault.json'), now: () => clock });
	await vault.create(PASS);
	imports = new ImportService(vault, { now: () => clock });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function maFileText(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		shared_secret: SECRET,
		identity_secret: 'aWRlbnRpdHk=',
		account_name: 'trader',
		revocation_code: 'R12345',
		steamid: '76561198000000001',
		...overrides
	});
}

/** One encrypted maFile plus the manifest entry that describes it. */
function encryptedPair(
	name: string,
	passphrase = SDA_PASS,
	overrides: Record<string, unknown> = {}
): { file: StagedFile; entry: Record<string, string> } {
	const salt = randomBytes(8);
	const iv = randomBytes(16);
	const key = pbkdf2Sync(passphrase, salt, 50_000, 32, 'sha1');
	const cipher = createCipheriv('aes-256-cbc', key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(maFileText(overrides), 'utf8'),
		cipher.final()
	]).toString('base64');

	return {
		file: { name, text: ciphertext },
		entry: {
			filename: name,
			encryption_iv: iv.toString('base64'),
			encryption_salt: salt.toString('base64')
		}
	};
}

function manifest(entries: Record<string, string>[], name = 'manifest.json'): StagedFile {
	return { name, text: JSON.stringify({ encrypted: true, entries }) };
}

describe('scanning an encrypted install', () => {
	it('asks for a passphrase rather than calling the file damaged', () => {
		const one = encryptedPair('76561198000000001.maFile');

		const report = imports.stage([one.file, manifest([one.entry])]);

		expect(report.locked).toHaveLength(1);
		expect(report.locked[0]?.sourceName).toBe('76561198000000001.maFile');
		expect(report.locked[0]?.decryptable).toBe(true);
		// Not rejected. Rejected means "there is nothing you can do about this",
		// and there very much is.
		expect(report.rejected).toHaveLength(0);
		expect(report.candidates).toHaveLength(0);
	});

	it('does not list the manifest as an account', () => {
		const one = encryptedPair('a.maFile');

		const report = imports.stage([one.file, manifest([one.entry])]);

		expect(report.candidates).toHaveLength(0);
		expect(report.rejected).toHaveLength(0);
		expect(report.locked.map((file) => file.sourceName)).toEqual(['a.maFile']);
	});

	it('recognises a manifest that has been renamed', () => {
		// Browsers name a second download `manifest (1).json`, and a user copying
		// files out of an SDA folder often ends up with one.
		const one = encryptedPair('a.maFile');

		const report = imports.stage([one.file, manifest([one.entry], 'manifest (1).json')]);

		expect(report.locked[0]?.decryptable).toBe(true);
	});

	it('marks a file undecryptable when no manifest was chosen', () => {
		// The distinction that matters most on this screen. No passphrase can help,
		// so reporting this as a decryption failure would send the user hunting for
		// a password when the fix is to pick one more file.
		const one = encryptedPair('a.maFile');

		const report = imports.stage([one.file]);

		expect(report.locked).toHaveLength(1);
		expect(report.locked[0]?.decryptable).toBe(false);
	});

	it('matches a manifest that records full paths, not bare names', () => {
		// An SDA install that has been moved records absolute paths, while the
		// picker only ever gives base names — so a naive comparison finds nothing
		// and every file looks undecryptable.
		const one = encryptedPair('a.maFile');
		const withPath = { ...one.entry, filename: 'C:\\SDA\\maFiles\\a.maFile' };

		const report = imports.stage([one.file, manifest([withPath])]);

		expect(report.locked[0]?.decryptable).toBe(true);
	});

	it('merges entries from more than one manifest', () => {
		// Consolidating two SDA installs in one go. Taking only the first manifest
		// would leave the second folder's files looking undecryptable.
		const one = encryptedPair('a.maFile');
		const two = encryptedPair('b.maFile');

		const report = imports.stage([
			one.file,
			two.file,
			manifest([one.entry], 'manifest.json'),
			manifest([two.entry], 'other-manifest.json')
		]);

		expect(report.locked.every((file) => file.decryptable)).toBe(true);
	});

	it('handles a folder holding both encrypted and plaintext files', () => {
		const one = encryptedPair('encrypted.maFile');
		const plain: StagedFile = {
			name: 'plain.maFile',
			text: maFileText({ steamid: '76561198000000002', account_name: 'other' })
		};

		const report = imports.stage([one.file, plain, manifest([one.entry])]);

		expect(report.candidates.map((candidate) => candidate.accountName)).toEqual(['other']);
		expect(report.locked).toHaveLength(1);
	});
});

describe('unlocking', () => {
	it('turns a locked file into an importable candidate', () => {
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);

		const report = imports.unlock(SDA_PASS);

		expect(report.locked).toHaveLength(0);
		expect(report.candidates).toHaveLength(1);
		expect(report.candidates[0]?.accountName).toBe('trader');
		expect(report.candidates[0]?.steamId64).toBe('76561198000000001');
		expect(report.candidates[0]?.hasRevocationCode).toBe(true);
		expect(report.candidates[0]?.importable).toBe(true);
	});

	it('commits a decrypted account into the vault', () => {
		// The end of the road: the point of the whole feature is an account that
		// works afterwards, not a candidate that looks right on screen.
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);
		const report = imports.unlock(SDA_PASS);
		const id = report.candidates[0]?.stagingId ?? '';

		return imports
			.commit([{ stagingId: id, replaceExisting: false, adoptProxy: false }])
			.then((outcomes) => {
				expect(outcomes[0]?.result).toBe('imported');

				const stored = vault.read().accounts[0];
				expect(stored?.steamId64).toBe('76561198000000001');
				expect(stored?.sharedSecret).toBe(SECRET);
				expect(stored?.revocationCode).toBe('R12345');
			});
	});

	it('says the file was decrypted, so the user knows which ones were', () => {
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);

		const report = imports.unlock(SDA_PASS);

		expect(report.candidates[0]?.warnings.join(' ')).toMatch(/decrypted/i);
	});

	it('keeps a file locked on a wrong passphrase instead of discarding it', () => {
		// A typo must cost a retry, not the whole selection. Discarding would mean
		// reopening the picker and choosing every file again.
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);

		const report = imports.unlock('wrong');

		expect(report.locked).toHaveLength(1);
		expect(report.candidates).toHaveLength(0);
		expect(report.rejected[0]?.reason).toMatch(/passphrase/i);
	});

	it('accepts the right passphrase after a wrong one', () => {
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);
		imports.unlock('wrong');

		const report = imports.unlock(SDA_PASS);

		expect(report.candidates).toHaveLength(1);
		expect(report.locked).toHaveLength(0);
	});

	it('unlocks what it can and leaves the rest, across mixed passphrases', () => {
		// One SDA folder can hold files encrypted under different passwords, from an
		// install whose password was changed. Failing the batch on the first miss
		// would make those accounts unimportable.
		const one = encryptedPair('a.maFile');
		const two = encryptedPair('b.maFile', 'a different password', {
			steamid: '76561198000000002',
			account_name: 'other'
		});
		imports.stage([one.file, two.file, manifest([one.entry, two.entry])]);

		const report = imports.unlock(SDA_PASS);

		expect(report.candidates.map((candidate) => candidate.accountName)).toEqual(['trader']);
		expect(report.locked.map((file) => file.sourceName)).toEqual(['b.maFile']);
	});

	it('keeps candidates found before the unlock, with their ids intact', () => {
		// The renderer's tick boxes are keyed on staging ids. Renumbering them here
		// would silently clear a selection the user had already made.
		const one = encryptedPair('encrypted.maFile');
		const plain: StagedFile = {
			name: 'plain.maFile',
			text: maFileText({ steamid: '76561198000000002', account_name: 'other' })
		};
		const first = imports.stage([one.file, plain, manifest([one.entry])]);
		const plainId = first.candidates[0]?.stagingId;

		const report = imports.unlock(SDA_PASS);

		expect(report.candidates).toHaveLength(2);
		expect(report.candidates.some((candidate) => candidate.stagingId === plainId)).toBe(true);
	});

	it('spots that a decrypted file is an account already in the vault', () => {
		// Duplicate detection runs against the vault as it is now, so it has to be
		// redone after an unlock rather than carried over from the scan.
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);
		const first = imports.unlock(SDA_PASS);

		return imports
			.commit([
				{
					stagingId: first.candidates[0]?.stagingId ?? '',
					replaceExisting: false,
					adoptProxy: false
				}
			])
			.then(() => {
				const two = encryptedPair('a.maFile');
				imports.stage([two.file, manifest([two.entry])]);

				expect(imports.unlock(SDA_PASS).candidates[0]?.duplicate).toBe('vault');
			});
	});

	it('refuses to decrypt a file whose manifest entry is missing', () => {
		const one = encryptedPair('a.maFile');
		imports.stage([one.file]);

		const report = imports.unlock(SDA_PASS);

		// Still locked, and still reported as undecryptable rather than as a wrong
		// passphrase — the passphrase was never the problem.
		expect(report.locked[0]?.decryptable).toBe(false);
		expect(report.rejected).toHaveLength(0);
	});

	it('refuses when nothing is encrypted, rather than pretending to work', () => {
		imports.stage([{ name: 'plain.maFile', text: maFileText() }]);

		expect(() => imports.unlock(SDA_PASS)).toThrow(ImportError);
	});
});

describe('not leaving ciphertext lying about', () => {
	it('drops locked files when the import is discarded', () => {
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);

		imports.discard();

		expect(imports.lockedCount()).toBe(0);
		expect(() => imports.unlock(SDA_PASS)).toThrow(ImportError);
	});

	it('expires locked files on the same clock as staged secrets', () => {
		// The bug this exists for: `expired()` looked only at the staged plaintext.
		// A scan of nothing but encrypted files staged nothing, so it never counted
		// as expired, and the ciphertext sat in memory until quit — waiting for a
		// prompt the user had walked away from an hour earlier.
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);
		expect(imports.lockedCount()).toBe(1);

		clock += 11 * 60_000;

		expect(imports.lockedCount()).toBe(0);
		expect(() => imports.unlock(SDA_PASS)).toThrow(/took too long/);
	});

	it('never even looks at a file when the vault is locked', () => {
		// Fail fast, *before parsing*. The vault read that finds duplicates used to
		// be the first statement of `stage`, so a locked vault threw before a single
		// file was decoded. Moving that read later meant every chosen file was pulled
		// into memory first and the lock noticed afterwards.
		//
		// Asserting only that it throws proves nothing — it throws either way, from
		// the vault read at the end. So the file's contents are exposed through a
		// getter and the test asserts the getter was never called. That is the
		// ordering, observed rather than assumed.
		let reads = 0;
		const watched: StagedFile = {
			name: 'a.maFile',
			get text() {
				reads += 1;
				return maFileText();
			}
		};
		vault.lock();

		expect(() => imports.stage([watched])).toThrow(VaultLockedError);
		expect(reads).toBe(0);
	});

	it('decrypts nothing when the vault locked while the prompt was up', () => {
		// The sibling of the `stage` ordering rule, and it was missed when that one
		// was fixed: `unlock` had no check of its own, so every file was turned into
		// plaintext and the locked vault noticed afterwards, in `buildReport`.
		//
		// Counted through the crypto module rather than inferred, because it throws
		// either way — asserting only that it throws would prove nothing about when.
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);
		vault.lock();
		decryptions = 0;

		expect(() => imports.unlock(SDA_PASS)).toThrow(VaultLockedError);
		expect(decryptions).toBe(0);
	});

	it('leaves nothing behind when the vault locks while the prompt is up', () => {
		// The real sequence: files are scanned with the vault open, the user walks
		// away, the idle auto-lock fires, and they come back and type the passphrase.
		// The unlock then fails at the vault read — after the ciphertext has been
		// reassigned and the plaintext decrypted — and both used to survive the
		// throw, with nobody present.
		//
		// Asserted on the fields rather than through `lockedCount()`, because that
		// accessor answers zero here for the wrong reason: a failed build never sets
		// `stagedAt`, so everything looks expired while it is still in the array.
		const one = encryptedPair('a.maFile');
		const plain: StagedFile = {
			name: 'plain.maFile',
			text: maFileText({ steamid: '76561198000000002', account_name: 'other' })
		};
		imports.stage([one.file, plain, manifest([one.entry])]);

		vault.lock();

		expect(() => imports.unlock(SDA_PASS)).toThrow();

		const held = imports as unknown as { locked: unknown[]; staged: unknown[] };
		expect(held.locked).toHaveLength(0);
		expect(held.staged).toHaveLength(0);
	});

	it('keeps unreadable-file rejections visible after an unlock', () => {
		// These come from the IPC layer — a file too large to be a maFile, or one
		// that could not be opened. They used to be merged onto the scan's response
		// and nowhere else, so typing a passphrase built a fresh report and the row
		// explaining the skipped file silently vanished.
		const one = encryptedPair('a.maFile');
		const unreadable = [{ sourceName: 'huge.maFile', reason: 'this file is 5000 KB.' }];

		const scan = imports.stage([one.file, manifest([one.entry])], unreadable);
		expect(scan.rejected).toHaveLength(1);

		const report = imports.unlock(SDA_PASS);

		expect(report.rejected.map((entry) => entry.sourceName)).toContain('huge.maFile');
	});

	it('replaces the previous scan rather than accumulating locked files', () => {
		const one = encryptedPair('a.maFile');
		const two = encryptedPair('b.maFile');
		imports.stage([one.file, manifest([one.entry])]);

		const report = imports.stage([two.file, manifest([two.entry])]);

		expect(report.locked.map((file) => file.sourceName)).toEqual(['b.maFile']);
	});

	it('never puts a decrypted secret into the report', () => {
		const one = encryptedPair('a.maFile');
		imports.stage([one.file, manifest([one.entry])]);

		const serialised = JSON.stringify(imports.unlock(SDA_PASS));

		expect(serialised).not.toContain(SECRET);
		expect(serialised).not.toContain('R12345');
		expect(serialised).not.toContain(SDA_PASS);
	});
});
