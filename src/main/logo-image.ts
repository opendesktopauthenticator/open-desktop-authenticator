import { nativeImage, type NativeImage } from 'electron';
import { premultipliedBgra } from '../shared/logo';

/**
 * The application mark as something Electron can draw.
 *
 * Built from the geometry in `shared/logo.ts` rather than loaded from
 * `build/icon.ico`, for two reasons. A path into `build/` resolves differently
 * in development and inside an asar archive, which is a footgun for the sake of
 * a file that is generated from this same source anyway. And it keeps the
 * property the tray has always had here: the artwork the running application
 * draws is code, not a binary.
 *
 * The `.ico` files still matter — they are what stamps the executable and the
 * installer, which Electron never gets a say in — but nothing at runtime reads
 * them.
 *
 * ## Why several representations
 *
 * Windows asks for a specific pixel size and Electron answers with the
 * representation whose scale factor matches, or the nearest one scaled. Supplying
 * a single large image and letting it be resampled is what makes an icon look
 * soft; it is also what closes up the aperture, which is the first detail to go.
 * Each size here is drawn at its own size instead.
 */
export function logoImage(base: number, scales: readonly number[]): NativeImage {
	const image = nativeImage.createEmpty();
	for (const scaleFactor of scales) {
		const size = Math.round(base * scaleFactor);
		image.addRepresentation({
			width: size,
			height: size,
			scaleFactor,
			// Node's Buffer over the shared module's plain bytes; see its note.
			buffer: Buffer.from(premultipliedBgra(size))
		});
	}
	return image;
}

/**
 * The notification-area icon: 16, 20, 24 and 32.
 *
 * Those are the four sizes Windows draws the tray at across 100%, 125%, 150% and
 * 200% display scaling, which between them cover essentially every laptop.
 */
export const trayImage = (): NativeImage => logoImage(16, [1, 1.25, 1.5, 2]);

/**
 * The window icon: Alt-Tab, the taskbar button, and the window list.
 *
 * Only visible unpackaged on Windows, where a packaged build takes its icon from
 * the executable instead — but "only in development" is where a wrong icon is
 * seen most often by the people working on it.
 */
export const windowImage = (): NativeImage => logoImage(32, [1, 1.5, 2, 4, 8]);
