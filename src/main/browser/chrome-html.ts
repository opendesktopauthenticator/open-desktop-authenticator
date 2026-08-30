/**
 * The toolbar and tab strip drawn above the page in the in-app browser.
 *
 * Written out here rather than shipped as a file because it is markup with no
 * build step of its own, and a `data:` URL keeps it in an opaque origin that
 * shares nothing with the sites below it.
 *
 * **It is not part of any page.** The chrome and the sites are separate
 * `WebContents`: this one has a preload and no access to Steam, each page has
 * Steam and no preload. Chrome drawn inside a page would be chrome the page
 * could read, restyle, move and forge — which is the whole trick this
 * application exists to warn people about.
 *
 * The tab labels come from page titles, which pages choose for themselves. That
 * is what every browser does and it is useful, but it means a tab label is not
 * evidence of anything. The address field is the authority: it shows the real
 * URL of the active tab, and says NOT STEAM when the host is not Valve's. Tabs
 * that are off Steam carry the same mark, so the strip can be read at a glance
 * without trusting what a page called itself.
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
		margin: 0; height: 100vh; display: flex; flex-direction: column;
		background: #16181d; border-bottom: 1px solid #2a2e37;
		font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #c9cfda;
		user-select: none; overflow: hidden;
	}
	#tabs {
		flex: none; height: 32px; display: flex; align-items: stretch; gap: 2px;
		padding: 4px 6px 0; overflow-x: auto; scrollbar-width: none;
	}
	#tabs::-webkit-scrollbar { display: none; }
	.tab {
		flex: 0 1 190px; min-width: 64px; display: flex; align-items: center; gap: 6px;
		padding: 0 6px 0 10px; border-radius: 7px 7px 0 0; cursor: default;
		background: #1a1d23; color: #8b93a1; border: 1px solid transparent; border-bottom: none;
	}
	.tab:hover { background: #21242c; }
	.tab.active { background: #101216; color: #e6eaf2; border-color: #2a2e37; }
	.tab .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tab .off { flex: none; color: #d9822b; font-weight: 700; font-size: 10px; letter-spacing: .04em; }
	.tab .x {
		flex: none; width: 16px; height: 16px; border-radius: 4px; text-align: center;
		line-height: 15px; font-size: 13px; color: #7b8393;
	}
	.tab .x:hover { background: #343945; color: #e6eaf2; }
	#newtab {
		flex: none; width: 26px; height: 24px; align-self: center; margin-left: 2px;
		border: none; border-radius: 6px; background: transparent; color: #8b93a1;
		font-size: 16px; cursor: pointer;
	}
	#newtab:hover:not(:disabled) { background: #262a33; color: #e6eaf2; }
	#newtab:disabled { opacity: .35; cursor: default; }
	#bar {
		flex: none; height: 40px; display: flex; align-items: center; gap: 6px; padding: 0 8px;
	}
	button.nav {
		flex: none; width: 30px; height: 26px; border: 1px solid #2a2e37; border-radius: 6px;
		background: #1d2027; color: #c9cfda; font-size: 14px; cursor: pointer;
	}
	button.nav:hover:not(:disabled) { background: #262a33; }
	button.nav:disabled { opacity: .35; cursor: default; }
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
	<div id="tabs"></div>
	<div id="bar">
		<button class="nav" id="back" title="Back" aria-label="Back">&#8592;</button>
		<button class="nav" id="forward" title="Forward" aria-label="Forward">&#8594;</button>
		<button class="nav" id="reload" title="Reload" aria-label="Reload">&#8635;</button>
		<span id="warn">NOT STEAM</span>
		<input id="address" spellcheck="false" autocomplete="off" aria-label="Address">
	</div>
<script>
	var back = document.getElementById('back');
	var forward = document.getElementById('forward');
	var reload = document.getElementById('reload');
	var address = document.getElementById('address');
	var warn = document.getElementById('warn');
	var strip = document.getElementById('tabs');
	var newtab = document.getElementById('newtab');
	var typing = false;

	back.onclick = function () { window.odaBrowser.back(); };
	forward.onclick = function () { window.odaBrowser.forward(); };
	reload.onclick = function () { window.odaBrowser.reload(); };

	address.onfocus = function () { typing = true; address.select(); };
	address.onblur = function () { typing = false; };
	address.onkeydown = function (event) {
		if (event.key === 'Enter') { typing = false; window.odaBrowser.go(address.value); address.blur(); }
		if (event.key === 'Escape') { address.blur(); }
	};

	function drawTabs(tabs, atLimit) {
		strip.textContent = '';
		for (var i = 0; i < tabs.length; i++) {
			(function (tab) {
				var el = document.createElement('div');
				el.className = 'tab' + (tab.active ? ' active' : '');
				el.title = tab.url || tab.title;
				el.onmousedown = function (event) {
					// Middle click closes, as it does everywhere else.
					if (event.button === 1) { event.preventDefault(); window.odaBrowser.closeTab(tab.id); }
					else if (event.button === 0) { window.odaBrowser.selectTab(tab.id); }
				};

				if (tab.offSteam) {
					var mark = document.createElement('span');
					mark.className = 'off';
					mark.textContent = '!';
					mark.title = 'Not a Steam page';
					el.appendChild(mark);
				}

				var label = document.createElement('span');
				label.className = 'label';
				// textContent, never innerHTML: this string comes from a page.
				label.textContent = tab.title || 'New tab';
				el.appendChild(label);

				var close = document.createElement('span');
				close.className = 'x';
				close.textContent = '\\u00d7';
				close.title = 'Close tab';
				close.onmousedown = function (event) {
					event.stopPropagation();
					if (event.button === 0) { event.preventDefault(); window.odaBrowser.closeTab(tab.id); }
				};
				el.appendChild(close);

				strip.appendChild(el);
			})(tabs[i]);
		}

		var plus = document.createElement('button');
		plus.id = 'newtab';
		plus.textContent = '+';
		// Disabled at the ceiling rather than left to do nothing. A page can open
		// tabs too, so this can be reached without the user having pressed it
		// twenty times — and a + that silently stops working reads as a bug.
		plus.disabled = atLimit;
		plus.title = atLimit ? 'This window is full — close a tab first' : 'New tab';
		plus.onclick = function () { window.odaBrowser.newTab(); };
		strip.appendChild(plus);
	}

	window.odaBrowser.onFocusAddress(function () {
		address.focus();
		address.select();
	});

	window.odaBrowser.onState(function (state) {
		// Never overwrite what somebody is halfway through typing.
		if (!typing) { address.value = state.url; }
		back.disabled = !state.canGoBack;
		forward.disabled = !state.canGoForward;
		reload.textContent = state.loading ? '\\u00d7' : '\\u21bb';
		reload.title = state.loading ? 'Stop' : 'Reload';
		address.className = state.offSteam ? 'off' : '';
		warn.className = state.offSteam ? 'on' : '';
		drawTabs(state.tabs || [], state.atTabLimit === true);
	});
</script>
</body>
</html>`;

/** How tall the tab strip and toolbar are together, in device-independent pixels. */
export const CHROME_HEIGHT = 72;
