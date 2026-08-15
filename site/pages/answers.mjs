/**
 * Pages that answer a question somebody is actually typing.
 *
 * **On how these were chosen.** There is no query data for this domain yet — it
 * has never been served to the public, so Search Console has nothing and there
 * is no analytics history to read. Anyone claiming otherwise would be inventing
 * numbers. These three exist because they cover distinct intents the rest of the
 * site could not answer at all:
 *
 *  - someone who has read the word "maFile" and does not know what it is;
 *  - someone who has already lost access and is looking for a way back, which is
 *    the highest-urgency moment in this whole subject;
 *  - someone explicitly shopping for something other than SDA.
 *
 * Each is a page we can write better than a content farm, because the answers
 * come from having implemented the format and the recovery paths. That is the
 * only durable reason to rank for anything.
 */

export const mafile = {
	slug: 'what-is-a-mafile',
	updated: '2026-08-14',
	navTitle: 'maFiles',
	title: 'What is a .maFile?',
	description:
		'A maFile is your Steam authenticator in a file: shared secret, identity secret, revocation code. What is inside one, how it is encrypted, how to handle it.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'What is a .maFile?',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: s.updated,
		mainEntityOfPage: `${s.origin}/what-is-a-mafile`
	}),
	body: () => `
		<article>
			<h1>What is a <code>.maFile</code>?</h1>
			<p class="lede">
				A maFile is a small JSON file holding one Steam account's authenticator. Not a
				copy of it, not a reference to it — the authenticator itself. Anyone with the
				<code>shared_secret</code> from it can generate that account's Steam Guard
				codes; with the <code>identity_secret</code> <em>and</em> a valid Steam
				session they can also
				<a href="/approve-steam-confirmations-desktop">approve confirmations</a>. A
				maFile can carry session material too, which is why losing one is treated here
				as losing the account.
			</p>

			<h2>What is inside one</h2>
			<dl class="defs">
				<dt><code>shared_secret</code></dt>
				<dd>
					The seed the login codes are generated from. Base64, twenty bytes decoded.
					Combined with the current thirty-second time window it produces the five
					characters you type into Steam. It never expires and never changes.
				</dd>
				<dt><code>identity_secret</code></dt>
				<dd>
					The seed used to sign trade and market confirmations. This is the dangerous
					one: it is what lets software approve a trade on your behalf.
				</dd>
				<dt><code>revocation_code</code></dt>
				<dd>
					Short, in the form <code>R12345</code>. One of the ways to detach the
					authenticator yourself — the one that still works when the device is gone
					and no phone number is linked.
					<a href="https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31" rel="noopener">Valve also documents</a> removing it from
					inside the Steam Mobile App, transferring it to a new device with an SMS
					code if you no longer have the old one, and printed backup codes. <a href="/lost-authenticator">Losing it is a
					different kind of problem</a>.
				</dd>
				<dt><code>Session</code></dt>
				<dd>
					Login tokens for the account. These do expire, which is why an old maFile
					often still generates valid codes but cannot fetch confirmations until you
					sign in again.
				</dd>
				<dt><code>account_name</code>, <code>steamid</code>, <code>device_id</code></dt>
				<dd>
					Identifying fields. The SteamID is a 64-bit number — large enough that
					software handling it as a floating-point number silently corrupts the last
					digits, which is a real and common bug.
				</dd>
			</dl>

			<h2>Encrypted maFiles</h2>
			<p>
				SDA can encrypt them. When it does, the file's contents are base64 ciphertext
				and the parameters needed to decrypt — the salt and the initialisation vector —
				are stored separately in <code>manifest.json</code>, keyed by SteamID.
			</p>
			<p>
				The practical consequences catch people out regularly:
			</p>
			<ul>
				<li>
					<strong>Copying only the <code>.maFile</code> to a new machine leaves you
					with something you cannot open.</strong> You need the manifest too.
				</li>
				<li>
					An encrypted maFile is not a backup of a readable maFile. If you lose the
					passphrase, the contents are gone the same way any AES ciphertext is gone.
				</li>
				<li>
					Encryption protects the file at rest on your disk. It does not protect it
					from a program you willingly type the passphrase into.
				</li>
			</ul>

			<h2>How to handle one</h2>
			<ul>
				<li>
					<strong>Treat it as more valuable than the account password.</strong> A
					password can be changed in a minute. A leaked shared secret keeps working
					until the authenticator is detached from Steam entirely.
				</li>
				<li>
					<strong>Never upload one anywhere.</strong> Not to a support ticket, not to a
					"maFile checker", not to a Discord bot, not to us. No legitimate service
					needs it.
				</li>
				<li>
					<strong>Keep the revocation code somewhere the file is not.</strong> A backup
					that loses both at once has not backed anything up.
				</li>
				<li>
					<strong>Be careful which program opens it.</strong>
					<a href="/scam-clones">Counterfeit authenticators exist specifically to be
					handed maFiles.</a>
				</li>
			</ul>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-desktop-authenticator">Steam Desktop Authenticator explained</a></li>
				<li><a href="/how-to-open-mafile">How to open one safely</a></li>
				<li><a href="/encrypted-mafile">Encrypted maFiles, and the manifest they need</a></li>
				<li><a href="/import-from-sda">Importing maFiles into this application</a></li>
				<li><a href="/lost-authenticator">If you have lost access to your authenticator</a></li>
			</ul>
		</article>`
};

