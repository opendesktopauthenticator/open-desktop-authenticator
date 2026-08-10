import { branding } from '../../shared/branding';

/**
 * Telling the user a new version exists (§11 S11).
 *
 * ## This checks. It does not install.
 *
 * That is the whole design, and it is not timidity. §4's answer to the clone
 * problem is a chain a stranger can walk — website → company → repository →
 * public CI build → signed binary → published hash — and an application that
 * downloads and executes its own replacement **is the exact mechanism the clone
 * sites use**. A user who has been taught that this app can silently replace
 * itself has been taught to accept the thing we exist to warn them about.
 *
 * So the update path is: we tell you a version exists, and you go to GitHub
 * Releases and get it, where the signature and the published hash are. The
 * download button on our own site does the same thing (§16). The user walks the
 * last step of the chain themselves, every time, because that step is the
 * product.
 *
 * **Automatic installation is not merely unimplemented — it is blocked on Q2.**
 * Without a Windows code-signing certificate there is no signature to verify, so
 * an auto-installer could only verify a hash it fetched from the same place as
 * the binary, which proves nothing against an attacker who controls that place.
 * The moment signing exists, `verifiedInstallAvailable` below is the one thing
 * that has to change, and the founder has to decide it deliberately.
 *
 * ## This is the only network request the app makes that is not Steam
 *
 * README promises no telemetry, and this is not telemetry — nothing about the
 * user is sent, and GitHub is asked a question every anonymous visitor may ask.
 * But it is still a request that reveals an IP and the fact that this
 * application is running, so it is disclosed in settings and can be switched
 * off. Defaulting it off would be worse: an authenticator running a version with
 * a known break is a worse outcome than GitHub knowing somebody checked.
 */

/** Whether a build can verify what it downloads. False until Q2 is resolved. */
export const verifiedInstallAvailable = false;

export interface ReleaseInfo {
	/** Tag as published, e.g. `v0.2.0`. */
	version: string;
	/** The human page for the release — never a direct asset link. */
	url: string;
	publishedAt?: string;
}

export type UpdateCheck =
	| { state: 'upToDate' }
	| { state: 'updateAvailable'; release: ReleaseInfo }
	/** Asked and could not find out. Never presented as "you are up to date". */
	| { state: 'unknown'; reason: string };

/** What a check needs, injected so this module has no import of `electron`. */
export interface UpdateCheckDeps {
	/** Performs the GET and yields the body, or throws. */
	fetchText(url: string): Promise<string>;
	currentVersion: string;
}

/**
 * Parse `owner/repo` out of the configured repository URL.
 *
 * Derived rather than configured separately: two places naming the repository is
 * two places to disagree, and the one in `branding` is the one the verification
 * chain publishes.
 */
export function releasesApiUrl(repositoryUrl: string): string {
	const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/?$/.exec(
		repositoryUrl
	);
	if (!match) {
		throw new Error('the configured repository is not a GitHub repository URL');
	}
	return `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`;
}

/**
 * Compare two semver-ish versions.
 *
 * Deliberately small: tags we publish are `vMAJOR.MINOR.PATCH`. Anything with a
 * pre-release suffix is **not** offered as an update — someone running a stable
 * build should not be walked onto a beta by a version comparison.
 */
export function compareVersions(
	candidate: string,
	current: string
): 'newer' | 'notNewer' | 'unknown' {
	const parse = (value: string): number[] | undefined => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
	};

	const a = parse(candidate);
	const b = parse(current);
	// **A third answer, not `false`.** An unparseable version on either side is
	// not evidence that there is no update — it is evidence that we cannot tell.
	// Collapsing it into "not newer" made the caller report `upToDate`, which is
	// the one thing it must never say when it does not know: a pre-release tag on
	// the repository, or a build whose own version is malformed, would silently
	// pin every user to a reassuring tick.
	if (!a || !b) {
		return 'unknown';
	}

	for (let i = 0; i < 3; i += 1) {
		if ((a[i] as number) !== (b[i] as number)) {
			return (a[i] as number) > (b[i] as number) ? 'newer' : 'notNewer';
		}
	}
	return 'notNewer';
}

/** True only when `candidate` is a readable version strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
	return compareVersions(candidate, current) === 'newer';
}

const releaseShape = (value: unknown): ReleaseInfo | undefined => {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const tag = record.tag_name;
	const url = record.html_url;
	if (typeof tag !== 'string' || typeof url !== 'string') {
		return undefined;
	}
	// The URL is shown and can be opened, so it is checked to be a release page
	// on the repository we actually publish from — not merely a string GitHub
	// happened to send.
	if (!url.startsWith(`${branding.repository}/releases/`)) {
		return undefined;
	}
	const info: ReleaseInfo = { version: tag, url };
	if (typeof record.published_at === 'string') {
		info.publishedAt = record.published_at;
	}
	return info;
};

/**
 * Ask GitHub whether there is a newer release.
 *
 * Never throws: an update check failing is not an error the user did anything
 * about, and a modal about GitHub being unreachable would be noise. It resolves
 * to `unknown`, which the UI states plainly rather than dressing up as fine.
 */
export async function checkForUpdate(deps: UpdateCheckDeps): Promise<UpdateCheck> {
	let url: string;
	try {
		url = releasesApiUrl(branding.repository);
	} catch (err) {
		return { state: 'unknown', reason: err instanceof Error ? err.message : String(err) };
	}

	let body: string;
	try {
		body = await deps.fetchText(url);
	} catch (err) {
		return {
			state: 'unknown',
			reason: `could not reach GitHub (${err instanceof Error ? err.message : String(err)})`
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { state: 'unknown', reason: 'GitHub sent something that was not a release' };
	}

	const release = releaseShape(parsed);
	if (!release) {
		return { state: 'unknown', reason: 'GitHub sent something that was not a release' };
	}

	switch (compareVersions(release.version, deps.currentVersion)) {
		case 'newer':
			return { state: 'updateAvailable', release };
		case 'notNewer':
			return { state: 'upToDate' };
		default:
			// Neither "there is an update" nor "you are current" is true here, and
			// the second is the dangerous one to guess at.
			return {
				state: 'unknown',
				reason: `could not compare ${release.version} against this build (${deps.currentVersion})`
			};
	}
}
