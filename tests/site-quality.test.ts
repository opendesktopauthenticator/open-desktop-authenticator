import { beforeAll, describe, expect, it } from 'vitest';

type QualityModule = typeof import('../site/quality.mjs', {
	with: { 'resolution-mode': 'import' }
});

let quality: QualityModule;

beforeAll(async () => {
	quality = await import('../site/quality.mjs');
});

describe('site publication dates', () => {
	const now = new Date('2026-09-07T22:30:00Z'); // 8 September in the publication timezone

	it.each(['2026-09-08', '2024-02-29'])(`accepts the real date %s`, (value) => {
		expect(quality.calendarDateProblem(value, now)).toBeNull();
	});

	it('formats the visible date from the same ISO value', () => {
		expect(quality.formatPublicationDate('2026-09-08')).toBe('8 September 2026');
	});

	it.each([
		['2026-9-08', 'explicit YYYY-MM-DD'],
		['2026-02-29', 'real calendar date'],
		['2026-13-01', 'real calendar date'],
		['2026-00-10', 'real calendar date'],
		['2026-09-09', 'future']
	])('rejects %s because it is not a truthful publication date', (value, reason) => {
		expect(quality.calendarDateProblem(value, now)).toContain(reason);
	});
});

describe('guide source notes', () => {
	it('accepts substantive visible copy linked to public HTTPS evidence', () => {
		expect(
			quality.sourceNoteProblem(
				'Checked against <a href="https://docs.github.com/en/actions">the published reference documentation</a>.'
			)
		).toBeNull();
	});

	it('does not mistake words in a URL path for hidden-link attributes', () => {
		expect(
			quality.sourceNoteProblem(
				'Checked against <a href="https://docs.github.com/style/hidden/reference">the published reference documentation</a>.'
			)
		).toBeNull();
	});

	it.each([
		['A substantive source note with no evidence link at all.', 'link its evidence'],
		[
			'A substantive note pointing to <a href="#">a placeholder rather than evidence</a>.',
			'public HTTPS'
		],
		[
			'A substantive note pointing to <a href="http://example.com/source">an insecure source</a>.',
			'public HTTPS'
		],
		[
			'A substantive note pointing to <a href="https://example.com/source"></a> without a label.',
			'no visible label'
		],
		[
			'A substantive note pointing to <a href="https://example.com/source">a placeholder host</a>.',
			'public HTTPS'
		],
		[
			'A substantive note pointing to <a href="https://127.0.0.1/source">a private host</a>.',
			'public HTTPS'
		],
		[
			'A substantive note with <!-- <a href="https://docs.github.com/source">hidden evidence</a> --> only.',
			'HTML comment'
		],
		[
			'A substantive note with <template><a href="https://docs.github.com/source">hidden evidence</a></template>.',
			'unsupported'
		],
		[
			'<strong data-padding="this attribute is deliberately long but invisible">Short</strong>',
			'30 visible'
		]
	])('rejects a non-evidential source note', (source, reason) => {
		expect(quality.sourceNoteProblem(source)).toContain(reason);
	});
});

describe('authored article extraction', () => {
	it('removes generated publication and navigation furniture', () => {
		const html = `<main><article>
			<h1>Actual answer</h1>
			<!-- A proof hidden in a comment -->
			<template>A proof hidden in a template</template>
			<p hidden>A proof hidden with the hidden attribute</p>
			<div class="guide-meta">Repeated source and author copy</div>
			<nav class="jump"><p>On this page</p><ul><li>Repeated heading</li></ul></nav>
			<h2 id="answer">Real detail<a class="anchor" href="#answer">#</a></h2>
			<p>The fact that belongs to this page.</p>
			<aside class="ask">Repeated review solicitation</aside>
		</article></main>`;
		const body = quality.editorialBodyOf(html);

		expect(body).toContain('Actual answer');
		expect(body).toContain('The fact that belongs to this page.');
		expect(body).not.toContain('Repeated source');
		expect(body).not.toContain('hidden in');
		expect(body).not.toContain('On this page');
		expect(body).not.toContain('review solicitation');
		expect(body).not.toContain('class="anchor"');
	});
});

describe('exact wording overlap', () => {
	const token = (index: number) => {
		const first = String.fromCharCode(97 + (index % 26));
		const second = String.fromCharCode(97 + (Math.floor(index / 26) % 26));
		return `token${first}${second}`;
	};

	it('catches a short article copied into a much longer one', () => {
		const copied = Array.from({ length: 24 }, (_, index) => token(index)).join(' ');
		const paddingBefore = Array.from({ length: 70 }, (_, index) => `before${token(index)}`).join(
			' '
		);
		const paddingAfter = Array.from({ length: 70 }, (_, index) => `after${token(index)}`).join(' ');
		const scores = quality.overlapScores(
			quality.shingles(copied),
			quality.shingles(`${paddingBefore} ${copied} ${paddingAfter}`)
		);

		expect(scores.jaccard).toBeLessThan(quality.JACCARD_LIMIT);
		expect(scores.containment).toBe(1);
		expect(scores.containment).toBeGreaterThanOrEqual(quality.CONTAINMENT_LIMIT);
	});

	it('does not manufacture overlap for empty bodies', () => {
		expect(quality.overlapScores(quality.shingles(''), quality.shingles('')).containment).toBe(0);
	});
});
