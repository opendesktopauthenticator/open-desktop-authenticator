/** The three pages that exist to stop somebody being robbed. */

export const scamClones = {
	slug: 'scam-clones',
	navTitle: 'Scam clones',
	title: 'Fake Steam authenticator downloads',
	description:
		'Counterfeit SDA builds steal maFiles and drain inventories. The patterns to recognise, what a real release looks like, and what to do if you ran one.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: 'Fake Steam authenticator downloads: how they work and how to spot one',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/scam-clones`
	}),
	body: () => `
		<article>
			<h1>Fake Steam authenticator downloads</h1>
			<p class="lede">
				A counterfeit authenticator does not need to break any cryptography. It only
				needs you to open your maFile with it once. This page describes what those
				builds actually do, the signs that separate a real release from a trap, and
				what to do if you think you have already run one.
			</p>

			<h2>What the malicious build actually does</h2>
			<p>
				It works. That is the part people find hardest to believe. A stealer that
				failed to generate codes would be deleted within a minute, so it generates
				codes correctly and looks like the real thing. In the background it does one
				or more of:
			</p>
			<ul>
				<li>
					<strong>Copies the maFile out.</strong> The whole file, containing the shared
					secret, the identity secret and the revocation code, uploaded on first run.
				</li>
				<li>
					<strong>Keeps the passphrase.</strong> If your maFiles are encrypted, the
					program has to see your passphrase to decrypt them. So it records it.
				</li>
				<li>
					<strong>Auto-approves a confirmation it created.</strong> With the identity
					secret, an attacker can raise a trade and confirm it from their own copy.
					Nothing appears on your screen.
				</li>
				<li>
					<strong>Waits.</strong> Often weeks. Theft timed to the moment you enabled it
					would point straight at the download.
				</li>
			</ul>

			<h2>The signs, in order of how much they tell you</h2>
			<ol class="signs">
				<li>
					<strong>The download is not on the project's own source repository.</strong>
					This is the one that matters most. Real projects release from the same place
					the code lives. A download hosted on a marketing page, a file locker, a
					shortened link, or a Discord attachment has no chain back to any source.
				</li>
				<li>
					<strong>There are no checksums, or the checksums are not published
					separately from the file.</strong> A hash printed next to the download by the
					same person who could swap the download proves nothing.
				</li>
				<li>
					<strong>The site asks for your maFile, your password, or your API key.</strong>
					No authenticator needs to be given anything through a web page. Ever.
				</li>
				<li>
					<strong>It arrived through an advertisement or a video description.</strong>
					Paid placement above the real result is a standard part of this.
				</li>
				<li>
					<strong>It wants to be installed rather than unpacked, and asks for
					administrator rights.</strong> An authenticator does not need administrator
					rights.
				</li>
				<li>
					<strong>The page pressures you.</strong> A limited-time build, an urgent
					security update, a warning that your accounts are at risk.
				</li>
			</ol>

			<h2>What a genuine release looks like</h2>
			<p>
				Ours, when it exists, will look like this — and so does any other project worth
				trusting:
			</p>
			<ul>
				<li>Published on the repository that holds the source, at a tagged version.</li>
				<li>A <code>SHA256SUMS</code> file listing every artifact, and a signature over it.</li>
				<li>
					A build that anyone can reproduce from the tag and compare byte for byte
					against what was published.
				</li>
				<li>No installer that reaches outside its own directory, and no self-update.</li>
			</ul>
			<p><a href="/verify">Step-by-step instructions for checking all of that</a>.</p>

			<h2>If you think you already ran one</h2>
			<div class="callout callout-warn">
				<p>
					Assume the secret is copied. Speed matters more than certainty here — the
					steps below cost you an afternoon if you are wrong, and save the account if
					you are right.
				</p>
			</div>
			<ol>
				<li>
					<strong>Detach the authenticator from Steam using the revocation code.</strong>
					This invalidates the shared and identity secrets. A copy of your maFile
					becomes worthless. This is the step that actually stops the theft.
				</li>
				<li><strong>Change your Steam password</strong>, from a machine you trust.</li>
				<li>
					<strong>Deauthorise all other devices</strong> in Steam's settings, which
					kills any session the attacker is holding.
				</li>
				<li>
					<strong>Revoke your Steam Web API key</strong> if you have ever created one.
					An API key left behind is a common way access survives a password change.
				</li>
				<li>
					<strong>Re-enable Steam Guard fresh</strong>, and treat the machine you ran
					the build on as compromised until you have dealt with it.
				</li>
			</ol>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/verify">How to verify a download</a></li>
				<li><a href="/steam-desktop-authenticator">What SDA and maFiles are</a></li>
				<li><a href="/support">Report a suspected clone site</a></li>
			</ul>
		</article>`
};

