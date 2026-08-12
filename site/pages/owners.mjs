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
		blurb:
			'A trading platform for CS2 and CS:GO skins. The largest of these projects, and where most of what we know about how Steam accounts actually get compromised was learned.'
	},
	{
		name: 'BuySteamAccounts',
		domain: 'buysteamaccounts.com',
		logo: '/assets/projects/buysteamaccounts.svg',
		alt: 'BuySteamAccounts',
		blurb:
			'A marketplace for Steam accounts aimed at CS2 traders. Handling accounts at volume is what makes authenticator hygiene a daily operational problem rather than an abstract one.'
	},
	{
		name: 'ExactPic',
		domain: 'exactpic.com',
		logo: '/assets/projects/exactpic.svg',
		alt: 'ExactPic',
		blurb:
			'Fixes photos rejected by online forms — compress, resize and convert, entirely in the browser. Unrelated to Steam, and built on the same principle: the work happens on your machine, not on a server of ours.'
	},
	{
		name: 'Open Desktop Authenticator',
		domain: 'opendesktopauthenticator.com',
		logo: '/assets/mark.svg',
		alt: 'Open Desktop Authenticator',
		blurb:
			'This project. Free, open source, and the only one of the four that holds anything as sensitive as a Steam Guard shared secret — which is why it is the one built to be checked rather than trusted.'
	}
];

export default {
	slug: 'owners',
	navTitle: 'Who we are',
	title: 'Who builds this',
	description:
		'Open Desktop Authenticator is published by MASTERPANEL LLC. Who we are, what else we build, and why a Steam trading company wrote an open-source authenticator.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Organization',
		name: s.publisher,
		url: `${s.origin}/owners`,
		sameAs: PROJECTS.filter((p) => p.domain !== 'opendesktopauthenticator.com').map(
			(p) => `https://${p.domain}`
		),
		makesOffer: PROJECTS.map((p) => ({
			'@type': 'Offer',
			itemOffered: { '@type': 'SoftwareApplication', name: p.name, url: `https://${p.domain}` }
		}))
	}),
	body: (s) => `
		<article>
			<h1>Who builds this</h1>

			<p class="lede">
				${s.name} is published by <strong>${s.publisher}</strong>. On most products this
				page would be filler. On something that holds your Steam Guard secrets it is
				evidence, so here it is plainly.
			</p>

			<h2>Why this page exists</h2>
			<p>
				The counterfeit authenticators described on
				<a href="/scam-clones">the scam clones page</a> have one thing in common: nobody
				is behind them. No company, no name, no other work to point at, nothing that
				could be embarrassed by the software turning out to steal accounts. That
				anonymity is not incidental — it is the business model.
			</p>
			<p>
				We are not asking you to trust us because we are named. We are pointing out that
				a name is one of the few things you can check about a piece of software before
				you run it, alongside
				<a href="/verify">the checksum and the signature</a> and
				<a href="${s.repo}" rel="noopener">the source itself</a>. Use all of them.
			</p>

			<h2>What else we build</h2>
			<ul class="projects">
${PROJECTS.map(
	(p) => `				<li class="project">
					<div class="project-plate">
						<img src="${p.logo}" alt="${p.alt}" loading="lazy">
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
				Because we watch this go wrong. Running a skins platform and an account
				marketplace means dealing, routinely, with people whose accounts have just been
				emptied — and a large share of them were emptied the same way: they searched for
				a desktop authenticator, downloaded the first plausible result, and handed a
				modified build their <code>.maFile</code>.
			</p>
			<p>
				It also happened to one of us, before any of this existed.
				<a href="/steam-inventory-stolen">That account is written up in full</a>, because
				it is the most honest answer to why we bothered.
			</p>
			<p>
				That is a solvable problem. Not by telling people to be careful, which has never
				worked, but by making a version of the tool where the dangerous parts are
				visible, the build is reproducible, and the site tells you how to check what you
				downloaded. Whether they use ours or somebody else's matters less than whether
				they verify it.
			</p>

			<h2>The obvious question</h2>
			<p>
				Two of the projects above are commercial and Steam-adjacent. It is fair to ask
				whether a company that profits from Steam trading should be trusted with a
				Steam authenticator, and the honest answer is that you should not have to decide
				that on vibes.
			</p>
			<p>
				This is precisely why the application is built the way it is. It has
				<a href="/security">no server of ours to talk to</a>, no account system, and no
				telemetry — there is nowhere for a secret to go even if we wanted one. It cannot
				update itself, so a future version cannot be pushed to you quietly. And every
				line of it is public, so the claim in this paragraph is checkable rather than
				merely stated. That is a better answer than a promise.
			</p>

			<h2>Getting in touch</h2>
			<p>
				Bugs, documentation errors and suspected clone sites go through
				<a href="/support">the reporting form</a>. Security reports go to the same place
				and are handled privately — see <a href="/security">the security page</a> for
				what we ask and what we commit to.
			</p>
		</article>`
};
