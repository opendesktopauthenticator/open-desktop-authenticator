import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The page and the header have to agree, and nothing said so.**
 *
 * Every third-party script the site loads is named twice: once in the HTML the
 * builder emits, and once in the `script-src` list nginx sends. Adding one to
 * either side alone produces the worst kind of failure — the browser refuses
 * the request, the feature is simply absent, and the page looks fine. Nobody
 * finds it except by opening a console on the deployed site.
 *
 * The Trustpilot review widget needs *two* directives for that reason:
 * `script-src` for the loader, and `frame-src` for the box, which is rendered
 * in an iframe from the same host. With only the first, the loader runs, does
 * its work, and the widget is invisible — one directive short of a review
 * collector that collects nothing.
 *
 * Read as text on both sides. Importing the builder would write the whole site
 * as a side effect, and reading `site/dist` would tie this to an artifact that
 * does not exist on a clean checkout — both of which this suite has already
 * been bitten by once each.
 */

const ROOT = join(__dirname, '..');

const builder = readFileSync(join(ROOT, 'site', 'build.mjs'), 'utf8');
const headers = readFileSync(
	join(ROOT, 'infra', 'nginx', 'snippets', 'security-headers.conf'),
	'utf8'
);

/** The CSP line nginx actually sends. */
const csp = /add_header Content-Security-Policy\s+"([^"]+)"/.exec(headers)?.[1] ?? '';

