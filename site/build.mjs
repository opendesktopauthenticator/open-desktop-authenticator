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

import { mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './pages/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

export const SITE = {
	origin: 'https://opendesktopauthenticator.com',
	name: 'Open Desktop Authenticator',
	short: 'ODA',
	tagline: 'An open-source Steam authenticator for the desktop.',
	publisher: 'MASTERPANEL LLC',
	repo: 'https://github.com/opendesktopauthenticator/open-desktop-authenticator'
};

const escape = (s) =>
	String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

/** The pages that appear in the header, in the order a newcomer needs them. */
const NAV = ['steam-desktop-authenticator', 'download', 'verify', 'security', 'docs', 'support'];

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
	const title =
		page.slug === 'index' || page.title.length + suffix.length > 62
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
	<meta property="og:image" content="${SITE.origin}/assets/mark-512.png">
	<meta name="twitter:card" content="summary">
	<link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
	<link rel="apple-touch-icon" href="/assets/mark-512.png">
	<link rel="stylesheet" href="/assets/site.css">
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

function layout(page) {
	const nav = NAV.map((slug) => {
		const target = PAGES.find((p) => p.slug === slug);
		const current = target.slug === page.slug || page.parent === target.slug;
		return `<a href="/${target.slug}"${current ? ' aria-current="page"' : ''}>${escape(target.navTitle ?? target.title)}</a>`;
	}).join('\n\t\t\t\t');

	return `<!doctype html>
<html lang="en">
<head>
	${head(page)}
</head>
<body>
	<a class="skip" href="#main">Skip to content</a>
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

	<main id="main" class="wrap">
${page.body(SITE)}
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
				<a href="/import-from-sda">Import from SDA</a>
				<a href="/docs">Documentation</a>
				<a href="/faq">FAQ</a>
				<a href="/support">Report a problem</a>
				<a href="${SITE.repo}" rel="noopener">Source code</a>
			</nav>
			<p class="fineprint">
				Published by ${escape(SITE.publisher)}. Not affiliated with, endorsed by, or
				connected to Valve Corporation, Steam, or the authors of Steam Desktop
				Authenticator. Steam is a trademark of Valve Corporation.
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

for (const page of PAGES) {
	const file = join(out, `${page.slug}.html`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, layout(page));
}

cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });

/**
 * The sitemap, generated from the same list that generated the pages, so it can
 * never advertise a URL that does not exist or miss one that does.
 *
 * No `<priority>` and no `<changefreq>`: both are ignored by every major engine
 * and their presence is a reliable sign a sitemap was written by someone
 * following a 2009 checklist.
 */
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
	join(out, 'sitemap.xml'),
	`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.filter((p) => !p.noindex)
	.map(
		(p) =>
			`\t<url><loc>${SITE.origin}/${p.slug === 'index' ? '' : p.slug}</loc><lastmod>${today}</lastmod></url>`
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
