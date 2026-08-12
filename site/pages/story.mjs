/**
 * The account of the theft this project came out of.
 *
 * **Told in the first person, unattributed, on purpose.** The voice is what
 * makes it useful — people discount a case study about somebody else — but a
 * name adds nothing a reader can act on and follows one person around for good.
 *
 * The framing is deliberate too. The person this happened to had done it
 * correctly the first time and got the file from the project's own releases.
 * What changed between the first download and the second was the search results,
 * not their judgement. Written as a confession it reads as carelessness and
 * teaches nobody anything; written as what it was — a poisoned result catching
 * somebody mid-routine — it is a warning that applies to careful people, who
 * are most of the ones this happens to.
 *
 * Only details that were stated plainly are here. A number in the original
 * telling was unclear, so it is absent rather than guessed at.
 */

export default {
	slug: 'steam-inventory-stolen',
	navTitle: 'What happened to us',
	title: 'A fake SDA download emptied my Steam inventory',
	description:
		'A first-hand account: a poisoned search result, a two-week wait, and an inventory sold on the Community Market to buy the thief’s own listings.',
	structuredData: (s) => ({
		'@context': 'https://schema.org',
		'@type': 'Article',
		headline: 'A fake SDA download emptied my Steam inventory',
		description:
			'A first-hand account of a counterfeit Steam Desktop Authenticator download and the theft that followed.',
		author: { '@type': 'Organization', name: s.publisher },
		publisher: { '@type': 'Organization', name: s.publisher },
		dateModified: s.updated,
		mainEntityOfPage: `${s.origin}/steam-inventory-stolen`
	}),
	body: () => `
		<article>
			<h1>A fake SDA download emptied my Steam inventory</h1>

			<p class="lede">
				This happened to one of us, about five years ago. It is the reason this project
				exists, and the reason the rest of this site is written the way it is. Nothing
				here is hypothetical.
			</p>

			<h2>I had already done it right once</h2>
			<p>
				I was starting out in trading and I needed Steam Guard on my PC. I got Steam
				Desktop Authenticator the correct way: from the project's own releases page. The
				fake sites existed even then, but they were buried — you had to go looking to
				find one.
			</p>
			<p>
				That is the part I want to be clear about, because it is the part that gets
				missed. I knew where the real one lived. I had already downloaded it from there.
			</p>

			<h2>Then I reinstalled Windows</h2>
			<p>
				Months later I rebuilt the machine, and set about reinstalling everything I
				used. I searched for SDA the way anyone does. This time one of those sites was
				sitting at the top of the results.
			</p>
			<p>
				I did not examine it. I was reinstalling twenty things that afternoon and this
				was the one I had used for months already. It looked like the thing I remembered.
				I downloaded it, set it up, imported my accounts, and it worked — codes, trades,
				confirmations, all of it, exactly as before.
			</p>
			<p>
				<strong>It working is the whole trick.</strong> A build that failed would have
				been deleted within a minute. This one did its job perfectly and copied my
				<a href="/what-is-a-mafile">maFile</a> out at the same time.
			</p>

			<h2>Two weeks of nothing</h2>
			<p>
				Then about a fortnight later I was in a lecture at university and my phone
				started going. Not one notification — a stream of them, emails arriving faster
				than I could read the subject lines.
			</p>

			<h2>What they actually did</h2>
			<p>
				Half my inventory was under a trade hold, so they could not simply trade it
				away. I had genuinely believed that made me relatively safe. It does not, and
				here is the route they used instead:
			</p>
			<ol class="signs">
				<li>
					<strong>They listed and sold the entire inventory on the Community Market.</strong>
					Trade holds do not stop a market sale. Everything went, and the proceeds
					landed in my Steam Wallet.
				</li>
				<li>
					<strong>They spent the balance on their own listings.</strong> They had
					already put up items worth a few cents each, priced enormously. My wallet
					bought them. The money left for an account they controlled and I was holding
					the worthless items.
				</li>
				<li>
					<strong>None of it could be undone.</strong> Wallet funds cannot be withdrawn
					to a bank and market purchases are not refundable. By the time I had read the
					first email it was already finished.
				</li>
			</ol>
			<p>
				Around three thousand dollars, converted into items genuinely worth cents. They
				did not even leave the balance — they emptied it to the last penny, and bought a
				few stickers worth about five dollars with what was left. I have never been able
				to read that as anything other than deliberate.
			</p>

			<h2>What I would tell myself</h2>
			<ul class="plain next">
				<li>
					<strong>The dangerous moment is the reinstall, not the first install.</strong>
					You are moving quickly, restoring things you already trust, and not
					re-examining any of them. That is exactly when the search result gets you.
				</li>
				<li>
					<strong>A trade hold protects the items, not the value.</strong> Anything
					sellable is reachable through the Market. Believing otherwise is what stopped
					me worrying earlier than I should have.
				</li>
				<li>
					<strong>Bookmark the real release page.</strong> Not the search. The search is
					the attack surface.
				</li>
				<li>
					<strong>Check the file, not the website.</strong> A convincing page proves
					nothing. <a href="/verify">A checksum and a signature take a minute</a> and
					prove what you actually have.
				</li>
			</ul>

			<h2>Why this exists</h2>
			<p>
				Because it is still happening, in the same way, to people being no more careless
				than I was. The name still outranks the source, the fake builds still work
				perfectly on the day you install them, and the two-week delay still means almost
				nobody connects the theft back to the download.
			</p>
			<p>
				So <a href="/">this application</a> is built to be checked rather than trusted:
				<a href="${'https://github.com/opendesktopauthenticator/open-desktop-authenticator'}" rel="noopener">public source</a>,
				reproducible builds, published checksums, and
				<a href="/security">a security page that says what it cannot protect you from</a>.
				It cannot update itself, because that is the same door left open.
			</p>
			<p>
				If you use something else, use something else. Just
				<a href="/verify">verify what you downloaded</a> — and if a page like this ever
				becomes your story, <a href="/scam-clones">the recovery steps are here</a> and
				the first one matters more than all the rest.
			</p>
		</article>`
};
