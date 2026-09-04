/**
 * The screen to show after the enrollment recovery flow is completely left.
 *
 * Shared as a pure rule so both the renderer and the Node test target can use it
 * without importing a JSX module.
 */
export function recoveryExitView(queued: 'move' | undefined): 'accounts' | 'move' {
	return queued === 'move' ? 'move' : 'accounts';
}

/** Whether “Steam Guard was not added” is a truthful resolution to offer. */
export function enrollmentMayBeClearedAsNotAttached(pending: {
	state: 'sending' | 'unanswered' | 'not-attached' | 'attached' | 'recoverable' | 'unreadable';
	stored: boolean;
	certain?: boolean | undefined;
}): boolean {
	return (
		!pending.stored &&
		pending.certain !== true &&
		pending.state !== 'attached' &&
		pending.state !== 'recoverable' &&
		pending.state !== 'unreadable'
	);
}
