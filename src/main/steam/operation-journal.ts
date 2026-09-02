import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * **A note that an irreversible Steam call was about to go out.**
 *
 * The vault already records an operation whose outcome nobody knows — see
 * `latch` in `enrollment-ipc.ts` — and it is written *after* Steam answers.
 * Everything that can go wrong between the send and the answer therefore leaves
 * no trace at all: the vault locking on the idle timer while the user is
 * waiting, a crash, a power cut, the machine being shut down. Those are not
 * exotic; the pause where somebody goes to find an emailed code is exactly when
 * an idle timer fires.
 *
 * The consequence is the one this application exists to prevent. Steam may have
 * detached the authenticator; the vault still holds the secrets and the account
 * looks ordinary; and the same button offers the same irreversible call again.
 *
 * So the intent is written down **before** the request goes, and it is written
 * here rather than in the vault, because the vault is precisely what is
 * unavailable in most of these failures — it is sealed, or the write to it is
 * the thing that failed.
 *
 * ## Two rules, both learned expensively
 *
 * **It never blocks an operation.** A post-send transport failure is reported as
 * uncertain far more often than Steam actually acted, so entries appear after an
 * ordinary network blip. An entry that refused the next attempt would make the
 * feature unusable after one dropped connection. This is read as a fallback by
 * `recordFor`, which produces guidance and a resolution — never a refusal.
 *
 * **Every entry can be cleared.** A clean outcome removes it immediately, and
 * the resolution the user already has removes it too. An earlier attempt at
 * durable refusal shipped a record that could be created and not cleared, which
 * left accounts unusable with nothing in the application able to help.
 *
 * ## Nothing secret is in here
 *
 * A SteamID, an operation name, a digest of the shared secret that is already
 * how the vault identifies which authenticator a record is about, and a
 * timestamp. It sits beside the recovery files, which is the same trust
 * boundary — no worse, and deliberately not more.
 */
export interface PendingOperation {
	steamId64: string;
	kind: 'activate' | 'deactivate';
	/**
	 * Which authenticator this was about, sampled before the call.
	 *
	 * Same digest and same reason as the vault record: an account whose
	 * authenticator was replaced while Steam was failing to answer must not have
	 * a stale note applied to its replacement.
	 */
	fingerprint: string;
	at: string;
}

/** What `enrollment-ipc` is handed, so a test can supply one without a disk. */
export interface OperationJournal {
	/** Best effort. A failure here must never stop the operation. */
	record(operation: PendingOperation): void;
	clear(steamId64: string, kind: PendingOperation['kind']): void;
	read(steamId64: string): PendingOperation | undefined;
}

export function journalDirectory(userDataPath: string): string {
	return join(userDataPath, 'pending-operations');
}

/** Digits only, so a malformed id can never reach outside the directory. */
function nameFor(steamId64: string, kind: PendingOperation['kind']): string | undefined {
	return /^[0-9]{1,32}$/.test(steamId64) ? `${steamId64}.${kind}.json` : undefined;
}

/**
 * Write the whole file, flush it, then move it into place.
 *
 * `rename` rather than the `link` that `recovery.ts` uses: a recovery file must
 * never overwrite its predecessor, but a note about the operation happening
 * right now is exactly the thing that should replace an older note about the
 * same account and the same kind.
 */
function durablyReplace(path: string, body: string): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temp, 'wx', 0o600);
	try {
		const bytes = Buffer.from(body, 'utf8');
		let written = 0;
		while (written < bytes.length) {
			const wrote = writeSync(fd, bytes, written, bytes.length - written);
			if (wrote <= 0) {
				throw new Error('the write stopped making progress before the file was complete');
			}
			written += wrote;
		}
		// Without this the rename can land while the contents are still only in the
		// page cache, which on a power cut is a file of zero bytes at the name the
		// next start reads.
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);

	// The rename itself needs flushing, for the same reason the contents did.
	try {
		const dir = openSync(join(path, '..'), 'r');
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	} catch {
		// Windows refuses to open a directory for reading, and the rename is already
		// ordered there. Not a reason to fail the write.
	}
}

/** The real, file-backed journal. */
export function fileOperationJournal(userDataPath: string): OperationJournal {
	const dir = journalDirectory(userDataPath);

	return {
		record(operation) {
			const name = nameFor(operation.steamId64, operation.kind);
			if (name === undefined) {
				return;
			}
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				durablyReplace(join(dir, name), JSON.stringify(operation));
			} catch (err) {
				// **Logged, never thrown.** This runs immediately before an irreversible
				// Steam call, and refusing to make that call because a note could not be
				// written would turn a full disk into an unusable feature. Losing the
				// note costs the durability this file adds and nothing that existed
				// before it.
				console.error('a pending Steam operation could not be written down', err);
			}
		},

		clear(steamId64, kind) {
			const name = nameFor(steamId64, kind);
			if (name === undefined) {
				return;
			}
			try {
				rmSync(join(dir, name), { force: true });
			} catch (err) {
				console.error('a finished Steam operation could not be cleared', err);
			}
		},

		read(steamId64) {
			for (const kind of ['activate', 'deactivate'] as const) {
				const name = nameFor(steamId64, kind);
				if (name === undefined) {
					continue;
				}
				try {
					const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
					const entry = parsed as Partial<PendingOperation>;
					if (
						entry.steamId64 === steamId64 &&
						entry.kind === kind &&
						typeof entry.fingerprint === 'string' &&
						typeof entry.at === 'string'
					) {
						return { steamId64, kind, fingerprint: entry.fingerprint, at: entry.at };
					}
				} catch {
					// Absent is the ordinary case, and a note we cannot read is one we
					// cannot act on. Neither is worth an exception on a read path that
					// runs before every activation.
				}
			}
			return undefined;
		}
	};
}

/**
 * A journal that remembers nothing.
 *
 * The default, so the six existing call sites keep compiling — and the reason
 * `interrupted-operation-survives-restart.test.ts` asserts that `index.ts` supplies a real one. A
 * dependency that silently defaults to doing nothing is how `requireProxies`
 * shipped as a field the schema stored, the docblock described, and no code
 * read.
 */
export function noOperationJournal(): OperationJournal {
	return {
		record: () => undefined,
		clear: () => undefined,
		read: () => undefined
	};
}

/** Every note currently on disk. For diagnostics and for tests. */
export function readAllPendingOperations(userDataPath: string): PendingOperation[] {
	const dir = journalDirectory(userDataPath);
	const journal = fileOperationJournal(userDataPath);
	try {
		return readdirSync(dir)
			.map((name) => name.split('.')[0])
			.filter((id): id is string => id !== undefined)
			.map((id) => journal.read(id))
			.filter((entry): entry is PendingOperation => entry !== undefined);
	} catch {
		return [];
	}
}
