import { randomUUID } from 'node:crypto';
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { envelopeSchema, type Envelope } from '../../shared/vault-format';
import { renameWithTransientRetry } from '../atomic-replace';
import { openBytesWithKey, wipe } from '../vault/crypto';

const steamId = z.string().regex(/^[0-9]{1,32}$/);
const attemptId = z.string().uuid();
const accountName = z.string().min(1).max(64);
const timestamp = z.string().min(1).max(64);

const sealedReplacementSchema = z
	.object({
		nonce: z.string().min(1).max(128),
		tag: z.string().min(1).max(128),
		ciphertext: z
			.string()
			.min(1)
			.max(128 * 1024)
	})
	.strict();

const enrollmentRecordSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal('enrollment-add'),
		attemptId,
		steamId64: steamId,
		accountName,
		at: timestamp,
		state: z.enum([
			'sending',
			'unanswered',
			'not-attached',
			'attached',
			'recoverable',
			'unreadable'
		]),
		/** Optional only so records written by the earlier v1 build remain readable. */
		wrappedKey: envelopeSchema.optional(),
		recovery: sealedReplacementSchema.optional(),
		/** Whether the separate per-account recovery file was durably published. */
		recoveryPublished: z.boolean().optional()
	})
	.strict()
	.superRefine((record, context) => {
		if (
			(record.state === 'recoverable' || record.state === 'unreadable') &&
			(record.wrappedKey === undefined || record.recovery === undefined)
		) {
			context.addIssue({
				code: 'custom',
				message: 'retained enrollment needs key and ciphertext'
			});
		}
		if (
			record.state !== 'recoverable' &&
			record.state !== 'unreadable' &&
			record.recovery !== undefined
		) {
			context.addIssue({
				code: 'custom',
				message: 'only retained enrollment may hold ciphertext'
			});
		}
		if (
			(record.state === 'unanswered' || record.state === 'attached') &&
			record.wrappedKey !== undefined
		) {
			context.addIssue({
				code: 'custom',
				message: 'terminal enrollment metadata cannot hold a key'
			});
		}
	});
const transferRecordSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal('transfer'),
		attemptId,
		steamId64: steamId,
		accountName,
		at: timestamp,
		/** Exact old authenticator found in the compatible backup before submission. */
		priorAuthenticatorFingerprint: z
			.string()
			.regex(/^[0-9a-f]{16}$/)
			.optional(),
		state: z.enum(['sending', 'unanswered', 'unreadable', 'not-replaced', 'replacement']),
		wrappedKey: envelopeSchema.optional(),
		replacement: sealedReplacementSchema.optional(),
		/** Whether the separate per-account recovery file was durably published. */
		recoveryPublished: z.boolean().optional()
	})
	.strict()
	.superRefine((record, context) => {
		if (record.state === 'sending' && record.wrappedKey === undefined) {
			context.addIssue({ code: 'custom', message: 'a sending transfer needs its wrapped key' });
		}
		if (
			record.state === 'replacement' &&
			(record.wrappedKey === undefined || record.replacement === undefined)
		) {
			context.addIssue({ code: 'custom', message: 'a replacement needs its key and ciphertext' });
		}
		if (
			record.state === 'unreadable' &&
			(record.wrappedKey === undefined) !== (record.replacement === undefined)
		) {
			context.addIssue({
				code: 'custom',
				message: 'an unreadable retained reply needs both its key and ciphertext'
			});
		}
		if (
			record.state !== 'replacement' &&
			record.state !== 'unreadable' &&
			record.replacement !== undefined
		) {
			context.addIssue({ code: 'custom', message: 'only a retained reply may hold ciphertext' });
		}
	});

export type EnrollmentWorkflowRecord = z.infer<typeof enrollmentRecordSchema>;
export type TransferWorkflowRecord = z.infer<typeof transferRecordSchema>;
export type SealedWorkflowPayload = z.infer<typeof sealedReplacementSchema>;
export type SealedTransferReplacement = SealedWorkflowPayload;

export class WorkflowJournalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkflowJournalError';
	}
}

/** A newly published record could not be rolled back with verified durability. */
class WorkflowJournalRollbackError extends WorkflowJournalError {}

