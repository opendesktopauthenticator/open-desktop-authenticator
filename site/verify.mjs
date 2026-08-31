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
// The same object the pages render from, so the check compares against the
// single source of truth rather than a second copy of it.
import { SITE } from './build.mjs';

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
	/*
	 * Built at the root, served from /.well-known by an nginx alias, so the file
	 * on disk and the URL do not share a path. Listed explicitly rather than
	 * resolved by guesswork — the pages link the URL, and the URL is what has to
	 * work.
	 */
	'/.well-known/security.txt',
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
	// 155, not the 165 this used to allow.
	//
	// 165 is roughly where a description is truncated outright; 155 is where it
	// starts being truncated in practice, because the cut is made on pixel width
	// rather than characters and a description full of wide letters loses its
	// ending sooner. Six pages sat in the gap between the two — long enough to
	// have their last clause cut off in a result, short enough that the checker
	// called them fine.
	if (description.length > 155) fail(slug, `description is ${description.length} chars, over 155`);

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
			// The alias above is the one URL whose file lives elsewhere on disk.
			const onDisk = href === '/.well-known/security.txt' ? '/security.txt' : href;
			if (!existsSync(join(dist, onDisk))) fail(slug, `links to ${href}, which was not built`);
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

/*
 * Distinct pages need distinct promises.
 *
 * A technically valid site can still become a collection of near-duplicate
 * landing pages aimed at adjacent queries. Exact duplicates are the clearest
 * regression signal: two indexable pages with the same title, description or
 * H1 no longer explain why both should exist. Keep this deliberately exact;
 * semantic similarity still needs editorial judgement during review.
 */
const uniqueFields = [
	['title', (html) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? ''],
	['description', (html) => /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? ''],
	[
		'H1',
		(html) =>
			(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '')
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
	]
];

for (const [field, read] of uniqueFields) {
	const seen = new Map();
	for (const page of PAGES) {
		if (page.noindex) continue;
		const value = read(built.get(page.slug) ?? '').toLocaleLowerCase('en');
		if (!value) continue;
		const first = seen.get(value);
		if (first) {
			fail(page.slug, `${field} duplicates ${first}: "${value}"`);
		} else {
			seen.set(value, page.slug);
		}
	}
}

/*
 * A declared hierarchy must be real for readers as well as for breadcrumbs.
 *
 * A child page whose parent never links to it is structured-data theatre. It
 * also recreates the flat, search-result-first shape associated with doorway
 * collections. Guide pages are required to live under a deliberate hub.
 */
/*
 * **Two pages that say the same thing in different words.**
 *
 * The duplicate title, description and H1 checks above are exact-match: they
 * catch a copied field, not a copied page. Google's scaled content abuse policy
 * is about pages "generated for the primary purpose of manipulating search
 * rankings and not helping users", and the shape that produces is a family of
 * pages whose bodies are substantially the same with the query swapped.
 *
 * Measured as the overlap of six-word runs, over `<main>` only — the shared
 * header, nav and footer are identical on all 32 pages by design and would
 * drown the signal. When this was written the highest overlap between any two
 * pages was 5.1%, and the median page ran to 817 words, so 30% is far above
 * anything the site does today and far below two pages worth merging.
 *
 * This is deliberately a floor rather than a style guide: it cannot tell a
 * useful sibling page from a spun one, only that two pages have stopped being
 * distinguishable. Editorial judgement still belongs in review.
 */
const SIMILARITY_LIMIT = 0.3;

function shingles(text) {
	const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
	const out = new Set();
	for (let i = 0; i + 6 <= words.length; i++) out.add(words.slice(i, i + 6).join(' '));
	return out;
}

