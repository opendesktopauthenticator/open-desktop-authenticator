import { reviewAsk } from '../markup.mjs';
import { browserFeatureCopy } from '../publication.mjs';

/** The three pages that exist to stop somebody being robbed. */

const publishedSourceVersion = (site) => site.publication?.github?.latestVersion ?? site.version;

export const scamClones = {
	slug: 'scam-clones',
	updated: '2026-09-30',
	navTitle: 'Scam clones',
	title: 'Fake Steam authenticator downloads',
	description:
		'Ran a suspicious Steam authenticator? Secure your account from a trusted device. Before downloading, check the publisher and release evidence.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: 'Fake Steam authenticator downloads: how they work and how to spot one',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/scam-clones`
	}),
	body: (s) => `
		<article>
			<h1>Fake Steam authenticator downloads</h1>
			<p class="lede">
				If you ran a suspicious authenticator or gave it your maFiles, start recovery
				from a different, trusted device. Working Steam Guard codes do not establish
				that a download is safe. If you have not run it, check its origin before opening it.
			</p>
			<nav class="jump" aria-label="Choose your situation">
				<ul>
					<li><a href="#already-ran-it">I already ran it</a></li>
					<li><a href="#before-downloading">I am checking a download</a></li>
				</ul>
			</nav>

			<h2 id="already-ran-it">If you already ran a suspicious authenticator</h2>
			<div class="callout callout-warn">
				<p>
					Treat credentials exposed to the suspect program as compromised. Use a
					different, trusted device for recovery. Importing the same maFile into a
					genuine application does not invalidate an attacker's copy.
				</p>
			</div>
			<ol>
				<li>
					<strong>Stop using the suspect computer and secure your email account.</strong>
					Disconnect the computer from the network. From a trusted device, change any
					exposed email password and review its sessions and recovery settings.
					Email access can let an attacker undo Steam recovery.
				</li>
				<li><strong>Recover control of Steam and change its password.</strong> Start at
					<a href="https://help.steampowered.com/en/faqs/view/0A94-F308-34A5-1988" rel="noopener">Steam's account-recovery instructions</a> if
					you cannot sign in. Review authorised devices and revoke unfamiliar sessions.
					Do not approve sign-in requests you did not initiate.</li>
				<li>
					<strong>Replace the compromised authenticator.</strong> Use Steam's
					<a href="https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31" rel="noopener">authenticator-removal instructions</a>, then set up a
					fresh authenticator, preferably in Valve's mobile app. Removing it invalidates
					its old authenticator secrets; changing a vault passphrase does not. Removal
					also brings Steam trade and Market restrictions. This step does not revoke
					every other kind of stolen credential, so complete the other steps too.
				</li>
				<li>
					<strong>Review and revoke any Steam Web API key</strong> at
					<a href="https://steamcommunity.com/dev/apikey" rel="noopener">Steam's API-key page</a>,
					including one you did not create. A key is a separate credential, not the same
					as a password or session; its presence is not required for account theft.
				</li>
				<li>
					<strong>Cancel pending unauthorised activity.</strong> Review trade offers,
					held trades, unsold Market listings and buy orders. Check eligible protected
					trades immediately. Report the incident through Steam Support and retain
					transaction IDs and the suspect download address without sharing your maFile.
				</li>
				<li>
					<strong>Clean or reinstall the affected system before trusting it again.</strong>
					Deleting the authenticator program alone does not establish that malware is
					gone. Change other credentials exposed on that computer from a trusted device.
				</li>
			</ol>

			<div class="callout">
				<p>
					<a href="https://github.com/Jessecar96/SteamDesktopAuthenticator" rel="noopener">SDA's own repository warns about fake builds that steal accounts</a>.
					The explanation below describes what exposed credentials can enable.
					It does not identify what a particular download did; that requires examining
					the file and the affected account.
				</p>
			</div>

			<h2>What the malicious build actually does</h2>
			<p>
				A malicious authenticator can generate correct codes while stealing the same
				secrets it uses to generate them. Working codes are not evidence of safety.
				A program you run may be able to:
			</p>
			<ul>
				<li>
					<strong>Copy the maFile.</strong> The whole file, containing the shared
					secret, the identity secret, a revocation code and possibly session tokens.
				</li>
				<li>
					<strong>Keep the passphrase.</strong> If your maFiles are encrypted, the
					program receives the passphrase when you type it and can retain it or the
					decrypted secrets. Encryption at rest cannot stop this.
				</li>
				<li>
					<strong>Approve a confirmation.</strong> With the identity
					secret <em>and a valid Steam session</em>, software can approve a pending
					confirmation. An attacker with sufficient account access can initiate the
					transaction too. The identity secret alone is not a logged-in session.
				</li>
				<li>
					<strong>Keep access for later.</strong> Copied authenticator secrets do not
					expire with each login code. A quiet period does not establish that a download
					was safe; there is no reliable delay to wait out.
				</li>
			</ul>

			<h2>&ldquo;My items are trade-locked, so I am safe&rdquo;</h2>
			<div class="callout callout-warn">
				<p>
					<strong>Check the actual restriction; do not infer safety from the word
					&ldquo;locked&rdquo;.</strong> A trade hold, a Market hold, an item-specific
					cooldown and CS2 Trade Protection are different mechanisms.
				</p>
			</div>
			<p>
				Valve documents <a href="https://help.steampowered.com/en/faqs/view/34A1-EA3F-83ED-54AB" rel="noopener">both trade and Market holds</a>:
				a trade hold delays delivery after acceptance, while a Market hold delays a
				sell listing becoming available. Other restrictions can block both features.
				Check the item's description and the account's
				<a href="/steam-guard-trade-holds">trade and Market restrictions</a>.
				Where selling is allowed, a compromised account can lose value through this route:
			</p>
			<ol class="signs">
				<li>
					<strong>Eligible items are sold on the Community Market.</strong> Only items
					that are marketable and not blocked by applicable restrictions can be sold.
					The proceeds, after fees, become Steam Wallet funds.
				</li>
				<li>
					<strong>The wallet balance is spent without permission.</strong> Our team
					member describes purchases of overpriced items that they believe benefited
					the attacker. This is spending through Market transactions, not a direct
					withdrawal or transfer of Steam Wallet funds.
				</li>
				<li>
					<strong>Completed Market transactions are final under Valve's policy.</strong>
					The <a href="https://help.steampowered.com/en/faqs/view/61F0-72B7-9A18-C70B" rel="noopener">Community Market FAQ</a>
					distinguishes completed purchases from unsold listings, which you can still
					remove. Report unauthorised activity and secure the account promptly.
				</li>
			</ol>
			<p>
				<strong>There is also a time-sensitive recovery route for eligible CS2 trades.</strong>
				Valve's <a href="https://help.steampowered.com/en/faqs/view/365F-4BEE-2AE2-7BDD" rel="noopener">Trade Protection</a>
				allows reversal within seven days. It reverses all eligible protected trades
				from that period and applies a 30-day trade and Market restriction to the
				initiating account. It does not reverse Community Market sales. Secure the
				account first, then check Trade History for eligibility.
			</p>
			<p>
				A restriction may buy time, but it does not remove malware or invalidate copied
				credentials. Use that time to recover control, not to test whether the attacker waits.
			</p>

			<h2 id="before-downloading">Before downloading: check the source</h2>
			<ol class="signs">
				<li>
					<strong>The download has no verified connection to the project.</strong>
					Follow release links from an independently established official address.
					Projects can legitimately use stores and distribution sites; a familiar logo,
					GitHub page or search position alone does not establish their identity.
				</li>
				<li>
					<strong>You cannot authenticate the published checksum.</strong> A hash
					checks byte equality. If an attacker controls both file and hash, matching
					them does not prove origin. A signature or attestation checked against the
					expected publisher adds evidence; a missing checksum alone does not prove malware.
				</li>
				<li>
					<strong>The site asks for your maFile, your password, or your API key.</strong>
					A download or support page does not need these secrets. Steam's own sign-in
					pages are different: check the actual Valve hostname before entering credentials.
				</li>
				<li>
					<strong>It arrived through an advertisement or a video description.</strong>
					That placement is not a verification of the publisher or download.
				</li>
				<li>
					<strong>It requests unexplained administrator rights.</strong> Generating
					codes does not require elevation. A legitimate machine-wide installer may
					need it; an installer format by itself is not evidence of a counterfeit.
				</li>
				<li>
					<strong>The page pressures you.</strong> A limited-time build, an urgent
					security update, a warning that your accounts are at risk.
				</li>
			</ol>

			<h2>What a genuine release looks like</h2>
			<p>
				For ODA's direct releases, these are the checks and current limitations:
			</p>
			<ul>
				<li>Published on the repository that holds the source, at a tagged version.</li>
				<li>
					A <code>SHA256SUMS.txt</code> file listing release artifacts. Ideally a signature
					over that list too —
					${
						s.release.checksums && s.release.signed
							? `ours carries one, and <a href="/verify">the verification page</a>
								shows how to check it.`
							: `ours does not have one yet, which is why the provenance attestation
								below matters here rather than being a nicety.`
					}
				</li>
				<li>
					A build anyone can reproduce from the tag and compare byte for byte against
					what was published.
					${
						s.release.reproducible
							? `<strong>Ours can be</strong> — rebuild the tag and the bytes match.`
							: `<strong>Ours cannot be, yet</strong> — it is on the list because it is
								an additional assurance we have not achieved. Build provenance records
								the workflow and source commit; it does not replace independent reproduction
								or establish that the source and dependencies are safe.`
					}
				</li>
				<li>
					<strong>No updater inside ODA.</strong> The optional direct-build update
					check reports a new version and links to it. Microsoft Store updates are
					managed by the Store. Neither policy proves that a release is safe.
				</li>
				<li>
					Documented storage locations. Our portable build keeps
					vaults, settings and recovery data beside its executable; its single-file
					launcher extracts Electron and Chromium runtime files to Windows Temp while
					it runs and normally removes them on exit. The ordinary installed build uses
					the normal application-data directory, because that is where its vault lives.
				</li>
			</ul>
			<p><a href="/verify">Step-by-step instructions for checking all of that</a>.</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-inventory-stolen">What this looked like when it happened to us</a></li>
				<li><a href="/verify">How to verify a download</a></li>
				<li><a href="/steam-desktop-authenticator">Original SDA and the ODA alternative</a></li>
				<li><a href="/what-is-a-mafile">Which secrets a maFile contains</a></li>
				<li><a href="/support">Report a suspected clone site</a></li>
			</ul>

${reviewAsk(s, { got: 'Did this help you spot a fake before you ran it?' })}
		</article>`
};

