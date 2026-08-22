import { CHANNELS } from '../../shared/channels';
import { registerHandler } from '../ipc/router';
import { checkForUpdate } from './checker';
import type { UpdateCheckResult } from '../../shared/ipc';

/**
 * The update-check handler (§11 S11).
 *
 * Two things are deliberately absent and should stay that way:
 *
 * - **No download.** The response carries a release *page*, so the only thing
 *   the renderer can do with it is open a browser. `isOpenableExternally`
 *   already allowlists github.com, which is what makes that safe.
 * - **No account routing.** This request has nothing to do with any Steam
 *   account, so sending it through an account's proxy would tell that proxy
 *   operator this application is running, and burn proxy bandwidth on
 *   non-account traffic. It goes out the machine's ordinary egress, which is
 *   also what makes it honest to describe in Settings as "contacts GitHub".
 */

export interface UpdateCheckDeps {
	/** Reads the current settings. Returns false to skip the check entirely. */
	isEnabled(): boolean;
	currentVersion: string;
	fetchText(url: string): Promise<string>;
	/** Coalesces repeat checks. Injected so tests do not depend on the wall clock. */
	now?: () => number;
	/**
	 * Whether this build was installed from the Microsoft Store.
	 *
	 * Injected rather than read from `process.windowsStore` inside the handler,
	 * so the Store path can be tested on any platform. Defaults to the real
	 * value, which Electron sets only for an appx package.
	 */
	isStoreBuild?: () => boolean;
}

/**
 * True when running as an installed Store package.
 *
 * Electron sets `process.windowsStore` for appx builds and leaves it undefined
 * everywhere else, so this is the only signal that distinguishes the two Windows
 * channels at runtime — the binary is otherwise identical.
 */
export function installedFromStore(): boolean {
	return (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true;
}

/** Don't re-ask GitHub more than this often, however often the UI mounts. */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function registerUpdateHandlers(deps: UpdateCheckDeps): void {
	const now = deps.now ?? ((): number => Date.now());

	let cached: { at: number; result: UpdateCheckResult } | undefined;
	/**
	 * The request currently on the wire, so simultaneous calls share it.
	 *
	 * The cache is only written when a request finishes, so two calls arriving
	 * before the first resolved both saw it empty and both asked GitHub — and
	 * React's Strict Mode double-runs effects in development, making the pair the
	 * ordinary case rather than a race.
	 */
	let inFlight: Promise<UpdateCheckResult> | undefined;

	const isStoreBuild = deps.isStoreBuild ?? installedFromStore;

	registerHandler(CHANNELS.updateCheck, async () => {
		// **Before the settings check and before any request.**
		//
		// Windows already fetches and verifies new packages for a Store install,
		// so asking GitHub would be a network call made for nothing — and worse
		// than nothing if it answered: telling this user a release exists invites
		// them to install a second, unmanaged copy beside the managed one, and two
		// installs of an authenticator means two vaults and an account visible in
		// only one of them.
		//
		// Ahead of `isEnabled()` because this is not a preference. There is no
		// setting to respect here and nothing for the user to turn back on.
		if (isStoreBuild()) {
			return { state: 'storeManaged' as const };
		}

		// Checked on every call rather than captured once: the user can switch it
		// off, and the next call must respect that without a restart.
		if (!deps.isEnabled()) {
			return { state: 'disabled' as const };
		}

		// The renderer re-renders often and screens mount more than once. Without
		// this, opening Settings a few times would hammer GitHub's rate limit and
		// earn a 403 that surfaces as "could not check".
		const previous = cached;
		// `Math.abs`, because the clock can move backwards. `now() - previous.at`
		// is negative for every reading after a rollback — a restored VM, a manual
		// correction, a large NTP step — and negative is always less than the
		// interval, so the cache never expired again for the life of the process.
		// A banner about a security release could wait out the rollback plus six
		// hours, or a restart. Treating a jump in either direction as "old enough
		// to ask again" costs one request.
		if (previous && Math.abs(now() - previous.at) < MIN_INTERVAL_MS) {
			return previous.result;
		}

		if (inFlight) {
			return inFlight;
		}

		inFlight = (async (): Promise<UpdateCheckResult> => {
			const outcome = await checkForUpdate({
				// Wrapped rather than passed by reference: `deps.fetchText` detached from
				// `deps` is a method with no `this`, which lint rightly objects to.
				fetchText: (url) => deps.fetchText(url),
				currentVersion: deps.currentVersion
			});

			const result: UpdateCheckResult =
				outcome.state === 'updateAvailable'
					? {
							state: 'updateAvailable' as const,
							version: outcome.release.version,
							url: outcome.release.url,
							...(outcome.release.publishedAt !== undefined
								? { publishedAt: outcome.release.publishedAt }
								: {})
						}
					: outcome.state === 'upToDate'
						? { state: 'upToDate' as const }
						: { state: 'unknown' as const, reason: outcome.reason };

			// A failure is cached too, deliberately. Retrying a broken network on every
			// mount is how a transient outage becomes a request storm.
			cached = { at: now(), result };

			// Consent, checked **again** with the answer in hand. The check at the top
			// ran before the network round trip, and switching the setting off during
			// it must win: returning `updateAvailable` here is what put the banner
			// back up after the user had just watched it come down.
			if (!deps.isEnabled()) {
				return { state: 'disabled' as const };
			}
			return result;
		})().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	});
}
