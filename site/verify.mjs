/**
 * Checks the built site.
 *
 *     node site/verify.mjs            → check site/dist on disk
 *     node site/verify.mjs <origin>   → check the same pages as served
 *
 * Two passes, because they catch different things. The first reads the files the
 * generator produced and can check every page exhaustively — structure, metadata,
 * internal links, structured data. The second asks the running server for the
 * same URLs and checks what a visitor and a crawler actually receive: status
 * codes, content types, security headers, and whether clean URLs resolve at all.
 *
 * A page can be perfect on disk and unreachable in nginx. Only the second pass
 * would notice.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './pages/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const origin = process.argv[2];

/**
 * Files served from the root under names browsers hardcode.
 *
 * Not pages and not hashed assets, so the link checker needs to know about them
 * — but they are still verified to exist rather than waved through.
 */
const ROOT_FILES = new Set([
	'/favicon.ico',
	'/apple-touch-icon.png',
	'/apple-touch-icon-precomposed.png',
	'/site.webmanifest',
	'/robots.txt',
	'/sitemap.xml'
]);

const problems = [];
const fail = (page, message) => problems.push(`${page}: ${message}`);
const count = (text, re) => (text.match(re) ?? []).length;

/* --------------------------------------------------------------- pass one -- */

const built = new Map();
for (const page of PAGES) {
	const file = join(dist, `${page.slug}.html`);
	if (!existsSync(file)) {
		fail(page.slug, 'was not generated');
		continue;
	}
	built.set(page.slug, readFileSync(file, 'utf8'));
}

for (const [slug, html] of built) {
	const page = PAGES.find((p) => p.slug === slug);
	const path = slug === 'index' ? '' : slug;

	// Structure. One H1 per page is not a style preference: it is what tells a
	// crawler what the page is about, and two of them means neither is trusted.
	if (count(html, /<h1[\s>]/g) !== 1) {
		fail(slug, `has ${count(html, /<h1[\s>]/g)} <h1> elements, expected exactly 1`);
	}
	if (!/<html lang="en">/.test(html)) {
		fail(slug, 'is missing a lang attribute');
	}
	if (!/<main id="main"/.test(html)) {
		fail(slug, 'has no main landmark');
	}

	// Metadata. Lengths are the practical limits before a result is truncated —
	// a description that gets cut mid-sentence is worse than a shorter one.
	const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
	if (title.length < 15) fail(slug, `title is too short: "${title}"`);
	if (title.length > 65) fail(slug, `title is ${title.length} chars, over 65: "${title}"`);

	const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
	if (description.length < 70) fail(slug, `description is only ${description.length} chars`);
	if (description.length > 165) fail(slug, `description is ${description.length} chars, over 165`);

	const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
	const expected = `https://opendesktopauthenticator.com/${path}`;
	if (canonical !== expected) fail(slug, `canonical is ${canonical}, expected ${expected}`);

	if (page.noindex) {
		if (!/name="robots" content="[^"]*noindex/.test(html)) {
			// The 404 must not be indexed, and the generator has to say so.
			fail(slug, 'is marked noindex in the page list but does not say so in the HTML');
		}
	}

	// Structured data has to parse, or it is worse than absent.
	for (const [, json] of html.matchAll(
		/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
	)) {
		try {
			const parsed = JSON.parse(json);
			if (!parsed['@context']) fail(slug, 'structured data has no @context');
		} catch (error) {
			fail(slug, `structured data is not valid JSON: ${error.message}`);
		}
	}

	// Every internal link must go somewhere that exists — a page, a hashed asset,
	// or one of the fixed-name files at the root. All three are checked on disk
	// rather than merely tolerated, because a head that points at a missing icon
	// is exactly the failure this whole set was added to fix.
	for (const [, href] of html.matchAll(/href="(\/[^"#?]*)"/g)) {
		if (href.startsWith('/assets/') || ROOT_FILES.has(href)) {
			if (!existsSync(join(dist, href))) fail(slug, `links to ${href}, which was not built`);
			continue;
		}
		const target = href === '/' ? 'index' : href.slice(1);
		if (!PAGES.some((p) => p.slug === target)) fail(slug, `links to ${href}, which is not a page`);
	}

	// Images need alt text, even when the right alt text is empty.
	for (const [tag] of html.matchAll(/<img [^>]*>/g)) {
		if (!/\balt=/.test(tag)) fail(slug, `has an <img> with no alt attribute: ${tag.slice(0, 60)}`);
		// Explicit dimensions, or the page reflows when the image arrives and the
		// reader loses their place. Cumulative layout shift is the one Core Web
		// Vital a static site with no scripts can still fail.
		if (!/\bwidth=/.test(tag) || !/\bheight=/.test(tag)) {
			fail(slug, `has an <img> with no width/height: ${tag.slice(0, 70)}`);
		}
	}

	// Thin pages were the thing to avoid, so measure it rather than assume it.
	const words = html
		.replace(/<script[\s\S]*?<\/script>/g, '')
		.replace(/<[^>]+>/g, ' ')
		.split(/\s+/)
		.filter(Boolean).length;
	if (!page.noindex && words < 320) {
		fail(slug, `is thin: ${words} words of visible text`);
	}

	// Anything left unwritten. Matched on word boundaries: a plain substring
	// search flagged an example reference of the form ODA-XXXX-XXXX, which is
	// documentation rather than an unfinished sentence.
	for (const marker of ['TODO', 'TKTK', 'Lorem ipsum', 'PLACEHOLDER', 'FIXME']) {
		// `\\b`, not `\b`: inside a template literal a single backslash-b is the
		// backspace character, so the pattern becomes \x08TODO\x08 and matches
		// nothing. This check silently passed everything until it was mutation-tested.
		if (new RegExp(`\\b${marker}\\b`).test(html)) {
			fail(slug, `contains the placeholder "${marker}"`);
		}
	}
}

