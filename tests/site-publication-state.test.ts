import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

type PagesModule = typeof import('../site/pages/index.mjs', {
	with: { 'resolution-mode': 'import' }
});
type PublicationModule = typeof import('../site/publication.mjs', {
	with: { 'resolution-mode': 'import' }
});
type Page = PagesModule['PAGES'][number];
type StructuredPage = Page & {
	structuredData(site: unknown): {
		'@graph': Array<Record<string, unknown> & { '@type': string }>;
	};
};

let home: StructuredPage;
let download: Page;
let security: Page;
let verify: Page;
let moveToPc: Page;
let donate: Page;
let publicationApi: PublicationModule;

beforeAll(async () => {
	const [pages, publication] = await Promise.all([
		import('../site/pages/index.mjs'),
		import('../site/publication.mjs')
	]);
	const page = (slug: string) => {
		const found = pages.PAGES.find((candidate) => candidate.slug === slug);
		if (!found) throw new Error(`Site fixture is missing /${slug}`);
		return found;
	};
	home = page('index') as StructuredPage;
	download = page('download');
	security = page('security');
	verify = page('verify');
	moveToPc = page('move-steam-authenticator-to-pc');
	donate = page('donate');
	publicationApi = publication;
});

const VERSION = '1.5.0';
const OLD = '1.0.0';
const DATE = '2026-09-04';
const oldGitHub = { [OLD]: { publishedOn: '2026-08-25' } };
const oldStore = { [OLD]: {} };

type Publications = {
	github: Record<string, { publishedOn: string }>;
	store: Record<string, Record<string, never>>;
};

function siteFor(records: Publications, sourceVersion = VERSION) {
	const publication = publicationApi.publicationState(sourceVersion, records);
	const features = {
		browser: publicationApi.featureAvailability(
			publication,
			publicationApi.FEATURE_INTRODUCED.browser
		),
		transfer: publicationApi.featureAvailability(
			publication,
			publicationApi.FEATURE_INTRODUCED.transfer
		)
	};
	const release = {
		version: publication.github.latestVersion,
		published: publication.github.latestVersion !== undefined,
		checksums: true,
		signed: false,
		codeSigned: false,
		gpgSignature: false,
		reproducible: false,
		audited: false
	};
	return {
		version: sourceVersion,
		name: 'Open Desktop Authenticator',
		short: 'ODA',
		tagline: 'Authenticator',
		publisher: 'MASTERPANEL LLC',
		origin: 'https://example.test',
		repo: 'https://github.com/example/oda',
		githubOrg: 'example',
		store: { url: 'https://apps.microsoft.com/detail/example' },
		publication,
		features,
		release,
		released: records.github[sourceVersion]?.publishedOn,
		releasedOn: 'August 25, 2026',
		organizationId: 'https://example.test/#organization',
		websiteId: 'https://example.test/#website',
		softwareId: 'https://example.test/#software',
		brand: { legal: 'MASTERPANEL LLC', url: 'https://example.invalid', logo: '/logo.svg' },
		sda: {
			notice: 'is unsupported',
			authorsAdvice: 'use the mobile app',
			repo: 'https://github.com/example/sda',
			author: 'author'
		},
		reviews: {
			profile: 'https://reviews.example/profile',
			write: 'https://reviews.example/write',
			widget: {
				script: 'https://reviews.example/widget.js',
				origin: 'https://reviews.example',
				locale: 'en-US',
				templateId: 'template',
				businessUnitId: 'unit',
				token: 'token'
			}
		}
	};
}

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const softwareFor = (site: ReturnType<typeof siteFor>) => {
	// Exercise the same JSON serialization boundary used by the generated page;
	// an `undefined` field must disappear rather than become a misleading URL.
	const generated = JSON.parse(JSON.stringify(home.structuredData(site))) as ReturnType<
		StructuredPage['structuredData']
	>;
	const software = generated['@graph'].find((entry) => entry['@type'] === 'SoftwareApplication');
	if (!software) throw new Error('Homepage structured data is missing SoftwareApplication');
	return software;
};

