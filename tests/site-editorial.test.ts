import { beforeAll, describe, expect, it } from 'vitest';

type EditorialModule = typeof import('../site/editorial.mjs', {
	with: { 'resolution-mode': 'import' }
});
type PagesModule = typeof import('../site/pages/index.mjs', {
	with: { 'resolution-mode': 'import' }
});
type BuildModule = typeof import('../site/build.mjs', {
	with: { 'resolution-mode': 'import' }
});
type QualityModule = typeof import('../site/quality.mjs', {
	with: { 'resolution-mode': 'import' }
});

let editorial: EditorialModule;
let pages: PagesModule;
let build: BuildModule;
let quality: QualityModule;

beforeAll(async () => {
	editorial = await import('../site/editorial.mjs');
	pages = await import('../site/pages/index.mjs');
	build = await import('../site/build.mjs');
	quality = await import('../site/quality.mjs');
});

const indexed = () => pages.PAGES.filter((page) => !page.noindex);

describe('the editorial publication gate', () => {
	it('covers every indexable page and no retired URL', () => {
		expect(indexed()).toHaveLength(31);
		expect(Object.keys(editorial.EDITORIAL_BY_SLUG).sort()).toEqual(
			indexed()
				.map((page) => page.slug)
				.sort()
		);
	});

	it.each(['value', 'evidence'] as const)(
		'requires a unique, substantive, plain-text %s',
		(field) => {
			const statements = indexed().map((page) => page.editorial?.[field].trim() ?? '');
			expect(statements.every((statement) => statement.length >= 80)).toBe(true);
			expect(
				statements.every((statement) => editorial.editorialStatementProblem(statement) === null)
			).toBe(true);
			expect(new Set(statements.map((statement) => statement.toLowerCase())).size).toBe(
				statements.length
			);
		}
	);

	it.each(['TODO', 'FIXME', 'TKTK', 'PLACEHOLDER', '<!-- editorial note -->', '<b>value</b>'])(
		'rejects %s in otherwise long editorial text',
		(marker) => {
			expect(
				editorial.editorialStatementProblem(`${'Useful evidence. '.repeat(8)} ${marker}`)
			).not.toBeNull();
		}
	);

	it('keeps the records as review data rather than mutating the page definitions', () => {
		const original = pages.PAGES.map((page) => {
			const copy = { ...page };
			delete copy.editorial;
			return copy;
		});
		const attached = editorial.attachEditorial(original);
		const originalHome = original.find((page) => page.slug === 'index');
		const attachedHome = attached.find((page) => page.slug === 'index');

		expect(attached).not.toBe(original);
		expect(attachedHome).not.toBe(originalHome);
		expect(attachedHome?.editorial).toBe(editorial.EDITORIAL_BY_SLUG.index);
		expect(originalHome).not.toHaveProperty('editorial');
	});

	it('connects every publication case to concrete evidence in its own article', () => {
		for (const page of indexed()) {
			const proofs = page.editorial?.proofs ?? [];
			expect(proofs.length, page.slug).toBeGreaterThanOrEqual(2);
			expect(proofs.length, page.slug).toBeLessThanOrEqual(3);
			expect(new Set(proofs).size, page.slug).toBe(proofs.length);
			const article = quality.editorialBodyOf(page.body(build.SITE));
			for (const proof of proofs) {
				expect(article, `${page.slug}: ${proof}`).toContain(proof);
			}
		}
	});

	it('allows a noindex utility page to omit an editorial record', () => {
		const allLedgerPages = Object.keys(editorial.EDITORIAL_BY_SLUG).map((slug) => ({ slug }));
		const attached = editorial.attachEditorial([...allLedgerPages, { slug: '404', noindex: true }]);
		expect(attached.at(-1)).not.toHaveProperty('editorial');
	});

	it('rejects a new indexable page with no publication case', () => {
		expect(() => editorial.attachEditorial([{ slug: 'unreviewed-page' }])).toThrow(
			/Missing editorial record.*unreviewed-page/
		);
	});

	it('rejects a ledger record after its page has been removed', () => {
		const missingPrivacy = Object.keys(editorial.EDITORIAL_BY_SLUG)
			.filter((slug) => slug !== 'privacy')
			.map((slug) => ({ slug }));
		expect(() => editorial.attachEditorial(missingPrivacy)).toThrow(
			/Editorial record has no page: privacy/
		);
	});

	it('exports immutable records', () => {
		const record = editorial.EDITORIAL_BY_SLUG.security!;
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.proofs)).toBe(true);
		expect(Object.isFrozen(editorial.EDITORIAL_BY_SLUG)).toBe(true);
	});
});
