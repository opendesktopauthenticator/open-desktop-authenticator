export default {
	slug: 'steam-desktop-authenticator',
	updated: '2026-08-14',
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
		// The head carried a modified time and the Article object did not, so the
		// two disagreed about whether this page had ever been revised.
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/steam-desktop-authenticator`
	}),
	body: (s) => `
		<article>
			<h1>Steam Desktop Authenticator: what it is, and how to use it safely</h1>

			<p class="lede">
				Steam Desktop Authenticator — almost always shortened to SDA — is a Windows
				program that moves Steam Guard off your phone and onto your computer. This page
				explains what it does, what it stores, why the search results for it are
				dangerous, and what your options are. It is not a download page for SDA, and we
				are not its authors.
			</p>

			<!--
				This page ranks for the query that gets people robbed, so the official
				repository belongs above the fold rather than in a paragraph two
				screens down. Somebody who reads one sentence and leaves should still
				leave with the right link.
			-->
			<div class="callout callout-warn">
				<h2>Before anything else: SDA is no longer maintained</h2>
				<p>
					Its own README states that it is ${s.sda.notice}, and
					${s.sda.authorsAdvice}. That is the project's own assessment of its own
					software, and it matters more than any opinion on this page.
					<strong>Steam's official mobile authenticator is the right answer for most
					people</strong>, and this page will not pretend otherwise.
				</p>
				<p>
					The rest of this page explains what SDA is, what it stores and why searching
					for it is dangerous — because many people still run it, still
					search for it, and are still handed counterfeits when they do. We have no
					usage figures for somebody else's software and will not invent any.
				</p>
			</div>

			<div class="origin-note">
				<p>
					<strong>If you are going to use it regardless, the only real home is
					<a href="${s.sda.repo}" rel="noopener">github.com/${s.sda.author}/SteamDesktopAuthenticator</a>.</strong>
					Everything else calling itself SDA — a lookalike domain, a "mirror", an
					installer from a forum post, a sponsored search result — is somebody else's
					software with somebody else's motives.
				</p>
				<a class="button button-quiet" href="${s.sda.repo}" rel="noopener">The real repository →</a>
			</div>

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
					to each other. Anyone holding this secret can generate your login
					codes for as long as that authenticator stays on the account — it does not
					expire on its own, and only removing or replacing it stops them.
				</dd>
				<dt><code>identity_secret</code></dt>
				<dd>
					The seed used to sign trade and market confirmations. This is the one that
					approves a trade. Someone with your identity secret and a session can accept
					trades on your behalf.
				</dd>
				<dt>The revocation code</dt>
				<dd>
					A short code in the form <code>R12345</code>, which Valve now calls your
					<a href="/steam-revocation-code">recovery code</a>. It is shown during setup
					and can be retrieved again while the authenticator is still accessible. It is how
					you detach the authenticator if you lose the device. If you do not have it
					and you lose your authenticator, recovering the account means going through
					Steam Support and proving ownership.
				</dd>
			</dl>

			<h2>What a maFile is</h2>
			<p>
				SDA stores each account in a file named after the SteamID with a
				<code>.maFile</code> extension. It is JSON, and a typical one carries the
				authenticator secrets and account metadata above, and may also hold session
				data that has not expired. In other words: <strong>a maFile is the
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
					<strong>The practical consequence:</strong> treat a maFile as at least as
					sensitive as the password and the second factor combined, because that is
					what it is. A password can be changed in a minute. A shared secret somebody
					else has copied keeps working until you detach the authenticator entirely.
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
					<strong>Get it from the project's own repository, and nowhere else:</strong>
					<a href="${s.sda.repo}" rel="noopener">github.com/${s.sda.author}/SteamDesktopAuthenticator</a>.
					SDA is released there by ${s.sda.author}. Any other site offering a
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
					<strong>Compare a checksum only against one published separately</strong> —
					never one printed beside the download by whoever served it, which proves
					nothing about a file that same person could have replaced.
					<a href="/verify">The exact commands are here</a>, and they work for any
					project.
					<span class="hint">
						Worth knowing before you go looking: SDA's own release does not publish a
						checksum for its zip. That is not a sign of a fake — it is simply not
						offered, so for SDA the address is the check that matters, and the only
						address is the ${s.sda.author} repository linked above.
					</span>
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
				however, is generic enough that a great many other sites rank for it, and some
				of them distribute unofficial or modified builds. The pattern is
				consistent and worth recognising:
			</p>
			<ol>
				<li>A site that looks like a product page, often with a stolen screenshot.</li>
				<li>
					A file served directly by an unrelated website, rather than a link to the
					official ${s.sda.author} release page. SDA itself ships as a zip, so the
					archive is not the warning sign — who is handing it to you is.
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
						source, builds produced in public CI, and no self-updating. Published
						published checksums shipped with 1.0, and a signature over that list does not exist yet;
						reproducible builds are a later goal and are not claimed yet —
						<a href="/download">the download page tracks where each one stands</a>.
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
				<li><a href="/steam-guard-code-not-working">If SDA's codes are being refused</a></li>
				<li><a href="/encrypted-mafile">Encrypted maFiles and the manifest</a></li>
				<li><a href="/alternatives">How the options compare</a></li>
				<li><a href="/lost-authenticator">If you have already lost access</a></li>
				<li><a href="/verify">Verifying that a download is genuine</a></li>
				<li><a href="/import-from-sda">Moving maFiles into this application</a></li>
				<li><a href="/security">What this application does with your secrets</a></li>
			</ul>
		</article>`
};
