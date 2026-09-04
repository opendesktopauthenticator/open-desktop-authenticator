import type { ReactNode } from 'react';

/**
 * An error produced after an interaction or asynchronous request.
 *
 * `role="alert"` already carries assertive live-region semantics, so this does
 * not add a second `aria-live` declaration. Keeping the contract in one
 * component means visual error styling cannot silently lose its announcement.
 * Static warnings do not belong here: announcing prose that was present when a
 * screen opened would be noise rather than feedback.
 */
export function DynamicError({
	children,
	className = 'error',
	id
}: {
	children: ReactNode;
	className?: string;
	id?: string;
}): React.JSX.Element {
	return (
		<p {...(id === undefined ? {} : { id })} className={className} role="alert" aria-atomic="true">
			{children}
		</p>
	);
}
