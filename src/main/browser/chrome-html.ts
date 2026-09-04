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
		padding: 0 5px 0 0; border-radius: 7px 7px 0 0; cursor: default;
		background: #1a1d23; color: #8b93a1; border: 1px solid transparent; border-bottom: none;
	}
	.tab:hover { background: #21242c; }
	.tab.active { background: #101216; color: #e6eaf2; border-color: #2a2e37; }
	.tab-select {
		flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 6px;
		padding: 0 2px 0 9px; border: 0; background: transparent; color: inherit;
		font: inherit; text-align: left; cursor: default;
	}
	.tab .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tab .off { flex: none; color: #d9822b; font-weight: 700; font-size: 10px; letter-spacing: .04em; }
	.tab .x {
		flex: none; width: 16px; height: 16px; border-radius: 4px; text-align: center;
		padding: 0; border: 0; background: transparent; line-height: 15px;
		font: inherit; font-size: 13px; color: #7b8393; cursor: pointer;
	}
	.tab .x:hover { background: #343945; color: #e6eaf2; }
	.tab-select:focus-visible, .tab .x:focus-visible, #newtab:focus-visible, button.nav:focus-visible {
		outline: 2px solid #65c980; outline-offset: -2px;
	}
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
	<div id="tabs" role="tablist" aria-label="Browser tabs"></div>
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
	// Where keyboard focus should land after closing a tab. drawTabs replaces
	// the strip on every state event, so relying on the browser's default focus
	// repair would drop focus onto the document body.
	var focusAfterClose = '';
	// The address of the page actually loaded, kept even while somebody is typing
	// over it, so blur has something true to restore.
	var shownUrl = '';

	back.onclick = function () { window.odaBrowser.back(); };
	forward.onclick = function () { window.odaBrowser.forward(); };
	reload.onclick = function () { window.odaBrowser.reload(); };

	address.onfocus = function () { typing = true; address.select(); };
	// **Blur re-syncs, always.** The bar is the only thing in this window that
	// says which page is loaded, so the one state it must never be left in is
	// showing an address that is not the current one. Two ways it could be:
	// Escape abandoned an edit and nothing put the real address back, and a page
	// that navigated while the bar had focus was skipped by the state handler
	// below and never re-applied. The second needs no user action at all — a page
	// can redirect itself while somebody is halfway through typing — and left the
	// previous, trusted address on screen for the page that replaced it.
	address.onblur = function () { typing = false; address.value = shownUrl; };
	address.onkeydown = function (event) {
		// Enter deliberately does NOT paint what was typed. The navigation may be
		// refused, may redirect, may land somewhere else entirely; the address that
		// appears is the one the state handler reports once something has actually
		// loaded. No backticks in here: this whole script is a template literal.
		if (event.key === 'Enter') { typing = false; window.odaBrowser.go(address.value); address.blur(); }
		if (event.key === 'Escape') { address.blur(); }
	};

	function drawTabs(tabs, atLimit) {
		var oldFocus = document.activeElement;
		var restoreId = oldFocus && oldFocus.getAttribute
			? oldFocus.getAttribute('data-tab-id')
			: null;
		var restoreClose = oldFocus && oldFocus.getAttribute
			? oldFocus.getAttribute('data-tab-close') === 'true'
			: false;
		strip.textContent = '';
		for (var i = 0; i < tabs.length; i++) {
			(function (tab, index) {
				var el = document.createElement('div');
				el.className = 'tab' + (tab.active ? ' active' : '');
				el.title = tab.url || tab.title;
				el.setAttribute('role', 'presentation');
				el.onmousedown = function (event) {
					// Middle click closes, as it does everywhere else.
					if (event.button === 1) { event.preventDefault(); window.odaBrowser.closeTab(tab.id); }
					// Preserve the old whole-tab pointer target. Real clicks on the selection
					// button use its click handler; this branch covers the few pixels of wrapper.
					else if (event.button === 0 && event.target === el) { window.odaBrowser.selectTab(tab.id); }
				};

				var select = document.createElement('button');
				select.type = 'button';
				select.className = 'tab-select';
				select.setAttribute('role', 'tab');
				select.setAttribute('aria-selected', tab.active ? 'true' : 'false');
				select.setAttribute('aria-label', (tab.title || 'New tab') + (tab.offSteam ? ' — not a Steam page' : ''));
				select.setAttribute('data-tab-id', String(tab.id));
				select.tabIndex = tab.active ? 0 : -1;
				select.title = el.title;
				select.onclick = function () { window.odaBrowser.selectTab(tab.id); };
				select.onmousedown = function (event) {
					if (event.button === 1) {
						event.preventDefault();
						event.stopPropagation();
						window.odaBrowser.closeTab(tab.id);
					}
				};
				select.onkeydown = function (event) {
					var choices = Array.prototype.slice.call(strip.querySelectorAll('[role="tab"]'));
					var destination = -1;
					if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
						destination = (index - 1 + choices.length) % choices.length;
					} else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
						destination = (index + 1) % choices.length;
					} else if (event.key === 'Home') {
						destination = 0;
					} else if (event.key === 'End') {
						destination = choices.length - 1;
					} else if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						// A keyboard-activated ARIA tab keeps focus in its tablist. Tell
						// the host this was not a pointer selection, because selecting the
						// page temporarily focuses its separate WebContents.
						window.odaBrowser.selectTab(tab.id, true);
						return;
					} else if (event.key === 'Delete') {
						event.preventDefault();
						var neighbour = tabs[index + 1] || tabs[index - 1];
						focusAfterClose = neighbour ? String(neighbour.id) : '';
						window.odaBrowser.closeTab(tab.id, true);
						return;
					}
					if (destination >= 0) {
						event.preventDefault();
						choices[destination].focus();
					}
				};

				if (tab.offSteam) {
					var mark = document.createElement('span');
					mark.className = 'off';
					mark.textContent = '!';
					mark.title = 'Not a Steam page';
					mark.setAttribute('aria-hidden', 'true');
					select.appendChild(mark);
				}

				var label = document.createElement('span');
				label.className = 'label';
				// textContent, never innerHTML: this string comes from a page.
				label.textContent = tab.title || 'New tab';
				select.appendChild(label);
				el.appendChild(select);

				var close = document.createElement('button');
				close.type = 'button';
				close.className = 'x';
				close.textContent = '\\u00d7';
				close.title = 'Close tab';
				close.setAttribute('aria-label', 'Close ' + (tab.title || 'New tab'));
				close.setAttribute('data-tab-id', String(tab.id));
				close.setAttribute('data-tab-close', 'true');
				var closedByPointer = false;
				close.onmousedown = function (event) {
					event.stopPropagation();
					if (event.button === 0) {
						event.preventDefault();
						var neighbour = tabs[index + 1] || tabs[index - 1];
						focusAfterClose = neighbour ? String(neighbour.id) : '';
						closedByPointer = true;
						window.odaBrowser.closeTab(tab.id, true);
					}
				};
				close.onclick = function (event) {
					event.preventDefault();
					event.stopPropagation();
					if (closedByPointer) {
						closedByPointer = false;
						return;
					}
					var neighbour = tabs[index + 1] || tabs[index - 1];
					focusAfterClose = neighbour ? String(neighbour.id) : '';
					window.odaBrowser.closeTab(tab.id, true);
				};
				el.appendChild(close);

				strip.appendChild(el);
			})(tabs[i], i);
		}

		var plus = document.createElement('button');
		plus.id = 'newtab';
		plus.textContent = '+';
		// Disabled at the ceiling rather than left to do nothing. A page can open
		// tabs too, so this can be reached without the user having pressed it
		// twenty times — and a + that silently stops working reads as a bug.
		plus.disabled = atLimit;
		plus.title = atLimit ? 'This window is full — close a tab first' : 'New tab';
		plus.setAttribute('aria-label', plus.title);
		plus.onclick = function () { window.odaBrowser.newTab(); };
		strip.appendChild(plus);

		var wantedId = focusAfterClose || restoreId;
		if (wantedId) {
			var candidates = strip.querySelectorAll('[data-tab-id]');
			for (var j = 0; j < candidates.length; j++) {
				var candidate = candidates[j];
				if (
					candidate.getAttribute('data-tab-id') === wantedId &&
					(focusAfterClose || (candidate.getAttribute('data-tab-close') === 'true') === restoreClose)
				) {
					candidate.focus();
					break;
				}
			}
		}
		focusAfterClose = '';
	}

	window.odaBrowser.onFocusAddress(function () {
		address.focus();
		address.select();
	});

	window.odaBrowser.onState(function (state) {
		// Never overwrite what somebody is halfway through typing — but record it
		// regardless, or blur has nothing to restore and the bar keeps the address
		// of a page that is no longer loaded.
		shownUrl = state.url;
		if (!typing) { address.value = shownUrl; }
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
