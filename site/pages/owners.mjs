/**
 * Who is behind the software.
 *
 * For most products this page is filler. For an authenticator it is evidence:
 * the single most useful thing a reader can know about a tool that holds their
 * Steam secrets is whether a named, findable entity is accountable for it, or
 * whether it appeared on a download site under a pseudonym.
 *
 * Which is also why the descriptions here stay factual. A page arguing at length
 * that its author is trustworthy is doing the opposite of what it claims.
 */

const PROJECTS = [
	{
		name: 'Master Panel',
		domain: 'masterspanel.com',
		logo: '/assets/projects/masterspanel.svg',
		alt: 'Master Panel',
		w: 40,
		h: 40,
		blurb: 'A platform for trading Counter-Strike skins, operated by the same publisher as ODA.'
	},
	{
		name: 'BuySteamAccounts',
		domain: 'buysteamaccounts.com',
		logo: '/assets/projects/buysteamaccounts.svg',
		alt: 'BuySteamAccounts',
		// Square, like the others: the file here was a 300x80 wordmark with a
		// Steam-cloud icon that the site has not used for a long time. Replaced
		// with the mark buysteamaccounts.com actually serves.
		w: 40,
		h: 40,
		blurb:
			'A separate marketplace for Steam accounts. This commercial relationship is disclosed here; it is not evidence that ODA is secure or endorsed by Valve.'
	},
	{
		name: 'ExactPic',
		domain: 'exactpic.com',
		logo: '/assets/projects/exactpic.svg',
		alt: 'ExactPic',
		w: 40,
		h: 40,
		blurb:
			'Browser tools for compressing, resizing and converting images to meet upload requirements. A separate product with its own privacy information.'
	},
	{
		name: 'Open Desktop Authenticator',
		domain: 'opendesktopauthenticator.com',
		logo: '/assets/mark.svg',
		alt: 'Open Desktop Authenticator',
		w: 40,
		h: 40,
		blurb:
			'This project. A free, open-source desktop authenticator that stores Steam Guard secrets locally. Its source, release verification instructions and security limitations are public.'
	}
];

