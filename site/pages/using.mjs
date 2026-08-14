/**
 * Pages for somebody choosing an authenticator, or working out how to use one.
 *
 * The rescue pages in rescues.mjs catch people mid-accident. These catch them
 * earlier — deciding, or trying something they have not done before — which is
 * a different register: less urgency, more comparison, and a much stronger
 * obligation to be even-handed.
 *
 * **The comparison page recommends Steam's own app for most readers**, and
 * describes it accurately rather than conveniently. An earlier draft implied the
 * mobile app handles one account at a time; Valve documents the opposite, and
 * understating a competitor is the same failure as overstating yourself. The
 * readers a desktop authenticator genuinely suits can recognise themselves from
 * an honest description of the trade, and the rest are better served elsewhere.
 */

/** Valve's own pages, cited wherever this makes a claim about Steam's behaviour. */
const VALVE = {
	guard: 'https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31',
	setup: 'https://help.steampowered.com/en/faqs/view/6891-E071-C9D9-0134'
};

export const confirmationsOnDesktop = {
	slug: 'approve-steam-confirmations-desktop',
	navTitle: 'Confirmations on PC',
	title: 'How Steam trade confirmations work on desktop',
	updated: '2026-08-14',
	description:
		'What actually signs a Steam trade confirmation, why desktop tools can do it, and the two questions to ask any software you let approve trades.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'How Steam trade confirmations work on desktop',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/approve-steam-confirmations-desktop`
	}),
	body: (s) => `
		<article>
			<h1>How Steam trade confirmations work on desktop</h1>
			<p class="lede">
				Every trade and every Market listing needs a second approval after you click
				accept. Steam's own answer is the phone in your pocket — but it is not the
				only thing that can sign one, and understanding what a confirmation actually
				is explains both the appeal and the risk of moving that job to a desktop.
			</p>

			<h2>What actually approves a Steam trade confirmation?</h2>
			<p>
				When you accept a trade, Steam creates a pending confirmation and waits for a
				correctly signed request to approve it. Three things have to come together
				before that request is valid:
			</p>
			<ol>
				<li>
					<strong>The identity secret</strong> from your authenticator, used to
					compute an HMAC.
				</li>
				<li>
					<strong>An authenticated Steam session</strong> — a live login for the
					account, not just the secret.
				</li>
				<li>
					<strong>A key minted for that exact operation and moment</strong>: the HMAC
					covers the current Steam-corrected time and a tag naming the action, so a
					key made for <em>listing</em> confirmations cannot be replayed to
					<em>accept</em> one.
				</li>
			</ol>
			<p>
				That third property is easy to miss and worth knowing about, because it is
				what stops a captured request being reused as an approval later.
			</p>

			<h2>How can a desktop program approve them?</h2>
			<p>
				By holding the identity secret and signing in as you. It imports the secret
				from a <a href="/what-is-a-mafile">maFile</a>, or receives it when the
				authenticator is first created, then produces the same signatures the phone
				does. Steam accepts any request carrying valid authenticator cryptography and
				a valid session — it is not checking whether a phone or a PC produced it,
				though it can of course observe how a client behaves.
			</p>
			<p>
				Which is the honest framing of "approve confirmations on PC": not a
				convenience feature, but moving trade authority from a device you carry to a
				machine that is often left running. Be precise about the limit, though: the
				identity secret cannot sign in to Steam. A program that also holds a usable
				session or refresh token can act immediately; one holding only the secrets
				needs an authentication route first. The <code>shared_secret</code> supplies
				the second factor, not the password — so it closes half the gap, not all of
				it.
			</p>

			<h2>Why would anyone want confirmations on a PC?</h2>
			<ul>
				<li>
					<strong>Volume.</strong> Confirming forty Market listings one at a time on a
					phone is genuinely miserable. On a desktop they can be reviewed as a list.
				</li>
				<li>
					<strong>Several accounts at once.</strong> The Steam app
					<a href="${VALVE.guard}" rel="noopener">does hold multiple accounts</a>, but
					it shows one at a time; a desktop screen can show them side by side.
				</li>
				<li>
					<strong>No usable phone.</strong> A broken handset does not have to stop
					trading. <a href="/steam-guard-without-phone">There is more on that here.</a>
				</li>
			</ul>

			<h2>Is it safe to let software approve my trades?</h2>
			<p>
				Not "can it approve confirmations" — they all can, or they would not be
				offering. Ask <strong>what it will approve without asking you</strong>, and
				<strong>what happens to the secret while the machine is unattended</strong>.
			</p>
			<p>
				${s.name}'s answers, so you can compare them against anything else: automatic
				approval is off unless you switch it on, per account, and switching on
				automatic <em>trades</em> — the setting that can move items out of an account
				with nobody watching — requires typing a confirmation phrase rather than
				clicking a toggle. Nothing is approved at all while the vault is locked, and
				the vault locks on idle and on suspend. The secrets stay
				<a href="/security">encrypted on disk and never leave the machine</a>.
			</p>
			<p>
				A tool that cannot answer those two questions clearly is asking you to hand
				over trade authority on trust alone.
			</p>

			<div class="callout">
				<p>
					<strong>Looking for the steps rather than the explanation?</strong> There is
					no public build of ${s.short} to give you steps for yet —
					<a href="/download">the release status is here</a>, stated plainly rather
					than implied. This page explains the mechanism so the eventual instructions
					make sense, and so you can judge any other tool offering the same thing.
				</p>
			</div>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/security">Where the secrets live, and what reaches the network</a></li>
				<li><a href="/steam-mobile-vs-desktop-authenticator">Mobile app or desktop: an honest comparison</a></li>
				<li><a href="/what-is-a-mafile">What the identity secret is, and what else a maFile holds</a></li>
			</ul>
		</article>`
};

