/** Download status, migration, documentation hub, FAQ, support and 404. */

export const download = {
	slug: 'download',
	navTitle: 'Download',
	title: 'Download and release status',
	description:
		'Release status for Open Desktop Authenticator. No public build has been published yet. What exists, what is left, and how to build from source in the meantime.',
	body: (s) => `
		<article>
			<h1>Download</h1>
			<div class="callout callout-warn">
				<h2>There is no release yet</h2>
				<p>
					No signed public build of ${s.name} has been published. There is no
					installer to download from this page, from anywhere else, or from anyone
					claiming to distribute it. <strong>If you find a file advertised as an
					${s.short} or Open Desktop Authenticator build today, it is not
					ours.</strong>
				</p>
			</div>

			<h2>Why the page exists anyway</h2>
			<p>
				Because "coming soon" pages get replaced by scam listings the moment a product
				is talked about and cannot be got. Stating the status plainly, at the URL people
				will look at, is worth more than an empty page.
			</p>

			<h2>What is finished</h2>
			<ul>
				<li>The application itself: codes, confirmations, enrollment, import and export, encrypted vault, recovery files.</li>
				<li>The security posture described on the <a href="/security">security page</a>.</li>
				<li>An automated test suite that runs on every change.</li>
			</ul>

			<h2>What is left before a release</h2>
			<ul>
				<li>Packaging and installers for Windows and Linux.</li>
				<li>A code-signing certificate, so Windows can tell you who built it.</li>
				<li>Published checksums and a signature, and a reproducible build others can compare against.</li>
			</ul>

			<h2>In the meantime</h2>
			<p>
				The source is public and can be built and run today by anyone comfortable with
				Node.js. That is not a substitute for a release and we are not pretending
				otherwise — it is the honest answer to "can I use it now".
			</p>
			<p><a class="button" href="${s.repo}" rel="noopener">View the source repository</a></p>

			<h2>When it does ship</h2>
			<p>
				Every artifact will be listed with a SHA-256 checksum and a signature over that
				list, published on the release page beside the source. <a href="/verify">The
				verification steps are already written</a>, so you can learn them before you need
				them.
			</p>
		</article>`
};

export const importFromSda = {
	slug: 'import-from-sda',
	navTitle: 'Import',
	title: 'Import maFiles from SDA',
	description:
		'Moving accounts from SDA: which files to select, why encrypted maFiles need manifest.json, what is checked before anything is stored, and how to leave.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Import maFiles from Steam Desktop Authenticator',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Find your maFiles directory' },
			{ '@type': 'HowToStep', name: 'Select the files, including manifest.json if encrypted' },
			{ '@type': 'HowToStep', name: 'Enter the SDA passphrase if the files are encrypted' },
			{ '@type': 'HowToStep', name: 'Review what was found and choose what to keep' }
		]
	}),
	body: () => `
		<article>
			<h1>Importing maFiles from Steam Desktop Authenticator</h1>
			<p class="lede">
				Your accounts are yours. Import reads the same <code>.maFile</code> format SDA
				writes, shows you what it found, and stores nothing until you say so.
			</p>

			<h2>Before you start</h2>
			<div class="callout">
				<p>
					<strong>Do not delete your SDA installation.</strong> Keep it until you have
					confirmed the imported accounts generate the same codes. Importing copies;
					it does not move. There is no step here that alters your existing files.
				</p>
			</div>

			<h2>1. Find your maFiles</h2>
			<p>
				They live in the <code>maFiles</code> folder inside your SDA installation
				directory, one <code>.maFile</code> per account, named after the SteamID —
				plus a <code>manifest.json</code>.
			</p>

			<h2>2. Select them</h2>
			<p>
				Choose <em>Import maFiles</em> and select the account files. If your maFiles are
				encrypted you also need <code>manifest.json</code>: it holds the salt and
				initialisation vector, and without it an encrypted maFile cannot be decrypted at
				all. If you select an encrypted file and forget the manifest, the application
				looks for one beside the files you picked and adds it for you.
			</p>

			<h2>3. Unlock, if they are encrypted</h2>
			<p>
				You will be asked for the passphrase you set in SDA — not your Steam password,
				and not the passphrase for this application's vault. It is used to decrypt the
				files in memory and is not stored.
			</p>

			<h2>4. Review what was found</h2>
			<p>
				Nothing has been written yet at this point. The report lists each account it
				could read and flags anything that matters:
			</p>
			<ul>
				<li>Accounts already in your vault, so you do not import a duplicate.</li>
				<li>
					A maFile with no <code>identity_secret</code> — it will generate login codes
					but cannot confirm trades, and it is better to know now.
				</li>
				<li>
					A maFile with no revocation code, which means detaching that authenticator
					later will need Steam Support.
				</li>
				<li>A proxy setting found inside the file, which you can adopt or discard.</li>
				<li>Files that could not be read at all, and why.</li>
			</ul>
			<p>Tick what you want. Everything else is discarded when you close the screen.</p>

			<h2>5. Confirm the codes match</h2>
			<p>
				Put the two applications side by side and check that an imported account shows
				the same five characters as SDA does. Same secret, same clock, same code. That
				is your proof the import worked before you rely on it.
			</p>

			<h2>Leaving again</h2>
			<p>
				Export writes an account back out as a standard <code>.maFile</code>, readable
				by SDA. There is no lock-in, and that is deliberate: a tool that made your
				secrets hard to take elsewhere would be behaving like the thing it is meant to
				replace.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/steam-desktop-authenticator">What is actually inside a maFile</a></li>
				<li><a href="/security">How they are stored once imported</a></li>
				<li><a href="/docs">Full documentation</a></li>
			</ul>
		</article>`
};

