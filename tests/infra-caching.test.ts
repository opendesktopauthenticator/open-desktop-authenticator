import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the edge is allowed to keep.
 *
 * HTML is now cacheable by shared caches, which is the difference between a
 * reader waiting for Germany on every page and not. That is only safe while the
 * routes carrying somebody's support thread, their attachments and the admin
 * queue are excluded — and "they are in a different location block" is a fact
 * about a file nobody re-reads, not a guarantee.
 *
 * So the guarantee is asserted here instead. A future edit that adds a
 * cacheable header to those routes, or removes their `no-store`, fails.
 */

const CONFIG = readFileSync(
	join(__dirname, '..', 'infra', 'nginx', 'sites-available', 'oda'),
	'utf8'
);

/** Where the HTTPS server begins — everything before it only redirects. */
const SERVING = CONFIG.indexOf('location = /index.html { return 301 /; }');

/**
 * The body of one `location` block, by the pattern that opens it.
 *
 * `from` disambiguates. There are two `location / {` blocks — the first belongs
 * to the HTTP server that does nothing but redirect to HTTPS, and matching it
 * instead of the one that serves pages is how this test first reported the
 * config as broken when it was not.
 */
function block(opening: string, from = 0): string {
	const start = CONFIG.indexOf(opening, from);
	expect(start, `no location block matching ${opening}`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = start; i < CONFIG.length; i++) {
		if (CONFIG[i] === '{') depth++;
		if (CONFIG[i] === '}') {
			depth--;
			if (depth === 0) return CONFIG.slice(start, i + 1);
		}
	}
	throw new Error(`unterminated block for ${opening}`);
}

describe('what a shared cache may keep', () => {
	it('never lets the ticket service or admin be cached', () => {
		const priv = block('location ~ ^/(support/submit|support/ticket/|admin)');
		expect(priv).toContain('no-store');
		expect(priv).not.toMatch(/s-maxage/);
		expect(priv).not.toMatch(/Cache-Control\s+"public/);
	});

	it('hides whatever Cache-Control the ticket service sends', () => {
		// Otherwise the upstream header and ours both arrive, and which one a
		// cache honours stops being something this file decides.
		expect(block('location ~ ^/(support/submit|support/ticket/|admin)')).toContain(
			'proxy_hide_header Cache-Control'
		);
	});

	it('lets the edge hold HTML but never the browser', () => {
		const html = block('location / {', SERVING);
		// The browser is still told to revalidate every time, so a correction is
		// never served stale from somebody's disk.
		expect(html).toMatch(/Cache-Control "no-cache"/);
		// The edge is told separately, in a header browsers ignore.
		expect(html).toMatch(/CDN-Cache-Control "public, max-age=\d+/);
		expect(html).toMatch(/stale-while-revalidate=\d+/);
	});

	/*
	 * The trap this replaced.
	 *
	 * A single `Cache-Control: public, max-age=0, s-maxage=300` reads as "browsers
	 * revalidate, shared caches hold it for five minutes" and is what was shipped
	 * first. Cloudflare's documented behaviour is that `max-age=0` makes a
	 * response uncacheable outright, s-maxage or not, so the edge went on
	 * answering DYNAMIC and the change did nothing at all.
	 */
	it('never puts max-age=0 in Cache-Control, which stops Cloudflare caching', () => {
		const html = block('location / {', SERVING);
		expect(html).not.toMatch(/Cache-Control "[^"]*max-age=0/);
	});

	it('keeps hashed assets immutable', () => {
		// These can be cached hard precisely because a change is a new filename.
		expect(block('location /assets/')).toContain('immutable');
	});

	/*
	 * An `add_header` anywhere in a location discards every one inherited from
	 * the server block. Both blocks touched here set one, so both have to
	 * re-include the security headers or they silently lose the CSP — which has
	 * happened once already on this file.
	 */
	it('re-includes the security headers wherever a header is set', () => {
		for (const opening of [
			'location / {',
			'location /assets/',
			'location ~ ^/(favicon\\.ico|apple-touch-icon(-precomposed)?\\.png|site\\.webmanifest)$'
		]) {
			expect(block(opening, SERVING), opening).toContain('include snippets/security-headers.conf');
		}
	});
});