// The sitemap must agree with the pages, in both directions.
const sitemap = existsSync(join(dist, 'sitemap.xml'))
	? readFileSync(join(dist, 'sitemap.xml'), 'utf8')
	: '';
for (const page of PAGES) {
	const url = `https://opendesktopauthenticator.com/${page.slug === 'index' ? '' : page.slug}`;
	const listed = sitemap.includes(`<loc>${url}</loc>`);
	if (page.noindex && listed) fail('sitemap', `lists ${url}, which is noindex`);
	if (!page.noindex && !listed) fail('sitemap', `is missing ${url}`);
}

/*
 * The licence the site claims must be the licence the repository carries.
 *
 * These had drifted. The FAQ said GPL — in the visible answer and again inside
 * the FAQPage structured data — while LICENSE, package.json, the README and
 * CONTRIBUTING all said MIT, and the home page's SoftwareApplication data
 * asserted gpl-3.0 in machine-readable form. An outside reviewer caught it by
 * comparing the site against the repository, which is a comparison a machine
 * can make on every build instead.
 */
const licencePath = join(here, '..', 'LICENSE');
// Reported rather than thrown. A crash here would take the whole verification
// down over a missing file, which is how a check stops running without anyone
// deciding that it should.
const declaredLicence = !existsSync(licencePath)
	? (fail('LICENSE', 'not found beside the site, so licence claims cannot be checked'), 'UNKNOWN')
	: /^MIT License/.test(readFileSync(licencePath, 'utf8'))
		? 'MIT'
		: 'UNKNOWN';

for (const [slug, html] of built) {
	const words = html.replace(/<[^>]+>/g, ' ');
	for (const other of ['GPL', 'Apache License', 'BSD']) {
		if (declaredLicence !== other && new RegExp(`\\b${other}\\b`).test(words)) {
			fail(slug, `claims the ${other} licence; LICENSE says ${declaredLicence}`);
		}
	}
	if (declaredLicence === 'MIT' && /gnu\.org\/licenses/.test(html)) {
		fail(slug, 'points structured data at a GNU licence while LICENSE says MIT');
	}
}

process.stdout.write(`pass 1 — ${built.size} pages read from site/dist\n`);

/* --------------------------------------------------------------- pass two -- */

