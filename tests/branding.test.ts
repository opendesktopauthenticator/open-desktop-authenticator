import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	attribution,
	branding,
	hasUnresolvedBranding,
	PRODUCT_NAME_PLACEHOLDER,
	unresolvedBrandingFields
} from '../src/shared/branding';
import {
	isAllowedNavigation,
	isOpenableExternally,
	type NavigationTarget
} from '../src/shared/security-policy';

/**
 * Every name-dependent value is now real (D12). These tests exist to keep it
 * that way, and to guard the failure mode that nearly shipped once: the visible
 * fields getting real values while a placeholder application id went out
 * underneath them.
 *
 * **What this file cannot check:** that `repository` resolves to a repository
 * that exists. It only proves the string is not a placeholder. Confirming the
 * organisation is real, is ours, and matches `/official` is a human step on the
 * release checklist — and it is the link the entire verification chain hangs on.
 */
/** Read rather than imported, so this asserts against the real file on disk. */
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
	name: string;
	author: string;
	description: string;
};

describe('branding placeholders', () => {
	it('reports no unresolved fields', () => {
		expect(hasUnresolvedBranding()).toBe(false);
		expect(unresolvedBrandingFields()).toEqual([]);
	});

	it('points at a plausible GitHub repository', () => {
		// Not proof the org exists — nothing offline can be. It does catch the
		// obvious mistakes: a bare org with no repo, the wrong host, a trailing
		// path, or someone pasting the website in by accident.
		expect(branding.repository).toMatch(
			/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
		);
		expect(branding.repository).not.toContain('opendesktopauthenticator.com');
	});

	it('has a resolved product name, app id and website', () => {
		for (const field of ['productName', 'appId', 'website'] as const) {
			expect(unresolvedBrandingFields(), field).not.toContain(field);
			expect(branding[field]).not.toContain(PRODUCT_NAME_PLACEHOLDER);
			expect(branding[field]).not.toContain('product-name-placeholder');
		}
	});

	it('derives the app id from the domain actually owned', () => {
		// Reverse-DNS of opendesktopauthenticator.com. A mismatch here surfaces as
		// installer and update-channel weirdness long after anyone remembers why.
		expect(branding.appId).toBe('com.opendesktopauthenticator.desktop');
		expect(branding.website).toBe('https://opendesktopauthenticator.com');
	});

	it('offers a short name and binary name for tight spaces', () => {
		expect(branding.shortName).toBe('ODA');
		expect(branding.binaryName).toBe('oda');
	});

	it('keeps the package name in step with the product name', () => {
		// This is not tidiness. `app.getPath('userData')` is derived from
		// `app.getName()`, which falls back to package.json's `name` — so this
		// string decides where the vault lives. Changing the product name without
		// changing this, or the reverse, moves the directory and every existing
		// vault becomes invisible to the app that wrote it. No migration exists.
		const slug = branding.productName.toLowerCase().replace(/\s+/g, '-');
		expect(pkg.name).toBe(slug);
		expect(pkg.author).toBe(branding.company);
		expect(pkg.description).toContain(branding.productName);
	});

	it('does not flag the company, which is settled', () => {
		expect(unresolvedBrandingFields()).not.toContain('company');
		expect(branding.company).toBe('MASTERPANEL LLC');
	});

	it('keeps Steam and Valve marks out of the product identity (§7.2)', () => {
		for (const field of ['productName', 'appId', 'website', 'repository'] as const) {
			expect(branding[field]).not.toMatch(/steam|valve/i);
		}
	});

	it('phrases attribution as attribution, never endorsement (§8)', () => {
		expect(attribution.mckay).toContain('not affiliated with or endorsed by DoctorMcKay');
		expect(attribution.valve).toContain('Not affiliated with, endorsed by, or sponsored by Valve');
		// "powered by" implies backing, which §8 explicitly forbids.
		expect(attribution.mckay).not.toMatch(/powered by/i);
	});
});

/**
 * Regression tests for the packaged navigation lock.
 *
 * Every `file:` URL serialises to the origin `"null"`, so an origin comparison
 * in a packaged build compares `"null"` to `"null"` and lets the window navigate
 * to any local file on the machine.
 */
