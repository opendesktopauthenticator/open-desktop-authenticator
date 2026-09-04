/**
 * Human-verified public release state, kept separate for the two channels.
 * A package version, workflow run, or GitHub release cannot prove what Partner
 * Center currently serves, and a Store submission cannot prove GitHub assets.
 */
export const RELEASE_PUBLICATIONS = {
	github: {
		'1.0.0': { publishedOn: '2026-08-25' }
	},
	// The listing is public, but no evidence in this repository says its 1.5.0
	// submission has completed Partner Center publication. Do not infer it from
	// the source version or from the GitHub workflow.
	store: {
		'1.0.0': {}
	}
};

const parts = (version) => version.split('.').map((part) => Number(part));

export function compareVersions(left, right) {
	const a = parts(left);
	const b = parts(right);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

const channel = (sourceVersion, releases) => {
	const versions = Object.keys(releases).sort(compareVersions);
	const latestVersion = versions.at(-1);
	return {
		current: Object.hasOwn(releases, sourceVersion),
		latestVersion,
		latest: latestVersion === undefined ? undefined : releases[latestVersion]
	};
};

export function publicationState(sourceVersion, releases = RELEASE_PUBLICATIONS) {
	return {
		sourceVersion,
		github: channel(sourceVersion, releases.github),
		store: channel(sourceVersion, releases.store)
	};
}

export const FEATURE_INTRODUCED = {
	browser: '1.5.0',
	transfer: '1.0.0'
};

export function featureAvailability(publication, introducedVersion) {
	const on = (channelState) =>
		channelState.latestVersion !== undefined &&
		compareVersions(channelState.latestVersion, introducedVersion) >= 0;
	const github = on(publication.github);
	const store = on(publication.store);
	return {
		introducedVersion,
		inSource: compareVersions(publication.sourceVersion, introducedVersion) >= 0,
		github,
		store,
		anyPublic: github || store,
		bothPublic: github && store
	};
}

export function browserAvailabilitySummary(site) {
	const feature = site.features.browser;
	const githubVersion = site.publication.github.latestVersion;
	const storeVersion = site.publication.store.latestVersion;
	if (feature.bothPublic) {
		return `The routed in-app browser is available in GitHub ${githubVersion} and Microsoft Store ${storeVersion}.`;
	}
	if (feature.github) {
		return `The routed in-app browser is available in GitHub ${githubVersion}; Microsoft Store ${storeVersion} does not include it yet.`;
	}
	if (feature.store) {
		return `The routed in-app browser is available in Microsoft Store ${storeVersion}; GitHub ${githubVersion} does not include it yet.`;
	}
	return `The routed in-app browser is part of the upcoming ${feature.introducedVersion} update and is absent from the currently downloadable GitHub ${githubVersion} and Microsoft Store ${storeVersion} builds.`;
}

export function browserFeatureCopy(site) {
	const status = browserAvailabilitySummary(site);
	return {
		description: site.features.browser.anyPublic
			? `How Steam secrets are stored, including the routed in-app browser and which published channel contains it.`
			: `How Steam secrets are stored. The routed in-app browser is upcoming in ${site.features.browser.introducedVersion} and is not in the current public builds.`,
		fact: site.features.browser.anyPublic
			? `An in-app browser, signed in as one account and routed like it, for finishing a trade on Steam or a third-party trading site. ${status}`
			: `Upcoming in ${site.features.browser.introducedVersion}: an in-app browser signed in as one account and routed like it for finishing a trade. ${status}`,
		security: site.features.browser.anyPublic
			? `The in-app browser is the deliberate exception: it is a user-driven window with no vault access that loads the sites the user chooses over that account's configured route. ${status}`
			: `${status} In ${site.features.browser.introducedVersion}, that user-driven window is the deliberate exception to the no-remote-content interface: it has no vault access and uses the account's configured route.`
	};
}

export function publicationSummary(site) {
	const { github, store } = site.publication;
	if (github.current && store.current) {
		return `${site.name} ${site.version} is published in the Microsoft Store and on this project's GitHub releases page.`;
	}

	const githubText = github.latestVersion
		? `GitHub currently offers ${github.latestVersion}.`
		: 'GitHub does not currently offer a public build.';
	const storeText = store.latestVersion
		? `The Microsoft Store currently offers ${store.latestVersion}.`
		: 'The Microsoft Store does not currently offer a public build.';
	if (github.current) {
		return `${site.name} ${site.version} is published on GitHub but is not yet published in the Microsoft Store. ${storeText}`;
	}
	if (store.current) {
		return `${site.name} ${site.version} is published in the Microsoft Store but is not yet published on GitHub. ${githubText}`;
	}
	return `${site.name} ${site.version} is the upcoming source version; it is not yet published in either release channel. ${githubText} ${storeText}`;
}
