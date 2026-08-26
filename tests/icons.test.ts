import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APERTURE, coverage, DESIGN, rgbaOf, shieldSvgPath } from '../src/shared/logo';

/**
 * The icons, and the claim that they are reproducible.
 *
 * `src/shared/logo.ts` argues that committing binaries into an authenticator's
 * repository is only acceptable because those binaries can be regenerated from
 * source and checked. That argument is worth exactly as much as this file: if
 * the committed `.ico` stops matching what the generator produces, the artwork
 * has become something a reader has to take on trust after all.
 *
 * So the first test below re-runs the generator into a scratch tree and compares
 * every byte. The rest check the two things about an icon that are easy to get
 * wrong and impossible to see in a diff: that the container formats are actually
 * well-formed, and that the mark still reads at 16px.
 */

const root = join(__dirname, '..');
const build = join(root, 'build');
const read = (rel: string) => readFileSync(join(build, rel));

/** Every file the generator is expected to have produced. */
function tree(dir: string, prefix = ''): string[] {
	return readdirSync(dir)
		.flatMap((name) => {
			const full = join(dir, name);
			return statSync(full).isDirectory() ? tree(full, `${prefix}${name}/`) : [`${prefix}${name}`];
		})
		.sort();
}

describe('the committed icons', () => {
	it('are exactly what the generator produces', () => {
		// Regenerating in place would make this test pass by rewriting the evidence,
		// so it runs against a copy and compares. Any drift — a hand-edited PNG, a
		// geometry change someone forgot to re-run — shows up here as a byte
		// mismatch naming the file.
		const scratch = join(root, 'node_modules', '.icon-verify');
		execFileSync(process.execPath, [join(root, 'tools', 'make-icons.mjs')], {
			cwd: root,
			env: { ...process.env, ICON_OUTPUT_DIR: scratch },
			stdio: 'pipe'
		});

		const produced = tree(scratch);
		expect(produced).toEqual(tree(build));

		const differing = produced.filter(
			(name) => !readFileSync(join(scratch, name)).equals(read(name))
		);
		expect(differing, 'run `node tools/make-icons.mjs` and commit the result').toEqual([]);
	}, 60_000);

	it('cover every size Windows asks for', () => {
		// 20, 40 and 96 are the display-scaling sizes. Missing them is not a crash,
		// it is a soft icon at 125%, 150% and 200% — which is most laptops, and
		// which nobody notices on the machine that built it.
		const sizes = entriesOf(read('icon.ico')).map((entry) => entry.width);
		expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
		expect(entriesOf(read('tray/tray.ico')).map((e) => e.width)).toEqual([16, 20, 24, 32]);
	});

	it('are structurally valid icon files', () => {
		// Hand-rolled container formats. A wrong offset or a DIB whose declared
		// height is not double its real one produces a file that parses far enough
		// to look fine and then renders as nothing.
		for (const name of ['icon.ico', 'tray/tray.ico']) {
			const bytes = read(name);
			expect(bytes.readUInt16LE(0), `${name} reserved`).toBe(0);
			expect(bytes.readUInt16LE(2), `${name} type`).toBe(1);
			for (const entry of entriesOf(bytes)) {
				expect(entry.offset + entry.length, `${name} @${entry.width}`).toBeLessThanOrEqual(
					bytes.length
				);
				if (entry.png) {
					expect(bytes.subarray(entry.offset, entry.offset + 4)).toEqual(
						Buffer.from([0x89, 0x50, 0x4e, 0x47])
					);
				} else {
					// A DIB inside an .ico declares twice its height, for the AND mask.
					expect(bytes.readInt32LE(entry.offset + 4)).toBe(entry.width);
					expect(bytes.readInt32LE(entry.offset + 8)).toBe(entry.width * 2);
				}
			}
		}
	});

	/*
	 * The macOS container, walked chunk by chunk.
	 *
	 * `.icns` states its own total length and then each chunk states its own,
	 * every one of them counting its header and all of them big-endian — which
	 * is three chances to be off by eight in a file the Finder will simply
	 * refuse to draw rather than complain about. Walking it is the only way to
	 * know, and there is no macOS in this suite to ask.
	 */
	it('is a well-formed icns covering every size macOS asks for', () => {
		const bytes = read('icon.icns');
		expect(bytes.toString('ascii', 0, 4)).toBe('icns');
		expect(bytes.readUInt32BE(4), 'the declared length is not the file length').toBe(bytes.length);

		const found: [string, number][] = [];
		let offset = 8;
		while (offset < bytes.length) {
			const type = bytes.toString('ascii', offset, offset + 4);
			const length = bytes.readUInt32BE(offset + 4);
			expect(length, `${type} declares nothing`).toBeGreaterThan(8);

			const png = bytes.subarray(offset + 8, offset + length);
			expect(png.subarray(0, 4), `${type} is not a PNG`).toEqual(
				Buffer.from([0x89, 0x50, 0x4e, 0x47])
			);
			// Width and height out of the IHDR, which is always the first chunk.
			expect(png.readUInt32BE(16), `${type} is not square`).toBe(png.readUInt32BE(20));
			found.push([type, png.readUInt32BE(16)]);
			offset += length;
		}

		expect(offset, 'the chunks do not fill the file exactly').toBe(bytes.length);

		/*
		 * Ten entries, seven sizes. The Retina duplicates are the part that is
		 * easy to drop: `ic11` is 16pt at 2x and `icp5` is 32pt at 1x, both
		 * 32 pixels square, and macOS will not substitute one for the other — it
		 * draws nothing at that size instead.
		 */
		expect(found).toEqual([
			['icp4', 16],
			['ic11', 32],
			['icp5', 32],
			['ic12', 64],
			['ic07', 128],
			['ic13', 256],
			['ic08', 256],
			['ic14', 512],
			['ic09', 512],
			['ic10', 1024]
		]);
	});

	it('describes the same shape in the SVG as in the bitmaps', () => {
		// The vector and the rasters are generated from one geometry, so the only
		// way they can disagree is if the SVG writer stops following it.
		const svg = read('icon.svg').toString('utf8');
		expect(svg).toContain(shieldSvgPath());
		expect(svg).toContain(`viewBox="0 0 ${DESIGN} ${DESIGN}"`);
		// Without evenodd the aperture fills in and the mark becomes a plain shield.
		expect(svg).toContain('fill-rule="evenodd"');
	});
});

