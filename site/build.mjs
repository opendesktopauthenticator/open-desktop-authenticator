/**
 * The website, generated.
 *
 *     node site/build.mjs        → site/dist/
 *
 * ## Why a generator and not a folder of HTML
 *
 * Every page needs a canonical URL, an accurate `<title>` and description, Open
 * Graph tags, breadcrumb structured data, and a sitemap entry that agrees with
 * all of it. Hand-maintained across a dozen files, those drift within a week —
 * and a canonical pointing at the wrong URL or a sitemap listing a page that no
 * longer exists is precisely the sort of quiet technical-SEO fault that is
 * invisible on the page and expensive in the index.
 *
 * So the page list below is the single source: it produces the navigation, the
 * breadcrumbs, the sitemap, and the internal links, and `site/verify.mjs` reads
 * the same list to check the output.
 *
 * ## Why static
 *
 * A site about not getting your Steam account stolen should not itself be a
 * running attack surface. There is no template engine at request time, no
 * database behind the marketing pages, and no JavaScript required to read a
 * word of it. nginx serves files. The only dynamic thing on the domain is the
 * ticket tool, which is deliberately a separate, sandboxed service.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './pages/index.mjs';
import { rootIcons, hashedIcons, manifest } from './icons.mjs';
import { checkAddresses } from './addresses.mjs';
import { escape, releaseGaps, reviewAsk, sentenceList } from './markup.mjs';
import { anchorHeadings, readingMinutes, guideMeta, jumpList } from './guide-kit.mjs';

// Re-exported so pages may take it from either module without a second import.
export { reviewAsk };

/*
 * Refuse to build a site with a bad payment address on it.
 *
 * Thrown rather than reported, and checked before anything is written, because
 * every other fault on this site can be corrected after the fact. A wrong
 * address cannot: the money is gone the moment somebody trusts the page. If the
 * checksums do not verify, there should be no output at all.
 */
