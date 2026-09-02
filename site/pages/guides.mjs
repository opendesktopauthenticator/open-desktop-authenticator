import { releaseGaps, reviewAsk, reviewCollector } from '../markup.mjs';

/** Download status, migration, documentation hub, FAQ, support and 404. */

export const download = {
	slug: 'download',
	navTitle: 'Download',
	script: 'download.js',
	title: 'Open Desktop Authenticator download and release status',
	description:
		'Download Open Desktop Authenticator for Windows and Linux. Install from the Microsoft Store, or take a build from GitHub and verify it yourself.',
	body: (s) => `
		<article>
			<h1>Download</h1>
			<div class="callout" data-download>
				<h2>Two places, and nowhere else</h2>
				<p>
					${s.name} 1.0 is published in the Microsoft Store and on this project's
					GitHub releases page. <strong>Those are the only two places a genuine build
					comes from.</strong> Not a mirror, not a lookalike domain, not a sponsored
					search result, and not this page — every button here is a link somewhere
					else, never a file we serve.
					<a href="/official">The full list of addresses we publish from</a> is
					short, and anything outside it is not ours.
				</p>

				<div class="download-primary download-windows">
					<p>
						<a class="button" href="${s.store.url}" rel="noopener" data-got-it="the Store build">Get it from the Microsoft Store</a>
					</p>
					<p class="download-why">
						Microsoft re-signs every package it distributes, so Windows never warns,
						updates arrive on their own, and there is nothing for you to check by
						hand. On Windows this is the right answer for almost everybody.
					</p>
				</div>

				<div class="download-primary download-linux">
					<p>
						<a class="button" href="${s.repo}/releases/latest" rel="noopener" data-got-it="the Linux build" data-hands-over-a-file>Download for Linux</a>
					</p>
					<p class="download-why">
						An AppImage and a <code>.deb</code>, published on the releases page.
						Nothing has checked these for you, so
						<a href="/verify">verify them</a> — the checksums and the build
						provenance attestation are both on that release.
					</p>
				</div>

				<details class="download-alt">
					<summary>Can't use the Store, or want to check the bytes yourself?</summary>
					<p>
						The same builds are on
						<a href="${s.repo}/releases/latest" rel="noopener" data-got-it="a build from the release page" data-hands-over-a-file>the GitHub releases page</a>,
						including the portable build, which has no Store equivalent — it writes
						nothing outside its own folder and runs from a USB stick. Take this route
						if the Store is missing from your Windows image, if the machine is locked
						down, or if you would rather verify a download than be told it is fine.
					</p>
					<p>
						<strong>These carry no code-signing certificate yet, so Windows warns on
						first run.</strong> That warning is about a missing certificate, not about
						the file being wrong — <a href="/verify">the verification steps</a> are
						how you tell those two apart instead of guessing.
					</p>
				</details>
			</div>

			<!--
				The most useful thing this page can do today.

				Somebody arrives here wanting a Steam authenticator, finds there is
				nothing to download, and goes back to a search result — which is the
				precise sequence that cost the person who runs this site their
				inventory. Sending them to the genuine original instead is worth more
				than keeping them on a page with no build on it.
			-->
			<h2>What to use today</h2>
			<p>
				In order, and the first one is the right answer for most people:
			</p>
			<ol class="signs">
				<li>
					<strong>Steam's official mobile authenticator.</strong> Maintained by the
					people who run the service, distributed through Apple's and Google's own
					stores rather than a search result, and a lost phone is recoverable rather
					than fatal. If you are here
					because you searched for a desktop authenticator, this is still probably what
					you want.
				</li>
				<li>
					<strong>The original Steam Desktop Authenticator, if you understand what you
					are taking on.</strong> Its own README says it is
					${s.sda.notice}, and its authors' position is that
					${s.sda.authorsAdvice}. That is their assessment of their own software and it
					deserves more weight than ours. Unmaintained software that holds a Steam Guard
					secret does not get safer with time. If you use it anyway, take it from
					<a href="${s.sda.repo}" rel="noopener">github.com/${s.sda.author}/SteamDesktopAuthenticator</a>
					and nowhere else — not a mirror, not a lookalike domain, not a sponsored
					result.
				</li>
				<li>
					<strong>This project.</strong> There is a release to check now, and the
					links at the top of this page are it. We still put Valve's own app first,
					because for most people it is the better answer and saying otherwise to win
					an install would be the same mistake in the other direction.
				</li>
			</ol>
			<div class="origin-note">
				<p>
					We would rather lose you to Valve's app than have you install something
					abandoned on our recommendation. Sending people to unmaintained security
					software while leaving out its author's own warning is the behaviour this
					site exists to complain about.
				</p>
				<a class="button button-quiet" href="${s.sda.repo}" rel="noopener">Read SDA's own notice →</a>
			</div>

			<h2>Why this page still lists the alternatives</h2>
			<p>
				Because the reason this project exists is that somebody searching for a desktop
				authenticator lands on a page and installs whatever it offers. A download page
				that answers only "install ours" trains exactly that habit, which is the habit
				that costs people their inventories. Naming the alternatives, and the real home
				of each, is worth more than the installs it loses us.
			</p>

			<h2>What is finished</h2>
			<ul>
				<li>The application itself: codes, confirmations, enrollment, import and export, encrypted vault, recovery files.</li>
				<li>The security posture described on the <a href="/security">security page</a>.</li>
				<li>An automated test suite that runs on every change.</li>
				${
					/*
					 * **The checksum-list signature is listed here, under the flag, rather
					 * than as a fourth entry in "What is still missing" below.**
					 *
					 * It used to live down there in both directions: one `<li>` whose signed
					 * branch read "The checksum list <em>is</em> signed. Every release carries
					 * SHA256SUMS.txt.sig ...", sitting under a heading that says "What is
					 * still missing" and a lead-in promising the reader is being told what has
					 * not been done. A finished thing announced as an outstanding one is the
					 * same class of error the release flags exist to prevent, only aimed at
					 * the reader's comprehension instead of at the facts — and nothing catches
					 * it, because `CLAIMS` in site/verify.mjs skips the entry while the flag is
					 * true and `STALE_ABSENCE` only ever hunts for absence phrasings.
					 *
					 * An earlier draft bridged the position instead, ending the signed branch
					 * with "The two things still missing are below." That parses, but it makes
					 * the heading a lie the next sentence then apologises for, and it only
					 * reads correctly for as long as this item happens to sit above the
					 * remaining ones. The neighbouring reproducible-builds entry already
					 * survives the build only because "cannot yet" lands inside a
					 * 200-character qualifier window, so a second position-dependent sentence
					 * in the same list is a second thing that breaks silently when somebody
					 * reorders it. Moving the item leaves both headings literally true
					 * whichever way the flag points, which is the reading a careful editor
					 * arrives at without having to reconcile anything.
					 *
					 * The wording changes with the move as well: entries in this list are
					 * plain noun phrases and the ones below lead with a bold claim, so the
					 * sentence is rewritten to the grammar of the list it now belongs to
					 * rather than carried over intact from the one it left.
					 */
					s.release.signed
						? `<li>
					A signature over the checksum list: every release carries
					<code>SHA256SUMS.txt.sig</code> and the certificate that goes with it, so
					you can check that the list itself came from our workflow rather than only
					that your download matches the list.
					<a href="/verify">Step 5 walks through it.</a>
				</li>`
						: ''
				}
				<li>
					End-to-end testing against live Steam accounts — import from SDA,
					enrollment, codes, confirmations, backup and recovery — with the defects it
					surfaced fixed. Maintainer testing, not an independent audit.
				</li>
			</ul>

			<h2>What is still missing</h2>
			<p>Stated here rather than left for you to discover:</p>
			<ul>
				<li>
					<strong>A code-signing certificate for the direct downloads.</strong> The
					Store build is signed by Microsoft; the <code>.exe</code> and Linux builds on
					GitHub are not, so Windows warns on first run. Until that changes, the
					checksums and the provenance attestation are how you check them.
					<br />
					We are applying to the
					<a href="https://signpath.org/" rel="noopener">SignPath Foundation</a>, which
					provides free code-signing certificates to open-source projects, and intend
					to sign the direct downloads through
					<a href="https://about.signpath.io/" rel="noopener">SignPath.io</a> once that
					is granted. <strong>It has not been granted yet</strong>, so nothing you can
					download today is signed by us — when that changes, this paragraph and the
					release notes change with it. See
					<a href="/code-signing-policy">our code signing policy</a>.
				</li>
				${
					/*
					 * Absent from this list entirely once the flag is true, because what it
					 * describes is then finished and is stated up under "What is finished" —
					 * the note there explains why it moved rather than being bridged in place.
					 *
					 * The conditional wraps the whole `<li>` instead of sitting inside one, so
					 * the signed rendering has three bullets rather than three bullets and an
					 * empty one.
					 */
					s.release.signed
						? ''
						: `<li>
					<strong>The checksum list is not signed yet.</strong> The release workflow
					signs it now, but it started doing so after the current release was
					published — so there is no <code>SHA256SUMS.txt.sig</code> to fetch for the
					build you can download today. <a href="/verify">Step 5 says so plainly</a>
					rather than printing a command that cannot succeed.
				</li>`
				}
				<li>
					<strong>Reproducible builds.</strong> You cannot yet rebuild the tag and
					compare bytes with ours. The provenance attestation is what stands in for it.
				</li>
				<li>
					<strong>An independent audit.</strong> This has been tested end to end
					against live Steam accounts by the maintainer. That is testing, not review by
					someone with no stake in the answer.
				</li>
			</ul>

			<p>
				Free software under the MIT licence — no account, no agreement to accept, and
				nothing to cancel. <a href="${s.repo}/blob/main/LICENSE" rel="noopener">Read the
				licence</a>, or <a href="/uninstall">read how to remove it and its data</a>
				before you install rather than after.
			</p>

			<h2>Building it yourself</h2>
			<p>
				The source is public and can be built and run by anyone comfortable with
				Node.js. You no longer have to — there are builds now — but the option is the
				point: every claim on this site is checkable against the thing that produced the
				download.
			</p>
			<p><a class="button" href="${s.repo}" rel="noopener">View the source repository</a></p>

			<h2>Checking what you downloaded</h2>
			<p>
				Every artifact is listed with a SHA-256 checksum in
				<code>SHA256SUMS.txt</code> on the release page, alongside a build provenance
				attestation that ties those exact bytes to the public workflow run that produced
				them. <a href="/verify">The verification steps walk through both</a> — worth
				reading once before you need them rather than in a hurry afterwards.
			</p>

${reviewAsk(s, { got: 'Did this page stop you downloading the wrong thing?' })}

			<!--
				Revealed once a download has actually started, which is the only moment
				on this page where the reader has received the thing the review would be
				about. Hidden to begin with and hidden again for anybody who says no,
				because an ask that ignores an answer is not an ask.
			-->
			<aside class="ask ask-prompt" data-review-prompt hidden>
				<div class="ask-body">
					<h2>Your download has started</h2>
					<p>
						You now have the thing most people cannot safely get: a Steam authenticator
						they can read the source of. If it works, saying so publicly is the only
						way the next person — who has no way to tell us apart from the sites that
						steal inventories — finds out that it does.
					</p>
					<p class="hint">
						It takes a minute. Nothing is offered in return, nothing is filtered, and
						if it turns out not to work for you that is the review worth leaving most.
					</p>
					<div class="ask-collector" data-review-prompt-collector>${reviewCollector(s)}</div>
					<div class="ask-actions">
						<a class="button" href="${s.reviews.write}" rel="noopener nofollow">Write a review →</a>
						<button type="button" class="button button-quiet" data-review-dismiss>
							Not now
						</button>
					</div>
				</div>
			</aside>
		</article>`
};

