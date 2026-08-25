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
})();
