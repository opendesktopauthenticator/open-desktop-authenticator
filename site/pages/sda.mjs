export default {
	slug: 'steam-desktop-authenticator',
	navTitle: 'About SDA',
	title: 'Steam Desktop Authenticator (SDA), explained',
	description:
		'What SDA is, what a maFile actually contains, why searching for it is risky, and how to keep Steam Guard on your PC without losing the account.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: 'Steam Desktop Authenticator: what it is, and how to use it safely',
		description:
			'An explanation of Steam Desktop Authenticator, maFiles, and the risks of downloading it from search results.',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/steam-desktop-authenticator`
	}),
	body: () => `
		<article>
			<h1>Steam Desktop Authenticator: what it is, and how to use it safely</h1>

			<p class="lede">
				Steam Desktop Authenticator — almost always shortened to SDA — is a Windows
				program that moves Steam Guard off your phone and onto your computer. This page
				explains what it does, what it stores, why the search results for it are
				dangerous, and what your options are. It is not a download page for SDA, and we
				are not its authors.
			</p>

			<h2>What Steam Guard actually is</h2>
			<p>
				When you enable Steam Guard Mobile Authenticator, Steam gives your device two
				long-lived secrets and keeps a copy:
			</p>
			<dl class="defs">
				<dt><code>shared_secret</code></dt>
				<dd>
					The seed for the five-character login codes. It is a time-based one-time
					password: your device and Steam both hash the secret together with the
					current thirty-second window, and get the same answer without ever talking
					to each other. Anyone holding this secret can generate your login codes
					forever.
				</dd>
				<dt><code>identity_secret</code></dt>
				<dd>
					The seed used to sign trade and market confirmations. This is the one that
					approves a trade. Someone with your identity secret and a session can accept
					trades on your behalf.
				</dd>
				<dt>The revocation code</dt>
				<dd>
					A short code, usually shown once, in the form <code>R12345</code>. It is how
					you detach the authenticator if you lose the device. If you do not have it
					and you lose your authenticator, recovering the account means Steam Support
					and a wait measured in days.
				</dd>
			</dl>

			<h2>What a maFile is</h2>
			<p>
				SDA stores each account in a file named after the SteamID with a
				<code>.maFile</code> extension. It is JSON, and it contains all three of the
				items above plus the session tokens. In other words: <strong>a maFile is the
				account's second factor, in a file, on disk.</strong>
			</p>
			<p>
				SDA can encrypt maFiles with a passphrase. When it does, the file contents are
				base64 ciphertext and the salt and initialisation vector live beside it in
				<code>manifest.json</code> — which is why an encrypted maFile cannot be
				decrypted without that manifest, and why copying only the <code>.maFile</code>
				to a new machine leaves you with something you cannot open.
			</p>
			<div class="callout">
				<p>
					<strong>The practical consequence:</strong> treat a maFile exactly as you
					would treat the password to the account, because it is worth more. A
					password can be changed. A shared secret that someone else has copied works
					until you detach the authenticator entirely.
				</p>
			</div>

			<h2>Why people use a desktop authenticator at all</h2>
			<p>
				Steam's own mobile app is the intended route, and for most people it is the
				right one. Traders reach for a desktop tool for reasons that are practical
				rather than exotic:
			</p>
			<ul>
				<li>
					Confirming twenty market listings on a phone means twenty taps on a phone.
					On a desktop it is a list and one button.
				</li>
				<li>
					A code you can copy is faster and less error-prone than a code you read off
					a phone screen and retype.
				</li>
				<li>
					Accounts outlive phones. People who have lost an authenticator to a broken
					handset tend to want the secret somewhere they control.
				</li>
			</ul>
			<p>
				All of that is legitimate. The risk is not in wanting a desktop authenticator.
				The risk is in how you get one.
			</p>

			<h2>Looking for the Steam Desktop Authenticator download?</h2>
			<div class="callout callout-warn">
				<p>
					<strong>Get it from the project's own repository, and nowhere else.</strong>
					SDA is released on GitHub by its authors. Any other site offering a
					&ldquo;Steam Desktop Authenticator download&rdquo; — an installer, a zip, a
					mirror, a &ldquo;fixed&rdquo; or &ldquo;updated&rdquo; build — is not the
					project, whatever the page looks like.
				</p>
			</div>
			<p>
				If you take one thing from this page, take the two minutes to check what you
				downloaded before you open a <code>.maFile</code> with it:
			</p>
			<ol class="signs">
				<li>
					<strong>Confirm the address.</strong> Releases live on the same repository as
					the source. A download page that has no source attached to it has nothing
					tying the file to the project.
				</li>
				<li>
					<strong>Compare the checksum</strong> against the one published on the release
					page — not one printed beside the download by whoever served it.
					<a href="/verify">The exact commands are here</a>, and they work for any
					project, not just ours.
				</li>
				<li>
					<strong>Never enter a maFile, password or API key into a web page</strong>
					offering to check, repair or convert it.
				</li>
			</ol>
			<p>
				We publish <a href="/">an independent alternative</a> and would rather you used
				it, but not at the cost of being unclear here: <strong>using SDA safely is
				better than using anything unsafely.</strong> If SDA is what you want, get it
				from its own releases and verify it.
			</p>

			<h2>Why searching for "steam desktop authenticator download" is the dangerous part</h2>
			<p>
				SDA is distributed as source and as releases on its project page. The name,
				however, is generic enough that a great many other sites rank for it, and a
				meaningful share of them exist to hand you a modified build. The pattern is
				consistent and worth recognising:
			</p>
			<ol>
				<li>A site that looks like a product page, often with a stolen screenshot.</li>
				<li>
					A download that is an installer or a zip rather than a link to a release
					page with checksums.
				</li>
				<li>
					A build that works. It really does generate codes — that is the point,
					because a tool that failed would be uninstalled. It also copies your maFile
					out.
				</li>
				<li>
					Nothing happens for weeks. Then the inventory is gone during a window when
					you were not looking.
				</li>
			</ol>
			<p>
				<a href="/scam-clones">We have written up the specific patterns and what to check
				for</a>, because the single most useful thing this project can do for somebody
				is make them harder to rob, whether or not they ever use our software.
			</p>

			<h2>Your options, honestly</h2>
			<div class="grid">
				<section>
					<h3>Steam's mobile app</h3>
					<p>
						Official, maintained by Valve, and the safest default. If you are not
						trading in volume and you are not sure what a maFile is, this is the
						answer and you can stop reading.
					</p>
				</section>
				<section>
					<h3>SDA itself</h3>
					<p>
						A real project with real users. If you use it, get it from its own source
						repository and its own releases — never from a search advertisement, a
						YouTube description, or a Discord message.
					</p>
				</section>
				<section>
					<h3>This project</h3>
					<p>
						An independent, open-source alternative, written to be checkable: public
						source, reproducible builds, published checksums, and no self-updating.
						<a href="/download">Not yet released</a>.
					</p>
				</section>
			</div>

			<h2>How this project relates to SDA</h2>
			<p>
				It does not share code with SDA and is not endorsed by its authors. It is a
				separate implementation of the same idea, built in the open, and it reads the
				same <code>.maFile</code> format so that nobody is trapped by their choice of
				tool. If you decide to leave, the application
				<a href="/import-from-sda">exports your accounts back out in the same
				format</a>. A security tool that holds your secrets hostage is not a security
				tool.
			</p>

			<h2>Related reading</h2>
			<ul class="plain next">
				<li><a href="/scam-clones">How the fake SDA sites work</a></li>
				<li><a href="/what-is-a-mafile">What is inside a maFile</a></li>
				<li><a href="/alternatives">How the options compare</a></li>
				<li><a href="/lost-authenticator">If you have already lost access</a></li>
				<li><a href="/verify">Verifying that a download is genuine</a></li>
				<li><a href="/import-from-sda">Moving maFiles into this application</a></li>
				<li><a href="/security">What this application does with your secrets</a></li>
			</ul>
		</article>`
};
