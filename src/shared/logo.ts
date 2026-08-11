/**
 * The logo, as geometry.
 *
 * ## Why the artwork is code
 *
 * Everything the application draws for itself comes from here: the tray icon at
 * runtime, and — through `tools/make-icons.mjs` — every PNG, ICO and BMP in
 * `build/`. There is one drawing in this repository and it is the curve list
 * below.
 *
 * Two reasons, and the second is the real one.
 *
 * Artwork that exists as both a vector file and a pile of bitmaps drifts the
 * first time somebody nudges one of them, and nobody notices until the taskbar
 * and the tray are visibly different products.
 *
 * More importantly, this is an authenticator. Its whole claim on a user's trust
 * is that nothing here has to be taken on faith — the source is public and every
 * behaviour can be checked against it. A committed binary is the one thing in a
 * repository that resists that: nobody diffs a PNG. Windows needs real `.ico`
 * files and there is no way around that, so the next best thing is that they are
 * reproducible — `node tools/make-icons.mjs` regenerates every byte from this
 * file, and `tests/icons.test.ts` fails if the committed ones stop matching.
 *
 * ## The mark
 *
 * A shield with a hole straight through it.
 *
 * The shield is the obvious half: this is software people hand the only copy of
 * a secret that guards their account. The hole is the half that means something,
 * and it is why the shield is not solid. An authenticator asks for more trust
 * than almost anything else on a desktop, and the reason to extend it here is
 * that nothing is concealed. A shield you can see through says so; a solid one
 * says the opposite. That the opening is a round O, for open, is not an accident
 * either.
 *
 * It also survives being small, which is the constraint that actually decides an
 * icon. At 16px there are about eleven usable pixels across and anything with
 * interior detail turns to porridge. A silhouette with one large aperture keeps
 * a distinct outline at every size, and the aperture closes up last rather than
 * first — checked by rendering it at 16px and looking, not by scaling down the
 * big one and hoping.
 *
 * Coordinates are in a 1024 design square, so the proportions are identical
 * whether the target is 16px or 1024px.
 */

/** The design square everything below is expressed in. */
export const DESIGN = 1024;

/**
 * The gradient, mint over deep green.
 *
 * The top stop is `--mint` from `app.css` exactly, so the icon and the interface
 * are the same colour rather than nearly the same. The bottom is darker, which
 * makes the shield read as lit from above rather than as a flat sticker; at
 * 256px that is depth, and at 16px it weights the lower half in a way that
 * sharpens the silhouette.
 *
 * The ramp is darker overall than it first seems it should be, deliberately. A
 * paler mint vanishes into a light taskbar — rendered against white, a top stop
 * near `#6cffbe` loses its entire upper edge. This one holds an edge on white
 * and stays vivid on the app's near-black.
 */
export const COLOURS = {
	top: [0x42, 0xf2, 0x9a],
	bottom: [0x0b, 0x7d, 0x4c]
} as const;

const CX = DESIGN / 2;
const TOP = 118;
const BOTTOM = 946;
const HALF = 366;
const LEFT = CX - HALF;
const RIGHT = CX + HALF;
/** Rounded top corners: square reads as a road sign, fully round as a badge. */
const CORNER = 92;
/** Where the flanks stop being vertical and start heading for the point. */
const WAIST = TOP + (BOTTOM - TOP) * 0.44;

type Command = ['M' | 'L', number, number] | ['C', ...number[]] | ['Z'];

/**
 * The shield outline as drawing commands — the single source of the shape.
 *
 * Straight down each flank to the waist, then one curve into a point.
 */
export const SHIELD: Command[] = [
	['M', LEFT + CORNER, TOP],
	['L', RIGHT - CORNER, TOP],
	['C', RIGHT - CORNER * 0.45, TOP, RIGHT, TOP + CORNER * 0.45, RIGHT, TOP + CORNER],
	['L', RIGHT, WAIST],
	['C', RIGHT, BOTTOM - 210, CX + 210, BOTTOM - 60, CX, BOTTOM],
	['C', CX - 210, BOTTOM - 60, LEFT, BOTTOM - 210, LEFT, WAIST],
	['L', LEFT, TOP + CORNER],
	['C', LEFT, TOP + CORNER * 0.45, LEFT + CORNER * 0.45, TOP, LEFT + CORNER, TOP],
	['Z']
];