const badAddresses = checkAddresses();
if (badAddresses.length) {
	throw new Error(
		`refusing to build with unverified donation addresses:\n  ${badAddresses.join('\n  ')}`
	);
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Gridinsoft's ownership token for this domain.
 *
 * Named rather than inlined because it appears twice — in the home page's head
 * and as the name of a file at the site root — and the two have to agree. They
 * are issued per domain, so this one is `opendesktopauthenticator.com`'s and
 * nothing else's: the same token on another site verifies neither.
 */
const GRIDINSOFT_KEY = 'nxu0pl5j85cxvlp60subwgz6bicyp3qv4zd1j7mr0b2jm3f9d1cunqqwqupqls81';
const out = join(here, 'dist');

export const SITE = {
	origin: 'https://opendesktopauthenticator.com',
	name: 'Open Desktop Authenticator',
	short: 'ODA',
	tagline: 'An open-source Steam authenticator for the desktop.',
	publisher: 'MASTERPANEL LLC',
	/*
	 * When the content was last reviewed. A real date, set by hand.
	 *
	 * Not `new Date()`: stamping every page with the build date claims a review
	 * that did not happen, and a site whose every page updates whenever CSS
	 * changes is telling search engines something false about its freshness.
	 */
	updated: '2026-08-27',

	/*
	 * When each published version went out, from the GitHub releases.
	 *
	 * Here because two pages said "Version 1.0 is days old" — true when typed,
	 * wronger every day after, and nothing to notice. It is the same failure as
	 * the checksum-signature sentences: a fact about the release, written by
	 * hand, with no path from the fact to the page. A date does not rot.
	 *
	 * **Keyed by version, and that is the whole point.** It was a single date
	 * described in its own comment as "when 1.0 was published", and `version`
	 * moved to 1.5.0 underneath it — so `datePublished` went on saying 1.0's
	 * date beside `softwareVersion: 1.5.0`, in structured data, which is a false
	 * statement about a release in the form search engines read. A version with
	 * no entry here has not been published yet, and pages print nothing rather
	 * than borrowing the last one's date.
	 */
	publishedOn: { '1.0.0': '2026-08-25' },

	/**
	 * The publication date of the version this build is — **undefined until it
	 * has one**, which is the honest answer for a version that has not shipped.
	 */
	get released() {
		return this.publishedOn[this.version];
	},

	/**
	 * When the project first shipped, formatted.
	 *
	 * A different fact from the one above, and the two were the same value until
	 * `version` moved. Both prose uses say "Version 1.0 was published on ..." —
	 * an argument about how young the project is, which is anchored to the first
	 * release and does not move when a later one goes out.
	 */
	get releasedOn() {
		return formatDate(Object.values(this.publishedOn).sort()[0]);
	},
	/** GA4 measurement ID. Referenced by head() and by the CSP host allowlist. */
	analyticsId: 'G-G0GE9H5VR7',

	/*
	 * Ownership tokens third parties ask us to put on the home page.
	 *
	 * Inert by design: an HTML comment, not a script and not a request. Nothing
	 * here executes, nothing is fetched, and the CSP is untouched — which is why
	 * this form of verification is the one to agree to when a service offers a
	 * choice between a comment, a script tag and a DNS record.
	 *
	 * Home page only, because that is what is asked for and because a token is
	 * somebody else's identifier for us: there is no reason to repeat it across
	 * thirty pages. Kept here rather than typed into the template so it is
	 * findable by the person who later wonders what it is.
	 */
	verifications: [
		// Requested by Trustpilot support, 2026-08-26, to verify domain ownership
		// for the review profile.
		{ service: 'Trustpilot', token: 'r2qnjwvklb' },
		/*
		 * Gridinsoft, 2026-08-30. A `meta` name rather than a comment because that
		 * is what they read — Trustpilot accepts a comment and Gridinsoft does not,
		 * so the shape is per service rather than a house style.
		 *
		 * They offer a root file as an alternative and this site publishes both:
		 * `file` puts the same token at `/gridinsoft-<token>.txt`. Either alone
		 * would verify; together, neither a rewritten head nor a missing file can
		 * quietly un-verify the domain.
		 */
		{ service: 'Gridinsoft', token: GRIDINSOFT_KEY, meta: 'gridinsoft-key', file: true }
	],

	/*
	 * How many packages actually ship, counted rather than remembered.
	 *
	 * /security advertises this number, and it was written out as a word — "Four
	 * runtime dependencies" — which was true until the day a fifth was needed and
	 * would then have been a false claim on the page whose whole argument is that
	 * claims should be checkable. Read from package.json at build time, so adding
	 * or removing one corrects the sentence by itself.
	 */
	get runtimeDependencies() {
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
		return Object.keys(pkg.dependencies ?? {}).length;
	},

	/**
	 * How many packages are in the installer once their dependencies are counted.
	 *
	 * **The number above is five, and the sentence it sat in was about the whole
	 * shipping surface.** "Every package that ships is a package someone could
	 * compromise, so there are as close to none as the job allows" is a claim
	 * about the supply chain, and five is the count of names typed into
	 * `dependencies` — not of packages that ship. The closure is 39, plus the
	 * Electron runtime.
	 *
	 * Five is still worth saying; it is a real and unusual number for an
	 * application of this kind. Saying it *instead* of the closure, on the page
	 * whose entire argument is that claims should be checkable, was the problem —
	 * and the SBOM published beside every release lists all of them, so the page
	 * was understating something a reader could already count.
	 *
	 * Read from the lockfile at build time for the reason the direct count is:
	 * a number that has to be remembered is one that eventually goes stale.
	 */
	get shippedPackages() {
		const lock = JSON.parse(readFileSync(join(here, '..', 'package-lock.json'), 'utf8'));
		return Object.entries(lock.packages ?? {}).filter(([path, entry]) => path !== '' && !entry.dev)
			.length;
	},
	/*
	 * What it runs on.
	 *
	 * Modelled here because it was already typed out in three places — the
	 * download page, the FAQ answer and a meta description — and macOS is a
	 * `false` that is expected to become `true`: the packaging, the entitlements
	 * and the release job all exist and wait only on an Apple certificate. The
	 * day that lands, a hand-written "Windows and Linux" is wrong everywhere it
	 * was typed and nothing would say so.
	 *
	 * `llms.txt` derives from this. The three older copies have not been moved
	 * over and still state it themselves.
	 */
	platforms: [
		{ name: 'Windows', detail: '10 version 1809 or later, and Windows 11', shipping: true },
		{ name: 'Linux', detail: 'AppImage and .deb', shipping: true },
		{
			name: 'macOS',
			detail: 'not shipped, because we will not publish a build we cannot sign',
			shipping: false
		}
	],

	repo: 'https://github.com/opendesktopauthenticator/open-desktop-authenticator',

	/*
	 * The GitHub organisation on its own.
	 *
	 * Derived from `repo` rather than written twice: /verify prints it inside a
	 * command the reader is told to copy (`gh attestation verify --owner ...`),
	 * and a command that is subtly wrong is worse than no command — it fails,
	 * and the reader concludes the download is bad rather than the docs.
	 */
	get githubOrg() {
		return new URL(this.repo).pathname.split('/')[1];
	},

	/*
	 * The original Steam Desktop Authenticator, and its only official home.
	 *
	 * Linked from everywhere this site mentions SDA, which until now it did not
	 * do at all — sixteen pages discussing a piece of software without ever
	 * saying where the real one lives. For a site whose entire argument is that
	 * people are downloading fakes, that was the most useful link on the domain
	 * and it was missing. Somebody who reads a page here and decides they would
	 * rather stay on SDA should be one click from the genuine repository, not
	 * back in a search result next to the clone.
	 *
	 * Ours is the successor, not the replacement, and Jessecar96 wrote the thing
	 * this exists because of. Saying so is both accurate and the safer default.
	 */
	sda: {
		author: 'Jessecar96',
		repo: 'https://github.com/Jessecar96/SteamDesktopAuthenticator',
		releases: 'https://github.com/Jessecar96/SteamDesktopAuthenticator/releases',
		/*
		 * SDA's own status, in its own words.
		 *
		 * This site sent people to SDA on the grounds that "it works", and omitted
		 * the notice at the top of its README: no longer supported, no further
		 * updates, and its authors' own view that using it puts an account at risk.
		 * Recommending abandoned security software while leaving out the author's
		 * warning is precisely the failure this domain exists to complain about,
		 * and it is worse coming from us than from a stranger.
		 *
		 * Kept here so every page that mentions SDA gets the same caveat from one
		 * place, and so it can be corrected everywhere if that status ever changes.
		 */
		unsupported: true,
		notice: 'no longer supported and will not receive any more updates',
		authorsAdvice: "Steam's official mobile app is what its authors now tell people to use"
	},

	/*
	 * The public review profile.
	 *
	 * Reviews are asked for here on the same grounds as everything else on this
	 * domain: an anonymous authenticator with no third-party trace is
	 * indistinguishable from a scam, and a review on a platform we do not control
	 * is one more thing the next person can check that does not rely on taking
	 * our word. That is the argument, and it is also the constraint — a review
	 * from somebody who has not used anything is worth nothing to that person and
	 * would make the profile another unverifiable claim.
	 *
	 * So the ask is only ever placed where something was actually received, and
	 * it says what it is asking about. Nothing is offered in exchange, which is
	 * both Trustpilot's rule and the only way the result means anything.
	 */
	reviews: {
		profile: 'https://www.trustpilot.com/review/opendesktopauthenticator.com',
		write: 'https://www.trustpilot.com/evaluate/opendesktopauthenticator.com',
		/*
		 * **The Review Collector, embedded rather than linked.**
		 *
		 * The ask already existed and pointed at Trustpilot by hand. This replaces
		 * that with Trustpilot's own collection surface, which they track as one.
		 *
		 * **It is still a button.** The Review Collector renders a call to action,
		 * not a form: the writing happens on Trustpilot, as it has to if the review
		 * is going to be tied to a real account and mean anything to the reader.
		 * Worth saying because it was first added here under a description that
		 * claimed otherwise.
		 *
		 * These are public identifiers — they appear in the markup of every site
		 * that embeds one, and the token identifies the widget rather than
		 * authorising anything. No secret belongs here.
		 */
		widget: {
			script: 'https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js',
			origin: 'https://widget.trustpilot.com',
			locale: 'en-US',
			/** Review Collector. */
			templateId: '56278e9abfbbba0bdcd568bc',
			businessUnitId: '6a8f1c6d93a7a59a46a46270',
			token: '7f6209c2-e467-4b2f-9dd4-2bd892cb1e0c'
		}
	},

	/*
	 * What the release pipeline can actually do today.
	 *
	 * **Every status claim on the site renders from this object**, because the
	 * alternative had already failed: five pages described reproducible builds,
	 * published checksums and signatures in the present tense while GitHub had
	 * zero releases and the backlog listed GPG signing and reproducible-build
	 * hardening as deferred. Each sentence was written when it was a fair
	 * description of the intent, and none of them was revisited.
	 *
	 * That is a bad failure for any project and a disqualifying one here. This
	 * site's entire argument is that a stranger should verify claims rather than
	 * believe them — so a claim of ours that cannot be verified is not marketing
	 * overreach, it is the exact behaviour the domain exists to warn people about.
	 *
	 * Flip a flag when the thing is genuinely true, and every page follows.
	 */
	release: {
		/** A signed public build exists and can be downloaded. */
		published: true,
		/** Artifacts are listed with SHA-256 checksums on the release page. */
		checksums: true,
		/*
		 * **Whether a signature is on the release somebody can download right
		 * now** — not whether the workflow signs.
		 *
		 * It was `true` from the day the signing step was written, and that was
		 * three days after v1.0.0 was tagged. So the only published release has
		 * no `SHA256SUMS.txt.sig` and no `.pem`, while /verify told every visitor
		 * to fetch both and run `cosign verify-blob` against them. The command
		 * cannot succeed. Worse than useless: a missing signature file is what
		 * tampering looks like, so the page taught people to suspect a release
		 * that is fine.
		 *
		 * **Flip this back to `true` in the same change that publishes a signed
		 * release, and not before.** The workflow signs correctly today; the
		 * question this flag answers is whether the bytes on the release page
		 * carry the result, which is a fact about the release and not about the
		 * code.
		 *
		 * The flag was already split three ways — checksum-list signature,
		 * binary code-signing, and a `.asc` for `gpg --verify` — because one word
		 * doing three jobs would have licensed all three phrasings the moment any
		 * one became true. Being split is what makes it safe to say "checksums,
		 * yes; signature, not yet" rather than going silent about both.
		 */
		signed: false,
		/*
		 * **The binaries are not code-signed**, and this is the flag that says
		 * so. The Microsoft Store package carries Microsoft's signature because
		 * Microsoft re-signs what it distributes; the `.exe`, `.AppImage` and
		 * `.deb` on the release page carry none, so Windows warns on first run.
		 * Blocked on the SignPath Foundation certificate — see
		 * /code-signing-policy, which exists and says the same thing.
		 */
		codeSigned: false,
		/*
		 * **No `.asc`, and there never was one.** The signature is sigstore, not
		 * GPG, so `gpg --verify` and `SHA256SUMS.txt.asc` remain instructions to
		 * nobody — a reader who follows one gets "No such file or directory" and
		 * has to guess whether that means the download is bad. /verify once
		 * carried exactly that instruction, which is why the tripwire for it is
		 * kept rather than deleted now that a different signature exists.
		 */
		gpgSignature: false,
		/** Anyone can rebuild the tag and get the same bytes. Deferred (§P3). */
		reproducible: false,
		/*
		 * **An independent third party has audited this and published the
		 * result.** Maintainer testing is not that, and neither is passing Store
		 * certification — certification checks policy compliance, not
		 * cryptography. The flag exists because two pages asserted the absence
		 * of an audit in prose, which is a claim that would have gone stale
		 * silently the day one happened.
		 */
		audited: false
	},

	/*
	 * Where the Store listing lives.
	 *
	 * The product ID is issued by Partner Center and is the only stable handle
	 * for the listing — the slug in a browser's address bar is generated from
	 * the display name and is not ours to rely on.
	 */
	store: {
		id: '9NMM2XJ6HZ1D',
		get url() {
			return `https://apps.microsoft.com/detail/${this.id}`;
		}
	},

	/** The release version, read from the package that is actually built. */
	get version() {
		return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
	},

	/** The company behind this, and the other things it runs. */
	brand: {
		name: 'MASTERPANEL',
		legal: 'MASTERPANEL LLC',
		url: 'https://masterspanel.com',
		logo: '/assets/projects/masterspanel.svg'
	},

	/*
	 * Stable entity identifiers for structured data.
	 *
	 * The company is not the product website, and the repository is not another
	 * identity for the company. Keeping the three IDs separate prevents schema
	 * on individual pages from silently merging those different entities.
	 */
	get organizationId() {
		return `${this.brand.url}/#organization`;
	},
	get websiteId() {
		return `${this.origin}/#website`;
	},
	get softwareId() {
		return `${this.origin}/#software`;
	}
};

/** The pages that appear in the header, in the order a newcomer needs them. */
const NAV = [
	'steam-desktop-authenticator',
	'steam-inventory-stolen',
	'download',
	'verify',
	'security',
	'docs',
	'owners',
	'credits',
	'support',
	'donate'
];

/**
 * One page's `<head>`.
 *
 * The canonical is absolute and always present, including on the home page.
 * Relative canonicals and missing ones are the two ways a site ends up with the
 * same content indexed under several URLs.
 */
/**
 * @param page the page being rendered
 * @param collectsReviews whether its body actually carries a review widget
 */
function head(page, collectsReviews) {
	const url = `${SITE.origin}/${page.slug === 'index' ? '' : page.slug}`;
	// The brand suffix is the short form. Spelling it out costs 29 characters,
	// which is most of the room a result has before it is truncated mid-word —
	// and a title cut off at "Open Desktop Authentica…" has spent that room on
	// nothing. Pages that are already long enough go without it entirely.
	const suffix = ' · ODA';
	// Skipped when the title already names the product, or the result reads
	// "Open Desktop Authenticator download … · ODA" — the brand twice, in the one
	// line a result has before it is truncated.
	const namesTheProduct = /Open Desktop Authenticator|\bODA\b/.test(page.title);
	const title =
		page.slug === 'index' || namesTheProduct || page.title.length + suffix.length > 62
			? page.title
			: page.title + suffix;
	// After the charset, which has to stay inside the first 1024 bytes, and
	// before everything else — a verifier that reads only the head still finds it.
	const verifications =
		page.slug === 'index'
			? SITE.verifications
					.map((v) =>
						// A comment satisfies the services that read one; the rest want a
						// real tag, and a comment they cannot see is indistinguishable
						// from having done nothing.
						v.meta
							? `
	<meta name="${escape(v.meta)}" content="${escape(v.token)}">`
							: `
	<!-- ${escape(v.service)} verification: ${escape(v.token)} -->`
					)
					.join('')
			: '';

	return `
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">${verifications}
	<title>${escape(title)}</title>
	<meta name="description" content="${escape(page.description)}">
	<link rel="canonical" href="${escape(url)}">
	<meta name="robots" content="${page.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large, max-snippet:-1'}">
	<meta name="theme-color" content="#070a0e">
	<meta property="og:type" content="website">
	<meta property="og:site_name" content="${escape(SITE.name)}">
	<meta property="og:title" content="${escape(title)}">
	<meta property="og:description" content="${escape(page.description)}">
	<meta property="og:url" content="${escape(url)}">
	<meta property="og:image" content="${SITE.origin}${asset('og-512.png')}">
	<meta property="og:image:width" content="512">
	<meta property="og:image:height" content="512">
	<meta property="og:image:alt" content="The Open Desktop Authenticator shield mark">
	<meta property="og:locale" content="en_GB">
	<meta name="twitter:card" content="summary">
	<meta property="article:modified_time" content="${page.updated ?? SITE.updated}">

	<!--
		The icon set. (No backticks in this comment: it lives inside a JS template
		literal, and one would end the string.)

		favicon.ico is declared even though browsers request it regardless. An
		explicit link stops the browser guessing, and the guess it makes when the
		path 404s is the generic default it then caches.

		Order matters to older browsers, which take the last icon they understand
		rather than the best one — so the SVG, which every modern browser prefers,
		comes last among the icon entries.
	-->
	<!--
		The .ico holds 16, 32 and 48, and this used to declare only 32x32.
		Google asks for a square that is a multiple of 48 and reads the declared
		sizes, so the one qualifying image in the file was being hidden behind an
		attribute that understated it. Declaring all three is simply accurate.
	-->
	<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
	<link rel="icon" type="image/png" sizes="16x16" href="${asset('favicon-16.png')}">
	<link rel="icon" type="image/png" sizes="32x32" href="${asset('favicon-32.png')}">
	<link rel="icon" type="image/png" sizes="48x48" href="${asset('favicon-48.png')}">
	<link rel="icon" type="image/png" sizes="96x96" href="${asset('favicon-96.png')}">
	<link rel="icon" type="image/svg+xml" href="${asset('icon.svg')}">
	<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
	<link rel="mask-icon" href="${asset('mask-icon.svg')}" color="#42f29a">
	<link rel="manifest" href="/site.webmanifest">
	<meta name="application-name" content="${escape(SITE.name)}">
	<meta name="apple-mobile-web-app-title" content="${escape(SITE.short)}">
	<meta name="msapplication-TileColor" content="#070a0e">
	<meta name="msapplication-TileImage" content="${asset('mstile-150.png')}">

	<link rel="stylesheet" href="${asset('site.css')}">
	<!--
		Script only where a page asks for one. Everything here works without it;
		the one script that exists adds file attachments to the support form, and
		putting it on all sixteen pages would mean fifteen requests for nothing.
	-->
	${page.script ? `<script src="${asset(page.script)}" defer></script>` : ''}
	<!--
		Google Analytics 4. The loader is the only third-party script on the site;
		the configuration beside it is served from our own origin so the content
		security policy never has to allow inline execution. See assets/analytics.js.

		No integrity attribute, deliberately: gtag.js is generated per request and
		Google publishes no stable hash for it, so subresource integrity would pin
		a body that changes and break measurement on Google's next deploy. The
		trust here rests on TLS and the CSP host allowlist instead.
	-->
	<script async src="https://www.googletagmanager.com/gtag/js?id=${SITE.analyticsId}"></script>
	<script src="${asset('analytics.js')}" defer></script>
	<!--
		Trustpilot's widget loader, which turns the review boxes on this site into
		something a reader can write in without leaving the page.

		Second third-party script, and the same reasoning as the one above: no
		integrity attribute, because Trustpilot regenerates the bundle and
		publishes no stable hash, so pinning one would break every widget on their
		next deploy. The CSP host allowlist and TLS are what this rests on, and the
		frame-src directive has to name the same host: the widget renders in an
		iframe, and without it the box is invisible with nothing in the console to
		say why.

		Only on the pages that actually carry a widget, and derived from the
		rendered body rather than from a flag somebody has to remember. It went on
		all thirty-two first, including /privacy — a page that lists every third
		party this site talks to and ends that list with "Nobody else", while
		loading a third party to say it.
	-->
	${collectsReviews ? `<script async src="${SITE.reviews.widget.script}"></script>` : ''}
	${page.structuredData ? `<script type="application/ld+json">${JSON.stringify(datedFor(page))}</script>` : ''}
	<script type="application/ld+json">${JSON.stringify(breadcrumbs(page))}</script>`.trim();
}

/**
 * A page's structured data, with its dates forced to agree with the page.
 *
 * **Two ways of writing the same date had drifted apart.** Some pages hardcoded
 * `dateModified` and some set it to `s.updated`, which is the *site's* review
 * date rather than the page's — so a page revised on one date could announce
 * another, in a field only a machine reads and only an audit would catch. Two
 * pages had it exactly backwards: each was publishing the other's date.
 *
 * The page's own `updated` is the truth here, and the visible "Last reviewed"
 * line already uses it. Overwriting rather than defaulting is deliberate: a
 * default still lets a page state a date, and a page stating its own date is
 * the thing that went wrong.
 */
function datedFor(page) {
	const data = page.structuredData(SITE);
	const on = page.updated ?? SITE.updated;
	for (const key of ['datePublished', 'dateModified']) {
		if (key in data) data[key] = on;
	}
	// `mainEntity` carries its own dates on the FAQ page.
	if (Array.isArray(data.mainEntity)) {
		for (const entry of data.mainEntity) {
			for (const key of ['datePublished', 'dateModified']) {
				if (key in entry) entry[key] = on;
			}
		}
	}
	return data;
}

/** Breadcrumbs, so a result can show its place rather than a bare URL. */
function breadcrumbs(page) {
	const trail = [{ name: 'Home', url: `${SITE.origin}/` }];
	if (page.parent) {
		const parent = PAGES.find((p) => p.slug === page.parent);
		/*
		 * Named here rather than left to crash.
		 *
		 * `site/verify.mjs` has a rule for a page declaring a parent that does not
		 * exist, and that rule could never run: this line reached `.navTitle` on
		 * `undefined` first and took the build down with a TypeError three frames
		 * deep. The build failed either way — but "Cannot read properties of
		 * undefined" is not the same help as being told which page points where.
		 */
		if (!parent) {
			throw new Error(
				`${page.slug} declares parent "${page.parent}", which is not a page. ` +
					'Fix the slug, or add the parent to site/pages/index.mjs.'
			);
		}
		trail.push({ name: parent.navTitle ?? parent.title, url: `${SITE.origin}/${parent.slug}` });
	}
	if (page.slug !== 'index') {
		trail.push({ name: page.navTitle ?? page.title, url: `${SITE.origin}/${page.slug}` });
	}
	return {
		'@context': 'https://schema.org',
		'@type': 'BreadcrumbList',
		itemListElement: trail.map((item, i) => ({
			'@type': 'ListItem',
			position: i + 1,
			name: item.name,
			item: item.url
		}))
	};
}

const formatDate = (iso) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});

