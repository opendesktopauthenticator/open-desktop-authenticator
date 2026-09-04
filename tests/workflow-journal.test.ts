import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileWorkflowJournal, workflowJournalDirectory } from '../src/main/steam/workflow-journal';

const STEAM_ID = '76561198000000001';
const WRAPPED = {
	version: 1,
	kdf: {
		type: 'scrypt' as const,
		N: 16384,
		r: 8,
		p: 1,
		salt: Buffer.alloc(32, 1).toString('base64')
	},
	cipher: {
		type: 'aes-256-gcm' as const,
		nonce: Buffer.alloc(12, 2).toString('base64'),
		tag: Buffer.alloc(16, 3).toString('base64')
	},
	ciphertext: Buffer.from('wrapped').toString('base64'),
	modifiedAt: '2026-09-02T00:00:00.000Z'
};
const SEALED = {
	nonce: Buffer.alloc(12, 4).toString('base64'),
	tag: Buffer.alloc(16, 5).toString('base64'),
	ciphertext: Buffer.from('encrypted replacement').toString('base64')
};

const temp = (): string => mkdtempSync(join(tmpdir(), 'oda-workflow-'));

describe('durable Steam workflow records', () => {
	it('survives a new journal instance and keeps operation kinds exact', () => {
		const root = temp();
		const first = fileWorkflowJournal(root);
		const enrollment = first.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		const transfer = first.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:01.000Z',
			wrappedKey: WRAPPED
		});

		const restarted = fileWorkflowJournal(root);
		expect(restarted.enrollments()).toEqual([enrollment]);
		expect(restarted.transfers()).toEqual([transfer]);
	});

	it('persists a known not-attached cleanup debt across restart', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		const begun = journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		const debt = journal.updateEnrollment(begun, 'not-attached');
		expect(fileWorkflowJournal(root).enrollments()).toEqual([debt]);
	});

	it('never derives a path from an account name and rejects a malformed SteamID', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		expect(() =>
			journal.beginEnrollment({
				steamId64: '../../outside',
				accountName: '../still-only-data',
				at: '2026-09-02T00:00:00.000Z',
				wrappedKey: WRAPPED
			})
		).toThrow();
		expect(readdirSync(root)).toEqual([]);
	});

	it('fails closed on an unknown or newer final file', () => {
		const root = temp();
		const directory = workflowJournalDirectory(root);
		const journal = fileWorkflowJournal(root);
		journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		writeFileSync(join(directory, 'future-v2.record'), '{}');
		expect(() => journal.enrollments()).toThrow(/cannot understand/);
		expect(() => journal.transfers()).toThrow(/cannot understand/);
	});

	it('uses the exclusive direct-write fallback when hard links are unavailable', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root, {
			link: () => {
				const error = new Error('hard links unavailable') as NodeJS.ErrnoException;
				error.code = 'EPERM';
				throw error;
			}
		});
		const record = journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		expect(fileWorkflowJournal(root).enrollments()).toEqual([record]);
		expect(
			readdirSync(workflowJournalDirectory(root)).every((name) => !name.endsWith('.tmp'))
		).toBe(true);
	});

	it('never overwrites an existing recovery record', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root);
		const first = journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'first',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		const second = journal.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'second',
			at: '2026-09-02T00:00:01.000Z',
			wrappedKey: WRAPPED
		});
		expect(
			journal
				.enrollments()
				.map((entry) => entry.attemptId)
				.sort()
		).toEqual([first.attemptId, second.attemptId].sort());
	});

	it('flushes both the first-use directory entry and the published record', () => {
		const root = temp();
		const flushed: string[] = [];
		fileWorkflowJournal(root, { syncDirectory: (path) => flushed.push(path) }).beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});

		expect(flushed[0]).toBe(root);
		expect(flushed).toContain(workflowJournalDirectory(root));
	});

	it('persists the staged update before renaming it over the conservative record', () => {
		const root = temp();
		const events: string[] = [];
		const directory = workflowJournalDirectory(root);
		const journal = fileWorkflowJournal(root, {
			syncDirectory: (path) => events.push(`flush:${path}`),
			rename: (oldPath, newPath) => {
				events.push('rename');
				expect(events.at(-2)).toBe(`flush:${directory}`);
				expect(readFileSync(oldPath, 'utf8')).toContain('"state":"not-replaced"');
				renameSync(oldPath, newPath);
			}
		});
		const begun = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});

		events.length = 0;
		journal.updateTransfer(begun, { state: 'not-replaced' });
		expect(events).toEqual([`flush:${directory}`, 'rename', `flush:${directory}`]);
	});

	it('retries a transient replacement lock without changing the journal transition', () => {
		const root = temp();
		let failures = 2;
		let attempts = 0;
		const journal = fileWorkflowJournal(root, {
			rename: (oldPath, newPath) => {
				attempts += 1;
				if (failures > 0) {
					failures -= 1;
					throw Object.assign(new Error('replacement is briefly busy'), { code: 'EBUSY' });
				}
				renameSync(oldPath, newPath);
			}
		});
		const begun = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});

		expect(journal.updateTransfer(begun, { state: 'not-replaced' })).toMatchObject({
			state: 'not-replaced'
		});
		expect(attempts).toBe(3);
		expect(fileWorkflowJournal(root).transfers()).toMatchObject([{ state: 'not-replaced' }]);
	});

	it('keeps a complete failed replacement for startup reconciliation', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root, {
			rename: () => {
				throw Object.assign(new Error('replacement is busy'), { code: 'EBUSY' });
			}
		});
		const begun = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});

		expect(() => journal.updateTransfer(begun, { state: 'not-replaced' })).toThrow(
			/replacement is busy/
		);
		expect(
			readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
		).toHaveLength(1);
		expect(fileWorkflowJournal(root).transfers()).toMatchObject([{ state: 'not-replaced' }]);
		expect(
			readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
		).toEqual([]);
	});

	it('reconciles a failed replacement before same-process retry and clear', () => {
		const root = temp();
		// Eight exhaust the first bounded replacement. The ninth belongs to startup
		// reconciliation, proving that promotion uses the same retry rather than one
		// bare rename.
		let remainingFailures = 9;
		const journal = fileWorkflowJournal(root, {
			rename: (oldPath, newPath) => {
				if (remainingFailures > 0) {
					remainingFailures -= 1;
					throw Object.assign(new Error('replacement is busy'), { code: 'EBUSY' });
				}
				renameSync(oldPath, newPath);
			}
		});
		const begun = journal.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});

		expect(() => journal.updateTransfer(begun, { state: 'not-replaced' })).toThrow();
		const updated = journal.updateTransfer(begun, { state: 'not-replaced' });
		expect(remainingFailures).toBe(0);
		journal.clearTransfer(updated);

		expect(fileWorkflowJournal(root).transfers()).toEqual([]);
		expect(readdirSync(workflowJournalDirectory(root))).toEqual([]);
	});

	it('promotes the exact unanswered-to-unreadable resolution after a failed rename', () => {
		const root = temp();
		const initial = fileWorkflowJournal(root);
		const sending = initial.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		const unanswered = initial.updateTransfer(sending, { state: 'unanswered' });
		const interrupted = fileWorkflowJournal(root, {
			rename: () => {
				throw Object.assign(new Error('replacement is busy'), { code: 'EBUSY' });
			}
		});

		expect(() => interrupted.updateTransfer(unanswered, { state: 'unreadable' })).toThrow(
			/replacement is busy/
		);
		expect(fileWorkflowJournal(root).transfers()).toMatchObject([{ state: 'unreadable' }]);
		expect(
			readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
		).toEqual([]);
	});

	it('promotes the exact unanswered-to-not-replaced cleanup after a failed rename', () => {
		const root = temp();
		const initial = fileWorkflowJournal(root);
		const sending = initial.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		const unanswered = initial.updateTransfer(sending, { state: 'unanswered' });
		const interrupted = fileWorkflowJournal(root, {
			rename: () => {
				throw Object.assign(new Error('replacement is busy'), { code: 'EBUSY' });
			}
		});

		expect(() => interrupted.updateTransfer(unanswered, { state: 'not-replaced' })).toThrow(
			/replacement is busy/
		);
		expect(fileWorkflowJournal(root).transfers()).toMatchObject([{ state: 'not-replaced' }]);
		expect(
			readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
		).toEqual([]);
	});

	it('promotes a replacement-to-unreadable safety record after a failed rename', () => {
		const root = temp();
		const initial = fileWorkflowJournal(root);
		const sending = initial.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		const replacement = initial.updateTransfer(sending, {
			state: 'replacement',
			wrappedKey: WRAPPED,
			replacement: SEALED
		});
		const interrupted = fileWorkflowJournal(root, {
			rename: () => {
				throw Object.assign(new Error('replacement is busy'), { code: 'EBUSY' });
			}
		});

		expect(() =>
			interrupted.updateTransfer(replacement, {
				state: 'unreadable',
				wrappedKey: WRAPPED,
				replacement: SEALED
			})
		).toThrow(/replacement is busy/);
		expect(fileWorkflowJournal(root).transfers()).toMatchObject([
			{ state: 'unreadable', wrappedKey: WRAPPED, replacement: SEALED }
		]);
		expect(
			readdirSync(workflowJournalDirectory(root)).filter((name) => name.endsWith('.tmp'))
		).toEqual([]);
	});

	it('does not broadly promote an unrelated terminal transition', () => {
		const root = temp();
		const initial = fileWorkflowJournal(root);
		const sending = initial.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		const notReplaced = initial.updateTransfer(sending, { state: 'not-replaced' });
		const interrupted = fileWorkflowJournal(root, {
			rename: () => {
				throw Object.assign(new Error('replacement is busy'), { code: 'EBUSY' });
			}
		});
		expect(() => interrupted.updateTransfer(notReplaced, { state: 'unreadable' })).toThrow();

		expect(() => fileWorkflowJournal(root).transfers()).toThrow(/ambiguous staged workflow/);
	});

	it('does not report a workflow durable when a directory flush fails', () => {
		const root = temp();
		const journal = fileWorkflowJournal(root, {
			syncDirectory: () => {
				throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' });
			}
		});
		expect(() =>
			journal.beginTransfer({
				steamId64: STEAM_ID,
				accountName: 'trader',
				at: '2026-09-02T00:00:00.000Z',
				wrappedKey: WRAPPED
			})
		).toThrow(/directory I\/O failure/);
	});

	it.each([
		['hard-link publication', undefined],
		[
			'exclusive-write fallback',
			() => {
				const error = Object.assign(new Error('hard links unavailable'), { code: 'EPERM' });
				throw error;
			}
		]
	] as const)('rolls back %s when the post-publication directory flush fails', (_case, link) => {
		const root = temp();
		let flushes = 0;
		const journal = fileWorkflowJournal(root, {
			...(link === undefined ? {} : { link }),
			syncDirectory: () => {
				flushes += 1;
				if (flushes === 3) {
					throw Object.assign(new Error('post-publication directory I/O failure'), {
						code: 'EIO'
					});
				}
			}
		});

		expect(() =>
			journal.beginTransfer({
				steamId64: STEAM_ID,
				accountName: 'trader',
				at: '2026-09-02T00:00:00.000Z',
				wrappedKey: WRAPPED
			})
		).toThrow(/post-publication/);
		expect(journal.transfers()).toEqual([]);
		expect(readdirSync(workflowJournalDirectory(root))).toEqual([]);
		expect(flushes).toBe(4);
	});

	it('poisons the live journal when a published record cannot be rolled back', () => {
		const root = temp();
		let flushes = 0;
		const journal = fileWorkflowJournal(root, {
			syncDirectory: () => {
				flushes += 1;
				if (flushes === 3) throw Object.assign(new Error('flush failed'), { code: 'EIO' });
			},
			remove: (path) => {
				if (path.endsWith('.json')) {
					throw Object.assign(new Error('rollback delete failed'), { code: 'EACCES' });
				}
				rmSync(path, { force: true });
			}
		});

		expect(() =>
			journal.beginTransfer({
				steamId64: STEAM_ID,
				accountName: 'trader',
				at: '2026-09-02T00:00:00.000Z',
				wrappedKey: WRAPPED
			})
		).toThrow(/rollback could not be verified/i);
		expect(() => journal.transfers()).toThrow(/rollback could not be verified/i);
		// A fresh process sees the exact conservative sending record rather than
		// allowing another operation to be created alongside it.
		expect(fileWorkflowJournal(root).transfers()).toHaveLength(1);
	});

	it('never deletes a final path that another creator already owns', () => {
		const root = temp();
		const sentinel = 'another creator owns this path';
		let claimedPath: string | undefined;
		const journal = fileWorkflowJournal(root, {
			link: (_temp, final) => {
				claimedPath = final;
				writeFileSync(final, sentinel, { flag: 'wx' });
				throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
			}
		});

		expect(() =>
			journal.beginEnrollment({
				steamId64: STEAM_ID,
				accountName: 'trader',
				at: '2026-09-02T00:00:00.000Z',
				wrappedKey: WRAPPED
			})
		).toThrow(/already exists/i);
		expect(readFileSync(claimedPath!, 'utf8')).toBe(sentinel);
	});
});