if (origin) {
	const REQUIRED_HEADERS = [
		'content-security-policy',
		'x-content-type-options',
		'referrer-policy',
		'x-frame-options',
		'permissions-policy'
	];
	let checked = 0;

	for (const page of PAGES) {
		if (page.slug === '404') continue;
		const path = page.slug === 'index' ? '/' : `/${page.slug}`;
		let response;
		try {
			response = await fetch(`${origin}${path}`, { redirect: 'manual' });
		} catch (error) {
			fail(path, `could not be fetched: ${error.message}`);
			continue;
		}
		checked++;
		if (response.status !== 200) fail(path, `served ${response.status}, expected 200`);
		if (!(response.headers.get('content-type') ?? '').includes('text/html')) {
			fail(path, `content-type is ${response.headers.get('content-type')}`);
		}
		for (const header of REQUIRED_HEADERS) {
			if (!response.headers.get(header)) fail(path, `is missing the ${header} header`);
		}
		if (response.headers.get('server')?.match(/\d/)) {
			fail(path, `leaks a version in the Server header: ${response.headers.get('server')}`);
		}
		const body = await response.text();
		if (body !== built.get(page.slug)) {
			// Name the cause when we recognise it. Cloudflare's Email Address
			// Obfuscation rewrites any plain-text address in HTML and injects a
			// decoder script — on a site that ships none, and leaving the address
			// unreadable to anyone without JavaScript, which for a security contact
			// is the wrong audience to exclude. Turn it off under
			// Scrape Shield → Email Address Obfuscation.
			if (/__cf_email__|email-decode\.min\.js/.test(body)) {
				fail(path, 'Cloudflare is obfuscating an email address and injecting a script');
			} else {
				fail(path, 'served content differs from the build output');
			}
		}
	}

	// The things that are not pages but must still work. The stylesheet's name
	// carries a content hash, so it is read out of the page rather than assumed —
	// and checking the exact URL the HTML asks for is the stronger test anyway,
	// since a mismatch there is a page with no styling at all.
	const styleHref =
		/<link rel="stylesheet" href="([^"]+)"/.exec(built.get('index') ?? '')?.[1] ??
		'/assets/site.css';
	for (const [path, expect] of [
		['/robots.txt', 'text/plain'],
		['/sitemap.xml', 'xml'],
		[styleHref, 'text/css']
	]) {
		const response = await fetch(`${origin}${path}`).catch(() => undefined);
		if (!response || response.status !== 200) {
			fail(path, `served ${response?.status ?? 'nothing'}`);
		} else if (!(response.headers.get('content-type') ?? '').includes(expect)) {
			fail(path, `content-type is ${response.headers.get('content-type')}, expected ${expect}`);
		}
	}

	/*
	 * The icons, including the ones no HTML points at.
	 *
	 * Checked here rather than assumed, because the failure is silent: a 404 on
	 * /favicon.ico does not break anything, it just means every tab shows the
	 * browser's generic default — and browsers cache that miss, so it outlives
	 * the fix. Every one of these paths was returning 404 before this ran.
	 */
	for (const [path, type] of [
		['/favicon.ico', 'image/'],
		['/apple-touch-icon.png', 'image/png'],
		['/apple-touch-icon-precomposed.png', 'image/png'],
		['/site.webmanifest', 'json'],
		// Was 404 for a day after a deploy cleared the web root.
		['/.well-known/security.txt', 'text/plain']
	]) {
		const response = await fetch(`${origin}${path}`).catch(() => undefined);
		if (!response || response.status !== 200) {
			fail(path, `served ${response?.status ?? 'nothing'} — browsers ask for this by name`);
			continue;
		}
		if (!(response.headers.get('content-type') ?? '').includes(type)) {
			fail(path, `content-type is ${response.headers.get('content-type')}, expected ${type}`);
		}
		// These cannot be content-hashed, so an immutable cache would strand a
		// stale icon in every browser that ever loaded the old one.
		const cache = response.headers.get('cache-control') ?? '';
		if (cache.includes('immutable')) {
			fail(path, `is immutable but cannot be versioned: ${cache}`);
		}
	}

	// Every icon the HTML declares must actually resolve.
	for (const [, href] of (built.get('index') ?? '').matchAll(
		/<link rel="(?:icon|apple-touch-icon|mask-icon|manifest)"[^>]*href="([^"]+)"/g
	)) {
		const response = await fetch(`${origin}${href}`).catch(() => undefined);
		if (!response || response.status !== 200) {
			fail(href, `declared in the head but served ${response?.status ?? 'nothing'}`);
		}
	}

	// A missing page must be a 404, not a 200 with a friendly page — a soft 404
	// gets indexed.
	const missing = await fetch(`${origin}/no-such-page-here`).catch(() => undefined);
	if (missing && missing.status !== 404)
		fail('/no-such-page-here', `served ${missing.status}, expected 404`);

	process.stdout.write(`pass 2 — ${checked} pages fetched from ${origin}\n`);
}

/* ------------------------------------------------------------------ report -- */

if (problems.length === 0) {
	process.stdout.write(`\nno problems found\n`);
} else {
	process.stdout.write(`\n${problems.length} problem(s):\n`);
	for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
	process.exitCode = 1;
}
