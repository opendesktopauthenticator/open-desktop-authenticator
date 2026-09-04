import { createHash, randomUUID } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isAuthenticatorFingerprint, isOperationId } from './authenticator-secrets';

export type OperationKind = 'activate' | 'deactivate';

export interface PendingOperationInput {
	steamId64: string;
	kind: OperationKind;
	fingerprint: string;
	at: string;
}

/** Immutable identity of one exact on-disk operation record. */
export interface OperationIdentity {
	source: 'legacy-v1' | 'v2';
	steamId64: string;
	kind: OperationKind;
	/** Zero belongs to the legacy fixed-name record. V2 generations start at one. */
	generation: string;
	recordId: string;
	/** SHA-256 of the exact pending-record bytes. */
	digest: string;
}

/** A pending operation together with the only handle that is allowed to clear it. */
export interface PendingOperation extends PendingOperationInput {
	identity: OperationIdentity;
	/** Steam is known to have accepted this exact request. */
	certain?: true;
}

export type OperationClearResult = 'cleared' | 'already-cleared';
export type OperationInspection = 'pending' | 'cleared' | 'changed';

/** What `enrollment-ipc` is handed, so a test can supply one without a disk. */
export interface OperationJournal {
	/**
	 * Fail closed: an irreversible request must not start without this record.
	 * This is durable storage, not an OS lease: the caller must hold the app's
	 * single-instance/account-operation reservation from before `record` until the
	 * Steam call and its exact `clear` have finished.
	 */
	record(operation: PendingOperationInput): PendingOperation;
	/** Durably attach a known-accepted outcome to this exact immutable record. */
	markCertain(expected: PendingOperation | OperationIdentity): PendingOperation;
	/** Append an exact tombstone. A key-only destructive clear does not exist. */
	clear(expected: PendingOperation | OperationIdentity): OperationClearResult;
	inspect(expected: PendingOperation | OperationIdentity): OperationInspection;
	/** Read one operation kind exactly; another kind must never mask it. */
	readKind(steamId64: string, kind: OperationKind): PendingOperation | undefined;
	/** Read every live, valid note for this account, newest first. */
	readAll(steamId64: string): PendingOperation[];
	/** Backwards-compatible convenience for diagnostics only. */
	read(steamId64: string): PendingOperation | undefined;
}

export class OperationJournalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OperationJournalError';
	}
}

export function journalDirectory(userDataPath: string): string {
	return join(userDataPath, 'pending-operations');
}

const V2_DIRECTORY = 'v2';
const LEGACY_NOTE = /^(\d{1,32})\.(activate|deactivate)\.json$/;
const GENERATION = '[0-9]{20}';
const V2_PENDING = new RegExp(
	`^(\\d{1,32})\\.(activate|deactivate)\\.(${GENERATION})\\.pending\\.json$`
);
const V2_CLEARED = new RegExp(
	`^(\\d{1,32})\\.(activate|deactivate)\\.(${GENERATION})\\.([0-9a-f]{64})\\.cleared\\.json$`
);
const V2_CERTAIN = new RegExp(
	`^(\\d{1,32})\\.(activate|deactivate)\\.(${GENERATION})\\.([0-9a-f]{64})\\.certain\\.json$`
);
const V2_LEGACY_ARCHIVE = /^(\d{1,32})\.(activate|deactivate)\.legacy\.([0-9a-f]{64})\.json$/;
const STAGED = /^(.*\.json)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;
const DIGEST = /^[0-9a-f]{64}$/;
const STEAM_ID = /^[0-9]{1,32}$/;
const ZERO_GENERATION = '00000000000000000000';
const MAX_GENERATION = 18_446_744_073_709_551_615n;
const MAX_NOTE_BYTES = 32 * 1024;
const DOWNGRADE_GUARD_AT = '1970-01-01T00:00:00.000Z';

interface V2PendingRecord extends PendingOperationInput {
	version: 2;
	state: 'pending';
	generation: string;
	recordId: string;
}

interface V2ClearRecord {
	version: 2;
	state: 'cleared';
	steamId64: string;
	kind: OperationKind;
	generation: string;
	recordId: string;
	digest: string;
}

interface V2CertainRecord {
	version: 2;
	state: 'certain';
	steamId64: string;
	kind: OperationKind;
	generation: string;
	recordId: string;
	digest: string;
}

interface DowngradeGuardRecord {
	version: 2;
	state: 'v2-downgrade-guard';
	steamId64: string;
	kind: OperationKind;
	fingerprint: string;
	at: string;
}

interface ParsedPending {
	operation: PendingOperation;
	path: string;
	body: string;
}

interface ParsedClear {
	value: V2ClearRecord;
	path: string;
	body: string;
}

interface ParsedCertain {
	value: V2CertainRecord;
	path: string;
	body: string;
}

interface JournalSnapshot {
	live: PendingOperation[];
	pending: ParsedPending[];
	cleared: Set<string>;
	certain: Set<string>;
	maximum: Map<string, bigint>;
}

interface FileOperations {
	linkFinal?: (existingPath: string, finalPath: string) => void;
	openFinal?: (path: string) => number;
	replaceFinal?: (stagedPath: string, finalPath: string) => void;
	remove?: (path: string) => void;
	syncDirectory?: (path: string) => void;
	syncFile?: (fd: number) => void;
}

function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join(',') === [...fields].sort().join(',')
	);
}

