import { randomUUID } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	fileWorkflowJournal,
	memoryWorkflowJournal,
	workflowJournalDirectory
} from '../src/main/steam/workflow-journal';
import { sealBytesWithKey } from '../src/main/vault/crypto';
import type { Envelope } from '../src/shared/vault-format';

const STEAM_ID = '76561198000000001';
const OTHER_STEAM_ID = '76561198000000002';
const AT = '2026-09-02T00:00:00.000Z';

const VAULT_KEY = Buffer.alloc(32, 7);
const OTHER_VAULT_KEY = Buffer.alloc(32, 8);
const WRAPPED = sealBytesWithKey(Buffer.alloc(32, 9), VAULT_KEY, {
	type: 'scrypt',
	N: 16384,
	r: 8,
	p: 1,
	salt: Buffer.alloc(32, 1).toString('base64')
}) satisfies Envelope;

const SEALED = {
	nonce: Buffer.alloc(12, 4).toString('base64'),
	tag: Buffer.alloc(16, 5).toString('base64'),
	ciphertext: Buffer.from('encrypted workflow payload').toString('base64')
};

type FileKind = 'enrollment' | 'transfer';
type EnrollmentState = 'sending' | 'unanswered' | 'attached' | 'recoverable' | 'unreadable';
type TransferState = 'sending' | 'unanswered' | 'unreadable' | 'not-replaced' | 'replacement';

const temp = (): string => mkdtempSync(join(tmpdir(), 'oda-workflow-hardening-'));

function pathFor(root: string, kind: FileKind, steamId64: string, attemptId: string): string {
	return join(workflowJournalDirectory(root), `${steamId64}.${kind}.${attemptId}.json`);
}

function writeRecord(root: string, kind: FileKind, record: object): string {
	const value = record as { steamId64: string; attemptId: string };
	const directory = workflowJournalDirectory(root);
	mkdirSync(directory, { recursive: true });
	const path = pathFor(root, kind, value.steamId64, value.attemptId);
	writeFileSync(path, JSON.stringify(record));
	return path;
}

function enrollmentRecord(state: EnrollmentState): Record<string, unknown> {
	return {
		version: 1,
		kind: 'enrollment-add',
		attemptId: randomUUID(),
		steamId64: STEAM_ID,
		accountName: 'trader',
		at: AT,
		state,
		...(state === 'sending' || state === 'recoverable' || state === 'unreadable'
			? { wrappedKey: WRAPPED }
			: {}),
		...(state === 'recoverable' || state === 'unreadable' ? { recovery: SEALED } : {})
	};
}

function transferRecord(state: TransferState): Record<string, unknown> {
	return {
		version: 1,
		kind: 'transfer',
		attemptId: randomUUID(),
		steamId64: STEAM_ID,
		accountName: 'trader',
		at: AT,
		state,
		wrappedKey: WRAPPED,
		...(state === 'replacement' || state === 'unreadable' ? { replacement: SEALED } : {})
	};
}

function createThroughApi(
	root: string,
	kind: FileKind
): {
	attemptId: string;
	read: () => unknown;
} {
	const journal = fileWorkflowJournal(root);
	if (kind === 'enrollment') {
		const record = journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			wrappedKey: WRAPPED
		});
		return { attemptId: record.attemptId, read: () => journal.enrollments() };
	}
	const record = journal.beginTransfer({
		steamId64: STEAM_ID,
		accountName: 'trader',
		at: AT,
		wrappedKey: WRAPPED
	});
	return { attemptId: record.attemptId, read: () => journal.transfers() };
}

