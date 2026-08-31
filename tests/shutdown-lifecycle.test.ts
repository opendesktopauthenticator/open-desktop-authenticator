import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The ways this application can be asked to stop, and what it does about
 * each.**
 *
 * Three of them were wrong at once, and they share a shape: one handler was
 * treated as the only way the event could arrive.
 *
 *  - **Quit was cancellable.** `quitting` was set in exactly one place — the
 *    tray's Quit item — and the window's `close` handler refuses to close
 *    unless it is set, because closing is meant to hide. So every other
 *    legitimate quit (Cmd-Q, `app.quit()` from anywhere, a taskbar Close All,
 *    an installer asking the app to exit) reached that handler with the flag
 *    false, was cancelled, and left the application running and hidden. The
 *    user pressed Quit and got neither an exit nor a window.
 *  - **Windows shutdown skipped every bit of cleanup.** All of it lived in
 *    `before-quit`, and Electron does not emit that during a Windows session
 *    end — the process is terminated. The machine went down with a live Steam
 *    Guard code still on the clipboard, which the next session pastes.
 *  - **The macOS Dock icon did nothing.** `activate` acted only when zero
 *    windows existed, and closing *hides* rather than destroys, so there was
 *    always a window and never anything to show.
 *
 * Asserted against the source because this project cannot boot the main process
 * in a unit test, and this is wiring rather than logic. Comments are stripped
 * first: every one of these calls is also quoted in the prose explaining why it
 * is there, and a `toContain` over raw text is satisfied by the prose alone.
 */

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const source = stripComments(
	readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
);

/** The body of one `app.on(...)` or `powerMonitor.on(...)` handler. */
function handlerBody(emitter: string, event: string): string {
	const opening = `${emitter}.on('${event}', () => {`;
	const start = source.indexOf(opening);
	expect(start, `nothing handles ${emitter} ${event} any more`).toBeGreaterThan(-1);
	const end = source.indexOf('\n\t\t});', start);
	expect(end, `the ${event} handler does not close where this test expects`).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('quitting', () => {
	/*
	 * The flag has to be set where every quit passes, not where one of them does.
	 * `before-quit` fires before Electron closes any window, which is the only
	 * point that covers Cmd-Q, `app.quit()` and an OS-initiated exit alike.
	 */
	it('is not cancelled by the close handler, whatever asked for it', () => {
		expect(
			handlerBody('app', 'before-quit'),
			'only the tray sets the quit flag, so every other way of quitting is cancelled by the ' +
				'close handler and the app stays running and hidden'
		).toContain('quitting = true');
	});

	/* And the window still hides on an ordinary close, which is the whole point. */
	it('still hides the window when nothing asked to quit', () => {
		expect(source).toContain('mainWindow.hide()');
	});
});

describe('the machine shutting down', () => {
	/**
	 * Electron does not emit `before-quit` during a Windows session end, so
	 * cleanup that lives only there does not happen. `powerMonitor` reports it in
	 * time to act.
	 */
	it('is handled somewhere other than before-quit', () => {
		expect(
			source,
			'nothing handles the OS ending the session, so a Windows shutdown skips every bit of ' +
				'cleanup that lives in before-quit'
		).toContain("powerMonitor.on('shutdown'");
	});

	it.each([
		['the clipboard, which may be holding a live code', 'clipboard.clearIfOurs()'],
		['the vault', "vault.lock('shutdown')"]
	])('clears %s', (_what, call) => {
		expect(
			handlerBody('powerMonitor', 'shutdown'),
			`${call} does not run on an OS shutdown, so it is skipped entirely on Windows`
		).toContain(call);
	});
});

describe('activating from the Dock', () => {
	/*
	 * A hidden window still exists, so counting windows answered a question about
	 * a state this application does not have. `showMainWindow` already handles
	 * minimised, hidden and destroyed, which is why it exists.
	 */
	it('shows the window rather than counting them', () => {
		const body = handlerBody('app', 'activate');
		expect(
			body,
			'the Dock icon acts only when no window exists — but closing hides, so there is always ' +
				'one, and clicking it does nothing at all'
		).not.toContain('getAllWindows().length === 0');
		expect(body).toContain('showMainWindow()');
	});
});

/**
 * **What the production toast host does when the OS cannot show one.**
 *
 * The notifier's own tests cover what happens *after* a host says "not
 * delivered" — it rolls the announcement back and the next poll says it again.
 * They cannot cover which answer the real host gives, because that lives in
 * `index.ts` beside a live `Notification`.
 *
 * And the answer used to be the wrong one. It resolved `true` on a machine with
 * no notification service, on the reasoning that retrying could not help and the
 * activity log carried it anyway. The second half was false: a notify-only
 * account writes no activity entry on a successful poll — only the confirm arm
 * does — so a security-critical recovery confirmation on such a machine produced
 * no toast, no record, and no second attempt. It vanished.
 *
 * A source assertion rather than a behavioural one, and that is a real
 * limitation: it proves the branch says `false`, not that Electron reaches it.
 * The behaviour on the other side of that answer is tested properly in
 * `confirmation-notify.test.ts`, and the screen that warns about such a machine
 * is tested in `auto-confirm-paused.test.tsx`.
 */
describe('a machine with no notification service', () => {
	const host = (() => {
		const start = source.indexOf('if (!Notification.isSupported())');
		expect(start, 'nothing asks whether notifications are supported').toBeGreaterThan(-1);
		const end = source.indexOf('}', source.indexOf('return;', start));
		return source.slice(start, end);
	})();

	it('is reported as undelivered, not as delivered', () => {
		expect(
			host,
			'a machine that shows nothing reports the toast as delivered, so the confirmation is ' +
				'marked announced and — for a notify-only account, which writes no activity entry — ' +
				'disappears entirely'
		).toContain('resolve(false)');
		expect(host).not.toContain('resolve(true)');
	});

	/* And it is offered to the renderer, so the settings screen can say so. */
	it('is reported to the renderer', () => {
		const appInfo = stripComments(
			readFileSync(join(__dirname, '..', 'src', 'main', 'app-info.ts'), 'utf8')
		);
		expect(
			appInfo,
			'the renderer is never told, so the switch is offered on a machine where it does nothing'
		).toContain('notificationsAvailable');
	});
});