export const docs = {
	slug: 'docs',
	navTitle: 'Docs',
	title: 'Documentation',
	description:
		'Guides for Open Desktop Authenticator: setting up a vault, adding accounts, confirmations, automatic confirmation, backups, recovery codes and troubleshooting.',
	body: () => `
		<article>
			<h1>Documentation</h1>
			<p class="lede">
				How the application works, page by page. If something here is wrong or missing,
				<a href="/support">tell us</a> — documentation faults are treated as faults.
			</p>

			<h2>Getting started</h2>
			<dl class="defs">
				<dt><a href="/import-from-sda">Importing from SDA</a></dt>
				<dd>Bringing existing maFile accounts across, including encrypted ones.</dd>
				<dt>Creating a vault</dt>
				<dd>
					On first run you choose a passphrase. It protects every secret the
					application holds and it cannot be recovered — there is no reset, because a
					reset would be a back door. Write it down before you continue past that
					screen.
				</dd>
				<dt>Adding an authenticator</dt>
				<dd>
					For an account that does not have Steam Guard on a device yet. You sign in,
					Steam emails a code, and the application attaches an authenticator and shows
					your revocation code. Write that code down. The application will keep warning
					you until you confirm you have.
				</dd>
			</dl>

			<h2>Everyday use</h2>
			<dl class="defs">
				<dt>Codes</dt>
				<dd>
					Each account shows its current code and how much of the thirty-second window
					is left. Copy places it on the clipboard and clears it again shortly after,
					so it does not sit there for the next thing that reads your clipboard.
				</dd>
				<dt>Confirmations</dt>
				<dd>
					Trades and market listings awaiting approval, with what Steam said about
					each: what is being traded, with whom, and when it was raised. Approve or
					cancel individually.
				</dd>
				<dt>Automatic confirmation</dt>
				<dd>
					Optional, per account, and limited to market listings and trades. Anything
					else — most importantly an account recovery request — is held back and
					reported in Activity rather than approved. This limit is in the code, not in
					a setting.
				</dd>
				<dt>Activity</dt>
				<dd>
					What automatic confirmation did while you were not watching, and anything it
					refused. The place to look if something feels wrong.
				</dd>
			</dl>

			<h2>Keeping access</h2>
			<dl class="defs">
				<dt>Revocation codes</dt>
				<dd>
					The code that detaches an authenticator from Steam. Revealing one requires
					your passphrase again even when the vault is unlocked. Store it somewhere
					that is not this computer.
				</dd>
				<dt>Backups</dt>
				<dd>
					The vault keeps the previous version of itself beside the current one. If the
					vault file is damaged, the unlock screen offers to load that backup. Restoring
					returns the vault to how it was when the backup was written: accounts added
					since will be gone, and accounts removed since will come back.
				</dd>
				<dt>Recovery files</dt>
				<dd>
					Written automatically when an account is enrolled, and deliberately kept when
					an account is removed — recovering from that removal is the reason they
					exist. They are encrypted with the vault passphrase in force at the time they
					were written.
				</dd>
			</dl>

			<h2>Troubleshooting</h2>
			<dl class="defs">
				<dt>Steam rejects the codes</dt>
				<dd>
					Almost always the clock. Codes are generated from the current time, so a
					machine more than about half a minute out produces codes Steam will not
					accept. The application checks its clock against Steam's and warns you when
					it could not.
				</dd>
				<dt>An imported account cannot confirm trades</dt>
				<dd>
					Its maFile had no identity secret. Login codes work; confirmations cannot.
					The account has to be re-enrolled to fix it.
				</dd>
				<dt>Sign-in wants approval on another device</dt>
				<dd>
					Steam is asking for confirmation on the device that already holds the
					authenticator. If that device is gone, the revocation code is the way through.
				</dd>
			</dl>
		</article>`
};

