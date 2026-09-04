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
 * The `.ico` files still matter. They stamp the executable and installer, and
 * unpackaged Windows windows name `build/icon.ico` in their shell-group details.
 * The pixels Electron draws on native window surfaces still come from this
 * module.
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
 * The image handed to a tray balloon.
 *
 * A single large representation on purpose. Windows draws the app logo on a
 * toast at around 48px, doubled on a 200% display — and given nothing, it takes
 * the tray icon and scales 16px up to that, which is why the notification looked
 * soft. One 256px image means it is always scaling down.
 */
export const notificationImage = (): NativeImage => logoImage(256, [1]);

/**
 * The native window icon: title-bar, Alt-Tab, and the window list.
 *
 * Windows taskbar grouping is a separate shell identity. In an unpackaged
 * Windows run, `windows-taskbar-identity.ts` gives the group a development-only
 * AppUserModelID and names the ICO resource before either window is shown. This
 * image remains the correct source for the windows themselves.
 */
export const windowImage = (): NativeImage => logoImage(32, [1, 1.5, 2, 4, 8]);
