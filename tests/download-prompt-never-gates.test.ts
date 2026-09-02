import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/**
 * **The review prompt must never stand between a reader and a build.**
 *
 * The download page's entire job is handing somebody a genuine build, on a site
 * whose argument is that the alternatives are how inventories get stolen. A
 * review prompt that can leave a person unable to download is worse than no
 * prompt at all — and it is the failure mode this shape invites, because the
 * prompt works by cancelling the click.
 *
 * So the guarantees are: the original destination always survives into a
 * control the reader can press; a reader who has answered once is never
 * intercepted again; and a modifier-click, which the reader used deliberately
 * to open a new tab, is left alone.
 *
 * The real asset is run against a faked DOM, as `download-platform.test.ts`
 * does — anything less tests a copy of the script rather than the script.
 */

const SOURCE = readFileSync(join(__dirname, '..', 'site', 'assets', 'download.js'), 'utf8');

interface FakeEl {
	attributes: Record<string, string>;
	hidden: boolean;
	textContent: string;
	onclick: ((e: unknown) => void) | null;
	listeners: Record<string, ((e: unknown) => void)[]>;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	addEventListener(type: string, fn: (e: unknown) => void): void;
	querySelector(sel: string): FakeEl | null;
	querySelectorAll(sel: string): FakeEl[];
	scrollIntoView(): void;
	/** How many times something asked the page to move to this element. */
	scrolledIntoView: number;
	focus(): void;
	dispatch(type: string, event: Record<string, unknown>): void;
}

function el(attributes: Record<string, string> = {}): FakeEl {
	const node: FakeEl = {
		attributes,
		hidden: true,
		textContent: '',
		scrolledIntoView: 0,
		onclick: null,
		listeners: {},
		getAttribute: (name) => node.attributes[name] ?? null,
		setAttribute: (name, value) => {
			node.attributes[name] = value;
		},
		addEventListener: (type, fn) => {
			(node.listeners[type] ??= []).push(fn);
		},
		querySelector: () => null,
		querySelectorAll: () => [],
		scrollIntoView: () => {
			node.scrolledIntoView += 1;
		},
		focus: () => undefined,
		dispatch: (type, event) => {
			for (const fn of node.listeners[type] ?? []) fn.call(node, event);
		}
	};
	return node;
}

/** The download page as the script finds it, with a store link and a prompt. */
function page(options: { dismissed?: boolean } = {}) {
	const root = el({ 'data-download': '' });
	const route = el({ 'data-got-it': 'the Store build', href: 'https://store.example/app' });
	const proceed = el({ href: '#', 'data-review-continue': '' });
	const dismiss = el({ 'data-review-dismiss': '' });
	const prompt = el({ 'data-review-prompt': '' });
	prompt.querySelector = (sel) =>
		sel.includes('continue') ? proceed : sel.includes('dismiss') ? dismiss : null;
	prompt.querySelectorAll = () => [];

	const store: Record<string, string> =
		options.dismissed === true ? { 'oda.review-prompt.dismissed': '1' } : {};

	const navigated: string[] = [];
	const keys: ((e: unknown) => void)[] = [];
	const context = {
		document: {
			querySelector: (sel: string) =>
				sel === '[data-download]' ? root : sel === '[data-review-prompt]' ? prompt : null,
			querySelectorAll: (sel: string) => (sel === '[data-got-it]' ? [route] : []),
			addEventListener: (type: string, fn: (e: unknown) => void) => {
				if (type === 'keydown') keys.push(fn);
			}
		},
		navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32' },
		window: {
			localStorage: {
				getItem: (k: string) => store[k] ?? null,
				setItem: (k: string, v: string) => {
					store[k] = v;
				},
				removeItem: (k: string) => {
					delete store[k];
				}
			},
			setTimeout: () => 0,
			get location() {
				return {
					set href(value: string) {
						navigated.push(value);
					}
				};
			}
		}
	};
	runInNewContext(SOURCE, context);
	return {
		route,
		prompt,
		proceed,
		dismiss,
		navigated,
		store,
		press: (key: string) => keys.forEach((fn) => fn({ key }))
	};
}

/** A plain left click, as a mouse makes one. */
function plainClick() {
	let prevented = false;
	return {
		event: {
			button: 0,
			defaultPrevented: false,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			preventDefault: () => {
				prevented = true;
			}
		},
		wasPrevented: () => prevented
	};
}

describe('a download click with the prompt unanswered', () => {
	it('keeps the destination on a control the reader can press', () => {
		const { route, proceed } = page();
		const click = plainClick();
		route.dispatch('click', click.event);

		expect(
			proceed.getAttribute('href'),
			'the click was cancelled and the destination went nowhere, so the reader is stranded on ' +
				'a page whose whole job is handing them a build'
		).toBe('https://store.example/app');
	});

	it('shows the prompt', () => {
		const { route, prompt } = page();
		route.dispatch('click', plainClick().event);

		expect(prompt.hidden).toBe(false);
	});

	it('names the destination on that control', () => {
		const { route, proceed } = page();
		route.dispatch('click', plainClick().event);

		expect(proceed.textContent).toContain('the Store build');
	});
});

