import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	reconcileRecoveryFiles,
	recoveryDirectory,
	recoveryPathFor,
	RECOVERY_EXTENSION
} from '../src/main/vault/recovery';

/**
 * **A complete recovery document staged but not yet published.**
 *
 * Reconciliation may publish a complete, fsynced staging file only while its
 * final name is still absent. Any existing final path — even a zero-byte one —
 * may belong to another writer, so startup must preserve both files rather than
 * infer ownership and overwrite one of them.
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

/** The exact shape a stop before atomic publication leaves behind. */
function interruptedPublish(
	body = envelope,
	claimTarget = false
): { primary: string; staged: string } {
	const primary = recoveryPathFor(dir, STEAM_ID);
	const staged = `${primary}.4f0a1c22-0000-4000-8000-000000000000.tmp`;
	if (claimTarget) writeFileSync(primary, '');
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

	it('preserves every candidate when two valid stages name one absent destination', () => {
		const primary = recoveryPathFor(dir, STEAM_ID);
		const first = `${primary}.4f0a1c22-0000-4000-8000-000000000001.tmp`;
		const second = `${primary}.4f0a1c22-0000-4000-8000-000000000002.tmp`;
		const otherEnvelope = JSON.stringify(
			{ ...JSON.parse(envelope), ciphertext: 'b'.repeat(200) },
			null,
			2
		);
		// Write in the opposite order to the UUIDs: directory enumeration must not
		// choose whichever complete candidate happens to appear first.
		writeFileSync(second, otherEnvelope);
		writeFileSync(first, envelope);
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);

		expect(statSync(primary, { throwIfNoEntry: false })).toBeUndefined();
		expect(readFileSync(first, 'utf8')).toBe(envelope);
		expect(readFileSync(second, 'utf8')).toBe(otherEnvelope);
		expect(warned).toHaveBeenCalledOnce();
		warned.mockRestore();
	});

	it('removes a staged duplicate after recognizing the already-published bytes', () => {
		const { primary, staged } = interruptedPublish();
		writeFileSync(primary, envelope);

		expect(reconcileRecoveryFiles(dir)).toEqual([primary]);
		expect(readFileSync(primary, 'utf8')).toBe(envelope);
		expect(statSync(staged, { throwIfNoEntry: false })).toBeUndefined();
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
		const staged = `${primary}.4f0a1c22-0000-4000-8000-000000000000.tmp`;
		writeFileSync(staged, envelope);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
		expect(
			readFileSync(primary, 'utf8'),
			'a damaged recovery file was replaced by a staged one, and a damaged file is still ' +
				'evidence somebody may need'
		).toBe(damaged);
		expect(readFileSync(staged, 'utf8')).toBe(envelope);
	});

	it('preserves a valid target and a different valid stage byte-for-byte', () => {
		const { primary, staged } = interruptedPublish();
		const otherEnvelope = JSON.stringify(
			{ ...JSON.parse(envelope), ciphertext: 'c'.repeat(200) },
			null,
			2
		);
		writeFileSync(primary, otherEnvelope);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
		expect(readFileSync(primary, 'utf8')).toBe(otherEnvelope);
		expect(readFileSync(staged, 'utf8')).toBe(envelope);
	});

	it('does not promote a staging file that is itself incomplete', () => {
		const { primary, staged } = interruptedPublish('{ "v": 1, "kdf": { "type": "scr');

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
		expect(statSync(primary, { throwIfNoEntry: false })).toBeUndefined();
		expect(readFileSync(staged, 'utf8')).toBe('{ "v": 1, "kdf": { "type": "scr');
	});

	it('preserves an occupied empty destination and its staged candidate', () => {
		const { primary, staged } = interruptedPublish(envelope, true);

		expect(reconcileRecoveryFiles(dir)).toEqual([]);
		expect(readFileSync(primary, 'utf8')).toBe('');
		expect(readFileSync(staged, 'utf8')).toBe(envelope);
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