const CASES = [
	{
		name: 'neither channel has the source version',
		records: { github: oldGitHub, store: oldStore },
		heading: '1.5.0 is the upcoming source version',
		github: OLD,
		date: undefined,
		downloadChannel: undefined,
		publishedTransfer: true,
		verify:
			"1.5.0 is the upcoming source version. These commands apply to GitHub's published 1.0.0.",
		browser:
			'upcoming 1.5.0 update and is absent from the currently downloadable GitHub 1.0.0 and Microsoft Store 1.0.0 builds'
	},
	{
		name: 'only GitHub has the source version',
		records: {
			github: { ...oldGitHub, [VERSION]: { publishedOn: DATE } },
			store: oldStore
		},
		heading: '1.5.0 is on GitHub; the Store update is pending',
		github: VERSION,
		date: DATE,
		downloadChannel: 'github',
		publishedTransfer: true,
		verify: 'These commands apply to 1.5.0, which is published on GitHub.',
		browser: 'available in GitHub 1.5.0; Microsoft Store 1.0.0 does not include it yet'
	},
	{
		name: 'only the Store has the source version',
		records: {
			github: oldGitHub,
			store: { ...oldStore, [VERSION]: {} }
		},
		heading: '1.5.0 is in the Store; the GitHub release is pending',
		github: OLD,
		date: undefined,
		downloadChannel: 'store',
		publishedTransfer: true,
		verify:
			"1.5.0 is published in the Microsoft Store, but its GitHub release is still pending. These commands apply to GitHub's published 1.0.0.",
		browser: 'available in Microsoft Store 1.5.0; GitHub 1.0.0 does not include it yet'
	},
	{
		name: 'both channels have the source version',
		records: {
			github: { ...oldGitHub, [VERSION]: { publishedOn: DATE } },
			store: { ...oldStore, [VERSION]: {} }
		},
		heading: '1.5.0, in the Microsoft Store and on GitHub',
		github: VERSION,
		date: DATE,
		downloadChannel: 'store',
		publishedTransfer: true,
		verify: 'These commands apply to 1.5.0, which is published on GitHub.',
		browser: 'available in GitHub 1.5.0 and Microsoft Store 1.5.0'
	}
] as const;

