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
	 * **The review ask, shown at the click and never in the way of it.**
	 *
	 * It used to appear on the visit after a download route was followed, which
	 * meant almost nobody saw it: the routes navigate away, and coming back to
	 * this page is not something people do. So it is shown at the moment of the
	 * click instead — and the thing the reader asked for is the first control in
	 * it, one click away, always working.
	 *
	 * **Not a gate.** The link is followed by this script, so if the script fails
	 * to load or throws, every download link on the page is an ordinary link that
	 * works. Nothing here can leave somebody unable to get a build, which on a
	 * page whose whole job is handing over a genuine build is the only acceptable
	 * failure mode.
	 *
	 * It also asks once. Somebody who has said "do not ask again", or who has
	 * followed the review link, goes straight through on every later click.
	 */
	var prompt = document.querySelector('[data-review-prompt]');
	if (!prompt) return;

	var DISMISSED = 'oda.review-prompt.dismissed';

	/*
	 * Storage can throw outright — a private window, a browser set to block site
	 * data. This is a review prompt, not worth an exception that stops the page,
	 * and "we could not remember" resolves to asking, which is the harmless
	 * direction: an extra ask, never a blocked download.
	 */
	function remembered(key) {
		try {
			return window.localStorage.getItem(key) === '1';
		} catch {
			return false;
		}
	}
	function remember(key) {
		try {
			window.localStorage.setItem(key, '1');
		} catch {
			/* the ask simply returns next time */
		}
	}

	var proceed = prompt.querySelector('[data-review-continue]');
	var dismiss = prompt.querySelector('[data-review-dismiss]');
	var invoker = null;
	var inerted = [];

	/*
	 * `aria-modal` describes the relationship; `inert` enforces it for pointer,
	 * keyboard and assistive-technology navigation in browsers that implement it.
	 * Walk outwards from the prompt so only sibling branches are disabled — an
	 * ancestor containing the dialog itself must never become inert. Remember the
	 * old value because a page may already have disabled a branch for its own
	 * reason.
	 */
	function makeBackgroundInert() {
		if (!document.body || !prompt.parentElement) return;
		var child = prompt;
		var parent = prompt.parentElement;
		while (parent) {
			var siblings = Array.from(parent.children || []);
			for (var i = 0; i < siblings.length; i += 1) {
				if (siblings[i] === child || !('inert' in siblings[i])) continue;
				inerted.push({ node: siblings[i], value: siblings[i].inert });
				siblings[i].inert = true;
			}
			if (parent === document.body) break;
			child = parent;
			parent = parent.parentElement;
		}
	}

	function restoreBackground() {
		for (var i = inerted.length - 1; i >= 0; i -= 1) {
			inerted[i].node.inert = inerted[i].value;
		}
		inerted = [];
	}

	function closePrompt(restoreFocus) {
		prompt.hidden = true;
		restoreBackground();
		if (restoreFocus && invoker && typeof invoker.focus === 'function') invoker.focus();
		invoker = null;
	}

	function activationStaysOnPage(event) {
		return Boolean(
			(event.button !== undefined && event.button !== 0) ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		);
	}

	if (dismiss) {
		dismiss.addEventListener('click', function () {
			remember(DISMISSED);
			closePrompt(true);
		});
	}

	if (proceed) {
		/*
		 * This remains an ordinary anchor. The handler records only that the ask
		 * was answered; the browser still owns navigation, so Ctrl/Cmd/Shift/Alt
		 * and middle clicks keep the destination context the reader requested.
		 */
		proceed.addEventListener('click', function (event) {
			remember(DISMISSED);
			closePrompt(activationStaysOnPage(event));
		});
		proceed.addEventListener('auxclick', function (event) {
			if (event.button === 1) {
				remember(DISMISSED);
				closePrompt(true);
			}
		});
	}

	/*
	 * Following the review link counts as answering. "Do not ask again" was once
	 * the only thing that stopped it, so somebody who actually went and wrote the
	 * review was asked again on every later visit.
	 */
	var writes = prompt.querySelectorAll('a[href]:not([data-review-continue])');
	for (var w = 0; w < writes.length; w += 1) {
		writes[w].addEventListener('click', function (event) {
			remember(DISMISSED);
			closePrompt(activationStaysOnPage(event));
		});
	}

	/*
	 * Escape closes it without answering.
	 *
	 * It covers the page while it is open, so without this the only ways out are
	 * to go to the store or to say "never ask again" — and a reader who wants
	 * neither right now has been cornered by a review request, which is the
	 * opposite of what it is for. Nothing is remembered: press the button again
	 * and it asks again.
	 */
	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && !prompt.hidden) {
			event.preventDefault?.();
			closePrompt(true);
			return;
		}
		if (event.key !== 'Tab' || prompt.hidden) return;
		var controls = Array.from(
			prompt.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
		);
		if (controls.length === 0) return;
		var first = controls[0];
		var last = controls[controls.length - 1];
		var inside = typeof prompt.contains === 'function' && prompt.contains(document.activeElement);
		if (event.shiftKey && (document.activeElement === first || !inside)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (document.activeElement === last || !inside)) {
			event.preventDefault();
			first.focus();
		}
	});

	var routes = document.querySelectorAll('[data-got-it]');
	for (var i = 0; i < routes.length; i += 1) {
		routes[i].addEventListener('click', function (event) {
			var target = event.currentTarget;
			var href = target.getAttribute('href');
			if (!href || remembered(DISMISSED)) return;

			/*
			 * A modifier or middle click is a deliberate "open this somewhere else".
			 * Cancelling it swallows an action the reader took on purpose, and the
			 * prompt they would get instead is in the wrong window.
			 */
			if (event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

			event.preventDefault();
			invoker = target;
			if (proceed) {
				proceed.setAttribute('href', href);
				proceed.textContent =
					'Continue to ' + (target.getAttribute('data-got-it') || 'the download') + ' \u2192';
			}
			/*
			 * No `scrollIntoView`. The prompt is fixed while it is open — see
			 * `.ask-prompt:not([hidden])` — so it arrives in front of whatever the
			 * reader is looking at. Scrolling to it was what dragged them 3,798px
			 * down the page to reach it, which is the thing being fixed.
			 */
			makeBackgroundInert();
			prompt.hidden = false;
			if (proceed) proceed.focus();
		});
	}
})();
