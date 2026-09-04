import { describe, expect, it, vi } from 'vitest';
import { actOnConfirmationBatches } from '../src/shared/confirmation-batches';
import { CONFIRMATION_ACTION_BATCH_LIMIT, confirmationsActRequest } from '../src/shared/ipc';

describe('interactive confirmation batching', () => {
	it('sends every visible ordinary confirmation in sequential bounded batches', async () => {
		const ids = Array.from({ length: 230 }, (_, index) => String(index + 1));
		let inFlight = 0;
		let maximumInFlight = 0;
		const onAct = vi.fn(async (_action: 'allow' | 'cancel', batch: string[]) => {
			inFlight += 1;
			maximumInFlight = Math.max(maximumInFlight, inFlight);
			await Promise.resolve();
			inFlight -= 1;
			expect(batch.length).toBeLessThanOrEqual(CONFIRMATION_ACTION_BATCH_LIMIT);
		});

		await actOnConfirmationBatches(onAct, 'allow', ids);

		expect(onAct.mock.calls.map(([, batch]) => batch.length)).toEqual([100, 100, 30]);
		expect(onAct.mock.calls.flatMap(([, batch]) => batch)).toEqual(ids);
		expect(maximumInFlight).toBe(1);
	});

	it('separates completed, unknown, and never-attempted selections after a failed batch', async () => {
		const ids = Array.from({ length: 230 }, (_, index) => String(index + 1));
		const onAct = vi
			.fn<(action: 'allow' | 'cancel', batch: string[]) => Promise<unknown>>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('Steam refused the second batch'));

		await expect(actOnConfirmationBatches(onAct, 'cancel', ids)).rejects.toThrow(
			/100 confirmations were processed.*result for 100 confirmations.*could not be confirmed.*30 later confirmations were not attempted.*Steam refused/i
		);
		expect(onAct).toHaveBeenCalledTimes(2);
	});

	it('does not call a failed first batch unsent and still identifies later untouched work', async () => {
		const ids = Array.from({ length: 130 }, (_, index) => String(index + 1));
		const onAct = vi.fn().mockRejectedValue(new Error('response was lost'));

		await expect(actOnConfirmationBatches(onAct, 'allow', ids)).rejects.toThrow(
			/result for 100 confirmations.*could not be confirmed.*30 later confirmations were not attempted.*response was lost/i
		);
		expect(onAct).toHaveBeenCalledTimes(1);
	});

	it('keeps the IPC validator and renderer chunk size on the same limit', () => {
		const request = (count: number) => ({
			steamId64: '76561198000000001',
			action: 'allow',
			ids: Array.from({ length: count }, (_, index) => String(index + 1))
		});

		expect(
			confirmationsActRequest.safeParse(request(CONFIRMATION_ACTION_BATCH_LIMIT)).success
		).toBe(true);
		expect(
			confirmationsActRequest.safeParse(request(CONFIRMATION_ACTION_BATCH_LIMIT + 1)).success
		).toBe(false);
	});
});