/**
 * The aperture punched through the shield.
 *
 * Above the geometric centre on purpose: the shield's mass is in its upper half,
 * so a hole at the true centre sits visibly low. This is the optical centre,
 * which is the one people see.
 *
 * The radius was chosen at 16px rather than at 1024px, because 16px is where it
 * can fail. Larger and the flanks thin to a couple of pixels; smaller and the
 * opening closes into a smudge.
 */
export const APERTURE = { x: CX, y: 458, r: 155 } as const;

/** The vertical span the gradient is mapped across. */
export const EXTENT = { top: TOP, bottom: BOTTOM } as const;

/** Flatten the commands into a closed polygon for the rasteriser. */
export function shieldPolygon(steps = 72): [number, number][] {
	const points: [number, number][] = [];
	let at: [number, number] = [0, 0];
	for (const [kind, ...n] of SHIELD) {
		if (kind === 'M' || kind === 'L') {
			at = [n[0] as number, n[1] as number];
			points.push(at);
		} else if (kind === 'C') {
			const [x1, y1, x2, y2, x3, y3] = n as number[];
			const [x0, y0] = at;
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				const u = 1 - t;
				points.push([
					u * u * u * x0 + 3 * u * u * t * x1! + 3 * u * t * t * x2! + t * t * t * x3!,
					u * u * u * y0 + 3 * u * u * t * y1! + 3 * u * t * t * y2! + t * t * t * y3!
				]);
			}
			at = [x3!, y3!];
		}
	}
	return points;
}

const round = (n: number) => Number(n.toFixed(2));

/**
 * The same commands as an SVG `d`, the aperture as a second subpath.
 *
 * Punched out by `fill-rule="evenodd"` rather than by a mask, so the whole mark
 * is one path element and stays legible when pasted anywhere.
 */
export function shieldSvgPath(): string {
	const outline = SHIELD.map(([kind, ...n]) => kind + n.map(round).join(' ')).join(' ');
	const { x, y, r } = APERTURE;
	const hole =
		`M${round(x + r)} ${y}` +
		`A${r} ${r} 0 1 0 ${round(x - r)} ${y}` +
		`A${r} ${r} 0 1 0 ${round(x + r)} ${y}Z`;
	return `${outline} ${hole}`;
}

/* ------------------------------------------------------------ rendering -- */

/** Sub-rows per output row. Horizontal coverage is exact, so 4 is ample. */
const SUBSAMPLES = 4;

/**
 * Where a horizontal line crosses a closed polygon, in order.
 *
 * The even-odd scanline rule. The half-open test on `y` is what stops a vertex
 * landing exactly on the line from being counted twice, which would invert
 * everything below it.
 */
function crossings(polygon: readonly (readonly [number, number])[], y: number): number[] {
	const xs: number[] = [];
	for (let i = 0, n = polygon.length; i < n; i++) {
		const [x0, y0] = polygon[i]!;
		const [x1, y1] = polygon[(i + 1) % n]!;
		if (y0 === y1 || y < Math.min(y0, y1) || y >= Math.max(y0, y1)) {
			continue;
		}
		xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
	}
	return xs.sort((a, b) => a - b);
}

/**
 * Per-pixel coverage of the mark at `size`, 0..1.
 *
 * Supersampled vertically; horizontally it measures each span's overlap with
 * each pixel column exactly, which is both cleaner and faster than sampling.
 */
