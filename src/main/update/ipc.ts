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
}

/** Don't re-ask GitHub more than this often, however often the UI mounts. */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function registerUpdateHandlers(deps: UpdateCheckDeps): void {
	const now = deps.now ?? ((): number => Date.now());

	let cached: { at: number; result: UpdateCheckResult } | undefined;

	registerHandler(CHANNELS.updateCheck, async () => {
		// Checked on every call rather than captured once: the user can switch it
		// off, and the next call must respect that without a restart.
		if (!deps.isEnabled()) {
			return { state: 'disabled' as const };
		}

		// The renderer re-renders often and screens mount more than once. Without
		// this, opening Settings a few times would hammer GitHub's rate limit and
		// earn a 403 that surfaces as "could not check".
		const previous = cached;
		if (previous && now() - previous.at < MIN_INTERVAL_MS) {
			return previous.result;
		}

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
		return result;
	});
}
