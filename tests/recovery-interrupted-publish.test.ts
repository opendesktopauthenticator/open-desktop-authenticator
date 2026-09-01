import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	reconcileRecoveryFiles,
	recoveryDirectory,
	recoveryPathFor,
	RECOVERY_EXTENSION
} from '../src/main/vault/recovery';

/**
 * **The recovery file caught between claiming its name and filling it.**
 *
 * On a filesystem with no hard links, `durably` publishes by claiming the
 * destination with `wx` — the only atomic way to refuse to overwrite there — and
 * then renaming the completed staging file over it. That closed a race where a
 * second enrollment could overwrite a previous authenticator's backup, and it
 * opened a window of two adjacent syscalls: a hard stop between them leaves a
 * nought-byte file at exactly the name a restore reads, and the whole, fsynced
 * document beside it under a name nothing looks at.
 *
 * The bytes are not lost. They are unreachable, and for a file whose entire
 * purpose is to be found later that is close enough to the same thing — and the
 * window sits after Steam may have attached the authenticator and before the
 * vault has stored it, which is the one stretch this module exists for.
 *
 * These build that on-disk state directly rather than trying to kill a process
 * mid-write, because the state is the thing the fix has to handle and a test
 * that cannot produce it reliably proves nothing.
 */

const STEAM_ID = '76561199000000001';

let dir: string;

/** A sealed envelope, shaped the way `writeRecoveryFile` writes one. */
const envelope = JSON.stringify(
	{
		version: 1,
		kdf: { type: 'scrypt', N: 16384, r: 8, p: 1, salt: 'c2FsdHktc2FsdGE=' },
		cipher: {
			type: 'aes-256-gcm',
			nonce: 'bm9uY2UtdmFsdWUtaGVy',
			tag: 'dGFnLXZhbHVlLWdvZXNoZXJl'
		},
		ciphertext: 'a'.repeat(200),
		modifiedAt: '2026-01-01T00:00:00.000Z'
	},
	null,
	2
);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'oda-recovery-publish-'));
	mkdirSync(recoveryDirectory(dir), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** The exact shape a stop between the claim and the rename leaves behind. */
function interruptedPublish(body = envelope): { primary: string; staged: string } {
	const primary = recoveryPathFor(dir, STEAM_ID);
	const staged = `${primary}.4f0a1c22-0000-4000-8000-000000000000.tmp`;
	writeFileSync(primary, '');
	writeFileSync(staged, body);
	return { primary, staged };
}

describe('a recovery file whose publication was interrupted', () => {
	it('is completed on the next start', () => {
		const { primary } = interruptedPublish();

		expect(reconcileRecoveryFiles(dir)).toEqual([primary]);

		expect(
			readFileSync(primary, 'utf8'),
			'the complete document was sitting beside a nought-byte file at the name a restore ' +
				'reads, and nothing ever looked at it'
		).toBe(envelope);
	});

	it('leaves no staging file behind once it has', () => {
		const { staged } = interruptedPublish();
		reconcileRecoveryFiles(dir);

		expect(statSync(staged, { throwIfNoEntry: false })).toBeUndefined();
	});

	it('does nothing the second time', () => {
		interruptedPublish();
		reconcileRecoveryFiles(dir);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
	});

	/* And a directory with nothing wrong in it is untouched. */
	it('does nothing to an ordinary recovery file', () => {
		const primary = recoveryPathFor(dir, STEAM_ID);
		writeFileSync(primary, envelope);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
		expect(readFileSync(primary, 'utf8')).toBe(envelope);
	});

	it('does nothing when there is no recovery directory at all', () => {
		expect(reconcileRecoveryFiles(join(dir, 'nowhere'))).toEqual([]);
	});
});

/**
 * **Which way this is allowed to be wrong.**
 *
 * The file it would overwrite may be the only copy of a different enrollment's
 * secrets, so promoting a staging file has to be the narrow case and never the
 * general one. A destination that is merely damaged — unreadable, truncated,
 * anything with bytes in it — is left exactly where it is for a person to look
 * at, and a staging file that is not itself a whole sealed envelope is not a
 * recovery file and does not get to stand in for one.
 */
describe('what the reconciliation refuses to touch', () => {
	it('does not overwrite a destination that has anything in it', () => {
		const primary = recoveryPathFor(dir, STEAM_ID);
		const damaged = '{ "v": 1, "kdf": { "type": "scr';
		writeFileSync(primary, damaged);
		writeFileSync(`${primary}.4f0a1c22-0000-4000-8000-000000000000.tmp`, envelope);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
		expect(
			readFileSync(primary, 'utf8'),
			'a damaged recovery file was replaced by a staged one, and a damaged file is still ' +
				'evidence somebody may need'
		).toBe(damaged);
	});

	it('does not promote a staging file that is itself incomplete', () => {
		const { primary } = interruptedPublish('{ "v": 1, "kdf": { "type": "scr');

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
		expect(
			readFileSync(primary, 'utf8'),
			'a half-written staging file was published as though it were a recovery file'
		).toBe('');
	});

	it('does not promote a file that is not an envelope at all', () => {
		interruptedPublish(JSON.stringify({ hello: 'world' }));

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
	});

	/* And it only claims names inside its own scheme. */
	it('ignores staging files that are not recovery files', () => {
		writeFileSync(join(recoveryDirectory(dir), 'something-else.4f0a.tmp'), envelope);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
	});

	it('promotes onto the recovery name rather than some other one', () => {
		const { primary } = interruptedPublish();

		expect(reconcileRecoveryFiles(dir)).toEqual([primary]);
		expect(primary.endsWith(RECOVERY_EXTENSION)).toBe(true);
	});
});