export const mobileVsDesktop = {
	slug: 'steam-mobile-vs-desktop-authenticator',
	navTitle: 'Mobile or desktop',
	title: 'Steam mobile app or a desktop authenticator?',
	updated: '2026-08-14',
	description:
		'An honest comparison of Steam Guard on the official mobile app versus a desktop authenticator, including who should ignore the desktop option entirely.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Steam mobile app or a desktop authenticator?',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/steam-mobile-vs-desktop-authenticator`
	}),
	body: (s) => `
		<article>
			<h1>Steam mobile app or a desktop authenticator?</h1>
			<p class="lede">
				We build a desktop authenticator, so treat this page with the suspicion it
				deserves — and then read the recommendation, which is that most people should
				use Steam's official mobile app and not think about this again.
			</p>

			<div class="callout">
				<p>
					<strong>Use the official Steam Mobile app if it works for you.</strong> It is
					made by Valve, it holds the secret in storage you never have to manage, and
					if you link a phone number it gains an SMS recovery and transfer route
					nothing else offers. For the large
					majority of Steam accounts that is simply the correct answer, and no feature
					below outweighs it.
				</p>
			</div>

			<h2>Can I use the Steam app and a desktop authenticator together?</h2>
			<p>
				Worth settling first, because it is widely misunderstood: Valve states that
				<a href="${VALVE.guard}" rel="noopener">an account "can only be on one
				authenticator ... at a time"</a>. Moving to a desktop tool means the phone app
				stops being your authenticator, and moving back means the reverse. Anything
				describing them as running side by side is describing an unsupported
				arrangement, not a feature.
			</p>

			<h2>When is Steam's mobile app the better choice?</h2>
			<dl class="defs">
				<dt>Recovery</dt>
				<dd>
					This is the big one, provided you linked a number: lose the phone and Steam
					can text you to get you back in. Lose a desktop authenticator's file with no
					backup and your route is the <a href="/steam-revocation-code">recovery
					code</a> or a support ticket that takes days.
				</dd>
				<dt>Nothing for you to mislay</dt>
				<dd>
					The secret lives in the app's own storage — there is no user-managed file to
					copy to the wrong place, sync to cloud storage, or hand to the wrong
					program. A desktop authenticator's entire risk model starts with the fact
					that such a file exists.
				</dd>
				<dt>It is official</dt>
				<dd>
					No third party between you and Valve. Every desktop option, ours included,
					asks you to trust somebody else with the most sensitive thing on the
					account.
				</dd>
				<dt>Modern sign-in</dt>
				<dd>
					The app can approve logins by notification and by QR code, so there is often
					no code to type at all. It also
					<a href="${VALVE.guard}" rel="noopener">holds several accounts at once</a> and
					sends sign-in notifications for each — which is more than it usually gets
					credit for.
				</dd>
				<dt>It is less likely to sit unattended</dt>
				<dd>
					A phone in your pocket spends far less time logged in and idle than the
					desktop you trade from. That is a difference of habit rather than of
					design, and it is most of why it matters.
				</dd>
			</dl>

			<h2>When is a desktop authenticator the better choice?</h2>
			<dl class="defs">
				<dt>Many accounts, side by side</dt>
				<dd>
					The app holds multiple accounts but shows one at a time. On a desktop they
					can be visible together, which for someone managing several is not merely
					faster but easier to check carefully.
				</dd>
				<dt>Trading volume</dt>
				<dd>
					<a href="/approve-steam-confirmations-desktop">Confirming Market listings in
					bulk</a> on a phone is genuinely painful work.
				</dd>
				<dt>No smartphone, or no wish to use one</dt>
				<dd>
					Some people do not have a suitable handset; some will not install the app.
					<a href="/steam-guard-without-phone">This is the page for that</a> — and it
					is more complicated than it sounds.
				</dd>
				<dt>Backups you control</dt>
				<dd>
					A file can be copied deliberately and kept somewhere safe. That is the same
					property as the risk — it cuts both ways, honestly.
				</dd>
			</dl>

			<h2>So which should I use?</h2>
			<p>
				If you have a working smartphone, trade occasionally, and run one account:
				<strong>use the mobile app.</strong> Nothing here should talk you out of it.
			</p>
			<p>
				If you run several accounts, trade in volume, or cannot use the app at all,
				then a desktop authenticator solves a real problem — and the thing to compare
				is not features but failure modes.
				<a href="/alternatives">The alternatives page lists every option we know of,
				including the ones that are not ours</a>, and
				<a href="/scam-clones">the counterfeits are a genuine hazard</a> in this
				particular corner of the internet.
			</p>
			<p>
				Whichever way you go, moving is not free. Steam's own phone-to-phone transfer
				carries a two-day trade and Market restriction. A move involving an unofficial
				desktop authenticator may instead require removing the authenticator and
				enrolling again, which is the
				<a href="/move-steam-authenticator-new-phone">fifteen-day path</a> — so it is
				worth deciding once rather than experimenting.</p>

			<h2>Questions that decide it either way</h2>

			<h3>Is a desktop authenticator against Steam's rules?</h3>
			<p>
				Valve supports its own app and does not endorse third-party authenticators,
				so anything else is unofficial by definition — you are choosing to hold the
				secret yourself. Desktop tools have existed for years and work because the
				cryptography is the same, not because they are sanctioned.
			</p>

			<h3>What happens to my items while I switch?</h3>
			<p>
				A restriction on trading and the Market, and the length depends on the route:
				two days for Steam's own transfer, fifteen if the authenticator is removed and
				re-added. <a href="/move-steam-authenticator-new-phone">The two paths are set
				out here.</a>
			</p>

			<h3>Can I go back to the phone app afterwards?</h3>
			<p>
				Yes, and it is not a one-way door — but do not assume it is the cheap path.
				Steam's documented two-day transfer covers moving between devices running
				Steam's own app; coming back from an unofficial desktop tool may instead mean
				removing the authenticator and enrolling again, which is the fifteen-day
				route. Budget for fifteen unless you have confirmed otherwise.
			</p>

			<h3>What if I lose the computer?</h3>
			<p>
				The same question as losing the phone, with a different answer: a vault file
				you backed up restores the secrets, so codes work again immediately —
				confirmations may still need you to sign in, since a stored session expires
				even when a secret does not. No backup means the
				<a href="/steam-revocation-code">recovery code</a> or Steam Support. This is
				the question to answer <em>before</em> you switch, not after.
			</p>

			<h2>Where ${s.short} stands today</h2>
			<p>
				Stated so you can weigh it: this is a young project with no public release
				yet, no independent audit, and none of the years of scrutiny the mobile app
				has. Those are real disadvantages and open source does not cancel them.
				<a href="/download">The current status is here</a>, and
				<a href="/owners">the company behind it is named</a> — which is the least you
				should demand of anything asking to hold a Steam secret.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/alternatives">Every desktop option, compared</a></li>
				<li><a href="/security">How this one stores secrets</a></li>
				<li><a href="/steam-guard-code-not-working">If codes stop being accepted</a></li>
			</ul>
		</article>`
};

export const withoutPhone = {
	slug: 'steam-guard-without-phone',
	navTitle: 'Without a phone',
	title: 'Steam Guard without a smartphone',
	updated: '2026-08-14',
	description:
		'Steam’s official authenticator needs Android or iOS, but a phone number is optional. What desktop tools change, and what you lose without SMS recovery.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Steam Guard without a smartphone',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/steam-guard-without-phone`
	}),
	body: (s) => `
		<article>
			<h1>Steam Guard without a smartphone</h1>
			<p class="lede">
				Two different questions hide inside this one, and mixing them up is why the
				answers you find online contradict each other. One is about the device that
				generates codes. The other is about the phone number on your account — and
				the second has an answer most people do not expect.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Two different things, and only one of them is required.</strong>
					Valve's official mobile authenticator runs on a supported Android or iOS
					device, so without one of those the official app is not an option. A
					<em>phone number</em>, however, is no longer mandatory — Valve's own setup
					guide includes a way to skip it. The rest of this page separates the two.
				</p>
			</div>

			<h2>Question 1: does the authenticator have to run on a phone?</h2>
			<p>
				<strong>No.</strong> An authenticator is a secret plus a clock, and a desktop
				can hold both — that is what
				<a href="/steam-desktop-authenticator">desktop authenticators</a> are, and
				they have existed for years. But note this is a
				<a href="/steam-mobile-vs-desktop-authenticator">move, not an addition</a>:
				Steam allows one authenticator on an account at a time.
			</p>

			<h2>Question 2: can the account have no phone number at all?</h2>
			<p>
				<strong>Yes.</strong> Valve's current setup walkthrough documents an
				enrolment path for people without access to a phone number, and says so
				directly:
			</p>
			<div class="callout">
				<p>
					<a href="${VALVE.setup}" rel="noopener">"if you do not have a phone number,
					you can still add the authenticator. To do this, select the link <strong>I
					don't have access to a phone number</strong> below the Next button."</a>
				</p>
			</div>
			<p>
				So a number is no longer a hard requirement for attaching an authenticator.
				Steam still asks for one first, and still recommends it — Valve's step for
				entering a number explains why, since it is what lets you recover the account
				by text later. But there is a documented way past it.
			</p>
			<p>
				This matches what we see. Our own enrolment decides from Steam's response
				whether to expect the activation code by SMS or by email rather than assuming
				SMS, and one live run against an account with no phone — in August 2026 —
				completed with the code delivered by email. That is a single observed account
				flow rather than a guarantee, but it is consistent with the documented path
				above.
			</p>
			<p>
				Adding a number, if you decide you want one, is done on Steam itself — no
				third-party tool can do it for you.
			</p>

			<h2>What do I lose by not having a phone number?</h2>
			<div class="callout callout-warn">
				<p>
					<strong>A phone number is the easiest way back into a locked-out
					account.</strong> Skipping it is supported, but it costs you the SMS
					recovery route and the simplest phone-to-phone transfer. Without a number,
					losing your authenticator means the
					<a href="/steam-revocation-code">recovery code</a> or a Steam Support ticket
					that takes days — so writing that code down stops being good practice and
					becomes the only thing standing between you and support.
				</p>
			</div>

			<h2>What if I have a phone but will not install the app?</h2>
			<p>
				If you have a phone but will not install the app — a common and reasonable
				position — keep the number on the account for recovery and let a desktop tool
				generate the codes. You keep Steam's easy recovery path <em>and</em> get codes
				and <a href="/approve-steam-confirmations-desktop">confirmations</a> on the
				machine you are already using. That is the setup a desktop authenticator suits
				best, and it sidesteps everything difficult above.
			</p>

			<h2>Related questions about phone numbers</h2>

			<h3>Can I remove the phone number after adding an authenticator?</h3>
			<p>
				Removing it is done on Steam, and it costs you the SMS recovery route — which
				is usually the fastest way back into a locked-out account. Worth keeping
				unless you have a specific reason not to.
			</p>

			<h3>Can two accounts share one phone number?</h3>
			<p>
				<a href="${VALVE.guard}" rel="noopener">Valve says yes</a> — the same number
				may be used on multiple accounts.
			</p>

			<h3>Does a landline or VoIP number work?</h3>
			<p>
				Steam sends codes by SMS, so a number that cannot receive text messages is not
				useful for this, and Valve documents blocking some VoIP numbers outright. If
				the number is the obstacle, the no-number option above is the cleaner route.
			</p>

			<h2>What am I taking on with a desktop authenticator?</h2>
			<p>
				Honestly: responsibility for a file. On a phone the secret is sealed inside an
				app; on a PC it is data you can back up, and equally data you can leak.
				${s.name} keeps it <a href="/security">encrypted with a passphrase and locks
				itself when idle</a>, but no design removes the underlying fact — and
				<a href="/steam-mobile-vs-desktop-authenticator">if a smartphone is genuinely
				an option for you, the official app is still the simpler answer</a>.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-mobile-vs-desktop-authenticator">Mobile app or desktop?</a></li>
				<li><a href="/steam-revocation-code">The code that gets you back in</a></li>
				<li><a href="/lost-authenticator">If you are already locked out</a></li>
			</ul>
		</article>`
};

