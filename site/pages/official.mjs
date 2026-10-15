/**
 * The official domains registry.
 *
 * Three separate places already treated this page as a trust anchor —
 * `MAINTENANCE.md` lists it as the registry, `docs/RELEASE_CHECKLIST.md` makes a
 * release step out of comparing the org name against it, and `branding.ts` cites
 * it twice as the thing a suspicious user checks a download against. It returned
 * 404 for the whole of 1.0.
 *
 * That is the worst possible shape for this particular gap. Everything else on
 * this site can be stale and still merely wrong; a missing verification endpoint
 * is a broken link in the one chain the project asks strangers to walk, and the
 * reader who follows it carefully is exactly the reader who was doing the right
 * thing.
 *
 * The list is deliberately short and deliberately complete. A registry that
 * omits something we own teaches people to distrust a genuine address; one that
 * pads the list with things we merely use teaches them the list means nothing.
 */

/**
 * Everything we publish from, and nothing we do not.
 *
 * `what` says what the address is *for*, because "is this domain yours" is
 * rarely the real question — the real question is "should this address be
 * offering me a download". Authorized distributors are included explicitly.
 */
const OURS = [
	{
		address: 'opendesktopauthenticator.com',
		href: 'https://opendesktopauthenticator.com',
		what: 'This site. Documentation and links only — it has never hosted an installer and never will.',
		downloads: false
	},
	{
		address: 'github.com/opendesktopauthenticator/open-desktop-authenticator',
		href: 'https://github.com/opendesktopauthenticator/open-desktop-authenticator',
		what: 'The project repository: source, public build workflow and releases. Use its Releases page for direct downloads.',
		downloads: true
	},
	{
		address: 'apps.microsoft.com — Open Desktop Authenticator',
		href: 'https://apps.microsoft.com/detail/9NMM2XJ6HZ1D',
		what: 'The Microsoft Store listing for product ID 9NMM2XJ6HZ1D, published by MASTERPANEL LLC. Microsoft signs the Store AppX package.',
		downloads: true
	},
	{
		address: 'open-desktop-authenticator.en.softonic.com',
		href: 'https://open-desktop-authenticator.en.softonic.com/',
		what: 'Softonic’s authorized Windows x64 listing, naming MASTERPANEL LLC. Its “Trusted Program” and “Official distributor” labels were checked on 1 October 2026. A tested route returned a separate downloader; read the notice below.',
		downloads: true
	},
	{
		address: 'open-desktop-authenticator.en.uptodown.com/windows',
		href: 'https://open-desktop-authenticator.en.uptodown.com/windows',
		what: 'Uptodown’s Windows x64 listing, naming MASTERPANEL LLC as developer. Version 1.5.1 and its displayed checksum were checked against the GitHub release on 15 October 2026.',
		downloads: true
	},
	{
		address: 'masterspanel.com',
		href: 'https://masterspanel.com',
		what: 'The company that publishes this. Names the product and links back here, which is the other half of the check.',
		downloads: false
	}
];

export const official = {
	slug: 'official',
	updated: '2026-10-15',
	reviewed: '2026-10-15',
	navTitle: 'Official domains',
	title: 'Official domains for Open Desktop Authenticator',
	description:
		'Check ODA publisher websites and its four official download sources: Microsoft Store, GitHub, Softonic and Uptodown.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'WebPage',
		name: `Official domains for ${s.name}`,
		description: 'The complete list of addresses this project publishes from.',
		publisher: { '@id': s.organizationId }
	}),
	body: (s) => `
		<article>
			<h1>Official domains</h1>

			<div class="callout">
				<p>
					Use the exact addresses on this page to find our four official download
					sources. <strong>A similar name or high search ranking is not
					proof of origin.</strong> The MIT licence allows others to redistribute or
					modify the source; that does not make independently built or modified copies ours.
				</p>
			</div>

			<h2>Publisher websites and official download sources</h2>
			<table class="pairs-table">
				<thead>
					<tr><th>Address</th><th>What it is</th><th>Downloads?</th></tr>
				</thead>
				<tbody>
					${OURS.map(
						(o) => `
					<tr>
						<td><a href="${o.href}" rel="noopener">${o.address}</a></td>
						<td>${o.what}</td>
						<td>${o.downloads ? '<strong>Yes</strong>' : 'No'}</td>
					</tr>`
					).join('')}
				</tbody>
			</table>

			<p>
				Our four official download sources are <strong>Microsoft Store, GitHub, Softonic and Uptodown</strong>.
				<a href="/download">The download page</a> explains
				which to take, and <a href="/verify">how to check what you got</a>.
			</p>
			${
				s.softonic
					? `<h2>What Softonic's labels mean</h2>
			<p>
				The <a href="${s.softonic.url}" rel="noopener">ODA listing on Softonic</a>
				names MASTERPANEL LLC as developer. Softonic's <strong>“Official distributor”</strong> label
				means it has authorization to offer ODA. Its <strong>“Trusted Program”</strong> label reports
				a clean VirusTotal scan of the listed file. We checked both labels on 1 October 2026.
				They are distribution and file-scan information, not an independent security audit of ODA.
			</p>
			<p>
				A public Softonic download tested on 1 October 2026 returned a separate Softonic downloader instead of the original ODA installer. Resolution is not verified; use Microsoft Store, GitHub or Uptodown. <a href="/download#softonic-download-route">Read the download notice</a>.
				For an ODA installer obtained there, <a href="/verify">check the publisher signature and compare the file
				with the matching GitHub release checksum</a>. ARM64, portable Windows and Linux packages are available on GitHub.
			</p>`
					: ''
			}

			<h2>What this page is for</h2>
			<p>
				The attack this project exists to answer is a search result that looks
				official. A counterfeit Steam Desktop Authenticator can display working codes
				while copying account secrets. Similar names and search rankings are not proof
				of origin —
				<a href="/scam-clones">what a counterfeit build actually does</a> covers the
				pattern.
			</p>
			<p>
				A list like this only helps if it is the same list everywhere, which is why the
				release process compares the GitHub organisation name against this page rather
				than against somebody&rsquo;s memory. If this page, the repository and a download
				disagree, <strong>stop and investigate</strong>. Do not choose whichever source
				looks most reassuring. Follow <a href="/verify">the signature and provenance
				checks</a>; a website can be compromised too.
			</p>

			<h2>If you find something claiming to be us</h2>
			<p>
				Report it through <a href="/support">the reporting form</a> — suspected clone
				sites are one of the things it is for, and a report costs you a minute and may
				save somebody their inventory. Do not send us vulnerability details there;
				<a href="/security">the security page</a> has the private channels for that.
			</p>
			<p>
				GitHub, Microsoft, Softonic and Uptodown can serve files through their own delivery
				domains after you follow the links above. A delivery redirect alone is
				not proof of a fake; a lookalike page offering its own build needs independent
				verification. If you ran an untrusted authenticator and gave it Steam
				credentials or maFiles, treat those secrets as potentially compromised and
				<a href="/scam-clones#already-ran-it">work through the compromised-account steps</a> rather than
				hoping. ${s.name} cannot undo that, and neither can we.
			</p>
		</article>`
};

export default official;
