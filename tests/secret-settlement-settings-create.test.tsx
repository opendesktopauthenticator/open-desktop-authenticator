import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * A tiny stateful renderer for the two forms under test. The project has no DOM
 * test dependency; this runs the real component functions and preserves their
 * hook state across renders so promise settlement can be observed directly.
 */
class HookHarness {
	private states: unknown[] = [];
	private readonly initialized = new Set<number>();
	private cursor = 0;
	readonly transitions: Array<{ index: number; value: unknown }> = [];

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
			this.transitions.push({ index, value });
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

function changeValue(element: ReactElement, value: string): void {
	const onChange = (element.props as { onChange?: (event: unknown) => void }).onChange;
	if (!onChange) throw new Error('The field has no change handler');
	onChange({ target: { value } });
}

function valueOf(tree: ReactNode, id: string): unknown {
	return (byId(tree, id).props as { value?: unknown }).value;
}

function text(node: ReactNode): string {
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(text).join('');
	if (!isValidElement(node)) return '';
	return text((node.props as { children?: ReactNode }).children);
}

function button(tree: ReactNode, label: string): ReactElement {
	const match = elements(tree).find(
		(element) => element.type === 'button' && text(element).replace(/\s+/g, ' ').trim() === label
	);
	if (!match) throw new Error(`The screen rendered no “${label}” button`);
	return match;
}

function click(element: ReactElement): void {
	const onClick = (element.props as { onClick?: () => void }).onClick;
	if (!onClick) throw new Error('The button has no click handler');
	onClick();
}

function submit(form: ReactElement): void {
	const onSubmit = (form.props as { onSubmit?: (event: unknown) => void }).onSubmit;
	if (!onSubmit) throw new Error('The form has no submit handler');
	onSubmit({ preventDefault: () => undefined });
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

async function mountedScreens() {
	const hooks = new HookHarness();
	vi.resetModules();
	vi.doMock('react', async () => {
		const actual = await vi.importActual<typeof import('react')>('react');
		return { ...actual, useState: hooks.useState };
	});
	const [{ PassphraseChange }, { CreateVault }] = await Promise.all([
		import('../src/renderer/screens/Settings'),
		import('../src/renderer/screens/CreateVault')
	]);
	return { hooks, PassphraseChange, CreateVault };
}

afterEach(() => {
	vi.doUnmock('react');
	vi.resetModules();
});

describe('submitted passphrases leave Settings state on settlement', () => {
	it.each(['success', 'rejection', 'synchronous throw'] as const)(
		'clears all three fields after %s',
		async (outcome) => {
			const { hooks, PassphraseChange } = await mountedScreens();
			const gate = deferred<unknown>();
			const onChange = vi.fn(() => {
				if (outcome === 'synchronous throw') throw new Error('bridge threw before returning');
				return gate.promise;
			});
			let releasedValues: unknown[] | undefined;
			const props = {
				onChange,
				onBusy: (busy: boolean): void => {
					if (busy) return;
					const released = hooks.render(() => PassphraseChange(props));
					releasedValues = [
						valueOf(released, 'passphrase-current'),
						valueOf(released, 'passphrase-next'),
						valueOf(released, 'passphrase-confirm')
					];
				}
			};
			let tree = hooks.render(() => PassphraseChange(props));
			changeValue(byId(tree, 'passphrase-current'), 'submitted-current-passphrase');
			changeValue(byId(tree, 'passphrase-next'), 'submitted-next-passphrase');
			changeValue(byId(tree, 'passphrase-confirm'), 'submitted-next-passphrase');
			tree = hooks.render(() => PassphraseChange(props));

			submit(firstForm(tree));
			tree = hooks.render(() => PassphraseChange(props));
			for (const id of ['passphrase-current', 'passphrase-next', 'passphrase-confirm']) {
				expect((byId(tree, id).props as { disabled?: boolean }).disabled, id).toBe(true);
			}

			if (outcome === 'success') gate.resolve(undefined);
			else if (outcome === 'rejection') gate.reject(new Error('current passphrase rejected'));
			await settle();
			tree = hooks.render(() => PassphraseChange(props));

			expect(onChange).toHaveBeenCalledWith(
				'submitted-current-passphrase',
				'submitted-next-passphrase'
			);
			for (const id of ['passphrase-current', 'passphrase-next', 'passphrase-confirm']) {
				expect(valueOf(tree, id), `${id} retained its submitted secret after ${outcome}`).toBe('');
			}
			expect(releasedValues, 'the parent was released before the fields were cleared').toEqual([
				'',
				'',
				''
			]);
			if (outcome === 'success') expect(text(tree)).toContain('Changed.');
			else expect(text(tree)).toMatch(/current passphrase rejected|bridge threw before returning/);
		}
	);
});

describe('submitted passphrases leave Create vault state on settlement', () => {
	it.each(['success', 'rejection', 'synchronous throw'] as const)(
		'clears both copies after %s',
		async (outcome) => {
			const { hooks, CreateVault } = await mountedScreens();
			const gate = deferred<void>();
			const onCreate = vi.fn(() => {
				if (outcome === 'synchronous throw') throw new Error('bridge threw before returning');
				return gate.promise;
			});
			const props = {
				onCreate,
				backupAvailable: false,
				onRestoreBackup: vi.fn(() => Promise.resolve()),
				onAdopt: vi.fn(() => Promise.resolve({ state: 'cancelled' as const }))
			};
			let tree = hooks.render(() => CreateVault(props));
			changeValue(byId(tree, 'passphrase'), 'submitted vault passphrase long enough');
			changeValue(byId(tree, 'confirmation'), 'submitted vault passphrase long enough');
			const acknowledgement = elements(tree).find(
				(element) =>
					element.type === 'input' && (element.props as { type?: string }).type === 'checkbox'
			);
			if (!acknowledgement) throw new Error('The recovery acknowledgement is missing');
			(acknowledgement.props as { onChange: (event: unknown) => void }).onChange({
				target: { checked: true }
			});
			tree = hooks.render(() => CreateVault(props));

			submit(firstForm(tree));
			tree = hooks.render(() => CreateVault(props));
			if (outcome !== 'synchronous throw') {
				for (const id of ['passphrase', 'confirmation']) {
					expect((byId(tree, id).props as { disabled?: boolean }).disabled, id).toBe(true);
				}
			}

			if (outcome === 'success') gate.resolve();
			else if (outcome === 'rejection') gate.reject(new Error('vault creation rejected'));
			await settle();
			tree = hooks.render(() => CreateVault(props));

			expect(onCreate).toHaveBeenCalledWith('submitted vault passphrase long enough');
			for (const id of ['passphrase', 'confirmation']) {
				expect(valueOf(tree, id), `${id} retained its submitted secret after ${outcome}`).toBe('');
			}
			const settledAcknowledgement = elements(tree).find(
				(element) =>
					element.type === 'input' && (element.props as { type?: string }).type === 'checkbox'
			);
			expect(
				(settledAcknowledgement?.props as { checked?: boolean } | undefined)?.checked,
				'credential cleanup reset unrelated recovery acknowledgement state'
			).toBe(true);
			if (outcome === 'success') {
				expect((byId(tree, 'passphrase').props as { disabled?: boolean }).disabled).toBe(true);
			} else {
				expect((byId(tree, 'passphrase').props as { disabled?: boolean }).disabled).toBe(false);
				expect(text(tree)).toMatch(/vault creation rejected|bridge threw before returning/);
			}
		}
	);
});

describe('an adopted-vault passphrase leaves Create vault state on settlement', () => {
	it.each(['adopted', 'cancelled', 'rejection', 'synchronous throw'] as const)(
		'clears the field after %s without changing the result behavior',
		async (outcome) => {
			const { hooks, CreateVault } = await mountedScreens();
			const gate = deferred<{ state: 'adopted' | 'cancelled' }>();
			const onAdopt = vi.fn(() => {
				if (outcome === 'synchronous throw') throw new Error('adoption bridge threw');
				return gate.promise;
			});
			const props = {
				onCreate: vi.fn(() => Promise.resolve()),
				backupAvailable: false,
				onRestoreBackup: vi.fn(() => Promise.resolve()),
				onAdopt
			};
			const render = () => hooks.render(() => CreateVault(props));

			changeValue(byId(render(), 'adopt-passphrase'), 'existing vault secret');
			expect(() => click(button(render(), 'Load a vault file…'))).not.toThrow();
			expect((byId(render(), 'adopt-passphrase').props as { disabled?: boolean }).disabled).toBe(
				true
			);
			hooks.clearTransitions();

			if (outcome === 'adopted') gate.resolve({ state: 'adopted' });
			else if (outcome === 'cancelled') gate.resolve({ state: 'cancelled' });
			else if (outcome === 'rejection') gate.reject(new Error('adoption rejected'));
			await settle();

			const tree = render();
			expect(onAdopt).toHaveBeenCalledWith('existing vault secret');
			expect(valueOf(tree, 'adopt-passphrase')).toBe('');
			expect((byId(tree, 'adopt-passphrase').props as { disabled?: boolean }).disabled).toBe(false);
			const cleared = hooks.transitions.findIndex(
				(transition) => transition.index === 7 && transition.value === ''
			);
			const released = hooks.transitions.findIndex(
				(transition) => transition.index === 3 && transition.value === false
			);
			expect(cleared, 'the adopted-vault secret was not cleared').toBeGreaterThanOrEqual(0);
			expect(released, 'busy was released before the secret was cleared').toBeGreaterThan(cleared);

			if (outcome === 'cancelled') expect(text(tree)).toContain('No file was chosen');
			else expect(text(tree)).not.toContain('No file was chosen');
			if (outcome === 'rejection') expect(text(tree)).toContain('adoption rejected');
			else if (outcome === 'synchronous throw')
				expect(text(tree)).toContain('adoption bridge threw');
			else expect(text(tree)).not.toMatch(/adoption rejected|adoption bridge threw/);
		}
	);
});
