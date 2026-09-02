/**
 * Markup helpers shared by the builder and the pages it builds.
 *
 * These live outside `build.mjs` for a structural reason rather than a tidiness
 * one. `build.mjs` imports the page list, and the pages need `reviewAsk` — so
 * exporting it from the builder made a cycle (`guides → build → index → guides`)
 * that left `download` uninitialised at the moment the page list was assembled.
 * A module that imports nothing cannot be part of a cycle.
 */

export const escape = (s) =>
	String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

/**
 * Ask for a review, naming the thing being reviewed.
 *
 * Takes the sentence describing what the reader just got, because a block that
 * says "enjoying the app? leave us a review!" on a page about how somebody lost
 * three thousand pounds of inventory is asking a stranger to vouch for
 * something they have not used. Each placement supplies its own reason, and a
 * page with no reason does not get one of these.
 *
 * Never on the home page and never in a banner. The ask goes after the thing it
 * is asking about, which is the only position where it is a request rather than
 * an interruption.
 */
/**
 * Trustpilot's Review Collector, as markup.
 *
 * The box people actually type in. Everything about it is public — the
 * identifiers appear in the source of every site that embeds one — and the
 * anchor inside it is not decoration: it is what a reader sees when the script
 * is blocked, which on a privacy-minded audience is a real fraction of them.
 * Losing the widget should cost the reader a click, not the whole invitation.
 */
export function reviewCollector(s) {
	const w = s.reviews.widget;
	return `<div
						class="trustpilot-widget"
						data-locale="${escape(w.locale)}"
						data-template-id="${escape(w.templateId)}"
						data-businessunit-id="${escape(w.businessUnitId)}"
						data-style-height="52px"
						data-style-width="100%"
						data-token="${escape(w.token)}"
					>
						<a href="${escape(s.reviews.profile)}" target="_blank" rel="noopener nofollow">Trustpilot</a>
					</div>`;
}

export function reviewAsk(s, { got }) {
	return `			<aside class="ask">
				<div class="ask-body">
					<h2>${escape(got)}</h2>
					<p>
						An authenticator nobody has vouched for looks exactly like one nobody
						should trust — which is the whole problem this site is about. A review on
						a platform we do not own is something the next person can check without
						taking our word for it, the same as a checksum or the source.
					</p>
					<p class="hint">
						Nothing is offered in return and nothing is filtered: the profile is
						public and negative reviews stay up. If the honest answer is that this did
						not help, that is worth writing too.
					</p>
				</div>
				<div class="ask-collector">${reviewCollector(s)}</div>
				<div class="ask-actions">
					<a class="button" href="${s.reviews.write}" rel="noopener nofollow">Write a review →</a>
					<a class="button button-quiet" href="${s.reviews.profile}" rel="noopener nofollow">Read the reviews</a>
				</div>
			</aside>`;
}

/**
 * The distance between what the release pipeline does today and what it should
 * eventually do, derived from the flags rather than written out by hand.
 *
 * `build.mjs` states the rule this exists to enforce: every status claim on the
 * site renders from the release object. Two pages had drifted from it anyway —
 * both still said the checksum list was unsigned long after it was signed —
 * because they described the gaps in prose instead of deriving them. Prose does
 * not follow a flag; this does.
 *
 * Each gap carries three phrasings because the call sites need different
 * grammar: `clause` completes "what is missing is …", `noun` completes "not yet
 * done: …", and `sentence` stands on its own — the FAQ gives each gap its
 * consequence rather than just its name, which is the most useful form and the
 * one worth keeping when the list became derived.
 */
const RELEASE_GAPS = [
	{
		open: (r) => !(r.checksums && r.signed),
		clause: 'nothing signs the checksum list',
		noun: 'signing that checksum list',
		sentence:
			'Nothing signs the checksum list, so take it from the release page itself ' +
			'rather than from wherever you got the installer.'
	},
	{
		open: (r) => !r.codeSigned,
		clause: 'the direct downloads carry no code-signing certificate',
		noun: 'a code-signing certificate for the direct downloads',
		sentence: 'The direct downloads carry no code-signing certificate, so Windows warns on them.'
	},
	{
		open: (r) => !r.reproducible,
		clause: 'builds are not yet reproducible',
		noun: 'reproducible builds you could compare byte for byte',
		// Standalone on purpose. This used to read "are further out still", which
		// only parses while something precedes it — and once the list is derived,
		// nothing is guaranteed to.
		sentence:
			'Builds are not yet reproducible: you cannot compile the tag yourself and ' +
			'get byte-for-byte identical output.'
	},
	{
		open: (r) => !r.audited,
		clause: 'no independent audit has happened',
		noun: 'an independent audit',
		sentence: 'No independent audit has happened.'
	}
];

/** The gaps still open, in whichever phrasing the call site needs. */
export const releaseGaps = (s, form = 'clause') =>
	RELEASE_GAPS.filter((g) => g.open(s.release)).map((g) => g[form]);

/** "a", "a and b", "a, b, and c". The serial comma is deliberate. */
export function sentenceList(items) {
	if (items.length <= 1) return items[0] ?? '';
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/** "One thing is", "Two things are" — the verb agreement changes with the count. */
export function countPhrase(n) {
	if (n === 0) return 'Nothing is';
	if (n === 1) return 'One thing is';
	return `${['', '', 'Two', 'Three', 'Four', 'Five'][n] ?? n} things are`;
}
