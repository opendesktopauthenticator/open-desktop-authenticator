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
	setup: 'https://help.steampowered.com/en/faqs/view/6891-E071-C9D9-0134',
	holds: 'https://help.steampowered.com/en/faqs/view/34A1-EA3F-83ED-54AB',
	confirmations: 'https://help.steampowered.com/en/faqs/view/2E6E-A02C-5581-8904'
};

export const confirmationsOnDesktop = {
	slug: 'approve-steam-confirmations-desktop',
	guide: true,
	// Valve documents the feature; the wire protocol is from open implementations.
	sourced: 'Checked against Valve documentation and current Steam protocol implementations',
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
		<article class="guide numbered">
			<h1>How Steam trade confirmations work on desktop</h1>
			<p class="lede">
				Every trade and every Market listing needs a second approval after you click
				accept. Steam's own answer is the phone in your pocket — but it is not the
				only thing that can sign one, and understanding what a confirmation actually
				is explains both the appeal and the risk of moving that job to a desktop.
			</p>

			<div class="answer">
				<span class="eyebrow">Short answer</span>
				<p>
					A desktop tool approves confirmations by holding your
					<code>identity_secret</code> and signing each request with it, exactly as
					the phone does. <strong>It needs a live Steam session as well as the
					secret</strong> — the secret alone cannot sign in.
				</p>
				<p>
					That is why an authenticator file is worth protecting like the account
					itself, and why nothing here should ever be pasted into a website.
				</p>
			</div>

			<h2>What actually approves a Steam trade confirmation?</h2>
			<p>
				Valve documents the feature itself on
				<a href="${VALVE.confirmations}" rel="noopener">Trade and Market
				Confirmations</a>: confirmations are the final step before a trade completes or
				a Market listing goes up, delivered through the mobile app if you have one and
				by email if you do not. What follows is what has to be true for one of those
				approvals to be accepted.
			</p>
			<p>
				When you accept a trade, Steam creates a pending confirmation and waits for a
				correctly signed request to approve it. Three things have to come together
				before that request is valid:
			</p>
			<ol>
				<li>
					<strong>The identity secret</strong> from your authenticator. It is used as
					the HMAC key — not as data sent anywhere — so it never leaves your machine.
				</li>
				<li>
					<strong>An authenticated Steam session</strong> — a live login for the
					account, not just the secret.
				</li>
				<li>
					<strong>A key minted for that exact operation and moment</strong>. The
					message being signed is the current
					<a href="/steam-guard-code-not-working">Steam-corrected time</a> followed by
					a short tag naming the action — one tag for fetching the list, a different
					one for allowing, another for cancelling. Change either half and the
					signature changes, so a key generated for <em>fetching the confirmation
					list</em> is not valid for <em>accepting</em> a confirmation, and a captured
					key stops being usable once its moment passes.
				</li>
			</ol>
			<p class="hint">
				Valve documents the confirmation feature but not this wire format. The tag
				behaviour above matches the long-standing open implementation in
				<a href="https://github.com/DoctorMcKay/node-steamcommunity/wiki/SteamCommunity" rel="noopener">DoctorMcKay's
				node-steamcommunity</a>, one of the libraries
				<a href="/credits">this project is built on</a>, and our own
				implementation follows it.
			</p>
			<p>
				That third property is easy to miss and worth knowing about, because it is
				what stops a captured request being reused as an approval later. The reason
				Steam demands any of this is the same reason it applies holds: Valve documents
				that accounts without a mobile authenticator get
				<a href="${VALVE.holds}" rel="noopener">trade holds of up to 15 days</a> on
				items leaving the account, and confirmations are what an authenticator buys you
				instead of that wait.
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
			<p class="pull">
				That is the honest framing of "approve confirmations on PC": not a convenience
				feature, but moving trade authority from a device you carry to a machine that
				is often <em>left running</em>.
			</p>
			<p>
				It is worth being exact about what somebody gains by stealing that file,
				because both the panic and the shrug are wrong:
			</p>
			<ul class="check">
				<li class="no">
					<strong>The identity secret cannot sign in to Steam.</strong> On its own it
					signs confirmations and nothing else.
				</li>
				<li class="no">
					<strong>The shared secret is not your password.</strong> It supplies the
					second factor, so it closes half the gap rather than all of it.
				</li>
				<li class="yes">
					<strong>A usable session or refresh token changes that.</strong> A file
					carrying one lets a thief act immediately, with no sign-in step at all.
				</li>
				<li class="yes">
					<strong>The secrets do not expire.</strong> A password can be changed in a
					minute; a copied secret keeps working until the authenticator is detached
					from the account.
				</li>
			</ul>

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
					<strong>Looking for the steps rather than the explanation?</strong>
					<a href="/download">Get ${s.short} here</a> and the application walks you
					through it. This page explains the mechanism underneath, so the steps make
					sense while you follow them — and so you can judge any other tool offering
					to do the same thing.
				</p>
			</div>

			<h2>Related</h2>
			<ul class="link-cards">
				<li>
					<a href="/security"><b>Where the secrets live</b>
					<span>What this application stores, and what reaches the network.</span></a>
				</li>
				<li>
					<a href="/steam-mobile-vs-desktop-authenticator"><b>Mobile app or desktop</b>
					<span>An honest comparison, including when the answer is the phone.</span></a>
				</li>
				<li>
					<a href="/what-is-a-mafile"><b>The identity secret</b>
					<span>What signs a confirmation, and what else sits in the same file.</span></a>
				</li>
			</ul>
		</article>`
};

export const mobileVsDesktop = {
	slug: 'steam-mobile-vs-desktop-authenticator',
	guide: true,
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
		<article class="guide numbered">
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
					if you link a phone number it gains SMS recovery and transfer routes that run
					through Valve's own account systems — something no third-party tool is in a
					position to provide. For the large majority of Steam accounts that is simply
					the correct answer, and no feature below outweighs it.
				</p>
			</div>

			<div class="answer">
				<span class="eyebrow">Short answer</span>
				<p>
					<strong>Use Steam's official mobile app unless you have a specific reason
					not to.</strong> It is Valve's own, it needs no file management from you,
					and with a phone number attached it has recovery routes nothing outside
					Valve can offer.
				</p>
				<p>
					A desktop authenticator is mainly useful for bulk confirmations, managing
					several accounts side by side, controlling your own backups, or operating
					without the official mobile app.
				</p>
			</div>

			<div class="tbl">
				<table>
					<thead>
						<tr>
							<th scope="col">&nbsp;</th>
							<th scope="col">Steam Mobile app</th>
							<th scope="col">A desktop authenticator</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row">Who makes it</th>
							<td>Valve</td>
							<td>Third parties, including us</td>
						</tr>
						<tr>
							<th scope="row">Account recovery</th>
							<td>Steam's recovery flow; SMS when a phone number is linked</td>
							<td>
								Your backup or recovery code; Steam's own options may also remain
								available if a number is linked
							</td>
						</tr>
						<tr>
							<th scope="row">Confirming many trades</th>
							<td>One tap each, on a phone</td>
							<td>A list and one button</td>
						</tr>
						<tr>
							<th scope="row">Needs a phone</th>
							<td>Yes — Android or iOS</td>
							<td>No</td>
						</tr>
						<tr>
							<th scope="row">Who holds the secret</th>
							<td>The app, in storage you never see</td>
							<td>A file on your disk, which you must protect and back up</td>
						</tr>
						<tr>
							<th scope="row">If you lose the device</th>
							<td>Valve's own recovery flow</td>
							<td>Your backup, or the recovery code</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p class="hint">
				The honest summary of that table: the mobile app is the safest default for most
				people. A desktop tool is a specialist option for the specific workflows above.
			</p>

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
					code</a> or Steam Support.
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
					A phone in your pocket generally spends less time physically unattended and
					accessible than the
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
				Stated so you can weigh it: this is a young project. Version 1.0 is days old,
				no independent audit has happened, and it has none of the years of scrutiny the
				mobile app has.</p>

			<h2>Related</h2>
			<ul class="link-cards">
				<li>
					<a href="/move-steam-authenticator-to-pc"><b>Moving yours to a PC</b>
					<span>What Steam's transfer does, and the two days it costs.</span></a>
				</li>
				<li>
					<a href="/alternatives"><b>Every desktop option, compared</b>
					<span>What each one is, who maintains it, and what it asks of you.</span></a>
				</li>
				<li>
					<a href="/security"><b>How this one stores secrets</b>
					<span>The encryption, the threat model, and what it does not protect against.</span></a>
				</li>
				<li>
					<a href="/steam-guard-code-not-working"><b>If codes stop being accepted</b>
					<span>Usually the clock. About a minute to fix, whichever tool you use.</span></a>
				</li>
			</ul>
		</article>`
};