export const lostAuthenticator = {
	slug: 'lost-authenticator',
	// Edited 14 Aug (UTC) to drop the unsupported Support durations. Without
	// this the page inherits SITE.updated and advertises a stale lastmod.
	updated: '2026-08-14',
	navTitle: 'Lost access',
	title: 'Lost your Steam authenticator?',
	description:
		'Lost Steam authenticator? The order to try things in, with or without a revocation code, and what Steam Support can and cannot do for you.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Recover access after losing a Steam authenticator',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Find any surviving copy of the secret' },
			{ '@type': 'HowToStep', name: 'Use the revocation code if you have it' },
			{ '@type': 'HowToStep', name: 'Use Steam Support if you do not' }
		]
	}),
	body: () => `
		<article>
			<h1>Lost your Steam authenticator?</h1>
			<p class="lede">
				A dead phone, a wiped machine, a deleted folder. This page is the order to try
				things in, from the option that takes a minute to the one that hands the
				problem to Steam Support. Work down it — do not skip to the bottom.
			</p>

			<div class="callout callout-warn">
				<p>
					<strong>Everything on this page happens on Steam's own site or in Steam's own
					app.</strong> Searching for a tool that promises to recover a Steam
					authenticator will find you something that steals accounts. There is no such
					tool and there cannot be one.
				</p>
			</div>

			<h2>1. Is there a copy of the secret anywhere?</h2>
			<p>
				More recoverable than people assume. Any of these is a working authenticator:
			</p>
			<ul>
				<li>A <code>.maFile</code> in an old SDA folder, or in a backup of one.</li>
				<li>
					The same folder on a machine you still have — an old laptop, a drive you kept.
					<a href="/what-is-a-mafile">Encrypted ones also need
					<code>manifest.json</code></a>.
				</li>
				<li>Steam still signed in on another device, which can often re-add Steam Guard.</li>
			</ul>
			<p>
				If you find one, import it somewhere you control and confirm it produces codes
				Steam accepts before you rely on it.
			</p>

			<h2>2. Is a phone number still linked to the account?</h2>
			<p>
				If it is, you may not need the recovery code at all.
				<a href="https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31" rel="noopener">Valve's own instructions</a> say that when you
				no longer have access to your authenticator, you can choose
				<em>"I no longer have access to my authenticator"</em> at the sign-in
				confirmation and transfer it to a new device using an SMS code sent to that
				number. Printed backup codes, if you made a set, work here too. Both are
				self-service and neither needs a support ticket.
			</p>

			<h2>3. Do you have the revocation code?</h2>
			<p>
				It looks like <code>R12345</code> and was shown when the authenticator was first
				added. With it, you can remove the authenticator yourself from Steam's help
				pages, then set a new one up. This is the fast path: minutes, not days.
			</p>
			<p>
				Removing the authenticator puts a hold on trading and the Market for a period.
				That is Steam's rule, not something a tool can shorten — anything advertising
				otherwise is a scam.
			</p>

			<h2>4. No recovery code and no phone number</h2>
			<p>
				Then it is Steam Support, through a help request to remove the authenticator.
				Expect to prove ownership: purchase history, payment details, the original email
				address, when the account was created. It is slower than the routes above
				because Steam verifies ownership before detaching a second factor, and it
				generally works if the account is genuinely yours.
			</p>
			<p>
				Nobody else can do this for you. A service offering to recover a Steam account
				is either lying or planning to sell it.
			</p>

			<h2>Making sure this does not happen again</h2>
			<ul>
				<li>
					<strong>Write the revocation code on paper.</strong> Not in the same place as
					the maFile, and not only on the machine that holds it.
				</li>
				<li>
					<strong>Keep an offline copy of the secret</strong> somewhere encrypted that
					is not the computer you use every day.
				</li>
				<li>
					<strong>Test the backup once.</strong> An untested backup is a belief, not a
					backup.
				</li>
			</ul>
			<p>
				This is the reasoning behind two decisions in our own application: a recovery
				file is written the moment an account is enrolled rather than when someone
				remembers to ask, and it is deliberately kept when an account is removed —
				because that is exactly the moment people discover they needed it.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-revocation-code">The revocation code, in detail</a></li>
				<li><a href="/what-is-a-mafile">What is inside a maFile</a></li>
				<li><a href="/security">How this application stores and protects secrets</a></li>
				<li><a href="/scam-clones">Why "recovery tools" are the wrong search</a></li>
			</ul>
		</article>`
};