function digest(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

function keyFor(steamId64: string, kind: OperationKind): string {
	return `${steamId64}.${kind}`;
}

function identityOf(value: PendingOperation | OperationIdentity): OperationIdentity {
	return 'identity' in value ? value.identity : value;
}

function identityKey(value: OperationIdentity): string {
	return [
		value.source,
		value.steamId64,
		value.kind,
		value.generation,
		value.recordId,
		value.digest
	].join(':');
}

function assertSteamId(steamId64: string): void {
	if (!STEAM_ID.test(steamId64)) {
		throw new OperationJournalError('the Steam account identifier is invalid');
	}
}

function validTimestamp(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
	return Number.isFinite(Date.parse(value));
}

function syncDirectory(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		fsyncSync(fd);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
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

function writeAll(fd: number, body: string): void {
	const bytes = Buffer.from(body, 'utf8');
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written <= 0) throw new Error('the write stopped making progress');
		offset += written;
	}
}

function readRegular(path: string): string {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_NOTE_BYTES) {
		throw new Error('not a regular operation record');
	}
	return readFileSync(path, 'utf8');
}

function pendingName(steamId64: string, kind: OperationKind, generation: string): string {
	return `${steamId64}.${kind}.${generation}.pending.json`;
}

function clearedName(identity: OperationIdentity): string {
	return `${identity.steamId64}.${identity.kind}.${identity.generation}.${identity.digest}.cleared.json`;
}

function certainName(identity: OperationIdentity): string {
	return `${identity.steamId64}.${identity.kind}.${identity.generation}.${identity.digest}.certain.json`;
}

function formatGeneration(value: bigint): string {
	if (value < 0n || value > MAX_GENERATION) {
		throw new OperationJournalError('the Steam operation generation is exhausted');
	}
	return value.toString(10).padStart(20, '0');
}

function parseLegacy(name: string, path: string): ParsedPending {
	const match = LEGACY_NOTE.exec(name);
	if (match === null) throw new Error('not a legacy operation record');
	const steamId64 = match[1]!;
	const kind = match[2] as OperationKind;
	return parseLegacyContents(steamId64, kind, path);
}

function parseLegacyContents(steamId64: string, kind: OperationKind, path: string): ParsedPending {
	const body = readRegular(path);
	let decoded: unknown;
	try {
		decoded = JSON.parse(body) as unknown;
	} catch {
		throw new Error('invalid JSON');
	}
	if (!exactFields(decoded, ['steamId64', 'kind', 'fingerprint', 'at'])) {
		throw new Error('unexpected legacy fields');
	}
	if (
		decoded.steamId64 !== steamId64 ||
		decoded.kind !== kind ||
		!isAuthenticatorFingerprint(decoded.fingerprint) ||
		!validTimestamp(decoded.at)
	) {
		throw new Error('legacy filename and contents differ');
	}
	const recordDigest = digest(body);
	return {
		path,
		body,
		operation: {
			steamId64,
			kind,
			fingerprint: decoded.fingerprint,
			at: decoded.at,
			identity: {
				source: 'legacy-v1',
				steamId64,
				kind,
				generation: ZERO_GENERATION,
				recordId: `legacy:${recordDigest}`,
				digest: recordDigest
			}
		}
	};
}

function parseLegacyArchive(name: string, path: string): ParsedPending {
	const match = V2_LEGACY_ARCHIVE.exec(name);
	if (match === null) throw new Error('not an archived legacy operation record');
	const parsed = parseLegacyContents(match[1]!, match[2] as OperationKind, path);
	if (parsed.operation.identity.digest !== match[3]) {
		throw new Error('archived legacy filename and contents differ');
	}
	return parsed;
}

function parseDowngradeGuard(name: string, path: string): DowngradeGuardRecord {
	const match = LEGACY_NOTE.exec(name);
	if (match === null) throw new Error('not a downgrade guard');
	let decoded: unknown;
	try {
		decoded = JSON.parse(readRegular(path)) as unknown;
	} catch {
		throw new Error('invalid guard JSON');
	}
	if (!exactFields(decoded, ['version', 'state', 'steamId64', 'kind', 'fingerprint', 'at'])) {
		throw new Error('unexpected guard fields');
	}
	if (
		decoded.version !== 2 ||
		decoded.state !== 'v2-downgrade-guard' ||
		decoded.steamId64 !== match[1] ||
		decoded.kind !== match[2] ||
		!isAuthenticatorFingerprint(decoded.fingerprint) ||
		!validTimestamp(decoded.at)
	) {
		throw new Error('guard filename and contents differ');
	}
	return decoded as unknown as DowngradeGuardRecord;
}

function parseV2Pending(name: string, path: string): ParsedPending {
	const match = V2_PENDING.exec(name);
	if (match === null) throw new Error('not a v2 pending record');
	const body = readRegular(path);
	let decoded: unknown;
	try {
		decoded = JSON.parse(body) as unknown;
	} catch {
		throw new Error('invalid JSON');
	}
	if (
		!exactFields(decoded, [
			'version',
			'state',
			'steamId64',
			'kind',
			'generation',
			'recordId',
			'fingerprint',
			'at'
		])
	) {
		throw new Error('unexpected pending fields');
	}
	const steamId64 = match[1]!;
	const kind = match[2] as OperationKind;
	const generation = match[3]!;
	if (
		decoded.version !== 2 ||
		decoded.state !== 'pending' ||
		decoded.steamId64 !== steamId64 ||
		decoded.kind !== kind ||
		decoded.generation !== generation ||
		!isOperationId(decoded.recordId) ||
		!isAuthenticatorFingerprint(decoded.fingerprint) ||
		!validTimestamp(decoded.at) ||
		generation === ZERO_GENERATION ||
		BigInt(generation) > MAX_GENERATION
	) {
		throw new Error('pending filename and contents differ');
	}
	const recordDigest = digest(body);
	return {
		path,
		body,
		operation: {
			steamId64,
			kind,
			fingerprint: decoded.fingerprint,
			at: decoded.at,
			identity: {
				source: 'v2',
				steamId64,
				kind,
				generation,
				recordId: decoded.recordId,
				digest: recordDigest
			}
		}
	};
}

