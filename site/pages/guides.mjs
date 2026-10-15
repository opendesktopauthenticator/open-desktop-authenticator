import { releaseGaps, reviewAsk } from '../markup.mjs';
import { publicationSummary } from '../publication.mjs';

/** Download status, migration, documentation hub, FAQ, support and 404. */

export const download = {
	slug: 'download',
	updated: '2026-10-15',
	reviewed: '2026-10-15',
	navTitle: 'Download',
	title: 'Download Open Desktop Authenticator for Windows and Linux',
	description:
		'Download ODA from four official sources: Microsoft Store, GitHub, Softonic or Uptodown. Compare Windows and Linux packages, updates and verification steps.',
	body: (s) => `
		<article>
			<h1>Download Open Desktop Authenticator</h1>
			<p class="lede">${publicationSummary(s)} Choose your package below.
				These are ODA downloads, an independent alternative to
				<a href="/steam-desktop-authenticator">the original Steam Desktop Authenticator</a>.</p>

			<div class="callout" data-download>
				<h2>Choose from four official sources</h2>
				<div class="download-actions">
					<a class="button" href="${s.store.url}" rel="noopener">Microsoft Store ${s.publication.store.latestVersion}</a>
					<a class="button button-quiet" href="${s.repo}/releases/tag/v${s.publication.github.latestVersion}" rel="noopener">GitHub ${s.publication.github.latestVersion}: all packages</a>
					${s.uptodown ? `<a class="button button-quiet" href="${s.uptodown.url}" rel="noopener">Uptodown ${s.uptodown.version}: Windows x64</a>` : ''}
					${s.softonic ? `<a class="button button-quiet" href="${s.softonic.url}" rel="noopener">Softonic ${s.softonic.version}: read notice below</a>` : ''}
				</div>
				<p>The Store package is x64, and Uptodown lists the original x64 installer. <a href="#softonic-download-route">Read the Softonic download notice</a> before using its listing. GitHub offers native x64 and ARM64 Windows installers,
					portable x64, and x64 Linux packages. Check your computer's system type before
					choosing an installer.</p>
			</div>

			<div class="tbl" role="region" aria-label="ODA packages and update routes" tabindex="0">
				<table>
					<thead><tr><th scope="col">Your device or workflow</th><th scope="col">Package</th><th scope="col">Updates and limits</th></tr></thead>
					<tbody>
						<tr><th scope="row">Windows, with Microsoft Store</th><td><a href="${s.store.url}" rel="noopener">Store ${s.publication.store.latestVersion}</a> (x64)</td><td>Store-managed updates, subject to your settings. The recorded Store package is x64; use GitHub for native ARM64.</td></tr>
						${s.uptodown ? `<tr><th scope="row">Windows, through Uptodown</th><td><a href="${s.uptodown.url}" rel="noopener">Windows x64 listing</a></td><td>Download later updates manually. Verify the actual ODA installer's publisher signature and release checksum.</td></tr>` : ''}
						${s.softonic ? `<tr><th scope="row">Windows, through Softonic</th><td><a href="${s.softonic.url}" rel="noopener">Windows x64 listing</a></td><td>A tested public route returned a separate Softonic downloader. <a href="#softonic-download-route">Read the unresolved download notice</a>; use another source for now.</td></tr>` : ''}
						<tr><th scope="row">Intel/AMD Windows PC</th><td><code>open-desktop-authenticator-${s.publication.github.latestVersion}-x64-setup.exe</code></td><td>Direct installer; download later updates manually.</td></tr>
						<tr><th scope="row">Windows on Arm</th><td><code>open-desktop-authenticator-${s.publication.github.latestVersion}-arm64-setup.exe</code></td><td>Native ARM64 installer. Native ARM64 execution is not claimed in the release's manual test record.</td></tr>
						<tr><th scope="row">One installer for x64 and ARM64 Windows</th><td><code>open-desktop-authenticator-${s.publication.github.latestVersion}-setup.exe</code></td><td>Combined installer from the same GitHub release.</td></tr>
						<tr><th scope="row">Portable Windows x64</th><td><code>open-desktop-authenticator-${s.publication.github.latestVersion}-portable.exe</code></td><td>Vault/settings stay beside the executable. Keep that data when replacing the executable to update.</td></tr>
						<tr><th scope="row">Linux x64</th><td><code>open-desktop-authenticator-${s.publication.github.latestVersion}-x86_64.AppImage</code> or <code>open-desktop-authenticator-${s.publication.github.latestVersion}-amd64.deb</code></td><td>Published packages; Linux manual runtime checks remain uncompleted in the maintainer record. No Linux ARM64 package.</td></tr>
					</tbody>
				</table>
			</div>
			<p>Get every direct package from the <a href="${s.repo}/releases/tag/v${s.publication.github.latestVersion}" rel="noopener">GitHub release assets</a>.
				Do not select the source-code ZIP when you want an installer. No macOS build is published.
				Windows builds target Windows 10 version 1809 or later and Windows 11; that minimum
				is not a recommendation to use an operating system without security updates.</p>

			<h2>Four official download sources</h2>
			<p>Get ODA from the <strong>Microsoft Store, GitHub, Softonic or Uptodown</strong>.
				This website links to downloads and does not serve an installer itself.
				Check <strong>MASTERPANEL LLC</strong> as publisher and use the
				<a href="/official">official-address reference</a> if a link looks unfamiliar.</p>
			${
				s.softonic
					? `<p><strong>Softonic's labels:</strong>
					<a href="${s.softonic.url}" rel="noopener">Open Desktop Authenticator for Windows</a>.
					Softonic displays <strong>“Official distributor”</strong>, meaning it has authorization to distribute ODA,
					and <strong>“Trusted Program”</strong>, with a clean VirusTotal scan reported for the listed file.
					These labels were checked on 1 October 2026. They describe distribution authorization and a file scan;
					they are not an independent security audit of ODA.
					The listing is for Windows x64; the labels do not establish what the public download route delivers.
					Use GitHub for native ARM64, portable Windows or Linux packages. For a downloaded ODA installer, check its MASTERPANEL LLC signature
					and compare its checksum with the matching GitHub release using <a href="/verify">our verification steps</a>.</p>`
					: ''
			}
			<aside class="callout" id="softonic-download-route" aria-labelledby="softonic-route-title">
				<h2 id="softonic-route-title">Softonic download notice</h2>
				<p>A public Softonic download tested on 1 October 2026 returned a separate Softonic downloader
					instead of the original ODA installer. Resolution is not verified. Use Microsoft Store, GitHub
					or Uptodown, and <a href="/verify">verify the actual ODA file</a>.</p>
			</aside>
			${
				s.uptodown
					? `<p><strong>Uptodown:</strong> <a href="${s.uptodown.url}" rel="noopener">ODA ${s.uptodown.version} for Windows x64</a>
				is listed under MASTERPANEL LLC. On 15 October 2026, its displayed SHA-256 matched the original GitHub x64 installer's
				published checksum. This verifies the listing information; check the signature and checksum of the file you actually download.</p>`
					: ''
			}
			<p>Microsoft signs the Store AppX package and checks its integrity during installation.
				The Store's package signature is separate from a publisher signature on a direct
				download. See <a href="https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements" rel="noopener">Microsoft's signing requirements</a>
				and <a href="https://support.microsoft.com/en-us/windows/apps/turn-on-automatic-app-updates" rel="noopener">Store update settings</a>.</p>
			<p>${
				s.release.codeSigned
					? `<strong>GitHub ${s.publication.github.latestVersion} Windows downloads are signed and timestamped as MASTERPANEL LLC</strong>
					using Microsoft Azure Artifact Signing.`
					: '<strong>This GitHub release has no publisher code signature on its Windows downloads.</strong>'
			}
				SmartScreen may still warn, and device policy may block an application. A valid
				signature is not a reason to dismiss a malware detection.
				<a href="/verify">Verify the file before running it</a>.</p>

			<h2>Install or update without losing your accounts</h2>
			<ol>
				<li><strong>Back up first if you already use ODA.</strong> Keep an independent encrypted
					vault backup, its passphrase and recovery information. Updating the app and replacing
					an account's Steam authenticator are different operations.</li>
				<li><strong>Choose one distribution route.</strong> The Store manages its edition's updates.
					Direct builds obtained from GitHub, Softonic or Uptodown can report a newer GitHub release but do not download or install it.
					The portable build has no Store equivalent.</li>
				<li><strong>For a new setup, create your vault.</strong> Then use
					<a href="/import-from-sda">Import maFiles</a> for existing SDA files, or follow
					<a href="/docs">the setup documentation</a>. A phone authenticator requires a
					different <a href="/move-steam-authenticator-to-pc">transfer workflow</a>.</li>
			</ol>
			<p>The portable launcher keeps account data beside the executable but extracts runtime
				files to Windows Temp while running. It normally removes those runtime files on exit.
				Portable packaging does not bypass an organisation's device policy.</p>

			<h2>Installing a verified Linux download</h2>
			<p>Choose one package. On Debian or Ubuntu, from the download directory, run
				<code>sudo apt install ./open-desktop-authenticator-${s.publication.github.latestVersion}-amd64.deb</code>.
				For the AppImage, enable its executable permission in your file manager, or run
				<code>chmod +x ./open-desktop-authenticator-${s.publication.github.latestVersion}-x86_64.AppImage</code>,
				then open it as your normal user. If it does not launch, report the error and your
				distribution/version through <a href="/support">support</a>. Package availability
				does not establish compatibility with every distribution.</p>

			<h2>What is finished</h2>
			<ul>
				<li>Implemented features include codes, confirmations, enrollment, import/export,
					an encrypted vault and recovery files. <a href="/security">Read their security boundaries</a>.</li>
				<li>${
					s.release.checksums
						? 'Published checksums in <code>SHA256SUMS.txt</code> identify the release bytes.'
						: 'A published checksum list is not available for this release.'
				}
					<a href="/verify">Follow the available verification procedure</a>, including how
					to inspect build provenance and the producing workflow.</li>
				${
					s.release.codeSigned
						? `<li>Windows installers and the portable executable are signed and
					timestamped as MASTERPANEL LLC using Microsoft Azure Artifact Signing. Linux packages
					do not carry a platform code signature.</li>`
						: ''
				}
				${
					s.release.checksums && s.release.signed
						? `<li>The current GitHub release includes <code>SHA256SUMS.txt.sig</code>
					and its certificate for checking the checksum list's origin.</li>`
						: ''
				}
				<li><a href="${s.repo}/releases/tag/v${s.publication.github.latestVersion}" rel="noopener">The release notes</a>
					identify its automated and manual checks. Historical maintainer testing is recorded in
					<a href="${s.repo}/blob/main/docs/FOUNDER_TEST_PLAN.md" rel="noopener">the founder test plan</a>.
					Those older observations are not a new test of every current package.</li>
			</ul>

			<h2>What is still missing</h2>
			<ul>
				${
					s.release.codeSigned
						? ''
						: `<li>A publisher code signature for this release's direct
					Windows downloads. Store package signing is separate; see the <a href="/code-signing-policy">signing policy</a>.</li>`
				}
				${
					s.release.checksums && s.release.signed
						? ''
						: `<li>The checksum list is not signed yet for this release;
					there is no <code>SHA256SUMS.txt.sig</code> to verify. <a href="/verify">Check the available verification steps</a>.</li>`
				}
				${
					s.release.reproducible
						? ''
						: `<li><strong>Reproducible builds.</strong> Independently rebuilding
					the tag to match the published bytes is not yet established. Build provenance does
					not substitute for that comparison.</li>`
				}
				${
					s.release.audited
						? ''
						: `<li><strong>An independent security audit.</strong> Maintainer test
					records and automated checks do not establish independent review.</li>`
				}
				<li><strong>Manual coverage for every platform and workflow.</strong> The maintainer record
					still lists Linux runtime, live two-account proxy isolation and the signed-in browser
					handoff as gaps. The release notes do not claim native ARM64 execution.</li>
			</ul>

			<h2>Source, licence and help</h2>
			<p>ODA is free software under the <a href="${s.repo}/blob/main/LICENSE" rel="noopener">MIT licence</a>,
				with no ODA account or subscription. The <a href="${s.repo}" rel="noopener">source repository</a>
				includes build instructions. Public code and release signatures establish inspectability
				and origin; they do not establish harmlessness.</p>
			<ul class="plain next">
				<li><a href="/verify">Verify your ODA download</a></li>
				<li><a href="/import-from-sda">Import existing SDA accounts</a></li>
				<li><a href="/uninstall">Remove ODA while preserving account access</a></li>
				<li><a href="/alternatives">Compare options before choosing a desktop authenticator</a></li>
			</ul>

${reviewAsk(s, { got: 'Did the download and setup instructions help?' })}
		</article>`
};

export const importFromSda = {
	slug: 'import-from-sda',
	parent: 'docs',
	guide: true,
	updated: '2026-09-30',
	reviewed: '2026-09-30',
	sourced: (s) =>
		`Version covered: ODA ${s.version}. Steps checked against <a href="${s.repo}/blob/v${s.version}/src/renderer/screens/ImportAccounts.tsx" rel="noopener">the release's import screen</a>, <a href="${s.repo}/tree/v${s.version}/src/main/import" rel="noopener">import implementation</a> and <a href="${s.repo}/blob/v${s.version}/tests/import-service.test.ts" rel="noopener">service tests</a>. This is a source review, not a new live Steam migration test`,
	navTitle: 'Import',
	title: 'Import maFiles from SDA',
	description:
		'Import readable or encrypted SDA maFiles into ODA. Keep your source files, resolve import warnings, and check codes and confirmations separately.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'HowTo',
		name: 'Import maFiles from Steam Desktop Authenticator',
		publisher: { '@type': 'Organization', name: s.publisher },
		step: [
			{ '@type': 'HowToStep', name: 'Back up the SDA folder and create or unlock an ODA vault' },
			{ '@type': 'HowToStep', name: 'Select the files, including manifest.json if encrypted' },
			{ '@type': 'HowToStep', name: 'Enter the SDA passphrase if the files are encrypted' },
			{ '@type': 'HowToStep', name: 'Review accounts and import the selected rows' },
			{
				'@type': 'HowToStep',
				name: 'Check codes, Steam session and confirmation access separately'
			}
		]
	}),
	body: () => `
		<article class="guide">
			<h1>Importing maFiles from Steam Desktop Authenticator</h1>
			<p class="lede">
				In ODA, open <strong>Import maFiles → Choose files</strong>, select your SDA
				files, unlock them if encrypted, and review the accounts before importing.
				ODA reads the source files without moving or changing them. This copies an
				existing authenticator; it does not enroll a new one or transfer it off a phone.
			</p>

			<h2>Before you start</h2>
			<div class="callout">
				<p>
					<strong>Keep an independent backup of the complete SDA folder.</strong>
					Do not delete the original or remove Steam Guard to perform this import.
					Turn off automatic confirmation in both applications while checking the setup.
					Retain the backup after migration; matching login codes alone does not verify
					every credential in a maFile.
				</p>
			</div>

			<h2>1. Prepare the vault and find your maFiles</h2>
			<p><a href="/download">Install the ODA package for your device</a>, then create
				or unlock its vault. Keep the ODA vault passphrase separately from your backup.
				It may be different from the password you used to encrypt SDA files.</p>
			<p>
				They live in the <code>maFiles</code> folder inside your SDA installation
				directory, one <code>.maFile</code> per account, named after the SteamID —
				plus a <code>manifest.json</code>.
			</p>
			<ul>
				<li><strong>Readable files:</strong> select the account's <code>.maFile</code>.</li>
				<li><strong>Encrypted SDA files:</strong> retain each <code>.maFile</code>, its matching
					<code>manifest.json</code> and the SDA encryption passphrase as a recovery set.</li>
				<li><strong>No maFile, only a phone authenticator:</strong> this guide cannot export
					secrets from Steam Mobile. Read the <a href="/move-steam-authenticator-to-pc">phone-to-PC transfer guide</a>.</li>
			</ul>

			<h2>2. Select them</h2>
			<p>
				Choose <strong>Import maFiles</strong> on the accounts screen, then
				<strong>Choose files…</strong> and select the account files. If your maFiles are
				encrypted you also need <code>manifest.json</code>: it holds the salt and
				initialisation vector, and without it an encrypted maFile cannot be decrypted at
				all. If you select an encrypted file and forget the manifest, the application
				looks for one beside the files you picked and adds it for you.
			</p>

			<h2>3. Unlock, if they are encrypted</h2>
			<p>
				You will be asked for the passphrase you set in SDA — not your Steam password,
				and not the passphrase for this application's vault. It is used to decrypt the
				files in memory and is not stored. Select <strong>Decrypt</strong>; readable
				accounts then appear under <strong>Found</strong>. If no files are encrypted,
				skip this step.
			</p>

			<h2>4. Review what was found</h2>
			<p>
				Nothing has been written yet at this point. The report lists each account it
				could read and flags anything that matters:
			</p>
			<ul>
				<li>Accounts already in your vault, so you do not import a duplicate.</li>
				<li>
					An <code>identity_secret</code> that is present but unusable — the account
					remains selectable with a warning. Login codes may still work when the
					<code>shared_secret</code> is usable, but confirmations will not.
				</li>
				<li>
					A maFile with no revocation code. ODA cannot use its built-in deactivation
					option without that code; Steam may offer recovery through a linked phone
					number or Steam Support. <a href="/lost-authenticator">Recovery routes</a>.
				</li>
				<li>A proxy setting found inside the file. Its separate opt-in starts off;
					leave it off unless you recognise and still use that routing address.</li>
				<li>
					Files that could not be read at all, and why. A missing or empty
					<code>identity_secret</code> is rejected here rather than imported.
				</li>
			</ul>
			<p>
				Check the account name and SteamID, tick only the rows you want, then select
				<strong>Import</strong> with the displayed account count. Existing vault accounts
				start unticked: choosing one permits replacing its stored copy. Back up the vault
				before doing that. If you opted into a proxy, a separate dialog identifies its
				address before import; decline it if you do not recognise the destination.
			</p>
			<p>
				Read each <strong>Result</strong> row: <em>imported</em> and <em>replaced</em>
				mean the vault entry was written; <em>skipped</em> does not. An imported account
				can still have a recovery-backup warning that needs attention.
				Uncommitted staged files are discarded when you leave, lock the vault, or the
				ten-minute staging window expires.
			</p>

			<h2>5. Confirm the codes match</h2>
			<p>
				Put ODA and a working copy of that account's authenticator side by side and
				compare the five-character codes within the same time window. If they differ,
				check the account and <a href="/steam-guard-code-not-working">time synchronisation</a>.
				Matching codes checks code generation at that moment, not all account functions.
			</p>
			<dl class="defs">
				<dt>Steam session and confirmations</dt>
				<dd>Open Confirmations for that account and sign in when prompted. Refresh the list.
					A successfully loaded empty list is different from a sign-in or connection error;
					neither a matching code nor a file import proves a pending confirmation can be approved.
					<a href="/approve-steam-confirmations-desktop">Troubleshoot the session and review workflow</a>.
					Do not create or approve a trade merely to finish this guide.</dd>
				<dt>Recovery and backups</dt>
				<dd>Keep the original backup and confirm you can read the saved recovery information.
					Record the recovery code outside the vault where available. Do not deactivate
					Steam Guard to test a code; <a href="/steam-revocation-code">review the recovery-code guidance</a>.</dd>
			</dl>

			<h2>If an import does not complete</h2>
			<div class="tbl" role="region" aria-label="Import problems and next steps" tabindex="0">
				<table>
					<thead><tr><th scope="col">What ODA shows</th><th scope="col">Next step</th></tr></thead>
					<tbody>
						<tr><th scope="row">Encrypted, missing manifest</th><td>Choose the files again with the matching <code>manifest.json</code> from the same SDA backup. A passphrase cannot replace missing encryption parameters.</td></tr>
						<tr><th scope="row">Decryption failed</th><td>Check the SDA encryption passphrase and that the manifest belongs to those files. It is not your Steam password or ODA vault passphrase. <a href="/encrypted-mafile">Diagnose encrypted files</a>.</td></tr>
						<tr><th scope="row">Already in the vault</th><td>Leave it unticked to preserve the existing entry. Replace only when the selected file is the copy you intend to use.</td></tr>
						<tr><th scope="row">Not imported or unusable secret</th><td>Read the reason on that file's row. Use a known-good backup; changing the extension or inventing missing fields cannot reconstruct an authenticator.</td></tr>
						<tr><th scope="row">Staging expired or vault locked</th><td>Unlock the vault and choose the files again. Nothing left only in the preview was imported.</td></tr>
					</tbody>
				</table>
			</div>

			<h2>Leaving again</h2>
			<p>
				Use an account's <strong>Export</strong> button to save a standard
				<code>.maFile</code>. The file is <strong>unencrypted</strong>, even when the
				original import was encrypted. It contains authenticator secrets and any
				revocation code. Store it in a secure location and never upload it to a website
				or support report. ODA deliberately omits the Steam refresh token and proxy
				configuration: sign in again and configure routing in the destination app.
				Code compatibility does not guarantee that an unmaintained app's Steam login
				or confirmation features still work.
			</p>

			<h2>Related</h2>
			<ul class="plain next">
				<li><a href="/what-is-a-mafile">What is actually inside a maFile</a></li>
				<li><a href="/encrypted-mafile">Encrypted maFiles: the password and the manifest</a></li>
				<li><a href="/security">How they are stored once imported</a></li>
				<li><a href="/docs">Full documentation</a></li>
			</ul>
		</article>`
};