export const verify = {
	slug: 'verify',
	navTitle: 'Verify',
	title: 'How to verify a download is genuine',
	description:
		'Check a release against its published SHA-256 checksum and signature on Windows and Linux, and confirm the build matches the public source. Commands you can copy.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Verify an Open Desktop Authenticator download',
		description: 'Check a release against its published checksum and signature.',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Get the checksum file from the release page' },
			{ '@type': 'HowToStep', name: 'Compute the hash of your download' },
			{ '@type': 'HowToStep', name: 'Compare the two, character for character' },
			{ '@type': 'HowToStep', name: 'Verify the signature over the checksum file' }
		]
	}),
	body: () => `
		<article>
			<h1>How to verify a download is genuine</h1>
			<p class="lede">
				Verification is the difference between trusting a file and knowing what it is.
				It takes about a minute. These instructions work for our releases and, with the
				filenames changed, for anything else you download.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>No release exists yet</strong>, so there is nothing to verify today.
					The commands below are exactly what will apply when there is, and they are
					published now so the process is familiar before it matters.
				</p>
			</div>

			<h2>1. Get the checksums from the release page itself</h2>
			<p>
				Every release carries a <code>SHA256SUMS.txt</code> listing each artifact and
				its hash. Take it from the release page on the source repository — not from a
				mirror, and not from wherever you got the installer.
			</p>

			<h2>2. Compute the hash of what you downloaded</h2>
			<h3>Windows (PowerShell)</h3>
			<pre><code>Get-FileHash -Algorithm SHA256 .\\OpenDesktopAuthenticator-Setup.exe</code></pre>
			<h3>Linux or macOS</h3>
			<pre><code>sha256sum OpenDesktopAuthenticator.AppImage</code></pre>
			<p>Or check every file at once against the list:</p>
			<pre><code>sha256sum --check SHA256SUMS.txt</code></pre>

			<h2>3. Compare</h2>
			<p>
				The hash you computed must match the line for that filename exactly. Not
				"starts with the same characters" — the whole string. If it differs by one
				character, the file is not the file we published. Delete it.
			</p>

			<h2>4. Verify the signature over the checksum file</h2>
			<p>
				A checksum proves the file was not corrupted. A signature proves who wrote the
				checksum. Without step 4, anyone who can replace the download can also replace
				the list of hashes.
			</p>
			<pre><code>gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt</code></pre>
			<p>
				You are looking for a good signature from the release key published on the
				repository. A warning that the key is not certified with a trusted signature is
				normal and only means you have not personally marked it as trusted; a
				<em>BAD signature</em> is not normal and means stop.
			</p>

			<h2>5. On Windows, check the executable's signature too</h2>
			<pre><code>Get-AuthenticodeSignature .\\OpenDesktopAuthenticator-Setup.exe | Format-List Status, SignerCertificate</code></pre>
			<p>
				<code>Status</code> should read <code>Valid</code> and the signer should be the
				publisher named on the release page. An unsigned build, or one signed by a name
				you do not recognise, is not ours.
			</p>

			<h2>Going further: build it yourself</h2>
			<p>
				The strongest check available is not to trust our binary at all. The source is
				public and the build is reproducible: clone the tag, build it, and compare your
				artifact's hash with the published one. If they match, the binary on the release
				page contains exactly the source you just read.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/scam-clones">What a counterfeit build does</a></li>
				<li><a href="/security">The security model</a></li>
			</ul>
		</article>`
};