/**
 * The breadcrumb the reader sees.
 *
 * The same trail as the JSON-LD, from the same function. Structured data that
 * describes a breadcrumb the page does not actually show is the kind of
 * mismatch that gets rich results withdrawn — and it is unhelpful to the reader,
 * who is the reason to have one.
 */
function trail(page) {
	if (page.slug === 'index') {
		return '';
	}
	const items = breadcrumbs(page).itemListElement;
	const li = items.map((item, index) =>
		index === items.length - 1
			? `\t\t\t<li aria-current="page">${escape(item.name)}</li>`
			: `\t\t\t<li><a href="${item.item.replace(SITE.origin, '') || '/'}">${escape(item.name)}</a></li>`
	);
	return ['\t\t<nav class="crumbs" aria-label="Breadcrumb"><ol>', ...li, '\t\t</ol></nav>'].join(
		'\n'
	);
}

function layout(page) {
	const nav = NAV.map((slug) => {
		const target = PAGES.find((p) => p.slug === slug);
		const current = target.slug === page.slug || page.parent === target.slug;
		return `<a href="/${target.slug}"${current ? ' aria-current="page"' : ''}>${escape(target.navTitle ?? target.title)}</a>`;
	}).join('\n\t\t\t\t');

	/*
	 * Guides get their furniture generated here rather than written into each
	 * page: heading ids and anchors always, and for a guide the byline row and a
	 * contents list built from the headings that survived editing. Doing it at
	 * this point means it applies to every existing page and to the next one
	 * without anybody remembering to add it.
	 */
	const iso = page.updated ?? SITE.updated;
	let body = anchorHeadings(page.body(SITE));
	if (page.guide) {
		body = jumpList(
			body.replace(
				'</h1>',
				`</h1>\n${guideMeta(
					iso,
					formatDate(iso),
					readingMinutes(body),
					// A page whose sourcing line carries a link needs SITE to build it.
					typeof page.sourced === 'function' ? page.sourced(SITE) : page.sourced
				)}`
			)
		);
	}

	return `<!doctype html>
<html lang="en">
<head>
	${head(page, body.includes('trustpilot-widget'))}
</head>
<body>
	<a class="skip" href="#main">Skip to content</a>
	<div class="progress" aria-hidden="true"></div>
	<header class="masthead">
		<div class="wrap">
			<a class="brand" href="/">
				<img src="/assets/mark.svg" width="30" height="30" alt="" aria-hidden="true">
				<span><b>Open Desktop</b> Authenticator</span>
			</a>
			<nav aria-label="Main">
				${nav}
			</nav>
		</div>
	</header>

	<main id="main" class="wrap${page.hero ? ' has-hero' : ''}">
${page.hero ? page.hero(SITE) : ''}
${trail(page)}
${body}
		<p class="reviewed">Last reviewed <time datetime="${iso}">${formatDate(iso)}</time>.</p>
	</main>

	<footer class="site-foot">
		<div class="wrap">
			<p class="foot-lead"><strong>${escape(SITE.name)}</strong> — ${escape(SITE.tagline)}</p>
			<nav aria-label="Footer">
				<a href="/steam-desktop-authenticator">About SDA</a>
				<a href="/download">Download</a>
				<a href="/verify">Verify a download</a>
				<a href="/security">Security</a>
				<a href="/scam-clones">Scam clones</a>
				<a href="/steam-inventory-stolen">What happened to us</a>
				<a href="/what-is-a-mafile">What is a maFile</a>
				<a href="/lost-authenticator">Lost your authenticator</a>
				<a href="/alternatives">Alternatives compared</a>
				<a href="/import-from-sda">Import from SDA</a>
				<a href="/docs">Documentation</a>
				<a href="/faq">FAQ</a>
				<a href="/owners">Who we are</a>
				<a href="/support">Report a problem</a>
				<a href="/credits">Credits</a>
				<a href="/donate">Donate</a>
				<!--
					Privacy was reachable from nowhere at all.

					Not the navigation, not this footer, not one in-content link on any
					of the twenty-seven pages — the only references to it anywhere were
					its own canonical tag and the sitemap. Which meant the page
					describing what we keep, and for how long, could not be found by
					anybody who wanted to know, including from the support form that
					collects the data it describes. A privacy policy nobody can reach is
					a document, not a disclosure.
				-->
				<a href="/privacy">Privacy</a>
				<a href="${SITE.repo}" rel="noopener">Source code</a>
			</nav>

			<!--
				Two attributions, both load-bearing.

				The first is the original project. Every page here that says "SDA"
				now has somewhere real to point, and the footer means the link is on
				all sixteen of them — including whichever one a search result drops
				somebody onto. A person who lands here looking for SDA and leaves
				with the genuine repository is the best outcome this site can have,
				even though it is not the one that gets us a download.

				The second is whose site this is. Anonymous software asking to hold
				your Steam authenticator is the shape of the problem, not the shape
				of the answer, so the company is named, linked and checkable.
			-->
			<div class="foot-brand">
				<p class="foot-origin">
					Looking for the original <strong>Steam Desktop Authenticator</strong> by
					${escape(SITE.sda.author)}? It lives at
					<a href="${SITE.sda.repo}" rel="noopener">github.com/${escape(SITE.sda.author)}/SteamDesktopAuthenticator</a>
					— that repository is the only official source for it, and any other site
					offering "SDA" is not it. Note that it is
					${escape(SITE.sda.notice)}; ${escape(SITE.sda.authorsAdvice)}.
				</p>
				<a class="powered" href="${SITE.brand.url}" rel="noopener">
					<img src="${SITE.brand.logo}" alt="" width="28" height="28" loading="lazy">
					<span><span class="powered-by">Powered by</span>
					<strong>${escape(SITE.brand.name)}</strong></span>
				</a>
			</div>

			<p class="fineprint">
				Published by
				<a href="${SITE.brand.url}" rel="noopener">${escape(SITE.publisher)}</a>.
				Not affiliated with, endorsed by, or connected to Valve Corporation, Steam, or
				${escape(SITE.sda.author)} and the authors of
				<a href="${SITE.sda.repo}" rel="noopener">Steam Desktop Authenticator</a>.
				Steam is a trademark of Valve Corporation.
			</p>
		</div>
	</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ build -- */

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/**
 * Assets, with a content hash in the filename.
 *
 * **This is what makes the cache header honest.** nginx serves /assets/ with
 * `immutable, max-age=31536000`, which promises the bytes at that URL will never
 * change. With a fixed name like `site.css` that promise is a lie, and the
 * consequence is not theoretical: the first restyle went out, Cloudflare kept
 * serving the previous stylesheet from cache, and the new design simply did not
 * appear. Nothing short of a manual purge would have fixed it, and returning
 * visitors would have held the old file for a year.
 *
 * Hashing the name makes the promise true. New content is a new URL, so it is
 * never in anyone's cache, and the old URL can be cached as hard as we like.
 */
function publishAssets() {
	const from = join(here, 'assets');
	const map = new Map();
	mkdirSync(join(out, 'assets'), { recursive: true });

	const walk = (dir, prefix = '') => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full, `${prefix}${name}/`);
				continue;
			}
			const bytes = readFileSync(full);
			const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
			const dot = name.lastIndexOf('.');
			const hashed = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
			const target = join(out, 'assets', prefix, hashed);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, bytes);
			map.set(`/assets/${prefix}${name}`, `/assets/${prefix}${hashed}`);
		}
	};
	walk(from);

	// Generated icons go through the same hashing, so the favicon set is cached
	// as hard as everything else and still replaced the moment the mark changes.
	for (const [name, bytes] of hashedIcons()) {
		const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
		const dot = name.lastIndexOf('.');
		const hashed = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
		writeFileSync(join(out, 'assets', hashed), bytes);
		map.set(`/assets/${name}`, `/assets/${hashed}`);
	}
	return map;
}

const ASSETS = publishAssets();

/** The published path of an asset, hash included. */
const asset = (name) => ASSETS.get(`/assets/${name}`) ?? `/assets/${name}`;

/** Rewrite every asset reference in a finished page to its hashed name. */
function fingerprint(html) {
	let out = html;
	// Longest first, so /assets/mark.svg cannot partially match a longer name.
	for (const [plain, hashed] of [...ASSETS].sort((a, b) => b[0].length - a[0].length)) {
		out = out.split(plain).join(hashed);
	}
	return out;
}

for (const page of PAGES) {
	const file = join(out, `${page.slug}.html`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, fingerprint(layout(page)));
}

/**
 * The sitemap, generated from the same list that generated the pages, so it can
 * never advertise a URL that does not exist or miss one that does.
 *
 * No `<priority>` and no `<changefreq>`: both are ignored by every major engine
 * and their presence is a reliable sign a sitemap was written by someone
 * following a 2009 checklist.
 */
/*
 * The files browsers fetch by name, without being told to.
 *
 * No content hash is possible here — nothing in our HTML names these paths, the
 * browser simply asks for them — so they are the one part of the icon set that
 * relies on revalidation rather than an immutable URL. nginx serves them with a
 * short max-age for exactly that reason.
 */
for (const [name, bytes] of rootIcons()) {
	writeFileSync(join(out, name), bytes);
}
writeFileSync(join(out, 'site.webmanifest'), manifest(SITE, asset));

/*
 * RFC 9116.
 *
 * **Generated rather than placed on the server by hand.** It was hand-written
 * into the web root once and a later deploy that cleared the directory removed
 * it, so the path 404'd for a day without anything noticing. Anything the site
 * serves belongs in the build; anything only on the server is one `rm` from
 * gone.
 *
 * `Expires` is required by the spec and must be in the future — a lapsed one is
 * treated as no file at all. Derived from the review date rather than from the
 * clock, so rebuilding does not silently move it.
 */
const expires = new Date(`${SITE.updated}T00:00:00Z`);
expires.setUTCFullYear(expires.getUTCFullYear() + 1);
/*
 * The file half of each verification that asks for one.
 *
 * Written from the same token the head carries, so the pair cannot drift: a
 * meta tag and a file naming different keys is the one failure mode of
 * publishing both, and it verifies nothing while looking like it should.
 */
for (const v of SITE.verifications.filter((entry) => entry.file)) {
	writeFileSync(join(out, `gridinsoft-${v.token}.txt`), v.token);
}

writeFileSync(
	join(out, 'security.txt'),
	`# ${SITE.name} — how to report a security problem.
#
# Listed in preference order. GitHub's private reporting threads and does not
# depend on a mailbox staying monitored; the address is read as well.
Contact: ${SITE.repo}/security/advisories/new
Contact: mailto:security@opendesktopauthenticator.com
Contact: ${SITE.origin}/support#security-reports
Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, '.000Z')}
Preferred-Languages: en
Canonical: ${SITE.origin}/.well-known/security.txt
Policy: ${SITE.repo}/blob/main/SECURITY.md
`
);

writeFileSync(
	join(out, 'sitemap.xml'),
	`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.filter((p) => !p.noindex)
	.map(
		(p) =>
			// The page's own review date, falling back to the site's — not the build
			// date. Stamping every URL with today meant a deploy that changed one
			// stylesheet told search engines all seventeen pages had been revised,
			// which is a claim about freshness that was simply untrue and devalues
			// the signal for the pages that genuinely had changed.
			`\t<url><loc>${SITE.origin}/${p.slug === 'index' ? '' : p.slug}</loc><lastmod>${p.updated ?? SITE.updated}</lastmod></url>`
	)
	.join('\n')}
