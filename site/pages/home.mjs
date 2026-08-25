export default {
	slug: 'index',
	title: 'Open Desktop Authenticator — Steam Guard on your PC',
	navTitle: 'Home',
	description:
		'A free, open-source desktop Steam Guard authenticator. Generates codes, approves trade and market confirmations, and imports maFiles from SDA.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'Organization',
				'@id': `${s.origin}/#org`,
				name: s.publisher,
				url: s.origin,
				// The publisher's other authoritative presences: its own company site
				// and the source repository. `sameAs` is how a search engine ties the
				// three references to one entity — the same website → company → source
				// chain a suspicious human walks, expressed for a machine. The company
				// site is deliberately included even though this schema lives on the
				// product domain: it corroborates that MASTERPANEL LLC is a real
				// organisation with a footprint beyond this one site.
				sameAs: [s.brand.url, s.repo]
			},
			{
				'@type': 'SoftwareApplication',
				'@id': `${s.origin}/#app`,
				name: s.name,
				alternateName: 'ODA',
				applicationCategory: 'SecurityApplication',
				operatingSystem: 'Windows 10, Windows 11, Linux',
				isAccessibleForFree: true,
				// The repository's LICENSE is MIT. This said GPL-3.0, which is a false
				// claim in machine-readable form — see tests in site/verify.mjs.
				license: 'https://opensource.org/license/mit',
				publisher: { '@id': `${s.origin}/#org` },
				softwareHelp: `${s.origin}/docs`,
				offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
			}
		]
	}),
	/*
	 * The h1 lives here rather than in the body, so the page still has exactly
	 * one. A hero with its own heading plus a heading below it is the commonest
	 * way a landing page ends up with two, and then neither is what the page is
	 * about as far as a crawler is concerned.
	 */
	hero: (s) => `
		<section class="hero">
			<img class="hero-mark" src="/assets/mark.svg" width="88" height="88"
			     alt="" aria-hidden="true">
			<h1>An open-source Steam authenticator for the desktop</h1>
			<p class="lede">
				${s.name} generates Steam Guard codes on your computer, approves trades and
				market listings, and imports the <code>.maFile</code> accounts you already
				have — without ever asking you to take our word for anything.
			</p>
			<div class="hero-actions">
				<a class="button" href="/steam-desktop-authenticator">What this replaces</a>
				<a class="button button-quiet" href="/verify">How to verify a build</a>
			</div>

			<ul class="signals">
				<li>
					<b>Open source</b>
					<span>Every line that touches a secret is public and readable.</span>
				</li>
				<li>
					<b>No account</b>
					<span>Nothing to sign up for. No server of ours, no telemetry.</span>
				</li>
				<li>
					<b>No self-update</b>
					<span>It links to a new version. It never replaces itself.</span>
				</li>
				<li>
					<b>${s.release.checksums && s.release.signed ? 'Verifiable builds' : 'Built to be verifiable'}</b>
					<span>
						${
							s.release.checksums && s.release.signed
								? 'Checksums and signatures you can check against the source.'
								: 'Public source, public CI, published checksums and build provenance. A signature over the checksum list is not done yet.'
						}
					</span>
				</li>
			</ul>
		</section>`,

	body: () => `
		<article>
			<div class="callout">
				<h2>Status: 1.0, in the Microsoft Store and on GitHub</h2>
				<p>
					<a href="/download">The download page</a> has both, and they are the only
					two places a genuine build comes from. This page still hosts no installer
					and never will — every button here links outward.
				</p>
				<p>
					What is still missing is written down rather than left for you to find: the
					direct downloads carry no code-signing certificate, nothing signs the
					checksum list, builds are not yet reproducible, and no independent audit has
					happened. <a href="/download">The download page tracks each of those.</a>
				</p>
				<p>
					<strong>Code signing policy:</strong> who may approve a release for signing,
					and how to check one — <a href="/code-signing-policy">read it here</a>.
				</p>
			</div>

			<h2>Why this exists</h2>
			<p>
				<a href="/steam-desktop-authenticator">Steam Desktop Authenticator</a> — SDA —
				is the tool most traders have used for years to keep Steam Guard on a PC
				instead of a phone. It works, and this project owes it the idea. But searching
				for it is dangerous: the name outranks its own source, and a long tail of
				lookalike sites offer "SDA download" builds that are simply account stealers.
				A maFile contains the shared secret for your authenticator. Hand it to the
				wrong binary once and the account is gone, along with everything in the
				inventory.
			</p>
			<p>
				We think the answer is a tool where the dangerous parts are visible.
				<a href="/security">Everything in this application that touches a secret</a> is
				readable in the open, it is built in public CI from that source, and the site
				tells you <a href="/verify">how to check a download against what was
				published</a>. Reproducible builds — where you compile the tag yourself and get
				the same bytes — are the goal and are not finished; the
				<a href="/download">download page</a> tracks what is actually done.
			</p>

			<h2>What it does</h2>
			<div class="grid">
				<section>
					<h3>Steam Guard codes</h3>
					<p>
						The five-character code, regenerated every thirty seconds, with the time
						remaining shown as it drains. Copy puts it on the clipboard and clears it
						again on a timer.
					</p>
				</section>
				<section>
					<h3>Trade and market confirmations</h3>
					<p>
						Approve or cancel the confirmations Steam would otherwise send to a phone.
						Optional automatic confirmation is limited to market listings and trades,
						and cannot be widened to cover account-recovery requests.
					</p>
				</section>
				<section>
					<h3>Import from SDA</h3>
					<p>
						Reads <code>.maFile</code> accounts, including encrypted ones with their
						<code>manifest.json</code>. Nothing is written to your vault until you
						choose what to keep. <a href="/import-from-sda">How importing works</a>.
					</p>
				</section>
				<section>
					<h3>An encrypted vault</h3>
					<p>
						Secrets are sealed with a key derived from your passphrase using scrypt,
						then encrypted with AES-256-GCM. The vault locks itself when you stop
						using it. <a href="/security">The full security model</a>.
					</p>
				</section>
				<section>
					<h3>Adding a new authenticator</h3>
					<p>
						Move Steam Guard onto this app for an account that does not have an
						authenticator yet, including the revocation code you must write down
						before anything is activated.
					</p>
				</section>
				<section>
					<h3>Recovery that exists in advance</h3>
					<p>
						A recovery file is written when an account is enrolled, not when you ask
						for one, and it survives removing the account — because that is exactly
						when people discover they need it.
					</p>
				</section>
			</div>

			<h2>What it will not do</h2>
			<p>
				A short list, because the things a security tool refuses to do are more
				informative than the things it offers.
			</p>
			<ul class="plain">
				<li>
					<strong>It does not send your secrets anywhere.</strong> There is no account
					to create, no server of ours to sync with, and no telemetry. It talks to
					Steam, and — while the update check is on — asks GitHub's public releases
					page whether a newer version exists, which is the same question any visitor
					to that page asks. GitHub sees an IP address and that the application is
					running. Nothing about you or your accounts is sent to anyone, including us.
				</li>
				<li>
					<strong>It does not update itself.</strong> It will tell you a newer version
					exists and link to it. An application that can silently replace its own
					executable is the exact mechanism the clone sites rely on.
				</li>
				<li>
					<strong>It does not auto-confirm anything dangerous.</strong> Automatic
					confirmation works from a fixed allowlist of two types. Account recovery is
					not on it and cannot be added by a setting.
				</li>
			</ul>

			<h2>Start here</h2>
			<ul class="plain next">
				<li><a href="/steam-desktop-authenticator">What SDA is, and where this fits</a></li>
				<li><a href="/scam-clones">How the fake authenticator sites work</a></li>
				<li><a href="/security">The security model, in detail</a></li>
				<li><a href="/import-from-sda">Bringing your existing maFiles across</a></li>
				<li><a href="/alternatives">Which authenticator you should actually use</a></li>
			</ul>
		</article>`
};
