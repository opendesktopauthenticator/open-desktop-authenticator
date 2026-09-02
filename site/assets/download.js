/*
 * Which download to put in front of you.
 *
 * The Store is the right answer for almost everyone on Windows: Microsoft
 * re-signs the package, so SmartScreen never warns, and nobody has to be talked
 * through comparing a hash on the day they are already frightened about their
 * account. The direct downloads exist for people the Store cannot serve — LTSC
 * and Enterprise images with it stripped out, locked-down machines, and the
 * portable build, which has no Store equivalent by definition.
 *
 * So this does not remove a path, it chooses the default. Without JavaScript
 * every option is visible and the Store is listed first, which is the same
 * advice one step less tailored — a page that offers nothing when a script
 * fails would be the wrong trade on a page whose whole job is getting somebody
 * a genuine build.
 */
(function () {
	'use strict';

	var root = document.querySelector('[data-download]');
	if (!root) return;

	/*
	 * `userAgentData` where it exists, the UA string where it does not.
	 *
	 * Deliberately coarse. Getting this wrong in either direction costs a
	 * click on a page that still shows every option, so there is no case for
	 * fingerprinting harder than the question requires — and this site's
	 * privacy page promises the server learns nothing beyond an ordinary
	 * request log, which a narrower check here would start to strain.
	 */
	function platform() {
		var data = navigator.userAgentData;
		var name = (data && data.platform) || navigator.platform || '';
		var agent = navigator.userAgent || '';
		if (/win/i.test(name) || /windows/i.test(agent)) return 'windows';
		if (/linux|x11|ubuntu|fedora/i.test(name + ' ' + agent) && !/android/i.test(agent)) {
			return 'linux';
		}
		return 'other';
	}

	root.setAttribute('data-platform', platform());

	/*
	 * The review ask, shown once a download has actually started.
	 *
	 * The site's rule is that the ask goes after the thing it is asking about,
	 * and on this page that moment is a click on a real download rather than the
	 * page loading. Before it, the reader has received nothing and the request is
	 * an interruption; after it, they are holding the thing.
	 *
	 * Deliberately not a modal. This is a security tool whose entire argument is
	 * that you should check it rather than trust it, and a page that blocks the
	 * screen the instant you download something reads exactly like the sites it
	 * warns about. It appears in the flow of the page, it can be refused, and a
	 * refusal is remembered.
	 */
	var prompt = document.querySelector('[data-review-prompt]');
	if (!prompt) return;

	var DISMISSED = 'oda.review-prompt.dismissed';
	var STARTED = 'oda.review-prompt.started';

	/*
	 * Storage can throw outright — a private window, a browser set to block site
	 * data — and this is a review prompt. It is not worth an exception that stops
	 * the rest of the page, and "we could not remember" resolves to showing the
	 * ask, which is the harmless direction.
	 */
	function remembered(key) {
		try {
			return window.localStorage.getItem(key) === '1';
		} catch {
			return false;
		}
	}
	function forget(key) {
		try {
			window.localStorage.removeItem(key);
		} catch {
			/* the dismissal below is what actually stops it returning */
		}
	}
	function remember(key) {
		try {
			window.localStorage.setItem(key, '1');
		} catch {
			/* nothing to do: the ask simply returns next time */
		}
	}

	function reveal() {
		if (prompt.hidden === false || remembered(DISMISSED)) return;

		prompt.hidden = false;

		/*
		 * Laid out again once it is visible.
		 *
		 * The widget is in the page from the start, so Trustpilot's loader has
		 * already bound it — but it was bound inside a hidden container, where the
		 * box has no width to measure. Their loader exposes exactly this call for
		 * widgets revealed after load; without it the iframe can settle at zero
		 * width and the reader sees a gap where the review box should be.
		 *
		 * Guarded, because the script is third-party and blocked more often than
		 * people think. Without it the anchor inside the widget is still a working
		 * link to the review page, which is the whole reason that anchor is there.
		 */
		var slot = prompt.querySelector('.trustpilot-widget');
		if (slot && window.Trustpilot && typeof window.Trustpilot.loadFromElement === 'function') {
			window.Trustpilot.loadFromElement(slot, true);
		}
	}

	var dismiss = prompt.querySelector('[data-review-dismiss]');
	if (dismiss) {
		dismiss.addEventListener('click', function () {
			prompt.hidden = true;
			remember(DISMISSED);
			// So a later visit does not open with it again.
			forget(STARTED);
		});
	}

	/*
	 * **Shown when they come back, because they always leave.**
	 *
	 * The first version revealed the prompt 1.2 seconds after a click. Every
	 * route here navigates away in the same tab — the Store listing, the releases
	 * page — so the page was gone long before the timer fired, and the prompt was
	 * never seen once. It was written as though these links start a file
	 * download; they open a page somebody then leaves for.
	 *
	 * So the click only records that a build was fetched, and the ask is made on
	 * the next load of this page. That is a moment the reader chose, and by then
	 * they have actually installed the thing rather than merely clicked at it.
	 */
	if (remembered(STARTED)) reveal();

	var routes = document.querySelectorAll('[data-got-it]');
	for (var i = 0; i < routes.length; i += 1) {
		routes[i].addEventListener('click', function () {
			remember(STARTED);
			// And in case the link opened in a new tab and this page survives, which
			// costs nothing to handle and means the ask is not always deferred.
			window.setTimeout(reveal, 1200);
		});
	}
})();
