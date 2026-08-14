/*
 * Guide furniture, generated rather than hand-maintained.
 *
 * The alternative was writing an id on every heading and a contents list at the
 * top of every guide by hand. Both drift: a heading gets reworded, its anchor
 * keeps the old wording, and the contents list quietly points at nothing. So
 * the ids, the anchor links and the jump list are all derived from the headings
 * that are actually in the page at build time, which makes them correct by
 * construction and free to add to a new guide.
 */

/** A heading's text, minus any markup inside it, as a URL fragment. */
const slugify = (html) =>
	html
		.replace(/<[^>]+>/g, '')
		.replace(/&[a-z]+;|&#\d+;/gi, ' ')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);

/**
 * Give every h2 and h3 in an article a stable id and a hover anchor.
 *
 * Only headings that do not already carry an id are touched, so a page can
 * still pin an anchor by hand where an incoming link depends on it. Duplicate
 * slugs get a numeric suffix rather than silently colliding — two headings with
 * the same id means one of them is unreachable.
 */
export function anchorHeadings(html) {
	const seen = new Map();
	return html.replace(/<(h[23])>([\s\S]*?)<\/\1>/g, (whole, tag, inner) => {
		let id = slugify(inner);
		if (!id) return whole;
		if (seen.has(id)) {
			const n = seen.get(id) + 1;
			seen.set(id, n);
			id = `${id}-${n}`;
		} else {
			seen.set(id, 1);
		}
		const anchor = `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`;
		return `<${tag} id="${id}">${inner}${anchor}</${tag}>`;
	});
}

/** Reading time, rounded up, from the visible words of the article. */
export function readingMinutes(html) {
	const words = html
		.replace(/<[^>]+>/g, ' ')
		.split(/\s+/)
		.filter(Boolean).length;
	return Math.max(1, Math.round(words / 230));
}

/**
 * The byline row under the h1.
 *
 * "Last reviewed" already existed at the foot of every page, which is where a
 * reader looks last and a search engine weighs least. On a security guide the
 * date is part of the claim — advice about Steam's current setup flow is worth
 * knowing the age of — so it moves to the top, next to how long the page takes
 * and what it is sourced from.
 */
export function guideMeta(iso, formatted, minutes) {
	return `		<div class="guide-meta">
			<span>Reviewed <time datetime="${iso}">${formatted}</time></span>
			<span class="dot" aria-hidden="true"></span>
			<span>${minutes} min read</span>
			<span class="dot" aria-hidden="true"></span>
			<span class="sourced">Checked against Valve's own documentation</span>
		</div>`;
}

/**
 * A contents list built from the h2s the page actually has.
 *
 * Placed immediately before the first h2, which puts it after the short answer
 * and any warning — the reader gets the fix, then the shape of the page, then
 * the detail. Skipped for pages with fewer than three sections, where a
 * contents list is furniture for its own sake.
 */
export function jumpList(html) {
	const items = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(([, id, inner]) => ({
		id,
		text: inner.replace(/<a class="anchor"[\s\S]*?<\/a>/, '').replace(/<[^>]+>/g, '')
	}));
	if (items.length < 3) return html;

	const list = `		<nav class="jump" aria-label="On this page">
			<p>On this page</p>
			<ul>
${items.map((i) => `				<li><a href="#${i.id}">${i.text}</a></li>`).join('\n')}
			</ul>
		</nav>
`;
	return html.replace(/(\n[ \t]*<h2 id=)/, `\n${list}$1`);
}
