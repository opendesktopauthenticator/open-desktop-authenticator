/**
 * Every icon the web asks for, generated from the application's own mark.
 *
 * ## Why this exists
 *
 * The site declared two icons: an SVG and a 512px PNG. Everything else a
 * browser asks for on its own — `/favicon.ico` above all — returned 404, so
 * tabs, bookmarks and shortcuts fell back to the generic default. Browsers
 * cache that miss, which is why the wrong icon persists long after the right
 * one is published.
 *
 * ## Two kinds of icon, and why they differ
 *
 * **Transparent.** Favicons sit on a tab strip whose colour the browser
 * chooses, and which changes with the user's theme. A background baked into the
 * image would be a coloured rectangle in a grey tab bar.
 *
 * **Plated.** iOS and Android composite the icon onto their own surface and
 * ignore transparency — iOS fills it black, Android crops it to whatever shape
 * the launcher uses. Those get the mark drawn on the brand background with a
 * margin: for the maskable variant the margin is 20%, because Android's crop
 * can take everything outside the central circle and a shield drawn to the
 * edges loses its point and shoulders.
 *
 * ## Why some names cannot be fingerprinted
 *
 * `/favicon.ico`, `/apple-touch-icon.png` and `/site.webmanifest` are requested
 * at fixed paths that no HTML controls, so a content hash cannot be put in
 * them. They are served with a short revalidating cache instead of the
 * `immutable` used for hashed assets — which is precisely what lets a changed
 * mark replace a cached one.
 */

import { rgbaOf, coverage, colourAt, shieldSvgPath, DESIGN } from '../src/shared/logo.ts';
import { encodePng } from '../src/main/png.ts';
import { encodeIco } from '../tools/raster.mjs';

/** The brand background, for the platforms that refuse transparency. */
const PLATE = [0x07, 0x0a, 0x0e];

/** The mark at `size`, transparent, filling the square. */
const mark = (size) => Buffer.from(rgbaOf(size));

/**
 * The mark on an opaque brand plate, inset by `margin` (0–0.5 of the width).
 *
 * Rendered at the inner size and copied into the middle rather than scaled, so
 * the shield is rasterised at its true resolution instead of being resampled.
 */
function plate(size, margin) {
	const inner = Math.max(1, Math.round(size * (1 - margin * 2)));
	const offset = Math.round((size - inner) / 2);
	const art = rgbaOf(inner);
	const out = Buffer.alloc(size * size * 4);

	for (let i = 0; i < size * size; i++) {
		out[i * 4] = PLATE[0];
		out[i * 4 + 1] = PLATE[1];
		out[i * 4 + 2] = PLATE[2];
		out[i * 4 + 3] = 255;
	}
	for (let y = 0; y < inner; y++) {
		for (let x = 0; x < inner; x++) {
			const s = (y * inner + x) * 4;
			const alpha = art[s + 3] / 255;
			if (alpha === 0) {
				continue;
			}
			const d = ((y + offset) * size + (x + offset)) * 4;
			// Straight alpha over the plate.
			out[d] = Math.round(art[s] * alpha + PLATE[0] * (1 - alpha));
			out[d + 1] = Math.round(art[s + 1] * alpha + PLATE[1] * (1 - alpha));
			out[d + 2] = Math.round(art[s + 2] * alpha + PLATE[2] * (1 - alpha));
			out[d + 3] = 255;
		}
	}
	return out;
}

/**
 * Safari's pinned-tab icon: one path, no colour, no gradient.
 *
 * Safari fills it with a colour the user picks, so anything else in the file is
 * discarded. Built from the same path as everything else.
 */
const maskIcon = () =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN} ${DESIGN}">` +
			`<path fill-rule="evenodd" d="${shieldSvgPath()}"/></svg>\n`,
		'utf8'
	);

/** The full-colour vector, for the `rel="icon"` every modern browser prefers. */
function markSvg(colours) {
	const top = colourAt(DESIGN, 0);
	const bottom = colourAt(DESIGN, DESIGN - 1);
	void colours;
	void coverage;
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN} ${DESIGN}" role="img" aria-label="Open Desktop Authenticator">` +
			`<defs><linearGradient id="m" x1="0" y1="118" x2="0" y2="946" gradientUnits="userSpaceOnUse">` +
			`<stop offset="0" stop-color="rgb(${top.join(',')})"/>` +
			`<stop offset="1" stop-color="rgb(${bottom.join(',')})"/></linearGradient></defs>` +
			`<path fill="url(#m)" fill-rule="evenodd" d="${shieldSvgPath()}"/></svg>\n`,
		'utf8'
	);
}

/**
 * Files served from the site root, at names browsers hardcode.
 *
 * These cannot carry a content hash, because nothing in our HTML names them.
 */
export function rootIcons() {
	return new Map([
		// Classic multi-size ICO. Still the only thing some contexts look for, and
		// the 404 on this path was the whole reason tabs showed a blank page icon.
		['favicon.ico', encodeIco([16, 32, 48].map((size) => ({ size, rgba: mark(size) })))],
		// iOS home screen. 180 is the size current devices ask for, and it is
		// plated because iOS composites transparency onto black.
		['apple-touch-icon.png', encodePng(180, plate(180, 0.12))],
		// Older iOS asks for this exact name before falling back.
		['apple-touch-icon-precomposed.png', encodePng(180, plate(180, 0.12))]
	]);
}

/** Files referenced from our own HTML, so they can be content-hashed. */
export function hashedIcons() {
	return new Map([
		['icon.svg', markSvg()],
		['mask-icon.svg', maskIcon()],
		['favicon-16.png', encodePng(16, mark(16))],
		['favicon-32.png', encodePng(32, mark(32))],
		['favicon-48.png', encodePng(48, mark(48))],
		['favicon-96.png', encodePng(96, mark(96))],
		['icon-192.png', encodePng(192, plate(192, 0.1))],
		['icon-512.png', encodePng(512, plate(512, 0.1))],
		// Android adaptive icons are cropped to the launcher's shape. The safe
		// zone is the central 80%, so the mark is inset by 20% on every side.
		['icon-maskable-512.png', encodePng(512, plate(512, 0.2))],
		// Windows pinned tile.
		['mstile-150.png', encodePng(150, plate(150, 0.14))],
		// Social preview. Plated, because most platforms put it on white.
		['og-512.png', encodePng(512, plate(512, 0.12))]
	]);
}

/** The web app manifest, pointing at the hashed icon names. */
export function manifest(site, resolve) {
	return Buffer.from(
		JSON.stringify(
			{
				name: site.name,
				short_name: site.short,
				description: site.tagline,
				start_url: '/',
				scope: '/',
				display: 'standalone',
				background_color: '#070a0e',
				theme_color: '#070a0e',
				icons: [
					{ src: resolve('icon-192.png'), sizes: '192x192', type: 'image/png' },
					{ src: resolve('icon-512.png'), sizes: '512x512', type: 'image/png' },
					{
						src: resolve('icon-maskable-512.png'),
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			null,
			'\t'
		) + '\n',
		'utf8'
	);
}