describe.each(['enrollment', 'transfer'] as const)(
	'%s workflow filenames are authenticated by their contents',
	(kind) => {
		it('rejects a file renamed onto another Steam identity', () => {
			const root = temp();
			const { attemptId, read } = createThroughApi(root, kind);
			renameSync(
				pathFor(root, kind, STEAM_ID, attemptId),
				pathFor(root, kind, OTHER_STEAM_ID, attemptId)
			);

			expect(read).toThrow(/filename does not match its contents/i);
		});

		it('rejects a file renamed onto another attempt id', () => {
			const root = temp();
			const { attemptId, read } = createThroughApi(root, kind);
			renameSync(
				pathFor(root, kind, STEAM_ID, attemptId),
				pathFor(root, kind, STEAM_ID, randomUUID())
			);

			expect(read).toThrow(/filename does not match its contents/i);
		});

		it('rejects a file renamed as the other workflow kind', () => {
			const root = temp();
			const { attemptId, read } = createThroughApi(root, kind);
			const otherKind = kind === 'enrollment' ? 'transfer' : 'enrollment';
			renameSync(
				pathFor(root, kind, STEAM_ID, attemptId),
				pathFor(root, otherKind, STEAM_ID, attemptId)
			);

			expect(read).toThrow(/cannot understand|filename does not match/i);
		});

		it('rejects an oversized final record before trying to parse it', () => {
			const root = temp();
			const directory = workflowJournalDirectory(root);
			mkdirSync(directory, { recursive: true });
			const path = pathFor(root, kind, STEAM_ID, randomUUID());
			// Deliberately invalid JSON. Seeing "too large" rather than the parse error
			// proves the bound is applied before the attacker-controlled body is decoded.
			writeFileSync(path, Buffer.alloc(256 * 1024 + 1, 0x7b));

			expect(() => fileWorkflowJournal(root).enrollments()).toThrow(/too large/i);
		});
	}
);

const WRAPPED_KEY_STATES: ReadonlyArray<
	{ kind: 'enrollment'; state: EnrollmentState } | { kind: 'transfer'; state: TransferState }
> = [
	{ kind: 'enrollment', state: 'sending' },
	{ kind: 'enrollment', state: 'recoverable' },
	{ kind: 'enrollment', state: 'unreadable' },
	{ kind: 'transfer', state: 'sending' },
	{ kind: 'transfer', state: 'unanswered' },
	{ kind: 'transfer', state: 'unreadable' },
	{ kind: 'transfer', state: 'not-replaced' },
	{ kind: 'transfer', state: 'replacement' }
];

describe('vault-key compatibility', () => {
	it.each(WRAPPED_KEY_STATES)('checks $kind/$state records that carry a wrapped key', (item) => {
		const root = temp();
		writeRecord(
			root,
			item.kind,
			item.kind === 'enrollment' ? enrollmentRecord(item.state) : transferRecord(item.state)
		);
		const journal = fileWorkflowJournal(root);

		expect(journal.vaultKeyCompatible({ kdf: WRAPPED.kdf }, VAULT_KEY)).toBe(true);
		// Same KDF metadata, including the salt, is not enough: only the actual
		// derived vault key may authenticate this wrapped content key.
		expect(journal.vaultKeyCompatible({ kdf: WRAPPED.kdf }, OTHER_VAULT_KEY)).toBe(false);
	});
});

describe('workflow ciphertext state invariants', () => {
	it.each(['sending', 'unanswered', 'attached'] as const)(
		'rejects enrollment ciphertext in %s',
		(state) => {
			const root = temp();
			writeRecord(root, 'enrollment', { ...enrollmentRecord(state), recovery: SEALED });

			expect(() => fileWorkflowJournal(root).enrollments()).toThrow(/cannot understand/i);
		}
	);

	it.each(['sending', 'unanswered', 'not-replaced'] as const)(
		'rejects transfer ciphertext in %s',
		(state) => {
			const root = temp();
			writeRecord(root, 'transfer', { ...transferRecord(state), replacement: SEALED });

			expect(() => fileWorkflowJournal(root).transfers()).toThrow(/cannot understand/i);
		}
	);

	it('an API transition out of recoverable drops its key and ciphertext', () => {
		const journal = memoryWorkflowJournal();
		const sending = journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			wrappedKey: WRAPPED
		});
		const recoverable = journal.updateEnrollment(sending, {
			state: 'recoverable',
			wrappedKey: WRAPPED,
			recovery: SEALED
		});

		expect(journal.updateEnrollment(recoverable, 'attached')).toEqual({
			version: 1,
			kind: 'enrollment-add',
			attemptId: sending.attemptId,
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			state: 'attached'
		});
	});
});