export const uninstall = {
	slug: 'uninstall',
	guide: true,
	updated: '2026-10-15',
	reviewed: '2026-10-15',
	sourced: (s) =>
		`Version covered: ODA ${s.version}. Installed and portable data roots checked against <a href="${s.repo}/blob/v${s.version}/src/main/index.ts" rel="noopener">the tagged application path setup</a>; vault and backup names against <a href="${s.repo}/blob/v${s.version}/src/main/vault/storage.ts" rel="noopener">storage</a>; recovery paths against <a href="${s.repo}/blob/v${s.version}/src/main/vault/recovery.ts" rel="noopener">recovery</a>; package behavior against <a href="${s.repo}/blob/v${s.version}/electron-builder.config.mjs" rel="noopener">the release configuration</a>`,
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
				name: 'Preserve access before deleting data',
				text: 'For each account, verify another working authenticator or a usable backup, or deliberately remove the authenticator through Steam. Keep the recovery code outside the vault.'
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
		<article class="guide">
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
					application was generating. Deleting your only usable copy can leave you
					unable to sign in until you complete Steam's recovery process.
				</p>
				<p>Either, for each account:</p>
				<ul>
					<li>
						<strong>Verify access elsewhere</strong> — check another working copy of
						the authenticator, or make and test a secure export or backup before
						removing this one. Uninstalling ODA does not require disabling Steam Guard.
					</li>
					<li>
						<strong>If you intend to deactivate it</strong>, use Remove account and
						explicitly select <em>Also remove the authenticator from Steam</em>. Ordinary
						removal only removes the vault entry. Deactivation needs the revocation
						code and your passphrase; it can cause Steam trading restrictions. Read
						<a href="/steam-guard-trade-holds">the consequences</a> first.
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
					If you have no working copy or usable backup and the vault is already gone,
					<a href="/lost-authenticator">the recovery routes are here</a>.
				</p>
			</div>

			<h2>1. Remove the application</h2>
			<dl class="facts">
				<dt>Microsoft Store</dt>
				<dd>
					Start menu, right-click ${s.name}, Uninstall. Or Settings, Apps, Installed
					apps. Back up your data first: package removal may also remove
					Windows-managed package data.
				</dd>
				<dt>Windows installer (the <code>.exe</code> from GitHub, Softonic or Uptodown)</dt>
				<dd>
					Settings, Apps, Installed apps, ${s.name}, Uninstall. The uninstaller
					deliberately leaves your data behind so that removing the program does not
					also remove your stored authenticator secrets.
				</dd>
				<dt>Windows portable</dt>
				<dd>
					A portable build has no installer. Delete the
					<code>.exe</code> and the <code>open-desktop-authenticator</code> folder
					beside it, which is where it keeps the vault, settings, recovery records and
					other normal application data. While it runs, the single-file launcher also
					extracts Electron and Chromium runtime files to Windows Temp; it normally
					removes that runtime-only stage on exit.
				</dd>
				<dt>Linux AppImage</dt>
				<dd>Quit ODA and delete the <code>.AppImage</code> file. Remove any launcher or
				shortcut you created, then deal with application data below.</dd>
				<dt>Linux <code>.deb</code></dt>
				<dd>
					<code>sudo apt remove open-desktop-authenticator</code>, or
					<code>sudo dpkg -r open-desktop-authenticator</code>. As with the Windows
					installer, your data is left alone.
				</dd>
			</dl>

			<h2>2. What is left, and where</h2>
			<p>
				This project operates no server that stores a copy of your vault or account
				data. The application's persistent data lives in the directory below.
				Requested authenticator and confirmation operations send the necessary
				requests to Steam, and the optional update check contacts GitHub when it is
				enabled. <a href="/privacy">The privacy page names those destinations and
				what they receive.</a>
			</p>
			<dl class="facts">
				<dt>Windows, installed from GitHub, Softonic or Uptodown</dt>
				<dd><code>%APPDATA%\\open-desktop-authenticator</code></dd>
				<dt>Microsoft Store</dt>
				<dd>Windows may redirect the application's data into the package's private
				storage under <code>%LOCALAPPDATA%\\Packages</code>. Check the ODA package's
				<code>LocalCache\\Roaming\\open-desktop-authenticator</code> directory as
				well as the installed path above. Locate and back up the actual vault before
				uninstalling; do not delete other applications' package folders.
				<a href="https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes" rel="noopener">Microsoft documents this possible AppData redirection</a>.</dd>
				<dt>Windows, portable</dt>
				<dd>
					<code>open-desktop-authenticator</code>, in the same folder as the
					<code>.exe</code>
				</dd>
				<dt>Linux</dt>
				<dd><code>~/.config/open-desktop-authenticator</code> by default, or
				<code>$XDG_CONFIG_HOME/open-desktop-authenticator</code> when that environment
				variable overrides the configuration directory.</dd>
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
					The previous saved version, kept to help recover from a failed write.
					Encrypted too, and <strong>just as usable to somebody who
					has your passphrase</strong> — deleting only <code>vault.json</code> leaves
					this behind.
				</dd>
				<dt><code>recovery/</code></dt>
				<dd>
					<code>.oda-recovery</code> files created for imported, enrolled or transferred
					authenticators. They contain account secrets and any recovery code, not just
					the recovery code. Each is encrypted using the vault key in force when that
					file was written. Older copies may need an older passphrase, and a later
					authenticator transfer can make an old file's secrets obsolete.
				</dd>
				<dt>Other application files</dt>
				<dd>Interrupted-operation records, recovery staging files and Chromium data
				can also live here. Remove the whole ODA data directory when you intend to
				remove its local data, not only the three entries listed above.</dd>
			</dl>

			<h2>3. Remove the data</h2>
			<p>
				Quit ODA completely, including its tray icon, then delete its data directory
				if it remains after uninstalling. This removes that local copy. Check any
				other installation or portable folder, exports and backups separately.
				Files in the Recycle Bin, system backups or cloud-synced folders can remain
				recoverable; ordinary deletion is not a secure-erasure guarantee.
			</p>
			<p>
				Vault and recovery contents are encrypted. Other application data is not
				necessarily encrypted in the same way. Keep the encrypted backups you still
				need for access, with their passphrases stored separately.
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
				is no separate ODA end-user agreement or ODA account, and nothing to cancel.
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
	updated: '2026-09-30',
	reviewed: '2026-09-30',
	navTitle: 'Docs',
	title: 'Documentation: setup, codes, confirmations and backups',
	description:
		'Guides for Open Desktop Authenticator: setting up a vault, adding accounts, confirmations, backups, recovery codes and troubleshooting.',
	body: () => `
		<article>
			<h1>Documentation</h1>
			<p class="lede">
				Choose the task you need to complete, then follow the relevant steps.
				This page also covers ODA's vault, backups and everyday controls.
			</p>
			<ul class="plain next">
				<li><a href="/steam-desktop-authenticator"><strong>Choose an authenticator</strong></a> — original SDA, Steam Mobile or ODA.</li>
				<li><a href="/download"><strong>Get ODA for your device</strong></a> — packages, updates and release verification.</li>
				<li><a href="/import-from-sda"><strong>Bring existing SDA accounts into ODA</strong></a> — readable or encrypted maFiles.</li>
				<li><a href="/lost-authenticator"><strong>Recover lost account access</strong></a> — branches for the phone, backups or recovery code you still have.</li>
				<li><a href="/steam-guard-trade-holds"><strong>Identify a trade restriction</strong></a> — match Steam's message to the available action.</li>
			</ul>

			<h2>Getting started</h2>
			<dl class="defs">
				<dt><a href="/import-from-sda">Importing from SDA</a></dt>
				<dd>Bringing existing maFile accounts across, including encrypted ones.</dd>
				<dt>Creating a vault</dt>
				<dd>
					On first run you choose a passphrase. It protects every secret the
					vault stores, and ODA cannot reset it. Use a strong, unique passphrase and
					keep a secure record separately from your vault backup.
				</dd>
				<dt>Adding an authenticator</dt>
				<dd>
					Choose <strong>Add authenticator</strong> for an account without a mobile
					authenticator. Sign in and complete Steam's sign-in challenge. Activation
					then uses a separate code delivered by Steam; follow the screen's email or
					phone-number hint. Record the revocation code outside this computer and
					confirm the backup when asked. If an authenticator already exists, use
					<a href="/move-steam-authenticator-to-pc">Move authenticator</a> instead of
					removing it first. If an operation's outcome is uncertain, follow its
					recovery instructions before attempting it again.
				</dd>
			</dl>

			<h2>Everyday use</h2>
			<dl class="defs">
				<dt>Codes</dt>
				<dd>
					Each account shows its current code and how much of the thirty-second window
					is left. Copy places it on the clipboard; ODA attempts to clear its own
					entry after 30 seconds by default, configurable in Settings. This does not
					clear clipboard history, cloud sync or copies already read by other apps.
				</dd>
				<dt><a href="/approve-steam-confirmations-desktop">Confirmations</a></dt>
				<dd>
					Trades and market listings awaiting approval, with what Steam said about
					each: what is being traded, with whom, and when it was raised. Approve or
					cancel individually. Verify the recipient and items yourself before approving;
					a familiar account name is not proof that the request is yours.
				</dd>
				<dt>Automatic confirmation</dt>
				<dd>
					Optional, per account, and limited to market listings and trades. Anything
					else — most importantly an account recovery request — is held back and
					reported in Activity rather than approved. This limit is in the code, not in
					a setting.
					Automatic approval can still authorise an unwanted trade or sale. Leave it
					off if you need to review each request.
				</dd>
				<dt>Activity</dt>
				<dd>
					What automatic confirmation did while you were not watching, and anything it
					refused. The place to look if something feels wrong.
				</dd>
			</dl>

			<h2>Keeping access</h2>
			<dl class="defs">
				<dt><a href="/steam-revocation-code">Revocation codes</a></dt>
				<dd>
					The code that detaches an authenticator from Steam. Revealing one requires
					your passphrase again even when the vault is unlocked. Store it somewhere
					that is not this computer.
				</dd>
				<dt>Backups</dt>
				<dd>
					The vault keeps the previous version of itself beside the current one. If the
					vault file is damaged, the unlock screen offers to load that backup. Restoring
					returns local records to how they were when the backup was written. It does
					not undo a Steam-side transfer or deactivation. The adjacent backup is also
					lost if the disk fails or the whole data folder is deleted: keep a separate
					encrypted copy and retain the passphrase that opens it.
				</dd>
				<dt>Recovery files</dt>
				<dd>
					Written automatically for imported, enrolled and transferred authenticators,
					and kept when a vault entry is removed. Address any backup warning shown by
					the application. A file needs the vault passphrase in force when it was
					written; changing today's passphrase does not unlock an older copy with the
					new one. A file cannot revive secrets Steam has replaced or deactivated.
				</dd>
			</dl>

			<h2>Troubleshooting</h2>
			<dl class="defs">
				<dt>Steam rejects the codes</dt>
				<dd>
					Check the clock first. Codes depend on time, and clock drift can make them
					invalid. ODA attempts to obtain Steam's time offset and shows time-sync
					failures; do not infer Steam's acceptance tolerance from the 30-second code
					period. <a href="/steam-guard-code-not-working">The full
					walkthrough, including the fixes on Windows and phone, is here.</a>
				</dd>
				<dt>An imported account cannot confirm trades</dt>
				<dd>
					Its maFile may have an <code>identity_secret</code> whose value is present
					but unusable; current imports flag this with a warning. Login codes may still
					work when the <code>shared_secret</code> is usable, but confirmations cannot.
					First check sign-in, connectivity and the account's configured proxy. If
					the secret is unusable, re-import a known-good copy; if none exists, use
					<a href="/lost-authenticator">Steam's recovery or transfer routes</a> before
					considering removal and re-enrollment.
				</dd>
				<dt>Sign-in wants approval on another device</dt>
				<dd>
					Steam is asking for confirmation on the device that already holds the
					authenticator. Use its current code if the sign-in screen offers that route.
					If the device is gone, <a href="/lost-authenticator">Steam's recovery flow</a>
					may use your recovery code, linked phone number or proof of ownership.
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
				<dd>Review pending actions, diagnose an empty or failed list, and understand required access.</dd>
				<dt><a href="/steam-mobile-vs-desktop-authenticator">Mobile app or desktop</a></dt>
				<dd>The security, recovery and convenience trade-offs between device types.</dd>
				<dt><a href="/alternatives">Authenticator options compared</a></dt>
				<dd>Compare the options by existing accounts, workflow, updates and backups.</dd>
				<dt><a href="/faq">Product FAQ</a></dt>
				<dd>Short answers about cost, platform support, privacy, imports and losing a passphrase.</dd>
			</dl>
			<p>For a missing step or documentation error, <a href="/support">send a report</a>
				with the page URL and app version. Do not include account secrets.</p>
		</article>`
};

