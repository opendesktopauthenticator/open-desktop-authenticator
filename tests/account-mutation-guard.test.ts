import { describe, expect, it } from 'vitest';
import { accountMutationBlockedByDurableState } from '../src/main/steam/account-mutation-guard';
import { authenticatorFingerprint } from '../src/main/steam/authenticator-secrets';
import { memoryOperationJournal } from '../src/main/steam/operation-journal';
import { memoryWorkflowJournal } from '../src/main/steam/workflow-journal';

const STEAM_ID = '76561198000000001';
const OTHER_ID = '76561198000000002';
const WRAPPED = {
	version: 1 as const,
	kdf: {
		type: 'scrypt' as const,
		N: 16384,
		r: 8,
		p: 1,
		salt: Buffer.alloc(32, 1).toString('base64')
	},
	cipher: {
		type: 'aes-256-gcm' as const,
		nonce: Buffer.alloc(12, 2).toString('base64'),
		tag: Buffer.alloc(16, 3).toString('base64')
	},
	ciphertext: Buffer.from('wrapped').toString('base64'),
	modifiedAt: '2026-09-02T00:00:00.000Z'
};

function vault(
	accounts: Array<{
		steamId64: string;
		sharedSecret: string;
		unresolvedOperation?: { fingerprint?: string | undefined } | undefined;
	}> = []
) {
	return { read: () => ({ accounts }) };
}

describe('the account mutation durable-state gate', () => {
	it('includes process-only cleanup debt and fails it closed', () => {
		expect(
			accountMutationBlockedByDurableState(
				vault(),
				memoryWorkflowJournal(),
				memoryOperationJournal(),
				STEAM_ID,
				(candidate) => candidate === STEAM_ID
			)
		).toBe(true);
		expect(
			accountMutationBlockedByDurableState(
				vault(),
				memoryWorkflowJournal(),
				memoryOperationJournal(),
				STEAM_ID,
				() => {
					throw new Error('process-only state unavailable');
				}
			)
		).toBe(true);
	});

	it('allows a free account and does not let another account block it', () => {
		const workflows = memoryWorkflowJournal();
		const operations = memoryOperationJournal();
		workflows.beginEnrollment({
			steamId64: OTHER_ID,
			accountName: 'other',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		operations.record({
			steamId64: OTHER_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint({ sharedSecret: 'other authenticator' }),
			at: '2026-09-02T00:00:00.000Z'
		});

		expect(accountMutationBlockedByDurableState(vault(), workflows, operations, STEAM_ID)).toBe(
			false
		);
	});

	it('blocks each durable owner of the same account', () => {
		const enrollment = memoryWorkflowJournal();
		enrollment.beginEnrollment({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		expect(
			accountMutationBlockedByDurableState(vault(), enrollment, memoryOperationJournal(), STEAM_ID)
		).toBe(true);

		const transfer = memoryWorkflowJournal();
		transfer.beginTransfer({
			steamId64: STEAM_ID,
			accountName: 'trader',
			at: '2026-09-02T00:00:00.000Z',
			wrappedKey: WRAPPED
		});
		expect(
			accountMutationBlockedByDurableState(vault(), transfer, memoryOperationJournal(), STEAM_ID)
		).toBe(true);

		const operations = memoryOperationJournal();
		const current = { steamId64: STEAM_ID, sharedSecret: 'this secret' };
		operations.record({
			steamId64: STEAM_ID,
			kind: 'deactivate',
			fingerprint: authenticatorFingerprint(current),
			at: '2026-09-02T00:00:00.000Z'
		});
		expect(
			accountMutationBlockedByDurableState(
				vault([current]),
				memoryWorkflowJournal(),
				operations,
				STEAM_ID
			)
		).toBe(true);

		expect(
			accountMutationBlockedByDurableState(
				vault([
					{
						steamId64: STEAM_ID,
						sharedSecret: 'current secret',
						unresolvedOperation: {
							fingerprint: authenticatorFingerprint({ sharedSecret: 'current secret' })
						}
					}
				]),
				memoryWorkflowJournal(),
				memoryOperationJournal(),
				STEAM_ID
			)
		).toBe(true);
		expect(
			accountMutationBlockedByDurableState(
				vault([
					{
						steamId64: STEAM_ID,
						sharedSecret: 'legacy secret',
						unresolvedOperation: {}
					}
				]),
				memoryWorkflowJournal(),
				memoryOperationJournal(),
				STEAM_ID
			)
		).toBe(true);
	});

	it.each([
		'',
		'a'.repeat(15),
		'a'.repeat(17),
		'ABCDEF0123456789',
		'gggggggggggggggg',
		'not-an-authenticator'
	])('fails a vault record with an unverifiable fingerprint closed (%j)', (fingerprint) => {
		expect(
			accountMutationBlockedByDurableState(
				vault([
					{
						steamId64: STEAM_ID,
						sharedSecret: 'current secret',
						unresolvedOperation: { fingerprint }
					}
				]),
				memoryWorkflowJournal(),
				memoryOperationJournal(),
				STEAM_ID
			)
		).toBe(true);
	});

	it('allows an orphan or stale operation note to regain or release a row', () => {
		const operations = memoryOperationJournal();
		operations.record({
			steamId64: STEAM_ID,
			kind: 'activate',
			fingerprint: authenticatorFingerprint({
				sharedSecret: 'authenticator that needs restoring'
			}),
			at: '2026-09-02T00:00:00.000Z'
		});

		expect(
			accountMutationBlockedByDurableState(vault(), memoryWorkflowJournal(), operations, STEAM_ID)
		).toBe(false);
		expect(
			accountMutationBlockedByDurableState(
				vault([{ steamId64: STEAM_ID, sharedSecret: 'replacement secret' }]),
				memoryWorkflowJournal(),
				operations,
				STEAM_ID
			)
		).toBe(false);
		expect(
			accountMutationBlockedByDurableState(
				vault([
					{
						steamId64: STEAM_ID,
						sharedSecret: 'replacement secret',
						unresolvedOperation: {
							fingerprint: authenticatorFingerprint({ sharedSecret: 'older secret' })
						}
					}
				]),
				memoryWorkflowJournal(),
				memoryOperationJournal(),
				STEAM_ID
			)
		).toBe(false);
	});

	it.each(['vault', 'enrollment journal', 'transfer journal', 'operation journal'] as const)(
		'fails closed when the %s cannot be read',
		(source) => {
			const stored =
				source === 'vault'
					? {
							read: () => {
								throw new Error('damaged vault view');
							}
						}
					: vault();
			const workflows = {
				enrollments: () => {
					if (source === 'enrollment journal') throw new Error('damaged enrollment record');
					return [];
				},
				transfers: () => {
					if (source === 'transfer journal') throw new Error('damaged transfer record');
					return [];
				}
			};
			const operations = {
				readAll: () => {
					if (source === 'operation journal') throw new Error('damaged operation record');
					return [];
				}
			};

			expect(accountMutationBlockedByDurableState(stored, workflows, operations, STEAM_ID)).toBe(
				true
			);
		}
	);
});
