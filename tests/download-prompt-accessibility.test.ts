import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('site/assets/download.js', 'utf8');
const PAGE = readFileSync('site/pages/guides.mjs', 'utf8');

interface FakeElement {
	hidden: boolean;
	inert: boolean;
	parentElement: FakeElement | null;
	children: FakeElement[];
	listeners: Record<string, ((event: Record<string, unknown>) => void)[]>;
	attributes: Record<string, string>;
	textContent: string;
	append(...children: FakeElement[]): void;
	addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
	contains(candidate: FakeElement | null): boolean;
	focus(): void;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	querySelector(selector: string): FakeElement | null;
	querySelectorAll(selector: string): FakeElement[];
	dispatch(type: string, event?: Record<string, unknown>): void;
}

function page() {
	let activeElement: FakeElement | null = null;
	const element = (attributes: Record<string, string> = {}): FakeElement => {
		const node: FakeElement = {
			hidden: attributes.hidden === '',
			inert: false,
			parentElement: null,
			children: [],
			listeners: {},
			attributes,
			textContent: '',
			append: (...children) => {
				for (const child of children) {
					child.parentElement = node;
					node.children.push(child);
				}
			},
			addEventListener: (type, listener) => (node.listeners[type] ??= []).push(listener),
			contains: (candidate) =>
				candidate === node || node.children.some((child) => child.contains(candidate)),
			focus: () => {
				activeElement = node;
			},
			getAttribute: (name) => node.attributes[name] ?? null,
			setAttribute: (name, value) => {
				node.attributes[name] = value;
			},
			querySelector: () => null,
			querySelectorAll: () => [],
			dispatch: (type, event = {}) => {
				for (const listener of node.listeners[type] ?? [])
					listener.call(node, { currentTarget: node, ...event });
			}
		};
		return node;
	};

	const body = element();
	const header = element();
	const article = element();
	const footer = element();
	const root = element({ 'data-download': '' });
	const route = element({ href: 'https://store.example/app', 'data-got-it': 'the Store build' });
	const prompt = element({ 'data-review-prompt': '', hidden: '' });
	const promptBody = element();
	const proceed = element({ href: '#', 'data-review-continue': '' });
	const review = element({ href: 'https://review.example', 'data-review-write': '' });
	const dismiss = element({ 'data-review-dismiss': '' });
	body.append(header, article, footer);
	article.append(root, prompt);
	root.append(route);
	prompt.append(promptBody);
	promptBody.append(proceed, review, dismiss);
	prompt.querySelector = (selector) =>
		selector.includes('continue') ? proceed : selector.includes('dismiss') ? dismiss : null;
	prompt.querySelectorAll = () => [proceed, review, dismiss];

	const documentListeners: Record<string, ((event: Record<string, unknown>) => void)[]> = {};
	const document = {
		body,
		get activeElement() {
			return activeElement;
		},
		querySelector: (selector: string) =>
			selector === '[data-download]' ? root : selector === '[data-review-prompt]' ? prompt : null,
		querySelectorAll: (selector: string) => (selector === '[data-got-it]' ? [route] : []),
		addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
			(documentListeners[type] ??= []).push(listener)
	};
	const storage: Record<string, string> = {};
	runInNewContext(SOURCE, {
		document,
		navigator: { userAgent: 'Windows', platform: 'Win32' },
		window: {
			localStorage: {
				getItem: (key: string) => storage[key] ?? null,
				setItem: (key: string, value: string) => {
					storage[key] = value;
				}
			}
		}
	});
	const press = (key: string, shiftKey = false) => {
		let prevented = false;
		for (const listener of documentListeners.keydown ?? []) {
			listener({ key, shiftKey, preventDefault: () => (prevented = true) });
		}
		return prevented;
	};
	const clickRoute = () =>
		route.dispatch('click', {
			button: 0,
			defaultPrevented: false,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			preventDefault: () => undefined
		});

	return {
		article,
		dismiss,
		footer,
		header,
		prompt,
		proceed,
		review,
		root,
		route,
		clickRoute,
		press,
		active: () => activeElement
	};
}

describe('the download review prompt is a real modal', () => {
	it('has an accessible dialog name and modal semantics', () => {
		const opening = PAGE.indexOf('<aside class="ask ask-prompt"');
		const markup = PAGE.slice(opening, PAGE.indexOf('</aside>', opening));
		expect(opening).toBeGreaterThanOrEqual(0);
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain('aria-modal="true"');
		expect(markup).toContain('aria-labelledby="review-prompt-title"');
		expect(markup).toContain('<h2 id="review-prompt-title">');
	});

	it('focuses the first action and makes every background branch inert', () => {
		const current = page();
		current.route.focus();
		current.clickRoute();
		expect(current.active()).toBe(current.proceed);
		expect(current.root.inert).toBe(true);
		expect(current.header.inert).toBe(true);
		expect(current.footer.inert).toBe(true);
		expect(current.prompt.inert).toBe(false);
	});

	it('contains Tab and Shift+Tab at both ends', () => {
		const current = page();
		current.clickRoute();
		current.dismiss.focus();
		expect(current.press('Tab')).toBe(true);
		expect(current.active()).toBe(current.proceed);
		current.proceed.focus();
		expect(current.press('Tab', true)).toBe(true);
		expect(current.active()).toBe(current.dismiss);
	});

	it('Escape restores the download link and the prior inert state', () => {
		const current = page();
		current.header.inert = true;
		current.route.focus();
		current.clickRoute();
		current.press('Escape');
		expect(current.prompt.hidden).toBe(true);
		expect(current.active()).toBe(current.route);
		expect(current.root.inert).toBe(false);
		expect(current.footer.inert).toBe(false);
		expect(current.header.inert).toBe(true);
	});

	it('the dismiss button restores focus without navigating', () => {
		const current = page();
		current.route.focus();
		current.clickRoute();
		current.dismiss.dispatch('click');
		expect(current.prompt.hidden).toBe(true);
		expect(current.active()).toBe(current.route);
	});
});
