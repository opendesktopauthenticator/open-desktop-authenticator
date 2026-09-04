/**
 * What is held, for how long, and how to have it removed.
 *
 * Written after an audit pointed out that a site processing report text, contact
 * addresses, screenshots and video had no privacy page at all — and that the
 * backend deleted nothing, so there would have been no retention policy to
 * describe even if there had been a page.
 *
 * Both are fixed, and this page states the behaviour rather than an intention.
 * Every duration named here is a constant in `tickets/server.mjs`; a test
 * compares them, so this cannot become a description of what the code used to do.
 */

export const privacy = {
	slug: 'privacy',
	navTitle: 'Privacy',
	title: 'What this site stores, and for how long',
	description:
		'What this website and its support system hold: report text, attachments, logs, retention periods, and how to have a report deleted.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'WebPage',
		name: 'Privacy and data retention',
		description:
			'What the site and support system store, for how long, and how to have it removed.',
		publisher: { '@type': 'Organization', name: s.publisher },
		mainEntityOfPage: `${s.origin}/privacy`
	}),
	body: (s) => `
		<article>
			<h1>What this site stores</h1>
			<p class="lede">
				Short version: <strong>the application</strong> holds your secrets on your own
				machine, sends them to nobody but Steam, and contains no analytics or telemetry of any
				kind. <strong>This website</strong> is a separate thing and does collect a
				little — server logs kept for 14 days, Cloudflare in front of it, Google
				Analytics, and Trustpilot on the pages that ask you for a review. All of that
				is listed below, along with what a report holds, how long it lives, and the one
				thing the download page keeps in your own browser.
			</p>

			<div class="callout">
				<h2>The application is the part that matters, and it is the part that stores nothing</h2>
				<p>
					${s.name} keeps your Steam Guard secrets in an encrypted vault on your
					computer. There is no account, no sync, no server of ours for them to reach,
					and no telemetry — <a href="/security">the security page explains the design</a>.
					Nothing on this page describes your secrets, because we never have them.
				</p>
			</div>

			<h2>If you file a report</h2>
			<p>
				<a href="/support">The support form</a> is the only place this site collects
				anything <em>you write</em> — the server logs and the analytics above happen
				whether you type anything or not, which is why they are listed first rather
				than here. The form stores:
			</p>
			<dl class="defs">
				<dt>What you wrote</dt>
				<dd>
					The kind of report, the one-line summary and the detail. Submissions that look
					like they contain a Steam secret are <strong>refused and never written</strong>
					— that check reads text, so it cannot see inside an image.
				</dd>
				<dt>A reply address, only if you give one</dt>
				<dd>
					Optional, and never shown on the report page that anyone holding the link can
					read. Leave it blank and the report still works; you just cannot be asked a
					follow-up question.
				</dd>
				<dt>Screenshots or clips, only if you attach them</dt>
				<dd>
					Stored under a name we generate, readable only through the report they belong
					to, and served as the file type their own bytes say they are. Check a
					screenshot before you choose it — a code or an account name in the corner is
					ours to hold once you send it.
				</dd>
				<dt>Ordinary server logs</dt>
				<dd>
					The web server records requests — address, time, page, user agent — as any web
					server does. Kept 14 days, then rotated away.
				</dd>
			</dl>

			<h2>How long each thing lives</h2>
			<table class="retention">
				<thead>
					<tr><th>What</th><th>Kept for</th></tr>
				</thead>
				<tbody>
					<tr><td>An upload you never attached to a report</td><td>Eligible for deletion after 2 hours; normally removed within a few hours</td></tr>
					<tr><td>An open report, and anything attached to it</td><td>Until it is closed</td></tr>
					<tr><td>A resolved or declined report</td><td>90 days after it was closed, then deleted with its attachments</td></tr>
					<tr><td>Web server request logs</td><td>14 days</td></tr>
					<tr><td>Backups of the report database</td><td>Same 90-day cycle; a deleted report leaves the backups as they age out</td></tr>
				</tbody>
			</table>
			<p class="hint">
				Deletion runs on a clock inside the service, hourly, whether or not anybody
				visits. It used to run only when somebody uploaded a file, which meant a quiet
				week was a week when nothing expired. Failed removals are retried until they
				succeed.
			</p>

			<h2>Having something removed sooner</h2>
			<p>
				Reply on your own report and ask. You need the private link you were given
				when you filed it — the short reference identifies a report but is not enough
				to open one, deliberately, because a reference short enough to read out is
				short enough to guess. <a href="/support">The support page</a> explains how to
				get back to a report. We will
				delete the report, its replies and its attachments, and say when it is done.
				There is no account to close because there was never one to create.
			</p>
			<p>
				If you attached something by mistake and have not submitted yet,
				<strong>Remove</strong> on the file deletes our copy immediately rather than just
				hiding the thumbnail.
			</p>

			<h2>Who else is involved</h2>
			<dl class="defs">
				<dt>Cloudflare</dt>
				<dd>
					Sits in front of this site and terminates TLS, so it sees requests to it.
				</dd>
				<dt>Google Analytics</dt>
				<dd>
					<strong>This site runs Google Analytics 4</strong> to count visits and see
					which pages people arrive on. It sets cookies in your browser and sends
					Google your IP address, the page you are reading, and general device and
					referrer information. We use it to learn which guides are worth writing more
					of — not to identify anyone, and we never send it anything you type.
					<strong>The application itself contains no analytics of any kind</strong>;
					this is the website only, and nothing here touches your Steam accounts, your
					maFiles or your secrets. If you would rather not be counted, any content
					blocker or Google's own
					<a href="https://tools.google.com/dlpage/gaoptout" rel="noopener">opt-out
					add-on</a> stops it, and the site works identically without it.
				</dd>
				<dt>GitHub</dt>
				<dd>
					Hosts the source and the releases. If the application's update check
					is on, it asks GitHub's public releases page whether a newer version exists;
					GitHub sees an address and that the application is running, the same as any
					visitor to that page. Nothing about you or your accounts is sent.
				</dd>
				<dt>Cloudflare Web Analytics</dt>
				<dd>
					Cloudflare sits in front of this site, and its Web Analytics is switched on at
					the edge — so a small measurement script is added to pages on their way to
					you, without being part of the files we build. It records page views and
					performance timings, sets no cookie, and does not follow you between sites.
					<strong>We listed Google Analytics as the only third-party script until 25
					August 2026, which was wrong</strong>: this one is added after our build, so
					it never appeared in the source we were checking.
				</dd>
				<dt>Trustpilot, on the pages that ask for a review</dt>
				<dd>
					Only the pages that ask you for a review load Trustpilot's script — this page
					does not, and neither does any page that is not asking. (No number here on
					purpose: a count typed into a sentence is wrong the first time a page is
					added, and this one is derived from what each page actually renders.) Where it does load, Trustpilot sees the request
					the same way any embedded widget's host does: your IP address, your browser,
					and which of our pages you were on. We send it nothing about you, and we
					receive nothing back about who clicked; what we can see is the public review
					count on our own profile, the same number you can.
					<br />
					<strong>Added 2 September 2026.</strong> It went onto every page for one
					commit before this entry existed, including this one — a page that lists
					everyone we talk to and then ended the list with the sentence below.
				</dd>
				<dt>One thing kept in your own browser</dt>
				<dd>
					The download page remembers a single flag in your browser's local storage, and
					nothing else does: <code>oda.review-prompt.dismissed</code>, set if you turn the
					review prompt down, follow the link to write a review, or carry on to a build
					from the prompt itself. It exists so the page can ask you about a review once
					and then stop asking. This site cannot tell whether you actually downloaded or
					installed anything, and does not try to.
					It never leaves your machine, nothing on the server reads it, and clearing your
					site data removes it. It does not expire on its own.
				</dd>
				<dt>Nobody else</dt>
				<dd>
					No advertising network, no third-party fonts, and nothing sold or shared.
					<a href="/donate">Donations are cryptocurrency only</a> partly for this reason
					— taking cards would mean a payment processor holding donor names against a
					project whose whole argument is that it holds nothing.
				</dd>
			</dl>

			<h2>Reaching us about this</h2>
			<p>
				Use <a href="/support">the report form</a>. For a security issue, the routes are
				on <a href="/security">the security page</a> and in
				<a href="/.well-known/security.txt">security.txt</a>.
			</p>
			<p class="hint">
				Published by ${s.publisher}. Last reviewed ${s.updated}.
			</p>
		</article>`
};
