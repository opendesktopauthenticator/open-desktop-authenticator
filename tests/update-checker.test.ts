import { describe, expect, it } from 'vitest';
import {
	checkForUpdate,
	compareVersions,
	isNewer,
	releasesApiUrl,
	verifiedInstallAvailable
} from '../src/main/update/checker';
import { branding } from '../src/shared/branding';

/**
 * The updater (§11 S11).
 *
 * The property that matters most is the one that is easiest to erode later:
 * **this tells the user about a release and never fetches a binary.** An
 * authenticator that can replace its own executable is the mechanism the clone
 * sites use, so the tests below are as much about what the module cannot do as
 * what it does.
 */

const RELEASE_URL = `${branding.repository}/releases/tag/v0.2.0`;

function github(body: unknown): { fetchText: (url: string) => Promise<string>; asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		fetchText: (url: string) => {
			asked.push(url);
			return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body));
		}
	};
}

describe('deciding whether a release is newer', () => {
	it('compares each part numerically, not as text', () => {
		// The bug this prevents: "0.10.0" < "0.9.0" under string comparison, so the
		// tenth release would never be offered.
		expect(isNewer('v0.10.0', 'v0.9.0')).toBe(true);
		expect(isNewer('v1.0.0', 'v0.99.99')).toBe(true);
		expect(isNewer('v0.2.1', 'v0.2.0')).toBe(true);
	});

	it('is false for the same version and for older ones', () => {
		expect(isNewer('v1.2.3', 'v1.2.3')).toBe(false);
		expect(isNewer('v1.2.2', 'v1.2.3')).toBe(false);
		expect(isNewer('v0.9.0', 'v1.0.0')).toBe(false);
	});

	it('tolerates the tag being written with or without a leading v', () => {
		expect(isNewer('0.3.0', 'v0.2.0')).toBe(true);
		expect(isNewer('v0.3.0', '0.2.0')).toBe(true);
	});

	it('never offers a pre-release to someone on a stable build', () => {
		// Someone running a release should not be walked onto a beta by a version
		// comparison they did not ask for.
		expect(isNewer('v1.0.0-rc.1', 'v0.9.0')).toBe(false);
		expect(isNewer('v1.0.0-beta', 'v0.9.0')).toBe(false);
	});

	it('treats an unreadable version as no evidence rather than as newer', () => {
		expect(isNewer('latest', 'v0.1.0')).toBe(false);
		expect(isNewer('', 'v0.1.0')).toBe(false);
		expect(isNewer('v9.9.9', 'not-a-version')).toBe(false);
	});
});

describe('the API URL', () => {
	it('is derived from the repository the verification chain publishes', () => {
		expect(
			releasesApiUrl('https://github.com/opendesktopauthenticator/open-desktop-authenticator')
		).toBe(
			'https://api.github.com/repos/opendesktopauthenticator/open-desktop-authenticator/releases/latest'
		);
	});

	it('refuses anything that is not a GitHub repository URL', () => {
		for (const bad of [
			'https://evil.test/opendesktopauthenticator/oda',
			'https://github.com/only-an-org',
			'https://opendesktopauthenticator.com',
			'[PRODUCT_NAME]'
		]) {
			expect(() => releasesApiUrl(bad), bad).toThrow();
		}
	});
});

