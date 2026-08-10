import { app } from 'electron';
import { attribution, branding, hasUnresolvedBranding } from '../shared/branding';
import { CHANNELS } from '../shared/channels';
import { registerHandler } from './ipc/router';
import { SECURE_WEB_PREFERENCES } from './security';

/**
 * Non-secret application metadata for the About screen and window chrome.
 *
 * Its own module rather than a function inside `index.ts` so that every channel
 * in the contract is registered by something importable — which is what lets
 * `tests/ipc-registration.test.ts` prove that no declared channel was left
 * without a handler. `index.ts` calls `start()` on import and cannot be loaded
 * by a test.
 */
export function registerAppInfoHandler(): void {
	registerHandler(CHANNELS.appInfo, () => ({
		productName: branding.productName,
		version: app.getVersion(),
		company: branding.company,
		brandingUnresolved: hasUnresolvedBranding(),
		platform: process.platform,
		attribution: {
			mckay: attribution.mckay,
			valve: attribution.valve
		},
		// Read back from the live values rather than restated, so the UI reports
		// what the process is actually doing.
		security: {
			sandbox: SECURE_WEB_PREFERENCES.sandbox,
			contextIsolation: SECURE_WEB_PREFERENCES.contextIsolation,
			nodeIntegration: SECURE_WEB_PREFERENCES.nodeIntegration
		}
	}));
}
