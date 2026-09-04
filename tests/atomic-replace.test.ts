import { describe, expect, it } from 'vitest';
import { renameWithTransientRetry } from '../src/main/atomic-replace';

function codedError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: injected replacement failure`), { code });
}

describe('bounded atomic replacement retry', () => {
	it.each(['EPERM', 'EACCES', 'EBUSY'])(
		'retries transient %s without changing primitive',
		(code) => {
			let calls = 0;
			const rename = (from: string, to: string): void => {
				calls += 1;
				expect([from, to]).toEqual(['stage', 'final']);
				if (calls === 1) throw codedError(code);
			};

			renameWithTransientRetry(rename, 'stage', 'final');
			expect(calls).toBe(2);
		}
	);

	it('propagates a non-transient failure immediately', () => {
		let calls = 0;
		expect(() =>
			renameWithTransientRetry(
				() => {
					calls += 1;
					throw codedError('EIO');
				},
				'stage',
				'final'
			)
		).toThrow(/EIO/);
		expect(calls).toBe(1);
	});

	it('stops after exactly eight attempts when a transient lock persists', () => {
		let calls = 0;
		expect(() =>
			renameWithTransientRetry(
				() => {
					calls += 1;
					throw codedError('EBUSY');
				},
				'stage',
				'final'
			)
		).toThrow(/EBUSY/);
		expect(calls).toBe(8);
	});
});
