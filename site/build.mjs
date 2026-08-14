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
import { escape, reviewAsk } from './markup.mjs';
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
	updated: '2026-08-12',
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
		write: 'https://www.trustpilot.com/evaluate/opendesktopauthenticator.com'
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
		published: false,
		/** Artifacts are listed with SHA-256 checksums on the release page. */
		checksums: false,
		/** The checksum file carries a signature from a published key. */
		signed: false,
		/** Anyone can rebuild the tag and get the same bytes. Deferred (§P3). */
		reproducible: false
	},

	/** The company behind this, and the other things it runs. */
	brand: {
		name: 'MASTERPANEL',
		legal: 'MASTERPANEL LLC',
		url: 'https://masterspanel.com',
		logo: '/assets/projects/masterspanel.svg'
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
function head(page) {
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
	return `
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
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
	<link rel="icon" href="/favicon.ico" sizes="32x32">
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
	${page.structuredData ? `<script type="application/ld+json">${JSON.stringify(page.structuredData(SITE))}</script>` : ''}
	<script type="application/ld+json">${JSON.stringify(breadcrumbs(page))}</script>`.trim();
}

/** Breadcrumbs, so a result can show its place rather than a bare URL. */
function breadcrumbs(page) {
	const trail = [{ name: 'Home', url: `${SITE.origin}/` }];
	if (page.parent) {
		const parent = PAGES.find((p) => p.slug === page.parent);
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
	${head(page)}
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
