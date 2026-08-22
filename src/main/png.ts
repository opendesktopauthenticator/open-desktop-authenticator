import { deflateSync } from 'node:zlib';

/**
 * A minimal PNG writer.
 *
 * Lives in the main process rather than in `shared/` because it needs
 * `node:zlib`, and `shared/` is compiled by the renderer's tsconfig too — a Node
 * import there breaks the web build. It is here rather than in `tools/` because
 * both need it: the icon generator writes the files in `build/`, and the running
 * application writes one PNG of its own at startup for Windows to put in toast
 * notifications.
 *
 * `tools/raster.mjs` imports this file directly; Node strips the types. One
 * encoder, so the icon Windows shows in a notification is produced by the same
 * code as the icon on the taskbar.
 */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let c = -1;
	for (const byte of buffer) {
		c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	}
	return (c ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	const tagged = Buffer.concat([Buffer.from(type, 'ascii'), body]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(tagged));
	return Buffer.concat([length, tagged, crc]);
}

/**
 * An 8-bit RGBA PNG from straight (unpremultiplied) pixels.
 *
 * Filter 0 throughout — these are flat shapes, and deflate handles the long
 * transparent runs perfectly well without a filter to help it.
 */
export function encodePng(
	size: number,
	rgba: Buffer | Uint8Array,
	/**
	 * Rows, when the image is not square. Defaults to `size`.
	 *
	 * Everything this encoder produced was square until the Store's wide tile —
	 * 310x150 — needed writing, and a square-only encoder would have meant either
	 * a second encoder or letting electron-builder substitute its own sample art
	 * for that one asset.
	 */
	height: number = size
): Buffer {
	const pixels = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba);
	const stride = size * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let row = 0; row < height; row++) {
		raw[row * (stride + 1)] = 0;
		pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // truecolour with alpha
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}
