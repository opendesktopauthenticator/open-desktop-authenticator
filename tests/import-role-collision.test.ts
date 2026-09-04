import { describe, expect, it } from 'vitest';
import { ImportService } from '../src/main/import/service';

const vault = {
	isUnlocked: () => true,
	read: () => ({ accounts: [] })
};

function maFile(entries: unknown): string {
	return JSON.stringify({
		shared_secret: Buffer.alloc(20, 1).toString('base64'),
		identity_secret: Buffer.alloc(20, 2).toString('base64'),
		account_name: 'valid-account',
		steamid: '76561198000000001',
		entries
	});
}

describe('mutually exclusive import file roles', () => {
	it.each([
		['an empty manifest-looking extension', []],
		[
			'a populated manifest-looking extension',
			[
				{
					filename: 'other.maFile',
					encryption_iv: Buffer.alloc(16, 3).toString('base64'),
					encryption_salt: Buffer.alloc(8, 4).toString('base64')
				}
			]
		]
	])('keeps a valid maFile as an account when it carries %s', (_label, entries) => {
		const report = new ImportService(vault as never).stage([
			{ name: '76561198000000001.maFile', text: maFile(entries) }
		]);

		expect(report.candidates).toHaveLength(1);
		expect(report.candidates[0]).toMatchObject({
			accountName: 'valid-account',
			steamId64: '76561198000000001',
			importable: true
		});
		expect(report.rejected).toEqual([]);
		expect(report.locked).toEqual([]);
	});

	it('still uses a renamed genuine manifest to describe an encrypted account file', () => {
		const name = 'encrypted.maFile';
		const report = new ImportService(vault as never).stage([
			{ name, text: Buffer.alloc(32, 5).toString('base64') },
			{
				name: 'manifest (1).json',
				text: JSON.stringify({
					encrypted: true,
					entries: [
						{
							filename: name,
							encryption_iv: Buffer.alloc(16, 6).toString('base64'),
							encryption_salt: Buffer.alloc(8, 7).toString('base64')
						}
					]
				})
			}
		]);

		expect(report.candidates).toEqual([]);
		expect(report.rejected).toEqual([]);
		expect(report.locked).toEqual([{ sourceName: name, decryptable: true }]);
	});
});
