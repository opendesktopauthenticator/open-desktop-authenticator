/**
 * BrowserWindows that display an account's isolated trading session.
 *
 * A WeakSet records identity without extending a window's lifetime. The account
 * shell became a BrowserWindow so Windows Explorer would use the product icon;
 * that also made it visible to process-wide BrowserWindow queries which used to
 * mean "the main app window". Every such query now goes through this boundary.
 */
const accountBrowserWindows = new WeakSet<object>();

export function markAccountBrowserWindow<T extends object>(window: T): T {
	accountBrowserWindows.add(window);
	return window;
}

export function isAccountBrowserWindow(window: object): boolean {
	return accountBrowserWindows.has(window);
}

export function applicationWindows<T extends object>(windows: readonly T[]): T[] {
	return windows.filter((window) => !isAccountBrowserWindow(window));
}

/** Prefer a focused app window, but never parent an app action to account web content. */
export function preferredApplicationWindow<T extends object>(
	focused: T | undefined,
	all: readonly T[]
): T | undefined {
	if (focused !== undefined && !isAccountBrowserWindow(focused)) {
		return focused;
	}
	return applicationWindows(all)[0];
}