export const faq = {
	slug: 'faq',
	parent: 'docs',
	updated: '2026-09-30',
	reviewed: '2026-09-30',
	navTitle: 'FAQ',
	title: 'ODA FAQ: accounts, imports, privacy and recovery',
	description:
		'ODA answers: cost, maFile import, offline codes, platforms, automatic confirmations and lost vault passphrases. Links to setup and recovery steps.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: FAQ_ITEMS.map((item) => ({
			'@type': 'Question',
			name: item.q,
			acceptedAnswer: {
				'@type': 'Answer',
				text: typeof item.plain === 'function' ? item.plain(s) : item.plain
			}
		}))
	}),
	body: (s) => `
		<article>
			<h1>Open Desktop Authenticator FAQ</h1>
			<p class="lede">Short answers about the ODA application. For step-by-step tasks,
				use the <a href="/docs">documentation</a>; for original SDA download and
				maintenance information, see <a href="/steam-desktop-authenticator">SDA and ODA</a>.</p>
			${FAQ_ITEMS.map(
				(item) => `
			<section class="faq-item">
				<h2>${item.q}</h2>
				${typeof item.a === 'function' ? item.a(s) : item.a}
			</section>`
			).join('')}

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
				<li><a href="/steam-guard-trade-holds">Trade holds and restrictions</a> — identify the message and what you can do</li>
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
			'Yes. The application is free and open source under the MIT licence. There is no paid tier, ODA account or application telemetry. The website has analytics described in its privacy notice.',
		a: `<p>Yes. The application is free and open source under the <a href="${'https://github.com/opendesktopauthenticator/open-desktop-authenticator/blob/main/LICENSE'}" rel="noopener">MIT licence</a>. There is no paid tier, ODA account or application telemetry. Steam operations still require your Steam account. This website uses analytics, as described in <a href="/privacy">its privacy notice</a>. MASTERPANEL LLC publishes ODA as an open-source project.</p>`
	},
	{
		q: 'Can I use my existing SDA maFiles?',
		plain:
			'Yes. It imports .maFile accounts, including SDA-encrypted files with the matching manifest and passphrase. Exports are unencrypted .maFile files and omit Steam refresh tokens and proxy configuration.',
		a: `<p>Yes — including SDA-encrypted files with the matching <code>manifest.json</code> and SDA passphrase. Exports are <strong>unencrypted</strong> maFiles and omit Steam refresh tokens and proxy configuration. Keep them secure, and sign in and set routing again in the destination app. <a href="/import-from-sda">How importing and exporting work</a>.</p>`
	},
	{
		q: 'How can I check an ODA download?',
		plain: (s) =>
			`The source and release ${s.publication.github.latestVersion ?? s.publication.store.latestVersion} are public. Check official distribution addresses and follow the available release verification steps. Those checks establish origin, not that the software is harmless. ${s.release.audited ? 'Consult the security page for review scope and limitations.' : 'No independent security audit is published.'}`,
		// Keep the visible limits derived from the shared release record.
		a: (s) => {
			const open = releaseGaps(s, 'sentence');
			const enforcement = `<a href="/download">The download page tracks those limits</a>. Source review, tests and signatures address different risks; none guarantees that software is harmless.`;
			return `<p>Start with <a href="/official">the official addresses</a>, the public source and <a href="/verify">the release verification steps</a>. The publisher identifies itself as MASTERPANEL LLC. A company name, public code or successful signature check is not a guarantee of harmless software: signatures establish origin, while review and testing assess behaviour.</p>
			<p>${
				open.length
					? `Current release limits: ${open.join(' ')} ${enforcement}`
					: `Everything this answer used to list as unfinished is now done. ${enforcement}`
			}</p>
			<p>For how ODA stores secrets and where its protections end, read the <a href="/security">security model</a>.</p>`;
		}
	},
	{
		q: 'What happens if I lose my vault passphrase?',
		plain:
			'ODA cannot reset a lost vault passphrase. Recovery files need the passphrase used when written; an older known passphrase may open an older backup. Other working authenticator copies, secure exports, or Steam recovery through a recovery code, linked phone or Support may preserve account access.',
		a: `<p>ODA has no passphrase reset or master key. You need the passphrase that encrypted the vault to open it.</p>
			<p><strong>Recovery files are also encrypted.</strong> They need the passphrase in force when each was written. An older file may open with an older passphrase you still know, but it will only restore working access if Steam has not replaced or deactivated that authenticator.</p>
			<p>Check for another working authenticator copy, a secure maFile export, or a usable independent backup. For Steam-side recovery, use the recovery code (the <code>revocation_code</code> field in a maFile) you stored outside the vault, your linked phone where Steam offers it, or Steam Support's ownership checks. <a href="/lost-authenticator">Follow the recovery guide</a>; losing the vault passphrase does not necessarily mean losing the Steam account.</p>`
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
		a: `<p>No. It is an independent project, not affiliated with or endorsed by Valve Corporation or the authors of Steam Desktop Authenticator. It supports SDA's maFile format for migration. Format compatibility is not an endorsement from SDA or Valve.</p>`
	},
	{
		q: 'Can ODA approve confirmations automatically?',
		plain:
			'An authenticator that approves trades can authorise item transfers. ODA automatic confirmation is off by default and limited to trades and market listings; it can still approve an unwanted request of those types. Account-recovery confirmations are excluded from automatic approval.',
		a: `<p>ODA holds secrets that can authorise trade and market confirmations, so it must be treated as sensitive software. <strong>Automatic confirmation can approve an unwanted trade or sale</strong> if the request appears on Steam. It is off by default and configured per account; only trades and market listings are allowed, while account-recovery requests are held back and reported.</p><p>That restriction does not make automatic trading safe on a compromised account. Leave automatic confirmation off when you need to check every recipient and item. <a href="/security">Read the security model and its limits</a>.</p>`
	},
	{
		q: 'Which platforms does it run on?',
		plain:
			'Published builds target Windows 10 version 1809 or later and Windows 11 on x64 or ARM64, plus x64 Linux. The Store package and portable Windows build are x64; a native ARM64 installer is on GitHub. No macOS or Linux ARM64 build is published.',
		a: `<p>Published builds target Windows 10 version 1809 or later, Windows 11, and x64 Linux. GitHub offers x64 and ARM64 Windows installers; the portable Windows build and the recorded Store package are x64. Linux downloads are an AppImage and a Debian/Ubuntu package. Distribution compatibility depends on system libraries; a Linux package is not a promise that every distribution is supported.</p><p>No macOS or Linux ARM64 build is published. The declared Windows minimum is a compatibility floor, not a statement that an old Windows release still receives security updates. See <a href="/download">the downloads and release limits</a>.</p>`
	}
];

