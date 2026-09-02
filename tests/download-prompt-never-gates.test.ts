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
	focus(): void;
	dispatch(type: string, event: Record<string, unknown>): void;
}

function el(attributes: Record<string, string> = {}): FakeEl {
	const node: FakeEl = {
		attributes,
		hidden: true,
		textContent: '',
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
		scrollIntoView: () => undefined,
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
	const context = {
		document: {
			querySelector: (sel: string) =>
				sel === '[data-download]' ? root : sel === '[data-review-prompt]' ? prompt : null,
			querySelectorAll: (sel: string) => (sel === '[data-got-it]' ? [route] : [])
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
	return { route, prompt, proceed, dismiss, navigated, store };
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
				querySelectorAll: () => []
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