export const importFromSda = {
	slug: 'import-from-sda',
	parent: 'docs',
	updated: '2026-08-14',
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
				<li><a href="/encrypted-mafile">Encrypted maFiles: the password and the manifest</a></li>
				<li><a href="/security">How they are stored once imported</a></li>
				<li><a href="/docs">Full documentation</a></li>
			</ul>
		</article>`
};

export const uninstall = {
	slug: 'uninstall',
	updated: '2026-08-27',
	navTitle: 'Uninstall',
	parent: 'download',
	title: 'Uninstall Open Desktop Authenticator, and remove its data',
	description:
		'How to remove the application on Windows and Linux, what it leaves behind and where, and the one thing to do before you delete any of it.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Uninstall Open Desktop Authenticator',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{
				'@type': 'HowToStep',
				name: 'Detach the authenticator first',
				text: 'Remove the authenticator from each Steam account, or make sure the revocation code for each is written down somewhere outside the vault.'
			},
			{
				'@type': 'HowToStep',
				name: 'Remove the application',
				text: 'Uninstall from the Microsoft Store, Windows Settings, or your package manager, or delete the portable folder or AppImage.'
			},
			{
				'@type': 'HowToStep',
				name: 'Remove the data',
				text: 'Delete the application data directory, which holds the encrypted vault, its backup and any recovery files.'
			}
		]
	}),
	body: (s) => `
		<article>
			<h1>Uninstall ${s.name}, and remove its data</h1>
			<p class="lede">
				Removing the application is the easy half. The half worth reading first is what
				happens to the Steam accounts it was holding, because uninstalling does not
				touch them.
			</p>

			<div class="callout callout-warn">
				<h2>Do this before you delete anything</h2>
				<p>
					<strong>Uninstalling does not remove the authenticator from your Steam
					account.</strong> Steam still expects codes from an authenticator this
					application was generating. Delete the vault without dealing with that and
					you are locked out of every account it held.
				</p>
				<p>Either, for each account:</p>
				<ul>
					<li>
						<strong>Detach it in the application first</strong> — Remove account, which
						can also deactivate the authenticator on Steam's side. Do this while the
						vault still opens.
					</li>
					<li>
						<strong>Or make sure you have the revocation code</strong> — the
						<code>R</code> code Valve calls your recovery code, written down somewhere
						that is not the vault.
						<a href="/steam-revocation-code">What it is and how to get it back.</a>
						With it you can detach the authenticator from Steam later, without this
						application.
					</li>
				</ul>
				<p>
					If neither is true and the vault is already gone,
					<a href="/lost-authenticator">the recovery routes are here</a>.
				</p>
			</div>

			<h2>1. Remove the application</h2>
			<dl class="facts">
				<dt>Microsoft Store</dt>
				<dd>
					Start menu, right-click ${s.name}, Uninstall. Or Settings, Apps, Installed
					apps. Windows removes the package completely.
				</dd>
				<dt>Windows installer (the <code>.exe</code> from GitHub)</dt>
				<dd>
					Settings, Apps, Installed apps, ${s.name}, Uninstall. The uninstaller
					deliberately leaves your data behind — see below — because an uninstall that
					destroys a vault is an uninstall that destroys accounts.
				</dd>
				<dt>Windows portable</dt>
				<dd>
					A portable build has no installer and touches no registry key. Delete the
					<code>.exe</code> and the <code>open-desktop-authenticator</code> folder
					beside it, which is where a portable build keeps everything.
				</dd>
				<dt>Linux AppImage</dt>
				<dd>Delete the <code>.AppImage</code> file. Nothing else was installed.</dd>
				<dt>Linux <code>.deb</code></dt>
				<dd>
					<code>sudo apt remove open-desktop-authenticator</code>, or
					<code>sudo dpkg -r open-desktop-authenticator</code>. As with the Windows
					installer, your data is left alone.
				</dd>
			</dl>

			<h2>2. What is left, and where</h2>
			<p>
				Everything the application stored lives in one directory. Nothing is written
				anywhere else, and nothing was ever sent anywhere.
			</p>
			<dl class="facts">
				<dt>Windows, installed</dt>
				<dd><code>%APPDATA%\\open-desktop-authenticator</code></dd>
				<dt>Windows, portable</dt>
				<dd>
					<code>open-desktop-authenticator</code>, in the same folder as the
					<code>.exe</code>
				</dd>
				<dt>Linux</dt>
				<dd><code>~/.config/open-desktop-authenticator</code></dd>
			</dl>
			<p>Inside it:</p>
			<dl class="facts">
				<dt><code>vault.json</code></dt>
				<dd>
					Your accounts and their Steam secrets, encrypted with your passphrase. This
					is the file that matters.
				</dd>
				<dt><code>vault.json.bak</code></dt>
				<dd>
					The previous version, kept so an interrupted write cannot leave you with
					nothing. Encrypted the same way, and <strong>just as usable to somebody who
					has your passphrase</strong> — deleting only <code>vault.json</code> leaves
					this behind.
				</dd>
				<dt><code>recovery/</code></dt>
				<dd>
					One <code>.oda-recovery</code> file per account enrolled here, holding the
					revocation code for it. Encrypted under the same passphrase-derived key as
					the vault, so they are not a way around a forgotten passphrase — but they
					are secrets, and they are not covered by deleting the vault alone.
				</dd>
			</dl>

			<h2>3. Remove the data</h2>
			<p>
				Delete that directory. There is no uninstaller step that does it for you and no
				hidden second copy: when the directory is gone, everything this application
				stored is gone.
			</p>
			<p>
				It is encrypted at rest either way, so leaving it costs you nothing immediately —
				but it is a file whose whole purpose is to be worth stealing, and there is no
				reason to keep one for software you no longer run.
			</p>
			<p>
				<strong>Exports you made are not in there.</strong> A <code>.maFile</code> you
				exported went wherever you saved it, and those are unencrypted unless you
				encrypted them yourself. If you were leaving for another authenticator, that
				file is the one you are keeping; if you were not, it is the one to delete first.
			</p>

			<h2>Licence</h2>
			<p>
				${s.name} is free software under the MIT licence — you may use, copy, modify and
				redistribute it, and it comes with no warranty.
				<a href="${s.repo}/blob/main/LICENSE" rel="noopener">Read the licence</a>. There
				is no separate end-user agreement, no account, and nothing to cancel.
			</p>

			<h2>Related</h2>
			<ul>
				<li><a href="/download">Download and release status</a></li>
				<li><a href="/steam-revocation-code">Steam revocation code</a></li>
				<li><a href="/lost-authenticator">Lost access to an authenticator</a></li>
			</ul>

${reviewAsk(s, { got: 'Did this cover what you needed to remove?' })}
		</article>`
};

export const docs = {
	slug: 'docs',
	updated: '2026-08-27',
	navTitle: 'Docs',
	title: 'Documentation: setup, codes, confirmations and backups',
	description:
		'Guides for Open Desktop Authenticator: setting up a vault, adding accounts, confirmations, backups, recovery codes and troubleshooting.',
	body: () => `
		<article>
			<h1>Documentation</h1>
			<p class="lede">
				The product manual and the Steam Guard reference library, grouped by the task
				you are trying to complete. If something here is wrong or missing,
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
					The device clock is Valve's first documented check. Codes are generated from the current time, so a
					machine more than about half a minute out produces codes Steam will not
					accept. The application checks its clock against Steam's and warns you when
					it could not. <a href="/steam-guard-code-not-working">The full
					walkthrough, including the fixes on Windows and phone, is here.</a>
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

			<h2>maFile reference</h2>
			<dl class="defs">
				<dt><a href="/what-is-a-mafile">What a maFile contains</a></dt>
				<dd>The secrets, recovery code and session material inside the file, and why each matters.</dd>
				<dt><a href="/how-to-open-mafile">Opening a maFile safely</a></dt>
				<dd>How to inspect a copy locally without uploading live authenticator material.</dd>
				<dt><a href="/encrypted-mafile">Encrypted maFiles and manifest.json</a></dt>
				<dd>Why an SDA passphrase and the matching manifest are both required.</dd>
				<dt><a href="/import-from-sda">Importing from SDA</a></dt>
				<dd>The product workflow for selecting, checking, importing and later exporting accounts.</dd>
			</dl>

			<h2>Move or recover an authenticator</h2>
			<dl class="defs">
				<dt><a href="/lost-authenticator">Lost access completely</a></dt>
				<dd>The recovery routes in the order worth trying, all on Steam's own systems.</dd>
				<dt><a href="/steam-revocation-code">Find or use the recovery code</a></dt>
				<dd>What the R-code does and where to record it before a device is lost.</dd>
				<dt><a href="/move-steam-authenticator-new-phone">Move to a new phone</a></dt>
				<dd>Valve's phone-to-phone transfer and the restriction that follows it.</dd>
				<dt><a href="/move-steam-authenticator-to-pc">Move from a phone to a PC</a></dt>
				<dd>What a Steam transfer changes and why the old copy must be treated as replaced.</dd>
				<dt><a href="/steam-guard-trade-holds">Trade holds and restrictions</a></dt>
				<dd>Each trigger and duration, separated so different restrictions are not confused.</dd>
				<dt><a href="/steam-guard-code-not-working">Codes that Steam refuses</a></dt>
				<dd>Start with time synchronisation, then work through the less common causes.</dd>
			</dl>

			<h2>Choose and use an authenticator</h2>
			<dl class="defs">
				<dt><a href="/steam-guard-without-phone">Steam Guard without a smartphone</a></dt>
				<dd>The difference between needing a mobile device and keeping a phone number for recovery.</dd>
				<dt><a href="/approve-steam-confirmations-desktop">Trade confirmations on desktop</a></dt>
				<dd>How confirmation signing works and which secret and session it requires.</dd>
				<dt><a href="/steam-mobile-vs-desktop-authenticator">Mobile app or desktop</a></dt>
				<dd>The security, recovery and convenience trade-offs between device types.</dd>
				<dt><a href="/alternatives">Authenticator options compared</a></dt>
				<dd>Valve's app, SDA and this project, including the case against choosing ours.</dd>
				<dt><a href="/faq">Product FAQ</a></dt>
				<dd>Short answers about cost, platform support, privacy, imports and losing a passphrase.</dd>
			</dl>
		</article>`
};

export const faq = {
	slug: 'faq',
	parent: 'docs',
	updated: '2026-08-25',
	navTitle: 'FAQ',
	title: 'FAQ: Steam Guard codes, maFiles and security',
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
	body: (s) => `
		<article>
			<h1>Frequently asked questions</h1>
			${FAQ_ITEMS.map(
				(item) => `
			<section class="faq-item">
				<h2>${item.q}</h2>
				${typeof item.a === 'function' ? item.a(s) : item.a}
			</section>`
			).join('')}

			<!--
				The troubleshooting hub.

				Put here rather than in the navigation deliberately. These pages answer
				Steam problems rather than questions about this application, so they do
				not belong in a nav bar aimed at someone evaluating the product — but
				they were reachable only from the sitemap, which for the busiest of them
				meant no internal link at all. A reader who arrives at the FAQ with a
				broken authenticator is exactly the person they are for.
			-->
			<section class="faq-item">
				<h2>Common Steam Guard problems</h2>
				<p>
					Answers to the Steam problems people arrive here with. None of these
					require our software, and most are solved on Steam itself.
				</p>
				<ul class="plain next">
					<li><a href="/steam-guard-code-not-working">My codes are being refused</a> — start with the clock</li>
					<li><a href="/move-steam-authenticator-new-phone">Moving to a new phone</a> — and the two-day versus fifteen-day difference</li>
				<li><a href="/move-steam-authenticator-to-pc">Moving one to a PC</a> — what Steam's transfer actually does to the phone's copy</li>
				<li><a href="/steam-guard-trade-holds">Every trade hold and restriction</a> — by cause and duration, quoted from Valve</li>
					<li><a href="/steam-revocation-code">Finding my recovery code</a> — the R-code, and where it still is</li>
					<li><a href="/lost-authenticator">I have lost access completely</a></li>
					<li><a href="/steam-guard-without-phone">Doing this without a smartphone</a></li>
					<li><a href="/how-to-open-mafile">Opening a maFile safely</a>, and <a href="/encrypted-mafile">when it is encrypted</a></li>
					<li><a href="/approve-steam-confirmations-desktop">How trade confirmations work</a></li>
					<li><a href="/steam-mobile-vs-desktop-authenticator">Mobile app or desktop?</a></li>
				</ul>
			</section>
		</article>`
};

const FAQ_ITEMS = [
	{
		q: 'Is it free?',
		plain:
			'Yes. It is free and open source under the MIT licence. There is no paid tier, no account, and no telemetry.',
		a: `<p>Yes. Free and open source under the <a href="${'https://github.com/opendesktopauthenticator/open-desktop-authenticator/blob/main/LICENSE'}" rel="noopener">MIT licence</a>. There is no paid tier, no account to create, and no telemetry. It is published by MASTERPANEL LLC as an open-source project.</p>`
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
			'Do not take our word for it. The source is public, the publisher is a registered company, and 1.0 is out — so the honest answer includes what is still not finished.',
		/*
		 * **Derived, because this paragraph made a promise it was breaking.**
		 *
		 * Its last sentence says the site refuses to build if any page goes on
		 * saying something is missing after it is not — and this paragraph was
		 * saying "Nothing signs the checksum list" long after cosign started
		 * signing it. The claim was true of the machinery and false of the page
		 * making it. Now the list comes from the flags, so the sentence is
		 * describing something that actually holds.
		 */
		a: (s) => {
			const open = releaseGaps(s, 'sentence');
			const enforcement = `<a href="/download">The download page tracks each of those</a>, and the site refuses to build if any page here claims one of them before it is true, or goes on saying it is missing after it is not.`;
			return `<p>Do not take our word for it — that is the entire design. Here is what you can check <strong>today</strong>: the source is public and you can build and run it yourself; the publisher is a named, registered company you can look up; and the site tells you <a href="/verify">how to check any download</a>, ours or anyone else's.</p>
			<p>${
				open.length
					? `And here is what is <strong>not</strong> finished, because a page that only lists the reassuring half is doing the thing it warns you about. ${open.join(' ')} ${enforcement}`
					: `Everything this answer used to list as unfinished is now done. ${enforcement}`
			}</p>
			<p>We would rather you were sceptical of us and safe than trusting and robbed.</p>`;
		}
	},
	{
		q: 'What happens if I lose my vault passphrase?',
		plain:
			'The vault cannot be opened. There is no reset and no recovery, because either would be a back door. The recovery files this application writes are encrypted under the same passphrase, so they do not help. What helps is the revocation code you wrote down outside the vault; without it, Steam Support is the remaining route.',
		a: `<p>The vault cannot be opened. There is no reset, no master key and no support process that gets around it, because every one of those would be a back door into everyone else's vault too.</p>
			<p><strong>The recovery files this application writes will not help either.</strong> They are encrypted under the same passphrase-derived key as the vault, so losing the passphrase locks them in exactly the same way. Anything still inside this application is gone with it.</p>
			<p>What can still work is whatever you kept <em>outside</em> it: the revocation code for each account — the <code>R</code> code Valve now calls your recovery code, stored as <code>revocation_code</code> in a maFile — written down somewhere that is not the vault. With it you can detach the authenticator from Steam yourself. Without it, Steam Support is the remaining route, and they will want to verify the account. This is why the application insists you write that code down before it will call an account active.</p>`
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
		plain:
			'Open Desktop Authenticator runs on Windows 10 and 11, and on Linux. Install it from the Microsoft Store or from the GitHub releases page.',
		a: `<p>Windows 10 version 1809 or later, Windows 11, and Linux. macOS is deferred rather than planned, because we will not ship a macOS build we cannot sign. See <a href="/download">the download page</a> for the Store listing and the direct builds.</p>`
	}
];

export const support = {
	slug: 'support',
	navTitle: 'Support',
	// Reveals the attachment field and uploads the files. The form works without it.
	script: 'support.js',
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

			<!--
				Deliberately not multipart. Files are uploaded one at a time to
				/support/attach and referenced here by id, so this stays a plain
				urlencoded post that works with script disabled — and so the server
				never has to parse multipart, which is a notoriously sharp thing to
				hand-roll and the last place this project wants a parser bug.
			-->
			<form class="form" method="post" action="/support/submit">
				<div class="field">
					<label for="kind">What is this about?</label>
					<select id="kind" name="kind" required>
						<option value="bug">A bug in the application</option>
						<option value="documentation">Something on this site is wrong or missing</option>
						<option value="clone-site">A suspected fake or clone download</option>
						<option value="security">A security problem</option>
						<option value="other">Something else</option>
					</select>
				</div>

				<div class="field">
					<label for="summary">One line</label>
					<input id="summary" name="summary" type="text" maxlength="140" minlength="8" required
					       placeholder="Codes are rejected after importing from SDA">
				</div>

				<div class="field">
					<label for="detail">What happened</label>
					<textarea id="detail" name="detail" rows="8" maxlength="4000" minlength="20" required
					          placeholder="What you did, what you expected, what happened instead. Application version and operating system if it is a bug. For a clone site: the URL and where you found it."></textarea>
				</div>

				<!--
					Attachments are revealed by /assets/support.js. Without script there is
					no way to upload, so the control stays hidden rather than sitting there
					inert and taking a click that does nothing.
				-->
				<div class="field" data-attach hidden>
					<label for="files">Screenshots or a short video (optional)</label>
					<div class="dropzone" data-dropzone tabindex="0" role="button"
					     aria-describedby="files-hint">
						<strong>Drop files here, or choose them</strong>
						<p class="hint" id="files-hint">
							PNG, JPEG, GIF or WebP up to 6&nbsp;MB. MP4 or WebM up to 20&nbsp;MB.
							Four files at most.
						</p>
						<input id="files" type="file" multiple
						       accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm">
					</div>
					<p class="hint">
						<strong>Check the picture before you choose it.</strong> A screenshot of
						the application can have a code, an account name or a recovery code in the
						corner of it, and a screen recording can have far more than you meant to
						include. The check that refuses secrets in this form reads text — it
						cannot see inside an image, so nothing here will catch a secret that is
						only in a picture.
					</p>
					<p class="hint">
						Files upload as soon as you choose them, so we can check the type and size
						before you finish writing. <strong>Remove</strong> deletes our copy, not
						just the thumbnail. Anything you never attach to a report is deleted
						within two hours. <a href="/privacy">What we keep, and for how long</a>.
					</p>
					<ul class="attachments" data-list></ul>
				</div>

				<div class="field">
					<label for="contact">Where to reply, if you want one (optional)</label>
					<input id="contact" name="contact" type="text" maxlength="120"
					       placeholder="An email address, or leave this blank">
					<p class="hint">
						No account is created either way. You get a reference you can use to check
						back; leaving an address just means we can ask a follow-up question, which is
						often the difference between a fixed bug and a closed one.
					</p>
				</div>

				<div class="controls">
					<button type="submit">Send the report</button>
				</div>
			</form>

			<div class="callout">
				<p>
					Reports containing what looks like a shared secret, an identity secret, a
					revocation code or a private key are <strong>refused and not stored</strong>.
					That is deliberate: the check is in the code, not just in the sentence above.
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
					<strong>You get a link</strong>, holding a reference in the form
					<code>ODA-7K2M-B9QW</code> and the key that opens it. <strong>Keep the whole
					link</strong> — the reference on its own will not open the report, and there
					is no account to recover it from.
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

			<h2 id="security-reports">Security reports</h2>
			<p>
				<strong>Do not open a public issue for a security problem.</strong> There are
				two private routes, both live now:
			</p>
			<ul class="plain next">
				<li>
					<strong><a href="https://github.com/opendesktopauthenticator/open-desktop-authenticator/security/advisories/new" rel="noopener">GitHub private vulnerability
					reporting</a></strong> — preferred. It is private, it threads, and it does
					not depend on an address staying monitored.
				</li>
				<li>
					<strong>By email</strong>, if you would rather not use GitHub. The address is
					published in
					<a href="/.well-known/security.txt">our security.txt</a>, which is the
					standard place to look for it and the one place we keep it. It is
					deliberately not printed on this page: an address in HTML is harvested within
					days, and a security contact buried under spam is a security contact that
					misses the report that mattered.
				</li>
			</ul>
			<p>
				What we commit to, in writing: acknowledgement within 72 hours, an initial
				assessment within 7 days, and a fix or a dated plan within 30 days for a
				confirmed high or critical. Those are the commitments of a single maintainer,
				and if one is going to be missed we will say so before the deadline rather than
				after. The full policy is in
				<a href="${'https://github.com/opendesktopauthenticator/open-desktop-authenticator/blob/main/SECURITY.md'}" rel="noopener">SECURITY.md</a>.
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
