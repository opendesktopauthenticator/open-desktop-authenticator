/**
 * An editorial publication gate for every page that may be indexed.
 *
 * These notes make an editor state the distinct reader outcome that warrants a
 * URL and the evidence that supports its claims. They are review data, not page
 * copy: do not render them as a disclaimer or use them to persuade a search
 * classifier that a page is useful. The page itself still has to deliver the
 * stated value and show the relevant evidence where a reader needs it.
 */

const MIN_STATEMENT_LENGTH = 80;
const PLACEHOLDER = /\b(?:fixme|lorem ipsum|placeholder|tbd|tktk|todo)\b/i;

export function editorialStatementProblem(statement) {
	if (typeof statement !== 'string' || statement.trim().length < MIN_STATEMENT_LENGTH) {
		return `must be at least ${MIN_STATEMENT_LENGTH} characters`;
	}
	if (/<[^>]*>/.test(statement)) {
		return 'must be plain text, not markup';
	}
	if (PLACEHOLDER.test(statement)) {
		return 'contains placeholder text';
	}
	return null;
}

const record = (value, evidence) => {
	for (const [field, statement] of Object.entries({ value, evidence })) {
		const problem = editorialStatementProblem(statement);
		if (problem) throw new TypeError(`Editorial ${field} ${problem}`);
	}
	return Object.freeze({ value, evidence });
};

