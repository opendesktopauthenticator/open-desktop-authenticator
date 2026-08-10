/**
 * Copying a code to the clipboard, and taking it back out again (§10.3).
 *
 * The clipboard is shared with every process on the machine and, on some
 * systems, with other devices through cloud sync. A Steam Guard code left there
 * outlives its thirty seconds of usefulness by hours, so it is cleared on a
 * timer.
 *
 * Two rules make the clearing safe rather than annoying:
 *
 *  1. **Never clear something we did not put there.** The user copies other
 *     things. Wiping a paragraph they copied twenty seconds after we wrote a
 *     code would be data loss caused by a security feature, so the current
 *     contents are compared against what we wrote and left alone if they differ.
 *  2. **Only one pending clear at a time.** Copying a second code supersedes the
 *     first timer instead of stacking, so the countdown always refers to what is
 *     actually on the clipboard.
 *
 * The clipboard itself is injected. Electron's is a module-level singleton, and
 * a rule about not destroying the user's data deserves a test rather than a
 * careful reading.
 *
 * ## What this cannot do
 *
 * Clearing the clipboard does not reach Windows Clipboard History (`Win`+`V`) or
 * cloud clipboard sync. Those take their copy the instant anything is copied,
 * and no application-level API removes an entry afterwards. The limit is
 * recorded in THREAT_MODEL.md §4 rather than left for a user to discover, since
 * "the clipboard is cleared" reasonably sounds like more than it is.
 *
 * The read-then-clear in `clearIfOurs` is also **not atomic**, and cannot be:
 * the clipboard is shared machine-wide and no platform offers a compare-and-
 * clear. Another process writing in the microseconds between the two calls would
 * have its content cleared. The window is as small as it can be made — the read
 * happens immediately before the write, not at schedule time — and the failure
 * costs one clipboard entry rather than any secret. Stated because "never clears
 * what isn't ours" is a rule with an edge, not a guarantee.
 */

export interface Clipboard {
	readText(): string;
	writeText(text: string): void;
	clear(): void;
}

export interface ClipboardCourierOptions {
	clipboard: Clipboard;
	/** Injected so the timer can be driven directly in tests. */
	setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
	clearTimer?: (handle: NodeJS.Timeout) => void;
}

export class ClipboardCourier {
	private readonly clipboard: Clipboard;
	private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
	private readonly clearTimer: (handle: NodeJS.Timeout) => void;
	private pending: NodeJS.Timeout | undefined;
	/** Exactly what we last wrote, so we can tell whether it is still there. */
	private written: string | undefined;

	constructor(options: ClipboardCourierOptions) {
		this.clipboard = options.clipboard;
		this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
	}

	/** Put `text` on the clipboard and schedule its removal. */
	copy(text: string, clearAfterMs: number): void {
		this.cancel();
		this.clipboard.writeText(text);
		this.written = text;

		const handle = this.setTimer(() => {
			this.pending = undefined;
			this.clearIfOurs();
		}, clearAfterMs);
		// Never hold the process open for a clipboard wipe; `beforeQuit` handles
		// the case where the app exits first.
		handle.unref?.();
		this.pending = handle;
	}

	/**
	 * Clear now, if what we wrote is still there.
	 *
	 * Called on the timer, when the vault locks, and before quit — a code must not
	 * survive on the clipboard past the session that produced it.
	 */
	clearIfOurs(): boolean {
		this.cancel();

		const written = this.written;
		this.written = undefined;
		if (written === undefined) {
			return false;
		}

		// The user has copied something else since. Theirs, not ours to destroy.
		if (this.clipboard.readText() !== written) {
			return false;
		}

		this.clipboard.clear();
		return true;
	}

	/** Drop any pending clear without touching the clipboard. */
	cancel(): void {
		if (this.pending) {
			this.clearTimer(this.pending);
			this.pending = undefined;
		}
	}

	/** Whether a clear is currently scheduled. */
	hasPendingClear(): boolean {
		return this.pending !== undefined;
	}
}