export const support = {
	slug: 'support',
	updated: '2026-09-12',
	reviewed: '2026-09-12',
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
				account to report something. You receive a private report link: save the whole
				link, including its key, to follow up.
			</p>

			<div class="callout callout-warn">
				<h2>Never include a secret in a report</h2>
				<p>
					Do not paste a <code>.maFile</code>, a shared secret, an identity secret, a
					revocation code, a password or an API key into this form or into any message
					to us. Nobody here will ever ask for one. A report that needs to describe a
					secret can describe its shape without its value.
					For a vulnerability, use <a href="#security-reports">the private security
					channels below</a> rather than this general report form.
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
						just the thumbnail. Anything you never attach to a report becomes eligible
						for deletion after two hours and is normally removed within a few hours.
						A failed removal is retried until it succeeds.
						<a href="/privacy">What we keep, and for how long</a>.
					</p>
					<ul class="attachments" data-list></ul>
				</div>

				<div class="field">
					<label for="contact">Where to reply, if you want one (optional)</label>
					<input id="contact" name="contact" type="text" maxlength="120"
					       placeholder="An email address, or leave this blank">
					<p class="hint">
						No account is created either way. Save your full private report link to check
						back; leaving an address means we can ask a follow-up question, which is
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
					<strong>Our triage policy:</strong> anything
					describing lost access, lost items, or a secret behaving unexpectedly is
					looked at ahead of everything else.
				</li>
				<li>
					<strong>Our aim is to answer each report</strong>, including a reason if we
					cannot make the requested change. General reports have no guaranteed response
					time. Steam account recovery and item disputes must go through Steam Support.
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
					two published private routes:
			</p>
			<ul class="plain next">
				<li>
					<strong><a href="https://github.com/opendesktopauthenticator/open-desktop-authenticator/security/advisories/new" rel="noopener">GitHub private vulnerability
					reporting</a></strong> — preferred. It keeps the discussion in a private
					advisory rather than a public issue and requires a GitHub account. If it is
					unavailable, use the email route.
				</li>
				<li>
					<strong>By email</strong>, if you would rather not use GitHub. The address is
					published in
					<a href="/.well-known/security.txt">our security.txt</a>, which is the
					standard place to look for security contact information. The same address
					is also in the repository's SECURITY.md.
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