export const security = {
	slug: 'security',
	navTitle: 'Security',
	title: 'Security model',
	description:
		'How Steam secrets are stored: scrypt, AES-256-GCM, an isolated renderer, no network but Steam — and the limits of what any desktop authenticator can do.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Open Desktop Authenticator security model',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/security`
	}),
	body: () => `
		<article>
			<h1>Security model</h1>
			<p class="lede">
				What this application does with your secrets, what it deliberately refuses to
				do, and — the part most pages like this leave out — what it cannot protect you
				against.
			</p>

			<h2>Where secrets live</h2>
			<p>
				Every account's shared secret, identity secret and revocation code is held in a
				single encrypted vault file on your machine. Nothing is stored anywhere else and
				nothing is transmitted to us; we operate no account system and no sync service.
			</p>
			<dl class="defs">
				<dt>Key derivation</dt>
				<dd>
					scrypt, deliberately tuned to take a noticeable moment on ordinary hardware.
					That cost is the point: it is paid once when you unlock, and paid again by
					anyone trying to guess your passphrase, several billion times.
				</dd>
				<dt>Encryption</dt>
				<dd>
					AES-256-GCM. The authentication tag covers the vault's version, the key
					derivation parameters and the nonce as additional data, so a file cannot be
					altered — including downgrading it to weaker parameters — without the
					decryption failing outright rather than silently producing something wrong.
				</dd>
				<dt>Writing</dt>
				<dd>
					Every save is written to a temporary file, flushed to disk, and renamed over
					the target. A crash mid-write leaves either the old vault or the new one,
					never a half-written file. The previous version is kept as a backup.
				</dd>
				<dt>Locking</dt>
				<dd>
					The vault locks on idle and on demand, and the derived key is dropped from
					memory when it does. Unlocking requires the passphrase again — being logged
					in to the computer is not treated as being present at it.
				</dd>
			</dl>

			<h2>How the application is put together</h2>
			<ul>
				<li>
					<strong>Secrets never reach the interface.</strong> The window is a sandboxed
					renderer with no Node access and no direct filesystem access. It receives
					generated codes — which expire in thirty seconds and cannot be turned back
					into the secret that made them — and never the secrets themselves.
				</li>
				<li>
					<strong>A closed list of permitted messages.</strong> The interface can ask
					the privileged part of the application for a fixed set of named operations,
					each with a validated shape. There is no general-purpose bridge.
				</li>
				<li>
					<strong>No remote content.</strong> A strict content security policy with no
					remote origins, and navigation locked to the application's own files. There
					is nothing for an injected script to fetch and nowhere for it to send.
				</li>
				<li>
					<strong>Developer tools are disabled in release builds</strong>, together with
					the menu accelerator that opens them. "Open the console and paste this to fix
					your codes" is an attack that works on real people.
				</li>
				<li>
					<strong>Four runtime dependencies.</strong> Every package that ships is a
					package someone could compromise, so there are as close to none as the job
					allows.
				</li>
			</ul>

			<h2>Deliberate refusals</h2>
			<ul>
				<li>
					<strong>No self-updating.</strong> The application checks whether a newer
					version exists and links to it. It never downloads or executes one.
				</li>
				<li>
					<strong>Automatic confirmation is allowlisted, not configurable.</strong> It
					can act on market listings and trades. Account recovery confirmations are
					held back and reported to you, and no setting exists to widen the list.
				</li>
				<li>
					<strong>Revealing a revocation code requires the passphrase again</strong>,
					even with the vault already unlocked.
				</li>
				<li>
					<strong>Removing an account requires an explicit acknowledgement</strong>,
					because forgetting an account locally does not remove the authenticator from
					Steam, and the two get confused with expensive results.
				</li>
			</ul>

			<h2>What this cannot protect you from</h2>
			<div class="callout callout-warn">
				<p>
					Any page describing a security model without this section is selling
					something.
				</p>
			</div>
			<ul>
				<li>
					<strong>A compromised computer.</strong> Malware running as you, while the
					vault is unlocked, can read what the application can read. Full-disk
					encryption and a machine you control matter more than anything in this
					application.
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
					passphrase into a convincing copy of it. <a href="/verify">Verifying what you
					run</a> is the defence.
				</li>
			</ul>

			<h2>Reporting a vulnerability</h2>
			<p>
				If you have found a security problem, please report it privately rather than
				opening a public issue: use the <a href="/support">reporting form</a> and mark it
				as a security report. We will acknowledge it, and we will not argue about
				severity before fixing something that is obviously wrong.
			</p>
		</article>`
};
