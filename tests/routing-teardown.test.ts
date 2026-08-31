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
		['the enrolment access token', 'enrollment.forgetAccount(steamId64)']
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