describe('checking for an update', () => {
	it('reports an available release with its human page', async () => {
		const gh = github({ tag_name: 'v0.2.0', html_url: RELEASE_URL, published_at: '2026-09-01' });

		const result = await checkForUpdate({ ...gh, currentVersion: '0.1.0' });

		expect(result).toEqual({
			state: 'updateAvailable',
			release: { version: 'v0.2.0', url: RELEASE_URL, publishedAt: '2026-09-01' }
		});
	});

	it('reports up to date when the published release is the running one', async () => {
		const gh = github({ tag_name: 'v0.1.0', html_url: RELEASE_URL });

		expect(await checkForUpdate({ ...gh, currentVersion: '0.1.0' })).toEqual({
			state: 'upToDate'
		});
	});

	it('refuses a release whose link points somewhere other than our repository', async () => {
		// The URL is shown to the user and can be opened. A response that carries
		// somebody else's link is not a release, however well-formed it looks.
		const gh = github({ tag_name: 'v9.0.0', html_url: 'https://evil.test/releases/tag/v9.0.0' });

		expect(await checkForUpdate({ ...gh, currentVersion: '0.1.0' })).toMatchObject({
			state: 'unknown'
		});
	});

	it('says unknown rather than up to date when GitHub cannot be reached', async () => {
		// The distinction matters: "we could not check" and "you are current" are
		// different facts, and conflating them hides a version with a known break.
		const result = await checkForUpdate({
			fetchText: () => Promise.reject(new Error('ENOTFOUND')),
			currentVersion: '0.1.0'
		});

		expect(result).toMatchObject({ state: 'unknown' });
		expect(result.state === 'unknown' && result.reason).toMatch(/GitHub/i);
	});

	it('says unknown for a response that is not a release', async () => {
		for (const body of ['<html>rate limited</html>', '{}', '[]', 'null']) {
			const result = await checkForUpdate({ ...github(body), currentVersion: '0.1.0' });
			expect(result, body).toMatchObject({ state: 'unknown' });
		}
	});

	it('never throws, whatever GitHub returns', async () => {
		// An update check is background work the user did not ask for. It must not
		// be able to take down the screen they are actually using.
		await expect(
			checkForUpdate({
				fetchText: () => Promise.reject(new Error('boom')),
				currentVersion: '0.1.0'
			})
		).resolves.toBeDefined();
	});
});

describe('what the updater must not do', () => {
	it('reports no verified install path, because there is no signing yet (Q2)', () => {
		// This is the flag that would let a future version install for the user.
		// It stays false until a code-signing certificate exists — without one
		// there is no signature to verify, and verifying a hash fetched from the
		// same place as the binary proves nothing.
		expect(verifiedInstallAvailable).toBe(false);
	});

	it('asks GitHub exactly one question and downloads nothing', async () => {
		const gh = github({ tag_name: 'v0.2.0', html_url: RELEASE_URL });

		await checkForUpdate({ ...gh, currentVersion: '0.1.0' });

		expect(gh.asked).toHaveLength(1);
		expect(gh.asked[0]).toBe(releasesApiUrl(branding.repository));
		// No asset, no archive, no installer.
		expect(gh.asked.join(' ')).not.toMatch(/\.exe|\.zip|\.AppImage|\.msi|releases\/download/);
	});
});

/**
 * Regression: an unreadable version was reported as `upToDate`.
 *
 * `isNewer` returns false both for "older" and for "cannot tell", and the caller
 * mapped false to up-to-date. So a pre-release tag on the repository, or a build
 * whose own version string was malformed, pinned every user behind a reassuring
 * tick — the one answer this must never guess at.
 */
describe('a version it cannot read', () => {
	it('reports unknown rather than up to date for a pre-release tag', async () => {
		const gh = github({ tag_name: 'v2.0.0-rc.1', html_url: RELEASE_URL });

		const result = await checkForUpdate({ ...gh, currentVersion: '0.1.0' });

		expect(result.state).toBe('unknown');
		expect(result.state).not.toBe('upToDate');
	});

	it('reports unknown when this build has no readable version', async () => {
		const gh = github({ tag_name: 'v0.1.0', html_url: RELEASE_URL });

		const result = await checkForUpdate({ ...gh, currentVersion: 'dev' });

		expect(result.state).toBe('unknown');
	});

	it('still reports up to date when both versions are readable and equal', () => {
		expect(compareVersions('v1.2.3', 'v1.2.3')).toBe('notNewer');
		expect(compareVersions('v1.2.2', 'v1.2.3')).toBe('notNewer');
		expect(compareVersions('v1.2.4', 'v1.2.3')).toBe('newer');
		expect(compareVersions('v1.2.4-rc.1', 'v1.2.3')).toBe('unknown');
	});
});