export const verify = {
	slug: 'verify',
	parent: 'download',
	guide: true,
	updated: '2026-10-15',
	sourced: (s) =>
		`Version covered: GitHub release ${s.publication.github.latestVersion}. Provenance command checked against <a href="https://cli.github.com/manual/gh_attestation_verify" rel="noopener">GitHub CLI's attestation verification reference</a>; checksum-list verification against <a href="https://docs.sigstore.dev/cosign/verifying/verify/" rel="noopener">Sigstore's Cosign documentation</a>`,
	navTitle: 'Verify',
	title: 'How to verify a download is genuine',
	description:
		'Check a download against its published SHA-256 checksum on Windows and Linux, and confirm where the bytes came from. Commands you can copy.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Verify an Open Desktop Authenticator download',
		description:
			'Check a release against its published checksum and its build provenance attestation.',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Get the checksum file from the release page' },
			{ '@type': 'HowToStep', name: 'Compute the hash of your download' },
			{ '@type': 'HowToStep', name: 'Compare the two, character for character' },
			{ '@type': 'HowToStep', name: 'Check the build provenance attestation' }
		]
	}),
	body: (s) => `
		<article class="guide">
			<h1>How to verify a download is genuine</h1>
			<p class="lede">
				These checks establish whether a file matches the release and its recorded
				publisher workflow. They do not prove the program is free of malware or bugs.
				Hash commands are general-purpose; the signing and attestation identities below
				are specific to ODA. Initial tool setup may take longer than the checks themselves.
			</p>

			<div class="callout">
				<p>
					<strong>${
						s.publication.github.current
							? `These commands apply to ${s.version}, which is published on GitHub.`
							: s.publication.store.current
								? `${s.version} is published in the Microsoft Store, but its GitHub release is still pending. These commands apply to GitHub's published ${s.publication.github.latestVersion}.`
								: `${s.version} is the upcoming source version. These commands apply to GitHub's published ${s.publication.github.latestVersion}.`
					}</strong> Run them
					against what you actually downloaded rather than reading them and moving on
					— a verification step you have never performed is not a habit, and the
					moment you need it is the worst moment to learn it.
				</p>
			</div>

			<h2>First: which copy do you have?</h2>
			<p>
				Store packages and direct ODA installers are verified
				differently. Checking the wrong thing for your copy produces a scary-looking
				result that means nothing, so start here.
			</p>
			<dl class="pairs">
				<dt>From the Microsoft Store</dt>
				<dd>
					Use the ODA listing linked from <a href="/download">our download page</a>
					and check its product and publisher. Windows verifies the Store package on
					installation and update; no manual checksum step is needed. Microsoft
					<a href="https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements" rel="noopener">re-signs the MSIX/AppX package it distributes</a>.
					That package signature does not mean each executable inside is individually signed.
				</dd>
				<dt>A direct ODA installer, from GitHub, Softonic or Uptodown</dt>
				<dd>
					Use the following checks before running it. Browser or antivirus scans,
					if present, do not establish that it came from the intended release workflow.
				</dd>
			</dl>
			<p>
				Use <a href="/download">our download page</a> and
				<a href="/official">the address reference</a> to find all four official download sources: Microsoft Store, GitHub, Softonic and Uptodown.
				These checks apply to the ODA installer itself. If a file's signature, publisher or
				checksum does not match the intended release, stop and obtain that release from GitHub
				instead. A listing or scan label does not replace these checks.
			</p>

			<h2>1. Get the checksums from the release page itself</h2>
			<p>
				Every release carries a <code>SHA256SUMS.txt</code> listing each artifact and
				its hash. Take it from the release page on the source repository — not from a
				mirror, and not from wherever you got the installer.
			</p>

			<h2>2. Compute the hash of what you downloaded</h2>
			<h3>Windows (PowerShell)</h3>
			<pre><code>Get-FileHash -Algorithm SHA256 .\\open-desktop-authenticator-${s.publication.github.latestVersion}-x64-setup.exe</code></pre>
			<h3>Linux</h3>
			<pre><code>sha256sum open-desktop-authenticator-${s.publication.github.latestVersion}-x86_64.AppImage</code></pre>
			<h3>macOS</h3>
			<p>
				macOS ships <code>shasum</code> rather than <code>sha256sum</code>, so the Linux
				command above returns &ldquo;command not found&rdquo; on a stock Mac. There is no
				published macOS build of this application — this is here for someone checking a download
				on a Mac before moving it to the machine that will run it.
			</p>
			<pre><code>shasum -a 256 open-desktop-authenticator-${s.publication.github.latestVersion}-x86_64.AppImage</code></pre>
			<p>Or check everything you downloaded at once, from that folder (Linux):</p>
			<pre><code>sha256sum --check --ignore-missing SHA256SUMS.txt</code></pre>
			<p>On macOS, use the single-file command above and compare its output manually;
				<code>shasum</code> options vary by the version supplied with macOS.</p>
			<p>
				<code>--ignore-missing</code> matters. The list covers every file in the
				release, and you almost certainly downloaded one of them &mdash; without it,
				<code>sha256sum</code> reports <code>FAILED open or read</code> for absent
				files. That differs from a checksum mismatch. With <code>--ignore-missing</code>,
				make sure your actual download is named in the output with <code>OK</code>;
				an unrelated file or no matching files does not verify your download.
			</p>
			<p>
				PowerShell prints its hash in upper case and the list is in lower case. That
				is the same value written two ways, not a mismatch &mdash; compare the
				characters, not the capitals.
			</p>

			<h2>3. Compare</h2>
			<p>
				The hash you computed must match the line for that filename exactly. Not
				"starts with the same characters" — the whole string. If it differs by one
				character, the file is not the file we published. Delete it.
			</p>

			<h2>4. Check where the bytes came from</h2>
			<p>
				A matching SHA-256 checksum establishes equality with the expected bytes. It does not
				prove who produced it — anyone who can replace the download can also replace the
				list of hashes sitting next to it. What closes that gap is a statement, made by
				something other than us, about which build produced these bytes.
			</p>
			<p>
				The release workflow publishes a signed provenance statement for the executable
				artifacts. Its signing identity is tied to GitHub Actions. You can check it:
			</p>
			<pre><code>gh attestation verify &lt;file&gt; --repo ${new URL(s.repo).pathname.slice(1)} --signer-workflow ${new URL(s.repo).pathname.slice(1)}/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z --deny-self-hosted-runners</code></pre>
			<p>
				Replace <code>&lt;file&gt;</code> with the downloaded filename and
				<code>vX.Y.Z</code> with its release tag. A pass confirms that the file's digest
				is covered by verified provenance naming this repository, workflow and tag,
				with a GitHub-hosted attestation runner. It
				does not prove the program is safe or reproducible; it narrows the claim to the
				producer and source you intended to trust instead of accepting any repository or
				workflow under the same organisation. The command needs the
				<a href="https://cli.github.com/" rel="noopener">GitHub CLI</a>. If it asks you
				to authenticate, use <code>gh auth login</code> through GitHub's own flow.
				Network errors, missing attestations and identity mismatches are different
				failures: resolve the reported cause before running the file, and do not remove
				identity checks to make a command pass. For commit-level pinning, add
				<code>--source-digest</code> with the independently checked full commit SHA.
			</p>

			${
				s.release.signed
					? `
			<h2>5. Check the checksum list is ours</h2>
			<p>
				Step 1 told you to take <code>SHA256SUMS.txt</code> from the release page rather
				than from wherever you got the installer, and that advice was doing a lot of
				work: a hash file proves nothing about itself. Anyone who could swap a binary on
				a page could usually swap the list beside it. That list is now signed.
			</p>
			<pre><code>cosign verify-blob SHA256SUMS.txt   --signature SHA256SUMS.txt.sig   --certificate SHA256SUMS.txt.pem   --certificate-identity '${s.repo}/.github/workflows/release.yml@refs/tags/vX.Y.Z'   --certificate-oidc-issuer https://token.actions.githubusercontent.com</code></pre>
			<p>
				Replace <code>vX.Y.Z</code> with the version you downloaded — the identity names
				the exact tag, so it will not match any other release. That is deliberate.
				This command used to check only that the signer was somewhere under our GitHub
				organisation, which would have accepted a signature minted by any workflow in
				any repository we own, run from any branch. Checking the whole identity is the
				difference between &ldquo;someone we know signed something&rdquo; and
				&ldquo;this release was built by this workflow from this tag&rdquo;.
			</p>
			<p>
				Both files are on the release beside the list itself. The signature is keyless —
				there is no long-lived release-signing private key held by this project; the certificate is minted
				for the workflow run that produced the release and expires minutes later. That
				is deliberate: a key held by one maintainer is a key that can be lost or taken,
				and this project has one maintainer.
			</p>
			<p>
				It needs <a href="https://docs.sigstore.dev/cosign/system_config/installation/" rel="noopener">cosign</a>.
				If you would rather not install it, the checksums and the attestation above
				still stand on their own — this step tells you the <em>list</em> came from our
				workflow, not just that your file matches it.
			</p>
			`
					: `
			<h2>5. The checksum list is not signed yet</h2>
			<p>
				A hash file proves nothing about itself: anyone who could swap a binary on a
				page could usually swap the list beside it. The answer to that is a signature
				over the list, and the release workflow now produces one — but it started
				doing so after the current release was published, so there is nothing to
				check on the build you can download today. Rather than print a command that
				cannot succeed, this step says so.
			</p>
			<p>
				<strong>Do not read a missing signature file as tampering.</strong> If you went
				looking for <code>SHA256SUMS.txt.sig</code> because an older version of this
				page told you to, that is our mistake and not a sign that anything is wrong
				with the download. The build provenance in step 4 covers the same ground for
				now: it names the workflow, the repository and the commit the bytes came from.
			</p>
			`
			}

			<h2>6. On Windows, check the publisher</h2>
			<pre><code>Get-AuthenticodeSignature .\\&lt;file&gt;.exe | Format-List Status, SignerCertificate, TimeStamperCertificate</code></pre>
			<p>
				Replace <code>&lt;file&gt;.exe</code> with the downloaded installer's or portable
				file's name. What you should see depends on the release and distribution channel:
			</p>
			<dl class="pairs">
				<dt>A Store install</dt>
				<dd>
				The Store package is signed and Windows checks it when installing. The
				command above checks a standalone <code>.exe</code>, not its enclosing
				MSIX/AppX package; an executable inside a signed package can report
				<code>NotSigned</code> without contradicting the package signature.
				</dd>
				<dt>A Windows download from GitHub ${s.publication.github.latestVersion}</dt>
				<dd>
					${
						s.release.codeSigned
							? `<strong><code>Status</code> should read <code>Valid</code>, and
							<code>SignerCertificate</code> should name <code>MASTERPANEL LLC</code>.</strong>
							The Windows installers and portable executable are Authenticode signed and
							timestamped through Microsoft Azure Artifact Signing. Check that a
							<code>TimeStamperCertificate</code> is present too. An unexpected publisher,
							<code>NotSigned</code>, or any result other than <code>Valid</code> means this
							check has not succeeded; stop and investigate before running the file.`
							: `<strong><code>Status</code> reads <code>NotSigned</code> for this release's
							Windows files.</strong> It predates Windows publisher signing. This step
							cannot establish their origin; use the checksums and provenance for that release.`
					}
				</dd>
			</dl>
			<p>
				Windows signing began with 1.5.1; the older 1.5.0 direct Windows downloads remain
				unsigned. Linux packages have no Windows Authenticode signature and use the
				checksum-list signature and provenance checks above. Signing does not guarantee
				that SmartScreen will stop warning or that a program is harmless. Use the release's
				stated signing status and the preceding checks together. Any checksum or provenance
				failure is a reason to stop and investigate.
			</p>

			<h2>Going further: build it yourself</h2>
			<p>
				You can inspect the source and build the tag yourself using the repository's
				build instructions. This changes which build environment you trust; it does
				not eliminate trust in source code, dependencies or your compiler.
			</p>
			<p>
				<strong>Comparing your build's hash against ours is not yet meaningful.</strong>
				Getting identical bytes from the same source — a reproducible build — takes
				deliberate work on toolchains and timestamps that this project has not finished.
				Until it is done, a mismatch would tell you nothing, and we would rather say so
				than let you draw a false conclusion from it. The
				<a href="/download">download page</a> tracks the state of that work.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/scam-clones">What a counterfeit build does</a></li>
				<li><a href="/approve-steam-confirmations-desktop">What approving confirmations really delegates</a></li>
				<li><a href="/security">The security model</a></li>
			</ul>

