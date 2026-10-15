/**
 * Code signing policy.
 *
 * Windows signing, Store package signing and Sigstore release evidence are
 * separate checks. Keep their scope explicit and derive current Windows
 * signing status from the evidence for the linked GitHub release.
 */

export const codeSigningPolicy = {
	slug: 'code-signing-policy',
	updated: '2026-10-15',
	navTitle: 'Code signing policy',
	title: 'Code signing policy',
	description:
		'Which builds carry a signature and which do not, who is accountable for a release, and how to verify one without trusting us.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'WebPage',
		name: 'Code signing policy',
		description: 'Signing roles, approval, and verification for Open Desktop Authenticator.',
		publisher: { '@id': s.organizationId }
	}),
	body: (s) => `
		<article>
			<h1>Code signing policy</h1>

			<div class="callout">
				<p>
					${
						s.release.codeSigned
							? `<strong>The Windows downloads in GitHub ${s.publication.github.latestVersion} are
							code-signed and timestamped as MASTERPANEL LLC using Microsoft Azure Artifact
							Signing.</strong> This covers the x64, ARM64 and universal installers, and the
							portable x64 executable.`
							: `<strong>The Windows downloads in GitHub ${s.publication.github.latestVersion}
							do not carry a publisher code signature.</strong> Use the checksums and build
							provenance recorded for that release.`
					}
					Get them from
					<a href="${s.repo}/releases/tag/v${s.publication.github.latestVersion}" rel="noopener">the official release page</a>.
					<a href="https://learn.microsoft.com/en-us/azure/artifact-signing/overview" rel="noopener">Microsoft documents Artifact Signing here</a>.
				</p>
				<p>
					Windows signing began with version 1.5.1. The older 1.5.0 direct Windows
					files remain unsigned; their release history has not been rewritten.
					Linux packages do not carry a platform code signature. Their verification
					uses SHA-256 checksums, the Sigstore signature over the checksum list, and
					build provenance.
				</p>
				<p>
					A valid code signature identifies the publisher and protects the signed bytes.
					It does not guarantee that SmartScreen stops warning.
					<a href="https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation" rel="noopener">Microsoft now documents</a>
					that unsigned, self-signed and newly signed files can receive reputation
					warnings. Extended Validation certificates no longer bypass the reputation
					process. Signing identifies a publisher and protects signed bytes; it is not
					a guarantee of safe behavior.
					Check the publisher alongside the release's checksums and attestation.
				</p>
			</div>

			<h2>What carries a signature, and what does not</h2>
			<p>
				Windows Authenticode signing is separate from the release evidence shared by
				Windows and Linux. Starting with version 1.5, the release workflow signs
				<code>SHA256SUMS.txt</code> with Sigstore and
				publishes build provenance for the artifacts. Those records identify this
				project's public workflow and the exact tag in
				<a href="${s.repo}" rel="noopener">this repository</a>; they are not a
				conventional signature on the executable itself.
			</p>
			<p>
				<strong>The Microsoft Store package is separate.</strong> Microsoft
				<a href="https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements" rel="noopener">re-signs the MSIX/AppX package it distributes</a>.
				Windows verifies that package during installation. This does not individually
				code-sign every executable inside it. <a href="/download">The download page</a>
				explains the four official download sources: Microsoft Store, GitHub, Softonic and Uptodown.
			</p>

			<h2>Team roles</h2>
			<dl class="defs">
				<dt>Committers and reviewers</dt>
				<dd>
					People granted write or review access to the repository. The organisation does
					not publish a member roster, so its public people page is not used as identity
					evidence. Commits, pull-request reviews and workflow runs that actually happen
					remain visible in the public repository.
				</dd>
				<dt>Approvers</dt>
				<dd>
					People with permission to create a release tag and run the release workflow.
					Those GitHub roles are not publicly enumerated. The named publisher accountable
					for the product and its releases is
					<a href="/owners">${s.brand.legal}</a>.
				</dd>
				<dt>Multi-factor authentication</dt>
				<dd>
					Our policy requires it for every person in both roles on GitHub. This is a
					publisher policy statement: GitHub's private membership and account-security
					settings are not public evidence that every account complies. MFA reduces
					password-only compromise; stolen sessions, tokens and compromised workflows
					remain risks that MFA alone does not remove.
				</dd>
			</dl>

			<h2>Privacy</h2>
			<p>
				No ODA backend. No ODA account. No cloud sync. No telemetry. User-requested
				Steam operations contact Valve. In direct builds from GitHub, Softonic or Uptodown, the optional update
				check contacts GitHub; Microsoft Store builds do not perform that check. The
				user-driven browser contacts the sites the user chooses and the third-party
				resources those pages load. Visiting our site through that browser is also
				covered by the website portion of the privacy policy.
				<a href="/privacy">The full privacy policy is here</a>, and
				<a href="/security">the security page</a> describes what the application stores
				and where.
			</p>

			<h2>Verifying a release</h2>
			<p>
				A code signature identifies who signed an executable; it does not identify which
				source produced it. The GitHub release also publishes
				<code>SHA256SUMS.txt</code>, a Sigstore signature over that list, and build
				provenance naming the workflow run, commit and tag.
				<a href="/verify">The verification steps walk through all three</a>, and they are
				worth running whether or not a file is signed.
			</p>
			<p>
				All four official download sources are linked from
				<a href="/official">our official domains page</a>.
			</p>
		</article>`
};

export default codeSigningPolicy;
