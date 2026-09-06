/**
 * Code signing policy.
 *
 * **This page was originally written to a sponsor's requirements.** An
 * application to the SignPath Foundation was declined — their programme is for
 * projects with established public visibility, which is a threshold a new
 * project cannot clear by writing better code — so every claim that a
 * certificate was coming, and the attribution line that named them as the
 * sponsor, have been removed. Naming a sponsor who is not sponsoring you is the
 * one thing a page about trust cannot do.
 *
 * The page stays, because most of it never depended on that. "Who is allowed to
 * approve a release" is exactly the question the verification chain leaves open,
 * and it is worth answering whether or not anything is signed. What it says now
 * is the settled position rather than a plan: the Store build carries
 * Microsoft's signature, the direct downloads carry none, and the checksums and
 * the provenance attestation are how a stranger checks them.
 */

export const codeSigningPolicy = {
	slug: 'code-signing-policy',
	updated: '2026-09-07',
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
					<strong>The direct downloads are not code-signed, and no certificate is
					planned.</strong> None of the builds on
					<a href="${s.repo}/releases/latest" rel="noopener">the releases page</a> carry
					a code-signing certificate, so Windows warns on first run.
				</p>
				<p>
					We applied to the SignPath Foundation, which gives free certificates to
					open-source projects, and were declined: their programme asks for
					established public visibility — stars, forks, articles, independent
					discussion — which a project this young does not have yet. That is written
					here rather than quietly dropped, because a page about who you can trust is
					the wrong place to be vague about what did not happen.
				</p>
				<p>
					Paying for one would not change what you see today either. Since March 2024
					no certificate — not even Extended Validation — removes the Windows
					SmartScreen warning on its own; reputation accrues with downloads over
					time. So the honest answer is the one below: use the Store build if you want
					a signature, and verify the direct downloads by checksum and attestation.
				</p>
			</div>

			<h2>What carries a signature, and what does not</h2>
			<p>
				The direct installers and executables are not code-signed. Starting with version
				1.5, the release workflow signs <code>SHA256SUMS.txt</code> with Sigstore and
				publishes build provenance for the artifacts. Those records identify this
				project's public workflow and the exact tag in
				<a href="${s.repo}" rel="noopener">this repository</a>; they are not a
				conventional signature on the executable itself.
			</p>
			<p>
				<strong>The Microsoft Store package is separate.</strong> Microsoft re-signs
				what it distributes, so that build carries Microsoft's signature rather than
				this one — <a href="/download">the download page</a> explains which channel
				gives you which guarantee.
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
					Required for every person in both roles on GitHub. It is the only thing
					standing between a stolen password and a release going out over this
					project's name, which is true whether or not anything is signed.
				</dd>
			</dl>

			<h2>Privacy</h2>
			<p>
				No ODA backend. No ODA account. No cloud sync. No telemetry. User-requested
				Steam operations contact Valve. In direct GitHub builds, the optional update
				check contacts GitHub; Microsoft Store builds do not perform that check. The
				user-driven browser contacts the sites the user chooses.
				<a href="/privacy">The full privacy policy is here</a>, and
				<a href="/security">the security page</a> describes what the application stores
				and where.
			</p>

			<h2>Verifying a release</h2>
			<p>
				A conventional code-signing certificate would identify who signed an executable;
				it would not identify which source produced it. Version 1.5 instead publishes
				<code>SHA256SUMS.txt</code>, a Sigstore signature over that list, and build
				provenance naming the workflow run, commit and tag.
				<a href="/verify">The verification steps walk through all three</a>, and they are
				worth running whether or not a file is signed.
			</p>
			<p>
				Genuine builds come from two places and no others, listed on
				<a href="/official">our official domains page</a>.
			</p>
		</article>`
};

export default codeSigningPolicy;
