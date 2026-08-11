/**
 * The three container formats Windows wants.
 *
 * Written out longhand rather than pulled from npm. Icon toolchains are heavy,
 * and this project keeps its production dependencies at four on purpose — adding
 * a build-time image library with its own transitive tree to draw one shield is
 * a poor trade. Everything here uses `node:zlib` and nothing else.
 *
 * PNG is not here: it moved to `src/main/png.ts`, because the application needs
 * to write one at runtime as well and two encoders would be one too many.
 *
 * The drawing itself is not here — it lives in `src/shared/logo.ts`, because the
 * running application needs it too for the tray icon. This file is only the
 * three containers Windows wants around it.
 */

// The same encoder the running application uses to write its notification icon.
// One PNG writer, so the icon Windows shows in a toast is produced by the code
// that produced the one on the taskbar.
import { encodePng } from '../src/main/png.ts';

export { encodePng };

/* ------------------------------------------------------------------ ico -- */

/** One icon directory entry's image, as a bottom-up 32bpp DIB with an AND mask.
 *
 *  The mask is all zeros: with 32bpp the alpha channel does the work, but the
 *  mask is not optional — a DIB in an .ico declares double its real height and
 *  Windows expects the second half to be there. */
function dib(size, rgba) {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(size, 4);
	header.writeInt32LE(size * 2, 8); // colour data + mask
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	header.writeUInt32LE(size * size * 4, 20);

	const pixels = Buffer.alloc(size * size * 4);
	for (let row = 0; row < size; row++) {
		const source = (size - 1 - row) * size * 4; // bottom-up
		for (let col = 0; col < size; col++) {
			const s = source + col * 4;
			const d = (row * size + col) * 4;
			pixels[d] = rgba[s + 2]; // B
			pixels[d + 1] = rgba[s + 1]; // G
			pixels[d + 2] = rgba[s]; // R
			pixels[d + 3] = rgba[s + 3]; // A
		}
	}
	const maskStride = Math.ceil(size / 8 / 4) * 4;
	return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

/**
 * A multi-resolution .ico.
 *
 * Sizes up to 128 go in as DIBs and 256 goes in as a PNG. That split is what
 * every Windows icon in the wild does: PNG entries need Vista or later, and a
 * 256px DIB would add 256KB to the file for a size that has always been allowed
 * to be compressed.
 */
export function encodeIco(images) {
	const entries = [];
	const blobs = [];
	let offset = 6 + images.length * 16;
	for (const { size, rgba } of images) {
		const body = size >= 256 ? encodePng(size, rgba) : dib(size, rgba);
		const entry = Buffer.alloc(16);
		entry[0] = size >= 256 ? 0 : size; // 0 means 256
		entry[1] = size >= 256 ? 0 : size;
		entry.writeUInt16LE(1, 4); // planes
		entry.writeUInt16LE(32, 6); // bits per pixel
		entry.writeUInt32LE(body.length, 8);
		entry.writeUInt32LE(offset, 12);
		entries.push(entry);
		blobs.push(body);
		offset += body.length;
	}
	const header = Buffer.alloc(6);
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(images.length, 4);
	return Buffer.concat([header, ...entries, ...blobs]);
}

/* ------------------------------------------------------------------ bmp -- */

/**
 * A 24-bit BMP, for the two images NSIS puts in the installer.
 *
 * NSIS will not take a PNG for these, and 24-bit has no alpha, so the artwork
 * has to be composited onto a background here rather than left to the installer.
 */
export function encodeBmp24(width, height, rgba, background) {
	const stride = Math.ceil((width * 3) / 4) * 4;
	const pixels = Buffer.alloc(stride * height);
	for (let row = 0; row < height; row++) {
		const source = (height - 1 - row) * width * 4; // bottom-up
		for (let col = 0; col < width; col++) {
			const s = source + col * 4;
			const a = rgba[s + 3] / 255;
			const d = row * stride + col * 3;
			pixels[d] = Math.round(rgba[s + 2] * a + background[2] * (1 - a));
			pixels[d + 1] = Math.round(rgba[s + 1] * a + background[1] * (1 - a));
			pixels[d + 2] = Math.round(rgba[s] * a + background[0] * (1 - a));
		}
	}
	const file = Buffer.alloc(14);
	file.write('BM', 0, 'ascii');
	file.writeUInt32LE(14 + 40 + pixels.length, 2);
	file.writeUInt32LE(14 + 40, 10);
	const info = Buffer.alloc(40);
	info.writeUInt32LE(40, 0);
	info.writeInt32LE(width, 4);
	info.writeInt32LE(height, 8);
	info.writeUInt16LE(1, 12);
	info.writeUInt16LE(24, 14);
	info.writeUInt32LE(pixels.length, 20);
	return Buffer.concat([file, info, pixels]);
}