export interface WorkflowJournal {
	beginEnrollment(input: {
		steamId64: string;
		accountName: string;
		at: string;
		/** Required for new attempts; the disk parser alone accepts legacy v1 records without it. */
		wrappedKey: Envelope;
	}): EnrollmentWorkflowRecord;
	updateEnrollment(
		record: EnrollmentWorkflowRecord,
		update:
			| 'unanswered'
			| 'not-attached'
			| 'attached'
			| {
					state: 'recoverable' | 'unreadable';
					wrappedKey: Envelope;
					recovery: SealedWorkflowPayload;
			  }
	): EnrollmentWorkflowRecord;
	markEnrollmentRecovery(
		record: EnrollmentWorkflowRecord,
		published: boolean
	): EnrollmentWorkflowRecord;
	clearEnrollment(record: Pick<EnrollmentWorkflowRecord, 'steamId64' | 'attemptId'>): void;
	enrollments(steamId64?: string): EnrollmentWorkflowRecord[];

	beginTransfer(input: {
		steamId64: string;
		accountName: string;
		at: string;
		wrappedKey: Envelope;
		priorAuthenticatorFingerprint?: string;
	}): TransferWorkflowRecord;
	updateTransfer(
		record: TransferWorkflowRecord,
		update:
			| { state: 'unanswered' | 'not-replaced' }
			| {
					state: 'unreadable';
					wrappedKey?: Envelope;
					replacement?: SealedTransferReplacement;
			  }
			| {
					state: 'replacement';
					wrappedKey: Envelope;
					replacement: SealedTransferReplacement;
			  }
	): TransferWorkflowRecord;
	markTransferRecovery(record: TransferWorkflowRecord, published: boolean): TransferWorkflowRecord;
	clearTransfer(record: Pick<TransferWorkflowRecord, 'steamId64' | 'attemptId'>): void;
	transfers(steamId64?: string): TransferWorkflowRecord[];
	/** Whether this candidate's actual key opens every wrapped workflow key. */
	vaultKeyCompatible(candidate: Pick<Envelope, 'kdf'>, key: Buffer): boolean;
}

export function workflowJournalDirectory(userDataPath: string): string {
	return join(userDataPath, 'pending-steam-workflows');
}

const FILE = /^(\d{1,32})\.(enrollment|transfer)\.([0-9a-f-]{36})\.json$/i;
const STAGED_FILE =
	/^((\d{1,32})\.(enrollment|transfer)\.([0-9a-f-]{36})\.json)\.([0-9a-f-]{36})\.tmp$/i;
const MAX_WORKFLOW_RECORD_BYTES = 256 * 1024;

const WORKFLOW_KEY_BYTES = 32;

/**
 * KDF metadata identifies how a key was derived, not which passphrase produced
 * it. Prove compatibility by authenticating every wrapped workflow key with the
 * candidate key itself. A successful GCM tag check is the identity proof.
 */
function keyOpensEveryWorkflow(
	records: Array<EnrollmentWorkflowRecord | TransferWorkflowRecord>,
	candidate: Pick<Envelope, 'kdf'>,
	key: Buffer
): boolean {
	for (const record of records) {
		if (record.wrappedKey === undefined) continue;
		let opened: Buffer | undefined;
		try {
			opened = openBytesWithKey(record.wrappedKey, key, candidate.kdf);
			if (opened.length !== WORKFLOW_KEY_BYTES) return false;
		} catch {
			return false;
		} finally {
			if (opened !== undefined) wipe(opened);
		}
	}
	return true;
}

function fileName(
	steamId64: string,
	kind: 'enrollment' | 'transfer',
	id: string
): string | undefined {
	return /^[0-9]{1,32}$/.test(steamId64) && z.string().uuid().safeParse(id).success
		? `${steamId64}.${kind}.${id.toLowerCase()}.json`
		: undefined;
}

function writeAll(fd: number, text: string): void {
	const bytes = Buffer.from(text, 'utf8');
	let written = 0;
	while (written < bytes.length) {
		const count = writeSync(fd, bytes, written, bytes.length - written);
		if (count <= 0) {
			throw new WorkflowJournalError('the workflow record stopped writing before it was complete');
		}
		written += count;
	}
}

