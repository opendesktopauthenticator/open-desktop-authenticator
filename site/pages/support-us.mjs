/**
 * Two pages about money, neither of which asks for any on its own behalf first.
 *
 * The credit page comes first deliberately. This project runs on somebody else's
 * reverse-engineering, published free under MIT years before we existed, and a
 * site that solicited donations for itself while staying silent about that debt
 * would be describing itself dishonestly.
 */

import { ADDRESSES } from '../addresses.mjs';

const escape = (s) =>
	String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

/*
 * DoctorMcKay's own links, taken from his donation page rather than from
 * anywhere else. The PayPal URL is his canonical `cgi-bin/webscr` form: the
 * shortened variant that gets passed around carries an `ssrt` session parameter
 * belonging to whoever copied it, which does not belong in a published link.
 *
 * Every one of these points at a destination he controls. Nothing here routes a
 * payment through us, and we take no cut, because the moment a third party sits
 * between a donor and a maintainer this stops being credit and starts being
 * collection.
 */
const MCKAY = {
	name: 'DoctorMcKay',
	site: 'https://dev.doctormckay.com/',
	donate: 'https://dev.doctormckay.com/donate/',
	sponsors: 'https://github.com/sponsors/DoctorMcKay',
	paypal: 'https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=UX9VTKTXWLKLW',
	trade: 'https://steamcommunity.com/tradeoffer/new/?partner=46143802&token=KYworVTM',
	github: 'https://github.com/DoctorMcKay'
};

const LIBRARIES = [
	{
		name: 'steam-session',
		url: 'https://github.com/DoctorMcKay/node-steam-session',
		role: 'Shipped in the application',
		body: `The library that performs the sign-in to Steam. This is not inspiration or a
		reference — it is a dependency listed in our <code>package.json</code>, running in the
		application, doing the single most delicate thing it does. Every person who signs in
		is running his code.`
	},
	{
		name: 'steam-totp',
		url: 'https://github.com/DoctorMcKay/node-steam-totp',
		role: 'What our own code is checked against',
		body: `Generates the five-character Steam Guard code from a <code>shared_secret</code>,
		and the confirmation key from an <code>identity_secret</code>. We implement both
		ourselves, and a test compares our output against his on every push. When the two
		disagree, we are the ones who are wrong.`
	},
	{
		name: 'steamcommunity',
		url: 'https://github.com/DoctorMcKay/node-steamcommunity',
		role: 'How the protocol became public',
		body: `The mobile confirmation flow — the request shape, the signing, the tags — is
		documented nowhere by Valve. It is public because this library made it public, and
		anything that approves a trade outside the official app is downstream of that.`
	}
];