/** One directive's source list, as a set of hosts. */
function directive(name: string): string[] {
	const found = new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`).exec(csp)?.[1];
	return found === undefined ? [] : found.trim().split(/\s+/);
}

/** Every external origin the built pages ask for a script from. */
function scriptOrigins(): string[] {
	const origins = new Set<string>();
	for (const match of builder.matchAll(/<script[^>]+src="(https:\/\/[^"$]+)/g)) {
		origins.add(new URL(match[1] ?? '').origin);
	}
	// The loader is referenced through the config rather than inline, so take the
	// origins the config states as well.
	for (const match of builder.matchAll(/origin:\s*'(https:\/\/[^']+)'/g)) {
		origins.add(match[1] ?? '');
	}
	/*
	 * The site's own origin is one of those, and `'self'` already covers it —
	 * listing it in `script-src` would be noise, and failing this check over it
	 * would be a guard complaining about the thing working correctly.
	 */
	const own = /origin:\s*'(https:\/\/(?:www\.)?opendesktopauthenticator\.com)'/.exec(builder)?.[1];
	if (own !== undefined) {
		origins.delete(own);
	}
	return [...origins];
}

describe('the content security policy and the pages it protects', () => {
	it('names a policy at all, so the checks below are not reading an empty string', () => {
		expect(csp, 'no Content-Security-Policy header was found in the nginx snippet').not.toBe('');
		expect(directive('script-src').length).toBeGreaterThan(0);
	});

	it('permits every third-party script the pages load', () => {
		const allowed = directive('script-src');
		const refused = scriptOrigins().filter((origin) => !allowed.includes(origin));

		expect(
			refused,
			'the built HTML asks for these and the policy refuses them, so the feature is silently ' +
				'absent on the deployed site and present on every developer machine'
		).toEqual([]);
	});

	/**
	 * The widget renders in an iframe, and `frame-src` has no fallback to
	 * `script-src` — it falls back to `default-src`, which is `'self'`. Allowing
	 * the loader and forgetting the frame is a review collector that loads and
	 * shows nothing.
	 */
	it('permits the review widget to render its frame', () => {
		const widget = /origin:\s*'(https:\/\/widget\.trustpilot\.com)'/.exec(builder)?.[1];
		if (widget === undefined) {
			expect.fail('the review widget origin is no longer declared, so this asserts nothing');
		}

		expect(
			directive('frame-src'),
			'the loader is allowed and the frame is not, so the widget runs and renders nothing — ' +
				'and a refused frame says nothing in the page'
		).toContain(widget);
	});

	/* And the policy has not quietly grown a wildcard while nobody looked. */
	it('does not allow scripts from anywhere', () => {
		expect(directive('script-src')).not.toContain('*');
		expect(csp).not.toContain("'unsafe-inline'");
		expect(csp).not.toContain("'unsafe-eval'");
	});
});

/**
 * **A page that loads a third party has to be a page that says so.**
 *
 * The loader went onto all thirty-two pages while seven carried a widget —
 * including `/privacy`, which lists every third party this site talks to and
 * ends that list with "Nobody else". A page cannot both load Trustpilot and
 * say nobody else is involved.
 *
 * Read from the builder's source rather than from `site/dist`, for the reason
 * the file above already gives: the build does not exist on a clean checkout.
 */
describe('where the review loader is allowed to go', () => {
	it('is conditional rather than on every page', () => {
		const loader = /\$\{([^}]*)\?\s*`<script async src="\$\{SITE\.reviews\.widget\.script\}"/.exec(
			builder
		);

		expect(
			loader,
			'the Trustpilot loader is emitted unconditionally, so it ships to every page including ' +
				'the ones that carry no widget and the one that promises nobody else is involved'
		).not.toBeNull();
	});

	it('is decided by what the page actually renders', () => {
		expect(
			builder,
			'the condition is a flag somebody has to remember rather than the rendered body, which ' +
				'is how it drifts from what the page really contains'
		).toContain("body.includes('trustpilot-widget')");
	});

	/* And the page that promises to name every third party names this one. */
	it('is disclosed on the privacy page', () => {
		const privacy = readFileSync(join(ROOT, 'site', 'pages', 'privacy.mjs'), 'utf8');

		expect(
			privacy,
			'the site loads Trustpilot and the page that lists every third party it talks to does ' +
				'not mention it'
		).toContain('Trustpilot');
	});

	/**
	 * **Including in the summary somebody actually reads.**
	 *
	 * The check above passed on a `<dd>` far down the page while the lede — the
	 * one paragraph most readers stop at — still enumerated "server logs,
	 * Cloudflare and Google Analytics" and nothing else. A page can name a third
	 * party six times below the fold and still tell its readers the wrong list.
	 */
	it('is in the summary at the top, not only in the table below it', () => {
		const privacy = readFileSync(join(ROOT, 'site', 'pages', 'privacy.mjs'), 'utf8');
		const lede = /class="lede">([\s\S]*?)<\/p>/.exec(privacy)?.[1] ?? '';

		expect(lede, 'no lede was found, so this measured nothing').not.toBe('');
		expect(
			lede,
			'the summary paragraph still lists the providers from before Trustpilot was added'
		).toContain('Trustpilot');
	});

	/**
	 * **And the page titled "What this site stores" says what it stores.**
	 *
	 * The download page keeps two flags in the reader's own browser so it can ask
	 * for a review once and then stop. They were added without a word on the page
	 * whose entire subject is what gets kept.
	 */
	it('names the browser storage the download page keeps', () => {
		const privacy = readFileSync(join(ROOT, 'site', 'pages', 'privacy.mjs'), 'utf8');
		const download = readFileSync(join(ROOT, 'site', 'assets', 'download.js'), 'utf8');

		const keys = [...download.matchAll(/'(oda\.[a-z.-]+)'/g)].map((match) => match[1]);
		expect(
			keys.length,
			'the download script keeps no storage keys, so this asserts nothing'
		).toBeGreaterThan(0);

		const undisclosed = keys.filter((key) => key !== undefined && !privacy.includes(key));
		expect(
			undisclosed,
			'these are written to the reader browser and the page about what this site stores does ' +
				'not mention them'
		).toEqual([]);
	});

	/*
	 * And the other direction, which is the one that actually went wrong.
	 *
	 * The check above only asks that every key the script writes is disclosed. It is
	 * satisfied by a privacy page that describes *more* storage than exists — so when
	 * the download prompt was rewritten and `oda.review-prompt.started` stopped being
	 * written, the page went on telling readers it was stored, and nothing failed.
	 *
	 * An over-disclosure is a smaller harm than an under-disclosure but it is still a
	 * false statement on the one page whose entire subject is what this site keeps,
	 * and a reader who goes looking for the key to clear it will not find it.
	 */
	it('describes no browser storage that the download page does not keep', () => {
		const privacy = readFileSync(join(ROOT, 'site', 'pages', 'privacy.mjs'), 'utf8');
		const download = readFileSync(join(ROOT, 'site', 'assets', 'download.js'), 'utf8');

		const described = [...privacy.matchAll(/<code>(oda\.[a-z.-]+)<\/code>/g)].map(
			(match) => match[1]
		);
		expect(
			described.length,
			'the privacy page names no storage keys, so this asserts nothing'
		).toBeGreaterThan(0);

		const imaginary = described.filter((key) => key !== undefined && !download.includes(key));
		expect(
			imaginary,
			'the page about what this site stores describes keys the download script never ' +
				'writes, so a reader is told about storage that does not exist'
		).toEqual([]);
	});
});
