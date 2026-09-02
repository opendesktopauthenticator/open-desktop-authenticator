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
				Nothing this project publishes directly is signed by us. If that ever changes,
				only artifacts built by this project's own public workflow, from a tag in
				<a href="${s.repo}" rel="noopener">this repository</a>, would be eligible —
				nothing built on a maintainer's machine, and no third party's binaries.
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
					<a href="https://github.com/orgs/${s.githubOrg}/people" rel="noopener">Members
					of the ${s.githubOrg} organisation</a>. Every change reaches the default
					branch through the public repository, and the release workflow builds only
					from a pushed tag whose commit it verifies against <code>HEAD</code>.
				</dd>
				<dt>Approvers</dt>
				<dd>
					<a href="https://github.com/orgs/${s.githubOrg}/people?query=role%3Aowner" rel="noopener">Owners
					of the ${s.githubOrg} organisation</a>. A release is approved by an owner, who
					is the same person accountable for it under
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
				This program will not transfer any information to other networked systems unless
				specifically requested by the user or the person installing or operating it. It
				talks to Valve's own endpoints to do the job you asked for, and — if you leave
				the update check on — asks GitHub's public releases page whether a newer version
				exists. There is no telemetry, no analytics, and no account.
				<a href="/privacy">The full privacy policy is here</a>, and
				<a href="/security">the security page</a> describes what the application stores
				and where.
			</p>

			<h2>Verifying a release</h2>
			<p>
				A signature tells you who published a file. It does not tell you which source
				produced it — and since nothing here is signed, the second half is all there
				is, which is why it is published in full:
				<code>SHA256SUMS.txt</code> and a build provenance attestation naming the
				workflow run, commit and tag.
				<a href="/verify">The verification steps walk through both</a>, and they are
				worth running whether or not a file is signed.
			</p>
			<p>
				Genuine builds come from two places and no others, listed on
				<a href="/official">our official domains page</a>.
			</p>
		</article>`
};

export default codeSigningPolicy;
