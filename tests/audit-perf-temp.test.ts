import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const account = (i: number): Account => ({
	steamId64: `7656119${String(1_000_000_000 + i)}`,
	accountName: `account_${i}`,
	sharedSecret: 'ASNFZ4mrze8BI0VniavN7wEjRWc=',
	identitySecret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=',
	refreshToken: 'x'.repeat(700),
	status: 'active',
	addedAt: '2026-08-08T00:00:00.000Z',
	autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
});

it('records current vault scaling costs', async () => {
	for (const n of [10, 50]) {
		const dir = mkdtempSync(join(tmpdir(), 'oda-audit-perf-'));
		try {
			const vault = new VaultService({ file: join(dir, 'vault.json') });
			await vault.create('a sufficiently long passphrase');
			await vault.mutate((draft) => {
				for (let i = 0; i < n; i += 1) draft.accounts.push(account(i));
			});
			await vault.mutate((draft) => {
				draft.settings.autoLockMinutes = 11;
			});
			const bytes = statSync(join(dir, 'vault.json')).size;
			let started = performance.now();
			for (let i = 0; i < 1_000; i += 1) vault.read();
			const readMs = (performance.now() - started) / 1_000;
			started = performance.now();
			for (let i = 0; i < 1_000; i += 1) vault.backupAvailable();
			const backupMs = (performance.now() - started) / 1_000;
			started = performance.now();
			for (let i = 0; i < 10; i += 1) {
				await vault.mutate((draft) => {
					draft.settings.autoLockMinutes = 12 + (i % 3);
				});
			}
			const mutateMs = (performance.now() - started) / 10;
			process.stdout.write(
				`AUDIT_PERF accounts=${n} vault=${bytes}B read=${readMs.toFixed(3)}ms backup=${backupMs.toFixed(3)}ms mutate=${mutateMs.toFixed(2)}ms\n`
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	expect(true).toBe(true);
});
