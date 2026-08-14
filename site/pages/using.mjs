/**
 * Pages for somebody choosing an authenticator, or working out how to use one.
 *
 * The rescue pages in rescues.mjs catch people mid-accident. These catch them
 * earlier — deciding, or trying to do a thing they have not done before — which
 * is a different register: less urgency, more comparison, and a much stronger
 * obligation to be even-handed.
 *
 * **The comparison page recommends Steam's own app for most readers.** That is
 * not modesty for its own sake; it is true, and a comparison that concludes in
 * favour of whoever wrote it is worth nothing to the person reading it. The
 * readers for whom a desktop authenticator is genuinely the better answer can
 * recognise themselves from an honest description of the trade, and the rest
 * are better served elsewhere. A page that sends them there is doing its job.
 */

export const confirmationsOnDesktop = {
	slug: 'approve-steam-confirmations-desktop',
	navTitle: 'Confirmations on PC',
	title: 'Approving Steam trade confirmations from your PC',
	updated: '2026-08-14',
	description:
		'How Steam trade and market confirmations are actually signed, what it means to approve them from a desktop, and the risk that comes with letting software do it.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Approving Steam trade confirmations from your PC',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/approve-steam-confirmations-desktop`
	}),
	body: (s) => `
		<article>
			<h1>Approving Steam trade confirmations from your PC</h1>
			<p class="lede">
				Every trade and every Market listing needs a second approval after you click
				accept. Steam's own answer is the phone in your pocket. It is not the only
				thing that can do it — and understanding why explains both the appeal and the
				danger of doing it on a desktop.
			</p>

			<h2>What a confirmation actually is</h2>
			<p>
				When you accept a trade, Steam does not simply take your word for it. It
				creates a pending confirmation and waits for something holding your
				authenticator's <code>identity_secret</code> to sign it. That signature is the
				approval. The phone app signs it when you tap accept; nothing else about the
				tap matters.
			</p>
			<p>
				Which leads to the fact that governs this entire page:
				<strong>anything holding the identity secret can approve your trades, whether
				or not you are watching.</strong> That is not a flaw in Steam's design — it is
				the design. The secret <em>is</em> the authority.
			</p>

			<h2>So how does a desktop tool do it?</h2>
			<p>
				By holding that same secret. A desktop authenticator imports it from a
				<a href="/what-is-a-mafile">maFile</a> or receives it when the authenticator is
				first created, then signs confirmations the same way the phone does. Steam
				cannot tell the difference and does not try to — a valid signature is a valid
				signature.
			</p>
			<p>
				This is why the honest framing of "approve confirmations on PC" is not a
				convenience feature. It is a transfer of authority from a device you carry to
				a machine that is often left running.
			</p>

			<h2>Why people want it anyway</h2>
			<ul>
				<li>
					<strong>Volume.</strong> Confirming forty Market listings one at a time on a
					phone is genuinely miserable. On a desktop they can be reviewed as a list.
				</li>
				<li>
					<strong>Several accounts.</strong> Switching the phone app between accounts
					for each confirmation is slow enough that people stop checking properly,
					which is its own security problem.
				</li>
				<li>
					<strong>No usable phone.</strong> A broken handset does not have to stop
					trading. <a href="/steam-guard-without-phone">There is more on that here.</a>
				</li>
			</ul>

			<h2>The question to ask any tool that offers this</h2>
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
				the vault locks on idle and on suspend. The secrets themselves stay
				<a href="/security">encrypted on disk and never leave the machine</a>.
			</p>
			<p>
				A tool that cannot answer those two questions clearly is asking you to hand
				over trade authority on trust alone.
			</p>

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
					made by Valve, it recovers through your phone number when things go wrong,
					and there is no file for anyone to steal. For the large majority of Steam
					accounts that is simply the correct answer, and no feature below outweighs
					it.
				</p>
			</div>

			<h2>Where the mobile app is genuinely better</h2>
			<dl class="defs">
				<dt>Recovery</dt>
				<dd>
					This is the big one. Lose your phone and Steam can text the number on the
					account to get you back. Lose a desktop authenticator's file with no backup
					and your route back is the <a href="/steam-revocation-code">revocation
					code</a> or a support ticket that takes days.
				</dd>
				<dt>Nothing to steal</dt>
				<dd>
					The secret never exists as a file you could accidentally upload, sync to
					cloud storage, or hand to the wrong program. A desktop authenticator's
					entire risk model starts with the fact that it does.
				</dd>
				<dt>It is official</dt>
				<dd>
					No third party between you and Valve. Every desktop option, ours included,
					asks you to trust somebody else with the most sensitive thing on the
					account.
				</dd>
				<dt>It cannot be left running</dt>
				<dd>
					A phone in your pocket is not a machine sitting unattended with your trade
					authority loaded into it.
				</dd>
			</dl>

			<h2>Where a desktop authenticator is genuinely better</h2>
			<dl class="defs">
				<dt>Many accounts</dt>
				<dd>
					Switching the phone app between accounts for every code and every
					confirmation is slow enough that people start rushing the checks. Several
					accounts side by side on one screen is not merely faster, it is more
					careful.
				</dd>
				<dt>Trading volume</dt>
				<dd>
					<a href="/approve-steam-confirmations-desktop">Confirming Market listings in
					bulk</a> on a phone is genuinely painful work.
				</dd>
				<dt>No smartphone, or no wish to use one</dt>
				<dd>
					Some people do not have a suitable handset; some will not install the app.
					<a href="/steam-guard-without-phone">This is the page for that.</a>
				</dd>
				<dt>Backups you control</dt>
				<dd>
					A file can be copied deliberately and kept somewhere safe. That is the same
					property as the risk — it cuts both ways, honestly.
				</dd>
			</dl>

			<h2>The decision, stated plainly</h2>
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
				You can also do both: the secret is the same either way, so an account can be
				held on the phone and imported to a desktop tool as well. Two copies mean two
				places it could leak from — and also two places it can be recovered from.
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
				<li><a href="/steam-desktop-authenticator">Steam Desktop Authenticator, explained</a></li>
			</ul>
		</article>`
};

export const withoutPhone = {
	slug: 'steam-guard-without-phone',
	navTitle: 'Without a phone',
	title: 'Steam Guard without a smartphone',
	updated: '2026-08-14',
	description:
		'Whether you can run Steam Guard with no smartphone, what Steam still needs a phone number for, and when it sends the setup code by email instead.',
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
				Short answer: yes, the authenticator itself can live on a PC instead of a
				phone. But "without a phone" hides two different questions, and Steam treats
				them very differently.
			</p>

			<h2>The two questions</h2>
			<ol>
				<li>
					<strong>Can the authenticator run somewhere other than a smartphone?</strong>
					Yes. The authenticator is a secret plus a clock, and a desktop can hold both
					— that is what <a href="/steam-desktop-authenticator">desktop
					authenticators</a> are.
				</li>
				<li>
					<strong>Can the account have no phone number at all?</strong> Mostly no, and
					this is where people get stuck. Steam generally wants a confirmed phone
					number on the account before it will attach an authenticator.
				</li>
			</ol>

			<h2>What Steam asks for at setup</h2>
			<p>
				When something asks Steam to add an authenticator, Steam usually texts a
				confirmation code to the number on the account. If there is no confirmed
				number, Steam commonly refuses outright, with an error that amounts to
				<em>add and verify a phone number first</em>. Adding a number is done on Steam
				itself — no third-party tool can do it for you, and any offering to should be
				closed immediately.
			</p>
			<p>
				There is a real exception, and it is not widely documented:
				<strong>some accounts with no phone still enrol, and Steam sends the activation
				code by email instead.</strong> We know because our own enrollment handles both
				— it decides which one to expect from Steam's response rather than assuming SMS,
				and a live run against an account without a phone confirmed the email path
				works. Whether your account gets it appears to be Steam's call, not something
				you can request.
			</p>

			<h2>The recovery problem this creates</h2>
			<div class="callout callout-warn">
				<p>
					<strong>A phone number is the easiest way back into a locked-out account.</strong>
					Without one, losing your authenticator means the
					<a href="/steam-revocation-code">revocation code</a> or a Steam Support
					ticket that takes days. If you are deliberately running without a phone
					number, writing the revocation code down stops being good practice and
					becomes the only thing standing between you and support.
				</p>
			</div>

			<h2>If you have a phone but will not install the app</h2>
			<p>
				A common and reasonable position — the number stays on the account for
				recovery, and the codes come from your PC. This is the configuration a desktop
				authenticator suits best: you keep Steam's easy recovery path <em>and</em> the
				convenience of codes and
				<a href="/approve-steam-confirmations-desktop">confirmations on the machine you
				are already using</a>.
			</p>

			<h2>What you are taking on</h2>
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
	title: 'How to open a .maFile safely',
	updated: '2026-08-14',
	description:
		'A maFile is plain JSON you can read in Notepad. How to inspect one safely, and why loading it into a tool is a much bigger decision than reading it.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Open and inspect a Steam maFile safely',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Copy the file before touching it' },
			{ '@type': 'HowToStep', name: 'Open the copy in a plain text editor' },
			{ '@type': 'HowToStep', name: 'Check whether it is readable or encrypted' },
			{ '@type': 'HowToStep', name: 'Decide what may actually load it' }
		]
	}),
	body: (s) => `
		<article>
			<h1>How to open a <code>.maFile</code> safely</h1>
			<p class="lede">
				There is no special program needed to look inside one. A maFile is a small
				text file, and a text editor will show you everything in it. The care required
				is not technical — it is about what you do with the file afterwards.
			</p>

			<h2>1. Work on a copy</h2>
			<p>
				Before anything else, copy the file somewhere else and work on the copy. A
				maFile is frequently the only surviving record of an authenticator, and a text
				editor that helpfully saves a change to it can corrupt the JSON. Never edit
				the original.
			</p>

			<h2>2. Open the copy in a plain text editor</h2>
			<p>
				Notepad on Windows, or any code editor. Do not double-click the file and let
				Windows pick something; choose the editor deliberately with
				<strong>Open with</strong>. What you should see is JSON — curly braces and
				quoted field names.
			</p>

			<h2>3. Work out which kind you have</h2>
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
					<strong>Reading it is safe. Uploading it is not.</strong> Do not paste the
					contents into a website, a Discord bot, a pastebin, an AI chat, or a support
					form — <a href="/support">including ours</a>. Anyone who receives that text
					can generate your codes and approve your trades from then until the
					authenticator is detached from the account entirely.
				</p>
			</div>

			<h2>4. The decision that actually matters</h2>
			<p>
				"Opening" a maFile in an authenticator is a much larger act than reading it.
				You are handing a program the authority to act as your account — permanently,
				because <a href="/what-is-a-mafile">these secrets never expire</a>. Steam
				cannot tell that program apart from you.
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