function parseClear(name: string, path: string): ParsedClear {
	const match = V2_CLEARED.exec(name);
	if (match === null) throw new Error('not a v2 clear record');
	const body = readRegular(path);
	let decoded: unknown;
	try {
		decoded = JSON.parse(body) as unknown;
	} catch {
		throw new Error('invalid JSON');
	}
	if (
		!exactFields(decoded, [
			'version',
			'state',
			'steamId64',
			'kind',
			'generation',
			'recordId',
			'digest'
		])
	) {
		throw new Error('unexpected clear fields');
	}
	const steamId64 = match[1]!;
	const kind = match[2] as OperationKind;
	const generation = match[3]!;
	const targetDigest = match[4]!;
	const legacy = generation === ZERO_GENERATION;
	if (
		decoded.version !== 2 ||
		decoded.state !== 'cleared' ||
		decoded.steamId64 !== steamId64 ||
		decoded.kind !== kind ||
		decoded.generation !== generation ||
		decoded.digest !== targetDigest ||
		typeof decoded.recordId !== 'string' ||
		!(legacy ? decoded.recordId === `legacy:${targetDigest}` : isOperationId(decoded.recordId)) ||
		!DIGEST.test(targetDigest)
	) {
		throw new Error('clear filename and contents differ');
	}
	return { value: decoded as unknown as V2ClearRecord, path, body };
}

function parseCertain(name: string, path: string): ParsedCertain {
	const match = V2_CERTAIN.exec(name);
	if (match === null) throw new Error('not a v2 certainty record');
	const body = readRegular(path);
	let decoded: unknown;
	try {
		decoded = JSON.parse(body) as unknown;
	} catch {
		throw new Error('invalid JSON');
	}
	if (
		!exactFields(decoded, [
			'version',
			'state',
			'steamId64',
			'kind',
			'generation',
			'recordId',
			'digest'
		])
	) {
		throw new Error('unexpected certainty fields');
	}
	const steamId64 = match[1]!;
	const kind = match[2] as OperationKind;
	const generation = match[3]!;
	const targetDigest = match[4]!;
	const legacy = generation === ZERO_GENERATION;
	if (
		decoded.version !== 2 ||
		decoded.state !== 'certain' ||
		decoded.steamId64 !== steamId64 ||
		decoded.kind !== kind ||
		decoded.generation !== generation ||
		decoded.digest !== targetDigest ||
		typeof decoded.recordId !== 'string' ||
		!(legacy ? decoded.recordId === `legacy:${targetDigest}` : isOperationId(decoded.recordId)) ||
		!DIGEST.test(targetDigest)
	) {
		throw new Error('certainty filename and contents differ');
	}
	return { value: decoded as unknown as V2CertainRecord, path, body };
}

function inputIsValid(operation: PendingOperationInput): boolean {
	return (
		STEAM_ID.test(operation.steamId64) &&
		(operation.kind === 'activate' || operation.kind === 'deactivate') &&
		isAuthenticatorFingerprint(operation.fingerprint) &&
		validTimestamp(operation.at)
	);
}

function handleIsValid(identity: OperationIdentity): boolean {
	return (
		(identity.source === 'legacy-v1' || identity.source === 'v2') &&
		STEAM_ID.test(identity.steamId64) &&
		(identity.kind === 'activate' || identity.kind === 'deactivate') &&
		new RegExp(`^${GENERATION}$`).test(identity.generation) &&
		DIGEST.test(identity.digest) &&
		(identity.source === 'legacy-v1'
			? identity.generation === ZERO_GENERATION && identity.recordId === `legacy:${identity.digest}`
			: identity.generation !== ZERO_GENERATION && isOperationId(identity.recordId))
	);
}

