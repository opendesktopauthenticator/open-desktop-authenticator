import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Everything an account's route touches is dropped when that route changes.**
 *
 * `dropAccountRouting` is the single seam for a proxy change, an account
 * removal, and the import path that adopts a proxy. It is a list of caches, and
 * the failure mode is not that one of them is wrong — it is that a new cache
 * gets added somewhere else and nobody adds it here.
 *
 * That has happened. `EnrollmentService` kept the access token it minted over
 * the old route, so the next enrolment step reused a credential established
 * through the proxy the user had just replaced; a removed account left the same
 * credential resident until the vault locked. Every other cache in the process
 * was already covered, which is what made the gap invisible.
 *
 * Asserted against the source because this seam is a wiring list in
 * `index.ts`, and this project has no way to boot the main process in a unit
 * test. It is a weak test of behaviour and a strong one of the thing that
 * actually goes wrong.
 */
describe('the shared routing teardown', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

	/** The body of `dropAccountRouting`. */
	const body = (() => {
		const start = source.indexOf('const dropAccountRouting = (steamId64: string): void => {');
		expect(start, 'dropAccountRouting no longer exists under that name').toBeGreaterThan(-1);
		const end = source.indexOf('\n\t};', start);
		expect(end, 'dropAccountRouting changed shape; this test needs rewriting').toBeGreaterThan(
			start
		);
		return source.slice(start, end);
	})();

	it.each([
		['the per-account transport', 'transports.forget(steamId64)'],
		['the Direct mint transport', 'directTransports.forget(steamId64)'],
		['the confirmation session and pending nonces', 'confirmations.forgetAccount(steamId64)'],
		['the notifier state', 'notifier.forgetAccount(steamId64)'],
		['the poller schedule and epoch', 'autoConfirm.forgetAccount(steamId64)'],
		['the enrolment access token', 'enrollment.forgetAccount(steamId64)'],
		['the activity log entries and open runs', 'activity.forgetAccount(steamId64)']
	])('drops %s', (_what, call) => {
		expect(body, `${call} is missing, so that cache outlives the route it belongs to`).toContain(
			call
		);
	});

	/*
	 * The browser holds its own Steam session in its own partition, so it is
	 * closed too — fired and not awaited, which the comment there explains.
	 */
	it('closes the account browser', () => {
		expect(body).toContain('browsers.closeAccount(steamId64)');
	});
});

/**
 * **Every success signal the notifier and the activity log depend on.**
 *
 * Both track "we already said this" per account, and both need telling when a
 * poll worked. The engine has two success callbacks and the wiring used only
 * one of them for each, which is invisible from either class's own tests: an
 * account with auto-confirm on and notifications off never reaches `onPending`,
 * so the notifier's flag was never cleared and every expiry after its first was
 * swallowed for the life of the session.
 */
describe('the engine callbacks in index.ts', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

	const wiring = (() => {
		const start = source.indexOf('const autoConfirm = new AutoConfirmEngine({');
		expect(start, 'the engine is no longer constructed here').toBeGreaterThan(-1);
		return source.slice(start, source.indexOf('\n\t});', start));
	})();

	/**
	 * **Each call is pinned to its own arm, not to the block.**
	 *
	 * A first version asserted only that each string appeared somewhere in the
	 * whole constructor. Moving `notifier.pollSucceeded` from `onOutcome` to
	 * `onPending` left every row green — and that move *is* the defect this
	 * describe was written to guard: `onPending` runs only when notifications are
	 * on, so a confirming account with them off never clears its "already said
	 * sign in again" flag, and every expiry after the first is swallowed.
	 */
	const arm = (name: string): string => {
		const start = wiring.indexOf(`${name}: `);
		expect(start, `the ${name} callback is gone`).toBeGreaterThan(-1);
		const rest = wiring.slice(start + name.length);
		// Up to the next top-level callback key, which sits at this indent.
		const end = rest.search(/\n\t\t[a-zA-Z]+[:(]/);
		return end === -1 ? rest : rest.slice(0, end);
	};

	it.each([
		['onOutcome', 'notifier.pollSucceeded(steamId64)'],
		['onOutcome', 'activity.recordPass('],
		['onPending', 'activity.notePollSucceeded(steamId64)'],
		['onPending', 'notifier.pending('],
		['onFailure', 'notifier.halted('],
		['onSignInNeeded', 'activity.recordSignInRequired(steamId64)'],
		['onSignInNeeded', 'notifier.signInNeeded(steamId64, accountName)']
	])('%s calls %s', (name, call) => {
		expect(arm(name), `${call} is not in ${name}, so it fires under the wrong condition`).toContain(
			call
		);
	});

	/*
	 * And the halt toast is gated on the halt. Without that guard every ordinary
	 * transient failure raises "Automatic confirmation stopped after 10
	 * failures", once per poll — a sentence that is false and an alarm that is
	 * constant.
	 */
	it('raises the halt toast only on a halt', () => {
		expect(arm('onFailure')).toContain('if (halted && context)');
	});
});
