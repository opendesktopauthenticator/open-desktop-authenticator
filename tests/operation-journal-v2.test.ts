import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	linkSync,
	mkdtempSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	fileOperationJournal,
	journalDirectory,
	memoryOperationJournal,
	readAllPendingOperations,
	type PendingOperationInput
} from '../src/main/steam/operation-journal';

const STEAM_ID = '76561198000000001';
const INPUT: PendingOperationInput = {
	steamId64: STEAM_ID,
	kind: 'activate',
	fingerprint: 'abcdef0123456789',
	at: '2026-09-03T00:00:00.000Z'
};

/** The relevant behavior of the released fixed-name reader. */
function releasedV1ReadsApplicableNote(
	directory: string,
	fingerprint = INPUT.fingerprint
): boolean {
	for (const kind of ['activate', 'deactivate'] as const) {
		const path = join(journalDirectory(directory), `${STEAM_ID}.${kind}.json`);
		if (!existsSync(path)) continue;
		const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		if (
			value.steamId64 === STEAM_ID &&
			value.kind === kind &&
			value.fingerprint === fingerprint &&
			typeof value.at === 'string'
		) {
			return true;
		}
	}
	return false;
}

describe('OperationJournal v2 exact identities', () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'oda-operation-v2-'));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it('uses a new immutable generation and leaves cleared evidence append-only', () => {
		const journal = fileOperationJournal(directory);
		const first = journal.record(INPUT);

		expect(first.identity).toMatchObject({
			source: 'v2',
			generation: '00000000000000000001',
			steamId64: STEAM_ID,
			kind: 'activate'
		});
		expect(journal.clear(first)).toBe('cleared');
		const second = journal.record({ ...INPUT, at: '2026-09-03T00:01:00.000Z' });

		expect(second.identity.generation).toBe('00000000000000000002');
		expect(second.identity.recordId).not.toBe(first.identity.recordId);
		expect(readdirSync(join(journalDirectory(directory), 'v2'))).toEqual(
			expect.arrayContaining([
				`${STEAM_ID}.activate.00000000000000000001.pending.json`,
				`${STEAM_ID}.activate.00000000000000000001.${first.identity.digest}.cleared.json`,
				`${STEAM_ID}.activate.00000000000000000002.pending.json`
			])
		);
	});

	it('publishes a fixed-name guard that makes a released-v1 downgrade fail closed', () => {
		fileOperationJournal(directory).record(INPUT);

		expect(releasedV1ReadsApplicableNote(directory)).toBe(true);
		const guard = JSON.parse(
			readFileSync(join(journalDirectory(directory), `${STEAM_ID}.activate.json`), 'utf8')
		) as Record<string, unknown>;
		expect(guard).toMatchObject({ version: 2, state: 'v2-downgrade-guard' });
	});

	it('ignores only an exactly shaped v2 downgrade guard', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, `${STEAM_ID}.activate.json`),
			JSON.stringify({
				version: 2,
				state: 'v2-downgrade-guard',
				steamId64: STEAM_ID,
				kind: 'activate',
				fingerprint: INPUT.fingerprint,
				at: '1970-01-01T00:00:00.000Z',
				unexpected: true
			}),
			'utf8'
		);

		expect(() => fileOperationJournal(directory).readAll(STEAM_ID)).toThrow(/cannot understand/i);
	});

	it('makes the downgrade guard durable before attempting the v2 pending publication', () => {
		let sawGuardBeforePending = false;
		const journal = fileOperationJournal(directory, {
			linkFinal: (source, target) => {
				if (target.endsWith('.pending.json')) {
					sawGuardBeforePending = releasedV1ReadsApplicableNote(directory);
					throw Object.assign(new Error('stop before v2 publication'), { code: 'EIO' });
				}
				linkSync(source, target);
			}
		});

		expect(() => journal.record(INPUT)).toThrow(/nothing was sent/i);
		expect(sawGuardBeforePending).toBe(true);
		expect(
			readdirSync(join(journalDirectory(directory), 'v2')).some((name) =>
				name.endsWith('.pending.json')
			)
		).toBe(false);
	});

	it('refreshes its own guard before publishing for replacement secrets', () => {
		const first = fileOperationJournal(directory);
		const old = first.record(INPUT);
		expect(first.clear(old)).toBe('cleared');
		const replacementFingerprint = '0123456789abcdef';
		let sawReplacementGuard = false;
		const replacement = fileOperationJournal(directory, {
			linkFinal: (source, target) => {
				if (target.endsWith('.00000000000000000002.pending.json')) {
					sawReplacementGuard = releasedV1ReadsApplicableNote(directory, replacementFingerprint);
				}
				linkSync(source, target);
			}
		});

		const live = replacement.record({
			...INPUT,
			fingerprint: replacementFingerprint,
			at: '2026-09-03T00:01:00.000Z'
		});

		expect(sawReplacementGuard).toBe(true);
		expect(live.fingerprint).toBe(replacementFingerprint);
		expect(releasedV1ReadsApplicableNote(directory, replacementFingerprint)).toBe(true);
	});

	it('does not report replacement guard publication when its directory flush fails', () => {
		const first = fileOperationJournal(directory);
		const old = first.record(INPUT);
		first.clear(old);
		const root = journalDirectory(directory);
		const replacementFingerprint = '0123456789abcdef';
		let failedReplacementFlush = false;
		const replacement = fileOperationJournal(directory, {
			syncDirectory: (path) => {
				if (
					path === root &&
					!failedReplacementFlush &&
					releasedV1ReadsApplicableNote(directory, replacementFingerprint)
				) {
					failedReplacementFlush = true;
					throw Object.assign(new Error('guard directory flush failed'), { code: 'EIO' });
				}
			}
		});

		expect(() =>
			replacement.record({
				...INPUT,
				fingerprint: replacementFingerprint,
				at: '2026-09-03T00:01:00.000Z'
			})
		).toThrow(/nothing was sent/i);
		expect(failedReplacementFlush).toBe(true);
		expect(
			readdirSync(join(root, 'v2')).some((name) =>
				name.endsWith('.00000000000000000002.pending.json')
			)
		).toBe(false);
		const stillUnverified = fileOperationJournal(directory, {
			syncDirectory: (path) => {
				if (path === root) throw Object.assign(new Error('still unavailable'), { code: 'EIO' });
			}
		});
		expect(() =>
			stillUnverified.record({
				...INPUT,
				fingerprint: replacementFingerprint,
				at: '2026-09-03T00:02:00.000Z'
			})
		).toThrow(/nothing was sent/i);
		expect(
			readdirSync(join(root, 'v2')).some((name) =>
				name.endsWith('.00000000000000000002.pending.json')
			)
		).toBe(false);
		const retry = fileOperationJournal(directory).record({
			...INPUT,
			fingerprint: replacementFingerprint,
			at: '2026-09-03T00:03:00.000Z'
		});
		expect(retry.identity.generation).toBe('00000000000000000002');
	});

	it('never attempts the v2 pending record when the fixed-name guard cannot publish', () => {
		const attempted: string[] = [];
		const journal = fileOperationJournal(directory, {
			linkFinal: (source, target) => {
				attempted.push(target);
				if (!target.includes(`${join('pending-operations', 'v2')}`)) {
					throw Object.assign(new Error('fixed path unavailable'), { code: 'EIO' });
				}
				linkSync(source, target);
			}
		});

		expect(() => journal.record(INPUT)).toThrow(/nothing was sent/i);
		expect(attempted.some((path) => path.endsWith('.pending.json'))).toBe(false);
	});

	it('never hides a mismatching real activation record behind a second fixed-name guard', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		const legacyPath = join(root, `${STEAM_ID}.activate.json`);
		const legacyBody = JSON.stringify({ ...INPUT, fingerprint: '0123456789abcdef' });
		writeFileSync(legacyPath, legacyBody, 'utf8');
		const journal = fileOperationJournal(directory);

		expect(() => journal.record({ ...INPUT, kind: 'deactivate' })).toThrow(/nothing was sent/i);
		expect(readFileSync(legacyPath, 'utf8')).toBe(legacyBody);
		expect(existsSync(join(root, `${STEAM_ID}.deactivate.json`))).toBe(false);
		expect(
			existsSync(join(root, 'v2')) &&
				readdirSync(join(root, 'v2')).some((name) => name.endsWith('.pending.json'))
		).toBe(false);
	});

	it('cannot clear a replacement with a stale handle from another instance', () => {
		const firstProcess = fileOperationJournal(directory);
		const old = firstProcess.record(INPUT);
		const secondProcess = fileOperationJournal(directory);
		expect(secondProcess.clear(old)).toBe('cleared');
		const replacement = secondProcess.record({ ...INPUT, at: '2026-09-03T00:02:00.000Z' });

		expect(firstProcess.clear(old)).toBe('already-cleared');
		expect(fileOperationJournal(directory).readKind(STEAM_ID, 'activate')?.identity).toEqual(
			replacement.identity
		);
	});

	it('rejects a forged exact identity without changing the live record', () => {
		const journal = fileOperationJournal(directory);
		const live = journal.record(INPUT);

		expect(() => journal.clear({ ...live.identity, digest: '0'.repeat(64) })).toThrow(
			/could not be cleared durably/i
		);
		expect(journal.readKind(STEAM_ID, 'activate')?.identity).toEqual(live.identity);
	});

	it('reads a fixed-name v1 record and clears it without deleting or rewriting it', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		const legacyPath = join(root, `${STEAM_ID}.activate.json`);
		const legacyBody = JSON.stringify({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: INPUT.fingerprint,
			at: INPUT.at
		});
		writeFileSync(legacyPath, legacyBody, 'utf8');
		const journal = fileOperationJournal(directory);
		const legacy = journal.readKind(STEAM_ID, 'activate')!;

		expect(legacy.identity).toMatchObject({
			source: 'legacy-v1',
			generation: '00000000000000000000',
			recordId: `legacy:${createHash('sha256').update(legacyBody).digest('hex')}`
		});
		expect(journal.clear(legacy)).toBe('cleared');
		expect(readFileSync(legacyPath, 'utf8')).toBe(legacyBody);
		expect(journal.readKind(STEAM_ID, 'activate')).toBeUndefined();

		const next = journal.record(INPUT);
		expect(next.identity.generation).toBe('00000000000000000001');
		expect(readFileSync(legacyPath, 'utf8')).toBe(legacyBody);
	});

	it('archives a tombstoned legacy record before guarding replacement secrets', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		const legacyPath = join(root, `${STEAM_ID}.activate.json`);
		const legacyBody = JSON.stringify(INPUT);
		const legacyDigest = createHash('sha256').update(legacyBody).digest('hex');
		writeFileSync(legacyPath, legacyBody, 'utf8');
		const journal = fileOperationJournal(directory);
		const legacy = journal.readKind(STEAM_ID, 'activate')!;
		expect(journal.clear(legacy)).toBe('cleared');
		const replacementFingerprint = '0123456789abcdef';

		const replacement = journal.record({
			...INPUT,
			fingerprint: replacementFingerprint,
			at: '2026-09-03T00:02:00.000Z'
		});
		const archivePath = join(root, 'v2', `${STEAM_ID}.activate.legacy.${legacyDigest}.json`);

		expect(readFileSync(archivePath, 'utf8')).toBe(legacyBody);
		expect(releasedV1ReadsApplicableNote(directory, replacementFingerprint)).toBe(true);
		expect(journal.inspect(legacy)).toBe('cleared');
		expect(journal.readKind(STEAM_ID, 'activate')?.identity).toEqual(replacement.identity);
	});

	it('keeps the fixed legacy note when guard replacement stops after its durable archive', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		const legacyPath = join(root, `${STEAM_ID}.activate.json`);
		const legacyBody = JSON.stringify(INPUT);
		const legacyDigest = createHash('sha256').update(legacyBody).digest('hex');
		const archivePath = join(root, 'v2', `${STEAM_ID}.activate.legacy.${legacyDigest}.json`);
		writeFileSync(legacyPath, legacyBody, 'utf8');
		const initial = fileOperationJournal(directory);
		initial.clear(initial.readKind(STEAM_ID, 'activate')!);
		let sawDurableArchive = false;
		const interrupted = fileOperationJournal(directory, {
			replaceFinal: () => {
				sawDurableArchive = readFileSync(archivePath, 'utf8') === legacyBody;
				throw Object.assign(new Error('stopped before guard rename'), { code: 'EIO' });
			}
		});

		expect(() =>
			interrupted.record({
				...INPUT,
				fingerprint: '0123456789abcdef',
				at: '2026-09-03T00:02:00.000Z'
			})
		).toThrow(/nothing was sent/i);
		expect(sawDurableArchive).toBe(true);
		expect(readFileSync(legacyPath, 'utf8')).toBe(legacyBody);
		expect(
			readdirSync(join(root, 'v2')).some((name) =>
				name.endsWith('.00000000000000000001.pending.json')
			)
		).toBe(false);

		const retry = fileOperationJournal(directory).record({
			...INPUT,
			fingerprint: '0123456789abcdef',
			at: '2026-09-03T00:03:00.000Z'
		});
		expect(retry.identity.generation).toBe('00000000000000000001');
	});

	it('discards a pre-rename replacement stage while retaining its valid fixed guard', () => {
		const journal = fileOperationJournal(directory);
		const old = journal.record(INPUT);
		journal.clear(old);
		const root = journalDirectory(directory);
		const fixedPath = join(root, `${STEAM_ID}.activate.json`);
		const oldBody = readFileSync(fixedPath, 'utf8');
		const stage = `${fixedPath}.11111111-1111-4111-8111-111111111111.tmp`;
		writeFileSync(
			stage,
			JSON.stringify({
				version: 2,
				state: 'v2-downgrade-guard',
				steamId64: STEAM_ID,
				kind: 'activate',
				fingerprint: '0123456789abcdef',
				at: '1970-01-01T00:00:00.000Z'
			}),
			'utf8'
		);

		expect(fileOperationJournal(directory).readKind(STEAM_ID, 'activate')).toBeUndefined();
		expect(readFileSync(fixedPath, 'utf8')).toBe(oldBody);
		expect(existsSync(stage)).toBe(false);
	});

	it('recovers a staged first guard without hard-link support', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		const fixedPath = join(root, `${STEAM_ID}.activate.json`);
		const stage = `${fixedPath}.11111111-1111-4111-8111-111111111111.tmp`;
		writeFileSync(
			stage,
			JSON.stringify({
				version: 2,
				state: 'v2-downgrade-guard',
				steamId64: STEAM_ID,
				kind: 'activate',
				fingerprint: INPUT.fingerprint,
				at: '1970-01-01T00:00:00.000Z'
			}),
			'utf8'
		);
		const recovering = fileOperationJournal(directory, {
			linkFinal: () => {
				throw Object.assign(new Error('hard links unsupported'), { code: 'ENOSYS' });
			}
		});

		expect(recovering.readKind(STEAM_ID, 'activate')).toBeUndefined();
		expect(releasedV1ReadsApplicableNote(directory)).toBe(true);
		expect(existsSync(stage)).toBe(false);
	});

	it('fails closed if legacy bytes change after their exact tombstone was written', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		const path = join(root, `${STEAM_ID}.activate.json`);
		writeFileSync(path, JSON.stringify(INPUT), 'utf8');
		const journal = fileOperationJournal(directory);
		journal.clear(journal.readKind(STEAM_ID, 'activate')!);
		writeFileSync(path, JSON.stringify({ ...INPUT, fingerprint: '0123456789abcdef' }), 'utf8');

		expect(() => fileOperationJournal(directory).readKind(STEAM_ID, 'activate')).toThrow(
			/no exact pending record/i
		);
	});

	it('fails closed on a legacy record whose authenticator identity is malformed', () => {
		const root = journalDirectory(directory);
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, `${STEAM_ID}.activate.json`),
			JSON.stringify({ ...INPUT, fingerprint: 'not-an-authenticator-fingerprint' }),
			'utf8'
		);

		expect(() => fileOperationJournal(directory).readKind(STEAM_ID, 'activate')).toThrow(
			/cannot understand/i
		);
	});

	it('does not report a record as durable when a directory flush fails', () => {
		const journal = fileOperationJournal(directory, {
			syncDirectory: () => {
				throw Object.assign(new Error('disk failure'), { code: 'EIO' });
			}
		});

		expect(() => journal.record(INPUT)).toThrow(/nothing was sent/i);
	});

	it('does not report a record as durable when a file flush fails', () => {
		const journal = fileOperationJournal(directory, {
			syncFile: () => {
				throw Object.assign(new Error('file flush failed'), { code: 'EIO' });
			}
		});

		expect(() => journal.record(INPUT)).toThrow(/nothing was sent/i);
	});

	it('leaves a partial exclusive-write fallback fail-closed', () => {
		const journal = fileOperationJournal(directory, {
			linkFinal: (source, target) => {
				if (target.endsWith('.pending.json')) {
					throw Object.assign(new Error('hard links unsupported'), { code: 'ENOSYS' });
				}
				linkSync(source, target);
			},
			openFinal: (target) => {
				const claimed = openSync(target, 'wx', 0o600);
				closeSync(claimed);
				writeFileSync(target, '{', 'utf8');
				// Returning a descriptor whose write must fail models a process/filesystem
				// stopping after the exclusive final name was claimed.
				return openSync(target, 'r');
			}
		});

		expect(() => journal.record(INPUT)).toThrow(/nothing was sent/i);
		expect(() => fileOperationJournal(directory).readKind(STEAM_ID, 'activate')).toThrow(
			/cannot understand/i
		);
	});

	it('does not delete the valid winner after losing exclusive publication', () => {
		const winnerId = '55555555-5555-4555-8555-555555555555';
		const journal = fileOperationJournal(directory, {
			linkFinal: (source, target) => {
				if (target.endsWith('.pending.json')) {
					writeFileSync(
						target,
						JSON.stringify({
							version: 2,
							state: 'pending',
							...INPUT,
							generation: '00000000000000000001',
							recordId: winnerId
						}),
						{ flag: 'wx', mode: 0o600 }
					);
					throw Object.assign(new Error('another process won'), { code: 'EEXIST' });
				}
				linkSync(source, target);
			}
		});

		expect(() => journal.record(INPUT)).toThrow(/nothing was sent/i);
		expect(fileOperationJournal(directory).readKind(STEAM_ID, 'activate')?.identity.recordId).toBe(
			winnerId
		);
	});

	it('keeps a mismatching published final as fail-closed repair evidence', () => {
		const journal = fileOperationJournal(directory, {
			linkFinal: (source, target) => {
				if (target.endsWith('.pending.json')) {
					writeFileSync(target, '{}', { flag: 'wx', mode: 0o600 });
					return;
				}
				linkSync(source, target);
			}
		});

		expect(() => journal.record(INPUT)).toThrow(/nothing was sent/i);
		expect(() => fileOperationJournal(directory).readKind(STEAM_ID, 'activate')).toThrow(
			/cannot understand/i
		);
	});

	it('does not report a clear as durable until the final directory entry is flushed', () => {
		const written = fileOperationJournal(directory);
		const live = written.record(INPUT);
		const v2 = join(journalDirectory(directory), 'v2');
		let failedFinalFlush = false;
		const failing = fileOperationJournal(directory, {
			syncDirectory: (path) => {
				if (
					path === v2 &&
					!failedFinalFlush &&
					readdirSync(v2).some((name) => name.endsWith('.cleared.json'))
				) {
					failedFinalFlush = true;
					throw Object.assign(new Error('disk failure'), { code: 'EIO' });
				}
			}
		});

		expect(() => failing.clear(live)).toThrow(/could not be cleared durably/i);
		expect(failedFinalFlush).toBe(true);
		// A fresh process can establish the final entry's durability from the
		// retained, already-durable stage and only then regard it as cleared.
		expect(fileOperationJournal(directory).inspect(live)).toBe('cleared');
	});

	it('keeps working when only temporary-file cleanup fails after durable publication', () => {
		const journal = fileOperationJournal(directory, {
			remove: () => {
				throw Object.assign(new Error('busy'), { code: 'EBUSY' });
			}
		});
		const live = journal.record(INPUT);

		expect(journal.readKind(STEAM_ID, 'activate')?.identity).toEqual(live.identity);
		expect(journal.clear(live)).toBe('cleared');
		expect(journal.readKind(STEAM_ID, 'activate')).toBeUndefined();
	});

	it('accepts an identical concurrent tombstone on the no-hardlink fallback', () => {
		const live = fileOperationJournal(directory).record(INPUT);
		let raced = false;
		const clearer = fileOperationJournal(directory, {
			linkFinal: () => {
				throw Object.assign(new Error('hard links unsupported'), { code: 'ENOSYS' });
			},
			openFinal: (target) => {
				if (target.includes('.cleared.') && !raced) {
					raced = true;
					// Its read reconciles the first clearer's already-durable stage and
					// publishes the exact tombstone before the fallback claims the name.
					expect(fileOperationJournal(directory).clear(live)).toBe('already-cleared');
				}
				return openSync(target, 'wx', 0o600);
			}
		});

		expect(clearer.clear(live)).toBe('cleared');
		expect(raced).toBe(true);
	});

	it('recovers one complete staged generation before treating the journal as empty', () => {
		const v2 = join(journalDirectory(directory), 'v2');
		mkdirSync(v2, { recursive: true });
		const finalName = `${STEAM_ID}.activate.00000000000000000001.pending.json`;
		const body = JSON.stringify({
			version: 2,
			state: 'pending',
			...INPUT,
			generation: '00000000000000000001',
			recordId: '11111111-1111-4111-8111-111111111111'
		});
		writeFileSync(join(v2, `${finalName}.22222222-2222-4222-8222-222222222222.tmp`), body, 'utf8');

		expect(fileOperationJournal(directory).readKind(STEAM_ID, 'activate')?.identity.recordId).toBe(
			'11111111-1111-4111-8111-111111111111'
		);
		expect(existsSync(join(v2, finalName))).toBe(true);
	});

	it('fails closed rather than choosing between conflicting unpublished generations', () => {
		const v2 = join(journalDirectory(directory), 'v2');
		mkdirSync(v2, { recursive: true });
		const finalName = `${STEAM_ID}.activate.00000000000000000001.pending.json`;
		for (const [recordId, stageId] of [
			['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
			['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
		] as const) {
			writeFileSync(
				join(v2, `${finalName}.${stageId}.tmp`),
				JSON.stringify({
					version: 2,
					state: 'pending',
					...INPUT,
					generation: '00000000000000000001',
					recordId
				}),
				'utf8'
			);
		}

		expect(() => fileOperationJournal(directory).readKind(STEAM_ID, 'activate')).toThrow(
			/conflicting staged/i
		);
	});

	it('refuses unknown or orphaned v2 evidence instead of treating it as absent', () => {
		const v2 = join(journalDirectory(directory), 'v2');
		mkdirSync(v2, { recursive: true });
		writeFileSync(join(v2, 'future.v3.json'), '{}', 'utf8');

		expect(() => fileOperationJournal(directory).readAll(STEAM_ID)).toThrow(/cannot understand/i);
		expect(() => readAllPendingOperations(directory)).toThrow(/cannot understand/i);
	});

	it('fails closed on an exact tombstone whose pending record was removed', () => {
		const journal = fileOperationJournal(directory);
		const live = journal.record(INPUT);
		journal.clear(live);
		rmSync(
			join(
				journalDirectory(directory),
				'v2',
				`${STEAM_ID}.activate.${live.identity.generation}.pending.json`
			)
		);

		expect(() => fileOperationJournal(directory).readKind(STEAM_ID, 'activate')).toThrow(
			/no exact pending record/i
		);
	});

	it('uses exact handles in the in-memory contract too', () => {
		const journal = memoryOperationJournal();
		const old = journal.record(INPUT);
		expect(journal.clear(old)).toBe('cleared');
		const current = journal.record({ ...INPUT, at: '2026-09-03T00:03:00.000Z' });

		expect(journal.clear(old)).toBe('already-cleared');
		expect(journal.readKind(STEAM_ID, 'activate')?.identity).toEqual(current.identity);
	});

	it('uses a deterministic final path so two publishers contend instead of both winning', () => {
		const linked: string[] = [];
		const journal = fileOperationJournal(directory, {
			linkFinal: (source, target) => {
				linked.push(target);
				linkSync(source, target);
			}
		});
		const live = journal.record(INPUT);

		expect(linked.some((path) => path.endsWith('.00000000000000000001.pending.json'))).toBe(true);
		expect(() => journal.record({ ...INPUT, at: '2026-09-03T00:04:00.000Z' })).toThrow(
			/nothing was sent/i
		);
		expect(journal.readKind(STEAM_ID, 'activate')?.identity).toEqual(live.identity);
	});

	it('keeps all journal files inside digit-only account paths', () => {
		const journal = fileOperationJournal(directory);
		expect(() => journal.record({ ...INPUT, steamId64: '../../escaped' })).toThrow(
			/no Steam request was sent/i
		);
		expect(existsSync(join(directory, '..', 'escaped.activate.json'))).toBe(false);
	});
});
