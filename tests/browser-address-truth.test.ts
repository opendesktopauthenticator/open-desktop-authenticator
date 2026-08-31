import { describe, expect, it } from 'vitest';
import { CHROME_HTML } from '../src/main/browser/chrome-html';

/**
 * **The address bar is the only thing in that window that says where you are.**
 *
 * The in-app browser exists so somebody can sign in to Steam and answer a
 * confirmation without leaving the authenticator. It has no tab strip URL, no
 * status bar, no certificate padlock — one text field, and an off-Steam warning
 * beside it. A user deciding whether it is safe to type a Steam password is
 * deciding on the strength of that field.
 *
 * So the property is not "the field usually holds the URL". It is that the field
 * **may never be left showing an address that is not the loaded page**, and the
 * interesting cases are all the ones where somebody has touched it.
 *
 * Two ways it could be, both real before this file existed:
 *
 *   - Escape blurred the field and put nothing back, so an abandoned edit stayed
 *     on screen until the next navigation. The user typed it, which makes it
 *     sound harmless — until you notice the text that stays is whatever they
 *     typed, over a page that is whatever it was.
 *   - The state handler skipped `address.value` while `typing` was set, and blur
 *     cleared the flag without re-applying. **This one needs no user action.** A
 *     page that redirects itself while the bar has focus is never painted, and
 *     after blur the field still shows the address of the page that was replaced
 *     — the previous, more trusted one.
 *
 * ## How this is tested
 *
 * By running the real script out of `CHROME_HTML` against a small fake DOM,
 * rather than by looking for the fix in the source text. A guard that greps for
 * `address.value = shownUrl` passes for a file that assigns it in the wrong
 * handler, and this repository has been defeated by exactly that shape of check
 * more than once. The script is extracted and executed; the assertions are about
 * what the field holds afterwards.
 *
 * The fake is deliberately tiny — only what this script touches. If the chrome
 * grows a dependency on something the fake lacks, `Function` throws and the test
 * fails loudly, which is the correct outcome for a harness that has stopped
 * modelling the thing it claims to.
 */

class FakeElement {
	value = '';
	className = '';
	title = '';
	textContent = '';
	disabled = false;
	onclick?: () => void;
	onfocus?: () => void;
	onblur?: () => void;
	onkeydown?: (event: { key: string }) => void;
	appendChild(): void {}
	select(): void {}
	focus(): void {
		this.onfocus?.();
	}
	blur(): void {
		this.onblur?.();
	}
}

interface BrowserState {
	url: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
	offSteam: boolean;
	tabs: unknown[];
	atTabLimit: boolean;
}

function chrome(): {
	address: FakeElement;
	warn: FakeElement;
	arrive: (url: string, offSteam?: boolean) => void;
	navigatedTo: string[];
} {
	const ids = new Map<string, FakeElement>();
	for (const id of ['back', 'forward', 'reload', 'address', 'warn', 'tabs', 'newtab']) {
		ids.set(id, new FakeElement());
	}

	const navigatedTo: string[] = [];
	let push: ((state: BrowserState) => void) | undefined;

	const fakeWindow = {
		odaBrowser: {
			back() {},
			forward() {},
			reload() {},
			go(url: string) {
				navigatedTo.push(url);
			},
			newTab() {},
			selectTab() {},
			closeTab() {},
			onFocusAddress() {},
			onState(listener: (state: BrowserState) => void) {
				push = listener;
			}
		}
	};

	const fakeDocument = {
		getElementById: (id: string) => ids.get(id),
		createElement: () => new FakeElement()
	};

	const script = /<script>([\s\S]*?)<\/script>/.exec(CHROME_HTML)?.[1];
	expect(
		script,
		'CHROME_HTML no longer contains a script block, so this runs nothing'
	).toBeTruthy();

	// The template escapes these for the HTML it is embedded in; undo that so the
	// script runs as it will in the window.
	const source = (script ?? '').replace(/\\\\u/g, '\\u');

	/*
	 * **The rule being suspended, and why it has to be.**
	 *
	 * `no-implied-eval` is right about production code and wrong about this: the
	 * subject under test IS a string of JavaScript, shipped to a window as one,
	 * and the only two ways to check what it does are to run it or to read it.
	 * Reading it is the thing this file exists to avoid — a guard that greps the
	 * chrome for an assignment passes for a chrome that makes that assignment in
	 * the wrong handler, which is the defect that was actually present.
	 *
	 * The input is `CHROME_HTML`, a constant in this repository, imported at the
	 * top. It is not user input, not fetched, not built from anything a test
	 * controls. If that ever stops being true this disable must go.
	 */
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const run = new Function('window', 'document', source) as (
		w: typeof fakeWindow,
		d: typeof fakeDocument
	) => void;
	run(fakeWindow, fakeDocument);

	expect(push, 'the chrome never subscribed to state, so nothing below is exercised').toBeTypeOf(
		'function'
	);

	return {
		address: ids.get('address') as FakeElement,
		warn: ids.get('warn') as FakeElement,
		navigatedTo,
		arrive(url: string, offSteam = false) {
			push?.({
				url,
				canGoBack: false,
				canGoForward: false,
				loading: false,
				offSteam,
				tabs: [],
				atTabLimit: false
			});
		}
	};
}