export const alternatives = {
	slug: 'alternatives',
	updated: '2026-08-14',
	navTitle: 'Alternatives',
	title: 'Steam authenticator alternatives to SDA, compared',
	description:
		'Steam authenticator alternatives compared honestly: Steam Mobile, SDA and Open Desktop Authenticator — including where the right answer is not ours.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: 'Steam authenticator options compared',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: s.updated,
		mainEntityOfPage: `${s.origin}/alternatives`
	}),
	body: () => `
		<article>
			<h1>Steam authenticator alternatives to SDA, compared</h1>
			<p class="lede">
				Three realistic options, and the honest case for each — including the one where
				the answer is not us. We would rather you chose correctly than chose ours.
			</p>

			<h2>Steam Mobile — the default, and the right answer for most people</h2>
			<p>
				Valve's own app. It is maintained by the people who run the service, it comes
				from Apple's or Google's store rather than a search result — so it is far
				harder to substitute a fake, though phishing pages still imitate Steam's
				branding — and losing your phone is a recoverable problem rather than a
				catastrophe.
			</p>
			<p>
				<strong>Choose it if:</strong> you are not confirming listings in bulk, you are
				not sure what a maFile is, or you would rather not be responsible for storing a
				secret. This is not a consolation prize — it is the safest option available and
				most people should stop here.
			</p>
			<p>
				<strong>Against it:</strong> confirming thirty market listings means thirty taps.
				Codes have to be read and retyped. The secret lives on a device that can break.
			</p>

			<h2>Steam Desktop Authenticator — the incumbent</h2>
			<p>
				The tool most traders have used for years, and the reason this category exists.
				It works, it is widely understood, and there is a large body of community
				knowledge about it.
			</p>
			<p>
				<strong>Choose it if:</strong> you already use it, it works for you, and you got
				it from its own repository.
			</p>
			<p>
				<strong>Against it:</strong> its name is what the counterfeit sites rank for, so
				every new user has to run a gauntlet to get a genuine copy.
				<a href="/scam-clones">The clone problem is real and specific</a>, and it is a
				problem of the ecosystem around the tool rather than of the tool itself.
			</p>

			<h2>Open Desktop Authenticator — this project</h2>
			<p>
				An independent implementation built around one idea: you should not have to
				trust us. Public source, built in public CI, no self-updating, and
				<a href="/security">a documented security model that includes what it cannot
				protect you from</a>. Checksums, release signatures and reproducible builds are
				required before the first release rather than done —
				<a href="/download">the download page says where each one stands</a>.
			</p>
			<p>
				<strong>Choose it if:</strong> you want a desktop authenticator and you want to
				be able to check what it does — or have somebody else check.
			</p>
			<p>
				<strong>Against it, plainly:</strong> it is new. It has no public release yet, no
				years of community scrutiny behind it, and no track record. Those are real
				disadvantages and no amount of open source substitutes for them. If that matters
				more to you than auditability, one of the options above is the better choice
				today.
			</p>

			<h2>The comparison that actually matters</h2>
			<p>
				Not the feature list — the failure modes. Ask of any authenticator, including
				ours:
			</p>
			<ol>
				<li><strong>Can I verify that what I ran is what was published?</strong></li>
				<li><strong>Where does the secret live, and who else can read it?</strong></li>
				<li><strong>What happens when I lose the device?</strong> <a href="/lost-authenticator">Answer that before you need it.</a></li>
				<li><strong>Can it update itself?</strong> If yes, whoever controls the update controls the secret.</li>
				<li><strong>What can it approve without asking me?</strong></li>
			</ol>
			<p>
				A tool that answers those five well is a tool worth using, whoever wrote it.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-mobile-vs-desktop-authenticator">Mobile app or desktop: an honest comparison</a></li>
				<li><a href="/steam-desktop-authenticator">Steam Desktop Authenticator explained</a></li>
				<li><a href="/verify">How to verify any download</a></li>
				<li><a href="/download">Our release status</a></li>
			</ul>
		</article>`
};