</urlset>
`
);

/*
 * `llms.txt` — a map of this site for language models (llmstxt.org).
 *
 * **Worth being honest about what this is.** It is a 2024 proposal, and no
 * major AI search engine has committed to reading it; Google has said it does
 * not. What actually makes this site visible to GPTBot, ClaudeBot and the rest
 * is `robots.txt` allowing them and `sitemap.xml` listing every page, both of
 * which are below. This is a cheap bet on a convention that may become real,
 * not the mechanism — and saying so here stops somebody later believing the
 * file is load-bearing when it is not.
 *
 * Generated from `PAGES`, for the reason the sitemap is: a hand-written list
 * silently stops matching the site. And **every indexable page must be given a
 * section** — an unassigned page does not quietly vanish from the map, it stops
 * the build, because "the page exists but nothing points at it" is precisely
 * the failure this file is supposed to prevent.
 */
/** "Windows (…) and Linux (…). macOS is not shipped, because …" */
function platformSentence() {
	const shipping = SITE.platforms.filter((p) => p.shipping);
	const absent = SITE.platforms.filter((p) => !p.shipping);
	// `sentenceList` rather than a second joiner: the serial comma is a decision
	// this site has already made, and two implementations of it disagree.
	const head = sentenceList(shipping.map((p) => `${p.name} (${p.detail})`));
	return absent.length === 0
		? `${head}.`
		: `${head}. ${absent.map((p) => `${p.name} is ${p.detail}`).join('; ')}.`;
}

const LLMS_SECTIONS = [
	{
		heading: 'The application',
		note: 'What it is, how to get it, and how to check what you got.',
		slugs: ['index', 'download', 'verify', 'import-from-sda', 'uninstall', 'docs', 'faq']
	},
	{
		heading: 'Trust and safety',
		note: 'Why this project exists. Fake SDA downloads are the reason.',
		slugs: [
			'security',
			'scam-clones',
			'official',
			'code-signing-policy',
			'steam-inventory-stolen',
			'alternatives'
		]
	},
	{
		heading: 'Steam Guard, explained',
		note: 'Answers to Steam authenticator questions, independent of this application.',
		slugs: [
			'steam-desktop-authenticator',
			'what-is-a-mafile',
			'how-to-open-mafile',
			'encrypted-mafile',
			'lost-authenticator',
			'steam-revocation-code',
			'move-steam-authenticator-new-phone',
			'move-steam-authenticator-to-pc',
			'steam-guard-trade-holds',
			'steam-guard-code-not-working',
			'steam-guard-without-phone',
			'approve-steam-confirmations-desktop',
			'steam-mobile-vs-desktop-authenticator'
		]
	},
	{
		// The spec's reserved heading: everything here may be skipped when
		// context is short. These describe the publisher rather than the subject.
		heading: 'Optional',
		note: 'Who publishes this, and the housekeeping.',
		slugs: ['owners', 'credits', 'support', 'donate', 'privacy']
	}
];

{
	const indexable = PAGES.filter((p) => !p.noindex);
	const assigned = new Set(LLMS_SECTIONS.flatMap((section) => section.slugs));

	const unassigned = indexable.filter((p) => !assigned.has(p.slug));
	if (unassigned.length > 0) {
		throw new Error(
			`llms.txt has no section for: ${unassigned.map((p) => p.slug).join(', ')}. ` +
				'Add each to a section in LLMS_SECTIONS — a page missing from the map is ' +
				'the problem this file exists to avoid.'
		);
	}

	const missing = [...assigned].filter((slug) => !indexable.some((p) => p.slug === slug));
	if (missing.length > 0) {
		throw new Error(
			`llms.txt lists pages that do not exist: ${missing.join(', ')}. ` +
				'Renamed or removed, and the map was not updated.'
		);
	}

	const url = (slug) => `${SITE.origin}/${slug === 'index' ? '' : slug}`;
	const link = (slug) => {
		const page = indexable.find((p) => p.slug === slug);
		return `- [${page.title}](${url(slug)}): ${page.description}`;
	};

	writeFileSync(
		join(out, 'llms.txt'),
		`# ${SITE.name}

