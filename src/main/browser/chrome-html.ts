/**
 * The toolbar drawn above the page in the in-app browser.
 *
 * Written out here rather than shipped as a file because it is thirty lines of
 * markup with no build step of its own, and a `data:` URL keeps it in an opaque
 * origin that shares nothing with the site below it.
 *
 * **It is not part of the page.** The toolbar and the site are separate
 * `WebContents`: this one has a preload and no access to Steam, the site has
 * Steam and no preload. A bar injected into the page instead would be a bar the
 * page could read, move, restyle and forge — which is the whole trick this
 * application exists to warn people about.
 */
export const CHROME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
	:root { color-scheme: dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0; height: 100vh; display: flex; align-items: center; gap: 6px;
		padding: 0 8px; background: #16181d; border-bottom: 1px solid #2a2e37;
		font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #c9cfda;
		user-select: none;
	}
	button {
		flex: none; width: 30px; height: 26px; border: 1px solid #2a2e37; border-radius: 6px;
		background: #1d2027; color: #c9cfda; font-size: 14px; cursor: pointer;
	}
	button:hover:not(:disabled) { background: #262a33; }
	button:disabled { opacity: .35; cursor: default; }
	#address {
		flex: 1; height: 26px; padding: 0 10px; border-radius: 6px;
		border: 1px solid #2a2e37; background: #101216; color: #e6eaf2;
		font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	#address:focus { outline: none; border-color: #3ba55d; }
	#address.off { border-color: #d9822b; color: #f0b46a; }
	#warn { flex: none; display: none; color: #f0b46a; font-weight: 600; letter-spacing: .02em; }
	#warn.on { display: block; }
</style>
</head>
<body>
	<button id="back" title="Back" aria-label="Back">&#8592;</button>
	<button id="forward" title="Forward" aria-label="Forward">&#8594;</button>
	<button id="reload" title="Reload" aria-label="Reload">&#8635;</button>
	<span id="warn">NOT STEAM</span>
	<input id="address" spellcheck="false" autocomplete="off" aria-label="Address">
<script>
	var back = document.getElementById('back');
	var forward = document.getElementById('forward');
	var reload = document.getElementById('reload');
	var address = document.getElementById('address');
	var warn = document.getElementById('warn');
	var typing = false;

	back.onclick = function () { window.chrome.back(); };
	forward.onclick = function () { window.chrome.forward(); };
	reload.onclick = function () { window.chrome.reload(); };

	address.onfocus = function () { typing = true; address.select(); };
	address.onblur = function () { typing = false; };
	address.onkeydown = function (event) {
		if (event.key === 'Enter') { typing = false; window.chrome.go(address.value); address.blur(); }
		if (event.key === 'Escape') { address.blur(); }
	};

	window.chrome.onState(function (state) {
		// Never overwrite what somebody is halfway through typing.
		if (!typing) { address.value = state.url; }
		back.disabled = !state.canGoBack;
		forward.disabled = !state.canGoForward;
		reload.textContent = state.loading ? '\u00d7' : '\u21bb';
		reload.title = state.loading ? 'Stop' : 'Reload';
		address.className = state.offSteam ? 'off' : '';
		warn.className = state.offSteam ? 'on' : '';
	});
</script>
</body>
</html>`;

/** How tall the toolbar is, in device-independent pixels. */
export const CHROME_HEIGHT = 40;
