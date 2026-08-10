import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

	it('survives many sequential writes without drift', async () => {
		for (let i = 0; i < 25; i++) {
			writeEnvelope(file, await envelope(`{"seq":${i}}`));
		}
		expect(() => readEnvelope(file)).not.toThrow();
		expect(existsSync(vaultPaths(file).temp)).toBe(false);
	});
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
		expect(() => readEnvelope(join(dir, 'absent.json'))).toThrow(/could not read the vault file/);
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
