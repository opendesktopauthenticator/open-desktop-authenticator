export default {
	slug: 'steam-desktop-authenticator',
	updated: '2026-10-15',
	reviewed: '2026-10-15',
	navTitle: 'SDA & ODA',
	title: 'Steam Desktop Authenticator: Original SDA & ODA',
	description:
		'Find the original Steam Desktop Authenticator, compare it with Steam Mobile and ODA, and choose the right download or maFile migration route.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: 'Steam Desktop Authenticator: Original SDA & ODA',
		description:
			'Find the original SDA project, compare the three authenticator options, and plan an SDA-to-ODA migration.',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-09-30',
		mainEntityOfPage: `${s.origin}/steam-desktop-authenticator`
	}),
	body: (s) => `
		<article>
			<h1>Steam Desktop Authenticator: Original SDA &amp; ODA</h1>
			<p class="lede">
				<strong>Steam Desktop Authenticator (SDA)</strong> is the original community
				Windows app from Jessecar96. <strong>Open Desktop Authenticator (ODA)</strong>
				is a separate desktop app published by ${s.publisher}. Choose the original
				project, Valve's phone app, or ODA below.
			</p>

			<nav class="jump recovery-shortcuts" aria-label="Authenticator download choices">
				<ul>
					<li><a href="${s.sda.repo}" rel="noopener">Original SDA</a></li>
					<li><a href="https://store.steampowered.com/mobile" rel="noopener">Steam Mobile</a></li>
					<li><a href="/download">Download ODA</a></li>
				</ul>
			</nav>

			<div class="grid recovery-choices" aria-label="Choose an authenticator">
				<section>
					<h2>Original SDA</h2>
					<p>
						<strong>SDA is no longer maintained.</strong> Its authors recommend
						Steam Mobile. If you need to identify the original software or its
						releases, start with Jessecar96's repository.
					</p>
					<p><a class="button button-quiet" href="${s.sda.repo}" rel="noopener">Original SDA repository</a></p>
				</section>
				<section>
					<h2>Steam Mobile</h2>
					<p>
						<strong>Valve's official option for Android and iPhone.</strong>
						Use it for sign-in and trade confirmations on your phone.
						We recommend it when you do not need a desktop workflow.
					</p>
					<p><a class="button button-quiet" href="https://store.steampowered.com/mobile" rel="noopener">Get Steam Mobile</a></p>
				</section>
				<section>
					<h2>Open Desktop Authenticator</h2>
					<p>
						<strong>An independent, open-source desktop alternative.</strong>
						Generate codes, review confirmations and import SDA maFiles.
						Windows and Linux packages are published; testing limits are below.
					</p>
					<p><a class="button" href="/download">Download ODA ${s.publication.github.latestVersion}</a></p>
					<p><a href="/import-from-sda">Already have SDA? Import your maFiles →</a></p>
				</section>
			</div>
			<p>
				ODA is not affiliated with Valve or SDA's authors, and is not an official
				SDA release or an endorsed successor. We publish ODA and wrote this comparison.
			</p>

			<h2>What ODA looks like</h2>
			<figure class="recovery-product-shot">
				<a href="/assets/oda-accounts-demo-v150.png" aria-label="View the ODA 1.5.0 demonstration screenshot at full size">
					<img src="/assets/oda-accounts-demo-v150.png" width="1600" height="900"
						alt="ODA account dashboard with two fictional accounts, code copy controls, maFile import and confirmation buttons."
						loading="lazy" decoding="async">
				</a>
				<figcaption>
					ODA 1.5.0 interface, rendered with fictional accounts and demonstration
					codes. This illustrates the controls; it is not a live Steam-session test.
				</figcaption>
			</figure>
			<p>
				Each account has its own code and a route to its pending confirmations.
				The <strong>Import maFiles</strong> action reads existing SDA account files;
				<strong>Export</strong> lets you keep a separate copy. ODA stores accounts
				in a local encrypted vault. The <a href="/">product overview</a> explains
				its features, and the <a href="/download">download page</a> identifies
				the current packages and their requirements.
			</p>

			<h2 id="comparison">Which option fits your setup?</h2>
			<div class="tbl" role="region" aria-labelledby="comparison" tabindex="0">
				<table>
					<thead>
						<tr><th scope="col">Decision</th><th scope="col">Original SDA</th><th scope="col">Steam Mobile</th><th scope="col">ODA</th></tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row">Who publishes it?</th>
							<td>Jessecar96 and community contributors; unsupported.</td>
							<td>Valve, the operator of Steam.</td>
							<td>${s.publisher}; independent open-source project.</td>
						</tr>
						<tr>
							<th scope="row">Published platforms</th>
							<td>Windows; see the original repository's requirements.</td>
							<td>Android or iOS.</td>
							<td>Windows and x64 Linux packages. Check the <a href="/download">package and architecture choices</a>; no macOS package is published.</td>
						</tr>
						<tr>
							<th scope="row">Daily workflow</th>
							<td>Desktop codes and trade confirmations; continued compatibility is not assured.</td>
							<td>QR sign-in, sign-in approvals, and trade and Market confirmations on your phone.</td>
							<td>Desktop codes and trade/Market confirmations, with multiple accounts in one vault.</td>
						</tr>
						<tr>
							<th scope="row">Existing SDA files</th>
							<td>Keep the maFiles folder, encryption passphrase and matching manifest.</td>
							<td>Follow Valve's mobile setup or account-recovery instructions.</td>
							<td>Imports plaintext or SDA-encrypted maFiles. Exports plaintext maFiles without the Steam refresh token or proxy settings.</td>
						</tr>
						<tr>
							<th scope="row">Where to get it</th>
							<td>The original project's GitHub repository and releases.</td>
							<td>App links on Valve's Steam Mobile page.</td>
							<td>Four official sources: Microsoft Store, GitHub releases, Softonic and Uptodown, linked from <a href="/download">Download ODA</a>.</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p>
				Sources: <a href="${s.sda.repo}" rel="noopener">SDA's README</a>,
				<a href="https://store.steampowered.com/mobile" rel="noopener">Valve's mobile features and app links</a>,
				<a href="https://help.steampowered.com/en/faqs/view/6891-E071-C9D9-0134" rel="noopener">Steam Guard guidance</a>,
				and <a href="${s.repo}/releases/tag/v${s.publication.github.latestVersion}" rel="noopener">ODA's published release</a>.
				For a deeper choice based on recovery, updates and where your secrets live,
				<a href="/alternatives">compare the alternatives</a>.
			</p>

			<h2>Already using SDA? Start with your existing files</h2>
			<p>
				Importing a maFile copies its existing authenticator data into ODA.
				It does not remove or replace the authenticator on Steam. Keep your original
				SDA installation and an independent backup while checking the new setup.
			</p>
			<ol>
				<li>
					<strong>Make a copy of the SDA maFiles folder.</strong> For encrypted files,
					keep the matching <code>manifest.json</code> and your SDA passphrase.
					A Steam password cannot decrypt those files.
				</li>
				<li>
					<strong>Install ODA and create a vault.</strong> Choose
					<strong>Import maFiles</strong>, select the copied files and include the
					manifest when encrypted. Turn off automatic confirmations while checking.
				</li>
				<li>
					<strong>Review before importing.</strong> Check account names, duplicates
					and warnings. Proxy settings from a file are optional; leave them off unless
					you intend to use that route. Read each account's import result.
				</li>
				<li>
					<strong>Check the two functions separately.</strong> Compare codes for the
					same account. Then sign in when ODA asks and check that confirmations load.
					Matching codes alone does not verify the confirmation secret or session.
				</li>
			</ol>
			<p>
				<a class="button" href="/import-from-sda">Follow the complete SDA import guide</a>
			</p>
			<p>
				If you have only the phone authenticator, use the separate
				<a href="/move-steam-authenticator-to-pc">phone-to-PC guide</a>.
				If you have lost the working authenticator and its files,
				<a href="/lost-authenticator">choose an account-recovery route</a> first.
			</p>

			<h2>What to check before choosing a desktop authenticator</h2>
			<dl class="defs">
				<dt>Keep control of the files</dt>
				<dd>
					A maFile contains authenticator credentials: <code>shared_secret</code>
					generates login codes; <code>identity_secret</code> is used for
					confirmations together with a valid session. Do not upload these files
					to online viewers or support tickets. <a href="/what-is-a-mafile">See the file format and backup requirements</a>.
				</dd>
				<dt>Separate device risk from download verification</dt>
				<dd>
					Malware on a trading PC can threaten both its Steam session and a desktop
					authenticator. A separate phone reduces that shared exposure. Checking a
					download's origin does not remove this trade-off or prove its code is safe.
					<a href="/security">Read ODA's security boundaries</a>.
				</dd>
				<dt>Verify the actual ODA release</dt>
				<dd>
					Version ${s.publication.github.latestVersion}
					${s.release.checksums ? 'publishes SHA-256 checksums.' : 'does not publish SHA-256 checksums.'}
					${
						s.release.checksums && s.release.signed
							? 'Its checksum list carries a Sigstore signature.'
							: 'No signed checksum list is recorded for this release.'
					}
					${
						s.release.codeSigned
							? 'Its direct Windows downloads are signed and timestamped as MASTERPANEL LLC.'
							: 'Its direct Windows downloads do not have a publisher code signature.'
					}
					Store packages are signed separately by Microsoft.
					${s.release.reproducible ? '' : 'Builds are not yet reproducible.'}
					<a href="/verify">Follow the verification steps</a> to check file hashes,
					available signatures and build provenance. ODA's signing instructions
					do not apply to original SDA.
				</dd>
				<dt>Read what has actually been tested</dt>
				<dd>
					The <a href="${s.repo}/blob/v${s.publication.github.latestVersion}/docs/FOUNDER_TEST_PLAN.md" rel="noopener">maintainer's test record</a>
					describes Windows testing of imports, code matching and confirmations.
					This includes earlier releases, not a new test of every flow in the
					current version. Linux manual launch checks, live two-account proxy
					isolation and the browser's signed-in Steam handoff remain recorded gaps.
					${s.release.audited ? '' : 'ODA has no independent security audit.'}
				</dd>
			</dl>

			<h2>Help with an existing authenticator</h2>
			<ul class="plain next">
				<li><a href="/steam-guard-code-not-working">Codes rejected: check the account and clock</a></li>
				<li><a href="/encrypted-mafile">Encrypted maFile: find the manifest and passphrase</a></li>
				<li><a href="/approve-steam-confirmations-desktop">Confirmations missing or failing</a></li>
				<li><a href="/steam-revocation-code">Find or use a Steam recovery code</a></li>
				<li><a href="/scam-clones">Check a suspicious authenticator download</a></li>
			</ul>
		</article>`
};