/** File-backed v2 journal. Pending records and tombstones are immutable. */
export function fileOperationJournal(
	userDataPath: string,
	fileOps: FileOperations = {}
): OperationJournal {
	const root = journalDirectory(userDataPath);
	const v2 = join(root, V2_DIRECTORY);
	const flushDirectory = fileOps.syncDirectory ?? syncDirectory;
	const flushFile = fileOps.syncFile ?? fsyncSync;
	const remove = fileOps.remove ?? ((path: string) => rmSync(path, { force: true }));
	const linkFinal = fileOps.linkFinal ?? linkSync;
	const replaceFinal = fileOps.replaceFinal ?? renameSync;

	const ensureDirectories = (): void => {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		flushDirectory(dirname(root));
		mkdirSync(v2, { recursive: true, mode: 0o700 });
		flushDirectory(root);
	};

	const cleanupStage = (stage: string): void => {
		try {
			remove(stage);
			flushDirectory(dirname(stage));
		} catch {
			// A verified immutable final is authoritative; exact cleanup debt is harmless.
		}
	};

	const stageBody = (finalPath: string, body: string): string => {
		const stage = `${finalPath}.${randomUUID()}.tmp`;
		let fd: number | undefined;
		let created = false;
		try {
			fd = openSync(stage, 'wx', 0o600);
			created = true;
			writeAll(fd, body);
			flushFile(fd);
			closeSync(fd);
			fd = undefined;
			flushDirectory(dirname(stage));
			return stage;
		} catch (err) {
			if (fd !== undefined)
				try {
					closeSync(fd);
				} catch {
					/* preserve the first error */
				}
			if (created)
				try {
					remove(stage);
					flushDirectory(dirname(stage));
				} catch {
					/* residue fails closed */
				}
			throw err;
		}
	};

	const existingExact = (finalPath: string, body: string): boolean => {
		try {
			return readRegular(finalPath) === body;
		} catch {
			return false;
		}
	};

	const publish = (finalPath: string, body: string): void => {
		const stage = stageBody(finalPath, body);
		const finalDirectory = dirname(finalPath);
		try {
			try {
				linkFinal(stage, finalPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'EEXIST') {
					if (!existingExact(finalPath, body)) {
						cleanupStage(stage);
						throw err;
					}
					flushDirectory(finalDirectory);
					cleanupStage(stage);
					return;
				}
				if (code !== 'ENOSYS' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw err;
				let fd: number | undefined;
				try {
					try {
						fd = fileOps.openFinal?.(finalPath) ?? openSync(finalPath, 'wx', 0o600);
						writeAll(fd, body);
						flushFile(fd);
						closeSync(fd);
						fd = undefined;
					} catch (fallbackError) {
						if (
							(fallbackError as NodeJS.ErrnoException).code === 'EEXIST' &&
							existingExact(finalPath, body)
						) {
							flushDirectory(finalDirectory);
							cleanupStage(stage);
							return;
						}
						if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') {
							cleanupStage(stage);
						}
						throw fallbackError;
					}
				} finally {
					if (fd !== undefined)
						try {
							closeSync(fd);
						} catch {
							/* preserve publication error */
						}
				}
			}
			flushDirectory(finalDirectory);
			if (!existingExact(finalPath, body)) throw new Error('operation record read-back mismatch');
			cleanupStage(stage);
		} catch (err) {
			if (!existsSync(finalPath)) cleanupStage(stage);
			throw err;
		}
	};

	const fixedRecord = (
		steamId64: string,
		kind: OperationKind
	):
		| { type: 'absent'; path: string }
		| { type: 'guard'; value: DowngradeGuardRecord; path: string; body: string }
		| { type: 'legacy'; value: ParsedPending; path: string; body: string } => {
		const name = `${steamId64}.${kind}.json`;
		const path = join(root, name);
		if (!existsSync(path)) return { type: 'absent', path };
		try {
			return {
				type: 'guard',
				value: parseDowngradeGuard(name, path),
				path,
				body: readRegular(path)
			};
		} catch {
			try {
				const value = parseLegacy(name, path);
				return { type: 'legacy', value, path, body: value.body };
			} catch {
				throw new OperationJournalError(`cannot understand saved Steam operation record ${name}`);
			}
		}
	};

	const replaceDowngradeGuard = (path: string, expectedBody: string, body: string): void => {
		const stage = stageBody(path, body);
		try {
			// Production holds the app-wide account-operation reservation here. The
			// exact check still catches accidental replacement inside this process and
			// prevents us from overwriting bytes we did not archive.
			if (!existingExact(path, expectedBody)) {
				throw new Error('the fixed operation record changed before guard publication');
			}
			replaceFinal(stage, path);
			flushDirectory(root);
			if (!existingExact(path, body)) throw new Error('downgrade guard read-back mismatch');
		} catch (err) {
			if (existsSync(stage)) cleanupStage(stage);
			throw err;
		}
	};

	const archiveClearedLegacy = (legacy: ParsedPending): void => {
		const identity = legacy.operation.identity;
		const archiveName = `${identity.steamId64}.${identity.kind}.legacy.${identity.digest}.json`;
		publish(join(v2, archiveName), legacy.body);
		const archived = parseLegacyArchive(archiveName, join(v2, archiveName));
		if (identityKey(archived.operation.identity) !== identityKey(identity)) {
			throw new Error('the archived legacy operation did not read back exactly');
		}
	};

	/**
	 * Released v1 reads only the two fixed filenames. Keep one strictly validated,
	 * v1-readable marker for the authenticator before a v2-only pending record may
	 * authorise Steam traffic. A real legacy file is never overwritten or removed.
	 */
	const ensureDowngradeGuard = (operation: PendingOperationInput, state: JournalSnapshot): void => {
		const activation = fixedRecord(operation.steamId64, 'activate');
		if (activation.type === 'legacy') {
			if (activation.value.operation.fingerprint === operation.fingerprint) return;
			if (!state.cleared.has(identityKey(activation.value.operation.identity))) {
				// Released v1 stops after the activation filename even when its
				// fingerprint is stale. A matching marker in the deactivation slot would
				// therefore be invisible, so refusing is the only non-destructive answer.
				throw new OperationJournalError(
					'the fixed activation record belongs to a different authenticator and cannot be overwritten'
				);
			}
			// Once the exact legacy operation is tombstoned, preserve its exact bytes
			// under an immutable v2 name before atomically giving the fixed v1-visible
			// slot to the replacement authenticator's guard.
			archiveClearedLegacy(activation.value);
		}

		// Activation is deliberately the marker slot even for deactivation: it is
		// the first path the released reader consults.
		const availableKind: OperationKind = 'activate';
		const guard: DowngradeGuardRecord = {
			version: 2,
			state: 'v2-downgrade-guard',
			steamId64: operation.steamId64,
			kind: availableKind,
			fingerprint: operation.fingerprint,
			at: DOWNGRADE_GUARD_AT
		};
		const name = `${operation.steamId64}.${availableKind}.json`;
		const path = join(root, name);
		const body = JSON.stringify(guard);
		if (activation.type === 'legacy') {
			replaceDowngradeGuard(path, activation.body, body);
			return;
		}
		if (activation.type === 'guard') {
			if (activation.value.fingerprint === operation.fingerprint) return;
			// This is our own strictly validated marker, not a legacy record. Refresh
			// it before publishing a generation for replacement secrets.
			replaceDowngradeGuard(path, activation.body, body);
			return;
		}
		try {
			publish(path, body);
		} catch (err) {
			// A concurrent v2 writer may have installed a marker in the same slot.
			// Accept it only when its strict identity protects this authenticator.
			const winner = fixedRecord(operation.steamId64, availableKind);
			if (winner.type !== 'guard' || winner.value.fingerprint !== operation.fingerprint) {
				throw err;
			}
		}
		const verified = fixedRecord(operation.steamId64, availableKind);
		if (verified.type !== 'guard' || verified.value.fingerprint !== operation.fingerprint) {
			throw new OperationJournalError('the downgrade safety guard did not read back faithfully');
		}
	};

	const validateStageFor = (
		finalName: string,
		stageName: string
	): { body: string; path: string } => {
		const path = join(v2, stageName);
		const body = readRegular(path);
		if (V2_PENDING.test(finalName)) parseV2Pending(finalName, path);
		else if (V2_CLEARED.test(finalName)) parseClear(finalName, path);
		else if (V2_CERTAIN.test(finalName)) parseCertain(finalName, path);
		else if (V2_LEGACY_ARCHIVE.test(finalName)) parseLegacyArchive(finalName, path);
		else throw new Error('stage does not name a recognised final');
		return { body, path };
	};

	const reconcileStages = (names: string[]): Set<string> => {
		const tolerated = new Set<string>();
		const groups = new Map<string, string[]>();
		for (const name of names) {
			if (!name.endsWith('.tmp')) continue;
			const match = STAGED.exec(name);
			if (match === null)
				throw new OperationJournalError(`cannot understand staged Steam operation record ${name}`);
			const group = groups.get(match[1]!) ?? [];
			group.push(name);
			groups.set(match[1]!, group);
		}
		for (const [finalName, stageNames] of groups) {
			let stages: Array<{ name: string; body: string; path: string }>;
			try {
				stages = stageNames.map((name) => ({ name, ...validateStageFor(finalName, name) }));
			} catch {
				throw new OperationJournalError(
					`cannot understand staged Steam operation record ${stageNames[0]}`
				);
			}
			const finalPath = join(v2, finalName);
			if (!existsSync(finalPath)) {
				if (new Set(stages.map(({ body }) => body)).size !== 1) {
					throw new OperationJournalError(
						`conflicting staged Steam operation records need repair: ${finalName}`
					);
				}
				try {
					try {
						linkFinal(stages[0]!.path, finalPath);
					} catch (err) {
						const code = (err as NodeJS.ErrnoException).code;
						if (code === 'EEXIST') throw err;
						if (code !== 'ENOSYS' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw err;
						let fd: number | undefined;
						try {
							fd = fileOps.openFinal?.(finalPath) ?? openSync(finalPath, 'wx', 0o600);
							writeAll(fd, stages[0]!.body);
							flushFile(fd);
							closeSync(fd);
							fd = undefined;
						} finally {
							if (fd !== undefined)
								try {
									closeSync(fd);
								} catch {
									// Preserve the recovery error.
								}
						}
					}
					flushDirectory(v2);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
						throw new OperationJournalError(
							`staged Steam operation record could not be recovered: ${finalName}`
						);
					}
				}
			}
			let finalBody: string;
			try {
				finalBody = readRegular(finalPath);
				if (V2_PENDING.test(finalName)) parseV2Pending(finalName, finalPath);
				else if (V2_CLEARED.test(finalName)) parseClear(finalName, finalPath);
				else if (V2_CERTAIN.test(finalName)) parseCertain(finalName, finalPath);
				else parseLegacyArchive(finalName, finalPath);
				// A final that is still accompanied by its already-durable stage may
				// have been exposed just before a failed directory flush. Establish the
				// final entry's durability before allowing readers to act on it.
				flushDirectory(v2);
			} catch {
				throw new OperationJournalError(
					`cannot understand saved Steam operation record ${finalName}`
				);
			}
			for (const stage of stages) {
				if (
					stage.body !== finalBody &&
					(V2_CLEARED.test(finalName) ||
						V2_CERTAIN.test(finalName) ||
						V2_LEGACY_ARCHIVE.test(finalName))
				) {
					throw new OperationJournalError(
						`conflicting staged Steam operation records need repair: ${finalName}`
					);
				}
				cleanupStage(stage.path);
				tolerated.add(stage.name);
			}
		}
		return tolerated;
	};

	const reconcileGuardStages = (names: string[]): Set<string> => {
		const tolerated = new Set<string>();
		const groups = new Map<string, string[]>();
		for (const name of names) {
			if (!name.endsWith('.tmp')) continue;
			const match = STAGED.exec(name);
			if (match === null || !LEGACY_NOTE.test(match[1]!)) {
				throw new OperationJournalError(`cannot understand staged Steam operation guard ${name}`);
			}
			const group = groups.get(match[1]!) ?? [];
			group.push(name);
			groups.set(match[1]!, group);
		}
		for (const [finalName, stageNames] of groups) {
			const stages = stageNames.map((name) => {
				const path = join(root, name);
				try {
					parseDowngradeGuard(finalName, path);
					return { name, path, body: readRegular(path) };
				} catch {
					throw new OperationJournalError(`cannot understand staged Steam operation guard ${name}`);
				}
			});
			if (
				!existsSync(join(root, finalName)) &&
				new Set(stages.map(({ body }) => body)).size !== 1
			) {
				throw new OperationJournalError(
					`conflicting staged Steam operation guards need repair: ${finalName}`
				);
			}
			const finalPath = join(root, finalName);
			if (!existsSync(finalPath)) {
				try {
					// Reuse the same exclusive, durable publication path so recovery also
					// works on filesystems that cannot create hard links.
					publish(finalPath, stages[0]!.body);
				} catch {
					throw new OperationJournalError(
						`staged Steam operation guard could not be recovered: ${finalName}`
					);
				}
			}
			try {
				try {
					parseDowngradeGuard(finalName, finalPath);
				} catch {
					parseLegacy(finalName, finalPath);
				}
				flushDirectory(root);
			} catch {
				throw new OperationJournalError(
					`cannot understand saved Steam operation guard ${finalName}`
				);
			}
			// Guard replacement happens before the operation it protects can be
			// published. A differing final therefore means the process stopped before
			// the atomic rename; retain that valid final and discard only the intent.
			for (const stage of stages) {
				cleanupStage(stage.path);
				tolerated.add(stage.name);
			}
		}
		return tolerated;
	};

	const snapshot = (): JournalSnapshot => {
		const pending: ParsedPending[] = [];
		const clears: ParsedClear[] = [];
		const certainties: ParsedCertain[] = [];
		let rootNames: string[];
		try {
			rootNames = readdirSync(root);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT')
				return {
					live: [],
					pending: [],
					cleared: new Set(),
					certain: new Set(),
					maximum: new Map()
				};
			throw new OperationJournalError('the saved Steam operation records cannot be read');
		}
		const toleratedGuardStages = reconcileGuardStages(rootNames);
		rootNames = readdirSync(root);
		for (const name of rootNames) {
			if (name.endsWith('.tmp') && toleratedGuardStages.has(name)) continue;
			if (name === V2_DIRECTORY) {
				const info = lstatSync(join(root, name));
				if (!info.isDirectory() || info.isSymbolicLink())
					throw new OperationJournalError('cannot understand the v2 Steam operation directory');
				continue;
			}
			if (!LEGACY_NOTE.test(name))
				throw new OperationJournalError(`cannot understand saved Steam operation record ${name}`);
			try {
				parseDowngradeGuard(name, join(root, name));
				// An atomic guard replacement consumes its staged pathname. Re-flushing
				// the containing directory before trusting any surviving guard lets a
				// later process establish durability after the replacing process observed
				// an ambiguous directory-flush failure.
				flushDirectory(root);
				continue;
			} catch {
				try {
					pending.push(parseLegacy(name, join(root, name)));
				} catch {
					throw new OperationJournalError(`cannot understand saved Steam operation record ${name}`);
				}
			}
		}
		if (rootNames.includes(V2_DIRECTORY)) {
			let names = readdirSync(v2);
			const tolerated = reconcileStages(names);
			names = readdirSync(v2);
			for (const name of names) {
				if (name.endsWith('.tmp')) {
					if (tolerated.has(name)) continue;
					const match = STAGED.exec(name);
					if (match === null)
						throw new OperationJournalError(
							`cannot understand staged Steam operation record ${name}`
						);
					validateStageFor(match[1]!, name);
					continue;
				}
				try {
					if (V2_PENDING.test(name)) pending.push(parseV2Pending(name, join(v2, name)));
					else if (V2_CLEARED.test(name)) clears.push(parseClear(name, join(v2, name)));
					else if (V2_CERTAIN.test(name)) certainties.push(parseCertain(name, join(v2, name)));
					else if (V2_LEGACY_ARCHIVE.test(name)) {
						pending.push(parseLegacyArchive(name, join(v2, name)));
					} else throw new Error('unknown v2 record');
				} catch {
					throw new OperationJournalError(`cannot understand saved Steam operation record ${name}`);
				}
			}
		}

		const cleared = new Set<string>();
		for (const entry of clears) {
			const target = pending.find(({ operation }) => {
				const identity = operation.identity;
				return (
					identity.steamId64 === entry.value.steamId64 &&
					identity.kind === entry.value.kind &&
					identity.generation === entry.value.generation &&
					identity.recordId === entry.value.recordId &&
					identity.digest === entry.value.digest
				);
			});
			if (target === undefined) {
				throw new OperationJournalError(
					`cleared Steam operation record has no exact pending record: ${entry.value.steamId64}.${entry.value.kind}`
				);
			}
			cleared.add(identityKey(target.operation.identity));
		}

		const certain = new Set<string>();
		for (const entry of certainties) {
			const target = pending.find(({ operation }) => {
				const identity = operation.identity;
				return (
					identity.steamId64 === entry.value.steamId64 &&
					identity.kind === entry.value.kind &&
					identity.generation === entry.value.generation &&
					identity.recordId === entry.value.recordId &&
					identity.digest === entry.value.digest
				);
			});
			if (target === undefined) {
				throw new OperationJournalError(
					`certain Steam operation record has no exact pending record: ${entry.value.steamId64}.${entry.value.kind}`
				);
			}
			certain.add(identityKey(target.operation.identity));
		}

		const maximum = new Map<string, bigint>();
		const live: PendingOperation[] = [];
		const byKey = new Map<string, ParsedPending[]>();
		for (const item of pending) {
			const key = keyFor(item.operation.steamId64, item.operation.kind);
			const group = byKey.get(key) ?? [];
			group.push(item);
			byKey.set(key, group);
			if (item.operation.identity.source === 'v2') {
				const generation = BigInt(item.operation.identity.generation);
				if (generation > (maximum.get(key) ?? 0n)) maximum.set(key, generation);
			}
		}
		for (const [key, group] of byKey) {
			const unresolved = group
				.filter(({ operation }) => !cleared.has(identityKey(operation.identity)))
				.sort((left, right) =>
					BigInt(right.operation.identity.generation) > BigInt(left.operation.identity.generation)
						? 1
						: -1
				);
			if (unresolved.length > 1)
				throw new OperationJournalError(
					`multiple live Steam operation records need repair: ${key}`
				);
			if (unresolved[0] !== undefined) {
				const generation = BigInt(unresolved[0].operation.identity.generation);
				if (generation !== (maximum.get(key) ?? 0n) && generation !== 0n) {
					throw new OperationJournalError(
						`an older Steam operation generation is still live: ${key}`
					);
				}
				const operation = unresolved[0].operation;
				live.push(
					certain.has(identityKey(operation.identity)) ? { ...operation, certain: true } : operation
				);
			}
		}
		return { live, pending, cleared, certain, maximum };
	};

	const inspectIn = (
		state: JournalSnapshot,
		expected: PendingOperation | OperationIdentity
	): OperationInspection => {
		const identity = identityOf(expected);
		if (!handleIsValid(identity)) return 'changed';
		if (
			!state.pending.some(
				({ operation }) => identityKey(operation.identity) === identityKey(identity)
			)
		)
			return 'changed';
		return state.cleared.has(identityKey(identity)) ? 'cleared' : 'pending';
	};

	return {
		record(operation) {
			if (!inputIsValid(operation))
				throw new OperationJournalError(
					'the safety record is invalid, so no Steam request was sent'
				);
			try {
				let state = snapshot();
				if (
					state.live.some(
						(entry) => entry.steamId64 === operation.steamId64 && entry.kind === operation.kind
					)
				)
					throw new Error('unresolved');
				ensureDirectories();
				state = snapshot();
				if (
					state.live.some(
						(entry) => entry.steamId64 === operation.steamId64 && entry.kind === operation.kind
					)
				)
					throw new Error('unresolved');
				ensureDowngradeGuard(operation, state);
				// The guard was published through a fixed path. Re-read everything before
				// selecting a generation so a concurrent pending record still wins.
				state = snapshot();
				if (
					state.live.some(
						(entry) => entry.steamId64 === operation.steamId64 && entry.kind === operation.kind
					)
				)
					throw new Error('unresolved');
				const key = keyFor(operation.steamId64, operation.kind);
				const generation = formatGeneration((state.maximum.get(key) ?? 0n) + 1n);
				const disk: V2PendingRecord = {
					version: 2,
					state: 'pending',
					steamId64: operation.steamId64,
					kind: operation.kind,
					generation,
					recordId: randomUUID(),
					fingerprint: operation.fingerprint,
					at: operation.at
				};
				const body = JSON.stringify(disk);
				const identity: OperationIdentity = {
					source: 'v2',
					steamId64: operation.steamId64,
					kind: operation.kind,
					generation,
					recordId: disk.recordId,
					digest: digest(body)
				};
				publish(join(v2, pendingName(operation.steamId64, operation.kind, generation)), body);
				const recorded: PendingOperation = { ...operation, identity };
				if (inspectIn(snapshot(), recorded) !== 'pending') throw new Error('read-back mismatch');
				return recorded;
			} catch {
				throw new OperationJournalError(
					'The safety record required before changing this authenticator could not be written and verified, so nothing was sent. Free disk space or repair the application data folder, then try again.'
				);
			}
		},
		markCertain(expected) {
			const identity = identityOf(expected);
			if (!handleIsValid(identity))
				throw new OperationJournalError('the exact Steam operation identity is invalid');
			try {
				let state = snapshot();
				if (inspectIn(state, identity) !== 'pending') throw new Error('record changed');
				const already = state.live.find(
					(entry) => identityKey(entry.identity) === identityKey(identity) && entry.certain === true
				);
				if (already !== undefined) return already;
				ensureDirectories();
				state = snapshot();
				if (inspectIn(state, identity) !== 'pending') throw new Error('record changed');
				const marker: V2CertainRecord = {
					version: 2,
					state: 'certain',
					steamId64: identity.steamId64,
					kind: identity.kind,
					generation: identity.generation,
					recordId: identity.recordId,
					digest: identity.digest
				};
				publish(join(v2, certainName(identity)), JSON.stringify(marker));
				const verified = snapshot().live.find(
					(entry) => identityKey(entry.identity) === identityKey(identity) && entry.certain === true
				);
				if (verified === undefined) throw new Error('certainty read-back mismatch');
				return verified;
			} catch {
				throw new OperationJournalError(
					'Steam accepted the request, but that known outcome could not be written and verified. The operation remains blocked; do not treat it as refused or send it again.'
				);
			}
		},
		clear(expected) {
			const identity = identityOf(expected);
			if (!handleIsValid(identity))
				throw new OperationJournalError('the exact Steam operation identity is invalid');
			try {
				let state = snapshot();
				const before = inspectIn(state, identity);
				if (before === 'changed') throw new Error('record changed');
				if (before === 'cleared') return 'already-cleared';
				ensureDirectories();
				state = snapshot();
				const current = inspectIn(state, identity);
				if (current === 'changed') throw new Error('record changed');
				if (current === 'cleared') return 'already-cleared';
				const tombstone: V2ClearRecord = {
					version: 2,
					state: 'cleared',
					steamId64: identity.steamId64,
					kind: identity.kind,
					generation: identity.generation,
					recordId: identity.recordId,
					digest: identity.digest
				};
				publish(join(v2, clearedName(identity)), JSON.stringify(tombstone));
				if (inspectIn(snapshot(), identity) !== 'cleared')
					throw new Error('clear read-back mismatch');
				return 'cleared';
			} catch {
				throw new OperationJournalError(
					'The finished Steam operation safety record could not be cleared durably. The account remains blocked so the operation cannot be repeated.'
				);
			}
		},
		inspect(expected) {
			return inspectIn(snapshot(), expected);
		},
		readKind(steamId64, kind) {
			assertSteamId(steamId64);
			return snapshot().live.find((entry) => entry.steamId64 === steamId64 && entry.kind === kind);
		},
		readAll(steamId64) {
			assertSteamId(steamId64);
			return snapshot()
				.live.filter((entry) => entry.steamId64 === steamId64)
				.sort((left, right) => right.at.localeCompare(left.at));
		},
		read(steamId64) {
			return this.readAll(steamId64)[0];
		}
	};
}

