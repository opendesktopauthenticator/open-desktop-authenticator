/**
 * Code signing policy.
 *
 * SignPath Foundation requires this page, and requires specific literal
 * strings on it: the term "Code signing policy" on the home page and the
 * download/release pages, the exact attribution sentence, the team roles, and
 * a privacy policy reference. Those are quoted requirements from
 * https://signpath.org/terms.html, not stylistic choices — a paraphrase of the
 * attribution line is a failed condition, so `tests/code-signing-policy.test.ts`
 * asserts the exact strings rather than trusting anybody to keep them.
 *
 * It is also a page worth having independently. "Who is allowed to approve a
 * signature" is exactly the question §4's chain leaves open once a certificate
 * exists: a stranger can check that a binary is signed, but not who decided it
 * should be. This says so, in advance of having the certificate.
 */

/** SignPath's required attribution, quoted exactly. Do not paraphrase. */
export const SIGNPATH_ATTRIBUTION =
	'Free code signing provided by SignPath.io, certificate by SignPath Foundation';

export const codeSigningPolicy = {
	slug: 'code-signing-policy',
	navTitle: 'Code signing policy',
	title: 'Code signing policy',
	description:
		'Who may approve a release for signing, which builds are eligible, and how to verify one. Required by SignPath Foundation.',
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
					<strong>${SIGNPATH_ATTRIBUTION}</strong>
				</p>
				<p>
					An application is in progress and <strong>has not been granted yet</strong>.
					Until it is, none of the builds on
					<a href="${s.repo}/releases/latest" rel="noopener">the releases page</a> carry
					a code-signing certificate, and Windows warns on first run. This page
					describes the policy that applies once the certificate exists, and is
					published now so it can be read before it matters rather than after.
				</p>
			</div>

			<h2>What gets signed, and what does not</h2>
			<p>
				Only artifacts built by this project's own public workflow, from a tag in
				<a href="${s.repo}" rel="noopener">this repository</a>, are eligible. Nothing
				built on a maintainer's machine is ever signed, and no third party's binaries
				are signed with this certificate.
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
					of the ${s.githubOrg} organisation</a>. A signing request is approved by an
					owner, who is the same person accountable for the release under
					<a href="/owners">${s.brand.legal}</a>.
				</dd>
				<dt>Multi-factor authentication</dt>
				<dd>
					Required for every person in both roles, on GitHub and on SignPath. This is a
					SignPath Foundation condition and it is also the only thing standing between a
					stolen password and a release going out over this project's name.
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
				produced it, so this project publishes both:
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