describe('a reader who has already answered', () => {
	it('is not intercepted at all', () => {
		const { route, prompt } = page({ dismissed: true });
		const click = plainClick();
		route.dispatch('click', click.event);

		expect(
			click.wasPrevented(),
			'somebody who said "do not ask again" had their download cancelled anyway'
		).toBe(false);
		expect(prompt.hidden, 'and was shown the prompt they turned down').toBe(true);
	});
});

/*
 * A modifier-click is a deliberate "open this somewhere else". Cancelling it
 * swallows an action the reader took on purpose, and the prompt they get
 * instead is in the wrong window.
 */
describe('a click the reader meant for a new tab', () => {
	it.each(['metaKey', 'ctrlKey', 'shiftKey'])('is left alone for %s', (modifier) => {
		const { route, prompt } = page();
		const click = plainClick();
		(click.event as unknown as Record<string, unknown>)[modifier] = true;
		route.dispatch('click', click.event);

		expect(click.wasPrevented()).toBe(false);
		expect(prompt.hidden).toBe(true);
	});

	it('is left alone for a middle click', () => {
		const { route } = page();
		const click = plainClick();
		(click.event as unknown as Record<string, unknown>).button = 1;
		route.dispatch('click', click.event);

		expect(click.wasPrevented()).toBe(false);
	});
});

/*
 * And the whole mechanism is a progressive enhancement: the page ships ordinary
 * links, and the script only ever cancels a click when it has somewhere to put
 * the destination.
 */
describe('the page without the prompt in it', () => {
	it('leaves every download link untouched', () => {
		const root = el({ 'data-download': '' });
		const route = el({ 'data-got-it': 'the Store build', href: 'https://store.example/app' });
		runInNewContext(SOURCE, {
			document: {
				querySelector: (sel: string) => (sel === '[data-download]' ? root : null),
				querySelectorAll: () => [],
				addEventListener: () => undefined
			},
			navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32' },
			window: {
				localStorage: { getItem: () => null, setItem: () => undefined },
				setTimeout: () => 0
			}
		});

		const click = plainClick();
		route.dispatch('click', click.event);

		expect(click.wasPrevented(), 'a page with no prompt still cancelled the download').toBe(false);
	});
});

/**
 * **It opens where the reader is standing.**
 *
 * The prompt is the last element in the article and the download buttons are
 * near the top. Measured on the built page at 1920x889: pressing "Get it from
 * the Microsoft Store" scrolled the reader 3,798px to the very bottom, leaving
 * the button they had just pressed 3,335px above the fold and the card sitting
 * beside the review section it duplicated.
 *
 * It is a fixed dialog now, so the page behind it does not move — which means
 * nothing may ask it to.
 */
describe('showing the prompt', () => {
	it('does not drag the page anywhere', () => {
		const { route, prompt } = page();
		route.dispatch('click', plainClick().event);

		expect(
			prompt.scrolledIntoView,
			'the page was scrolled to the prompt, which on this page means throwing the reader ' +
				'thousands of pixels away from the button they just pressed'
		).toBe(0);
	});
});

/**
 * **Escape leaves without answering.**
 *
 * The dialog covers the page while it is open, so without this the only ways
 * out are to go to the store or to say "never ask again" — and a reader who
 * wants neither right now has been cornered by a review request, which is the
 * opposite of what it is for.
 *
 * Nothing is remembered, so pressing the download button again asks again.
 * That is the harmless direction: an extra ask, never a blocked download.
 */
describe('pressing Escape', () => {
	it('closes the prompt', () => {
		const { route, prompt, press } = page();
		route.dispatch('click', plainClick().event);
		expect(prompt.hidden).toBe(false);

		press('Escape');

		expect(prompt.hidden, 'the reader is held in a review request they cannot leave').toBe(true);
	});

	it('does not count as an answer', () => {
		const { route, prompt, press, store } = page();
		route.dispatch('click', plainClick().event);
		press('Escape');

		expect(
			store['oda.review-prompt.dismissed'],
			'backing out of the ask was recorded as turning it down, so somebody who meant "not now" ' +
				'is never asked again'
		).toBeUndefined();

		route.dispatch('click', plainClick().event);
		expect(prompt.hidden, 'and it never came back').toBe(false);
	});

	it('leaves other keys alone', () => {
		const { route, prompt, press } = page();
		route.dispatch('click', plainClick().event);

		press('a');
		press('Enter');

		expect(prompt.hidden).toBe(false);
	});
});
