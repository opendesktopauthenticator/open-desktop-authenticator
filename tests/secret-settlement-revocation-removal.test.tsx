import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { DEACTIVATE_ACK } from '../src/shared/acknowledgements';
import type { AccountSummary } from '../src/shared/ipc';

class HookHarness {
	private states: unknown[] = [];
	private readonly initialized = new Set<number>();
	private cursor = 0;
	readonly writes: Array<{ index: number; value: unknown }> = [];

	readonly useState = <T,>(initial: T | (() => T)) => {
		const index = this.cursor++;
		if (!this.initialized.has(index)) {
			this.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
			this.initialized.add(index);
		}
		const set = (next: T | ((previous: T) => T)): void => {
			const previous = this.states[index] as T;
			const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
			this.states[index] = value;
			this.writes.push({ index, value });
		};
		return [this.states[index] as T, set] as const;
	};

	render<T>(run: () => T): T {
		this.cursor = 0;
		return run();
	}

	state(index: number): unknown {
		return this.states[index];
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

function firstForm(tree: ReactNode): ReactElement {
	const match = elements(tree).find((element) => element.type === 'form');
	if (!match) throw new Error('The screen rendered no form');
	return match;
}

function button(tree: ReactNode, label: string): ReactElement {
	const match = elements(tree).find(
		(element) => element.type === 'button' && text(element).replace(/\s+/g, ' ').trim() === label
	);
	if (!match) throw new Error(`The screen rendered no “${label}” button`);
	return match;
}

function change(element: ReactElement, value: string): void {
	const onChange = (element.props as { onChange?: (event: unknown) => void }).onChange;
	if (!onChange) throw new Error('The field has no change handler');
	onChange({ target: { value } });
}

function submit(element: ReactElement): void {
	const onSubmit = (element.props as { onSubmit?: (event: unknown) => void }).onSubmit;
	if (!onSubmit) throw new Error('The form has no submit handler');
	onSubmit({ preventDefault: () => undefined });
}

function click(element: ReactElement): void {
	const onClick = (element.props as { onClick?: () => void }).onClick;
	if (!onClick) throw new Error('The button has no click handler');
	onClick();
}

function value(element: ReactElement): unknown {
	return (element.props as { value?: unknown }).value;
}

function disabled(element: ReactElement): boolean {
	return (element.props as { disabled?: boolean }).disabled === true;
}

function checkbox(tree: ReactNode): ReactElement {
	const match = elements(tree).find(
		(element) =>
			element.type === 'input' && (element.props as { type?: string }).type === 'checkbox'
	);
	if (!match) throw new Error('The screen rendered no checkbox');
	return match;
}

function check(element: ReactElement, checked: boolean): void {
	const onChange = (element.props as { onChange?: (event: unknown) => void }).onChange;
	if (!onChange) throw new Error('The checkbox has no change handler');
	onChange({ target: { checked } });
}

function expectClearBeforeRelease(
	hooks: HookHarness,
	secretState: number,
	busyState: number
): void {
	let clear = -1;
	let release = -1;
	for (const [position, write] of hooks.writes.entries()) {
		if (write.index === secretState && write.value === '') clear = position;
		if (write.index === busyState && write.value === false) release = position;
	}
	expect(clear, 'the submitted secret was never cleared').toBeGreaterThanOrEqual(0);
	expect(release, 'the operation never released its busy state').toBeGreaterThan(clear);
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function mountedScreens() {
	const hooks = new HookHarness();
	vi.resetModules();
	vi.doMock('react', async () => {
		const actual = await vi.importActual<typeof import('react')>('react');
		return { ...actual, useState: hooks.useState };
	});
	const [{ RevocationBackup }, { RemoveAccount }] = await Promise.all([
		import('../src/renderer/screens/RevocationBackup'),
		import('../src/renderer/screens/RemoveAccount')
	]);
	return { hooks, RevocationBackup, RemoveAccount };
}

const ACCOUNT = {
	steamId64: '76561198000000001',
	accountName: 'trader',
	status: 'active',
	hasRevocationCode: true,
	hasProxy: false,
	routing: 'off',
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

describe('revocation-code reveal secret settlement', () => {
	it('clears the submitted passphrase after an asynchronous rejection and keeps the error', async () => {
		const { hooks, RevocationBackup } = await mountedScreens();
		const attempt = deferred<{ revocationCode: string }>();
		const render = () =>
			hooks.render(() =>
				RevocationBackup({
					accountName: ACCOUNT.accountName,
					steamId64: ACCOUNT.steamId64,
					onReveal: () => attempt.promise,
					onConfirm: () => Promise.resolve(),
					onClose: () => undefined
				})
			);

		change(byId(render(), 'ceremony-passphrase'), 'wrong secret');
		submit(firstForm(render()));
		expect(disabled(byId(render(), 'ceremony-passphrase'))).toBe(true);
		attempt.reject(new Error('wrong passphrase'));
		await settle();

		const tree = render();
		expect(value(byId(tree, 'ceremony-passphrase'))).toBe('');
		expect(text(tree)).toContain('wrong passphrase');
		expectClearBeforeRelease(hooks, 0, 2);
	});

	it('clears the submitted passphrase after success while preserving the revealed code', async () => {
		const { hooks, RevocationBackup } = await mountedScreens();
		const render = () =>
			hooks.render(() =>
				RevocationBackup({
					accountName: ACCOUNT.accountName,
					steamId64: ACCOUNT.steamId64,
					onReveal: () => Promise.resolve({ revocationCode: 'R12345' }),
					onConfirm: () => Promise.resolve(),
					onClose: () => undefined
				})
			);

		change(byId(render(), 'ceremony-passphrase'), 'correct secret');
		submit(firstForm(render()));
		await settle();

		expect(hooks.state(0)).toBe('');
		expect(text(render())).toContain('R12345');
	});

	it('also clears and reports a synchronous callback throw', async () => {
		const { hooks, RevocationBackup } = await mountedScreens();
		const render = () =>
			hooks.render(() =>
				RevocationBackup({
					accountName: ACCOUNT.accountName,
					steamId64: ACCOUNT.steamId64,
					onReveal: () => {
						throw new Error('synchronous reveal refusal');
					},
					onConfirm: () => Promise.resolve(),
					onClose: () => undefined
				})
			);

		change(byId(render(), 'ceremony-passphrase'), 'submitted secret');
		expect(() => submit(firstForm(render()))).not.toThrow();
		await settle();

		const tree = render();
		expect(value(byId(tree, 'ceremony-passphrase'))).toBe('');
		expect(text(tree)).toContain('synchronous reveal refusal');
	});
});

function removalProps(overrides: Record<string, unknown> = {}) {
	return {
		account: ACCOUNT,
		onRemove: () => Promise.resolve(),
		onDeactivate: () => Promise.resolve({}),
		onResolve: () => Promise.resolve(),
		onClearStale: () => Promise.resolve(),
		onClose: () => undefined,
		...overrides
	};
}

describe('ordinary account-removal secret settlement', () => {
	it('clears the submitted passphrase after rejection and keeps the error', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const attempt = deferred<unknown>();
		const render = () =>
			hooks.render(() => RemoveAccount(removalProps({ onRemove: () => attempt.promise }) as never));

		change(byId(render(), 'remove-passphrase'), 'wrong secret');
		submit(firstForm(render()));
		attempt.reject(new Error('removal refused'));
		await settle();

		const tree = render();
		expect(value(byId(tree, 'remove-passphrase'))).toBe('');
		expect(text(tree)).toContain('removal refused');
	});

	it('clears after success and preserves closing behavior', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const onClose = vi.fn();
		const render = () => hooks.render(() => RemoveAccount(removalProps({ onClose }) as never));

		change(byId(render(), 'remove-passphrase'), 'correct secret');
		submit(firstForm(render()));
		await settle();

		expect(value(byId(render(), 'remove-passphrase'))).toBe('');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('keeps the passphrase control unavailable until settlement and preserves non-secret choices', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const attempt = deferred<unknown>();
		const render = () =>
			hooks.render(() =>
				RemoveAccount(removalProps({ onDeactivate: () => attempt.promise }) as never)
			);

		check(checkbox(render()), true);
		change(byId(render(), 'remove-ack'), DEACTIVATE_ACK);
		change(byId(render(), 'remove-passphrase'), 'submitted secret');
		submit(firstForm(render()));
		expect(disabled(byId(render(), 'remove-passphrase'))).toBe(true);
		attempt.reject(new Error('detach refused'));
		await settle();

		const tree = render();
		expect(value(byId(tree, 'remove-passphrase'))).toBe('');
		expect(value(byId(tree, 'remove-ack'))).toBe(DEACTIVATE_ACK);
		expect((checkbox(tree).props as { checked?: boolean }).checked).toBe(true);
		expectClearBeforeRelease(hooks, 0, 3);
	});

	it('also clears and reports a synchronous callback throw', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const render = () =>
			hooks.render(() =>
				RemoveAccount(
					removalProps({
						onRemove: () => {
							throw new Error('synchronous removal refusal');
						}
					}) as never
				)
			);

		change(byId(render(), 'remove-passphrase'), 'submitted secret');
		expect(() => submit(firstForm(render()))).not.toThrow();
		await settle();

		const tree = render();
		expect(value(byId(tree, 'remove-passphrase'))).toBe('');
		expect(text(tree)).toContain('synchronous removal refusal');
	});
});

function unresolvedAccount(): AccountSummary {
	return {
		...ACCOUNT,
		// This is the cross-kind legacy shape: the row still says activation is
		// pending while the durable operation says a deactivation must be settled.
		status: 'pendingActivation',
		unresolvedOperation: {
			kind: 'deactivate',
			guidance: 'Check what Steam did.',
			at: '2026-09-04T00:00:00.000Z',
			operationToken: 'a'.repeat(64)
		}
	};
}

describe('stored-outcome removal secret settlement', () => {
	it('clears the submitted passphrase after rejection and keeps the error', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const attempt = deferred<unknown>();
		const render = () =>
			hooks.render(() =>
				RemoveAccount(
					removalProps({ account: unresolvedAccount(), onResolve: () => attempt.promise }) as never
				)
			);

		change(byId(render(), 'resolve-passphrase'), 'wrong secret');
		click(button(render(), 'Steam Guard is off — remove this account here'));
		attempt.reject(new Error('resolution refused'));
		await settle();

		const tree = render();
		expect(value(byId(tree, 'resolve-passphrase'))).toBe('');
		expect(text(tree)).toContain('resolution refused');
	});

	it('clears after success and preserves closing behavior', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const onClose = vi.fn();
		const onResolve = vi.fn(() => Promise.resolve());
		const render = () =>
			hooks.render(() =>
				RemoveAccount(removalProps({ account: unresolvedAccount(), onResolve, onClose }) as never)
			);

		change(byId(render(), 'resolve-passphrase'), 'correct secret');
		click(button(render(), 'Steam Guard is off — remove this account here'));
		await settle();

		expect(value(byId(render(), 'resolve-passphrase'))).toBe('');
		expect(onResolve).toHaveBeenCalledWith('deactivate', 'a'.repeat(64), true, 'correct secret');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('keeps the passphrase control unavailable until settlement', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const attempt = deferred<unknown>();
		const render = () =>
			hooks.render(() =>
				RemoveAccount(
					removalProps({ account: unresolvedAccount(), onResolve: () => attempt.promise }) as never
				)
			);

		change(byId(render(), 'resolve-passphrase'), 'submitted secret');
		click(button(render(), 'Steam Guard is off — remove this account here'));
		expect(disabled(byId(render(), 'resolve-passphrase'))).toBe(true);
		attempt.reject(new Error('old resolution refused'));
		await settle();

		expect(value(byId(render(), 'resolve-passphrase'))).toBe('');
		expectClearBeforeRelease(hooks, 7, 6);
	});

	it('also clears and reports a synchronous callback throw', async () => {
		const { hooks, RemoveAccount } = await mountedScreens();
		const render = () =>
			hooks.render(() =>
				RemoveAccount(
					removalProps({
						account: unresolvedAccount(),
						onResolve: () => {
							throw new Error('synchronous resolution refusal');
						}
					}) as never
				)
			);

		change(byId(render(), 'resolve-passphrase'), 'submitted secret');
		expect(() =>
			click(button(render(), 'Steam Guard is off — remove this account here'))
		).not.toThrow();
		await settle();

		const tree = render();
		expect(value(byId(tree, 'resolve-passphrase'))).toBe('');
		expect(text(tree)).toContain('synchronous resolution refusal');
	});
});
