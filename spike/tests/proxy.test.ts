import { beforeEach, describe, expect, it } from 'vitest';
import {
	assertBothTransportsProxied,
	communityRequest,
	createAgents,
	loginSessionOptions,
	parseProxy,
	ProxyError,
	proxyForAccount
} from '../src/proxy';
import { clearRegisteredSecrets, scrub } from '../src/redact';

describe('proxy config parsing', () => {
	beforeEach(() => {
		clearRegisteredSecrets();
		delete process.env.SPIKE_PROXY;
		delete process.env.SPIKE_PROXY_TRADER_ONE;
	});

	it('accepts the schemes users actually have', () => {
		for (const url of [
			'http://host:8080',
			'https://host:8443',
			'socks5://host:1080',
			'socks5h://host:1080',
			'socks4://host:1080'
		]) {
			expect(() => parseProxy(url)).not.toThrow();
		}
	});

	it('rejects a scheme we cannot actually honour', () => {
		expect(() => parseProxy('ftp://host:21')).toThrow(ProxyError);
		expect(() => parseProxy('ftp://host:21')).toThrow(/unsupported proxy scheme/);
	});

	it('rejects garbage rather than silently running unproxied', () => {
		expect(() => parseProxy('not a url')).toThrow(ProxyError);
		// WHATWG URL parsing rejects an out-of-range port before we get to see it,
		// so this surfaces as a parse failure rather than a port failure.
		expect(() => parseProxy('socks5://host:99999')).toThrow(/could not parse/);
	});

	it('rejects port 0, which URL parsing accepts but nothing can connect to', () => {
		expect(() => parseProxy('socks5://host:0')).toThrow(/not a valid port/);
	});

	it('defaults the port per scheme', () => {
		expect(parseProxy('socks5://host').port).toBe(1080);
		expect(parseProxy('http://host').port).toBe(8080);
	});

	it('never puts proxy credentials in the display string', () => {
		const proxy = parseProxy('socks5://alice:hunter2pass@10.0.0.1:1080');
		expect(proxy.hasCredentials).toBe(true);
		expect(proxy.display).toBe('socks5://<credentials>@10.0.0.1:1080');
		expect(proxy.display).not.toContain('alice');
		expect(proxy.display).not.toContain('hunter2pass');
	});

	it('registers the proxy password as a secret so it cannot be logged', () => {
		parseProxy('http://alice:hunter2pass@10.0.0.1:8080');
		expect(scrub('connect failed: hunter2pass rejected')).toBe(
			'connect failed: [REDACTED] rejected'
		);
		expect(scrub('url=http://alice:hunter2pass@10.0.0.1:8080')).toBe('url=[REDACTED]');
	});

	it('registers the DECODED password, not just the percent-encoded form', () => {
		// `new URL(...).password` returns the value still encoded: `p%40sswordX` for
		// `p@sswordX`. Registering only that leaves the decoded form — which is what
		// a library or an error message actually prints — unscrubbed.
		parseProxy('http://user:p%40sswordX@10.0.0.1:8080');
		expect(scrub('connect failed: p%40sswordX')).toBe('connect failed: [REDACTED]');
		expect(scrub('connect failed: p@sswordX')).toBe('connect failed: [REDACTED]');
	});

	it('registers the decoded USERNAME too, not just the password', () => {
		// `URL.username` is percent-encoded exactly like `URL.password`. Fixing only
		// the password left `user@name` in the clear for `user%40name`.
		parseProxy('http://user%40name:p%40ss@10.0.0.5:8080');
		expect(scrub('user=user@name')).toBe('user=[REDACTED]');
		expect(scrub('user=user%40name')).toBe('user=[REDACTED]');
	});

	it('scrubs a short proxy password that the default threshold would skip', () => {
		// 7 characters, below the 8-char default floor.
		parseProxy('http://u:secret7@10.0.0.2:8080');
		expect(scrub('rejected: secret7')).toBe('rejected: [REDACTED]');
	});

	it('leaves a credential-free proxy printable, so status output stays readable', () => {
		const proxy = parseProxy('socks5h://127.0.0.1:1080');
		// Registering this URL would make it identical to the display string and
		// scrub our own "routing via ..." line into [REDACTED].
		expect(scrub(`routing via ${proxy.display}`)).toBe('routing via socks5h://127.0.0.1:1080');
	});
});

describe('per-account routing', () => {
	beforeEach(() => {
		clearRegisteredSecrets();
		delete process.env.SPIKE_PROXY;
		delete process.env.SPIKE_PROXY_TRADER_ONE;
	});

	it('returns nothing when no proxy is set', () => {
		expect(proxyForAccount('trader-one')).toBeUndefined();
	});

	it('treats an empty value as unset rather than as a broken proxy', () => {
		process.env.SPIKE_PROXY = '   ';
		expect(proxyForAccount('trader-one')).toBeUndefined();
	});

	it('prefers the per-account proxy over the global one', () => {
		process.env.SPIKE_PROXY = 'socks5://global:1080';
		process.env.SPIKE_PROXY_TRADER_ONE = 'socks5://specific:1080';
		expect(proxyForAccount('trader-one')?.host).toBe('specific');
		expect(proxyForAccount('someone-else')?.host).toBe('global');
	});
});

describe('fail-closed transport check', () => {
	for (const url of ['socks5h://host:1080', 'http://host:8080']) {
		it(`points every transport at one shared agent for ${url}`, () => {
			const proxy = parseProxy(url);
			const agents = createAgents(proxy);
			const login = loginSessionOptions(agents);
			const community = communityRequest(agents);

			// The whole design rests on this: same instance everywhere, so the
			// egress guard can tell "our proxy" from "some other agent".
			expect(login.agent).toBe(agents.https);
			expect(community.appliedVia).toBe('shared-agent');
			expect(() => assertBothTransportsProxied(proxy, login, community)).not.toThrow();
		});
	}

	it('reuses a single agent for both protocols when using SOCKS', () => {
		const agents = createAgents(parseProxy('socks5h://host:1080'));
		expect(agents.http).toBe(agents.https);
	});

	it('refuses to run when the confirmation transport is unproxied', () => {
		const proxy = parseProxy('socks5://host:1080');
		const login = loginSessionOptions(createAgents(proxy));

		expect(() => assertBothTransportsProxied(proxy, login, communityRequest(undefined))).toThrow(
			/confirmation transport/
		);
	});

	it('refuses to run when the login transport is unproxied', () => {
		const proxy = parseProxy('socks5://host:1080');
		const community = communityRequest(createAgents(proxy));

		expect(() => assertBothTransportsProxied(proxy, {}, community)).toThrow(/login transport/);
	});

	it('does not complain when no proxy was asked for', () => {
		expect(() =>
			assertBothTransportsProxied(undefined, {}, communityRequest(undefined))
		).not.toThrow();
	});
});
