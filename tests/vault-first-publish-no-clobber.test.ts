import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../src/shared/vault-format';

const injected = vi.hoisted(() => ({
	armed: false,
	destination: '',
	linkUnsupported: false,
	renameFailures: 0
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	const intervene = (from: unknown, to: unknown): void => {
		if (
			injected.armed &&
			typeof from === 'string' &&
			typeof to === 'string' &&
			from.endsWith('.tmp') &&
			to === injected.destination
		) {
			injected.armed = false;
			writeFileSync(to, 'FOREIGN-CREATED-WHILE-STAGING');
		}
	};
	return {
		...actual,
		renameSync: (from: unknown, to: unknown) => {
			intervene(from, to);
			if (to === injected.destination && injected.renameFailures > 0) {
				injected.renameFailures -= 1;
				const error = new Error('EPERM: transient Windows file lock') as NodeJS.ErrnoException;
				error.code = 'EPERM';
				throw error;
			}
			return (actual.renameSync as (from: unknown, to: unknown) => void)(from, to);
		},
		linkSync: (from: unknown, to: unknown) => {
			if (injected.armed && injected.linkUnsupported && to === injected.destination) {
				const error = new Error('hard links unavailable') as NodeJS.ErrnoException;
				error.code = 'EPERM';
				throw error;
			}
			intervene(from, to);
			return (actual.linkSync as (from: unknown, to: unknown) => void)(from, to);
		},
		copyFileSync: (from: unknown, to: unknown, mode?: number) => {
			intervene(from, to);
			return (actual.copyFileSync as (from: unknown, to: unknown, mode?: number) => void)(
				from,
				to,
				mode
			);
		}
	};
});

import { VaultStorageError, writeEnvelope } from '../src/main/vault/storage';

const ENVELOPE: Envelope = {
	version: 1,
	kdf: { type: 'scrypt', N: 16_384, r: 8, p: 1, salt: 'c2FsdA==' },
	cipher: { type: 'aes-256-gcm', nonce: 'bm9uY2U=', tag: 'dGFn' },
	ciphertext: 'Y2lwaGVydGV4dA==',
	modifiedAt: '2026-09-03T00:00:00.000Z'
};

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'vault-first-publish-'));
	file = join(dir, 'vault.json');
	injected.destination = file;
	injected.armed = true;
	injected.linkUnsupported = false;
	injected.renameFailures = 0;
});

afterEach(() => {
	injected.armed = false;
	injected.linkUnsupported = false;
	injected.renameFailures = 0;
	rmSync(dir, { recursive: true, force: true });
});

describe('a first vault whose destination is claimed while its stage is being written', () => {
	it('refuses without replacing the file that won the destination', () => {
		expect(() => writeEnvelope(file, ENVELOPE)).toThrow(VaultStorageError);
		expect(readFileSync(file, 'utf8')).toBe('FOREIGN-CREATED-WHILE-STAGING');
	});

	it('keeps the same guarantee on a filesystem without hard links', () => {
		injected.linkUnsupported = true;

		expect(() => writeEnvelope(file, ENVELOPE)).toThrow(VaultStorageError);
		expect(readFileSync(file, 'utf8')).toBe('FOREIGN-CREATED-WHILE-STAGING');
	});
});

describe('a transient Windows lock during an existing-vault replacement', () => {
	it('retries the same atomic replacement and completes normally', () => {
		injected.armed = false;
		writeEnvelope(file, ENVELOPE);

		const replacement = { ...ENVELOPE, modifiedAt: '2026-09-03T00:00:01.000Z' };
		injected.renameFailures = 2;
		writeEnvelope(file, replacement);

		expect(injected.renameFailures).toBe(0);
		expect(JSON.parse(readFileSync(file, 'utf8')).modifiedAt).toBe(replacement.modifiedAt);
	});

	it('stops after a bounded retry and leaves the previous bytes in place', () => {
		injected.armed = false;
		writeEnvelope(file, ENVELOPE);
		const before = readFileSync(file, 'utf8');
		injected.renameFailures = 100;

		let thrown: unknown;
		try {
			writeEnvelope(file, { ...ENVELOPE, modifiedAt: '2026-09-03T00:00:02.000Z' });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(VaultStorageError);
		expect((thrown as VaultStorageError).unchanged).toBe(true);
		expect(readFileSync(file, 'utf8')).toBe(before);
		expect(injected.renameFailures, 'the retry was not bounded').toBeGreaterThan(0);
	});
});