export const credits = {
	slug: 'credits',
	navTitle: 'Credits',
	title: 'The work this is built on, and how to pay for it',
	description:
		'This project runs on DoctorMcKay’s open-source Steam libraries. What each one does, why we need them, and how to donate to the person who wrote them.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: 'The work Open Desktop Authenticator is built on',
		description:
			'The open-source Steam libraries by DoctorMcKay that this project depends on, and how to support that work.',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/credits`
	}),
	body: (s) => `
		<article>
			<h1>The work this is built on</h1>
			<p class="lede">
				There is a reason an independent Steam authenticator can exist at all, and it is
				not us. Valve publishes no specification for Steam Guard. The algorithm behind
				the five-character code, the signing behind a mobile confirmation, the shape of
				the login exchange — none of it is documented by the people who built it. It is
				public because someone worked it out and gave it away.
			</p>

			<div class="origin-note">
				<p>
					<strong>${escape(MCKAY.name)}</strong> has maintained the open-source Steam
					libraries that most of this ecosystem runs on, for years, under the MIT
					licence — which is to say he did the hard part and then asked for nothing.
				</p>
				<a class="button" href="${MCKAY.donate}" rel="noopener">Donate to him →</a>
			</div>

			<h2>What we actually use</h2>
			<p>
				Stated precisely, because vague gratitude is worth less than an accurate
				account of the debt:
			</p>
			<ul class="thread">
${LIBRARIES.map(
	(l) => `				<li class="message message-us">
					<div class="message-head">
						<span class="message-who"><a href="${l.url}" rel="noopener">${escape(l.name)}</a></span>
						<span class="message-when">${escape(l.role)}</span>
					</div>
					<p>${l.body}</p>
				</li>`
).join('\n')}
			</ul>

			<h2>Why this matters more than a credits line</h2>
			<p>
				Everything on this site argues the same point: that you should not have to trust
				a stranger with the keys to your Steam account, because you can check the thing
				instead. That argument only works if there is something to check — an
				alternative that is open, inspectable and not the only game in town.
			</p>
			<p>
				Without that reverse-engineering published openly, there is no ecosystem. There
				is Valve's app, and there is whatever an anonymous download page hands you, and
				nothing in between. <strong>The clone sites we spend this whole domain warning
				people about exist precisely because the demand is real and the legitimate
				options are few.</strong> Every open, checkable option makes that gap smaller,
				and all of them rest on the same foundation.
			</p>
			<p>
				He is not paid for this. There is no company behind those repositories. The
				libraries are MIT-licensed, which means anyone — including us, including people
				selling things — can take the work and owe nothing back. That is generous to the
				point of being a bad deal for him, and it is the reason the deal exists for
				everyone else.
			</p>

			<h2>Donate to him directly</h2>
			<p>
				All three go to him. Nothing routes through us, and we take nothing — the moment
				anyone sits between a donor and a maintainer this stops being credit and starts
				being collection.
			</p>
			<div class="give">
				<a class="give-card" href="${MCKAY.sponsors}" rel="noopener">
					<span class="give-what">GitHub Sponsors</span>
					<span class="give-detail">Recurring or one-off, through GitHub</span>
				</a>
				<a class="give-card" href="${MCKAY.paypal}" rel="noopener">
					<span class="give-what">PayPal</span>
					<span class="give-detail">One-off, any amount</span>
				</a>
				<a class="give-card" href="${MCKAY.trade}" rel="noopener">
					<span class="give-what">Steam items</span>
					<span class="give-detail">A trade offer, if you have spares</span>
				</a>
			</div>
			<p class="hint">
				In his own words: &ldquo;If my work helped you or saved you time, please consider
				donating. Donations of any size are greatly appreciated.&rdquo; His page is at
				<a href="${MCKAY.donate}" rel="noopener">dev.doctormckay.com/donate</a>, and his
				repositories are at <a href="${MCKAY.github}" rel="noopener">github.com/DoctorMcKay</a>.
			</p>

			<div class="callout callout-warn">
				<h2>To be completely clear about what this page is</h2>
				<p>
					${escape(s.name)} is an independent project. It is
					<strong>not affiliated with, endorsed by, or connected to
					${escape(MCKAY.name)}</strong>, who has no involvement in it and has not
					reviewed it. We link to him because we depend on his work, not because he
					vouches for ours. Verify the addresses on
					<a href="${MCKAY.donate}" rel="noopener">his own donation page</a> before
					sending anything — including the links above, and including because we said so.
				</p>
			</div>

			<h2>If you would rather support this project</h2>
			<p>
				Consider him first; the dependency runs one way. If you still want to,
				<a href="/donate">the donations page</a> explains what it pays for.
			</p>
		</article>`
};

/* ------------------------------------------------------------------ ours -- */

const SPENDS = [
	{
		what: 'A code-signing certificate',
		cost: 'the largest single cost',
		body: `An unsigned Windows installer shows a blue warning telling people not to run it.
		That warning is the correct advice for an unsigned binary, and it is also the reason
		an honest small project looks more suspicious than a well-funded scam that bought a
		certificate. It is the largest single cost left. Packaging, installers and published
		checksums and a signature over them shipped with 1.0. A certificate for the
		binaries themselves has not arrived yet, and neither has a reproducible build
		others can compare against.
		<a href="/download">The download page tracks where each one stands.</a>`
	},
	{
		what: 'The server this runs on',
		cost: 'a few pounds a month',
		body: `A small virtual machine and a domain. It serves static files and one small
		process for the report form. There is no advertising network and no paid third-party
		service behind it — the third-party scripts are Google Analytics and Cloudflare's
		Web Analytics, both free and both
		<a href="/privacy">described on the privacy page</a>.`
	},
	{
		what: 'Time',
		cost: 'the honest answer',
		body: `Written outside the hours that pay for anything. Donations do not fund a salary
		and it would be a lie to imply otherwise — they make the unpaid hours easier to
		justify against the paid ones.`
	}
];

export const donate = {
	slug: 'donate',
	navTitle: 'Donate',
	script: 'support.js',
	title: 'Donate to Open Desktop Authenticator',
	description:
		'What donations pay for and what this project gives away regardless. Cryptocurrency addresses for USDT on Tron, Polygon, BSC and Solana, and for Litecoin.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'WebPage',
		name: 'Donate to Open Desktop Authenticator',
		description: 'How to support the project, and what the money is spent on.',
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/donate`
	}),
	body: (s) => `
		<article>
			<h1>Donate</h1>
			<p class="lede">
				Everything here is free and stays free. There is no paid tier to unlock, no
				account to create, nothing withheld from people who do not pay, and no plan to
				introduce any of those. Donating changes nothing about what you get, which is
				the only honest basis on which to ask.
			</p>

			<h2>What you get either way</h2>
			<p>
				This matters more than the request, so it comes first. Whether or not anybody
				ever donates:
			</p>
			<ul>
				<li>
					<strong>Every line stays public</strong>, under the MIT licence — including
					the parts that handle your secrets, which is the only part that matters.
				</li>
				<li>
					<strong>The application collects nothing.</strong> No telemetry, no accounts, no server
					of ours that your secrets could be sent to, because
					<a href="/security">there is no server in the design at all</a>.
				</li>
				<li>
					<strong>The scam-clone research stays up</strong>, free to read, with no
					registration and no advertising —
					<a href="/scam-clones">the clone-site page</a>,
					<a href="/verify">the verification instructions</a> and
					<a href="/steam-inventory-stolen">the account of how we learned this</a>.
				</li>
				<li>
					<strong>Reports get answered</strong> whether or not the person filing one
					has ever given us anything.
				</li>
			</ul>

			<h2>What it pays for</h2>
			<dl class="defs">
${SPENDS.map(
	(x) => `				<dt>${escape(x.what)} <span class="muted">— ${escape(x.cost)}</span></dt>
				<dd>${x.body}</dd>`
).join('\n')}
			</dl>

			<div class="origin-note">
				<p>
					<strong>Before you consider us, consider
					<a href="/credits">${escape(MCKAY.name)}</a>.</strong> This application
					depends on his libraries, he has been maintaining them for free for years,
					and the dependency runs one way. If you only intend to give once, give it to
					him.
				</p>
				<a class="button" href="/credits">Why, and how →</a>
			</div>

			<h2>Cryptocurrency only</h2>
			<p>
				There is no card payment here, and that is a deliberate limitation rather than
				an oversight. Taking cards means a payment processor, a merchant account and a
				billing relationship — a stack of third parties holding donor names and card
				details, attached to a project whose entire argument is that it holds nothing
				about you. Crypto keeps that promise intact. It is worse for donors in every
				other way, and we would rather be inconvenient than contradict ourselves.
			</p>

			<div class="callout callout-warn">
				<h2>Check the address you paste</h2>
				<p>
					After pasting, compare the <strong>first four and last four characters</strong>
					against this page. Clipboard-replacing malware is real, it targets exactly
					this moment, and those eight characters are the whole defence. This is the
					same advice we give about downloads, and it applies to us too — a payment
					address is unrecoverable in a way almost nothing else is.
				</p>
			</div>

			<ul class="wallets" data-wallets>
${ADDRESSES.map(
	(a) => `				<li class="wallet">
					<div class="wallet-head">
						<span class="wallet-asset">${escape(a.asset)}</span>
						<span class="wallet-chain">${escape(a.chain)}</span>
					</div>
					<p class="hint">${escape(a.note)}</p>
					<div class="wallet-address">
						<code id="addr-${escape(a.id)}">${escape(a.address)}</code>
						<button type="button" class="secondary" data-copy="addr-${escape(a.id)}">Copy</button>
					</div>
				</li>`
).join('\n')}
			</ul>

			<p class="hint">
				These four addresses are checked against their own checksums every time this
				site is built, so a typo introduced by an edit cannot reach the page —
				<a href="${s.repo}/blob/main/site/addresses.mjs" rel="noopener">the check is in
				the repository</a> like everything else.
			</p>

			<h2>Other ways, if money is not one</h2>
			<p>
				These are worth more than a small donation and cost nothing:
			</p>
			<ul>
				<li>
					<strong><a href="/support">Report a clone site</a></strong> when you find one.
					The list is only as good as what people send, and a fake ranking today is an
					inventory gone next week.
				</li>
				<li>
					<strong>Correct us.</strong> A wrong instruction on
					<a href="/verify">the verification page</a> is worse than no instruction.
				</li>
				<li>
					<strong>Tell somebody to check a checksum</strong> before they run an
					installer. That single habit is the whole point of this site.
				</li>
			</ul>
		</article>`
};