const EDITORIAL_NOTES_BY_SLUG = Object.freeze({
	index: record(
		'Understand ODA as a product, see its account interface and choose a download or an existing-account import without first reading the project history.',
		'It shows an accurately labeled real interface with fictional fixtures, routes readers to separate product-choice and migration guides, and derives availability and release limitations from shared publication facts.'
	),
	'steam-desktop-authenticator': record(
		'Identify the original SDA project and choose between its repository, Valve’s mobile app and ODA’s independent desktop alternative, with a clear route for existing SDA files.',
		'The three choices link to the actual products, a source-backed comparison explains their workflows, a labeled real UI demo illustrates ODA, and migration checks distinguish codes from confirmation access.'
	),
	'scam-clones': record(
		'A guide that first routes exposed users to account recovery, then helps people who have not run a download check its origin before handing it Steam secrets.',
		'Its ordered response links Steam account recovery, distinguishes replacing copied authenticator secrets from changing a password, and explains applicable Market and CS2 recovery limits using primary sources.'
	),
	'steam-inventory-stolen': record(
		'A clearly attributed account of a suspected counterfeit authenticator, explaining why working codes do not establish that a download is safe.',
		'It separates the unnamed team member’s recollection from unverified conclusions about exfiltration and recipient accounts, avoids an unsupported monetary estimate, and links current Valve rules independently of the story.'
	),
	verify: record(
		'A copyable procedure for verifying ODA downloads from Microsoft Store, GitHub, Softonic or Uptodown.',
		'It walks through SHA-256 calculation, checksum comparison, GitHub attestation/Sigstore identity, Windows publisher checks and source builds, while only showing commands supported by the current release state.'
	),
	security: record(
		'A concrete threat model for where Steam secrets live, which boundaries protect them, and which risks remain.',
		'It names the vault format and cryptography, derives dependency counts from the package data, links the relevant source file, documents deliberate refusals and caveats, and provides private vulnerability reporting.'
	),
	official: record(
		'A complete allowlist of the domains and storefronts ODA actually publishes from, with the role of each address.',
		'It links the four official download sources directly, distinguishes the publisher websites from distributors, and explains how to investigate an unfamiliar address.'
	),
	'code-signing-policy': record(
		'A precise distinction between Windows publisher signatures through Azure Artifact Signing, Store package signing, checksum-list signing and build provenance.',
		'It points to the published v1.5.1 release, names MASTERPANEL LLC as signer, separates unsigned historical Windows releases and Linux packages, and explains accountable release roles and remaining limits.'
	),
	'what-is-a-mafile': record(
		'A field-level explanation of why a maFile is the authenticator itself rather than an ordinary settings file.',
		'It identifies the shared secret, identity secret and revocation code, explains encrypted versus readable files, and links Valve’s authenticator-removal guidance.'
	),
	'how-to-open-mafile': record(
		'A safe, reversible workflow for locating, copying, identifying and inspecting a maFile without exposing or damaging it.',
		'It is checked against SDA’s source and on-disk format, branches on encrypted versus readable files, and requires a copied backup before inspection.'
	),
	'encrypted-mafile': record(
		'A diagnosis guide for the common case where the right SDA passphrase still fails because manifest.json is missing.',
		'It follows SDA’s published FileEncryptor source, separates ciphertext, salt and IV in an original diagram, and distinguishes genuinely wrong passphrases from missing or mismatched metadata.'
	),
	'lost-authenticator': record(
		'A recovery decision tree ordered by what the user still has: secret copy, phone number, revocation code or only Steam Support.',
		'It anchors the available recovery paths to Valve’s own instructions and closes with testable backup practices rather than promising an impossible bypass.'
	),
	'steam-revocation-code': record(
		'Choose a recovery-code route based on the phone, account backup or recovery access still available, then preserve the current code before a device is lost.',
		'It uses Valve’s current recovery instructions, names the optional maFile field and local backup checks, and distinguishes removing an authenticator from recovering secrets or using emergency login codes.'
	),
	'move-steam-authenticator-new-phone': record(
		'A branching plan that helps users choose transfer, phone recovery, revocation-code recovery or Steam Support without accidentally taking a 15-day path.',
		'Every stated duration links to Valve’s Guard, restrictions or transfer guidance, and an original two-versus-fifteen-day diagram makes the consequence visible.'
	),
	'move-steam-authenticator-to-pc': record(
		'Follow ODA’s phone-to-PC transfer prerequisites and actual controls while preserving recovery access and knowing how to respond if a transfer stops partway through.',
		'It separates Valve’s documented phone policy from ODA’s historical one-account observation, checks procedure against the transfer implementation, and avoids promising an account-specific restriction duration.'
	),
	'steam-guard-trade-holds': record(
		'One comparison of Steam holds and restrictions by trigger, duration and avoidability, including the costly remove-and-re-enrol path.',
		'Every duration is linked to Valve’s own holds, restrictions or Guard pages, and the page explicitly declines to invent a number where Valve gives none.'
	),
	'steam-guard-code-not-working': record(
		'A troubleshooting sequence that begins with an easy, non-destructive check for clock drift, then examines account selection and authenticator changes.',
		'It explains the 30-second-window calculation with an original diagram, quotes Valve’s own checks, and gives concrete Windows/phone time-sync and account-mismatch steps.'
	),
	'steam-guard-without-phone': record(
		'A clear separation between needing a smartphone, needing a phone number, and accepting the recovery trade-offs of either choice.',
		'It cites Valve’s current no-number setup route, labels the one-account completion as an observation, and itemizes the SMS transfer and recovery capabilities the user gives up.'
	),
	'approve-steam-confirmations-desktop': record(
		'Review a pending Steam confirmation on a desktop, distinguish signing from accepting a trade, and diagnose a missing or incomplete list before approving anything.',
		'The procedure names ODA’s real confirmation controls, separates code generation from authenticated session access, and checks incomplete-list and approval behavior against the application and Valve guidance.'
	),
	'steam-mobile-vs-desktop-authenticator': record(
		'A decision guide that recommends Valve’s mobile app by default and identifies the narrower cases where desktop custody may be worth it.',
		'It compares custody, recovery, multi-account use, switching costs and project maturity, linking Valve’s one-authenticator and multi-account statements and disclosing ODA’s current limitations.'
	),
	alternatives: record(
		'A user-centered comparison of Steam Mobile, original SDA and ODA that explicitly allows the right answer to be someone else’s product.',
		'It checks the options against Valve guidance and SDA’s official repository, applies the same practical questions to all three, and states ODA’s youth and unfinished assurances.'
	),
	download: record(
		'A live release-status page covering the Store, the project’s GitHub release and the Softonic and Uptodown Windows listings, with package and update details.',
		'Its versions, architectures, signatures and open gaps are derived from the verified publication/release state; it also links the license, source, build route and verification procedure.'
	),
	'import-from-sda': record(
		'A non-destructive migration procedure that shows what is read, what is flagged before storage, how to prove the import worked, and how to leave again.',
		'It mirrors the application’s real import checks—manifest recovery, decryption in memory, duplicates, missing secrets and proxy data—and asks the user to compare live codes side by side before deleting SDA.'
	),
	uninstall: record(
		'A safe removal guide that separates uninstalling the executable from deleting the only remaining copy of authenticator data.',
		'It names the platform-specific app and data locations, puts revocation/export recovery ahead of deletion, and explains exactly what remains after each uninstall path.'
	),
	docs: record(
		'A task-oriented hub that routes readers to setup, everyday use, recovery, troubleshooting, maFile reference and authenticator choice without forcing a search.',
		'Each entry states the outcome its linked guide provides, every declared child is linked from the hub, and the page invites documentation corrections through the working support route.'
	),
	faq: record(
		'Direct answers to the trust and operating questions a cautious user asks before giving software a Steam secret.',
		'It links the MIT license and deeper security/verification pages, distinguishes offline code generation from online Steam operations, and derives release caveats from shared truth instead of hand-written claims.'
	),
	support: record(
		'An accountless, trackable route for bugs, documentation corrections, clone reports and security issues, with explicit secret-handling warnings.',
		'The page contains the actual report workflow, describes each report state and retention behavior, and links the public SECURITY policy and GitHub private vulnerability reporting.'
	),
	owners: record(
		'Identify the publisher, its commercial relationships, the basis of product documentation and the correct route for an ordinary correction or private vulnerability report.',
		'It links source history, official channels and the maintainer test record, discloses AI assistance and publisher accountability, and distinguishes historical observations from independent audit or current platform testing.'
	),
	credits: record(
		'A dependency-level account of whose reverse engineering makes desktop Steam authentication possible and how readers can support that maintainer directly.',
		'It links each DoctorMcKay library to its repository, explains the job each performs, and sends donations to the maintainer’s own verified pages rather than reproducing an address.'
	),
	donate: record(
		'A transparent account of what remains free, what donations fund, the accepted networks, and useful non-monetary alternatives.',
		'Every address comes from one checked data source, the page links the build-time validation code, identifies checksum limits by network, and warns users to verify the pasted address and chain.'
	),
	privacy: record(
		'A line-item disclosure of what the app, website and support system store, who else receives data and how to request early deletion.',
		'It separates local vaults and exports from server data, names support cookies and external services, distinguishes live-data deletion from backup expiry, and explains the scope of analytics controls.'
	)
});

