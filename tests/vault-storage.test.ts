import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seal } from '../src/main/vault/crypto';
import {
	readBackupEnvelope,
	readEnvelope,
	vaultExists,
	vaultPaths,
	VaultStorageError,
	writeEnvelope
} from '../src/main/vault/storage';
import { MINIMUM_SCRYPT, type Envelope } from '../src/shared/vault-format';

/**
 * The vault file is routinely the only copy of an account's revocation code.
 * These tests are about never being the reason someone loses one.
 */

const FAST = { N: MINIMUM_SCRYPT.N, r: MINIMUM_SCRYPT.r, p: MINIMUM_SCRYPT.p };

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'vault-storage-'));
	file = join(dir, 'vault.json');
});

afterEach(() => {
	try {
		chmodSync(file, 0o666);
	} catch {
		/* may not exist */
	}
	rmSync(dir, { recursive: true, force: true });
});

async function envelope(text = '{"seq":1}'): Promise<Envelope> {
	return seal(text, 'a passphrase long enough', FAST);
}

describe('round trip', () => {
	it('writes and reads back an envelope', async () => {
		const env = await envelope();
		writeEnvelope(file, env);
		expect(vaultExists(file)).toBe(true);
		expect(readEnvelope(file)).toEqual(env);
	});

	it('creates the containing directory', async () => {
		const nested = join(dir, 'a', 'b', 'vault.json');
		writeEnvelope(nested, await envelope());
		expect(existsSync(nested)).toBe(true);
	});
});

describe('atomicity', () => {
	it('leaves no temp file behind', async () => {
		writeEnvelope(file, await envelope());
		expect(existsSync(vaultPaths(file).temp)).toBe(false);
	});

	it('keeps the previous version as a backup', async () => {
		const first = await envelope('{"seq":1}');
		const second = await envelope('{"seq":2}');

		writeEnvelope(file, first);
		expect(existsSync(vaultPaths(file).backup)).toBe(false); // nothing to back up yet

		writeEnvelope(file, second);
		expect(readEnvelope(file)).toEqual(second);
		expect(readBackupEnvelope(file)).toEqual(first);
	});

	/*
	 * Twenty-five writes, and the writes are the subject.
	 *
	 * This used to seal inside the loop, so most of the five-second budget went on
	 * twenty-five sequential scrypt derivations rather than on the thing being
	 * tested. It passed here and timed out on Windows CI, where the same work is
	 * several times slower — a flake that says nothing about atomicity.
	 *
	 * Sealing up front and in parallel puts the derivations on the threadpool and
	 * leaves the loop doing only what the test is named after. The explicit
	 * timeout is there because the cost is real work on a real KDF, not because
	 * the writes are slow.
	 */
	it('survives many sequential writes without drift', async () => {
		const envelopes = await Promise.all(
			Array.from({ length: 25 }, (_, i) => envelope(`{"seq":${i}}`))
		);
		for (const env of envelopes) {
			writeEnvelope(file, env);
		}
		expect(() => readEnvelope(file)).not.toThrow();
		expect(existsSync(vaultPaths(file).temp)).toBe(false);
	}, 30_000);
});

describe('failure leaves the previous vault intact', () => {
	it('restores the original when the write cannot complete', async () => {
		const good = await envelope('{"seq":1}');
		writeEnvelope(file, good);
		const before = readFileSync(file, 'utf8');

		// Read-only target: the rename cannot replace it.
		chmodSync(file, 0o444);
		let threw = false;
		try {
			writeEnvelope(file, await envelope('{"seq":2}'));
		} catch (err) {
			threw = true;
			expect(err).toBeInstanceOf(VaultStorageError);
		}
		chmodSync(file, 0o666);

		if (threw) {
			// Whatever happened, the file must still be a readable vault — either
			// the original or the restored backup.
			expect(() => readEnvelope(file)).not.toThrow();
		} else {
			// Some platforms allow the rename anyway; then the write must have
			// genuinely succeeded rather than half-applied.
			expect(() => readEnvelope(file)).not.toThrow();
		}
		expect(readFileSync(file, 'utf8').length).toBeGreaterThanOrEqual(before.length - 8);
	});

	it('never leaves a truncated file', async () => {
		writeEnvelope(file, await envelope());
		const content = readFileSync(file, 'utf8');
		expect(() => JSON.parse(content) as unknown).not.toThrow();
		expect(content.endsWith('\n')).toBe(true);
	});
});

describe('rejects files that are not ours', () => {
	it('rejects invalid JSON', () => {
		writeFileSync(file, '{not json');
		expect(() => readEnvelope(file)).toThrow(VaultStorageError);
	});

	it('rejects JSON that is not an envelope', () => {
		writeFileSync(file, JSON.stringify({ hello: 'world' }));
		expect(() => readEnvelope(file)).toThrow(/not a valid vault envelope/);
	});

	it('rejects an envelope missing its authentication tag', async () => {
		const env = await envelope();
		const broken = { ...env, cipher: { type: env.cipher.type, nonce: env.cipher.nonce } };
		writeFileSync(file, JSON.stringify(broken));
		expect(() => readEnvelope(file)).toThrow(VaultStorageError);
	});

	it('reports a missing file rather than throwing something opaque', () => {
		expect(() => readEnvelope(join(dir, 'absent.json'))).toThrow(/vault file could not be read/);
	});

	it('does not name the path in the message', () => {
		// The message reaches the renderer through unlock, passphrase change and the
		// passphrase verification behind account removal and the revocation reveal —
		// none of which sanitise it. A raw `ENOENT` quotes the absolute path, which
		// hands a sandboxed process the user's OS account name and their AppData
		// layout for nothing.
		const absent = join(dir, 'absent.json');
		try {
			readEnvelope(absent);
			expect.unreachable('should have thrown');
		} catch (err) {
			expect((err as Error).message).not.toContain(absent);
			expect((err as Error).message).not.toContain(dir);
			// Still attached for anything running locally, which is where a path is
			// actually of use.
			expect((err as VaultStorageError).cause).toBeDefined();
		}
	});
});

