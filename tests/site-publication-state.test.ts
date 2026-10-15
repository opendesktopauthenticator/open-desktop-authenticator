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
	github: Record<string, { publishedOn?: string; verifiedOn?: string; architectures?: string[] }>;
	store: Record<string, { publishedOn?: string; verifiedOn?: string; architectures?: string[] }>;
};

function siteFor(records: Publications, sourceVersion = VERSION) {
	const version = publicationApi.websiteVersion(sourceVersion, records);
	const publication = publicationApi.publicationState(version, records);
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
		version,
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
		released: records.github[version]?.publishedOn,
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
		heading: '1.5.0 is on GitHub; the Store offers 1.0.0',
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

	// Website publication records can advance before this checkout's app source.
	// A GitHub release must not also advance the independently checked Store marker.
	it('describes GitHub 1.5.1 and Store 1.5.1 independently of the app source version', () => {
		const { version: sourceVersion } = JSON.parse(
			readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
		) as { version: string };
		const site = siteFor(publicationApi.RELEASE_PUBLICATIONS, sourceVersion);
		expect(site.version).toBe('1.5.1');

		expect(
			site.publication.github.current,
			'the website must describe the verified published GitHub release'
		).toBe(true);
		expect(
			site.publication.store.current,
			'the Store marker moves only after the public Microsoft catalog serves the version'
		).toBe(true);
		expect(site.publication.github.latestVersion).toBe('1.5.1');
		expect(site.publication.github.latest).toMatchObject({
			publishedOn: '2026-09-26',
			architectures: ['x64', 'arm64']
		});
		expect(site.publication.store.latestVersion).toBe('1.5.1');
		expect(site.publication.store.latest).toMatchObject({
			verifiedOn: '2026-09-27',
			architectures: ['x64']
		});
		expect(text(download.body(site))).toMatch(/Store 1\.5\.1 \(x64\)/);
		expect(text(download.body(site))).toContain(
			'The recorded Store package is x64; use GitHub for native ARM64.'
		);

		const software = softwareFor(site);
		expect(software.softwareVersion).toBe('1.5.1');
		expect(software.datePublished).toBe('2026-09-26');
		expect(software.downloadUrl).toBe(site.store.url);
		expect(text(home.body(site))).toContain('1.5.1, in the Microsoft Store and on GitHub');
		expect(text(download.body(site))).toContain(
			"1.5.1 is published in the Microsoft Store and on this project's GitHub releases page."
		);
		expect(text(home.body(site))).not.toContain('the Store update is pending');
		expect(verify.body(site)).toContain('open-desktop-authenticator-1.5.1-x64-setup.exe');
		expect(verify.body(site)).not.toContain('open-desktop-authenticator-1.5.0-');
	});

	it('advances an older website checkout to a verified release from either channel', () => {
		const github = siteFor(
			{ github: { '1.5.1': { publishedOn: '2026-09-26' } }, store: { [VERSION]: {} } },
			VERSION
		);
		expect(github.version).toBe('1.5.1');
		expect(softwareFor(github).downloadUrl).toBe(`${github.repo}/releases/tag/v1.5.1`);

		const store = siteFor({ github: oldGitHub, store: { '1.5.1': {} } }, VERSION);
		expect(store.version).toBe('1.5.1');
		expect(store.publication.github.current).toBe(false);
		expect(softwareFor(store).downloadUrl).toBe(store.store.url);
		expect(softwareFor(store).datePublished).toBeUndefined();
	});

	it('names four current sources only when both catalog versions match the published version', () => {
		const site = siteFor({ github: { [VERSION]: {} }, store: { [VERSION]: {} } });
		const summary = publicationApi.publicationSummary({
			...site,
			softonic: { version: VERSION },
			uptodown: { version: VERSION }
		});
		expect(summary).toContain(`${VERSION} is published in the Microsoft Store and on GitHub`);
		expect(summary).toContain('listed for Windows x64 by Softonic and Uptodown');
		expect(summary).toContain('four official download sources');
	});

	it.each([
		{ softonicVersion: OLD, uptodownVersion: VERSION },
		{ softonicVersion: VERSION, uptodownVersion: OLD },
		{ softonicVersion: undefined, uptodownVersion: VERSION },
		{ softonicVersion: VERSION, uptodownVersion: undefined }
	])(
		'keeps catalog versions independent: Softonic $softonicVersion, Uptodown $uptodownVersion',
		({ softonicVersion, uptodownVersion }) => {
			const site = siteFor({ github: { [VERSION]: {} }, store: { [VERSION]: {} } });
			const summary = publicationApi.publicationSummary({
				...site,
				...(softonicVersion ? { softonic: { version: softonicVersion } } : {}),
				...(uptodownVersion ? { uptodown: { version: uptodownVersion } } : {})
			});
			expect(summary).not.toContain('four official download sources');
			for (const [name, version] of [
				['Softonic', softonicVersion],
				['Uptodown', uptodownVersion]
			]) {
				if (version) {
					expect(summary).toContain(`${name} lists the Windows x64 installer for ${version}`);
				} else {
					expect(summary).not.toContain(name);
				}
			}
		}
	);

	it.each(
		CASES.filter(({ downloadChannel, github }) => downloadChannel !== 'store' || github !== VERSION)
	)('does not let matching catalog listings imply publication when $name', ({ records }) => {
		const site = siteFor(records);
		const summary = publicationApi.publicationSummary({
			...site,
			softonic: { version: VERSION },
			uptodown: { version: VERSION }
		});
		expect(summary).not.toContain('four official download sources');
		expect(summary).toContain(publicationApi.publicationSummary(site));
		expect(summary).toContain(`Softonic lists the Windows x64 installer for ${VERSION}`);
		expect(summary).toContain(`Uptodown lists the Windows x64 installer for ${VERSION}`);
	});

	it('compares published versions numerically and preserves a newer upcoming source version', () => {
		const records = { github: { '1.9.0': {}, '1.10.0': {} }, store: oldStore };
		expect(publicationApi.websiteVersion('1.5.0', records)).toBe('1.10.0');
		expect(publicationApi.websiteVersion('2.0.0', records)).toBe('2.0.0');
		expect(publicationApi.websiteVersion(VERSION, { github: {}, store: {} })).toBe(VERSION);
	});

	it('wires the same browser availability into generated llms.txt facts and security copy', () => {
		const build = readFileSync(join(__dirname, '..', 'site', 'build.mjs'), 'utf8');
		expect(build).toContain('${browserFeatureCopy(SITE).fact}');
		expect(build).toContain('${browserFeatureCopy(SITE).security}');
		expect(build).not.toContain('- An in-app browser, signed in as one account');
		expect(build).toContain('<span class="powered-by">Published by</span>');
		expect(build).not.toContain('Powered by');
		expect(build).toMatch(/separate products with no shared accounts, data, or integration/);
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
		expect(expenses).toContain('Website hosting and the domain');
		expect(expenses).toContain('Time');
		expect(expenses).not.toMatch(/code-signing certificate/i);
		expect(expenses).not.toContain('the largest single cost');
	});
});