export const openMafile = {
	slug: 'how-to-open-mafile',
	navTitle: 'Opening a maFile',
	title: 'How to open a Steam maFile safely',
	updated: '2026-08-14',
	description:
		'An unencrypted maFile is JSON you can read in Notepad; encrypted ones need the SDA passphrase and manifest.json. How to inspect one safely.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Open and inspect a Steam maFile safely',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Find the maFiles folder beside the SDA program' },
			{ '@type': 'HowToStep', name: 'Copy the file before touching it' },
			{ '@type': 'HowToStep', name: 'Open the copy in a plain text editor' },
			{ '@type': 'HowToStep', name: 'Check whether it is readable or encrypted' }
		]
	}),
	body: (s) => `
		<article>
			<h1>How to open a Steam <code>.maFile</code> safely</h1>
			<p class="lede">
				There is no special program needed to look inside one. A maFile is a small
				text file, and a text editor will show you everything in it. The care required
				is not technical — it is about what you do with the file afterwards.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Never use an online file viewer or converter on a real
					maFile.</strong> Search results for this file extension are full of
					"open any file online" sites that ask you to upload it. Uploading a maFile
					hands over the authenticator itself. There is no legitimate reason for a
					website to see one.
				</p>
			</div>

			<h2>1. Where is the maFiles folder?</h2>
			<p>
				SDA is a portable program, so its <code>maFiles</code> folder sits
				<strong>beside the SDA executable</strong> — wherever you unzipped it —
				<em>not</em> inside your Steam installation and not in Program Files. If you
				are hunting for it, search your drive for the <code>maFiles</code> folder
				rather than for the file itself.
			</p>
			<p class="hint">
				Unrelated file, same-looking extension: Autodesk Maya uses <code>.ma</code>.
				If a file opens as 3D scene data, you have the wrong one.
			</p>

			<h2>2. Why should I copy it first?</h2>
			<p>
				Copy the file somewhere else and work on the copy. A maFile is frequently the
				only surviving record of an authenticator, and a text editor that helpfully
				saves a change can corrupt the JSON. Never edit the original.
			</p>

			<h2>3. What opens a .maFile?</h2>
			<p>
				Notepad on Windows, or any code editor. Do not double-click the file and let
				Windows pick something; choose the editor deliberately with
				<strong>Open with</strong>. What you should see is JSON — curly braces and
				quoted field names.
			</p>

			<h2>4. Is mine encrypted or readable?</h2>
			<dl class="defs">
				<dt>Readable field names</dt>
				<dd>
					<code>shared_secret</code>, <code>identity_secret</code>,
					<code>account_name</code> and friends. This is an unencrypted maFile, and
					everything in it is live.
					<a href="/what-is-a-mafile">Here is what each field does.</a>
				</dd>
				<dt>One long unbroken block of base64</dt>
				<dd>
					Encrypted. You will need the passphrase <em>and</em> the
					<code>manifest.json</code> that was beside it —
					<a href="/encrypted-mafile">this is the page for that</a>.
				</dd>
				<dt>Neither, or the file will not open</dt>
				<dd>
					Check you are looking at the right file. maFiles are usually a few
					kilobytes; something much larger is probably not one.
				</dd>
			</dl>

			<div class="callout callout-warn">
				<p>
					<strong>Opening a copy in a text editor does not run anything — but the
					contents are still live secrets.</strong> Editors keep recent-file history
					and documents folders are often synced to cloud storage, so where you put
					that copy matters. Do not paste the
					contents into a website, a Discord bot, a pastebin, an AI chat, or a support
					form — <a href="/support">including ours</a>. Anyone who receives that text
					can generate your Steam Guard codes from then until the authenticator is
					detached from the account entirely — the shared secret never expires. If
					the file also carries usable session tokens they may be able to approve
					trades immediately; if not, they need to sign in first, and holding your
					codes is a long way towards being able to.
				</p>
			</div>

			<h2>5. Is it safe to load it into an authenticator?</h2>
			<p>
				"Opening" a maFile in an authenticator is a much larger act than reading it.
				You are handing a program the authority to act as your authenticator
				indefinitely — <a href="/what-is-a-mafile">these secrets do not expire on their
				own</a>, and stop working only when the authenticator is removed or replaced.
				To Steam the requests it signs carry the same cryptography yours would.
			</p>
			<p>
				So the question is not whether the software can read the format. It is whether
				you are willing to give the people who wrote it that authority. Before loading
				a maFile into anything, including ${s.short}, check that you can name who
				publishes it, <a href="/verify">verify the download is what they published</a>,
				and read what it does with the secret afterwards.
				<a href="/scam-clones">Counterfeit authenticators exist specifically to be
				handed maFiles</a>, and they look like the real thing.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/what-is-a-mafile">What a maFile is, field by field</a></li>
				<li><a href="/encrypted-mafile">When it is encrypted</a></li>
				<li><a href="/import-from-sda">Importing one into this application</a></li>
			</ul>
		</article>`
};