{
	const bodies = new Map();
	for (const page of PAGES) {
		if (page.noindex) continue;
		const text = mainOf(built.get(page.slug) ?? '')
			.replace(/<script[\s\S]*?<\/script>/g, ' ')
			.replace(/<style[\s\S]*?<\/style>/g, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ');
		const set = shingles(text);
		if (set.size > 0) bodies.set(page.slug, set);
	}

	const slugs = [...bodies.keys()];
	for (let i = 0; i < slugs.length; i++) {
		for (let j = i + 1; j < slugs.length; j++) {
			const a = bodies.get(slugs[i]);
			const b = bodies.get(slugs[j]);
			let shared = 0;
			for (const run of a) if (b.has(run)) shared++;
			const overlap = shared / (a.size + b.size - shared);
			if (overlap >= SIMILARITY_LIMIT) {
				fail(
					slugs[i],
					`shares ${Math.round(overlap * 100)}% of its wording with ${slugs[j]} — ` +
						'two pages this alike need merging, or one needs a reason to exist'
				);
			}
		}
	}
}

/** A page's own content, with the shared header, nav and footer removed. */
function mainOf(html) {
	const start = html.indexOf('<main');
	const end = html.indexOf('</main>');
	return start === -1 || end === -1 ? html : html.slice(start, end);
}

for (const page of PAGES) {
	if (page.guide && !page.parent) {
		fail(page.slug, 'is a guide but has no declared reader-facing parent');
	}
	if (!page.parent) continue;
	const parent = PAGES.find((candidate) => candidate.slug === page.parent);
	if (!parent) {
		fail(page.slug, `declares missing parent ${page.parent}`);
		continue;
	}
	if (parent === page) fail(page.slug, 'declares itself as its parent');
	if (parent.noindex) fail(page.slug, `declares noindex page ${parent.slug} as its parent`);
	/*
	 * **The parent's own words, not the furniture around them.**
	 *
	 * This read the whole document, and the site footer links five of these
	 * children from every page — so for those five the rule passed on the
	 * footer's say-so and would have gone on passing if the hub stopped
	 * mentioning them at all. A hierarchy that only exists in navigation
	 * present on all 32 pages is the flat shape this rule was added to prevent,
	 * asserted rather than fixed.
	 *
	 * `<main>` is the parent actually saying it.
	 */
	const parentHtml = mainOf(built.get(parent.slug) ?? '');
	if (!parentHtml.includes(`href="/${page.slug}"`)) {
		fail(
			page.slug,
			`declares ${parent.slug} as its parent, but that page's own content does not link to it`
		);
	}
}

/*
 * The company, website and application are related, but not interchangeable.
 * Misidentifying a repository or sibling business as the company in JSON-LD is
 * misleading structured data even if every visible sentence is accurate.
 */
{
	const homePage = PAGES.find((page) => page.slug === 'index');
	const graph = homePage?.structuredData?.(SITE)?.['@graph'] ?? [];
	const organization = graph.find((entry) => entry['@type'] === 'Organization');
	const website = graph.find((entry) => entry['@type'] === 'WebSite');
	const software = graph.find((entry) => entry['@type'] === 'SoftwareApplication');
	if (organization?.['@id'] !== SITE.organizationId || organization?.url !== SITE.brand.url) {
		fail('index', 'structured data does not identify the publisher at its company URL');
	}
	if (website?.['@id'] !== SITE.websiteId || website?.url !== SITE.origin) {
		fail('index', 'structured data does not identify this domain as the product website');
	}
	if (
		software?.['@id'] !== SITE.softwareId ||
		software?.url !== SITE.origin ||
		software?.publisher?.['@id'] !== SITE.organizationId ||
		!software?.sameAs?.includes(SITE.repo) ||
		!software?.sameAs?.includes(SITE.store.url)
	) {
		fail(
			'index',
			'structured data does not keep the software, publisher and release homes distinct'
		);
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

/*
 * Attribution, on every page.
 *
 * Two links that are easy to lose in a redesign and expensive to be missing.
 *
 * The original project's repository is the more important of the two. This site
 * spent its whole existence discussing Steam Desktop Authenticator without ever
 * saying where the real one lives, which on a site about fake downloads was the
 * worst possible omission — so it is checked rather than remembered.
 *
 * The publisher is the other half of the same argument. Anonymous software
 * asking to hold a Steam Guard secret is the shape of the problem; a named,
 * followable company is part of the answer.
 */
const ORIGINAL_SDA = 'https://github.com/Jessecar96/SteamDesktopAuthenticator';
const BRAND_URL = 'https://masterspanel.com';

/*
 * Container tags must balance.
 *
 * A callout on /move-steam-authenticator-new-phone lost its closing `</div>`
 * and shipped. Nothing caught it: the build is string concatenation so it had
 * no opinion, every test passed, and the page still rendered — it just rendered
 * the entire Related section *inside* an amber warning box, because that is
 * what a browser does with an unclosed container. It looked deliberate enough
 * that several careful reads went past it.
 *
 * Counting is crude and that is the point: it needs no parser, it cannot be
 * argued with, and the failure it catches is exactly the one a human eye slides
 * over. Only containers whose imbalance changes the visual structure of a page
 * are counted; void and self-closing elements are not.
 */
const BALANCED = ['article', 'div', 'ul', 'ol', 'li', 'dl', 'figure', 'nav', 'table', 'p'];

for (const [slug, html] of built) {
	/*
	 * Literal regular expressions, tallied once.
	 *
	 * The first version built these from a template literal, where `\s` is not a
	 * valid escape and quietly collapses to a bare `s` — so the character class
	 * became `[s>]` and almost no opening tag matched. It reported every page as
	 * broken, which is at least a loud failure; a check that silently matched
	 * nothing would have been worse than no check at all.
	 */
	const opened = new Map();
	const closed = new Map();
	for (const [, tag] of html.matchAll(/<([a-z]+)[\s>]/g)) {
		opened.set(tag, (opened.get(tag) ?? 0) + 1);
	}
	for (const [, tag] of html.matchAll(/<\/([a-z]+)>/g)) {
		closed.set(tag, (closed.get(tag) ?? 0) + 1);
	}
	for (const tag of BALANCED) {
		const open = opened.get(tag) ?? 0;
		const close = closed.get(tag) ?? 0;
		if (open !== close) {
			fail(slug, `<${tag}> does not balance: ${open} opened, ${close} closed`);
		}
	}
}

for (const [slug, html] of built) {
	if (!html.includes(ORIGINAL_SDA)) {
		fail(slug, 'does not link the original SDA repository anywhere on the page');
	}
	if (!html.includes(BRAND_URL)) {
		fail(slug, 'does not link the publisher anywhere on the page');
	}
	// A brand mark nobody can follow is decoration, so the logo has to be inside
	// the link rather than beside it.
	if (!/<a class="powered"[^>]*>[\s\S]*?<img[\s\S]*?<\/a>/.test(html)) {
		fail(slug, 'has no followable "powered by" mark in the footer');
	}
}

/*
 * No page may claim a capability the release pipeline does not have.
 *
 * This is the check the site most needed and did not have. Five pages described
 * reproducible builds, published checksums and release signatures in the present
 * tense while there were no releases at all — each sentence true as a statement
 * of intent when written, none revisited, and nothing anywhere comparing the
 * claims against reality.
 *
 * Phrasing is matched rather than meaning, so this is not proof of honesty. It
 * is a tripwire: the specific present-tense forms that were actually wrong now
 * fail the build until the corresponding flag is true.
 */
const CLAIMS = [
	{
		flag: 'reproducible',
		says: 'reproducible builds exist today',
		patterns: [
			/builds are reproducible/i,
			/the build is reproducible/i,
			/builds? reproducible from that source/i,
			/compare (?:your|the) (?:build|result)[^.]{0,40}byte for byte/i
		]
	},
	{
		flag: 'checksums',
		says: 'every release carries checksums',
		patterns: [/every release (?:carries|is published with) checksums/i]
	},
	{
		/*
		 * **Missing entirely until five pages went out claiming it.**
		 *
		 * `STALE_ABSENCE` listed `signed`, but that array only fires the other
		 * way — flag true, page saying the thing is absent. The overclaim half
		 * had no entry at all, so when the flag went false because the published
		 * release carries no `SHA256SUMS.txt.sig`, /download, the homepage, and
		 * three more pages went on asserting a signature in the present tense and
		 * this file printed "no problems found".
		 *
		 * /download told visitors every release carries the file and linked them
		 * to the step that says it does not, which is the same failure the flag
		 * was flipped to remove, one page over.
		 *
		 * **Then the entry existed, and still missed the sentence it was written
		 * for.** Three separate holes, each confirmed by substituting the wording
		 * into /download's gaps list, building, and watching this file print "no
		 * problems found":
		 *
		 * 1. The homepage's actual pre-fix wording was "published checksums with a
		 *    signature over them", and the pattern meant to catch it demanded that
		 *    "a signature" follow "checksums" across nothing wider than an
		 *    optional comma and a single space. One interposed word — "with" —
		 *    carried the exact sentence this entry was written for straight past
		 *    it, and no other pattern came close. The two halves now get a short
		 *    run of words between them rather than the one punctuation the first
		 *    draft happened to be looking at.
		 * 2. "The checksum list is signed." failed the build, while "Our checksum
		 *    list is signed." and "This checksum list is signed." both passed. The
		 *    pattern required the literal determiner "the", so its coverage was an
		 *    accident of how /download's sentence happened to start rather than a
		 *    property of the claim, and any rewrite that put a different word in
		 *    front of the noun would have ended it without anyone noticing.
		 * 3. A pattern spelled `checksum list <em>is</em> signed` could not
		 *    fire at all, in any wording, on any page, ever. See the note below.
		 */
		flag: 'signed',
		says: 'the published checksum list carries a signature',
		/*
		 * Assertions about **our** release, not descriptions of the ideal.
		 *
		 * A first draft matched a bare "a signature over that list", which flagged
		 * /scam-clones for the sentence "Ideally a signature over that list too —
		 * ours does not have one yet". That page is right, and gates on the flag;
		 * the tripwire was wrong. A check that cries wolf on correct copy gets
		 * loosened by the next person, so it was narrowed to the claiming forms —
		 * and narrowing was the only lever there was, because the loop had no way
		 * to tell a claim from its denial. It has one now: a hit is rescued when
		 * its own sentence denies or defers it. That is what makes it safe to
		 * widen these back out, and it is why "There is no signature over the
		 * checksum list yet" no longer has to be an unwritable sentence in order
		 * for "The checksum list is signed" to be a catchable one.
		 *
		 * **Never put markup in a pattern here.** The loop replaces every tag with
		 * a space before matching, so by the time a pattern sees the text there is
		 * no `<em>`, no `<strong>` and no `<code>` left in it,
		 * and a word split by a tag has become two words. The deleted first
		 * pattern was `checksum list <em>is</em> signed`, copied out of the
		 * source of /download's flag-true branch, and it could never match the
		 * rendered page: it read like the emphasised wording was covered while the
		 * plain pattern beside it quietly did all the work. Match sentences as the
		 * reader receives them — words and single spaces.
		 */
		patterns: [
			/*
			 * Determiner-independent on purpose. "The", "Our", "This", "That" and
			 * no determiner at all are the same claim to the person reading it.
			 * The honest forms are untouched without needing the sentence window
			 * to rescue them, because "is not signed" and "is unsigned" do not
			 * contain "is signed".
			 */
			/\bchecksum list is signed\b/i,
			/\bsigned checksum list\b/i,
			/\bchecksum list (?:now )?carries (?:a|its own) signature\b/i,
			/ours carries one/i,
			/*
			 * "checksums" and "a signature over them" in one breath, however the
			 * sentence chooses to join the halves: "checksums with a signature
			 * over them", "checksums, and a signature over that list", "checksums
			 * plus a signature over that checksum list". The gap is bounded and
			 * may not contain a full stop, so the two halves have to be one claim
			 * rather than two sentences that happen to sit next to each other.
			 */
			/checksums[^.]{0,24}a signature over (?:them|(?:that|the|this|our) (?:checksum )?list)\b/i,
			/signature over (?:the|that|this|our) checksum list/i,
			/every release carries[^.]{0,40}SHA256SUMS\.txt\.sig/i
		]
	},
	{
		/*
		 * Split from `signed` when the checksum list gained a sigstore
		 * signature. The list being signed does not make the binaries signed,
		 * and one flag covering both would have permitted "signed builds" the
		 * moment `cosign` landed.
		 */
		flag: 'codeSigned',
		says: 'the published binaries are code-signed',
		/*
		 * The last two are here because the first two were not enough.
		 *
		 * /verify carried a step telling people to run `gpg --verify
		 * SHA256SUMS.txt.asc` against a detached signature that the release
		 * workflow does not produce and never has. It never matched a pattern
		 * above, because it did not *claim* releases were signed — it just
		 * instructed the reader to check a signature, which is the same lie told
		 * as a command instead of a sentence, and worse: the reader who follows
		 * it gets "No such file or directory" and has to guess whether that means
		 * the download is bad.
		 *
		 * So the tripwire now also matches the artefacts of signing, not only
		 * assertions about it.
		 */
		patterns: [/signed (?:binaries|installers?|executables?)/i, /releases are signed/i]
	},
	{
		/*
		 * Kept after the checksum list gained a signature, because it gained a
		 * *sigstore* one. Telling a reader to run `gpg --verify` against a `.asc`
		 * nobody publishes is the same lie told as a command, and it is the exact
		 * instruction /verify used to carry.
		 */
		flag: 'gpgSignature',
		says: 'a GPG signature is published',
		patterns: [/gpg\s+--verify/i, /SHA256SUMS\.txt\.asc/i]
	},
	{
		flag: 'published',
		says: 'a build is available',
		patterns: [/download (?:the|our) (?:latest|signed) (?:build|release)/i]
	}
];

/*
 * The same capabilities again, written as bare noun phrases.
 *
 * **The third time this tripwire has been outflanked by grammar.** It was
 * written to catch sentences — "builds are reproducible" — then had to learn
 * instructions, because `gpg --verify` asserted nothing and implied everything.
 * This is the remaining form: a list of nouns. Two pages described the project
 * as "public source, reproducible builds, published checksums" while
 * SITE.release marked both of those false, and every pattern above read straight
 * past them, because nothing in that phrase is a claim in the grammatical sense.
 * It is still a claim to the person reading it, which is the only sense that
 * matters.
 *
 * A bare match cannot be the test, though: half the site legitimately discusses
 * these things precisely to say they are NOT done, and a checker that forbade
 * the words would forbid the honesty as well. So the rule is proximity — the
 * phrase is allowed when a qualifier sits near it, and fails when it is offered
 * as a plain statement of fact.
 */
const UNBUILT_CAPABILITY = [
	{ flag: 'reproducible', phrase: /reproducible builds?/gi },
	{ flag: 'checksums', phrase: /published checksums|checksums (?:are|is) published/gi },
	{ flag: 'codeSigned', phrase: /signed (?:builds?|binaries|installers?)/gi }
];

/**
 * Words that turn a capability into an intention.
 *
 * Deliberately generous. A false negative here is a sentence that was honest
 * anyway; a false positive is a build failure on truthful copy, which teaches
 * whoever hits it to weaken the check.
 */
const QUALIFIER =
	/not yet|not finished|not done|are the goal|is the goal|remains? a goal|arrive with|required before|further out|planned|deferred|will be|when there is|no public release|before the first release|has not|cannot yet|once there is|in the meantime|tracks? (?:where|each)/i;

/** How far either side of the phrase a qualifier may sit and still count. */
const QUALIFIER_WINDOW = 200;

/**
 * A negator that governs the phrase **immediately after it**.
 *
 * QUALIFIER answers a neighbouring but different question: whether a bare noun
 * phrase — "reproducible builds" — is being offered as a plan. It is a
 * vocabulary of intentions, and matching it anywhere in a sentence is right for
 * that. This one has to decide whether a claim a CLAIMS pattern has *already
 * matched* is being denied, and that is a question about attachment, not about
 * vocabulary.
 *
 * **Which is why it reads a few words, not the sentence.** A first version
 * tested a bag of negation words against the whole sentence, and 40% of the
 * sentences on the built site contain one — 48% on /download. Measured, it
 * turned two overclaims this file used to catch into passes: "The checksum list
 * is signed, and the binaries are not code-signed yet." and "The checksum list
 * is signed, and code signing has not landed yet." Both are false about the
 * signature and honest about something else in the same breath, which is
 * exactly the shape a claim-detector exists to separate. A denial that is not
 * next to the claim is a denial of something else.
 */
const CLAIM_DENIAL_BEFORE = /\b(?:no|not|nothing|none|never|without|nor)\b[^.]{0,16}$/i;

/**
 * The other half: futurity attached to the phrase it follows.
 *
 * "a signature over that list **is still to come**" denies the claim it comes
 * after, and no negator sits in front of it to be found by the rule above.
 */
const CLAIM_DENIAL_AFTER =
	/^[^.]{0,16}\b(?:is|are|remains?|stays?)\s+(?:still\s+)?(?:to come|planned|missing|absent|unsigned|not\b)|^[^.]{0,12}\bstill to come\b|^[^.]{0,16}\byet to\b/i;

/** How far either side of a hit a denial has to sit to be about that hit. */
const DENIAL_REACH = 24;

/** Sentence boundary: terminal punctuation followed by whitespace. */
const SENTENCE_BREAK = /[.!?]\s/g;

/**
 * The sentence a hit sits in, clipped to QUALIFIER_WINDOW characters either side.
 *
 * UNBUILT_CAPABILITY gets away with a flat window because the phrases it matches
 * are nouns, and a noun qualified anywhere nearby is usually qualified on
 * purpose. The CLAIMS patterns match the claim itself, so a qualifier outside the
 * sentence is a qualifier about something else — and on /download it demonstrably
 * is. Substituting "The checksum list is signed." into the gaps list on that page
 * puts the code-signing bullet's "It has not been granted yet" 192 characters
 * upstream and the reproducible-builds bullet's "You cannot yet rebuild the tag"
 * just downstream, so a flat 200-character window rescues the exact overclaim
 * this check exists to catch, from two directions at once. Bounding to the
 * sentence is what stops one bullet's honesty from laundering the bullet beside
 * it.
 *
 * A boundary is terminal punctuation followed by whitespace, which is why
 * `SHA256SUMS.txt.sig` does not chop a sentence into three: the dots inside
 * it have no space after them.
 */
const sentenceAround = (words, index, length) => {
	const from = Math.max(0, index - QUALIFIER_WINDOW);
	const to = Math.min(words.length, index + length + QUALIFIER_WINDOW);
	let start = from;
	SENTENCE_BREAK.lastIndex = from;
	let brk;
	while ((brk = SENTENCE_BREAK.exec(words)) !== null && brk.index < index) {
		start = brk.index + brk[0].length;
	}
	SENTENCE_BREAK.lastIndex = index + length;
	const next = SENTENCE_BREAK.exec(words);
	const end = next !== null && next.index < to ? next.index + 1 : to;
	return words.slice(start, end);
};

/**
 * Every match of a CLAIMS pattern on the page, not only the first one.
 *
 * The CLAIMS table is declared without `g` so `exec` cannot carry a
 * `lastIndex` from one page into the next, and that was sufficient while
 * any match at all failed the build. It stopped being sufficient the moment a
 * match could be rescued by its sentence: a page whose first hit is the honest
 * "there is no signature over the checksum list yet" would then hide every
 * overclaim after it, which is the same silent-pass failure this whole file
 * exists to prevent. Rather than making the table global and reintroducing the
 * `lastIndex` bookkeeping that STALE_ABSENCE has to do, the global copy is
 * made here and thrown away as soon as the iteration ends.
 */
const everyMatch = (pattern, words) =>
	words.matchAll(
		new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
	);

/*
 * The same problem pointed the other way: claiming absence after the fact.
 *
 * Everything above guards against saying a capability exists before it does.
 * Nothing guarded the inverse, and the inverse is what actually happened. The
 * day v1.0.0 shipped, `SITE.release.published` flipped to true and the build
 * stayed green while the homepage said "not yet released", /verify opened with
 * "No release exists yet", and the donations page listed installers and
 * checksums as still to come.
 *
 * The asymmetry was not deliberate — it is what you get from writing a checker
 * during a pre-release, when every mistake you can imagine is an overclaim. A
 * project only ever moves through this transition once per capability, which is
 * exactly why nobody notices the missing half until it fires.
 *
 * These phrases are unconditionally wrong when the flag is true. There is no
 * qualifier that rescues "there is no release yet" on a site with a release, so
 * unlike the checks above this one takes no proximity window.
 */
const STALE_ABSENCE = [
	{
		flag: 'published',
		patterns: [
			/no (?:public )?(?:release|build|download)[^.]{0,30}\b(?:yet|exists)/gi,
			/not yet released/gi,
			/there is no (?:release|download|installer|build)/gi,
			/nothing to download/gi,
			/when it exists/gi,
			/once (?:there is|we have) a release/gi,
			/before the first release/gi,
			/*
			 * Anchored to a subject, unlike its neighbours, because "still to
			 * come" on its own is not a claim about the release at all. The bare
			 * form made the phrase unwritable anywhere on the site the day
			 * `published` went true, and it took an honest sentence down with it:
			 * "a signature over that list is still to come" is accurate, is about
			 * a different capability entirely, and failed the build as though it
			 * had said there was no release. What this pattern was written for was
			 * the donations page listing installers as still to come after 1.0
			 * shipped, and that still matches. Checksums are deliberately absent
			 * from the subject list because the entry below already catches
			 * "checksums are still to" against its own flag.
			 *
			 * **It is an allowlist of subjects, so it misses the ones not on it.**
			 * The first draft listed five nouns and silently dropped coverage the
			 * bare pattern had: "The 1.0 packages are still to come." and
			 * "Something you can actually install is still to come." both passed
			 * while `published` was true. Those two are on the list now, and the
			 * shape of the gap is worth knowing before writing the next sentence
			 * about a release — a subject nobody thought of reads as honest here.
			 */
			/(?:releases?|builds?|downloads?|installers?|binaries|packages?|versions?|1\.0|something you can[^.]{0,30})[^.]{0,40}\bstill to come\b/gi
		]
	},
	{
		flag: 'checksums',
		patterns: [/checksums? (?:will|are still to)|no checksums? (?:yet|exist)/gi]
	},
	/*
	 * **The four below exist because the two above were not enough.**
	 *
	 * `signed` went true when the release workflow began signing SHA256SUMS.txt
	 * with cosign, and the homepage went on saying "nothing signs the checksum
	 * list" — two paragraphs under a hero that read the same flag correctly and
	 * said the opposite. A page contradicting itself about its own signatures,
	 * on a site whose entire argument is "verify us rather than trust us", and
	 * the verifier watched it happen: `STALE_ABSENCE` covered `published` and
	 * `checksums` and nothing else, so the one flag that actually flipped was
	 * the one flag nobody was watching.
	 *
	 * Every remaining flag is listed now, whether or not it looks likely to
	 * flip. The cost of an entry that never fires is nothing; the cost of the
	 * missing entry was a live page understating its own security.
	 */
	{
		flag: 'signed',
		patterns: [
			/nothing signs (?:the|that) checksum list/gi,
			/checksum list is (?:un|not )signed/gi,
			/no signature over (?:the|that)/gi,
			/(?:not yet done|still missing)[^.]{0,200}signing (?:the|that) checksum list/gi
		]
	},
	{
		flag: 'codeSigned',
		patterns: [
			/carry no code[- ]signing certificate/gi,
			/(?:are|is) not (?:yet )?code[- ]signed/gi,
			/(?:not yet done|still missing)[^.]{0,200}code[- ]signing certificate for the direct/gi
		]
	},
	{
		flag: 'reproducible',
		patterns: [/builds are not (?:yet )?reproducible/gi, /reproducible builds you could compare/gi]
	},
	{
		flag: 'audited',
		patterns: [
			/no independent audit has happened/gi,
			/(?:not yet done|still missing)[^.]{0,200}an independent audit/gi
		]
	}
];

for (const [slug, html] of built) {
	const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	for (const claim of CLAIMS) {
		if (SITE.release[claim.flag]) {
			continue;
		}
		for (const pattern of claim.patterns) {
			for (const hit of everyMatch(pattern, words)) {
				/*
				 * The sentence the claim stands in, never the paragraph. A claim
				 * denied where it is made is honest copy; the same words with the
				 * denial two bullets away are two different sentences, and only
				 * one of them is true.
				 */
				const sentence = sentenceAround(words, hit.index, hit[0].length);
				/*
				 * Clipped to the sentence first, so a denial cannot reach across a
				 * full stop, and then to a few words either side of the hit, so one
				 * bullet's honesty cannot launder the bullet beside it.
				 */
				const at = hit.index - words.indexOf(sentence);
				const before = sentence.slice(Math.max(0, at - DENIAL_REACH), at);
				const after = sentence.slice(at + hit[0].length);
				if (CLAIM_DENIAL_BEFORE.test(before) || CLAIM_DENIAL_AFTER.test(after)) {
					continue;
				}
				fail(
					slug,
					`states that ${claim.says}, which SITE.release.${claim.flag} says is not true yet — "${hit[0].slice(0, 60)}"`
				);
			}
		}
	}

	for (const { flag, patterns } of STALE_ABSENCE) {
		if (!SITE.release[flag]) {
			continue;
		}
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			const hit = pattern.exec(words);
			if (hit) {
				fail(
					slug,
					`says "${hit[0]}" while SITE.release.${flag} is true — ` +
						'the release happened; this sentence did not notice'
				);
			}
		}
	}

	for (const { flag, phrase } of UNBUILT_CAPABILITY) {
		if (SITE.release[flag]) {
			continue;
		}
		phrase.lastIndex = 0;
		let hit;
		while ((hit = phrase.exec(words)) !== null) {
			const around = words.slice(
				Math.max(0, hit.index - QUALIFIER_WINDOW),
				hit.index + hit[0].length + QUALIFIER_WINDOW
			);
			if (!QUALIFIER.test(around)) {
				fail(
					slug,
					`offers "${hit[0]}" as a present fact, which SITE.release.${flag} says is not true yet — ` +
						'say when it arrives, or drop it'
				);
			}
		}
	}
}

/*
 * A page that sends somebody to SDA must repeat SDA's own warning.
 *
 * The download page recommended it because "it works", omitting the notice at
 * the top of its README: no longer supported, no further updates, and its
 * authors now telling people to use Steam's app instead. Pointing readers at
 * abandoned security software while leaving out its author's warning is the
 * behaviour this domain exists to complain about, and this site was doing it.
 *
 * Keyed on the link rather than on phrasing. The first version of this check
 * looked for "use the original SDA", which the corrected page no longer says —
 * so it matched nothing and passed everything, including the footer that sends
 * every visitor there from all eighteen pages. If a page carries the address,
 * it carries the caveat.
 */
for (const [slug, html] of built) {
	if (!html.includes(SITE.sda.repo) && !html.includes(SITE.sda.releases)) {
		continue;
	}
	const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	if (SITE.sda.unsupported && !words.includes(SITE.sda.notice)) {
		fail(slug, `links people to SDA without saying it is ${SITE.sda.notice}`);
	}
}

/*
 * Every page must be reachable from another page.
 *
 * `/privacy` was not. Not the navigation, not the footer, not one link in the
 * body of any of the twenty-six others — its only appearances anywhere were its
 * own canonical tag and a line in the sitemap. So the page describing what this
 * site keeps, and for how long, could be found by a crawler and by nobody else,
 * including from the support form that collects the very data it describes.
 *
 * The link-target check above is the mirror of this one and had been there from
 * the start: it catches a link pointing at a page that does not exist. Nothing
 * caught a page that exists with nothing pointing at it, which is the same
 * broken relationship seen from the other end.
 *
 * The sitemap deliberately does not count. A page only a search engine can find
 * is not reachable in any sense a reader would recognise.
 */
{
	const linkedTo = new Set();
	for (const [, html] of built) {
		for (const [, href] of html.matchAll(/href="(\/[^"#?]*)"/g)) {
			linkedTo.add(href === '/' ? 'index' : href.slice(1));
		}
	}
	for (const page of PAGES) {
		// 404 is served by nginx on a miss and is deliberately linked from nowhere.
		if (page.slug === 'index' || page.slug === '404') continue;
		if (!linkedTo.has(page.slug)) {
			fail(page.slug, 'exists but nothing links to it — unreachable except through the sitemap');
		}
	}

	/*
	 * And reachable from the home page specifically, not merely from something.
	 *
	 * The check above asks whether any page links to this one, which two new
	 * pages satisfied by linking to each other. They were a perfectly connected
	 * island: every internal link resolved, nothing was orphaned by the rule as
	 * written, and a crawler starting at the front door could reach neither.
	 *
	 * That is the shape the rule was meant to catch and did not, so it now walks
	 * outward from `index` the way a crawler does rather than counting inbound
	 * links.
	 */
	const reachable = new Set();
	const queue = ['index'];
	while (queue.length > 0) {
		const slug = queue.pop();
		if (slug === undefined || reachable.has(slug)) continue;
		const html = built.get(slug);
		if (html === undefined) continue;
		reachable.add(slug);
		for (const [, href] of html.matchAll(/href="(\/[^"#?]*)"/g)) {
			queue.push(href === '/' ? 'index' : href.slice(1));
		}
	}
	for (const page of PAGES) {
		if (page.slug === 'index' || page.slug === '404') continue;
		if (!reachable.has(page.slug)) {
			fail(page.slug, 'cannot be reached by following links from the home page');
		}
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
	/*
	 * Cloudflare Web Analytics is an intentional edge transformation.
	 *
	 * It is not in site/dist: Cloudflare inserts the tag after nginx has served
	 * the built page, and it skips clients that do not resemble browsers. The
	 * old verifier used Node's default user agent, therefore sometimes compared
	 * the unmodified response and reported a clean site while every visitor got
	 * another script. Ask for the page the way a browser does, validate the one
	 * transformation we permit, then remove only that tag for the byte comparison.
	 */
	const BROWSER_HEADERS = {
		accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
		'accept-language': 'en-US,en;q=0.9',
		'user-agent':
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
			'(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
	};
	const CLOUDFLARE_BEACON_TAG =
		/<script\b(?=[^>]*\bsrc="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^"\s]+")(?=[^>]*\btype="module")(?=[^>]*\bintegrity="sha512-[^"]+")(?=[^>]*\bdata-cf-beacon='[^']+')(?=[^>]*\bcrossorigin="anonymous")[^>]*><\/script>\r?\n?/g;
	let checked = 0;

	for (const page of PAGES) {
		if (page.slug === '404') continue;
		const path = page.slug === 'index' ? '/' : `/${page.slug}`;
		let response;
		try {
			response = await fetch(`${origin}${path}`, {
				redirect: 'manual',
				headers: BROWSER_HEADERS
			});
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
		const csp = response.headers.get('content-security-policy') ?? '';
		const scriptSources = /(?:^|;)\s*script-src\s+([^;]+)/.exec(csp)?.[1] ?? '';
		if (!scriptSources.includes('https://static.cloudflareinsights.com')) {
			fail(path, 'CSP does not permit the disclosed Cloudflare Web Analytics script');
		}
		if (response.headers.get('server')?.match(/\d/)) {
			fail(path, `leaks a version in the Server header: ${response.headers.get('server')}`);
		}
		const body = await response.text();
		const beaconTags = body.match(CLOUDFLARE_BEACON_TAG) ?? [];
		if (beaconTags.length !== 1) {
			fail(
				path,
				`has ${beaconTags.length} valid Cloudflare Web Analytics beacon tags, expected exactly 1`
			);
		}
		const comparableBody = body.replace(CLOUDFLARE_BEACON_TAG, '');
		if (comparableBody !== built.get(page.slug)) {
			// Name the cause when we recognise it. Cloudflare's Email Address
			// Obfuscation rewrites any plain-text address in HTML and injects a
			// decoder script — on a site that ships none, and leaving the address
			// unreadable to anyone without JavaScript, which for a security contact
			// is the wrong audience to exclude. Turn it off under
			// Scrape Shield → Email Address Obfuscation.
			if (/__cf_email__|email-decode\.min\.js/.test(comparableBody)) {
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
