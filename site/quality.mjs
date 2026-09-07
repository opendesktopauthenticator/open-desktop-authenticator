/**
 * Side-effect-free helpers used by the site publication checks.
 *
 * Keeping these separate from verify.mjs makes the rules unit-testable without
 * running a full site audit merely because a test imported one function.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PUBLICATION_TIME_ZONE = 'Asia/Karachi';

const dateInPublicationTimeZone = (date) => {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone: PUBLICATION_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(date);
	const part = (type) => parts.find((entry) => entry.type === type)?.value;
	return `${part('year')}-${part('month')}-${part('day')}`;
};

/** Return the reason a publication date is invalid, or null when it is sound. */
export function calendarDateProblem(value, now = new Date()) {
	if (typeof value !== 'string' || !ISO_DATE.test(value)) {
		return 'must be an explicit YYYY-MM-DD date';
	}

	const parsed = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
		return 'is not a real calendar date';
	}

	if (value > dateInPublicationTimeZone(now)) {
		return 'is in the future';
	}

	return null;
}

/** The one human-readable form used beside machine-readable publication dates. */
export function formatPublicationDate(iso) {
	return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
}

const visibleText = (html) =>
	html
		.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&(?:[a-z]+|#\d+|#x[a-f\d]+);/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** Return the reason a guide's source note is not usable evidence. */
export function sourceNoteProblem(source) {
	if (typeof source !== 'string' || visibleText(source).length < 30) {
		return 'must contain at least 30 visible characters';
	}
	if (/<!--/.test(source)) return 'must not hide evidence in an HTML comment';

	for (const [, tag] of source.matchAll(/<\/?([a-z][a-z\d-]*)\b[^>]*>/gi)) {
		if (tag.toLowerCase() !== 'a') {
			return `uses unsupported evidence-note markup: <${tag.toLowerCase()}>`;
		}
	}

	const anchors = [...source.matchAll(/<a\b[^>]*\bhref=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)];
	if (anchors.length === 0) return 'must link its evidence';

	for (const [anchor, , href, label] of anchors) {
		if (visibleText(label).length === 0) return 'has an evidence link with no visible label';
		const openingTag = /^<a\b[^>]*>/i.exec(anchor)?.[0] ?? '';
		if (/\s(?:hidden|style|class|aria-hidden)(?:\s|=|>)/i.test(openingTag)) {
			return 'must not hide or restyle an evidence link';
		}
		if (!/^https:\/\//i.test(href)) {
			return `must use a public HTTPS evidence link, not ${href || '(empty)'}`;
		}
		let url;
		try {
			url = new URL(href);
		} catch {
			return `has a malformed evidence link: ${href || '(empty)'}`;
		}
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
		const placeholderHost =
			host === 'localhost' ||
			host.endsWith('.localhost') ||
			host === 'example.com' ||
			host === 'example.net' ||
			host === 'example.org' ||
			/\.(?:example|invalid|test)$/.test(host);
		const octets = host.split('.').map(Number);
		const privateIpv4 =
			octets.length === 4 &&
			octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
			(octets[0] === 0 ||
				octets[0] === 10 ||
				octets[0] === 127 ||
				(octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
				(octets[0] === 169 && octets[1] === 254) ||
				(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
				(octets[0] === 192 && octets[1] === 168) ||
				octets[0] >= 224);
		const privateIpv6 =
			host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
		if (!host || url.username || url.password || placeholderHost || privateIpv4 || privateIpv6) {
			return `must use a public HTTPS evidence link, not ${href}`;
		}
	}

	return null;
}

/** The authored article, without the site-wide shell. */
export function articleOf(html) {
	const match = /<article(?:\s[^>]*)?>[\s\S]*?<\/article>/i.exec(html);
	return match?.[0] ?? '';
}

const withoutClassBlock = (html, tag, className) =>
	html.replace(
		new RegExp(
			`<${tag}\\b(?=[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'])[^>]*>[\\s\\S]*?<\\/${tag}>`,
			'gi'
		),
		' '
	);

/**
 * A page's own answer, excluding generated or repeated publication furniture.
 *
 * Review prompts, source/byline rows, contents lists, and heading-link glyphs
 * are useful navigation. They must not help a page clear the substance or
 * similarity gates, and they must not satisfy an editorial proof marker.
 */
export function editorialBodyOf(html) {
	let body = articleOf(html);
	body = body.replace(/<!--[\s\S]*?-->/g, ' ');
	for (const tag of ['script', 'style', 'template', 'noscript']) {
		body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
	}
	body = body
		.replace(/<([a-z][a-z\d-]*)\b(?=[^>]*\bhidden(?:\s|=|>))[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(
			/<([a-z][a-z\d-]*)\b(?=[^>]*\baria-hidden\s*=\s*["']true["'])[^>]*>[\s\S]*?<\/\1>/gi,
			' '
		)
		.replace(
			/<([a-z][a-z\d-]*)\b(?=[^>]*\bstyle=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi,
			' '
		);
	body = withoutClassBlock(body, 'aside', 'ask');
	body = withoutClassBlock(body, 'div', 'guide-meta');
	body = withoutClassBlock(body, 'nav', 'jump');
	return body.replace(
		/<a\b(?=[^>]*\bclass=["'][^"']*\banchor\b[^"']*["'])[^>]*>[\s\S]*?<\/a>/gi,
		' '
	);
}

export const SHINGLE_SIZE = 6;
export const JACCARD_LIMIT = 0.3;
export const CONTAINMENT_LIMIT = 0.65;

/** Exact, normalized runs of words used for mechanical overlap checks. */
export function shingles(text, size = SHINGLE_SIZE) {
	const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
	const out = new Set();
	for (let i = 0; i + size <= words.length; i++) {
		out.add(words.slice(i, i + size).join(' '));
	}
	return out;
}

/** Jaccard catches peers; containment catches a short article copied into a long one. */
export function overlapScores(a, b) {
	let shared = 0;
	for (const run of a) if (b.has(run)) shared += 1;
	const union = a.size + b.size - shared;
	const smaller = Math.min(a.size, b.size);
	return {
		jaccard: union === 0 ? 0 : shared / union,
		containment: smaller === 0 ? 0 : shared / smaller
	};
}
