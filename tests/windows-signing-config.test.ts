import { describe, expect, it } from 'vitest';
import { DebugLogger } from 'builder-util';
import type { Configuration } from 'app-builder-lib';
import { validateConfiguration } from 'app-builder-lib/out/util/config/config';

describe('Windows resource editing without code signing', () => {
	it('keeps icon and version resources while explicitly disabling signing', async () => {
		const { default: config } = await import('../electron-builder.config.mjs');
		await expect(
			validateConfiguration(config as Configuration, new DebugLogger(false))
		).resolves.toBeUndefined();
		expect(
			config.win?.signAndEditExecutable,
			'false disables resedit too, stripping the executable icon and version metadata'
		).toBe(true);
		expect(
			config.win?.signExecutable,
			'without this explicit switch the apparently contradictory signAndEditExecutable name is ' +
				'easy to mistake for a signing configuration'
		).toBe(false);
	});
});