export function noOperationJournal(): OperationJournal {
	return {
		record: () => {
			throw new OperationJournalError(
				'Durable Steam operation storage is not configured, so nothing was sent.'
			);
		},
		markCertain: () => {
			throw new OperationJournalError(
				'Steam accepted the request, but durable Steam operation storage is not configured.'
			);
		},
		clear: () => 'already-cleared',
		inspect: () => 'changed',
		readKind: () => undefined,
		readAll: () => [],
		read: () => undefined
	};
}

/** In-memory implementation for unit tests; never use as production durability. */
export function memoryOperationJournal(): OperationJournal {
	const records = new Map<string, PendingOperation[]>();
	const cleared = new Set<string>();
	const certain = new Set<string>();
	return {
		record(operation) {
			if (!inputIsValid(operation))
				throw new OperationJournalError(
					'the safety record is invalid, so no Steam request was sent'
				);
			const key = keyFor(operation.steamId64, operation.kind);
			const all = records.get(key) ?? [];
			if (all.some((entry) => !cleared.has(identityKey(entry.identity))))
				throw new OperationJournalError('an unresolved operation record already exists');
			const generation = formatGeneration(BigInt(all.length + 1));
			const recordId = randomUUID();
			const body = JSON.stringify({
				version: 2,
				state: 'pending',
				...operation,
				generation,
				recordId
			});
			const recorded: PendingOperation = {
				...operation,
				identity: {
					source: 'v2',
					steamId64: operation.steamId64,
					kind: operation.kind,
					generation,
					recordId,
					digest: digest(body)
				}
			};
			all.push(recorded);
			records.set(key, all);
			return recorded;
		},
		markCertain(expected) {
			const identity = identityOf(expected);
			if (!handleIsValid(identity))
				throw new OperationJournalError('the exact Steam operation identity is invalid');
			const all = records.get(keyFor(identity.steamId64, identity.kind)) ?? [];
			const entry = all.find((item) => identityKey(item.identity) === identityKey(identity));
			const key = identityKey(identity);
			if (entry === undefined || cleared.has(key))
				throw new OperationJournalError('the exact Steam operation record changed');
			certain.add(key);
			entry.certain = true;
			return entry;
		},
		clear(expected) {
			const identity = identityOf(expected);
			const all = records.get(keyFor(identity.steamId64, identity.kind)) ?? [];
			if (!all.some((entry) => identityKey(entry.identity) === identityKey(identity)))
				throw new OperationJournalError('the exact Steam operation record changed');
			const key = identityKey(identity);
			if (cleared.has(key)) return 'already-cleared';
			cleared.add(key);
			return 'cleared';
		},
		inspect(expected) {
			const identity = identityOf(expected);
			const all = records.get(keyFor(identity.steamId64, identity.kind)) ?? [];
			if (!all.some((entry) => identityKey(entry.identity) === identityKey(identity)))
				return 'changed';
			return cleared.has(identityKey(identity)) ? 'cleared' : 'pending';
		},
		readKind(steamId64, kind) {
			const all = records.get(keyFor(steamId64, kind)) ?? [];
			for (let index = all.length - 1; index >= 0; index -= 1) {
				const entry = all[index]!;
				if (!cleared.has(identityKey(entry.identity))) return entry;
			}
			return undefined;
		},
		readAll(steamId64) {
			return [...records.values()]
				.flat()
				.filter(
					(entry) => entry.steamId64 === steamId64 && !cleared.has(identityKey(entry.identity))
				)
				.sort((left, right) => right.at.localeCompare(left.at));
		},
		read(steamId64) {
			return this.readAll(steamId64)[0];
		}
	};
}

/** Every live note currently on disk. Corruption is deliberately not hidden. */
export function readAllPendingOperations(userDataPath: string): PendingOperation[] {
	const root = journalDirectory(userDataPath);
	const journal = fileOperationJournal(userDataPath);
	journal.readAll('0');
	let names: string[];
	try {
		names = readdirSync(root);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
	const ids = new Set<string>();
	for (const name of names) {
		const legacy = LEGACY_NOTE.exec(name);
		if (legacy !== null) ids.add(legacy[1]!);
	}
	const v2 = join(root, V2_DIRECTORY);
	if (existsSync(v2)) {
		for (const name of readdirSync(v2)) {
			const match = V2_PENDING.exec(name);
			if (match !== null) ids.add(match[1]!);
		}
	}
	return [...ids].flatMap((id) => journal.readAll(id));
}
