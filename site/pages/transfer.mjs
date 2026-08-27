/**
 * Moving an authenticator, and what Steam charges for each way of doing it.
 *
 * These two pages exist because this project implemented the transfer flow and
 * ran it against a real account, which is an unusual position to write from.
 * Almost everything published about "moving Steam Guard" is written by somebody
 * who has not done it, and it shows: the advice is generally "remove it and add
 * it again", which is the option Valve charges fifteen days for.
 *
 * **The discipline here is the same as everywhere else on this site.** Every
 * duration is quoted from Valve and linked. Where this project observed
 * something first-hand, the page says that it was observed rather than
 * documented, and says what was observed rather than generalising from it. Where
 * neither applies, the page says nothing.
 */

/** Valve's own pages. Every number on these pages comes from one of them. */
const VALVE = {
	guard: 'https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31',
	restrictions: 'https://help.steampowered.com/en/faqs/view/451E-96B3-D194-50FC',
	holds: 'https://help.steampowered.com/en/faqs/view/34A1-EA3F-83ED-54AB'
};

export const tradeHolds = {
	slug: 'steam-guard-trade-holds',
	parent: 'docs',
	guide: true,
	navTitle: 'Trade holds',
	title: 'Steam trade holds: every restriction, and how long each lasts',
	updated: '2026-08-14',
	description:
		'What triggers a Steam trade hold or restriction, how long each one lasts, and which are avoidable. Every duration quoted from Valve and linked.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Steam trade holds and restrictions, by cause and duration',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/steam-guard-trade-holds`
	}),
	// No `s` parameter: this page quotes Valve throughout and never interpolates
	// anything from the site config. Declaring one anyway failed `npm run lint`,
	// which the release workflow runs as a gate.
	body: () => `
		<article class="guide numbered">
			<h1>Steam trade holds: every restriction, and how long each lasts</h1>
			<p class="lede">
				Steam has several different restrictions and they get confused with one another
				constantly — partly because people call all of them &ldquo;the trade hold&rdquo;.
				They have different causes, different lengths, and only some are avoidable. Every
				number below is quoted from Valve.
			</p>

			<div class="answer">
				<span class="eyebrow">Short answer</span>
				<p>
					The two that catch people out are the authenticator ones.
					<strong>Removing a mobile authenticator costs 15 days</strong> of no trading and
					no Market. <strong>Transferring one costs 2 days.</strong> They reach the same
					place, and most guides tell you to do the expensive one.
				</p>
				<p>
					If your items are already held, nothing shortens it. Steam Support cannot lift
					these and no service can.
				</p>
			</div>

			<ul class="stat-strip">
				<li>
					<b>2<small> days</small></b>
					<span>Transferring an authenticator to a new device.</span>
				</li>
				<li class="cost">
					<b>15<small> days</small></b>
					<span>Removing one. Unable to trade or use the Market at all.</span>
				</li>
				<li class="cost">
					<b>15<small> days</small></b>
					<span>Item hold on trades, when the account has no authenticator.</span>
				</li>
			</ul>

			<h2>What is the difference between a hold and a restriction?</h2>
			<p>
				They are not the same thing, and the difference decides what you can still do.
			</p>
			<ul class="check">
				<li class="no">
					<strong>A restriction stops you trading.</strong> You cannot create trades or
					Market listings at all until it ends.
				</li>
				<li class="yes">
					<strong>A hold delays delivery.</strong> The trade goes ahead, but the items sit
					with Steam for a period before they arrive — and either side can cancel during
					it. Valve's stated purpose is that
					<a href="${VALVE.holds}" rel="noopener">holds give you a way to recover items
					before they are lost</a> if somebody else gets into your account.
				</li>
			</ul>

			<h2>What causes each one?</h2>
			<div class="tbl">
				<table>
					<thead>
						<tr><th scope="col">Cause</th><th scope="col">What Steam does</th><th scope="col">How long</th></tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row">Removing a mobile authenticator</th>
							<td>Cannot trade or use the Market</td>
							<td><span class="num warn">15 days</span></td>
						</tr>
						<tr>
							<th scope="row">Transferring one to a new device</th>
							<td>Trade and Market restriction</td>
							<td><span class="num">2 days</span></td>
						</tr>
						<tr>
							<th scope="row">Adding an authenticator</th>
							<td>Trades made in the first 7 days still carry a hold</td>
							<td><span class="num warn">up to 15 days</span></td>
						</tr>
						<tr>
							<th scope="row">No authenticator on the account</th>
							<td>Items held before delivery</td>
							<td><span class="num warn">up to 15 days</span></td>
						</tr>
						<tr>
							<th scope="row">Resetting a forgotten password</th>
							<td>Cannot trade or use the Market</td>
							<td><span class="num warn">5 days</span></td>
						</tr>
						<tr>
							<th scope="row">Account inactive over two months, then a password reset</th>
							<td>Cannot trade or use the Market</td>
							<td><span class="num warn">30 days</span></td>
						</tr>
						<tr>
							<th scope="row">Cancelling a trade that was already accepted</th>
							<td>Cannot trade</td>
							<td><span class="num warn">7 days</span></td>
						</tr>
						<tr>
							<th scope="row">Steam Guard enabled less than 15 days</th>
							<td>Cannot trade or use the Market</td>
							<td><span class="num warn">until 15 days have passed</span></td>
						</tr>
					</tbody>
				</table>
			</div>
			<p class="hint">
				Durations quoted from Valve's
				<a href="${VALVE.restrictions}" rel="noopener">Trading and Market Restrictions</a>,
				<a href="${VALVE.holds}" rel="noopener">Trade and Market Holds</a> and
				<a href="${VALVE.guard}" rel="noopener">Steam Guard Mobile Authenticator</a> pages.
				Where Valve does not state a number, this page does not invent one.
			</p>

			<h2>The 15 days people pay by accident</h2>
			<p>
				Valve is unambiguous about what removing an authenticator costs:
				<a href="${VALVE.restrictions}" rel="noopener">&ldquo;Removing a Steam Guard Mobile
				Authenticator reduces your account security. To help protect your items, you will
				be unable to trade or use the Community Market for 15 days.&rdquo;</a>
			</p>
			<p>
				And about the alternative:
				<a href="${VALVE.guard}" rel="noopener">&ldquo;After transferring the authenticator,
				a 2-day trade and market restriction will be placed on your account to protect your
				items.&rdquo;</a>
			</p>
			<p class="pull">
				Both routes end with the authenticator on the device you wanted it on. One of them
				costs <em>thirteen days more</em> than the other, and it is the one most guides
				describe.
			</p>
			<p>
				It gets worse than the 15 days alone, because the two stack. After the removal
				restriction ends and you add an authenticator again, Valve applies a further rule:
				<a href="${VALVE.restrictions}" rel="noopener">&ldquo;Trades created within the
				first 7 days of adding the authenticator will still have up to a 15 day trade
				hold.&rdquo;</a> So the fortnight of not trading is followed by a week of trades
				that do not deliver promptly.
			</p>

			<h2>Which of these can you avoid?</h2>
			<ul class="check">
				<li class="yes">
					<strong>The removal restriction.</strong> Transfer instead of removing —
					<a href="/move-steam-authenticator-to-pc">this is what the transfer flow is
					for</a>.
				</li>
				<li class="yes">
					<strong>The password-reset restriction.</strong> <em>Changing</em> a password you
					still know, from Steam's settings, costs nothing. Only a
					<em>reset</em> of a forgotten one triggers it.
				</li>
				<li class="no">
					<strong>The no-authenticator hold.</strong> Not avoidable except by having an
					authenticator, which is the point of it.
				</li>
				<li class="no">
					<strong>Any of them, once applied.</strong> Steam Support cannot lift these, and
					anybody offering to is selling something that does not exist.
				</li>
			</ul>

			<div class="callout callout-warn">
				<p>
					<strong>No service can shorten a hold.</strong> These are applied by Steam and
					enforced server-side. An offer to remove one is a way of getting your password,
					your authenticator file, or your items — see
					<a href="/scam-clones">how those approaches work</a>.
				</p>
			</div>

			<h2>Related</h2>
			<ul class="link-cards">
				<li>
					<a href="/move-steam-authenticator-to-pc"><b>Moving an authenticator to a PC</b>
					<span>The 2-day route, and why the 15-day one is so widely recommended.</span></a>
				</li>
				<li>
					<a href="/move-steam-authenticator-new-phone"><b>Moving to a new phone</b>
					<span>The same choice, between two devices you own.</span></a>
				</li>
				<li>
					<a href="/steam-guard-code-not-working"><b>Codes being refused</b>
					<span>Usually the clock, and a reset password can cost you five days.</span></a>
				</li>
			</ul>
		</article>`
};

export const moveToPc = {
	slug: 'move-steam-authenticator-to-pc',
	parent: 'docs',
	guide: true,
	navTitle: 'Move to a PC',
	title: 'Move your Steam authenticator from your phone to a PC',
	updated: '2026-08-14',
	description:
		'Steam can move an authenticator to another device for a 2-day restriction. What the flow actually does, what it costs, and what it requires.',
	sourced: 'Checked against Valve documentation and a transfer performed on a real account',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'TechArticle',
		headline: 'Moving a Steam authenticator from a phone to a desktop',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: '2026-08-14',
		mainEntityOfPage: `${s.origin}/move-steam-authenticator-to-pc`
	}),
	body: (s) => `
		<article class="guide numbered">
			<h1>Move your Steam authenticator from your phone to a PC</h1>
			<p class="lede">
				Steam supports moving an authenticator to a different device, and charges two days
				of trade restriction for it. The advice you will usually find — remove it from the
				phone, then add it somewhere else — is a different operation that costs fifteen.
				This page explains what the supported route actually does.
			</p>

			<div class="answer">
				<span class="eyebrow">Short answer</span>
				<p>
					Steam does not copy the secret off your phone. It
					<strong>replaces</strong> the authenticator: you prove you hold the current one,
					Steam texts a code to the number on the account, and on submitting that code
					Steam issues a brand-new set of secrets to the new device and makes the phone's
					copy inert.
				</p>
				<p>
					<strong>The cost is a 2-day trade and Market restriction</strong>, against
					<a href="/steam-guard-trade-holds">15 days for removing and re-adding</a>.
				</p>
			</div>

			<div class="callout callout-warn">
				<p>
					<strong>Do not remove the authenticator from your phone first.</strong> That is
					the fifteen-day path, and it also leaves the account with no second factor in
					between. The transfer needs the phone's authenticator to still be working,
					because proving you hold it is the first step.
				</p>
			</div>

			<h2>What Steam actually does</h2>
			<p>
				This is worth understanding, because it explains why the phone stops working and why
				nothing needs uninstalling.
			</p>
			<ol class="steps">
				<li>
					<strong>You prove you hold the current authenticator</strong>
					<p>By signing in with a code from it. Nothing has changed at this point.</p>
				</li>
				<li>
					<strong>Steam sends a code to the phone number on the account</strong>
					<p>
						Usually by SMS. It may arrive through a messaging app instead, from a sender
						name you do not recognise — that is normal for the services Steam sends
						through, and it is also exactly what a phishing message looks like, so
						never enter a code you did not just ask for.
					</p>
				</li>
				<li>
					<strong>You submit that code, and Steam rotates the authenticator</strong>
					<p>
						New secrets are issued to the new device. The ones on the phone stop being the
						account's authenticator at that moment. This step cannot be undone.
					</p>
				</li>
				<li>
					<strong>You write down the new recovery code</strong>
					<p>
						Steam issues a fresh one and the old one stops working. It is the only way to
						detach the new authenticator yourself later.
					</p>
				</li>
			</ol>

			<p class="pull">
				Because the replacement happens on Steam's side, there is
				<em>nothing to uninstall</em>. The phone's authenticator is already inert — removing
				it afterwards would be the fifteen-day operation, for no benefit.
			</p>

			<h2>What you need before starting</h2>
			<ul class="check">
				<li class="yes">
					<strong>The authenticator still working on the phone.</strong> It is what proves
					the account is yours.
				</li>
				<li class="yes">
					<strong>Access to the phone number on the account.</strong> Steam texts a code to
					it and there is no way to finish without that code.
				</li>
				<li class="yes">
					<strong>Somewhere to write the new recovery code.</strong> Not on the machine you
					are moving to — that is the one it will not help you with.
				</li>
				<li class="no">
					<strong>Not your old recovery code.</strong> It is void the moment the transfer
					completes.
				</li>
			</ul>

			<h2>What we observed doing this</h2>
			<p>
				This project implemented the flow and ran it against a real account with an active
				authenticator, which is worth reporting because most of what is written about it is
				written by people who have not.
			</p>
			<ul class="check">
				<li class="yes">
					Codes generated on the new device were accepted by Steam immediately.
				</li>
				<li class="yes">
					The account's authenticator was gone from the phone afterwards, and its Steam
					sessions had been signed out — the expected consequence of a server-side
					replacement, with nothing done to the device itself.
				</li>
				<li class="yes">
					The restriction applied was the short one, consistent with Valve's documented
					two days rather than the fifteen a removal carries.
				</li>
			</ul>
			<p class="hint">
				One observation on one account is not a guarantee, and it is reported here as an
				observation rather than as documentation. Where Valve states something, this page
				quotes Valve instead — see
				<a href="${VALVE.guard}" rel="noopener">the Steam Guard Mobile Authenticator
				page</a>.
			</p>

			<h2>Can I use ${s.short} for this?</h2>
			<div class="callout">
				<p>
					<strong>${
						s.release.published ? 'Yes — the transfer is built into the application.' : 'Not yet.'
					}</strong>
					${
						s.release.published
							? 'It uses the flow described above and never substitutes remove-and-add.'
							: `${s.name} implements this flow, and it has been run successfully against a real account — but there is no public release yet, so there is nothing for you to download. <a href="/download">The download page tracks exactly where that stands.</a>`
					}
				</p>
				<p>
					Whatever you use, the thing to check is which operation it performs. Software
					that removes the authenticator and adds a new one has cost you thirteen extra
					days whether or not it says so.
				</p>
			</div>

			<h2>Related</h2>
			<ul class="link-cards">
				<li>
					<a href="/steam-guard-trade-holds"><b>Every trade hold, by cause</b>
					<span>What each restriction is, how long it lasts, and which are avoidable.</span></a>
				</li>
				<li>
					<a href="/steam-mobile-vs-desktop-authenticator"><b>Phone or desktop?</b>
					<span>An honest comparison, including when the answer is to stay on the phone.</span></a>
				</li>
				<li>
					<a href="/steam-revocation-code"><b>Your recovery code</b>
					<span>What the new one does, and why the old one stops working.</span></a>
				</li>
			</ul>
		</article>`
};