> A free, open-source Steam Guard authenticator for the desktop. It generates Steam Guard codes, approves Steam trade and market confirmations, and imports maFiles from Steam Desktop Authenticator (SDA). Published by ${SITE.publisher} under the MIT licence. Commonly abbreviated ${SITE.short}.

## What it is

${SITE.name} is a desktop replacement for Steam Desktop Authenticator (SDA), which its author ${SITE.sda.author} says is ${SITE.sda.unsupported ? SITE.sda.notice : 'still supported'}. Because SDA is abandoned, searching for it returns clone sites that ship malware and steal maFiles — and a maFile is the Steam authenticator itself, so losing one loses the account. Much of this website exists to help someone tell a real download from a fake one, whether or not they choose this application.

It runs entirely on the user's own machine. There is no account to create, no server operated by the publisher, and no synchronisation: Steam communication happens directly between the user's machine and Valve.

## Facts

- **Cost:** free. No paid tier, no trial, no upsell.
- **Licence:** MIT. Source: ${SITE.repo}
- **Publisher:** ${SITE.publisher}, a Steam trading company — which is why it was written.
- **Platforms:** ${platformSentence()}
- **Install from:** the Microsoft Store (${SITE.store.url}) or GitHub releases (${SITE.repo}/releases/latest).
- **This website hosts no binaries** and never will; every download control links outward.
- **Dependencies:** ${SITE.runtimeDependencies} direct, ${SITE.shippedPackages} shipped in total, plus the Electron runtime.

