import { describe, expect, it } from 'vitest';
import { initialNavigationTimeoutMessage } from '../src/main/browser/window';

/**
 * **The sentence a user reads at the worst moment.**
 *
 * A window that never finished loading is closed, and this is all the reader
 * gets. It used to say "check this account's proxy" to everyone, so an account
 * with no proxy was sent looking for a setting that does not exist — and, worse,
 * told in passing that the application had routed through one it was never
 * given. The founder hit exactly that and reported the message as wrong before
 * reporting anything else.
 *
 * So the sentence has to know which route the window used.
 */
describe('the message for a window that never loaded', () => {
	const timeout = /did not finish loading within 30 seconds/;

	it('does not mention a proxy for an account that has none', () => {
		const message = initialNavigationTimeoutMessage({ route: 'direct' });
		expect(message).toMatch(timeout);
		expect(
			message,
			'an account with no proxy is told to check its proxy, which sends the reader after a ' +
				'setting that is not there and implies a route the application was never given'
		).not.toMatch(/proxy/i);
		expect(message).toMatch(/your network connection/);
	});

	/*
	 * A route can be chosen while the proxy is empty — that combination is
	 * refused elsewhere, but this sentence must not be the thing that assumes it
	 * cannot happen.
	 */
	it.each([
		['proxy', undefined],
		['proxy', ''],
		['steam-only', undefined],
		['steam-only', '']
	] as const)('says network only when route is %s but no proxy is set', (route, proxyUrl) => {
		expect(initialNavigationTimeoutMessage({ route, proxyUrl })).not.toMatch(/proxy/i);
	});

	/*
	 * And the routed case keeps what it was for. A proxied window that times out
	 * genuinely might be the proxy — the timeout cannot tell which hop failed, so
	 * it names both rather than guessing.
	 */
	it.each(['proxy', 'steam-only'] as const)('names the proxy and the network on %s', (route) => {
		const message = initialNavigationTimeoutMessage({
			route,
			proxyUrl: 'http://user:pass@proxy.example:8080'
		});
		expect(message).toMatch(timeout);
		expect(
			message,
			'a routed window stopped naming the proxy, which is the first thing to check when the ' +
				'hop the application added is the one that failed'
		).toMatch(/this account's proxy and your network/);
	});

	/*
	 * Never the credentials. This sentence reaches the renderer and a support
	 * screenshot, and the proxy URL carries a username and password.
	 */
	it.each(['direct', 'proxy', 'steam-only'] as const)(
		'never quotes the proxy URL on %s',
		(route) => {
			const message = initialNavigationTimeoutMessage({
				route,
				proxyUrl: 'http://user:hunter2@proxy.example:8080'
			});
			expect(message).not.toContain('hunter2');
			expect(message).not.toContain('proxy.example');
		}
	);
});
