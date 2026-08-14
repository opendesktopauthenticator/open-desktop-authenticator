import { reviewAsk } from '../markup.mjs';

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
	body: (s) => `
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

			<h2>&ldquo;My items are trade-locked, so I am safe&rdquo;</h2>
			<div class="callout callout-warn">
				<p>
					<strong>This is the assumption that costs people the most</strong>, and it is
					wrong. A trade hold stops items being <em>traded</em> away. It does not stop
					them being <em>sold</em>.
				</p>
			</div>
			<p>
				When an attacker finds half an inventory under a trade hold, they do not wait it
				out. They use the Community Market instead, and the sequence is always the same:
			</p>
			<ol class="signs">
				<li>
					<strong>Everything is listed on the Community Market and sold.</strong> Market
					sales are not blocked by the trade holds that were protecting those items,
					and the proceeds land in the account's Steam Wallet.
				</li>
				<li>
					<strong>The wallet balance is spent on the attacker's own listings.</strong>
					They have already listed near-worthless items at enormous prices. Your balance
					buys them. The money moves to an account they control, and what you are left
					holding is a handful of items genuinely worth a few cents.
				</li>
				<li>
					<strong>Nothing can be reversed.</strong> Steam Wallet funds cannot be
					withdrawn to a bank, and market purchases are not refundable. By the time the
					emails arrive, the value has already left.
				</li>
			</ol>
			<p>
				It is worth being precise about what this means: <strong>the trade hold never
				failed.</strong> It did exactly what it was designed to do, and the attacker
				simply used a route it was never meant to cover. Anyone reassuring themselves
				that a locked inventory makes a compromised authenticator survivable is
				protecting against the wrong thing.
			</p>
			<p>
				It also explains the timing. These thefts tend to arrive a couple of weeks after
				the download rather than the same evening — long enough that nobody connects the
				two, and long enough for a trade hold to look like it held.
			</p>

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
				<li><a href="/steam-inventory-stolen">What this looked like when it happened to us</a></li>
				<li><a href="/verify">How to verify a download</a></li>
				<li><a href="/steam-desktop-authenticator">What SDA and maFiles are</a></li>
				<li><a href="/support">Report a suspected clone site</a></li>
			</ul>

${reviewAsk(s, { got: 'Did this help you spot a fake before you ran it?' })}
		</article>`
};