## What it does

- Encrypted multi-account vault, unlocked with a passphrase the user chooses.
- Generates Steam Guard codes.
- Views, accepts and denies Steam trade and market confirmations.
- Imports existing SDA maFiles, including encrypted ones, which additionally need SDA's manifest.json.
- Exports back to the maFile format, so leaving later is a supported operation rather than a rescue.
- Adds a Steam authenticator to an account that has none, and moves one from a phone.
- Stores the Steam revocation code (Valve calls it the recovery code) and can reveal it again.
- Optional automatic confirmation, per account and per type, off by default.
- Optional per-account network routing.
- An in-app browser, signed in as one account and routed like it, for finishing a trade on Steam or a third-party trading site.

## What it deliberately does not do

Non-goals rather than roadmap items: no trade automation beyond confirmations, no market or inventory tooling, and no analytics of any kind — including "anonymous" or opt-in. No servers, no sync, no accounts, no telemetry.

**It never downloads or executes its own replacement.** The update check reports that a newer version exists and links to it; nothing is fetched or installed. Self-updating is exactly the mechanism the clone sites depend on, so an authenticator that did it could not argue against them.

## How secrets are protected

Steam secrets are encrypted at rest with scrypt and AES-256-GCM behind the user's passphrase. The interface runs isolated with no Node integration, the vault locks when idle, and on its own the application opens no network connection beyond Steam and an optional update check. The in-app browser is the exception and is not a background one: it is a window the user opens and drives, so it loads whatever they navigate to, over that account's configured network route, in a session of its own with no access to the vault. ${SITE.origin}/security sets out the model, including what it cannot protect against.