describe('navigation lock', () => {
	const packaged: NavigationTarget = {
		kind: 'file',
		href: 'file:///H:/app/out/renderer/index.html'
	};
	const dev: NavigationTarget = { kind: 'origin', origin: 'http://localhost:5173' };

	it('allows exactly the bundled entry point', () => {
		expect(isAllowedNavigation('file:///H:/app/out/renderer/index.html', packaged)).toBe(true);
	});

	it('rejects a file: URL carrying a remote host, however matching the path', () => {
		// `file://evil.com/H:/...` has the same pathname as ours but is a UNC path —
		// a document served from a remote SMB share. Comparing pathnames alone
		// accepted it, for navigation AND for IPC trust, since both use this
		// predicate.
		expect(isAllowedNavigation('file://evil.com/H:/app/out/renderer/index.html', packaged)).toBe(
			false
		);
		expect(isAllowedNavigation('file://127.0.0.1/H:/app/out/renderer/index.html', packaged)).toBe(
			false
		);
	});

	it('accepts a literal localhost host, which the URL parser normalises away', () => {
		// Per the URL spec, a `file:` URL whose host is exactly "localhost" is
		// normalised to an empty host — `new URL(...).host === ''`. It therefore
		// denotes the identical local file, and accepting it is correct rather than
		// a gap. A numeric host like 127.0.0.1 is NOT normalised and stays rejected.
		expect(new URL('file://localhost/H:/x').host).toBe('');
		expect(isAllowedNavigation('file://localhost/H:/app/out/renderer/index.html', packaged)).toBe(
			true
		);
	});

	it('blocks any other local file', () => {
		expect(isAllowedNavigation('file:///C:/Windows/System32/evil.html', packaged)).toBe(false);
		expect(isAllowedNavigation('file:///H:/app/out/renderer/../../secrets.txt', packaged)).toBe(
			false
		);
	});

	it('treats a case-flipped path as the same file only where paths are case-insensitive', () => {
		const flipped = 'file:///H:/APP/OUT/RENDERER/INDEX.HTML';
		expect(isAllowedNavigation(flipped, packaged, { caseInsensitivePaths: true })).toBe(true);
		expect(isAllowedNavigation(flipped, packaged, { caseInsensitivePaths: false })).toBe(false);
	});

	it('ignores query and fragment on the allowed file', () => {
		expect(isAllowedNavigation('file:///H:/app/out/renderer/index.html#/vault', packaged)).toBe(
			true
		);
		expect(isAllowedNavigation('file:///H:/app/out/renderer/index.html?x=1', packaged)).toBe(true);
	});

	it('blocks remote origins in a packaged build', () => {
		expect(isAllowedNavigation('https://evil.example/', packaged)).toBe(false);
		expect(isAllowedNavigation('http://localhost:5173/', packaged)).toBe(false);
	});

	it('never lets a file: URL satisfy an origin target', () => {
		// Both serialise to origin "null"; a naive origin comparison would pass.
		expect(isAllowedNavigation('file:///C:/Windows/System32/evil.html', dev)).toBe(false);
	});

	it('allows the dev server and nothing else in dev', () => {
		expect(isAllowedNavigation('http://localhost:5173/index.html', dev)).toBe(true);
		expect(isAllowedNavigation('http://localhost:5174/', dev)).toBe(false);
		expect(isAllowedNavigation('https://evil.example/', dev)).toBe(false);
	});

	it('hands only allowlisted hosts to the OS browser', () => {
		// From milestone 0.1 the UI renders attacker-influenced text: item names,
		// counterparties, confirmation descriptions. A crafted link there must not
		// be able to send someone anywhere via a click that looks like it came from
		// their authenticator.
		for (const good of [
			'https://steamcommunity.com/tradeoffer/1',
			'https://help.steampowered.com/en/',
			'https://github.com/example/repo'
		]) {
			expect(isOpenableExternally(good), good).toBe(true);
		}

		for (const bad of [
			'https://evil.test/phish',
			// Suffix confusion: must not match by "ends with steamcommunity.com".
			'https://steamcommunity.com.evil.test/',
			'https://notsteamcommunity.com/',
			// Non-http schemes are a way to launch something, not to show a page.
			'file:///C:/Windows/System32/calc.exe',
			'javascript:alert(1)',
			'ms-msdt:/id',
			'not a url'
		]) {
			expect(isOpenableExternally(bad), bad).toBe(false);
		}
	});

	it('rejects malformed and non-http schemes', () => {
		for (const bad of ['not a url', 'javascript:alert(1)', 'data:text/html,<h1>x', 'about:blank']) {
			expect(isAllowedNavigation(bad, packaged), bad).toBe(false);
			expect(isAllowedNavigation(bad, dev), bad).toBe(false);
		}
	});
});

describe('the application says who publishes it', () => {
	/**
	 * The gap this covers.
	 *
	 * `app:info` carried the publisher and the attribution strings from the day
	 * the channel was written — the handler describes itself as metadata "for the
	 * About screen" — and there was no About screen. Every one of those values
	 * crossed the bridge and went nowhere, so the application named its publisher
	 * precisely nowhere in its own interface.
	 *
	 * §4's answer to the clone problem is a chain a suspicious person can walk:
	 * the running application names a company, the company can be looked up, the
	 * repository read, the build checked. These assert the first links exist.
	 */
	it('exposes the publisher and the places to check it', () => {
		expect(branding.company).toBe('MASTERPANEL LLC');
		expect(branding.companyShort).toBe('MASTERPANEL');
		expect(branding.companyWebsite).toMatch(/^https:\/\//);
		expect(branding.website).toMatch(/^https:\/\//);
		expect(branding.repository).toMatch(/^https:\/\/github\.com\//);
	});

	it('can actually open its own site and its publisher', () => {
		// The links were unreachable before this: the external-link allowlist held
		// Steam, Valve and GitHub, and neither our own domain nor the company's.
		// A "powered by" link that silently does nothing is worse than none — it
		// looks like the check failed rather than that it was never wired up.
		expect(isOpenableExternally(branding.companyWebsite)).toBe(true);
		expect(isOpenableExternally(branding.website)).toBe(true);
		expect(isOpenableExternally(branding.repository)).toBe(true);
	});

	it('still refuses somewhere it was not asked to go', () => {
		// The allowlist exists because this UI renders attacker-influenced text —
		// item names, trade counterparties. Adding two first-party domains must not
		// have turned it into "anything https".
		expect(isOpenableExternally('https://evil.example')).toBe(false);
		expect(isOpenableExternally('https://masterspanel.com.evil.example')).toBe(false);
		expect(isOpenableExternally('https://opendesktopauthenticator.com.evil.example')).toBe(false);
		expect(isOpenableExternally('javascript:alert(1)')).toBe(false);
	});

	it('keeps the attribution wording exact', () => {
		// Rendered verbatim by About (§8). Worded to credit without implying
		// endorsement, which is a distinction that does not survive paraphrase.
		expect(attribution.mckay).toContain('steam-session');
		expect(attribution.mckay).toContain('not affiliated with or endorsed by DoctorMcKay');
		expect(attribution.valve).toContain('Not affiliated with, endorsed by, or sponsored by Valve');
	});
});
