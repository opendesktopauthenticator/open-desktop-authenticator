/**
 * The second batch of question-answering pages.
 *
 * Same selection rule as answers.mjs: distinct intents, each answerable better
 * here than by a content farm because the answer comes from having implemented
 * the thing. Chosen against live search results, not invented — each of these
 * queries currently resolves to listicles recycling each other or forum threads
 * from 2017, and none of the pages ranking for them has ever parsed a maFile or
 * corrected a clock against Steam's.
 *
 * The register is the site's usual one: honest, specific, and useful whether or
 * not the reader ever installs anything of ours. The product appears where it
 * genuinely belongs in the answer and nowhere else — a rescue page that turns
 * into an advert stops being trusted exactly when trust matters most.
 */

export const codeNotWorking = {
	slug: 'steam-guard-code-not-working',
	navTitle: 'Codes not working',
	title: 'Steam Guard code not working? Check the clock',
	updated: '2026-08-14',
	description:
		'Steam Guard codes are computed from the time, so a clock a minute off makes every code wrong. Fix time sync on Windows and phone, and what to check next.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Steam Guard code not working? Check the clock',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/steam-guard-code-not-working`
	}),
	body: (s) => `
		<article>
			<h1>Steam Guard code not working? Check the clock</h1>
			<p class="lede">
				When Steam refuses code after code, the cause is almost never the code. It is
				the clock on the device generating it. This page explains why, fixes it in
				about a minute, and then covers the rarer causes in the order worth checking.
			</p>

			<h2>Why the time breaks the code</h2>
			<p>
				A Steam Guard code is not random. It is computed from two ingredients: a
				secret your authenticator holds, and the current time, rounded to a
				thirty-second window. Steam runs the same computation on its side and checks
				that the answers match. If your device's clock is even a minute out, you are
				computing codes for a different window than the one Steam is checking — so
				every code you type is valid, just not <em>now</em>.
			</p>
			<p>
				Steam does not say any of this. It says the code is wrong, which sends people
				off reinstalling apps and resetting passwords when the fault is a drifted
				clock. The overwhelming majority of "my codes stopped working" is exactly
				this.
			</p>

			<h2>Fix it on Windows</h2>
			<ol>
				<li>Open <strong>Settings → Time &amp; language → Date &amp; time</strong>.</li>
				<li>Turn on <strong>Set time automatically</strong> and <strong>Set time zone
				automatically</strong>.</li>
				<li>Press <strong>Sync now</strong>. If it fails, check the connection and try
				again.</li>
			</ol>
			<p>
				The sneaky version is a wrong time <em>zone</em> with a right-looking local
				time: the clock on the wall reads correctly while the underlying UTC time —
				the one codes are computed from — is hours off.
			</p>

			<h2>Fix it on a phone</h2>
			<p>
				<strong>Android:</strong> Settings → System → Date &amp; time → automatic
				date, time and zone on. <strong>iPhone:</strong> Settings → General → Date
				&amp; Time → Set Automatically. Then close and reopen the Steam app so it
				notices the change.
			</p>

			<h2>Still refused? The rest, in order</h2>
			<dl class="defs">
				<dt>The code expired mid-typing</dt>
				<dd>
					Codes roll every thirty seconds. If one rolled while you typed it, the one
					you entered had just died. Wait for a fresh one and enter it promptly.
				</dd>
				<dt>Too many attempts</dt>
				<dd>
					After a run of failures Steam rate-limits the account for a while. Stop
					for fifteen minutes — continuing extends the wait.
				</dd>
				<dt>The authenticator was moved or re-added since</dt>
				<dd>
					Adding an authenticator on a new device replaces the old secret. Any copy
					of the old one — an old maFile, an old phone — keeps generating codes
					confidently, and every one of them is dead.
					<a href="/what-is-a-mafile">The secret in the file is the
					authenticator</a>: if Steam has been handed a new secret since the copy
					was made, the copy is a relic.
				</dd>
				<dt>Wrong account selected</dt>
				<dd>
					Codes are per account, and this catches everyone who runs more than one.
					Check the account name shown above the code.
				</dd>
			</dl>

			<h2>How this application sidesteps the whole problem</h2>
			<p>
				A desktop authenticator cannot assume the PC's clock is right — desktop
				clocks drift more than phones, which sync aggressively. So ${s.name} asks
				Steam's own servers what time it is and computes codes against
				<em>Steam's</em> clock, not the machine's. A drifted PC clock then stops
				mattering, because the code is computed in the window Steam is actually
				checking. That is not cleverness — it is doing the arithmetic with the right
				inputs, and it is worth asking of any authenticator you use.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/what-is-a-mafile">What is a maFile?</a></li>
				<li><a href="/lost-authenticator">Lost access to the authenticator entirely?</a></li>
				<li><a href="/steam-desktop-authenticator">Steam Desktop Authenticator, explained</a></li>
			</ul>
		</article>`
};

export const moveAuthenticator = {
	slug: 'move-steam-authenticator-new-phone',
	navTitle: 'New phone',
	title: 'Move your Steam authenticator to a new phone',
	updated: '2026-08-14',
	description:
		'Moving Steam Guard to a new phone: with the old phone, with just your number, or with the revocation code. What each path costs, and how to stop repeating this.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Move a Steam authenticator to a new phone',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Transfer while the old phone still works' },
			{ '@type': 'HowToStep', name: 'Transfer with the phone number alone' },
			{ '@type': 'HowToStep', name: 'Remove with the revocation code and re-add' },
			{ '@type': 'HowToStep', name: 'Ask Steam Support when nothing else is left' }
		]
	}),
	body: () => `
		<article>
			<h1>Move your Steam authenticator to a new phone</h1>
			<p class="lede">
				There are four ways to do this, and they cost very different amounts of time.
				Which one you can use depends on what you still have: the old phone, the
				phone number, or the revocation code. Start at the top and stop at the first
				that fits.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Every step here happens inside Steam's own app or on Steam's own
					site.</strong> No third-party tool can move a Steam authenticator for you,
					and anything offering to is collecting accounts.
				</p>
			</div>

			<h2>1. You still have the old phone</h2>
			<p>
				The clean path. Install the Steam Mobile app on the new phone and sign in.
				When it asks for a Steam Guard code, let the old phone answer one last time,
				then follow the prompts to move the authenticator across. The old phone's
				copy stops working the moment the new one takes over — that is expected, not
				a fault.
			</p>

			<h2>2. Old phone gone, number still yours</h2>
			<p>
				Sign in on the new phone and choose <strong>"Please help, I no longer have
				access to my Mobile Authenticator codes"</strong> on the code screen. Steam
				texts a confirmation to the number on the account. This works because the
				authenticator is tied to your account and number, not to the handset.
			</p>

			<h2>3. No phone and no number — the revocation code</h2>
			<p>
				The <a href="/steam-revocation-code">revocation code</a> — <code>R</code>
				followed by five digits, shown once at setup — removes the authenticator
				without needing any device at all. Remove it, then set up fresh on the new
				phone. Minutes, if you kept the code.
			</p>

			<h2>4. None of the above — Steam Support</h2>
			<p>
				A help request to remove the authenticator, with proof the account is yours:
				purchase history, the original email, payment details. It takes days by
				design — the delay is what stops a thief doing the same thing quickly.
				<a href="/lost-authenticator">The full recovery order is here</a>.
			</p>

			<h2>The catch nobody mentions until afterwards</h2>
			<p>
				Removing or transferring an authenticator puts a hold on trades and the
				Market for a period. That is Steam's protection against exactly this
				operation being performed by someone who is not you, and nothing legitimate
				shortens it. If you trade actively, time the move for a quiet week.
			</p>

			<h2>Tired of doing this every phone?</h2>
			<p>
				There is a second way to hold a Steam authenticator: in a file on a machine
				you control, rather than inside one phone. That is what
				<a href="/steam-desktop-authenticator">desktop authenticators</a> do — the
				secret lives in a <a href="/what-is-a-mafile">maFile</a> you can back up
				yourself, and a new phone stops being an event. It is a real trade-off rather
				than a free win: a file can be stolen in ways a phone cannot, which is why
				ours keeps it <a href="/security">encrypted and offline</a>. But if you are
				reading this page for the third handset in a row, it is the trade worth
				understanding.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-revocation-code">Your revocation code, explained</a></li>
				<li><a href="/lost-authenticator">Lost access entirely?</a></li>
				<li><a href="/steam-desktop-authenticator">What a desktop authenticator is</a></li>
			</ul>
		</article>`
};

export const revocationCode = {
	slug: 'steam-revocation-code',
	navTitle: 'Revocation code',
	title: 'Your Steam revocation code, explained',
	updated: '2026-08-14',
	description:
		'The R-code shown once when you added your Steam authenticator is the only self-service way to remove it later. Where it might still be, and how to keep the next one.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Your Steam revocation code, explained',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/steam-revocation-code`
	}),
	body: (s) => `
		<article>
			<h1>Your Steam revocation code, explained</h1>
			<p class="lede">
				It looks like <code>R12345</code>, it was shown exactly once when you set the
				authenticator up, and it is the difference between fixing a lost
				authenticator in five minutes and spending days proving your identity to
				Steam Support.
			</p>

			<h2>What it actually does</h2>
			<p>
				The revocation code detaches the authenticator from your account
				<em>without the device the authenticator is on</em>. Dead phone, wiped disk,
				stolen laptop — the code works from any browser, because it proves something
				you knew rather than something you hold. That is its entire purpose. It has
				no other power: it does not generate codes and it cannot approve anything.
			</p>

			<h2>Where yours might still be</h2>
			<p>
				If you never wrote it down, do not give up before looking. In rough order of
				likelihood:
			</p>
			<ul>
				<li>
					<strong>Inside the Steam app, right now.</strong> A still-working
					authenticator will show its code again: Steam Guard →
					<strong>My Authenticator</strong>, and the revocation code is on that
					screen. This is the one chance to recover it <em>before</em> the accident
					rather than after.
				</li>
				<li>
					<strong>Inside a maFile.</strong> If the authenticator was ever held by a
					desktop tool, the file carries a <code>revocation_code</code> field.
					<a href="/what-is-a-mafile">Any surviving copy</a> — an old machine, an
					old backup — carries it too.
				</li>
				<li>
					<strong>Screenshots and notes.</strong> The setup screen told you to save
					it, and plenty of people screenshotted it. Search your images and your
					password manager for anything starting with <code>R</code>.
				</li>
			</ul>

			<h2>Using it</h2>
			<p>
				Steam's help pages, under "I no longer have access to my Mobile
				Authenticator" — enter the code and the authenticator is removed; then set up
				a fresh one. Expect a temporary hold on trades and the Market afterwards.
				That is Steam's standard response whenever an authenticator changes hands,
				and nothing legitimate bypasses it.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Treat the code like a key, because it is one.</strong> Anyone
					holding it can strip Steam Guard from your account. Never paste it into a
					site that is not Steam's own, and <a href="/support">never into a support
					form</a> — including ours. Nobody legitimate asks for it.
				</p>
			</div>

			<h2>Keeping the next one</h2>
			<p>
				The failure pattern is always the same: the code appears at setup, the moment
				feels unimportant, and it is never seen again. Write it on paper, keep the
				paper somewhere the device is not, and check it is still readable when you
				think of it. A code stored only on the device it revokes is not a backup —
				losing the device loses both at once.
			</p>
			<p>
				This is also somewhere software can refuse to let you fail. When ${s.name}
				creates an authenticator it does not treat the account as active until the
				revocation code has been shown and you have confirmed it is written down —
				at the one moment the code exists and nothing is yet at risk. That ceremony
				exists because every horror story on
				<a href="/lost-authenticator">the lost-access page</a> begins with "I never
				wrote it down".
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/lost-authenticator">Lost access, in recovery order</a></li>
				<li><a href="/move-steam-authenticator-new-phone">Moving to a new phone</a></li>
				<li><a href="/what-is-a-mafile">What else a maFile holds</a></li>
			</ul>
		</article>`
};