${reviewAsk(s, { got: 'Did these steps help you check a download?' })}
		</article>`
};

export const security = {
	slug: 'security',
	updated: '2026-09-30',
	navTitle: 'Security',
	title: 'Security model: how your Steam secrets are stored',
	description: (s) =>
		// The old wording stopped at "no network beyond Steam and an optional update
		// check", which was written before the in-app browser existed and quietly
		// became the site's largest understatement: that window loads whatever the
		// user navigates to. A description is the one sentence a search result
		// shows, so the exception is named in it rather than left to the body.
		browserFeatureCopy(s).description,
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Open Desktop Authenticator security model',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/security`
	}),
	body: (s) => `
		<article>
			<h1>Security model</h1>
			<p class="lede">
				What this application does with your secrets, what it deliberately refuses to
				do, and — the part most pages like this leave out — what it cannot protect you
				against.
			</p>

			<h2>Where secrets live</h2>
			<p>
				The vault encrypts each account's authenticator secrets, any available revocation
				code, saved Steam session token and proxy settings on your machine. The
				authenticator service does not upload these to an ODA backend; we operate no
				ODA account system or vault-sync service.
			</p>
			<p>
				<strong>The vault is not the only secret-bearing file.</strong> Local recovery
				data and backups also use encrypted envelopes:
			</p>
			<ul>
				<li>
					<strong>A recovery file per account</strong>, created during import, enrollment
					or transfer. If writing it fails, ODA reports that recovery still needs attention.
					It remains after local account removal and needs the passphrase in use when
					it was written; changing the vault passphrase does not rewrite existing
					standalone recovery files.
				</li>
				<li>
					<strong>The previous version of the vault</strong>, kept as a backup so a
					failed write can often be recovered. This is on the same disk and does not
					protect against disk loss.
				</li>
				<li>
					<strong>Operation and write-recovery records</strong> can retain encrypted
					secrets or encrypted key material after an interrupted enrollment, transfer
					or passphrase change. Keep the whole app-data directory when backing up or
					recovering an interrupted operation; resolve its warning before deleting records.
				</li>
			</ul>
			<p>
				And one file it does <em>not</em> protect: the maFile you imported from. Import
				reads those and leaves them exactly where they were — deleting somebody's only
				copy of a secret would be the worse mistake — so if it was plaintext before, it
				still is. Moving it somewhere safe is yours to do, and the app says so after
				every import.
			</p>
			<dl class="defs">
				<dt>Key derivation</dt>
				<dd>
					scrypt, deliberately tuned to take a noticeable moment on ordinary hardware.
					That cost is the point: it is paid once when you unlock, and paid again by
					anyone making offline passphrase guesses. A weak passphrase can still be found.
					The current
					defaults are
					<strong><code>N=131072</code>, <code>r=8</code>, <code>p=1</code></strong>,
					which uses approximately <strong>128&nbsp;MiB</strong> for scrypt's main memory array per attempt, plus overhead, with a
					32-byte random salt and a 256-bit derived key. Every vault records the
					parameters it was written with, so an old file still opens after the
					defaults are raised.
					<span class="hint">
						Stated exactly rather than described, because "tuned to take a moment" is
						not something anybody can check. These values are in
						<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/shared/vault-format.ts" rel="noopener">src/shared/vault-format.ts</a>
						and are the numbers the application actually uses.
					</span>
				</dd>
				<dt>Encryption</dt>
				<dd>
					AES-256-GCM, with a 12-byte (96-bit) nonce generated fresh for every write.
					The authentication tag covers the encrypted contents, vault version, key
					derivation parameters and nonce. Changing those without the key causes
					validation or decryption to fail. The envelope's informational modification
					timestamp is not authenticated; it is not proof that a file is the newest copy.
				</dd>
				<dt>Writing</dt>
				<dd>
					Every save is written to a temporary file, flushed to disk, and renamed over
					the target, with recovery handling for interrupted replacements. This reduces
					the risk of partial saves; disk failure, filesystem behavior and failed flushes
					can still prevent durable storage. The previous version is kept as a backup.
				</dd>
				<dt>Locking</dt>
				<dd>
					The vault locks on idle and on demand. ODA zeroes its live key buffer and
					drops the unlocked state. This is best-effort cleanup: JavaScript strings,
					runtime copies, swap or crash dumps cannot be guaranteed erased.
					Unlocking requires the passphrase again — being logged
					in to the computer is not treated as being present at it.
				</dd>
			</dl>

			<h2>How the application is put together</h2>
			<ul>
				<li>
					<strong>Stored authenticator secrets have a narrow display boundary.</strong> The
					window is a sandboxed renderer with no Node access and no direct filesystem
					access. Ordinarily it receives generated codes — which change on a thirty-second
					cycle and do not reveal the secret that made them — and never
					the secrets themselves. The exceptions are both revocation codes you
					deliberately asked to see: the backup ceremony, which makes you re-enter your
					passphrase first, and the end of a transfer, where Steam has just issued a new
					code and you must write it down. Each is shown once and cleared when you
					navigate away. Shared and identity secrets are not returned to that interface.
					The interface does receive passwords and passphrases you type, so a compromised
					interface is still dangerous. Browser sessions are a separate boundary below.
				</li>
				<li>
					<strong>A closed list of permitted messages.</strong> The interface can ask
					the privileged part of the application for a fixed set of named operations,
					each with a validated shape. There is no general-purpose bridge.
				</li>
				<li>
					<strong>No remote content in the interface.</strong> A strict content
					security policy with no remote origins, and navigation locked to the
					application's own files. This blocks direct remote loading and network requests
					from the authenticator interface. It is a defense layer, not a guarantee that
					a compromised renderer cannot misuse an allowed operation.
				</li>
				<li>
					<strong>${browserFeatureCopy(s).security}</strong>
				</li>
				<li>
					<strong>Developer tools are disabled in release builds</strong>, together with
					the menu accelerator that opens them. "Open the console and paste this to fix
					your codes" is an attack that works on real people.
				</li>
				<li>
					<strong>${s.runtimeDependencies} direct dependencies, ${s.shippedPackages}
					packages in total.</strong> Every package that ships is a package someone
					could compromise, so there are as close to none as the job allows — but the
					number worth trusting is the second one, because a dependency's own
					dependencies ship too. This page used to give only the first, which is a
					count of names typed into <code>package.json</code> rather than of packages
					in the installer. Both are counted when the page is built, the first from
					<code>package.json</code> and the second from
					<code>package-lock.json</code>, because a claim that has to be remembered is
					one that eventually goes stale. The complete list, with versions, is
					published as an SBOM beside every release, and the Electron runtime is
					shipped alongside them.
				</li>
			</ul>

			<h2>Check these claims against the release</h2>
			<p>
				A security page is only useful when its claims lead back to something a reader
				can inspect. These links are pinned to <strong>v${publishedSourceVersion(s)}</strong>,
				the latest published GitHub release, rather than a future source version or the
				moving main branch. Compare that version with the copy you run; the
				<a href="/download">download page</a> lists each channel's published version.
			</p>
			<dl class="defs">
				<dt>Vault format and encryption</dt>
				<dd>
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/shared/vault-format.ts" rel="noopener">Parameters and authenticated metadata</a>,
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/main/vault/crypto.ts" rel="noopener">encryption and decryption</a>, and
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/tests/vault-crypto.test.ts" rel="noopener">the regression tests</a>.
				</dd>
				<dt>Renderer and message boundary</dt>
				<dd>
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/main/security.ts" rel="noopener">Window isolation and navigation policy</a>,
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/preload/index.ts" rel="noopener">the deliberately narrow preload bridge</a>, and
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/tests/security-posture.test.ts" rel="noopener">the posture tests</a>.
				</dd>
				<dt>Network destinations</dt>
				<dd>
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/shared/security-policy.ts" rel="noopener">The interface security policy</a>,
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/main/net/egress.ts" rel="noopener">Steam transport egress enforcement</a>, and
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/tests/egress.test.ts" rel="noopener">tests for allowed and refused routes</a>.
				</dd>
				<dt>Deliberate refusals</dt>
				<dd>
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/main/update/checker.ts" rel="noopener">The notification-only update check</a>,
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/src/main/confirmations/policy.ts" rel="noopener">the fixed confirmation allowlist</a>, and
					<a href="${s.repo}/blob/v${publishedSourceVersion(s)}/tests/confirmation-policy.test.ts" rel="noopener">the policy tests</a>.
				</dd>
			</dl>

			<h2>Deliberate refusals</h2>
			<ul>
				<li>
					<strong>No self-updating.</strong> The application checks whether a newer
					version exists and links to it when the optional direct-build check is enabled.
					It never downloads or executes an update. Store updates are handled by Microsoft Store.
				</li>
				<li>
					<strong>Automatic confirmation has a fixed type allowlist.</strong> It
					can act on market listings and trades. Account recovery confirmations are
					held back and reported to you, and no setting exists to widen the list.
				</li>
				<li>
					<strong>Revealing a stored revocation code through the backup screen requires
					the passphrase again</strong>, even with the vault already unlocked. The new
					code displayed at the end of a transfer is the separate exception described above.
				</li>
				<li>
					<strong>Removing an account requires an explicit acknowledgement</strong>,
					because forgetting an account locally does not remove the authenticator from
					Steam, and the two get confused with expensive results.
				</li>
			</ul>

			<h2>The honest caveat about automatic confirmation</h2>
			<p>
				Automatic confirmation can approve the sale of eligible items. On a compromised
				account, that can help an attacker turn items into Wallet funds and spend the
				balance. <a href="/scam-clones">The incident-response guide</a> explains pending
				transactions, completed Market sales and the separate CS2 Trade Protection rules.
			</p>
			<p>
				The confirmation service only confirms what Steam is already asking about;
				it does not create listings. A user can still create listings on Steam pages
				in the separate browser.
				But if something else with access to your account can raise one — a stolen
				session or an authorised trading tool — then leaving
				automatic confirmation on for market listings means this application will
				approve it without showing you.
			</p>
			<p>
				So: it is off unless you turn it on, it is set per account rather than globally,
				and it is worth turning on only for accounts where the convenience is worth that
				trade. If you are not listing in volume, leave it off and confirm by hand. The
				<a href="/docs">Activity screen</a> records confirmation actions and outcomes;
				it is not a replacement for Steam's transaction history.
			</p>

			<h2>What this cannot protect you from</h2>
			<div class="callout callout-warn">
				<p>
					These limits apply even when the checksum and provenance checks pass.
				</p>
			</div>
			<ul>
				<li>
					<strong>A compromised computer.</strong> Malware running as you, while the
					vault is unlocked, may read secrets or intercept your next passphrase.
					Full-disk encryption helps with a lost powered-off device; it does not stop
					malware running in your session.
				</li>
				<li>
					<strong>A weak passphrase.</strong> scrypt raises the cost of guessing; it
					does not make a six-character passphrase safe.
				</li>
				<li>
					<strong>You approving a malicious trade.</strong> The application shows you
					what Steam said and does what you tell it. It cannot know that the person on
					the other end is not your friend.
				</li>
				<li>
					<strong>Phishing.</strong> No software prevents someone typing their
					passphrase into a convincing copy of it. <a href="/verify">Verify downloads</a>,
					check Steam hostnames and review sign-in and transaction requests before approving.
				</li>
			</ul>

			<h2>Reporting a vulnerability</h2>
			<p>
				Report security issues privately. Use
				<a href="${'https://github.com/opendesktopauthenticator/open-desktop-authenticator/security/advisories/new'}" rel="noopener">GitHub
				private vulnerability reporting</a>, which is preferred, or email — the address
				is in <a href="/.well-known/security.txt">security.txt</a> rather than on this
				page, as a standard discovery location. That file is public and can be scraped.
				<a href="/support#security-reports">What we commit to</a> is written down:
				acknowledgement in 72 hours, an assessment in 7 days, a fix or a dated plan in
				30 for a confirmed high or critical.
			</p>
		</article>`
};