describe('crash recovery for fully written staged updates', () => {
	const stage = (finalPath: string, record: object): string => {
		const path = `${finalPath}.${randomUUID()}.tmp`;
		writeFileSync(path, JSON.stringify(record));
		return path;
	};

	it.each([
		['enrollment', 'recoverable'],
		['enrollment', 'unreadable'],
		['transfer', 'replacement'],
		['transfer', 'unreadable']
	] as const)('promotes a valid %s/%s update beside its exact sending record', (kind, state) => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		const sending =
			kind === 'enrollment'
				? journal.beginEnrollment({
						steamId64: STEAM_ID,
						accountName: 'trader',
						at: AT,
						wrappedKey: WRAPPED
					})
				: journal.beginTransfer({
						steamId64: STEAM_ID,
						accountName: 'trader',
						at: AT,
						wrappedKey: WRAPPED
					});
		const finalPath = pathFor(root, kind, STEAM_ID, sending.attemptId);
		const updated =
			kind === 'enrollment'
				? { ...sending, state, recovery: SEALED }
				: { ...sending, state, replacement: SEALED };
		stage(finalPath, updated);

		const restarted = fileWorkflowJournal(root);
		const recovered = kind === 'enrollment' ? restarted.enrollments() : restarted.transfers();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({ attemptId: sending.attemptId, state });
		expect(readdirSync(workflowJournalDirectory(root))).toEqual([
			`${STEAM_ID}.${kind}.${sending.attemptId}.json`
		]);
	});

	it('refuses a malformed staged update instead of hiding it', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		const sending = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			wrappedKey: WRAPPED
		});
		const finalPath = pathFor(root, 'transfer', STEAM_ID, sending.attemptId);
		writeFileSync(`${finalPath}.${randomUUID()}.tmp`, '{');

		expect(() => fileWorkflowJournal(root).transfers()).toThrow(/cannot understand/i);
	});

	it('refuses a staged update whose identity differs from the final record', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		const sending = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			wrappedKey: WRAPPED
		});
		stage(pathFor(root, 'transfer', STEAM_ID, sending.attemptId), {
			...sending,
			attemptId: randomUUID(),
			state: 'replacement',
			replacement: SEALED
		});

		expect(() => fileWorkflowJournal(root).transfers()).toThrow(/filename does not match/i);
	});

	it('refuses conflicting complete updates rather than choosing one', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		const sending = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			wrappedKey: WRAPPED
		});
		const finalPath = pathFor(root, 'transfer', STEAM_ID, sending.attemptId);
		stage(finalPath, {
			version: 1,
			kind: 'transfer',
			attemptId: sending.attemptId,
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			state: 'unanswered'
		});
		stage(finalPath, { ...sending, state: 'replacement', replacement: SEALED });

		expect(() => fileWorkflowJournal(root).transfers()).toThrow(/multiple conflicting/i);
	});

	it('removes an uncommitted sending temp that has no final record', () => {
		const root = temp();
		const directory = workflowJournalDirectory(root);
		mkdirSync(directory, { recursive: true });
		const sending = enrollmentRecord('sending');
		stage(pathFor(root, 'enrollment', STEAM_ID, sending.attemptId as string), sending);

		expect(fileWorkflowJournal(root).enrollments()).toEqual([]);
		expect(readdirSync(directory)).toEqual([]);
	});

	it('preserves and surfaces retained ciphertext whose final record is missing', () => {
		const root = temp();
		const directory = workflowJournalDirectory(root);
		mkdirSync(directory, { recursive: true });
		const recoverable = enrollmentRecord('recoverable');
		const stagedPath = stage(
			pathFor(root, 'enrollment', STEAM_ID, recoverable.attemptId as string),
			recoverable
		);

		expect(() => fileWorkflowJournal(root).enrollments()).toThrow(/no matching final/i);
		expect(readFileSync(stagedPath, 'utf8')).toContain('recoverable');
	});

	it('cleans a stale sending temp after the final record already advanced', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		const sending = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: AT,
			wrappedKey: WRAPPED
		});
		const replacement = journal.updateTransfer(sending, {
			state: 'replacement',
			wrappedKey: WRAPPED,
			replacement: SEALED
		});
		stage(pathFor(root, 'transfer', STEAM_ID, sending.attemptId), sending);

		expect(fileWorkflowJournal(root).transfers()).toEqual([replacement]);
		expect(
			readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
		).toEqual([]);
	});

	it.each([
		['enrollment', undefined],
		['enrollment', false],
		['transfer', undefined],
		['transfer', false]
	] as const)(
		'promotes the exact same-state %s recovery publication from %s and keeps another account readable',
		(kind, previousPublished) => {
			const root = temp();
			const base =
				kind === 'enrollment' ? enrollmentRecord('recoverable') : transferRecord('replacement');
			const current =
				previousPublished === undefined ? base : { ...base, recoveryPublished: previousPublished };
			const finalPath = writeRecord(root, kind, current);
			stage(finalPath, { ...current, recoveryPublished: true });
			const unrelatedBase =
				kind === 'enrollment' ? enrollmentRecord('recoverable') : transferRecord('replacement');
			const unrelated = { ...unrelatedBase, steamId64: OTHER_STEAM_ID };
			writeRecord(root, kind, unrelated);

			const restarted = fileWorkflowJournal(root);
			const recovered = kind === 'enrollment' ? restarted.enrollments() : restarted.transfers();
			expect(recovered.find((entry) => entry.attemptId === current.attemptId)).toMatchObject({
				state: current.state,
				recoveryPublished: true
			});
			expect(recovered.find((entry) => entry.steamId64 === OTHER_STEAM_ID)).toMatchObject({
				steamId64: OTHER_STEAM_ID,
				state: kind === 'enrollment' ? 'recoverable' : 'replacement'
			});
			expect(
				readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
			).toEqual([]);
		}
	);

	it.each([
		['enrollment', undefined],
		['enrollment', false],
		['transfer', undefined],
		['transfer', false]
	] as const)(
		'discards a reverse same-state %s recovery publication to %s as stale',
		(kind, stale) => {
			const root = temp();
			const base =
				kind === 'enrollment' ? enrollmentRecord('recoverable') : transferRecord('replacement');
			const current = { ...base, recoveryPublished: true };
			const finalPath = writeRecord(root, kind, current);
			const staged = { ...current, recoveryPublished: stale };
			stage(finalPath, staged);

			const restarted = fileWorkflowJournal(root);
			const recovered = kind === 'enrollment' ? restarted.enrollments() : restarted.transfers();
			expect(recovered).toEqual([current]);
			expect(
				readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
			).toEqual([]);
		}
	);

	it.each(['enrollment', 'transfer'] as const)(
		'refuses a hostile same-state %s update hidden beside recovery publication',
		(kind) => {
			const root = temp();
			const current =
				kind === 'enrollment' ? enrollmentRecord('recoverable') : transferRecord('replacement');
			const finalPath = writeRecord(root, kind, current);
			const hostilePayload = {
				...SEALED,
				ciphertext: Buffer.from('different encrypted workflow payload').toString('base64')
			};
			stage(finalPath, {
				...current,
				recoveryPublished: true,
				...(kind === 'enrollment' ? { recovery: hostilePayload } : { replacement: hostilePayload })
			});

			const restarted = fileWorkflowJournal(root);
			expect(() =>
				kind === 'enrollment' ? restarted.enrollments() : restarted.transfers()
			).toThrow(/conflicting staged workflow/i);
			expect(readFileSync(finalPath, 'utf8')).toBe(JSON.stringify(current));
		}
	);
});