## How to check a download is genuine

Every release publishes SHA-256 checksums${SITE.release.signed ? ', a signature over that checksum list' : ''}, and build provenance naming the workflow and the commit that produced the bytes. ${SITE.origin}/verify carries commands to copy for each platform.

${
	releaseGaps(SITE).length
		? `**Not finished, and said here rather than left to be discovered:** ${sentenceList(releaseGaps(SITE))}. ${SITE.origin}/download tracks each one.`
		: `Everything once listed as outstanding is done; ${SITE.origin}/download shows where each stands.`
}

${LLMS_SECTIONS.map(
	(section) => `## ${section.heading}

${section.note}

${section.slugs.map(link).join(`
`)}`
).join(`

`)}
`
	);
}

writeFileSync(
	join(out, 'robots.txt'),
	`# ${SITE.name}
# Everything here is meant to be found. The only disallowed paths are the ones
# that would waste a crawler's time or index a one-off token.
User-agent: *
Allow: /
Disallow: /support/ticket/
Disallow: /admin

Sitemap: ${SITE.origin}/sitemap.xml
`
);

process.stdout.write(
	`${PAGES.length} pages + sitemap + robots → site/dist\n` +
		PAGES.map((p) => `  /${p.slug === 'index' ? '' : p.slug}`).join('\n') +
		'\n'
);
