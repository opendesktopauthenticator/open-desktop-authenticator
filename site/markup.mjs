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
				<div class="ask-actions">
					<a class="button" href="${s.reviews.write}" rel="noopener nofollow">Write a review →</a>
					<a class="button button-quiet" href="${s.reviews.profile}" rel="noopener nofollow">Read the reviews</a>
				</div>
			</aside>`;
}