function syncDirectory(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		fsyncSync(fd);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// Node/Windows does not expose a flushable directory handle. Do not turn that
		// into a universal best-effort catch: on Linux, EIO/ENOSPC here means the
		// pre-send record's directory entry is not durable and the request must stop.
		if (
			process.platform === 'win32' &&
			(code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'EBADF')
		) {
			return;
		}
		throw err;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function staged(
	path: string,
	body: string,
	flushDirectory: (path: string) => void = syncDirectory
): string {
	const temp = `${path}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temp, 'wx', 0o600);
		writeAll(fd, body);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// The file contents are durable, but a crash can still lose the new temp
		// directory entry. That entry is the only recoverable copy if the atomic
		// replacement below cannot complete, so persist it before publication.
		flushDirectory(dirname(temp));
		return temp;
	} catch (err) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// The original error is the useful one.
			}
		}
		rmSync(temp, { force: true });
		throw err;
	}
}

function createDurably(
	path: string,
	body: string,
	link: (existingPath: string, newPath: string) => void = linkSync,
	flushDirectory: (path: string) => void = syncDirectory,
	remove: (path: string) => void = (target) => rmSync(target, { force: true })
): void {
	const temp = staged(path, body, flushDirectory);
	let published = false;
	try {
		try {
			link(temp, path);
			published = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
				throw err;
			}
			// Filesystems without hard links get an exclusive final descriptor. Do not
			// claim an empty path and then rename over it: Windows refuses that rename,
			// leaving a malformed permanent debt even though begin reported failure.
			// A hard crash during this direct write remains fail-closed by design.
			let claimed: number | undefined;
			try {
				claimed = openSync(path, 'wx', 0o600);
				published = true;
				writeAll(claimed, body);
				fsyncSync(claimed);
				closeSync(claimed);
				claimed = undefined;
			} catch (fallbackError) {
				if (claimed !== undefined) {
					try {
						closeSync(claimed);
					} catch {
						// Preserve the write failure.
					}
				}
				throw fallbackError;
			}
		}
		remove(temp);
		flushDirectory(dirname(path));
	} catch (err) {
		try {
			remove(temp);
		} catch {
			// Rollback of the final record is the safety property. A stale temp is
			// surfaced and reconciled on the next read rather than masking this error.
		}
		if (published) {
			try {
				remove(path);
				flushDirectory(dirname(path));
			} catch {
				throw new WorkflowJournalRollbackError(
					'the workflow record could not be published, and its rollback could not be verified; repair the pending workflow directory before retrying'
				);
			}
		}
		throw err;
	}
}

/**
 * Windows can keep a freshly hard-linked record non-replaceable while scanners
 * inspect it. The existing exclusive descriptor fallback is fail-closed on a
 * crash, so use that path deliberately there; Linux keeps atomic hard-link
 * publication.
 */
function defaultInitialLink(existingPath: string, newPath: string): void {
	if (process.platform === 'win32') {
		const unsupported = new Error(
			'Windows first publication uses the exclusive-write fallback'
		) as NodeJS.ErrnoException;
		unsupported.code = 'ENOTSUP';
		throw unsupported;
	}
	linkSync(existingPath, newPath);
}

function replaceDurably(
	path: string,
	body: string,
	flushDirectory: (path: string) => void = syncDirectory,
	rename: (oldPath: string, newPath: string) => void = renameSync
): void {
	const temp = staged(path, body, flushDirectory);
	// If rename fails, the complete fsynced temp remains for startup
	// reconciliation. If the directory flush fails after rename, the conservative
	// final remains visible. Neither case should remove the staged evidence here.
	renameWithTransientRetry(rename, temp, path);
	flushDirectory(dirname(path));
}

function byNewest<T extends { at: string; attemptId: string }>(left: T, right: T): number {
	return right.at.localeCompare(left.at) || right.attemptId.localeCompare(left.attemptId);
}

export function fileWorkflowJournal(
	userDataPath: string,
	fileOps: {
		link?: (existingPath: string, newPath: string) => void;
		rename?: (oldPath: string, newPath: string) => void;
		syncDirectory?: (path: string) => void;
		remove?: (path: string) => void;
	} = {}
): WorkflowJournal {
	const directory = workflowJournalDirectory(userDataPath);
	const flushDirectory = fileOps.syncDirectory ?? syncDirectory;
	const replacementRename = fileOps.rename ?? renameSync;
	let publicationDebt: WorkflowJournalRollbackError | undefined;
	let reconcilePendingStaged: () => void = () => undefined;

	const pathFor = (steamId64: string, kind: 'enrollment' | 'transfer', id: string): string => {
		const name = fileName(steamId64, kind, id);
		if (name === undefined) {
			throw new WorkflowJournalError('refusing an invalid Steam workflow identifier');
		}
		return join(directory, name);
	};

	const writeNew = (path: string, value: unknown): void => {
		if (publicationDebt !== undefined) throw publicationDebt;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		// On first use, persisting a file inside the new child is not enough: the
		// child directory's entry must also be flushed in its parent.
		flushDirectory(dirname(directory));
		try {
			createDurably(
				path,
				JSON.stringify(value),
				fileOps.link ?? defaultInitialLink,
				flushDirectory,
				fileOps.remove
			);
		} catch (err) {
			if (err instanceof WorkflowJournalRollbackError) publicationDebt = err;
			throw err;
		}
		if (readFileSync(path, 'utf8') !== JSON.stringify(value)) {
			throw new WorkflowJournalError('the workflow record did not read back faithfully');
		}
	};

	const replace = (path: string, value: unknown): void => {
		reconcilePendingStaged();
		replaceDurably(path, JSON.stringify(value), flushDirectory, replacementRename);
		if (readFileSync(path, 'utf8') !== JSON.stringify(value)) {
			throw new WorkflowJournalError('the updated workflow record did not read back faithfully');
		}
	};

	type Record = EnrollmentWorkflowRecord | TransferWorkflowRecord;
	const readRecord = (
		name: string,
		path: string,
		fileSteamId: string,
		fileKind: 'enrollment' | 'transfer',
		fileAttemptId: string
	): Record => {
		if (statSync(path).size > MAX_WORKFLOW_RECORD_BYTES) {
			throw new WorkflowJournalError(`pending workflow record ${name} is too large`);
		}
		let record: Record;
		try {
			const decoded = JSON.parse(readFileSync(path, 'utf8')) as unknown;
			record =
				fileKind === 'enrollment'
					? enrollmentRecordSchema.parse(decoded)
					: transferRecordSchema.parse(decoded);
		} catch {
			throw new WorkflowJournalError(`cannot understand pending workflow record ${name}`);
		}
		const recordKind = record.kind === 'enrollment-add' ? 'enrollment' : 'transfer';
		if (
			record.steamId64 !== fileSteamId ||
			recordKind !== fileKind ||
			record.attemptId.toLowerCase() !== fileAttemptId.toLowerCase()
		) {
			throw new WorkflowJournalError(
				`pending workflow filename does not match its contents: ${name}`
			);
		}
		return record;
	};

	const sameIdentity = (left: Record, right: Record): boolean =>
		left.version === right.version &&
		left.kind === right.kind &&
		left.attemptId === right.attemptId &&
		left.steamId64 === right.steamId64 &&
		left.accountName === right.accountName &&
		left.at === right.at &&
		(left.kind !== 'transfer' ||
			right.kind !== 'transfer' ||
			left.priorAuthenticatorFingerprint === right.priorAuthenticatorFingerprint);

	/**
	 * The recovery-file publication flag is metadata layered onto an otherwise
	 * complete retained workflow. A crash may leave that exact same-state update
	 * staged beside the conservative final record. Compare parsed fields rather
	 * than source property order, but ignore only this one field.
	 */
	const recoveryPublicationTransition = (
		current: Record,
		next: Record
	): 'forward' | 'stale' | undefined => {
		if (current.kind !== next.kind || current.state !== next.state) return undefined;
		const { recoveryPublished: currentPublished, ...currentWithoutPublication } = current;
		const { recoveryPublished: nextPublished, ...nextWithoutPublication } = next;
		if (!isDeepStrictEqual(currentWithoutPublication, nextWithoutPublication)) return undefined;
		if ((currentPublished === undefined || currentPublished === false) && nextPublished === true) {
			return 'forward';
		}
		if (currentPublished === true && (nextPublished === undefined || nextPublished === false)) {
			return 'stale';
		}
		return undefined;
	};

	/**
	 * Explicit state edges a fully written staged update may advance across.
	 * Recovery must be conservative, but "conservative" cannot mean rejecting a
	 * transition the services themselves intentionally perform. Keeping the graph
	 * here avoids the opposite mistake of accepting every terminal-to-terminal
	 * rewrite merely because its identity fields match.
	 */
	const isForwardTransition = (current: Record, next: Record): boolean => {
		if (current.kind !== next.kind || current.state === next.state) return false;
		if (current.state === 'sending') return next.state !== 'sending';
		if (next.state === 'sending') return false;
		if (current.kind === 'transfer' && next.kind === 'transfer') {
			return (
				(current.state === 'unanswered' && next.state === 'unreadable') ||
				(current.state === 'unanswered' && next.state === 'not-replaced') ||
				(current.state === 'replacement' && next.state === 'unreadable')
			);
		}
		if (current.kind === 'enrollment-add' && next.kind === 'enrollment-add') {
			return (
				(current.state === 'recoverable' && next.state === 'attached') ||
				(current.state === 'recoverable' && next.state === 'unreadable')
			);
		}
		return false;
	};

	/**
	 * A staged update is already complete and fsynced; only its final rename is
	 * missing. Recover it only beside the exact sending record it advances.
	 * Anything else is preserved and surfaced for repair instead of guessed at.
	 */
	const reconcileStaged = (initialNames: string[]): void => {
		const finals = new Map(
			initialNames
				.filter((name) => FILE.test(name))
				.map((name) => [name.toLowerCase(), name] as const)
		);
		const groups = new Map<
			string,
			Array<{
				name: string;
				path: string;
				record: Record;
				mtimeMs: number;
				finalName: string;
			}>
		>();

		for (const name of initialNames.filter((entry) => entry.endsWith('.tmp'))) {
			const match = STAGED_FILE.exec(name);
			if (match === null) {
				throw new WorkflowJournalError(`cannot understand staged workflow record ${name}`);
			}
			const path = join(directory, name);
			const fileKind = (match[3] as string).toLowerCase() as 'enrollment' | 'transfer';
			const record = readRecord(name, path, match[2] as string, fileKind, match[4] as string);
			const finalName = match[1] as string;
			const group = groups.get(finalName.toLowerCase()) ?? [];
			group.push({ name, path, record, mtimeMs: statSync(path).mtimeMs, finalName });
			groups.set(finalName.toLowerCase(), group);
		}

		for (const [finalKey, stagedRecords] of groups) {
			const existingName = finals.get(finalKey);
			if (existingName === undefined) {
				if (stagedRecords.every(({ record }) => record.state === 'sending')) {
					for (const stagedRecord of stagedRecords) rmSync(stagedRecord.path, { force: true });
					flushDirectory(directory);
					continue;
				}
				throw new WorkflowJournalError(
					`staged workflow recovery has no matching final record: ${stagedRecords[0]!.name}`
				);
			}

			const finalMatch = FILE.exec(existingName);
			if (finalMatch === null) throw new WorkflowJournalError('invalid workflow filename');
			const finalPath = join(directory, existingName);
			const finalKind = (finalMatch[2] as string).toLowerCase() as 'enrollment' | 'transfer';
			const current = readRecord(
				existingName,
				finalPath,
				finalMatch[1] as string,
				finalKind,
				finalMatch[3] as string
			);
			if (stagedRecords.some(({ record }) => !sameIdentity(current, record))) {
				throw new WorkflowJournalError(
					`staged workflow record does not match its final record: ${existingName}`
				);
			}

			const currentText = readFileSync(finalPath, 'utf8');
			const forward = stagedRecords.filter(({ record, path }) => {
				const stagedText = readFileSync(path, 'utf8');
				if (record.state === current.state) {
					if (stagedText === currentText) return false;
					const publication = recoveryPublicationTransition(current, record);
					if (publication === 'forward') return true;
					if (publication === 'stale') return false;
					throw new WorkflowJournalError(
						`conflicting staged workflow records need repair: ${existingName}`
					);
				}
				if (isForwardTransition(current, record)) return true;
				if (current.state !== 'sending' && record.state === 'sending') return false;
				throw new WorkflowJournalError(
					`ambiguous staged workflow transition needs repair: ${existingName}`
				);
			});

			const uniqueForward = new Map<string, (typeof forward)[number]>();
			for (const candidate of forward) {
				uniqueForward.set(readFileSync(candidate.path, 'utf8'), candidate);
			}
			if (uniqueForward.size > 1) {
				throw new WorkflowJournalError(
					`multiple conflicting staged workflow updates need repair: ${existingName}`
				);
			}
			const chosen = [...uniqueForward.values()].sort(
				(left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
			)[0];
			if (chosen !== undefined) {
				renameWithTransientRetry(replacementRename, chosen.path, finalPath);
				flushDirectory(directory);
			}
			for (const stagedRecord of stagedRecords) {
				if (stagedRecord.path !== chosen?.path) rmSync(stagedRecord.path, { force: true });
			}
			if (stagedRecords.some(({ path }) => path !== chosen?.path)) flushDirectory(directory);
		}
	};

	reconcilePendingStaged = (): void => {
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw err;
		}
		reconcileStaged(names);
	};

	const entries = (): Array<EnrollmentWorkflowRecord | TransferWorkflowRecord> => {
		if (publicationDebt !== undefined) throw publicationDebt;
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw err;
		}
		reconcileStaged(names);
		names = readdirSync(directory);
		return names.flatMap((name) => {
			const match = FILE.exec(name);
			if (match === null) {
				// This directory belongs only to this format. An unknown final file may be
				// from a newer version; ignoring it would be a fail-open downgrade.
				throw new WorkflowJournalError(`cannot understand pending workflow record ${name}`);
			}
			const path = join(directory, name);
			const fileSteamId = match[1] as string;
			const fileKind = (match[2] as string).toLowerCase() as 'enrollment' | 'transfer';
			const fileAttemptId = match[3] as string;
			const record = readRecord(name, path, fileSteamId, fileKind, fileAttemptId);
			return [record];
		});
	};

	return {
		beginEnrollment(input) {
			const record = enrollmentRecordSchema.parse({
				version: 1,
				kind: 'enrollment-add',
				attemptId: randomUUID(),
				...input,
				state: 'sending'
			});
			writeNew(pathFor(record.steamId64, 'enrollment', record.attemptId), record);
			return record;
		},
		updateEnrollment(record, update) {
			const updated = enrollmentRecordSchema.parse(
				typeof update === 'string'
					? {
							version: 1,
							kind: 'enrollment-add',
							attemptId: record.attemptId,
							steamId64: record.steamId64,
							accountName: record.accountName,
							at: record.at,
							state: update
						}
					: { ...record, ...update }
			);
			replace(pathFor(record.steamId64, 'enrollment', record.attemptId), updated);
			return updated;
		},
		markEnrollmentRecovery(record, published) {
			const updated = enrollmentRecordSchema.parse({ ...record, recoveryPublished: published });
			replace(pathFor(record.steamId64, 'enrollment', record.attemptId), updated);
			return updated;
		},
		clearEnrollment(record) {
			reconcilePendingStaged();
			rmSync(pathFor(record.steamId64, 'enrollment', record.attemptId), { force: true });
			flushDirectory(directory);
		},
		enrollments(onlySteamId) {
			return entries()
				.filter((entry): entry is EnrollmentWorkflowRecord => entry.kind === 'enrollment-add')
				.filter((entry) => onlySteamId === undefined || entry.steamId64 === onlySteamId)
				.sort(byNewest);
		},

		beginTransfer(input) {
			const record = transferRecordSchema.parse({
				version: 1,
				kind: 'transfer',
				attemptId: randomUUID(),
				...input,
				state: 'sending'
			});
			writeNew(pathFor(record.steamId64, 'transfer', record.attemptId), record);
			return record;
		},
		updateTransfer(record, update) {
			const updated = transferRecordSchema.parse({
				version: 1,
				kind: 'transfer',
				attemptId: record.attemptId,
				steamId64: record.steamId64,
				accountName: record.accountName,
				at: record.at,
				...(record.priorAuthenticatorFingerprint === undefined
					? {}
					: { priorAuthenticatorFingerprint: record.priorAuthenticatorFingerprint }),
				...(record.recoveryPublished === undefined
					? {}
					: { recoveryPublished: record.recoveryPublished }),
				...update
			});
			replace(pathFor(record.steamId64, 'transfer', record.attemptId), updated);
			return updated;
		},
		markTransferRecovery(record, published) {
			const updated = transferRecordSchema.parse({ ...record, recoveryPublished: published });
			replace(pathFor(record.steamId64, 'transfer', record.attemptId), updated);
			return updated;
		},
		clearTransfer(record) {
			reconcilePendingStaged();
			rmSync(pathFor(record.steamId64, 'transfer', record.attemptId), { force: true });
			flushDirectory(directory);
		},
		transfers(onlySteamId) {
			return entries()
				.filter((entry): entry is TransferWorkflowRecord => entry.kind === 'transfer')
				.filter((entry) => onlySteamId === undefined || entry.steamId64 === onlySteamId)
				.sort(byNewest);
		},
		vaultKeyCompatible(candidate, key) {
			return keyOpensEveryWorkflow(entries(), candidate, key);
		}
	};
}

export function noWorkflowJournal(): WorkflowJournal {
	const fail = (): never => {
		throw new WorkflowJournalError('durable Steam workflow storage is not configured');
	};
	return {
		beginEnrollment: fail,
		updateEnrollment: fail,
		markEnrollmentRecovery: fail,
		clearEnrollment: () => undefined,
		enrollments: () => [],
		beginTransfer: fail,
		updateTransfer: fail,
		markTransferRecovery: fail,
		clearTransfer: () => undefined,
		transfers: () => [],
		vaultKeyCompatible: () => true
	};
}

/** In-memory implementation for unit tests; share one instance to model restart. */
export function memoryWorkflowJournal(): WorkflowJournal {
	const enrollment = new Map<string, EnrollmentWorkflowRecord>();
	const transfer = new Map<string, TransferWorkflowRecord>();
	const key = (steamId64: string, id: string): string => `${steamId64}.${id}`;
	return {
		beginEnrollment(input) {
			const record = enrollmentRecordSchema.parse({
				version: 1,
				kind: 'enrollment-add',
				attemptId: randomUUID(),
				...input,
				state: 'sending'
			});
			enrollment.set(key(record.steamId64, record.attemptId), record);
			return record;
		},
		updateEnrollment(record, update) {
			const updated = enrollmentRecordSchema.parse(
				typeof update === 'string'
					? {
							version: 1,
							kind: 'enrollment-add',
							attemptId: record.attemptId,
							steamId64: record.steamId64,
							accountName: record.accountName,
							at: record.at,
							state: update
						}
					: { ...record, ...update }
			);
			enrollment.set(key(record.steamId64, record.attemptId), updated);
			return updated;
		},
		markEnrollmentRecovery(record, published) {
			const updated = enrollmentRecordSchema.parse({ ...record, recoveryPublished: published });
			enrollment.set(key(record.steamId64, record.attemptId), updated);
			return updated;
		},
		clearEnrollment(record) {
			enrollment.delete(key(record.steamId64, record.attemptId));
		},
		enrollments(steamId64) {
			return [...enrollment.values()]
				.filter((entry) => steamId64 === undefined || entry.steamId64 === steamId64)
				.sort(byNewest);
		},
		beginTransfer(input) {
			const record = transferRecordSchema.parse({
				version: 1,
				kind: 'transfer',
				attemptId: randomUUID(),
				...input,
				state: 'sending'
			});
			transfer.set(key(record.steamId64, record.attemptId), record);
			return record;
		},
		updateTransfer(record, update) {
			const updated = transferRecordSchema.parse({
				version: 1,
				kind: 'transfer',
				attemptId: record.attemptId,
				steamId64: record.steamId64,
				accountName: record.accountName,
				at: record.at,
				...update
			});
			transfer.set(key(record.steamId64, record.attemptId), updated);
			return updated;
		},
		markTransferRecovery(record, published) {
			const updated = transferRecordSchema.parse({ ...record, recoveryPublished: published });
			transfer.set(key(record.steamId64, record.attemptId), updated);
			return updated;
		},
		clearTransfer(record) {
			transfer.delete(key(record.steamId64, record.attemptId));
		},
		transfers(steamId64) {
			return [...transfer.values()]
				.filter((entry) => steamId64 === undefined || entry.steamId64 === steamId64)
				.sort(byNewest);
		},
		vaultKeyCompatible(candidate, key) {
			return keyOpensEveryWorkflow([...enrollment.values(), ...transfer.values()], candidate, key);
		}
	};
}
