import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { AccountSummary } from '../src/shared/ipc';

type Transition = { index: number; previous: unknown; next: unknown };

class HookHarness {
	private readonly states: unknown[] = [];
	private readonly initialized = new Set<number>();
	private cursor = 0;
	readonly transitions: Transition[] = [];

	readonly useState = <T,>(initial: T | (() => T)) => {
		const index = this.cursor++;
		if (!this.initialized.has(index)) {
			this.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
			this.initialized.add(index);
		}
		const set = (value: T | ((previous: T) => T)): void => {
			const previous = this.states[index] as T;
			const next = typeof value === 'function' ? (value as (previous: T) => T)(previous) : value;
			this.states[index] = next;
			this.transitions.push({ index, previous, next });
		};
		return [this.states[index] as T, set] as const;
	};

	render<T>(run: () => T): T {
		this.cursor = 0;
		return run();
	}

	clearTransitions(): void {
		this.transitions.length = 0;
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function elements(node: ReactNode): ReactElement[] {
	const found: ReactElement[] = [];
	const visit = (value: ReactNode): void => {
		if (Array.isArray(value)) {
			for (const child of value as ReactNode[]) visit(child);
			return;
		}
		if (!isValidElement(value)) return;
		found.push(value);
		visit((value.props as { children?: ReactNode }).children);
	};
	visit(node);
	return found;
}

function text(node: ReactNode): string {
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(text).join('');
	if (!isValidElement(node)) return '';
	return text((node.props as { children?: ReactNode }).children);
}

function byId(tree: ReactNode, id: string): ReactElement {
	const match = elements(tree).find((element) => (element.props as { id?: string }).id === id);
	if (!match) throw new Error(`No rendered element has id ${id}`);
	return match;
}

function button(tree: ReactNode, label: string): ReactElement {
	const match = elements(tree).find(
		(element) => element.type === 'button' && text(element).replace(/\s+/g, ' ').trim() === label
	);
	if (!match) throw new Error(`No rendered button says ${label}`);
	return match;
}

function change(element: ReactElement, value: string): void {
	const onChange = (element.props as { onChange?: (event: unknown) => void }).onChange;
	if (!onChange) throw new Error('The field has no change handler');
	onChange({ target: { value } });
}

function submit(tree: ReactNode): void {
	const form = elements(tree).find((element) => element.type === 'form');
	const onSubmit = (form?.props as { onSubmit?: (event: unknown) => void } | undefined)?.onSubmit;
	if (!onSubmit) throw new Error('The routing form has no submit handler');
	onSubmit({ preventDefault: () => undefined });
}

function click(element: ReactElement): void {
	const onClick = (element.props as { onClick?: () => void }).onClick;
	if (!onClick) throw new Error('The button has no click handler');
	onClick();
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

async function mountedRouting() {
	const hooks = new HookHarness();
	vi.resetModules();
	vi.doMock('react', async () => {
		const actual = await vi.importActual<typeof import('react')>('react');
		return { ...actual, useState: hooks.useState };
	});
	const { AccountRouting } = await import('../src/renderer/screens/AccountRouting');
	return { hooks, AccountRouting };
}

const ACCOUNT = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	status: 'active',
	hasRevocationCode: true,
	hasProxy: true,
	routing: 'verified',
	routedVia: '203.0.113.8',
	autoConfirm: {
		marketListings: false,
		trades: false,
		pollIntervalSeconds: 30,
		notify: { enabled: false, detail: 'count' }
	}
} as AccountSummary;

afterEach(() => {
	vi.doUnmock('react');
	vi.resetModules();
});

describe('routing credential settlement', () => {
	it.each(['success', 'rejection', 'synchronous throw'] as const)(
		'clears the submitted proxy URL after %s without changing the selected account mode',
		async (outcome) => {
			const { hooks, AccountRouting } = await mountedRouting();
			const gate = deferred<unknown>();
			const onSave = vi.fn((_proxyUrl: string | null) => {
				if (outcome === 'synchronous throw') throw new Error('bridge refused synchronously');
				return gate.promise;
			});
			const onClose = vi.fn();
			const render = () =>
				hooks.render(() => AccountRouting({ account: ACCOUNT, onSave, onClose }));

			change(byId(render(), 'proxy-address'), '  http://user:secret@proxy.example:8080  ');
			expect(() => submit(render())).not.toThrow();
			const pending = render();
			expect((byId(pending, 'proxy-address').props as { disabled?: boolean }).disabled).toBe(true);

			if (outcome === 'success') gate.resolve(undefined);
			else if (outcome === 'rejection') gate.reject(new Error('proxy save was refused'));
			await settle();

			const settled = render();
			expect(onSave).toHaveBeenCalledWith('http://user:secret@proxy.example:8080');
			expect((byId(settled, 'proxy-address').props as { value?: unknown }).value).toBe('');
			expect(text(settled)).toContain('traffic left through 203.0.113.8');
			if (outcome === 'success') {
				expect(onClose).toHaveBeenCalledTimes(1);
			} else {
				expect(onClose).not.toHaveBeenCalled();
				expect(text(settled)).toContain(
					outcome === 'rejection' ? 'proxy save was refused' : 'bridge refused synchronously'
				);
			}
		}
	);

	it('clears the address before releasing the busy state', async () => {
		const { hooks, AccountRouting } = await mountedRouting();
		const gate = deferred<unknown>();
		const render = () =>
			hooks.render(() =>
				AccountRouting({ account: ACCOUNT, onSave: () => gate.promise, onClose: () => undefined })
			);

		change(byId(render(), 'proxy-address'), 'http://user:secret@proxy.example:8080');
		submit(render());
		hooks.clearTransitions();
		gate.reject(new Error('refused'));
		await settle();

		const cleared = hooks.transitions.findIndex(
			(change) => change.index === 0 && change.next === ''
		);
		const released = hooks.transitions.findIndex(
			(change) => change.index === 1 && change.next === false
		);
		expect(cleared).toBeGreaterThanOrEqual(0);
		expect(released).toBeGreaterThan(cleared);
	});

	it('also relinquishes a typed credential when removing the saved route is refused', async () => {
		const { hooks, AccountRouting } = await mountedRouting();
		const gate = deferred<unknown>();
		const onSave = vi.fn(() => gate.promise);
		const render = () =>
			hooks.render(() => AccountRouting({ account: ACCOUNT, onSave, onClose: () => undefined }));

		change(byId(render(), 'proxy-address'), 'http://user:secret@unused.example:8080');
		click(button(render(), 'Stop routing this account'));
		gate.reject(new Error('could not remove route'));
		await settle();

		const settled = render();
		expect(onSave).toHaveBeenCalledWith(null);
		expect((byId(settled, 'proxy-address').props as { value?: unknown }).value).toBe('');
		expect(text(settled)).toContain('could not remove route');
		expect(text(settled)).toContain('Stop routing this account');
	});
});