describe('backup recovery', () => {
	it('returns undefined when there is no backup', () => {
		expect(readBackupEnvelope(file)).toBeUndefined();
	});

	it('returns undefined when the backup is itself corrupt', async () => {
		writeEnvelope(file, await envelope());
		writeEnvelope(file, await envelope('{"seq":2}'));
		writeFileSync(vaultPaths(file).backup, 'garbage');
		expect(readBackupEnvelope(file)).toBeUndefined();
	});
});

/*
 * Who else on the machine can read the vault.
 *
 * `openSync(path, 'w')` creates a file `0o666`, which an ordinary `022` umask
 * turns into `0o644`. On a shared Linux box that means every other local user
 * could copy the vault and grind the passphrase offline at their leisure —
 * against the one file whose entire purpose is to be the thing they cannot get.
 *
 * `recovery.ts` has always written `0o600`, so the intended policy was never in
 * doubt; the larger file simply missed it.
 *
 * POSIX only. Windows has no mode bits — `chmodSync` there moves the read-only
 * flag and nothing else — and the real protection is the per-user ACL on
 * `%APPDATA%`, which is not this function's to assert.
 */
describe.skipIf(process.platform === 'win32')('the vault is owner-only on disk', () => {
	const modeOf = (path: string): number => statSync(path).mode & 0o777;

	it('creates a new vault readable only by its owner', async () => {
		writeEnvelope(file, await envelope());
		expect(modeOf(file)).toBe(0o600);
	});

	it('narrows a vault an earlier build left world-readable', async () => {
		// The mode on create only helps files made from here on. Existing installs
		// are the ones actually at risk, and they are only repaired if every write
		// narrows what it finds.
		writeEnvelope(file, await envelope());
		chmodSync(file, 0o644);

		writeEnvelope(file, await envelope('{"seq":2}'));

		expect(modeOf(file)).toBe(0o600);
	});

	it('narrows the backup too', async () => {
		// The backup is a byte-for-byte copy of the vault. Protecting one and
		// leaving the other beside it protects nothing.
		writeEnvelope(file, await envelope());
		writeEnvelope(file, await envelope('{"seq":2}'));

		expect(modeOf(vaultPaths(file).backup)).toBe(0o600);
	});
});

/*
 * The same guarantee, asserted where it can actually run.
 *
 * The behavioural tests above are POSIX-only, so on the platform most of this
 * project's users and its author are on, they are skipped — and a guarantee that
 * only ever runs on somebody else's machine is one that regresses quietly.
 * `infra-caching.test.ts` asserts against a config file for the same reason.
 */
describe('the owner-only policy is in the source, on every platform', () => {
	const SOURCE = readFileSync(join(__dirname, '..', 'src', 'main', 'vault', 'storage.ts'), 'utf8');

	/**
	 * One function's body, so a duplicate elsewhere cannot answer for it.
	 *
	 * **Every literal below occurs more than once in the file.**
	 * `openSync(paths.temp, 'w', 0o600)` is in `writeEnvelope` and again in
	 * `restoreEnvelopeInPlace`; `tighten(paths.backup);` is in three places. A
	 * whole-file `toContain` was therefore satisfied by any one of them — so
	 * dropping the mode from `writeEnvelope`, the write that publishes the live
	 * vault, left the guard green. That would leave the temp file at whatever the
	 * umask allows for the whole write and fsync of a vault, readable by any other
	 * local user, which is the exact window this describe block exists to close —
	 * and the behavioural tests above cannot see it, because they read the mode
	 * only after `tighten` has narrowed the published file, and are POSIX-only.
	 */
	const bodyOf = (name: string): string => {
		const start = SOURCE.indexOf(`export function ${name}(`);
		expect(start, `storage.ts no longer exports ${name}`).toBeGreaterThan(-1);
		const end = SOURCE.indexOf(
			`
export `,
			start + 1
		);
		return SOURCE.slice(start, end === -1 ? SOURCE.length : end);
	};

	it('opens the temp file with an explicit mode', () => {
		expect(
			bodyOf('writeEnvelope'),
			'the write that publishes the live vault creates its temp file at whatever the umask ' +
				'allows, and it stays that way for the whole write and fsync'
		).toContain("openSync(paths.temp, 'w', 0o600)");
	});

	it('narrows the vault and its backup after the rename', () => {
		const body = bodyOf('writeEnvelope');
		expect(body).toMatch(/tighten\(file\);/);
		expect(body).toMatch(/tighten\(paths\.backup\);/);
	});

	/*
	 * The restore path publishes the same bytes and needs the same care, so it is
	 * asserted separately rather than being allowed to stand in for the one above.
	 */
	it('applies the same mode on the restore path', () => {
		expect(bodyOf('restoreEnvelopeInPlace')).toContain("openSync(paths.temp, 'w', 0o600)");
	});
});