describe('the mark itself', () => {
	it('still has an open aperture at 16px', () => {
		// The whole point of the logo is that you can see through it, and 16px is
		// where that fails first. The centre must be genuinely clear, not a smudge.
		const size = 16;
		const cover = coverage(size);
		const centre = Math.round((APERTURE.y / DESIGN) * size);
		const middle = cover[centre * size + size / 2] ?? 1;
		expect(middle, 'the aperture has closed up at 16px').toBeLessThan(0.02);
	});

	it('still has shield either side of that aperture at 16px', () => {
		// The other failure: an aperture so wide the flanks thin to nothing and the
		// silhouette stops being a shield.
		const size = 16;
		const cover = coverage(size);
		const row = Math.round((APERTURE.y / DESIGN) * size);
		const left = cover[row * size + 2] ?? 0;
		const right = cover[row * size + (size - 3)] ?? 0;
		expect(Math.min(left, right), 'the flanks have thinned away at 16px').toBeGreaterThan(0.5);
	});

	it('is opaque where it should be and absent where it should not', () => {
		const size = 64;
		const rgba = rgbaOf(size);
		const alphaAt = (x: number, y: number) => rgba[(y * size + x) * 4 + 3];
		// Corners are outside the shield entirely.
		expect(alphaAt(1, 1)).toBe(0);
		expect(alphaAt(size - 2, 1)).toBe(0);
		// The middle of the upper shield is solid.
		expect(alphaAt(size / 2, 10)).toBe(255);
	});
});

/** The directory entries of an .ico. */
function entriesOf(bytes: Buffer) {
	const count = bytes.readUInt16LE(4);
	return Array.from({ length: count }, (_, i) => {
		const at = 6 + i * 16;
		return {
			width: bytes[at] === 0 ? 256 : bytes[at]!,
			length: bytes.readUInt32LE(at + 8),
			offset: bytes.readUInt32LE(at + 12),
			png: bytes[bytes.readUInt32LE(at + 12)] === 0x89
		};
	});
}