export default {
	slug: 'owners',
	updated: '2026-10-15',
	navTitle: 'Who we are',
	title: 'Who builds Open Desktop Authenticator',
	description:
		'Who publishes Open Desktop Authenticator: MASTERPANEL LLC, related businesses, documentation sources, and contacts for corrections or security reports.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'Organization',
				'@id': s.organizationId,
				name: s.publisher,
				legalName: s.brand.legal,
				url: s.brand.url,
				logo: `${s.origin}${s.brand.logo}`
			},
			{
				'@type': 'AboutPage',
				'@id': `${s.origin}/owners#page`,
				url: `${s.origin}/owners`,
				name: `Who builds ${s.name}`,
				isPartOf: { '@id': s.websiteId },
				about: { '@id': s.organizationId }
			}
		]
	}),
	body: (s) => `
		<article>
			<h1>Who builds Open Desktop Authenticator</h1>

			<p class="lede">
				${s.name} is published by <strong>${s.publisher}</strong>. This page identifies
				the publisher, its other products, the documentation's sources and where to
				report a problem.
			</p>

			<h2>The publisher and the project</h2>
			<p>
				${s.publisher} develops and publishes ODA as a free, open-source desktop
				authenticator for Steam. It is an independent product, unaffiliated with Valve
				or the authors of the original Steam Desktop Authenticator.
			</p>
			<ul class="plain next">
				<li><a href="${s.repo}" rel="noopener">Source code and development history</a></li>
				<li><a href="/official">Publisher websites and four official download sources</a></li>
				<li><a href="/verify">Release-origin and publisher-signature checks</a></li>
				<li><a href="/support">Report a bug or documentation correction</a></li>
			</ul>

			<h2>What else we build</h2>
			<ul class="projects">
${PROJECTS.map(
	(p) => `				<li class="project">
					<div class="project-plate">
						<img src="${p.logo}" alt="${p.alt}" width="${p.w}" height="${p.h}" loading="lazy">
					</div>
					<h3>${p.name}</h3>
					<span class="domain">${p.domain}</span>
					<p>${p.blurb}</p>
					<span class="go"><a href="https://${p.domain}" rel="noopener">Visit ${p.name} →</a></span>
				</li>`
).join('\n')}
			</ul>

			<h2>Why a Steam trading company wrote an authenticator</h2>
			<p>
				The team works with Steam accounts and trading workflows. ODA grew out of that
				experience and a team member's
				<a href="/steam-inventory-stolen">account of a suspected counterfeit authenticator</a>.
				The story is personal testimony; it is not an independently verified incident report.
			</p>
			<p>
				The product focuses on local account management, SDA file import, Steam Guard
				codes and desktop confirmations. The
				<a href="/security">security model</a> explains its limits, including what a
				compromised PC can expose. The
				<a href="/alternatives">authenticator comparison</a> includes Valve's official
				mobile app for people who prefer to keep the authenticator off their desktop.
			</p>

			<h2>How these guides are written</h2>
			<p>
				${s.publisher} is responsible for the guides and product claims on this site.
				Steam rules are checked against Valve's support pages; SDA file-format claims
				against its published source; ODA procedures against the application and its
				recorded checks. A result from a live test is labeled with its scope rather
				than presented as a rule for every account.
			</p>
			<p>
				Pages show when they were updated. Guide source notes link the evidence behind
				changeable instructions. Demo screenshots use fictional data and are labeled
				separately from live testing. If a step no longer matches Steam or ODA,
				<a href="/support">send a correction</a> with the page address and app version;
				leave passwords, maFiles and recovery codes out of the report.
			</p>
			<p>
				<strong>We use generative AI to assist drafting, editing and source review.</strong>
				AI output is not a source or a test result. Claims still need the documentation,
				implementation or observed evidence described above, and ${s.publisher}
				remains responsible for corrections.
			</p>
			<p>
				The <a href="${s.repo}/blob/main/docs/FOUNDER_TEST_PLAN.md" rel="noopener">maintainer's test record</a>
				distinguishes completed checks from outstanding work. It includes historical
				Windows testing; it is not an independent security audit or confirmation that
				every published platform has been exercised by a person.
			</p>

			<h2>Commercial relationships and data</h2>
			<p>
				The products listed above share a publisher. They do not share an ODA login or
				cloud account: the application has
				<strong>no ODA backend, no ODA account, no cloud sync, and no telemetry</strong>.
				Requested Steam operations contact Valve, and direct builds from GitHub, Softonic or Uptodown can optionally
				check GitHub for updates; neither service is operated by ${s.publisher}. The
				in-app browser contacts the sites you open and resources those sites load;
				those services can collect their own data. The app has no built-in update installer.
				<strong>Microsoft Store installations can update through the Store</strong>, subject
				to your Store settings. Direct builds from GitHub, Softonic or Uptodown require a manual download and install.
				The <a href="/security">security model</a> and <a href="/privacy">privacy page</a>
				describe these boundaries and their limits.
			</p>

			<h2>Getting in touch</h2>
			<p>
				Bugs, documentation errors and suspected clone sites go through
				<a href="/support">the reporting form</a>.
			</p>
			<p>
				<strong>Vulnerabilities do not.</strong> The reporting form writes a ticket
				anyone holding its link can read, which is the wrong place for a working
				exploit. Use
				<a href="https://github.com/opendesktopauthenticator/open-desktop-authenticator/security/advisories/new" rel="noopener">GitHub's
				private vulnerability reporting</a>, or the address in
				<a href="/.well-known/security.txt">security.txt</a> — the two channels
				<a href="/security">the security page</a> names, and the only two there are.
			</p>
		</article>`
};
