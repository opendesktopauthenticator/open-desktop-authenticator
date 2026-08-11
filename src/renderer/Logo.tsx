import { shieldSvgPath, DESIGN } from '../shared/logo';

/**
 * The product mark, drawn from the same geometry as the application icon.
 *
 * Imported rather than copied: `shared/logo.ts` is the only drawing in this
 * repository, and an SVG pasted into the interface would be a second one that
 * quietly stops matching the taskbar the first time the shape is touched.
 *
 * The gradient is declared per instance with a unique id. Two copies of this
 * component on one page sharing a `<defs>` id is the classic SVG bug: the second
 * silently reuses the first's gradient, and if the first unmounts the second
 * turns black.
 */
export function Logo({
	size = 28,
	/**
	 * Draws the outline on rather than appearing at once.
	 *
	 * Only worth it where the mark is the largest thing on screen and the user is
	 * waiting anyway — the lock screen. In a header it would be a distraction that
	 * plays on every navigation.
	 */
	drawIn = false,
	className
}: {
	size?: number;
	drawIn?: boolean;
	className?: string;
}): React.JSX.Element {
	const id = `mark-${size}-${drawIn ? 'draw' : 'flat'}`;
	return (
		<svg
			className={[className, 'mark', drawIn ? 'mark-draw' : undefined].filter(Boolean).join(' ')}
			viewBox={`0 0 ${DESIGN} ${DESIGN}`}
			width={size}
			height={size}
			role="img"
			aria-label="Open Desktop Authenticator"
			focusable="false"
		>
			<defs>
				<linearGradient id={id} x1="0" y1="118" x2="0" y2="946" gradientUnits="userSpaceOnUse">
					<stop offset="0" stopColor="var(--mint)" />
					<stop offset="1" stopColor="var(--emerald-deep)" />
				</linearGradient>
			</defs>
			<path d={shieldSvgPath()} fill={`url(#${id})`} fillRule="evenodd" />
		</svg>
	);
}
