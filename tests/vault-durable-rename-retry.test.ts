import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../src/shared/vault-format';

const injected = vi.hoisted(() => ({ destination: '', failures: 0, attempts: 0 }));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		renameSync: (from: unknown, to: unknown) => {
			if (to === injected.destination) {
				injected.attempts += 1;
				if (injected.failures > 0) {
					injected.failures -= 1;
					throw Object.assign(new Error('EBUSY: transient Windows file lock'), { code: 'EBUSY' });
				}
			}
			return (actual.renameSync as (from: unknown, to: unknown) => void)(from, to);
		}
	};
});

import {
	readBackupEnvelope,
	readEnvelope,
	readRotationJournal,
	restoreEnvelopeInPlace,
	restoreRotationJournalSnapshot,
	snapshotRotationJournal,
	vaultPaths,
	writeBackupEnvelope,
	writeEnvelope,
	writeRotationJournal
} from '../src/main/vault/storage';

const envelope = (suffix: string): Envelope => ({
	version: 1,
	kdf: { type: 'scrypt', N: 16_384, r: 8, p: 1, salt: 'c2FsdA==' },
	cipher: { type: 'aes-256-gcm', nonce: `bm9uY2U${suffix}`, tag: 'dGFn' },
	ciphertext: 'Y2lwaGVydGV4dA==',
	modifiedAt: `2026-09-03T00:00:0${suffix}.000Z`
});

let root: string;
let file: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'vault-durable-rename-'));
	file = join(root, 'vault.json');
	injected.destination = '';
	injected.failures = 0;
	injected.attempts = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function failTwiceAt(destination: string): void {
	injected.destination = destination;
	injected.failures = 2;
	injected.attempts = 0;
}

function expectRetried(): void {
	expect(injected.attempts).toBe(3);
	expect(injected.failures).toBe(0);
}

describe('every durable vault-state rename tolerates one short-lived lock', () => {
	it('writes the rotation journal', () => {
		failTwiceAt(`${file}.rotating`);
		writeRotationJournal(file, envelope('1'));

		expectRetried();
		expect(readRotationJournal(file)).toMatchObject({ state: 'owed', backup: envelope('1') });
	});

	it('restores the exact earlier rotation journal', () => {
		writeRotationJournal(file, envelope('1'));
		const before = snapshotRotationJournal(file);
		writeRotationJournal(file, envelope('2'));
		failTwiceAt(`${file}.rotating`);

		restoreRotationJournalSnapshot(file, before);

		expectRetried();
		expect(snapshotRotationJournal(file)).toEqual(before);
	});

	it('rewrites the backup', () => {
		writeEnvelope(file, envelope('1'));
		writeEnvelope(file, envelope('2'));
		failTwiceAt(vaultPaths(file).backup);

		writeBackupEnvelope(file, envelope('3'));

		expectRetried();
		expect(readBackupEnvelope(file)).toEqual(envelope('3'));
	});

	it('puts an earlier envelope back in place', () => {
		writeEnvelope(file, envelope('1'));
		failTwiceAt(file);

		restoreEnvelopeInPlace(file, envelope('2'));

		expectRetried();
		expect(readEnvelope(file)).toEqual(envelope('2'));
		expect(readFileSync(file, 'utf8')).toContain('2026-09-03T00:00:02.000Z');
	});
});