export function coverage(size: number): Float32Array {
	const scale = size / DESIGN;
	const points = shieldPolygon().map(([x, y]) => [x * scale, y * scale] as [number, number]);
	const hx = APERTURE.x * scale;
	const hy = APERTURE.y * scale;
	const hr = APERTURE.r * scale;
	const cover = new Float32Array(size * size);
	const step = 1 / SUBSAMPLES;

	for (let row = 0; row < size; row++) {
		for (let s = 0; s < SUBSAMPLES; s++) {
			const y = row + (s + 0.5) * step;
			const xs = crossings(points, y);
			const spans: [number, number][] = [];
			for (let i = 0; i + 1 < xs.length; i += 2) {
				spans.push([xs[i]!, xs[i + 1]!]);
			}
			// The aperture, as its horizontal slice at this row.
			const dy = y - hy;
			const dx = Math.abs(dy) < hr ? Math.sqrt(hr * hr - dy * dy) : 0;
			for (const [a, b] of spans) {
				for (const [from, to] of dx > 0
					? ([
							[a, Math.min(b, hx - dx)],
							[Math.max(a, hx + dx), b]
						] as [number, number][])
					: [[a, b] as [number, number]]) {
					if (!(to > from)) {
						continue;
					}
					const first = Math.max(0, Math.floor(from));
					const last = Math.min(size - 1, Math.ceil(to) - 1);
					for (let col = first; col <= last; col++) {
						const overlap = Math.min(to, col + 1) - Math.max(from, col);
						if (overlap > 0) {
							cover[row * size + col]! += overlap * step;
						}
					}
				}
			}
		}
	}
	return cover;
}

/** The gradient colour at an output row, for a mark drawn at `size`. */
export function colourAt(size: number, row: number): [number, number, number] {
	const scale = size / DESIGN;
	const y0 = EXTENT.top * scale;
	const span = Math.max(1, EXTENT.bottom * scale - y0);
	const t = Math.min(1, Math.max(0, (row + 0.5 - y0) / span));
	return [
		Math.round(COLOURS.top[0] + (COLOURS.bottom[0] - COLOURS.top[0]) * t),
		Math.round(COLOURS.top[1] + (COLOURS.bottom[1] - COLOURS.top[1]) * t),
		Math.round(COLOURS.top[2] + (COLOURS.bottom[2] - COLOURS.top[2]) * t)
	];
}

/** The mark at `size` as straight (unpremultiplied) RGBA — what PNG wants. */
export function rgbaOf(size: number): Uint8Array {
	const cover = coverage(size);
	const out = new Uint8Array(size * size * 4);
	for (let row = 0; row < size; row++) {
		const [r, g, b] = colourAt(size, row);
		for (let col = 0; col < size; col++) {
			const i = row * size + col;
			const alpha = Math.round(Math.min(1, cover[i]!) * 255);
			if (alpha === 0) {
				continue;
			}
			out[i * 4] = r;
			out[i * 4 + 1] = g;
			out[i * 4 + 2] = b;
			out[i * 4 + 3] = alpha;
		}
	}
	return out;
}

/**
 * The mark at `size` as premultiplied BGRA — what Electron's `NativeImage`
 * wants.
 *
 * Skia reads these buffers as premultiplied, so full-intensity colour beside a
 * partial alpha renders the antialiased edge brighter than it should be: a halo
 * rather than a smooth edge, and very visible on a 16px tray icon.
 *
 * A `Uint8Array` rather than a `Buffer`, because this module is compiled by the
 * renderer's tsconfig as well and must not reach for Node's types. The main
 * process wraps it where it is used.
 */
export function premultipliedBgra(size: number): Uint8Array {
	const cover = coverage(size);
	const out = new Uint8Array(size * size * 4);
	for (let row = 0; row < size; row++) {
		const [r, g, b] = colourAt(size, row);
		for (let col = 0; col < size; col++) {
			const i = row * size + col;
			const alpha = Math.round(Math.min(1, cover[i]!) * 255);
			out[i * 4] = Math.round((b * alpha) / 255);
			out[i * 4 + 1] = Math.round((g * alpha) / 255);
			out[i * 4 + 2] = Math.round((r * alpha) / 255);
			out[i * 4 + 3] = alpha;
		}
	}
	return out;
}