export const faq = {
	slug: 'faq',
	navTitle: 'FAQ',
	title: 'Frequently asked questions',
	description:
		'Is it free, does it work with SDA maFiles, can it take my items, and what happens if I lose my passphrase. Answers about Open Desktop Authenticator.',
	structuredData: () => ({
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: FAQ_ITEMS.map((item) => ({
			'@type': 'Question',
			name: item.q,
			acceptedAnswer: { '@type': 'Answer', text: item.plain }
		}))
	}),
	body: () => `
		<article>
			<h1>Frequently asked questions</h1>
			${FAQ_ITEMS.map(
				(item) => `
			<section class="faq-item">
				<h2>${item.q}</h2>
				${item.a}
			</section>`
			).join('')}
		</article>`
};

const FAQ_ITEMS = [
	{
		q: 'Is it free?',
		plain:
			'Yes. It is free and open source under the GPL. There is no paid tier, no account, and no telemetry.',
		a: `<p>Yes. Free and open source under the GPL. There is no paid tier, no account to create, and no telemetry. It is published by MASTERPANEL LLC as an open-source project.</p>`
	},
	{
		q: 'Can I use my existing SDA maFiles?',
		plain:
			'Yes. It imports .maFile accounts including encrypted ones, and exports them back out in the same format.',
		a: `<p>Yes — including encrypted ones, provided you also supply <code>manifest.json</code>. It exports back to the same format too, so moving away later is a supported operation rather than a rescue mission. <a href="/import-from-sda">How importing works</a>.</p>`
	},
	{
		q: 'How do I know this is not itself a scam?',
		plain:
			'Do not take our word for it. The source is public, builds are reproducible from that source, and every release is published with checksums and a signature so you can confirm the binary matches the code.',
		a: `<p>Do not take our word for it — that is the entire design. The source is public and the build is reproducible from it, so you can compile the code yourself and check that the result matches the binary we publish, byte for byte. Every release carries checksums and a signature. <a href="/verify">The steps are here</a>, and they work whether or not you trust us.</p>
			<p>We would rather you were sceptical of us and safe than trusting and robbed.</p>`
	},
	{
		q: 'What happens if I lose my vault passphrase?',
		plain:
			'The vault cannot be opened. There is no reset and no recovery, because either would be a back door. Recovery files written at enrollment use the passphrase in force at the time.',
		a: `<p>The vault cannot be opened. There is no reset, no master key and no support process that gets around it, because every one of those would be a back door into everyone else's vault too.</p>
			<p>What you do have is the recovery file written when each account was enrolled, and your revocation codes. This is why the application insists you write them down.</p>`
	},
	{
		q: 'Does it work without an internet connection?',
		plain: 'Codes are generated offline. Confirmations and enrollment need to reach Steam.',
		a: `<p>Code generation is entirely offline — it is a calculation from a stored secret and the current time. Confirmations, sign-in and enrollment have to reach Steam, since they are conversations with Steam.</p>`
	},
	{
		q: 'Is it affiliated with Valve or with SDA?',
		plain:
			'No. It is an independent open-source project, not affiliated with Valve Corporation or with the authors of Steam Desktop Authenticator.',
		a: `<p>No. It is independent: not affiliated with, endorsed by or connected to Valve Corporation, and not connected to the authors of Steam Desktop Authenticator. It shares no code with SDA. It reads the same file format so that nobody is trapped by their choice of tool.</p>`
	},
	{
		q: 'Will it steal my items while I am not looking?',
		plain:
			'Automatic confirmation is limited in code to market listings and trades, and cannot be widened by a setting. Account recovery confirmations are always held back and reported.',
		a: `<p>Automatic confirmation is off unless you turn it on, is set per account, and can only ever act on market listings and trades. That limit is a fixed list in the source, not a preference — an account recovery confirmation is held back and reported to you no matter how the application is configured. <a href="/security">The security model explains why that distinction matters most.</a></p>`
	},
	{
		q: 'Which platforms does it run on?',
		plain: 'Windows 10 and 11 are the primary targets. Linux is supported.',
		a: `<p>Windows 10 and 11 are the primary targets. Linux is supported. There is no macOS build planned at present.</p>`
	}
];

