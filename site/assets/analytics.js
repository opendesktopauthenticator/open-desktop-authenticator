/*
 * Google Analytics 4 bootstrap.
 *
 * ## Why this is a file rather than an inline block
 *
 * Google publishes this snippet as two inline `<script>` blocks. Pasting it in
 * that form would require `script-src 'unsafe-inline'` in the content security
 * policy, which switches off the single most useful protection this site has:
 * with `unsafe-inline` present, any injected `<script>` anywhere on any page
 * executes. That is a poor trade for a measurement tag.
 *
 * Served from our own origin, the config runs under plain `'self'` and the only
 * concession the policy has to make is naming googletagmanager.com as a script
 * source. No hash to regenerate on every edit, and no inline execution allowed
 * anywhere on the site.
 *
 * ## Ordering
 *
 * `gtag.js` is loaded `async` and this file `defer`, so either can win the
 * race. That is fine, and is why the snippet is written the way it is:
 * `dataLayer` is an ordinary array and `gtag()` only pushes onto it. Whichever
 * arrives second finds the queue already there and drains it.
 */

window.dataLayer = window.dataLayer || [];

// Must be a real `function` using `arguments` — gtag.js reads the raw
// `arguments` object off each queued entry, so an arrow or a rest parameter
// pushes the wrong shape and the hit is silently dropped.
function gtag() {
	window.dataLayer.push(arguments);
}

gtag('js', new Date());
gtag('config', 'G-G0GE9H5VR7');
