import { app, Notification } from 'electron';
import { attribution, branding, hasUnresolvedBranding } from '../shared/branding';
import { CHANNELS } from '../shared/channels';
import { registerHandler } from './ipc/router';
import { installedFromStore } from './update/ipc';
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
		companyShort: branding.companyShort,
		companyWebsite: branding.companyWebsite,
		website: branding.website,
		repository: branding.repository,
		brandingUnresolved: hasUnresolvedBranding(),
		platform: process.platform,
		/*
		 * **Whether this machine can show a desktop notification at all.**
		 *
		 * Surfaced because the answer is invisible otherwise and decides whether a
		 * whole feature works: an account with notifications on and both auto types
		 * off is *only* reported by a toast — a successful notify-only poll writes
		 * no activity entry — so on a machine with no notification service, a
		 * security-critical confirmation produced nothing anywhere at all. The
		 * switch is still allowed; the screen beside it says what it will do.
		 */
		notificationsAvailable: Notification.isSupported(),
		installedFromStore: installedFromStore(),
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
