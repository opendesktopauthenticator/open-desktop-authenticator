import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportService, type StagedFile } from '../src/main/import/service';
import { VaultService } from '../src/main/vault/service';
import type { ImportCandidate, ImportSelection } from '../src/shared/ipc';

/**
 * **Two files for one account: which one wins, and why it must not be the order
 * they were listed in.**
 *
 * A folder of maFile backups routinely holds more than one copy of the same
 * account, and the copies are not equally good. Ranking was `completeness`
 * alone — revocation code, session, device id — compared with a strict `>`, so
 * two copies carrying the same fields left whichever the OS happened to list
 * first as the candidate and disabled the other as a duplicate.
 *
 * The identity secret was not in that ranking at all, even though its usability
 * is detected a few lines away, in `toEntry`, where it raises a warning. So a
 * damaged copy listed first beat a working one: the vault took an identity
 * secret that cannot sign anything, Guard codes kept appearing exactly as
 * before, and every trade and market confirmation failed from then on. A silent
 * failure, delayed by however long it takes to make the next trade, on the one
 * feature this product exists for.
 *
 * Each case below is asserted **in both file orders**. An assertion that only
 * holds for one arrangement is the bug written down rather than fixed.
 */

/** Stubbed to the accepted scrypt floor, like the other vault suites. */
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
const STEAM_ID = '76561198000000001';

/** Twenty bytes, base64 — what `decodeSharedSecret` accepts. */
const SECRET = 'ASNFZ4mrze8BI0VniavN7wEjRWc=';
const GOOD_IDENTITY = 'ICEiIyQlJicoKSorLC0uLzAxMjM=';
/**
 * Eight bytes. Valid base64 and a non-empty string, so the schema takes it
 * happily — and far too short to be an HMAC key, so every confirmation signed
 * with it is rejected by Steam.
 */
const BAD_IDENTITY = 'aWRlbnRpdHk=';

let dir: string;
let vault: VaultService;
let imports: ImportService;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'import-ranking-'));
	vault = new VaultService({ file: join(dir, 'vault.json') });
	await vault.create(PASS);
	imports = new ImportService(vault);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function file(
	name: string,
	overrides: { identitySecret?: string; revocationCode?: string | null; deviceId?: string } = {}
): StagedFile {
	const revocationCode =
		overrides.revocationCode === undefined ? 'R12345' : overrides.revocationCode;
	return {
		name,
		text: JSON.stringify({
			shared_secret: SECRET,
			identity_secret: overrides.identitySecret ?? GOOD_IDENTITY,
			account_name: 'trader',
			steamid: STEAM_ID,
			...(revocationCode === null ? {} : { revocation_code: revocationCode }),
			...(overrides.deviceId === undefined ? {} : { device_id: overrides.deviceId })
		})
	};
}

const damaged = (name: string): StagedFile => file(name, { identitySecret: BAD_IDENTITY });
const healthy = (name: string): StagedFile => file(name);

function candidateNamed(
	candidates: ImportCandidate[],
	sourceName: string
): ImportCandidate | undefined {
	return candidates.find((candidate) => candidate.sourceName === sourceName);
}

/** Commit every candidate, in the order the report lists them. */
function everything(candidates: ImportCandidate[]): ImportSelection[] {
	return candidates.map((candidate) => ({
		stagingId: candidate.stagingId,
		replaceExisting: false,
		adoptProxy: false
	}));
}

