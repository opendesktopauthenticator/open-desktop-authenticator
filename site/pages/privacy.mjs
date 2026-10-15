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
	updated: '2026-10-15',
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
				Short version: <strong>the application</strong> keeps your secrets in encrypted
				files on your own machine. It has no ODA backend, ODA account, cloud sync, or
				telemetry. Steam operations you request contact Valve; direct builds from GitHub, Softonic or Uptodown can
				optionally check GitHub for a newer release; and the in-app browser contacts
				the sites you open and resources those sites load. Those sites can set cookies
				and collect their own data. <strong>This website</strong> separately uses
				web-server request logs normally removed within 14 days, Cloudflare
				in front of it, Google Analytics, Yandex Metrica, and Trustpilot on the pages that ask you for
				a review. A delayed or failed log rotation can delay deletion. All of that
				is listed below, along with report retention, the Yandex analytics preference
				and an old download-page preference that is no longer used.
			</p>

			<div class="callout">
				<h2>The application stores secrets locally; the publisher does not receive them</h2>
				<p>
					${s.name} keeps your Steam Guard secrets in an encrypted vault on your
					computer. No ODA backend. No ODA account. No cloud sync. No telemetry.
					The app sends the data required for user-requested Steam operations to Valve,
					but it does not send vault contents to us.
					<strong>Exports you request are unencrypted maFiles</strong>; they need secure
					storage even though the vault remains encrypted.
					<a href="/security">The security page explains the boundaries</a>.
				</p>
			</div>

			<h2>If you file a report</h2>
			<p>
				<a href="/support">The support form</a> and replies to an existing report store
				the text you submit. Request logs and analytics can be collected without a
				submission. The support service stores:
			</p>
			<dl class="defs">
				<dt>What you wrote</dt>
				<dd>
					The kind of report, the one-line summary, the detail and subsequent replies.
					A text check rejects recognised Steam-secret patterns before storing a report
					or reply. <strong>It cannot detect every secret or read images.</strong> Never
					include passwords, maFiles, recovery codes or authentication tokens.
				</dd>
				<dt>A reply address, only if you give one</dt>
				<dd>
					Optional, and never shown on the report page that anyone holding the link can
					read. Leave it blank and you can still read and answer follow-up questions
					on your report's private link. The service does not send automatic emails.
				</dd>
				<dt>Screenshots or clips, only if you attach them</dt>
				<dd>
					Uploaded before you submit the report, stored under a generated name, and
					accessible through the report once attached. Our operators also have access.
					File signatures are checked to recognise supported formats; this is not a
					malware scan or removal of embedded metadata. Crop or redact sensitive details
					before choosing a file. Anyone with your private report link can read its text
					and download its attachments.
				</dd>
				<dt>Ordinary server logs</dt>
				<dd>
					The web server records requests — address, time, page, user agent — as any web
					server does. The logs are rotated daily and normally removed within 14 days.
					A delayed or failed rotation can delay deletion.
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
					<tr><td>Web server request logs</td><td>Normally within 14 days; a delayed or failed rotation can delay deletion</td></tr>
					<tr><td>Backups of the report database and attachments</td><td>Each archive becomes eligible for deletion at 90 days old, at the next daily backup cleanup. Copies may therefore remain for about 90 additional days after deletion from the live service.</td></tr>
				</tbody>
			</table>
			<p class="hint">
				Live-service deletion runs hourly while the service is running, and at startup.
				Failed removals are retried until they succeed. Outages, failed cleanup or failed backup jobs can
				delay deletion. Open reports have no automatic expiry; ask for removal if you
				no longer need one. These periods describe our own storage, not retention by
				the external providers listed below.
			</p>

			<h2>Having something removed sooner</h2>
			<p>
				Reply on your own report and ask. You need the private link you were given
				when you filed it — the short reference identifies a report but is not enough
				to open one, deliberately, because a reference short enough to read out is
				short enough to guess. <a href="/support">The support page</a> explains how to
				get back to a report. We will
				remove the report, its replies and its attachments from the live service.
				Existing backup copies age out on the schedule above. If you need a confirmation
				after the report is deleted, include a contact address; its page will no longer open.
				There is no account to close because there was never one to create.
			</p>
			<p>
				If you attached something by mistake and have not submitted yet,
				<strong>Remove</strong> requests deletion. After the server confirms success,
				the live copy is gone. If removal fails, the page shows an error and the service
				retries during cleanup. Existing backup copies follow the schedule above.
			</p>

			<h2>Who else is involved</h2>
			<dl class="defs">
				<dt>Cloudflare</dt>
				<dd>
					Sits in front of this site and terminates TLS, so it can process requests,
					including support submissions, your IP address and request URLs. Our local
					log-retention schedule does not set Cloudflare's retention. See
					<a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare's privacy policy</a>.
				</dd>
				<dt>Google Analytics</dt>
				<dd>
					<strong>This site runs Google Analytics 4</strong> to count visits and see
					which pages people arrive on. It sets cookies in your browser and sends
					Google your IP address, the page you are reading, and general device and
					referrer information. Page addresses can include query parameters; Google
					Analytics also supports interaction measurement controlled in its service
					settings. Do not put private information in website URLs. Our own code does
					not send support text or attachments as analytics events, and private report
					pages do not load our Google Analytics scripts. See
					<a href="https://support.google.com/analytics/answer/9216061?hl=en" rel="noopener">Google's measurement documentation</a>.
					<strong>ODA's own interface has no analytics</strong>; websites opened in its
					optional browser can use their own. This website's scripts have no direct access
					to ODA's local vault. Do not submit secrets or put them in page addresses.
					To block Google Analytics, use a content
					blocker configured to block it, or Google's
					<a href="https://tools.google.com/dlpage/gaoptout" rel="noopener">opt-out
					add-on</a>. The guides and support form work without Google Analytics.
				</dd>
				<dt>Yandex Metrica — public website pages only</dt>
				<dd>
					We use Yandex Metrica to count visits to public website pages and help discover updated pages.
					Yandex receives the public page address and basic request, browser and device information,
					including your IP address, and may use analytics cookies. We strip query strings and fragments
					from addresses we send; we do not forward document titles, original referring-page addresses,
					form contents, filenames, uploads, Steam secrets or account identifiers.
					Private ticket pages, admin and API routes are excluded. Our integration disables
					session replay, click maps, link tracking and ecommerce. Other optional Yandex requests
					are blocked by this website's security policy.
					<strong>This is website analytics only; the desktop application's no-telemetry behavior is unchanged.</strong>
					Global Privacy Control, Do Not Track, or the switch below disables Yandex collection.
					The choice is stored only in this browser as <code>oda_metrica</code> and can be changed here.
					This switch does not control the other services listed on this page.
					<p><button class="button button-quiet" id="oda-metrica-toggle" type="button" aria-pressed="false">Disable Yandex analytics</button></p>
					<p id="oda-metrica-status" role="status" aria-live="polite">Yandex analytics respects your browser privacy settings.</p>
				</dd>
				<dt>GitHub</dt>
				<dd>
					Hosts the source and releases. In a direct build from GitHub, Softonic or Uptodown, if the optional
					update check is on, it asks GitHub's public releases API whether a newer
					version exists. GitHub receives the request and its source IP, but no Steam
					account or vault data. Microsoft Store builds do not perform this check.
				</dd>
				<dt>Cloudflare Web Analytics</dt>
				<dd>
					Cloudflare sits in front of this site, and its Web Analytics is switched on at
					the edge — so a small measurement script is added to pages on their way to
					you, without being part of the files we build. It records page views and
					performance timings. Cloudflare describes Web Analytics as using neither
					cookies nor browser local storage to measure visits; this is separate from
					Cloudflare's other security services. See
					<a href="https://www.cloudflare.com/web-analytics/" rel="noopener">Cloudflare's Web Analytics privacy description</a>.
				</dd>
				<dt>Trustpilot, on the pages that ask for a review</dt>
				<dd>
					Only the pages that ask you for a review load Trustpilot's script — this page
					does not, and neither does any page that is not asking. Where it loads, Trustpilot sees the request
					the same way any embedded widget's host does: your IP address, your browser,
					and which of our pages you were on. We do not send it Steam account, vault,
					or support-form data. Writing a review takes you to Trustpilot, where its
					own account, cookie and privacy rules apply. See
					<a href="https://legal.trustpilot.com/for-everyone/end-user-privacy-terms" rel="noopener">Trustpilot's privacy policy</a>.
				</dd>
				<dt>Support access cookie</dt>
				<dd>
					Opening a private report link sets a cookie for that report, expiring after
					12 hours. It keeps the access key out of subsequent page URLs and is marked
					Secure, HttpOnly and SameSite=Lax. Keep the original private link so you can
					return after the cookie expires or you clear your browser data. The short
					report reference alone does not grant access.
				</dd>
				<dt>Retired download-page preference</dt>
				<dd>
					An older download page saved <code>oda.review-prompt.dismissed</code> in local
					storage after you answered its review request. The current download page
					no longer reads or writes this preference and opens download links directly.
					An existing value can remain in your browser until you clear this site's data;
					it has no automatic expiry. This local preference was not sent to our server.
				</dd>
				<dt>Donations and data sharing</dt>
				<dd>
					This site loads no advertising-network integration or third-party fonts.
					The services above receive data as described; calling that "nothing shared"
					would be inaccurate. <a href="/donate">Donations are cryptocurrency only</a>.
					Transactions on the listed networks are public, and a wallet or exchange may
					collect additional information. Cryptocurrency is not a promise of anonymity.
				</dd>
			</dl>

			<h2>Reaching us about this</h2>
			<p>
				Use <a href="/support">the report form</a>. For a security issue, the routes are
				on <a href="/security">the security page</a> and in
				<a href="/.well-known/security.txt">security.txt</a>.
			</p>
		</article>`
};