export const withoutPhone = {
	slug: 'steam-guard-without-phone',
	guide: true,
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
		<article class="guide">
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
					<em>phone number</em>, however, is optional in Valve's current setup flow —
					its own guide includes a way to skip that step. The rest of this page separates the two.
				</p>
			</div>

			<div class="answer">
				<span class="eyebrow">Short answer</span>
				<p>
					Two separate questions get tangled together here.
					<strong>Valve's official authenticator app does require an Android or iOS
					device</strong> — there is no official desktop version of it. But a
					<strong>phone number is optional in Valve's current setup flow</strong>.
					Generating Steam Guard login codes needs a secret and the correct time, so
					that part can run on a desktop; trade confirmations additionally need an
					identity secret and an authenticated Steam session.
				</p>
				<p>
					Skipping the phone number removes SMS recovery, which makes a working
					<a href="/encrypted-mafile">backup of the authenticator</a> and the
					<a href="/steam-revocation-code">recovery code</a> especially important.
				</p>
			</div>

			<h2>Question 1: does the authenticator have to run on a phone?</h2>
			<p>
				<strong>No.</strong> Generating login codes requires a secret and the correct
				time, so that function can run on a desktop; trade confirmations additionally
				require the identity secret and an authenticated session. That is what
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
				So a number is not a hard requirement in Valve's current setup flow for attaching an authenticator.
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
			<p>
				Skipping the number is supported and the account works normally. What changes
				is what happens on the day something goes wrong:
			</p>
			<ul class="check">
				<li class="yes">
					<strong>You keep the authenticator itself.</strong> Codes and trade
					confirmations continue to work without SMS, provided the authenticator
					secrets and session remain valid.
				</li>
				<li class="yes">
					<strong>You keep the recovery code.</strong> It still detaches the
					authenticator, and it does not depend on a phone number.
				</li>
				<li class="no">
					<strong>You lose SMS recovery.</strong> The quickest route back into a
					locked-out account is the one that texts you, and there is nowhere to text.
				</li>
				<li class="no">
					<strong>You lose Valve's documented SMS-based phone-to-phone transfer
					path.</strong> An alternative may require authenticator removal,
					re-enrolment or Steam Support.
				</li>
			</ul>
			<div class="callout callout-warn">
				<p>
					<strong>So the recovery code stops being good practice and starts being the
					plan.</strong> Without a phone number, your self-service fallbacks are a
					working backup of the authenticator or the
					<a href="/steam-revocation-code">recovery code</a>. Without either, the
					remaining route is Steam Support.
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
			<ul class="link-cards">
				<li>
					<a href="/steam-revocation-code"><b>The code that gets you back in</b>
					<span>Without a phone number this is your recovery route. Know where it is.</span></a>
				</li>
				<li>
					<a href="/steam-mobile-vs-desktop-authenticator"><b>Mobile app or desktop</b>
					<span>The trade-offs side by side, with no thumb on the scale.</span></a>
				</li>
				<li>
					<a href="/lost-authenticator"><b>If you are already locked out</b>
					<span>Every way back in, in the order worth trying them.</span></a>
				</li>
			</ul>
		</article>`
};

export const openMafile = {
	slug: 'how-to-open-mafile',
	guide: true,
	sourced: (s) =>
		`Checked against <a href="${s.sda.repo}" rel="noopener">SDA's source code</a> and on-disk file format`,
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
		<article class="guide">
			<h1>How to open a Steam <code>.maFile</code> safely</h1>
			<p class="lede">
				There is no special program needed to look inside one. A maFile is a small
				text file, and a text editor opens it — showing either readable fields or, if
				it was encrypted, a block of base64 you will need the passphrase and manifest
				to make sense of. The care required is not technical — it is about what you do
				with the file afterwards.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Never use an online file viewer or converter on a real
					maFile.</strong> Some generic online file viewers ask you to upload the file
					to read it. Uploading an unencrypted maFile exposes the authenticator secret
					itself. An encrypted one should not be uploaded either: it is sensitive
					backup material, and it may become readable if its matching
					<code>manifest.json</code> and passphrase are exposed later. There is no
					legitimate reason for a website to see either.
				</p>
			</div>

			<div class="answer">
				<span class="eyebrow">Short answer</span>
				<p>
					<strong>Any plain-text editor can display a maFile</strong> — Notepad, VS
					Code, anything. An unencrypted one contains JSON; an encrypted one shows
					base64 ciphertext. There is nothing to install and nothing to convert. Work
					on a copy, not the original.
				</p>
				<p>
					The danger is not opening it. It is
					<strong>where the contents go afterwards</strong>: never into a website, a
					Discord bot, a pastebin, an AI chat, or a support form.
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
				only surviving record of an authenticator, and a text editor that saves a
				change can corrupt the file. Never edit the original.
			</p>

			<h2>3. What opens a .maFile?</h2>
			<p>
				Anything that reads plain text. What matters more is what you deliberately do
				not use — and double-clicking counts as not choosing, because Windows will
				pick something for you.
			</p>
			<ul class="check">
				<li class="yes">
					<strong>Notepad, or any code editor.</strong> Use <strong>Open with</strong>
					and pick it yourself. An unencrypted maFile shows JSON — curly braces and
					quoted field names; an encrypted one shows a long block of base64
					ciphertext.
				</li>
				<li class="no">
					<strong>Not an online JSON viewer, formatter or "maFile decoder".</strong>
					Never upload either type. Pasting an unencrypted maFile into a web page
					exposes its secrets; uploading an encrypted one exposes sensitive backup
					material that may become readable if its matching manifest and passphrase are
					later obtained — whatever the page promises about not storing anything.
				</li>
				<li class="no">
					<strong>Not an AI chat, a Discord bot or a pastebin.</strong> An unencrypted
					file exposes live secrets immediately; an encrypted one is still sensitive
					backup material. Either way it is now in somebody's logs.
				</li>
				<li class="no">
					<strong>Not a tool that offers to "repair" or "convert" it.</strong> There is
					nothing to convert. A maFile is already text.
				</li>
			</ul>

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
					form — <a href="/support">including ours</a>. Pasting an unencrypted maFile
					hands over its secrets; an encrypted one is still sensitive backup material
					and should not be uploaded either. If the
					<code>shared_secret</code> is readable in what you paste, whoever receives
					it can generate your Steam Guard codes from then until the authenticator is
					detached from the account entirely — the secret does not expire on its own.
					The <code>shared_secret</code> on its own does not hand over the password.
					But a maFile carrying a still-usable session or refresh token may allow
					account actions immediately, and even without one, the second factor stops
					being an obstacle. A compromised <code>shared_secret</code> cannot be fixed
					by changing your password — it takes removing or replacing the
					authenticator.
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
			<ul class="link-cards">
				<li>
					<a href="/what-is-a-mafile"><b>A maFile, field by field</b>
					<span>What each value does, and which ones are the account itself.</span></a>
				</li>
				<li>
					<a href="/encrypted-mafile"><b>When it is encrypted</b>
					<span>The passphrase, the manifest, and why one without the other fails.</span></a>
				</li>
				<li>
					<a href="/import-from-sda"><b>Importing one</b>
					<span>Bringing accounts into this application, and exporting them back out.</span></a>
				</li>
			</ul>
		</article>`
};
