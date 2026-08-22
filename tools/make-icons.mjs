/**
 * Generates every icon the application ships, from `icon-art.mjs`.
 *
 *     node tools/make-icons.mjs
 *
 * The outputs are committed, so building the app never needs this to have been
 * run — it exists so the artwork can be changed by editing geometry rather than
 * by opening twenty files in an image editor and getting nineteen of them right.
 *
 * What Windows actually asks for, and why each one is here:
 *
 *  - `icon.ico` — the executable, the taskbar, Alt-Tab, the shortcut, the
 *    Programs list. Ten sizes, because Windows picks the nearest and scales the
 *    rest; leaving 20, 40 and 96 out is what makes an icon look soft at 125%,
 *    150% and 200% display scaling, which is most laptops.
 *  - `tray.ico` and the tray PNGs — the notification area, which is the one
 *    place this app is expected to live while it is doing its job. Sized for the
 *    same four scale factors.
 *  - `installerSidebar.bmp` / `installerHeader.bmp` — NSIS will not take a PNG
 *    for these two and 24-bit BMP has no alpha, so they are composited here.
 *  - `icon.png` at 1024 and the PNG set — Linux packaging, and the source
 *    electron-builder resamples from for macOS.
 *  - `icon.svg` — the canonical vector, for the readme, the site, and anywhere
 *    a raster would be the wrong answer.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Imported straight from the application's own source. Node strips the types;
// there is no build step here, and no second copy of the artwork.
import { COLOURS, DESIGN, EXTENT, rgbaOf, shieldSvgPath } from '../src/shared/logo.ts';
import { encodeBmp24, encodeIco, encodePng } from './raster.mjs';

/**
 * Where the files land. `build/` normally; `ICON_OUTPUT_DIR` lets
 * `tests/icons.test.ts` regenerate into a scratch tree and compare, rather than
 * overwriting the very files it is trying to check.
 */
const out =
	process.env.ICON_OUTPUT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

/** Straight RGBA for the mark at `size`, drawn to fill the square. */
const render = (size) => Buffer.from(rgbaOf(size));

/**
 * The same mark inset into a larger square.
 *
 * Used for the installer's side panel, where the art is a decoration on a field
 * of colour rather than an icon filling its box.
 */
function renderInto(width, height, markSize, offsetX, offsetY) {
	const mark = render(markSize);
	const canvas = Buffer.alloc(width * height * 4);
	for (let row = 0; row < markSize; row++) {
		const y = row + offsetY;
		if (y < 0 || y >= height) {
			continue;
		}
		for (let col = 0; col < markSize; col++) {
			const x = col + offsetX;
			if (x < 0 || x >= width) {
				continue;
			}
			mark.copy(
				canvas,
				(y * width + x) * 4,
				(row * markSize + col) * 4,
				(row * markSize + col) * 4 + 4
			);
		}
	}
	return canvas;
}

/** Every size that goes into the application icon. The awkward ones — 20, 40,
 *  96 — are the display-scaling sizes, and the reason to include them is that
 *  Windows scales a neighbour when they are missing. */
const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
/** Windows draws the notification area at these four across 100–200% scaling. */
const TRAY_SIZES = [16, 20, 24, 32];
/** Everything else: Linux hicolor, and the source macOS is resampled from. */
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const written = [];
function emit(relative, bytes) {
	const path = join(out, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	written.push([relative, bytes.length]);
}

mkdirSync(out, { recursive: true });

// The vector original.
emit(
	'icon.svg',
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN} ${DESIGN}" width="${DESIGN}" height="${DESIGN}" role="img" aria-label="Open Desktop Authenticator">\n` +
			`\t<title>Open Desktop Authenticator</title>\n` +
			`\t<defs>\n\t\t<linearGradient id="mint" x1="0" y1="${EXTENT.top}" x2="0" y2="${EXTENT.bottom}" gradientUnits="userSpaceOnUse">\n` +
			`\t\t\t<stop offset="0" stop-color="rgb(${COLOURS.top.join(',')})"/>\n` +
			`\t\t\t<stop offset="1" stop-color="rgb(${COLOURS.bottom.join(',')})"/>\n` +
			`\t\t</linearGradient>\n\t</defs>\n` +
			`\t<path fill="url(#mint)" fill-rule="evenodd" d="${shieldSvgPath()}"/>\n</svg>\n`,
		'utf8'
	)
);

// The application icon, and the loose PNGs around it.
emit('icon.ico', encodeIco(APP_SIZES.map((size) => ({ size, rgba: render(size) }))));
for (const size of PNG_SIZES) {
	emit(`icons/${size}x${size}.png`, encodePng(size, render(size)));
}
emit('icon.png', encodePng(1024, render(1024)));

/*
 * Microsoft Store tiles.
 *
 * These four names are exactly what electron-builder's appx target looks for,
 * and **without them it substitutes its own `SampleAppx.*.png`** — placeholder
 * art from 2019 that ships inside the packaging tool. The first Store package
 * built here carried them, so the install prompt showed a generic Electron logo
 * for an application whose entire argument is that a stranger can tell ours
 * from somebody else's.
 *
 * Rendered at each size from the vector, like everything else here, rather than
 * resampled from `icon.png` — the mark has fine detail at 44px and downscaling
 * a 1024px bitmap to reach it is exactly how an icon goes soft.
 */
const STORE_SQUARES = [
	['StoreLogo.png', 50],
	['Square150x150Logo.png', 150],
	['Square44x44Logo.png', 44]
];
for (const [name, size] of STORE_SQUARES) {
	emit(`appx/${name}`, encodePng(size, render(size)));
}
// The wide tile is not a square, so the mark is centred on a transparent field
// rather than stretched. `showNameOnTiles` is false, so nothing else goes on it.
emit('appx/Wide310x150Logo.png', encodePng(310, renderInto(310, 150, 150, 80, 0), 150));

// The tray.
emit('tray/tray.ico', encodeIco(TRAY_SIZES.map((size) => ({ size, rgba: render(size) }))));
for (const size of TRAY_SIZES) {
	emit(`tray/tray-${size}.png`, encodePng(size, render(size)));
}

// NSIS. The two fixed sizes are the installer's, not ours.
const INSTALLER_BACKGROUND = [0x07, 0x0a, 0x0e]; // --bg, so it matches the app
emit(
	'installerSidebar.bmp',
	encodeBmp24(164, 314, renderInto(164, 314, 116, 24, 40), INSTALLER_BACKGROUND)
);
emit(
	'installerHeader.bmp',
	encodeBmp24(150, 57, renderInto(150, 57, 44, 98, 6), INSTALLER_BACKGROUND)
);

const total = written.reduce((sum, [, bytes]) => sum + bytes, 0);
for (const [name, bytes] of written) {
	process.stdout.write(`${name.padEnd(28)} ${String(bytes).padStart(8)} bytes\n`);
}
process.stdout.write(`${String(written.length).padStart(28)} files, ${total} bytes total\n`);