export const encryptedMafile = {
	slug: 'encrypted-mafile',
	navTitle: 'Encrypted maFiles',
	title: 'Encrypted maFiles: the password, and the manifest',
	updated: '2026-08-14',
	description:
		'An encrypted SDA maFile needs the passphrase set in SDA plus the manifest.json beside it. Why copying the file alone fails, and what to do if the passphrase is gone.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Encrypted maFiles: the password, and the manifest',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/encrypted-mafile`
	}),
	body: (s) => `
		<article>
			<h1>Encrypted maFiles: the password, and the manifest</h1>
			<p class="lede">
				You have a <code>.maFile</code>, something is asking for a password, and
				nothing you type works. Two facts untangle nearly every case: which password
				it actually wants, and the second file it cannot work without.
			</p>

			<h2>Which password it wants</h2>
			<p>
				<strong>The encryption passphrase set inside SDA, on the machine that made
				the file.</strong> Not your Steam password, not your Windows password, not
				the email password. When SDA's encryption was switched on it asked for a
				passphrase of its own — that is the one. If somebody else set the machine up,
				it may be theirs rather than yours.
			</p>

			<h2>The file that has to travel with it</h2>
			<p>
				SDA does not keep everything needed for decryption inside the maFile itself.
				The salt and initialisation vector — parameters the passphrase is combined
				with — live in <code>manifest.json</code> in the same folder, keyed by
				account. The practical rule:
			</p>
			<div class="callout">
				<p>
					<strong>An encrypted maFile copied without <code>manifest.json</code>
					cannot be opened, even with the correct passphrase.</strong> Copy the
					whole <code>maFiles</code> folder, never the one file.
				</p>
			</div>
			<p>
				This is the most common way people lock themselves out while believing they
				made a backup: the <code>.maFile</code> went to the USB stick, the manifest
				stayed behind, and the machine was wiped.
			</p>

			<h2>Why the error messages are useless</h2>
			<p>
				SDA encrypts with AES-CBC, which has no built-in way to tell a wrong
				passphrase from a right one — a wrong key produces garbage rather than an
				error, and tools differ in how confusingly they surface that.
				<a href="/import-from-sda">${s.short}'s importer</a> checks whether the
				decrypted result actually parses as a maFile and says plainly that the
				passphrase did not open the file — but no tool can tell you what the right
				passphrase <em>is</em>. The mathematics does not know.
			</p>

			<h2>If the passphrase is genuinely gone</h2>
			<p>
				Then the file's contents are unreachable. That is what encryption is for, and
				anything claiming to crack it is either lying or describing a brute-force run
				that only works on short passphrases. The account itself is not lost, though.
				In order:
			</p>
			<ol>
				<li>
					<strong>Look for an unencrypted copy.</strong> SDA's encryption was off by
					default, so an older backup of the folder may be plain JSON.
					<a href="/what-is-a-mafile">Open one in a text editor</a> — readable field
					names mean unencrypted.
				</li>
				<li>
					<strong>Any still-working authenticator</strong> — the Steam app on a
					phone, SDA on another machine — can show the
					<a href="/steam-revocation-code">revocation code</a>, which removes and
					re-adds the authenticator cleanly.
				</li>
				<li>
					<strong>Neither?</strong> <a href="/lost-authenticator">The lost-access
					page</a> — from here it is the revocation code you hopefully wrote down,
					or Steam Support.
				</li>
			</ol>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/what-is-a-mafile">What a maFile is, field by field</a></li>
				<li><a href="/import-from-sda">Importing maFiles — encrypted ones included</a></li>
				<li><a href="/lost-authenticator">When the authenticator is simply gone</a></li>
			</ul>
		</article>`
};