/*
 * Concrete, stable fragments that must appear in each page's authored article.
 *
 * The prose above records an editorial judgement. These markers close the gap
 * between making that judgement and actually publishing the evidence it names:
 * a verifier can now reject a ledger entry whose promised proof disappeared
 * during an edit. They deliberately point at headings, field names, commands,
 * source paths, or primary-source URLs—not generic shared copy.
 */
const PROOFS_BY_SLUG = {
	index: ['Why this exists', 'What it will not do', 'manifest.json'],
	'steam-desktop-authenticator': [
		'https://github.com/Jessecar96/SteamDesktopAuthenticator',
		'SDA is no longer maintained',
		'identity_secret'
	],
	'scam-clones': ['0A94-F308-34A5-1988', 'Replace the compromised authenticator', 'SHA256SUMS'],
	'steam-inventory-stolen': [
		'Two weeks of nothing',
		'Community Market',
		"Today's rules are not inferred from this story"
	],
	verify: ['cosign verify-blob', 'Get-AuthenticodeSignature', 'SHA256SUMS.txt.sig'],
	security: ['src/shared/vault-format.ts', 'tests/confirmation-policy.test.ts', 'N=131072'],
	official: [
		'https://opendesktopauthenticator.com',
		'https://apps.microsoft.com/detail/9NMM2XJ6HZ1D',
		'https://github.com/opendesktopauthenticator'
	],
	'code-signing-policy': [
		'https://learn.microsoft.com/en-us/azure/artifact-signing/overview',
		'smartscreen-reputation',
		'SHA256SUMS.txt'
	],
	'what-is-a-mafile': ['shared_secret', 'identity_secret', 'revocation_code'],
	'how-to-open-mafile': ['Make a working copy first', 'manifest.json', 'account_name'],
	'encrypted-mafile': [
		'FileEncryptor.cs',
		'manifest.json',
		'I have the manifest but it still will not open'
	],
	'lost-authenticator': [
		'https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31',
		'R12345',
		'No recovery code and no phone number'
	],
	'steam-revocation-code': [
		'Checking a retained backup',
		'revocation_code',
		"Using Steam's recovery-code route"
	],
	'move-steam-authenticator-new-phone': [
		'29A9-9EEE-09F0-75F9',
		'451E-96B3-D194-50FC',
		'None of the above'
	],
	'move-steam-authenticator-to-pc': [
		'7EFD-3CAE-64D3-1C31',
		'What changes on Steam, and what has been tested',
		'What you need before starting'
	],
	'steam-guard-trade-holds': [
		'451E-96B3-D194-50FC',
		'34A1-EA3F-83ED-54AB',
		"Match Steam's reason to the next step"
	],
	'steam-guard-code-not-working': [
		'451E-96B3-D194-50FC',
		'How do I fix the time on Windows?',
		'Codes worked yesterday and stopped today with no changes'
	],
	'steam-guard-without-phone': [
		'6891-E071-C9D9-0134',
		'Plan recovery before removing a device from use',
		'Can I use a landline or VoIP number?'
	],
	'approve-steam-confirmations-desktop': [
		'2E6E-A02C-5581-8904',
		'No confirmation appears, or approval fails',
		'identity_secret'
	],
	'steam-mobile-vs-desktop-authenticator': [
		'7EFD-3CAE-64D3-1C31',
		'Choose a recovery route before switching',
		'What if the computer is lost or compromised?'
	],
	alternatives: [
		'6891-E071-C9D9-0134',
		'https://github.com/Jessecar96/SteamDesktopAuthenticator',
		'The comparison that actually matters'
	],
	download: [
		'https://apps.microsoft.com/detail/9NMM2XJ6HZ1D',
		'SHA256SUMS.txt.sig',
		'Four official download sources'
	],
	'import-from-sda': ['manifest.json', 'identity_secret', 'Confirm the codes match'],
	uninstall: ['%APPDATA%\\open-desktop-authenticator', 'vault.json.bak', 'recovery/'],
	docs: ['Creating a vault', 'Automatic confirmation', 'Recovery files'],
	faq: ['/blob/main/LICENSE', 'manifest.json', 'revocation_code'],
	support: ['/security/advisories/new', 'SECURITY.md', 'ODA-7K2M-B9QW'],
	owners: [
		'docs/FOUNDER_TEST_PLAN.md',
		'Commercial relationships and data',
		'/security/advisories/new'
	],
	credits: [
		'DoctorMcKay/node-steam-session',
		'DoctorMcKay/node-steam-totp',
		'DoctorMcKay/node-steamcommunity'
	],
	donate: [
		'site/addresses.mjs',
		'TLXxDn2fqAobwDeALr68B3PnppRKJJxoqh',
		'0x769962fd970e9875fd4de0a42cff2b84a0af5bfd'
	],
	privacy: ['oda.review-prompt.dismissed', 'Normally within 14 days', '90 days after it was closed']
};