export const verify = {
	slug: 'verify',
	updated: '2026-08-14',
	navTitle: 'Verify',
	title: 'How to verify a download is genuine',
	description:
		'Check a download against its published SHA-256 checksum on Windows and Linux, and confirm where the bytes came from. Commands you can copy.',
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
			{ '@type': 'HowToStep', name: 'Check the build provenance attestation' }
		]
	}),
	body: (s) => `
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

			<h2>First: which copy do you have?</h2>
			<p>
				There will be two ways to get this application, and they are verified
				differently. Checking the wrong thing for your copy produces a scary-looking
				result that means nothing, so start here.
			</p>
			<dl class="pairs">
				<dt>From the Microsoft Store</dt>
				<dd>
					Windows verified the package before it installed anything, and it will keep
					doing so on every update. <strong>There is nothing for you to check by
					hand.</strong> The signature on a Store package is Microsoft's, not ours —
					so if you inspect it you will see Microsoft named as the signer, and that is
					correct rather than suspicious.
				</dd>
				<dt>From the GitHub release page</dt>
				<dd>
					Nothing has checked this file for you. The steps below are the whole of the
					verification, and they are worth the minute they take.
				</dd>
			</dl>
			<p>
				Anywhere else is neither of those. No download of this application is genuine
				unless it came from the Store or from the release page linked on
				<a href="/download">our download page</a> — see
				<a href="/scam-clones">what a counterfeit build does</a>.
			</p>

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

			<h2>4. Check where the bytes came from</h2>
			<p>
				A checksum proves the file was not corrupted on the way to you. It does not
				prove who produced it — anyone who can replace the download can also replace the
				list of hashes sitting next to it. What closes that gap is a statement, made by
				something other than us, about which build produced these bytes.
			</p>
			<p>
				Every release is built by a public workflow on GitHub's runners, from a tag
				anyone can read, and GitHub signs a record of that. You can check it:
			</p>
			<pre><code>gh attestation verify &lt;file&gt; --owner ${s.githubOrg}</code></pre>
			<p>
				A pass tells you the file was produced by this project's release workflow, from
				a specific commit, and not assembled on somebody's laptop. That is a stronger
				statement than a signature alone, because it names the source the binary came
				from rather than only the person who signed it. It needs the
				<a href="https://cli.github.com/" rel="noopener">GitHub CLI</a>, which is the
				only tool here you may not already have.
			</p>

			<h2>5. On Windows, check the publisher</h2>
			<pre><code>Get-AuthenticodeSignature .\\&lt;file&gt;.exe | Format-List Status, SignerCertificate</code></pre>
			<p>
				What you should see depends on where the file came from, and right now the
				honest answer for direct downloads is uncomfortable:
			</p>
			<dl class="pairs">
				<dt>A Store install</dt>
				<dd>
					Signed, and the signer is Microsoft. Windows checked it before installing.
				</dd>
				<dt>A download from the release page, today</dt>
				<dd>
					<strong><code>Status</code> will read <code>NotSigned</code>.</strong> These
					builds carry no code-signing certificate yet, so Windows will also warn on
					first run. That is expected and it is stated here rather than left for you
					to discover — but it does mean this step cannot tell you anything for now,
					and steps 3 and 4 are doing all the work. When signing exists, the signer
					will be ${s.publisher} and anything else is not ours.
				</dd>
			</dl>
			<p>
				A build signed by a name you do not recognise is the one result that should stop
				you outright. "Unsigned" is a gap in what we have published so far; "signed by
				someone else" means the file is not from us at all.
			</p>

			<h2>Going further: build it yourself</h2>
			<p>
				The strongest check available is not to trust our binary at all: clone the tag,
				build it yourself, and run only what you compiled. The source is public, so that
				is possible today.
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
	updated: '2026-08-14',
	navTitle: 'Security',
	title: 'Security model: how your Steam secrets are stored',
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

			<h2>The honest caveat about automatic confirmation</h2>
			<p>
				Automatic confirmation can act on market listings. That is the same route
				<a href="/scam-clones">a compromised account is emptied through</a> — everything
				listed on the Community Market, the balance spent on the attacker's own
				listings — and it would be dishonest to describe the feature without saying so.
			</p>
			<p>
				The distinction is where the listing comes from. This application only ever
				confirms what Steam is already asking about; it cannot raise a listing itself.
				But if something else with access to your account can raise one — a stolen
				session, a leaked Web API key, a trading bot you have authorised — then leaving
				automatic confirmation on for market listings means this application will
				approve it without showing you.
			</p>
			<p>
				So: it is off unless you turn it on, it is set per account rather than globally,
				and it is worth turning on only for accounts where the convenience is worth that
				trade. If you are not listing in volume, leave it off and confirm by hand. The
				<a href="/docs">Activity screen</a> records everything it did either way.
			</p>

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
				Privately, please, rather than as a public issue. Two routes, both live:
				<a href="${'https://github.com/opendesktopauthenticator/open-desktop-authenticator/security/advisories/new'}" rel="noopener">GitHub
				private vulnerability reporting</a>, which is preferred, or email — the address
				is in <a href="/.well-known/security.txt">security.txt</a> rather than on this
				page, so that it is somewhere a researcher looks first and a scraper does
				not.
				<a href="/support#security-reports">What we commit to</a> is written down:
				acknowledgement in 72 hours, an assessment in 7 days, a fix or a dated plan in
				30 for a confirmed high or critical.
			</p>
		</article>`
};
