import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type PagesModule = typeof import('../site/pages/index.mjs', {
	with: { 'resolution-mode': 'import' }
});
type BuildModule = typeof import('../site/build.mjs', {
	with: { 'resolution-mode': 'import' }
});

let pages: PagesModule;
let build: BuildModule;

beforeAll(async () => {
	pages = await import('../site/pages/index.mjs');
	build = await import('../site/build.mjs');
});

describe('download destinations work without a review prompt or platform detection', () => {
	const page = () => pages.PAGES.find((entry) => entry.slug === 'download')!;
	const html = () => page().body(build.SITE);
	const facts = () =>
		build.SITE as {
			repo: string;
			store: { url: string };
			softonic: { url: string };
			uptodown: { url: string };
			publication: { github: { latestVersion: string } };
		};

	it('offers all four official destinations as ordinary links', () => {
		const anchors = [...html().matchAll(/<a\b([^>]*)href="([^"]+)"([^>]*)>/g)];
		for (const destination of [
			facts().store.url,
			`${facts().repo}/releases/tag/v${facts().publication.github.latestVersion}`,
			facts().softonic.url,
			facts().uptodown.url
		]) {
			const matches = anchors.filter((anchor) => anchor[2] === destination);
			expect(matches.length, destination).toBeGreaterThan(0);
			for (const anchor of matches) {
				expect(`${anchor[1]} ${anchor[3]}`).not.toMatch(/\bonclick\s*=|data-got-it/);
			}
		}
	});

	it('does not load a page-specific click interceptor or render a review dialog', () => {
		const script = (page() as ReturnType<typeof page> & { script?: string }).script;
		expect(script).toBeUndefined();
		expect(html()).not.toMatch(/data-review-prompt|data-review-continue|aria-modal="true"/);
	});

	it('leaves platform selection available without a detected browser platform', () => {
		expect(html()).not.toMatch(/data-platform=/);
		const css = readFileSync(join(__dirname, '..', 'site', 'assets', 'site.css'), 'utf8');
		expect(css).not.toMatch(/\[data-platform=/);
	});

	it('describes the old preference as retired, rather than claiming it is still set', () => {
		const privacy = pages.PAGES.find((entry) => entry.slug === 'privacy')!.body(build.SITE);
		expect(privacy).toContain('oda.review-prompt.dismissed');
		expect(privacy).toContain('no longer reads or writes');
		expect(privacy).not.toContain('The download page remembers a flag');
	});
});
