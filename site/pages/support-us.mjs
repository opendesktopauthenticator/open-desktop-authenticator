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
		application. ODA uses it for the Steam authentication exchange.`
	},
	{
		name: 'steam-totp',
		url: 'https://github.com/DoctorMcKay/node-steam-totp',
		role: 'What our own code is checked against',
		body: `Generates the five-character Steam Guard code from a <code>shared_secret</code>,
		and the confirmation key from an <code>identity_secret</code>. We implement both
		ourselves. CI compares code generation against <code>steam-totp</code> in the
		spike tests; the confirmation-key tests use recorded vectors produced by that
		library. A disagreement needs investigation, not an assumption that either
		implementation is infallible.`
	},
	{
		name: 'steamcommunity',
		url: 'https://github.com/DoctorMcKay/node-steamcommunity',
		role: 'A public protocol reference',
		body: `Its mobile confirmation implementation is a useful public reference for
		request shapes and signing conventions. ODA's confirmation client is implemented
		locally; <code>steamcommunity</code> is not a shipped dependency. This credits a
		reference without claiming that one library is the origin of every independent
		authenticator.`
	}
];

export const credits = {
	slug: 'credits',
	updated: '2026-09-12',
	reviewed: '2026-09-12',
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
				ODA depends on public libraries and protocol research from other developers.
				DoctorMcKay's Steam libraries provide a shipped sign-in dependency, test
				references and inspectable examples of Steam's authentication and confirmation
				flows. The specific relationships are listed below.
			</p>

			<div class="origin-note">
				<p>
					<strong>${escape(MCKAY.name)}</strong> has maintained the open-source Steam
					libraries for years under the MIT licence. His
					<a href="${MCKAY.donate}" rel="noopener">donation page</a> explains how
					contributions support his open-source work.
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
				Public implementations let developers compare results, identify mistakes and
				build compatible tools. Credit should identify the code actually used and the
				research consulted; it should not imply that the upstream maintainer reviewed
				or endorses every downstream application.
			</p>
			<p>
				The MIT licence permits reuse, including commercial reuse, subject to its
				notice requirements. It does not require a donation. We do not know the
				maintainer's total funding or employment arrangements; our reason to link his
				donation page is the value of the work we use.
			</p>

			<h2>Donate to him directly</h2>
			<p>
				These destinations match the links on his donation page, checked on
				12 September 2026. Payments do not pass through ODA. The payment platform or
				network may charge fees; check its terms and the destination before sending.
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
				He explains that donations help him continue his open-source work. His page is at
				<a href="${MCKAY.donate}" rel="noopener">dev.doctormckay.com/donate</a>, and his
				repositories are at <a href="${MCKAY.github}" rel="noopener">github.com/DoctorMcKay</a>.
			</p>

			<div class="callout callout-warn">
				<h2>To be completely clear about what this page is</h2>
				<p>
					${escape(s.name)} is an independent project. It is
					<strong>not affiliated with, endorsed by, or connected to
					${escape(MCKAY.name)}</strong>. We do not claim his review or approval.
					We link to him because we depend on his work, not because he
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
		what: 'Website hosting and the domain',
		cost: 'operating costs',
		body: `A small virtual machine and a domain. It serves static files and one small
		process for the report form. The site does not sell advertising space.
		See <a href="/privacy">the privacy page</a> for the website's analytics,
		review widgets and report storage.`
	},
	{
		what: 'Time',
		cost: 'maintenance work',
		body: `Support helps the maintainer make time for fixes, documentation and release
		work. This is a description of intended use, not a published budget or an
		independently audited account of spending.`
	}
];

export const donate = {
	slug: 'donate',
	updated: '2026-10-15',
	reviewed: '2026-10-15',
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
				ODA and this documentation are free. There is no paid tier or ODA account,
				and donating does not unlock features or buy priority support. The project's
				stated plan is to keep it that way.
			</p>

			<h2>What you get either way</h2>
			<p>
				This matters more than the request, so it comes first. Whether or not anybody
				ever donates:
			</p>
			<ul>
				<li>
					<strong>The source is public</strong> under the MIT licence, including
					the code that handles secrets, networking, updates and the interface.
				</li>
				<li>
					<strong>The application has no ODA backend, ODA account, cloud sync or telemetry.</strong>
					Requested Steam operations contact Valve, direct builds from GitHub, Softonic or Uptodown can optionally
					check GitHub for updates, and its browser loads the pages you open and their
					embedded resources. The website has separate analytics and report storage.
					<a href="/security">The security page documents those boundaries</a>.
				</li>
				<li>
					<strong>The scam-clone research stays up</strong>, free to read, with no
					registration and no advertising —
					<a href="/scam-clones">the clone-site page</a>,
					<a href="/verify">the verification instructions</a> and
					<a href="/steam-inventory-stolen">the account of how we learned this</a>.
				</li>
				<li>
					<strong>Reports follow the same triage policy</strong> whether or not the
					person filing one has donated. General support has no guaranteed response time.
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
					depends on his freely available libraries,
					and the dependency runs one way. If you only intend to give once, give it to
					him.
				</p>
				<a class="button" href="/credits">Why, and how →</a>
			</div>

			<h2>Cryptocurrency only</h2>
			<p>
				This page accepts the listed cryptocurrencies and networks only. It does not
				collect card details or create a donor account. <strong>That does not make a
				payment anonymous.</strong> These networks publish transaction records, and a
				wallet or exchange may hold information connecting an address to you. Check
				your provider's privacy terms; <a href="https://ethereum.org/zero-knowledge-proofs" rel="noopener">Ethereum's explanation of public transaction visibility</a>
				describes why pseudonymous payments can be linked to people.
				Donations are optional; do not buy cryptocurrency
				solely because you feel obliged to support this project.
			</p>

			<div class="callout callout-warn">
				<h2>Check the address you paste</h2>
				<p>
					After pasting, compare the address against this page — <strong>all of it, not
					just the ends</strong>. Checking the first and last four characters is a quick
					first look, and it is the check the attack is built to survive: address
					generators produce lookalikes that match at both ends and differ in the
					middle. Confirm the network as well as the address.
				</p>
				<p>
					Check the asset, network and any withdrawal fee in your wallet. A small test
					transfer can help check the route, but recheck the address for the final
					transfer too. Transfers generally cannot be reversed, and sending on the
					wrong network can make funds inaccessible. We cannot guarantee recovery of
					a mistaken payment.
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
				The build validates these address formats. Tron and Litecoin use checksum
				checks; the listed lowercase EVM address is checked for its shape, and the
				Solana address for a valid 32-byte encoding. <strong>Not every typo is caught,
				and no format check proves ownership.</strong>
				<a href="${s.repo}/blob/main/site/addresses.mjs" rel="noopener">Read the exact checks</a>.
			</p>

			<h2>Other ways, if money is not one</h2>
			<p>
				These are worth more than a small donation and cost nothing:
			</p>
			<ul>
				<li>
					<strong><a href="/support">Report a clone site</a></strong> when you find one.
					Send the URL and where you found it, without downloading or running a
					suspected malicious file.
				</li>
				<li>
					<strong>Correct us.</strong> A wrong instruction on
					<a href="/verify">the verification page</a> is worse than no instruction.
				</li>
				<li>
					<strong>Share the verification guide</strong> before somebody runs an
					installer: a checksum alone does not establish who published the file.
				</li>
			</ul>
		</article>`
};
