/**
 * The second batch of question-answering pages.
 *
 * Same selection rule as answers.mjs: distinct intents, each answerable better
 * here than by a content farm because the answer comes from having implemented
 * the thing.
 *
 * **Every durational and procedural claim here is cited to Valve.** The first
 * draft of these pages asserted a fifteen-minute rate limit, described a "My
 * Authenticator" screen that no longer exists under that name, and hid the
 * difference between a two-day and a fifteen-day restriction behind the phrase
 * "a period". None of that was checked; it was written in the confident
 * register of the rest of the site, which is exactly what makes it dangerous —
 * a reader following a recovery procedure has no way to tell a verified
 * instruction from a plausible one. Where Valve states a number, it is quoted
 * and linked. Where Valve does not, this says so instead of guessing.
 */

/** Valve's own pages, cited wherever this makes a claim about Steam's behaviour. */
const VALVE = {
	guard: 'https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31',
	restrictions: 'https://help.steampowered.com/en/faqs/view/451E-96B3-D194-50FC'
};

export const codeNotWorking = {
	slug: 'steam-guard-code-not-working',
	navTitle: 'Codes not working',
	title: 'Steam Guard code not working? Check the clock',
	updated: '2026-08-14',
	description:
		'Steam Guard codes come from the clock, so a device set wrong makes every code wrong. How to fix time sync on Windows and phone, and what to check next.',
	/*
	 * TechArticle *and* FAQPage, in one graph.
	 *
	 * **This earns no Google rich result, and the comment that used to sit here
	 * claimed it did.** Google restricted FAQ rich results to health and
	 * government sites in 2023 and deprecated them outright in May 2026, so the
	 * "people also ask eligibility" this was added for does not exist. Written
	 * down rather than quietly corrected, because the mistake is instructive: the
	 * markup was added on a recalled fact that was two years stale.
	 *
	 * It stays because FAQPage remains valid Schema.org, unused structured data
	 * is harmless, and non-Google consumers — other engines, assistants, anything
	 * reading the graph — can still use it. Every answer declared here is visible
	 * on the page, which was the right discipline regardless of who reads it.
	 */
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'TechArticle',
				headline: 'Steam Guard code not working? Check the clock',
				author: { '@type': 'Organization', name: s.publisher },
				publisher: { '@type': 'Organization', name: s.publisher },
				dateModified: '2026-08-14',
				mainEntityOfPage: `${s.origin}/steam-guard-code-not-working`
			},
			{
				'@type': 'FAQPage',
				mainEntity: [
					{
						'@type': 'Question',
						name: 'Why is Steam saying my Steam Guard code is wrong?',
						acceptedAnswer: {
							'@type': 'Answer',
							text: 'Codes are computed from the current time in thirty-second windows. If the clock on the device generating them is off, you are computing codes for a different window than the one Steam is checking, so every code is refused. Valve lists incorrect device time as the first thing to check.'
						}
					},
					{
						'@type': 'Question',
						name: 'How do I fix the time so Steam Guard codes work?',
						acceptedAnswer: {
							'@type': 'Answer',
							text: 'On Windows, open Settings, Time and language, Date and time, then turn on Set time automatically and Set time zone automatically and press Sync now. On Android or iPhone, enable automatic date, time and time zone, then reopen the Steam app.'
						}
					},
					{
						'@type': 'Question',
						name: 'My clock is correct and codes are still refused. What else?',
						acceptedAnswer: {
							'@type': 'Answer',
							text: 'Check you are entering the code for the correct account, that the code did not roll over while you were typing, and whether the authenticator was moved or re-added since the copy you are using was made. An account can only be on one authenticator at a time, so an older copy of the secret produces codes that are permanently dead.'
						}
					}
				]
			}
		]
	}),
	body: (s) => `
		<article>
			<h1>Steam Guard code not working? Check the clock</h1>
			<p class="lede">
				When Steam refuses code after code, the first thing to check is not the code.
				It is the clock on the device generating it — the cause Valve itself lists
				first. This page explains why, fixes it in about a minute, then covers the
				other causes in the order worth working through.
			</p>

			<h2>Why the time breaks the code</h2>
			<p>
				A Steam Guard code is not random. It is computed from two ingredients: a
				secret your authenticator holds, and the current time, rounded to a
				thirty-second window. Steam runs the same computation on its side and checks
				that the answers match. If your device's clock is out, you are computing codes
				for a different window than the one Steam is checking — so every code you type
				is valid, just not <em>now</em>.
			</p>
			<p>
				Valve's own troubleshooting says exactly this:
				<a href="${VALVE.guard}" rel="noopener">"check the time on your phone and make
				sure it is accurate. The authenticator codes are generated using the phone's
				time, and if the time is off, the codes will be incorrect."</a> The same
				arithmetic applies to any device generating codes, including a PC.
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
				<dt>The wrong account</dt>
				<dd>
					Valve's second listed cause, and it catches everyone running more than one
					account: <a href="${VALVE.guard}" rel="noopener">"make sure you are entering
					codes for the correct account."</a> Check the account name shown above the
					code.
				</dd>
				<dt>The code expired mid-typing</dt>
				<dd>
					Codes roll every thirty seconds. If one rolled while you typed it, the code
					you entered had just died. Wait for a fresh one and enter it promptly.
				</dd>
				<dt>Too many attempts</dt>
				<dd>
					After a run of failures Steam will stop accepting attempts for a while.
					Valve does not publish how long, so the only sound advice is to stop
					retrying and come back later rather than to guess at a number.
				</dd>
				<dt>The authenticator was moved or re-added since</dt>
				<dd>
					Adding an authenticator on a new device replaces the old secret, and
					<a href="${VALVE.guard}" rel="noopener">an account can only be on one
					authenticator at a time</a>. Any copy of the previous secret — an old
					maFile, an old phone — keeps generating codes confidently, and every one of
					them is dead. <a href="/what-is-a-mafile">The secret in the file is the
					authenticator</a>: if Steam has been handed a new one since that copy was
					made, the copy is a relic.
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
		'Transferring Steam Guard costs a 2-day trade restriction; removing and re-adding costs 15. The difference, and the current steps for each path.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Move a Steam authenticator to a new phone',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Install Steam Mobile on the new phone and sign in' },
			{ '@type': 'HowToStep', name: 'Choose Move Authenticator on the Steam Guard page' },
			{ '@type': 'HowToStep', name: 'Or confirm by SMS if the old authenticator is gone' },
			{ '@type': 'HowToStep', name: 'Use the recovery code or Steam Support as a last resort' }
		]
	}),
	body: () => `
		<article>
			<h1>Move your Steam authenticator to a new phone</h1>
			<p class="lede">
				There is a right way and an expensive way to do this, and the difference is
				thirteen days of not being able to trade. Transferring costs a two-day
				restriction. Removing the authenticator and adding a new one costs fifteen.
				Most people reach for the second without realising the first exists.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Use only Steam's mobile app or Steam's own help site.</strong> The
					supported transfer happens in the app; the fallbacks below run on Steam's
					website. No third-party service is needed for any of them — so never give
					your password, an SMS code or your recovery code to something claiming it
					has to perform the transfer for you.
				</p>
			</div>

			<h2>What each path costs</h2>
			<table class="grid">
				<thead>
					<tr><th>What you do</th><th>Restriction</th></tr>
				</thead>
				<tbody>
					<tr>
						<td><strong>Transfer</strong> to the new phone (Move Authenticator)</td>
						<td>2-day trade and Market restriction</td>
					</tr>
					<tr>
						<td><strong>Remove</strong> the authenticator, then add it again</td>
						<td>15 days, unable to trade or use the Market</td>
					</tr>
					<tr>
						<td>Trades created in the first <strong>7 days</strong> after adding one</td>
						<td>up to a 15-day hold on those trades</td>
					</tr>
				</tbody>
			</table>
			<p class="hint">
				Durations quoted from Valve's
				<a href="${VALVE.guard}" rel="noopener">Steam Guard Mobile Authenticator FAQ</a>
				and <a href="${VALVE.restrictions}" rel="noopener">Trading and Market
				Restrictions</a>. Steam Support cannot lift any of them, and nothing legitimate
				shortens them.
			</p>

			<h2>1. You still have the old authenticator — transfer it</h2>
			<p>
				This is the two-day path, and the one to use if you possibly can. Install the
				Steam Mobile app on the new phone and sign in. Then on the new device, open
				the <strong>Steam Guard</strong> page and choose
				<strong>Move Authenticator</strong>. Confirm on the old device when asked.
			</p>

			<h2>2. Old phone gone, number still yours</h2>
			<p>
				Sign in on the new phone. When asked to confirm the sign-in, choose
				<strong>"I no longer have access to my authenticator"</strong> and follow the
				steps — Steam texts a code to the number on the account. This is still a
				transfer, so it is still the two-day restriction rather than fifteen.
			</p>

			<h2>3. No phone and no number — the recovery code</h2>
			<p>
				The <a href="/steam-revocation-code">recovery code</a> removes the
				authenticator without needing the old device. You use it through Steam's
				browser-based recovery process, after signing in or otherwise proving the
				account is yours — the code is one half of that, not the whole of it. This is
				the fifteen-day path, because removing an authenticator is what it is, but it
				works when nothing else will.
			</p>

			<h2>4. None of the above — Steam Support</h2>
			<p>
				A help request to remove the authenticator, with proof the account is yours:
				purchase history, the original email, payment details. It takes days by
				design — the delay is what stops a thief doing the same thing quickly.
				<a href="/lost-authenticator">The full recovery order is here</a>.
			</p>

			<h2>Planning ahead</h2>
			<p>
				If you know a new phone is coming and you are <em>keeping the number</em>,
				there is nothing to do in advance — transfer it once the phone arrives. If you
				are <em>losing the number too</em>, deal with it before the old phone stops
				working, while the cheap path is still open to you.
			</p>

			<h2>Tired of doing this every phone?</h2>
			<p>
				There is a second way to hold a Steam authenticator: in a file on a machine
				you control, rather than inside one phone. That is what
				<a href="/steam-desktop-authenticator">desktop authenticators</a> do — the
				secret lives in a <a href="/what-is-a-mafile">maFile</a> you can back up
				yourself. It is a real trade-off rather than a free win: a file can be stolen
				in ways a phone cannot, which is why ours keeps it
				<a href="/security">encrypted and offline</a>. Steam allows only one
				authenticator on an account at a time, so this is a move rather than an
				addition — <a href="/steam-mobile-vs-desktop-authenticator">the comparison is
				here</a>.
			</p>
			<div class="callout callout-warn">
				<p>
					<strong>Budget for fifteen days, not two, when a desktop tool is
					involved.</strong> The two-day restriction is documented for Steam's own
					<em>Move Authenticator</em> flow between devices running Steam's app.
					Moving to or from an unofficial desktop authenticator may instead require
					removing the authenticator and enrolling again, which is the fifteen-day
					path. Assume the longer one unless you have tested the specific route.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-revocation-code">Your recovery code, explained</a></li>
				<li><a href="/lost-authenticator">Lost access entirely?</a></li>
				<li><a href="/steam-guard-code-not-working">Codes being refused after a move?</a></li>
			</ul>
		</article>`
};

export const revocationCode = {
	slug: 'steam-revocation-code',
	navTitle: 'Recovery code',
	title: 'Steam recovery code: what the R-code does',
	updated: '2026-08-14',
	description:
		'The R-code Valve calls your recovery code removes a Steam authenticator when the device is gone — and it is still retrievable while the app works.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Steam recovery code: what the R-code does',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/steam-revocation-code`
	}),
	body: (s) => `
		<article>
			<h1>Steam recovery code: what the R-code does</h1>
			<p class="lede">
				It looks like <code>R12345</code>. Valve calls it your <strong>recovery
				code</strong>; SDA and every maFile call the same thing
				<code>revocation_code</code>. It is the difference between fixing a lost
				authenticator in five minutes and spending days proving your identity to
				Steam Support.
			</p>

			<h2>What it actually does</h2>
			<p>
				The recovery code detaches the authenticator from your account
				<em>without the device the authenticator is on</em>. Dead phone, wiped disk,
				stolen laptop — it proves something you knew rather than something you hold,
				which is why it survives losing the hardware.
			</p>
			<p>
				It is not a master key on its own, and it is worth being exact about that.
				Removal happens <strong>inside an authenticated Steam session</strong> — you
				go through Steam's recovery pages as the account owner and supply the code
				there. Steam's own API works the same way: the removal call takes an access
				token <em>and</em> the code. So the code is one of two things a removal needs,
				not the whole of it. It also has no other power: it does not generate codes
				and it cannot approve a trade.
			</p>

			<h2>Where to find yours</h2>
			<p>
				It is shown once when the authenticator is created, and most people never
				look at it again — but <strong>it is not gone if you still have a working
				authenticator</strong>. Valve's answer to "I didn't save my recovery code" is
				direct:
			</p>
			<div class="callout">
				<p>
					<a href="${VALVE.guard}" rel="noopener">"In Steam Mobile App, go to the Steam
					Guard page, tap the gear icon, then tap <strong>Recovery Code</strong>."</a>
				</p>
			</div>
			<p>
				So the honest framing is: it is displayed once <em>unprompted</em>, and
				available on demand for as long as the authenticator still works. The moment
				it becomes unrecoverable is the moment you lose access — which is precisely
				when you need it. Look it up now rather than later.
			</p>
			<p>Other places a copy may survive:</p>
			<ul>
				<li>
					<strong>Inside a maFile.</strong> If the authenticator was ever held by a
					desktop tool, a typical file carries a <code>revocation_code</code> field —
					though not every one does, which is its own problem.
					<a href="/what-is-a-mafile">Any surviving copy</a> — an old machine, an old
					backup — carries it too.
				</li>
				<li>
					<strong>Screenshots and notes.</strong> The setup screen told you to save it,
					and plenty of people screenshotted it. Search your images and your password
					manager for anything starting with <code>R</code>.
				</li>
			</ul>

			<h2>Using it</h2>
			<p>
				Steam's help pages, under the option for no longer having access to your
				authenticator — enter the code and the authenticator is removed; then set up a
				fresh one. Removing an authenticator carries a
				<a href="/move-steam-authenticator-new-phone">fifteen-day trade and Market
				restriction</a>, which is why transferring is the better path when you still
				can. Nothing legitimate bypasses it.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Treat the code as sensitive.</strong> Anyone who has both your
					recovery code <em>and</em> authenticated access to your account may be able
					to remove the authenticator — it is one half of a pair, not a standalone
					master key, which is exactly why it should never travel alongside the
					other half. Never paste it into a site that is not Steam's own, and
					<a href="/support">never into a support form</a> — including ours. Nobody
					legitimate asks for it.
				</p>
			</div>

			<h2>Keeping the next one</h2>
			<p>
				Write it on paper, keep the paper somewhere the device is not, and check it is
				still readable when you think of it. A code stored only on the device it
				revokes is not a backup — losing the device loses both at once.
			</p>
			<p>
				This is also somewhere software can refuse to let you fail. When ${s.name}
				creates an authenticator it does not treat the account as active until the
				code has been shown and you have confirmed it is written down — at the one
				moment the code exists and nothing is yet at risk. That ceremony exists
				because every horror story on <a href="/lost-authenticator">the lost-access
				page</a> begins with "I never wrote it down".
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
		'An encrypted SDA maFile needs the passphrase set in SDA plus the manifest.json beside it. Why copying the file alone fails, and what to try next.',
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

			<h2>Why the error messages are so unhelpful</h2>
			<p>
				SDA derives a key from your passphrase with PBKDF2 and encrypts with
				<strong>AES-256-CBC</strong> — a mode with no authentication tag. That
				matters: an authenticated cipher would at least detect reliably that
				<em>something</em> was wrong, though not which thing. Without one you get a
				padding error, or occasionally plausible-looking rubbish, and those look
				identical whether the real problem is
			</p>
			<ul>
				<li>a wrong passphrase,</li>
				<li>the wrong salt or IV — usually a mismatched <code>manifest.json</code>,</li>
				<li>or a corrupted file.</li>
			</ul>
			<p>
				<a href="/import-from-sda">${s.short}'s importer</a> checks whether the
				decrypted result actually parses as a maFile, so it can say the passphrase
				did not open the file rather than handing you garbage — but no tool can tell
				you which of those three went wrong, or what the right passphrase is. The
				mathematics genuinely does not know.
			</p>

			<h2>If the passphrase is genuinely gone</h2>
			<p>
				Then the file's contents are unreachable. That is what encryption is for, and
				anything claiming to crack it is either lying or describing a guessing attack
				that only succeeds against weak or predictable passphrases. The account itself is not lost, though.
				In order:
			</p>
			<ol>
				<li>
					<strong>Look for an unencrypted copy.</strong> SDA's encryption was off by
					default, so an older backup of the folder may be plain JSON.
					<a href="/how-to-open-mafile">Open one in a text editor</a> — readable field
					names mean unencrypted.
				</li>
				<li>
					<strong>Any still-working authenticator</strong> — the Steam app on a
					phone, SDA on another machine — can show the
					<a href="/steam-revocation-code">recovery code</a>, which removes and
					re-adds the authenticator cleanly.
				</li>
				<li>
					<strong>Neither?</strong> <a href="/lost-authenticator">The lost-access
					page</a> — from here it is the recovery code you hopefully wrote down,
					or Steam Support.
				</li>
			</ol>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/what-is-a-mafile">What a maFile is, field by field</a></li>
				<li><a href="/how-to-open-mafile">Opening one safely</a></li>
				<li><a href="/import-from-sda">Importing maFiles — encrypted ones included</a></li>
			</ul>
		</article>`
};