export const support = {
	slug: 'support',
	navTitle: 'Support',
	title: 'Report a problem',
	description:
		'Report a bug, a documentation error, or a suspected fake Steam authenticator site. Tracked, answered, and resolvable without an account.',
	body: () => `
		<article>
			<h1>Report a problem</h1>
			<p class="lede">
				Bugs, documentation errors, and suspected clone sites. You do not need an
				account to report something, and you will get a reference you can use to follow
				it up.
			</p>

			<div class="callout callout-warn">
				<h2>Never include a secret in a report</h2>
				<p>
					Do not paste a <code>.maFile</code>, a shared secret, an identity secret, a
					revocation code, a password or an API key into this form or into any message
					to us. Nobody here will ever ask for one. A report that needs to describe a
					secret can describe its shape without its value.
				</p>
			</div>

			<div class="callout">
				<h2>The form is not live yet</h2>
				<p>
					The tracker is being built and will appear at this address. Until it does,
					issues can be raised on the public repository. Security reports should wait
					for the private channel here rather than being filed publicly.
				</p>
			</div>

			<h2>What to include</h2>
			<ul>
				<li>What you did, what you expected, and what happened instead.</li>
				<li>The application version and your operating system.</li>
				<li>Whether it happens every time or occasionally.</li>
				<li>For a suspected clone site: the URL, and where you encountered it.</li>
			</ul>

			<h2>What happens to a report</h2>
			<ol>
				<li>
					<strong>You get a reference.</strong> Submitting returns a code you can use to
					check the report later. No account, no email address required — although
					leaving one means we can ask a follow-up question, which is often the
					difference between a fixed bug and a closed one.
				</li>
				<li>
					<strong>It is read.</strong> Reports are triaged rather than queued: anything
					describing lost access, lost items, or a secret behaving unexpectedly is
					looked at ahead of everything else.
				</li>
				<li>
					<strong>It gets an answer.</strong> Including "we are not going to change
					this", with a reason. A tracker where reports quietly expire is a tracker
					nobody reports to twice.
				</li>
			</ol>

			<h2>Reporting a clone site</h2>
			<p>
				Fake authenticator downloads are the reason this project exists, and a report
				takes a minute. Send the URL and where you found it — a search result, an
				advertisement, a video description, a Discord message. We collect them, warn
				about the patterns on the <a href="/scam-clones">scam clones page</a>, and report
				the worst to the registrars and hosts involved.
			</p>
			<p>
				You do not need to be sure. A site that turns out to be legitimate costs us five
				minutes; one that turns out not to be may save somebody their inventory.
			</p>

			<h2>Security reports</h2>
			<p>
				If you have found a vulnerability, mark the report as a security issue. It goes
				to a private queue rather than a public list, it will be acknowledged, and we
				will not argue about severity before fixing something that is plainly wrong.
			</p>
			<p>
				Please give us a reasonable window to release a fix before publishing details.
				We will not use that window to argue you into silence, and we will credit you
				unless you would rather we did not.
			</p>
		</article>`
};

export const notFound = {
	slug: '404',
	title: 'Page not found',
	description:
		'That address does not exist on this site. Links to the main pages: what SDA is, download status, verifying a build, and the documentation.',
	noindex: true,
	body: () => `
		<article>
			<h1>Page not found</h1>
			<p class="lede">That address does not exist on this site.</p>
			<p>If you followed a link from somewhere and expected a page here, <a href="/support">tell us where the link was</a> — a broken link on our own site is a fault worth fixing.</p>
			<ul class="plain next">
				<li><a href="/">Home</a></li>
				<li><a href="/steam-desktop-authenticator">About Steam Desktop Authenticator</a></li>
				<li><a href="/download">Download status</a></li>
				<li><a href="/docs">Documentation</a></li>
			</ul>
		</article>`
};
