import { releaseGaps, sentenceList } from '../markup.mjs';
import { browserFeatureCopy, publicationSummary } from '../publication.mjs';

const downloadForSourceVersion = (site) => {
	if (site.publication.store.current) return site.store.url;
	if (site.publication.github.current) {
		return `${site.repo}/releases/tag/v${site.version}`;
	}
	return undefined;
};

export default {
	slug: 'index',
	updated: '2026-10-17',
	reviewed: '2026-10-17',
	title: 'Open Desktop Authenticator — Steam Guard on your PC',
	navTitle: 'Home',
	description:
		'A free, open-source desktop Steam Guard authenticator. Generates codes, approves trade and market confirmations, and imports maFiles from SDA.',
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
				'@type': 'WebSite',
				'@id': s.websiteId,
				url: s.origin,
				name: s.name,
				publisher: { '@id': s.organizationId },
				about: { '@id': s.softwareId }
			},
			{
				'@type': 'SoftwareApplication',
				'@id': s.softwareId,
				name: s.name,
				alternateName: 'ODA',
				url: s.origin,
				description: s.tagline,
				sameAs: [
					s.repo,
					s.store.url,
					...(s.alternativeTo ? [s.alternativeTo.url] : []),
					...(s.softonic ? [s.softonic.url] : []),
					...(s.uptodown ? [s.uptodown.url] : [])
				],
				applicationCategory: 'SecurityApplication',
				operatingSystem: 'Windows 10 version 1809 or later, Windows 11, x64 Linux',
				softwareVersion: s.version,
				/*
				 * **Omitted rather than guessed.** This was a single site-wide date
				 * described in its own comment as 1.0's, so once `version` moved it
				 * published 1.0's date beside `softwareVersion: 1.5.0` — a false
				 * statement about a release, in the form search engines read. A
				 * version with no publication date yet simply does not carry one.
				 */
				...(s.released !== undefined ? { datePublished: s.released } : {}),
				isAccessibleForFree: true,
				// The repository's LICENSE is MIT. This said GPL-3.0, which is a false
				// claim in machine-readable form — see tests in site/verify.mjs.
				license: 'https://opensource.org/license/mit',
				publisher: { '@id': s.organizationId },
				softwareHelp: `${s.origin}/docs`,
				...(downloadForSourceVersion(s) !== undefined
					? { downloadUrl: downloadForSourceVersion(s) }
					: {}),
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
			<h1>Open Desktop Authenticator</h1>
			<p class="lede">
				<strong>Steam Guard codes and confirmations on your computer.</strong>
				Open Desktop Authenticator (ODA) is a free, open-source app for Windows and
				Linux. View codes for your accounts, review trade and market confirmations,
				and import existing SDA <code>.maFile</code> backups into an encrypted vault.
			</p>
			<div class="hero-actions">
				<a class="button" href="/download">Download ODA ${s.publication.github.latestVersion}</a>
				<a class="button button-quiet" href="/import-from-sda">Import from SDA</a>
			</div>
			${s.softonic && s.uptodown ? `<p class="hint">Four official download sources: <a href="${s.store.url}" rel="noopener">Microsoft Store</a>, <a href="${s.repo}/releases" rel="noopener">GitHub</a>, <a href="${s.softonic.url}" rel="noopener">Softonic</a> and <a href="${s.uptodown.url}" rel="noopener">Uptodown</a>. <a href="/download#softonic-download-route">Read the Softonic download notice</a>.</p>` : ''}
			<p class="hint">
				Published by MASTERPANEL LLC. ODA is independent of Valve and the original
				SDA project. <a href="/steam-desktop-authenticator">Looking for Steam Desktop Authenticator?</a>
			</p>
			${
				s.release.codeSigned
					? `<p class="release-highlight">
				<strong>Signed Windows downloads are here.</strong>
				GitHub ${s.publication.github.latestVersion} is signed by MASTERPANEL LLC using
				Microsoft Azure Artifact Signing. <a href="/code-signing-policy">About the signatures</a>.
			</p>`
					: ''
			}

			<ul class="signals">
				<li>
					<b>Open source</b>
					<span>Every line that touches a secret is public and readable.</span>
				</li>
				<li>
					<b>No ODA account</b>
					<span>No ODA backend. No cloud sync. No telemetry.</span>
				</li>
				<li>
					<b>Clear update routes</b>
					<span>Manual updates for direct downloads; Store-managed updates for the Store edition.</span>
				</li>
				<li>
					<b>${s.release.checksums && s.release.signed ? 'Verifiable builds' : 'Built to be verifiable'}</b>
					<span>
						${
							s.release.checksums && s.release.signed
								? 'Published checksums, a signature over that list, and provenance naming the workflow and commit that built it.'
								: 'Public source, public CI, and build provenance naming the workflow and commit that built it. Check the verification guide for the signatures available in this release.'
						}
					</span>
				</li>
			</ul>
		</section>`,

	body: (s) => `
		<article>
			<figure class="recovery-product-shot">
				<img src="/assets/oda-accounts-demo-v150.png" width="1600" height="900"
					alt="ODA accounts screen with account cards, Steam Guard code timers and import controls"
					loading="lazy" decoding="async">
				<figcaption>ODA v1.5.0 interface, captured with fictional demo accounts and codes.
					This illustrates the account view; it is not a live Steam session or a new release test.</figcaption>
			</figure>
			<div class="callout">
				<h2>Status: ${
					s.publication.github.current && s.publication.store.current
						? s.softonic?.version === s.version && s.uptodown?.version === s.version
							? `${s.version} — four official download sources`
							: `${s.version}, in the Microsoft Store and on GitHub`
						: s.publication.github.current
							? `${s.version} is on GitHub; the Store offers ${s.publication.store.latestVersion}`
							: s.publication.store.current
								? `${s.version} is in the Store; the GitHub release is pending`
								: `${s.version} is the upcoming source version`
				}</h2>
				<p>
					${publicationSummary(s)} Choose a Windows installer, portable build or
					x64 Linux package on <a href="/download">the download page</a>.
					Published packages and platforms tested by a person are listed separately there.
				</p>
				<p>
					${
						releaseGaps(s).length
							? `Current limits: ${sentenceList(releaseGaps(s))}.
								<a href="/download">Read the release and testing details.</a>`
							: `Everything this page once listed as outstanding is done.
								<a href="/download">The download page shows where each one stands.</a>`
					}
				</p>
				<p>
					<strong>Code signing policy:</strong> ${s.release.codeSigned ? 'signed Windows downloads, ' : ''}Store package signing,
					Linux verification and checksum-list signatures — <a href="/code-signing-policy">read it here</a>.
				</p>
			</div>
			<h2>What it does</h2>
			<div class="grid">
				<section>
					<h3>Steam Guard codes</h3>
					<p>
						The five-character code, regenerated every thirty seconds, with the time
						remaining shown as it drains. Copy puts it on the clipboard and attempts
						to clear that entry on a timer. Clipboard history and other apps' copies
						are outside that clearing.
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
						and confirm you have saved outside this computer. Complete Steam's separate
						activation challenge as shown by the app.
					</p>
				</section>
				<section>
					<h3>Recovery that exists in advance</h3>
					<p>
						Encrypted account recovery files are created during import, enrollment and
						transfer, and retained after a vault entry is removed. They need the
						passphrase used when written. Keep an independent backup: a file on the
						same disk cannot protect you from losing that disk.
					</p>
				</section>
			</div>

			${
				s.alternativeTo
					? `<section class="community-listing" aria-labelledby="community-listing-title">
				<div>
					<h2 id="community-listing-title">Find us on AlternativeTo</h2>
					<p>Explore our listing, compare alternatives, and share your experience with ODA.</p>
				</div>
				<a href="${s.alternativeTo.url}?utm_source=badge&amp;utm_medium=referral" target="_blank" rel="noopener noreferrer">
					<img src="${s.alternativeTo.badge}" alt="Open Desktop Authenticator — listed on AlternativeTo"
						width="244" height="79" loading="lazy">
				</a>
			</section>`
					: ''
			}

			${
				s.uptodown
					? `<section class="community-listing" aria-labelledby="uptodown-listing-title">
				<div>
					<h2 id="uptodown-listing-title">Now available on Uptodown</h2>
					<p>Find ODA ${s.uptodown.version} for Windows x64 on Uptodown, listed under MASTERPANEL LLC.</p>
					<p>Its displayed installer checksum matches our GitHub release. <a href="/download">Compare all four download sources</a>
						and <a href="/verify">verify the file you download</a>.</p>
				</div>
				<a class="uptodown-badge" href="${s.uptodown.url}" rel="noopener">
					<img src="${s.uptodown.badge}" alt="Get Open Desktop Authenticator for Windows on Uptodown"
						width="172" height="61" loading="lazy">
				</a>
			</section>`
					: ''
			}

			${
				s.softonic
					? `<section class="community-listing" aria-labelledby="softonic-listing-title">
				<div>
					<h2 id="softonic-listing-title">Listed on Softonic</h2>
					<p>Find Open Desktop Authenticator for Windows on Softonic, published by MASTERPANEL LLC.
						On 1 October 2026, Softonic displayed <strong>“Trusted Program”</strong> and <strong>“Official distributor”</strong> on our listing.</p>
					<p>A public download tested on 1 October 2026 returned a separate Softonic downloader instead of the original ODA installer.
						Resolution is not verified; use Microsoft Store, GitHub or Uptodown. <a href="/download#softonic-download-route">Read the download notice and what the labels mean</a>.</p>
				</div>
				<a class="button button-quiet" href="${s.softonic.url}" rel="noopener">View ODA on Softonic</a>
			</section>`
					: ''
			}

			<h2>Why this exists</h2>
			<p>
				ODA provides a desktop workspace for people who already manage Steam accounts
				and maFile backups on a PC. It is a separate implementation, with its own
				source, release process and support. The original
				<a href="/steam-desktop-authenticator">Steam Desktop Authenticator and ODA</a>
				are different projects; that guide links the genuine original and explains
				your choices, including Valve's official mobile app.
			</p>
			<p>
				Using a desktop authenticator puts the Steam session and its second factor
				on the same computer. If you do not need that workflow, use
				<a href="https://store.steampowered.com/mobile" rel="noopener">Steam Mobile</a>
				on a separate phone. If you choose ODA, review its
				<a href="/security">security model</a>, <a href="/verify">verify the download</a>
				and keep an independent backup before importing accounts.
			</p>

			<h2>What it will not do</h2>
			<ul class="plain">
				<li>
					<strong>No ODA backend. No ODA account. No cloud sync. No telemetry.</strong>
					Steam operations you request contact Valve and send the data needed for that
					operation. In a direct build from GitHub, Softonic or Uptodown, the optional update check asks GitHub's
					public releases API whether a newer version exists; GitHub receives that
					request and its source IP, but no Steam account or vault data. Store builds do
					not perform that GitHub check. ${browserFeatureCopy(s).security}
					<a href="/security">The security model</a> sets out what each part can access.
				</li>
				<li>
					<strong>Direct downloads are updated manually.</strong> If enabled, the
					GitHub update check reports a newer version and links to its release; it
					does not download or install it. The Microsoft Store manages updates for
					the Store edition, subject to your Store settings.
				</li>
				<li>
					<strong>It never auto-confirms an account-recovery request.</strong> Automatic
					confirmation works from a fixed allowlist of two types — trades and market
					listings — and account recovery is not on it and cannot be added by a
					setting. Those two types can still move items and money, which is why the
					feature is off until you turn it on, per account, and why
					<a href="/security">the security model describes what it costs you</a>.
				</li>
			</ul>

			<h2>Start here</h2>
			<ul class="plain next">
				<li><a href="/steam-desktop-authenticator">What SDA is, and where this fits</a></li>
				<li><a href="/scam-clones">How the fake authenticator sites work</a></li>
				<li><a href="/security">The security model, in detail</a></li>
				<li><a href="/import-from-sda">Bringing your existing maFiles across</a></li>
				<li><a href="/alternatives">Compare authenticator options for your workflow</a></li>
			</ul>
		</article>`
};