const LOADED = 'https://steamcommunity.com/login/home';
const TYPED = 'https://store.steampowered.com/';

describe('the address bar never shows a page that is not loaded', () => {
	it('shows the loaded address to begin with', () => {
		const ui = chrome();
		ui.arrive(LOADED);
		expect(ui.address.value).toBe(LOADED);
	});

	it('leaves an edit in progress alone', () => {
		// The reason the skip exists, and it is a good reason: retyping under
		// somebody's cursor is its own kind of wrong.
		const ui = chrome();
		ui.arrive(LOADED);
		ui.address.focus();
		ui.address.value = TYPED;
		ui.arrive('https://steamcommunity.com/somewhere-else');
		expect(ui.address.value).toBe(TYPED);
	});

	it('puts the real address back when Escape abandons an edit', () => {
		const ui = chrome();
		ui.arrive(LOADED);
		ui.address.focus();
		ui.address.value = TYPED;
		ui.address.onkeydown?.({ key: 'Escape' });
		expect(
			ui.address.value,
			'Escape abandoned the edit and left the typed text over a page that never changed'
		).toBe(LOADED);
	});

	it('puts the real address back when focus simply leaves', () => {
		const ui = chrome();
		ui.arrive(LOADED);
		ui.address.focus();
		ui.address.value = TYPED;
		ui.address.blur();
		expect(ui.address.value).toBe(LOADED);
	});

	/**
	 * **The one that needs nobody to do anything.**
	 *
	 * A page can navigate itself. If it does so while the bar has focus, the
	 * state handler skips the field — correctly, somebody is typing — and the
	 * only thing that can repair it is blur. Before blur re-synced, the field
	 * went on showing the address of the page that had already been replaced.
	 */
	it('shows where a page went if it navigated while the bar had focus', () => {
		const ui = chrome();
		ui.arrive(LOADED);
		ui.address.focus();
		ui.arrive('https://evil.example/phish', true);
		ui.address.blur();
		expect(
			ui.address.value,
			'the page navigated away while the bar had focus and the bar kept the old, more trusted ' +
				'address after focus left — which is the whole of an address-spoofing surface'
		).toBe('https://evil.example/phish');
	});

	it('still warns off-Steam while an edit is in progress', () => {
		// The warning is painted outside the typing guard, and must stay that way:
		// it is the half of the answer that does not depend on the text.
		const ui = chrome();
		ui.arrive(LOADED);
		ui.address.focus();
		ui.arrive('https://evil.example/phish', true);
		expect(ui.warn.className).toBe('on');
	});

	/**
	 * Enter must not paint what was typed either. `go` may be refused, may
	 * redirect, may land somewhere else; the address that appears is whatever
	 * actually loads. Optimistically showing the request would make the field
	 * assert a page that may never exist.
	 */
	it('does not adopt the typed address on Enter', () => {
		const ui = chrome();
		ui.arrive(LOADED);
		ui.address.focus();
		ui.address.value = TYPED;
		ui.address.onkeydown?.({ key: 'Enter' });

		expect(ui.navigatedTo, 'Enter no longer navigates').toEqual([TYPED]);
		expect(
			ui.address.value,
			'the bar adopted an address nothing had loaded yet — if the navigation is refused it now ' +
				'names a page the window is not showing'
		).toBe(LOADED);

		ui.arrive(TYPED);
		expect(ui.address.value, 'and it follows once the page really arrives').toBe(TYPED);
	});
});