const missingProofs = Object.keys(EDITORIAL_NOTES_BY_SLUG).filter(
	(slug) => !Object.hasOwn(PROOFS_BY_SLUG, slug)
);
const orphanProofs = Object.keys(PROOFS_BY_SLUG).filter(
	(slug) => !Object.hasOwn(EDITORIAL_NOTES_BY_SLUG, slug)
);
if (missingProofs.length || orphanProofs.length) {
	throw new Error(
		`Editorial proof inventory mismatch. Missing: ${missingProofs.join(', ') || 'none'}. ` +
			`Orphaned: ${orphanProofs.join(', ') || 'none'}.`
	);
}

export const EDITORIAL_BY_SLUG = Object.freeze(
	Object.fromEntries(
		Object.entries(EDITORIAL_NOTES_BY_SLUG).map(([slug, note]) => [
			slug,
			Object.freeze({ ...note, proofs: Object.freeze([...PROOFS_BY_SLUG[slug]]) })
		])
	)
);

// Short alias for callers that do not need the storage shape in the name.
export const EDITORIAL = EDITORIAL_BY_SLUG;

/**
 * Attach the ledger to a complete page collection.
 *
 * Indexable pages cannot pass this gate without an editorial record. A 404 (or
 * any other explicitly noindex page) may omit one. Conversely, a ledger entry
 * that no longer has a page is an error rather than silent, stale justification.
 */
export function attachEditorial(pages) {
	if (!Array.isArray(pages)) {
		throw new TypeError('attachEditorial expected an array of pages');
	}

	const pageSlugs = new Set();
	for (const page of pages) {
		if (page === null || typeof page !== 'object' || typeof page.slug !== 'string') {
			throw new TypeError('attachEditorial expected every page to have a string slug');
		}
		if (pageSlugs.has(page.slug)) {
			throw new Error(`Duplicate page slug in editorial gate: ${page.slug}`);
		}
		pageSlugs.add(page.slug);
	}

	const missing = pages
		.filter((page) => !page.noindex && !Object.hasOwn(EDITORIAL_BY_SLUG, page.slug))
		.map((page) => page.slug);
	if (missing.length > 0) {
		throw new Error(`Missing editorial record for indexable page(s): ${missing.join(', ')}`);
	}

	const orphans = Object.keys(EDITORIAL_BY_SLUG).filter((slug) => !pageSlugs.has(slug));
	if (orphans.length > 0) {
		throw new Error(`Editorial record has no page: ${orphans.join(', ')}`);
	}

	return pages.map((page) => {
		const editorial = EDITORIAL_BY_SLUG[page.slug];
		return editorial === undefined ? { ...page } : { ...page, editorial };
	});
}