describe('per-channel publication output', () => {
	it.each(CASES)(
		'$name',
		({
			records,
			heading,
			github,
			date,
			downloadChannel,
			publishedTransfer,
			verify: verifyCopy,
			browser
		}) => {
			const site = siteFor(records);
			const downloadHtml = download.body(site);
			const homeHtml = home.body(site);
			const verifyHtml = verify.body(site);
			const transferHtml = text(moveToPc.body(site));
			const securityHtml = text(security.body(site));
			const browserCopy = publicationApi.browserFeatureCopy(site);

			expect(text(downloadHtml)).toContain(publicationApi.publicationSummary(site));
			expect(downloadHtml).toContain(`${site.repo}/releases/tag/v${github}`);
			expect(homeHtml).toContain(heading);
			expect(verifyHtml).toContain(`open-desktop-authenticator-${github}-x64-setup.exe`);
			expect(verifyHtml).toContain(`open-desktop-authenticator-${github}-x86_64.AppImage`);
			expect(text(verifyHtml)).toContain(verifyCopy);
			if (github !== VERSION) {
				expect(verifyHtml).not.toContain(`open-desktop-authenticator-${VERSION}-`);
			}

			const software = softwareFor(site);
			expect(software.softwareVersion).toBe(VERSION);
			expect(software.datePublished).toBe(date);
			const expectedDownload =
				downloadChannel === 'store'
					? site.store.url
					: downloadChannel === 'github'
						? `${site.repo}/releases/tag/v${VERSION}`
						: undefined;
			expect(software.downloadUrl).toBe(expectedDownload);
			if (software.downloadUrl === site.store.url)
				expect(site.publication.store.current).toBe(true);
			if (software.downloadUrl === `${site.repo}/releases/tag/v${VERSION}`) {
				expect(site.publication.github.current).toBe(true);
			}
			expect(transferHtml).toContain(
				publishedTransfer ? 'transfer is built into the published application' : 'Not yet.'
			);
			expect(text(homeHtml)).toContain(browser);
			expect(securityHtml).toContain(browser);
			expect(browserCopy.fact).toContain(browser);
			expect(browserCopy.security).toContain(browser);
			expect(typeof security.description).toBe('function');
			expect(
				typeof security.description === 'function'
					? security.description(site)
					: security.description
			).toBe(browserCopy.description);
			if (!site.features.browser.anyPublic) {
				expect(browserCopy.fact).not.toMatch(/^An in-app browser/);
				expect(securityHtml).not.toContain('The in-app browser is the deliberate exception');
			}
		}
	);

	it('keeps one channel from licensing claims about the other', () => {
		const githubOnly = text(
			download.body(
				siteFor({ github: { ...oldGitHub, [VERSION]: { publishedOn: DATE } }, store: oldStore })
			)
		);
		expect(githubOnly).toContain(
			'published on GitHub but is not yet published in the Microsoft Store'
		);
		expect(githubOnly).not.toContain('1.5.0 is published in the Microsoft Store and');

		const storeOnly = text(
			download.body(siteFor({ github: oldGitHub, store: { ...oldStore, [VERSION]: {} } }))
		);
		expect(storeOnly).toContain(
			'published in the Microsoft Store but is not yet published on GitHub'
		);
		expect(storeOnly).not.toContain('1.5.0 is published on GitHub');
	});

	it('does not call the checked-in package version published before either marker exists', () => {
		const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
		const site = siteFor(publicationApi.RELEASE_PUBLICATIONS as Publications);
		expect(version).toBe(VERSION);
		expect(site.publication.github.current).toBe(false);
		expect(site.publication.store.current).toBe(false);
		expect(publicationApi.publicationSummary(site)).toContain('upcoming source version');
		const software = softwareFor(site);
		expect(software.softwareVersion).toBe(VERSION);
		expect(software).not.toHaveProperty('datePublished');
		expect(software).not.toHaveProperty('downloadUrl');
	});

	it('wires the same browser availability into generated llms.txt facts and security copy', () => {
		const build = readFileSync(join(__dirname, '..', 'site', 'build.mjs'), 'utf8');
		expect(build).toContain('${browserFeatureCopy(SITE).fact}');
		expect(build).toContain('${browserFeatureCopy(SITE).security}');
		expect(build).not.toContain('- An in-app browser, signed in as one account');
	});

	it.each([
		['GitHub 1.0.0', VERSION, { github: oldGitHub, store: {} }],
		['Microsoft Store 1.0.0', VERSION, { github: {}, store: oldStore }],
		['both 1.0.0 channels after a future bump', '9.0.0', { github: oldGitHub, store: oldStore }]
	])('keeps the transfer available with %s published', (_name, sourceVersion, records) => {
		const site = siteFor(records, sourceVersion);
		expect(site.features.transfer.anyPublic).toBe(true);
		expect(text(moveToPc.body(site))).toContain(
			'Yes — the transfer is built into the published application.'
		);
	});

	it('does not publish the transfer before any channel reaches its introduction version', () => {
		const site = siteFor({ github: {}, store: {} });
		expect(site.features.transfer.anyPublic).toBe(false);
		expect(text(moveToPc.body(site))).toContain('Not yet.');
	});

	it('lists only real current costs in the donation page', () => {
		const html = donate.body(siteFor({ github: oldGitHub, store: oldStore }));
		const start = html.indexOf('<h2>What it pays for</h2>');
		expect(start, 'the expenses section disappeared').toBeGreaterThanOrEqual(0);
		const expenses = html.slice(start, html.indexOf('<div class="origin-note">', start));
		expect(expenses).toContain('The server this runs on');
		expect(expenses).toContain('Time');
		expect(expenses).not.toMatch(/code-signing certificate/i);
		expect(expenses).not.toContain('the largest single cost');
	});
});
