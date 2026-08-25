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
 * offering me a download", and only two of these ever should.
 */
const OURS = [
	{
		address: 'opendesktopauthenticator.com',
		href: 'https://opendesktopauthenticator.com',
		what: 'This site. Documentation and links only — it has never hosted an installer and never will.',
		downloads: false
	},
	{
		address: 'github.com/opendesktopauthenticator',
		href: 'https://github.com/opendesktopauthenticator',
		what: 'The GitHub organisation. The source, the public build workflow, and the releases.',
		downloads: true
	},
	{
		address: 'apps.microsoft.com — Open Desktop Authenticator',
		href: 'https://apps.microsoft.com/detail/9NMM2XJ6HZ1D',
		what: 'The Microsoft Store listing, published by MASTERPANEL LLC. Microsoft re-signs what it distributes here.',
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
	navTitle: 'Official domains',
	title: 'Official domains for Open Desktop Authenticator',
	description:
		'Every address Open Desktop Authenticator is published from, and the two that may offer a download. Anything else using this name is not ours.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'WebPage',
		name: `Official domains for ${s.name}`,
		description: 'The complete list of addresses this project publishes from.',
		publisher: { '@id': `${s.origin}/#org` }
	}),
	body: (s) => `
		<article>
			<h1>Official domains</h1>

			<div class="callout">
				<p>
					This is the complete list. <strong>If an address is not on it, it is not
					ours</strong> — however similar the name, however convincing the page, and
					however high it ranks. There is no mirror, no community edition, no
					&ldquo;official&rdquo; download portal, and no third-party distributor.
				</p>
			</div>

			<h2>Where we publish</h2>
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
				Only two of those four ever hand you a file: the Microsoft Store listing and
				the GitHub releases page. <a href="/download">The download page</a> explains
				which to take, and <a href="/verify">how to check what you got</a>.
			</p>

			<h2>What this page is for</h2>
			<p>
				The attack this project exists to answer is a search result that looks
				official. Counterfeit builds of Steam Desktop Authenticator rank for its name,
				ship a working authenticator that also steals the account, and reappear under a
				new domain every time one is reported —
				<a href="/scam-clones">what a counterfeit build actually does</a> covers the
				pattern.
			</p>
			<p>
				A list like this only helps if it is the same list everywhere, which is why the
				release process compares the GitHub organisation name against this page rather
				than against somebody&rsquo;s memory. If this page and a download disagree,
				<strong>believe this page</strong>.
			</p>

			<h2>If you find something claiming to be us</h2>
			<p>
				Report it through <a href="/support">the reporting form</a> — suspected clone
				sites are one of the things it is for, and a report costs you a minute and may
				save somebody their inventory. Do not send us vulnerability details there;
				<a href="/security">the security page</a> has the private channels for that.
			</p>
			<p>
				If you already installed something that was not from one of the two addresses
				above, treat the account as compromised and
				<a href="/lost-authenticator">work through the recovery steps</a> rather than
				hoping. ${s.name} cannot undo that, and neither can we.
			</p>
		</article>`
};

export default official;