describe('a damaged identity secret loses to a working one', () => {
	/*
	 * Both orders, and the same expectation from each. `damaged.maFile` sorts
	 * ahead of `working.maFile` alphabetically, which is the arrangement the
	 * original defect needed — but the point is that neither arrangement decides
	 * anything, so both are asserted.
	 */
	for (const [first, second] of [
		['damaged.maFile', 'working.maFile'],
		['working.maFile', 'damaged.maFile']
	] as const) {
		const files = (): StagedFile[] =>
			first === 'damaged.maFile'
				? [damaged(first), healthy(second)]
				: [healthy(first), damaged(second)];

		describe(`listed as ${first}, then ${second}`, () => {
			it('makes the working file the candidate and the damaged one the duplicate', () => {
				const report = imports.stage(files());

				expect(
					candidateNamed(report.candidates, 'working.maFile')?.duplicate,
					'the file with the usable identity secret was disabled as a duplicate'
				).toBeUndefined();
				expect(
					candidateNamed(report.candidates, 'damaged.maFile')?.duplicate,
					'the file with the unusable identity secret was offered as the one to import'
				).toBe('selection');
			});

			it('stores the usable identity secret even when both rows are committed', async () => {
				const report = imports.stage(files());

				await imports.commit(everything(report.candidates));

				const stored = vault.read().accounts[0];
				expect(stored?.steamId64).toBe(STEAM_ID);
				expect(
					stored?.identitySecret,
					'the vault took an identity secret that can never approve a confirmation, ' +
						'so codes keep working and every trade confirmation fails'
				).toBe(GOOD_IDENTITY);
			});

			it('says out loud that the damaged file is the one being ignored', () => {
				const report = imports.stage(files());
				const damagedRow = candidateNamed(report.candidates, 'damaged.maFile');

				expect(
					damagedRow?.warnings.some((warning) => warning.includes('identity secret')),
					'the row the user is told to ignore carries no explanation of what is wrong with it'
				).toBe(true);
			});
		});
	}

	/*
	 * The ranking is a property of the files, not of how many times it is run.
	 * `preferredIds` re-derives it at commit time rather than trusting the
	 * report, and a second opinion that disagreed with the first would mean the
	 * screen and the write name different winners.
	 */
	it('agrees with itself between the report and the write', async () => {
		const report = imports.stage([damaged('damaged.maFile'), healthy('working.maFile')]);
		const reportWinner = report.candidates.find((candidate) => candidate.duplicate === undefined);

		const outcomes = await imports.commit(everything(report.candidates));
		const written = outcomes.find((outcome) => outcome.result !== 'skipped');

		expect(written?.stagingId, 'the screen offered one file and the vault wrote another').toBe(
			reportWinner?.stagingId
		);
	});
});

describe('when both files can sign confirmations', () => {
	/*
	 * Unchanged, and worth pinning: `completeness` exists because a backup copy
	 * often still carries the revocation code that the working copy has had
	 * stripped, and a revocation code is the one loss that cannot be undone.
	 * Identity usability is ranked *above* completeness, so this asserts the
	 * tie-break still runs when identity usability cannot separate the two.
	 */
	/**
	 * **And usability outranks completeness, which nothing pinned.**
	 *
	 * The two keys only disagree when the *more complete* file is the damaged
	 * one, and no case put them in conflict — so a verifier swapped their order,
	 * making completeness primary and usability a mere tie-break, and every
	 * import suite stayed green. A backup copy is exactly where this bites: it
	 * often still carries the revocation code the working copy has had stripped,
	 * so the damaged file is frequently the more complete one.
	 *
	 * Losing the revocation code is the worse *permanent* loss, but an identity
	 * secret that cannot sign leaves the account confirming nothing at all, with
	 * codes still working so nobody notices for days. Both orders asserted, so
	 * the outcome cannot depend on which file was listed first either.
	 */
	for (const order of ['damaged first', 'usable first'] as const) {
		it(`prefers a usable identity secret over a more complete file (${order})`, async () => {
			const damagedButComplete = file('damaged-complete.maFile', {
				identitySecret: BAD_IDENTITY,
				revocationCode: 'R99999',
				deviceId: 'android:11111111-1111-1111-1111-111111111111'
			});
			const usableButBare = file('usable-bare.maFile', { revocationCode: null });
			const report = imports.stage(
				order === 'damaged first'
					? [damagedButComplete, usableButBare]
					: [usableButBare, damagedButComplete]
			);

			expect(
				candidateNamed(report.candidates, 'usable-bare.maFile')?.duplicate,
				'the only file whose identity secret can approve a confirmation was disabled as a ' +
					'duplicate, because completeness was allowed to outrank usability'
			).toBeUndefined();

			await imports.commit(everything(report.candidates));
			expect(
				vault.read().accounts[0]?.identitySecret,
				'the vault took an identity secret that can never approve a confirmation: codes keep ' +
					'working and every trade confirmation fails, which is a silent failure for days'
			).toBe(GOOD_IDENTITY);
		});
	}

	for (const order of ['bare first', 'complete first'] as const) {
		it(`still prefers the more complete file (${order})`, async () => {
			const bare = file('bare.maFile', { revocationCode: null });
			const complete = file('complete.maFile', { revocationCode: 'R99999' });
			const report = imports.stage(order === 'bare first' ? [bare, complete] : [complete, bare]);

			expect(candidateNamed(report.candidates, 'complete.maFile')?.duplicate).toBeUndefined();
			expect(candidateNamed(report.candidates, 'bare.maFile')?.duplicate).toBe('selection');

			await imports.commit(everything(report.candidates));
			expect(
				vault.read().accounts[0]?.revocationCode,
				'the copy carrying the revocation code lost to the one without it'
			).toBe('R99999');
		});
	}
});
