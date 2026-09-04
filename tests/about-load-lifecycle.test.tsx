import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '../src/shared/ipc';
import { attribution, branding } from '../src/shared/branding';

type Cleanup = void | (() => void);
type Effect = {
	deps: readonly unknown[] | undefined;
	cleanup: Cleanup;
};

/**
 * The project intentionally has no browser-DOM component-test dependency.
 * This small hook runner exercises the real component one boundary lower: it
 * preserves hook state between renders, applies dependency rules, and runs
 * effect cleanup on dependency changes and unmount. JSX is still produced by
 * React's real runtime; only the three hooks About uses are substituted.
 */
class HookHarness {
	private states: unknown[] = [];
	private readonly initializedStates = new Set<number>();
	private refs: { current: unknown }[] = [];
	private effects: (Effect | undefined)[] = [];
	private pendingEffects: {
		index: number;
		create: () => Cleanup;
		deps: readonly unknown[] | undefined;
	}[] = [];
	private stateCursor = 0;
	private refCursor = 0;
	private effectCursor = 0;
	stateWrites = 0;

	readonly useState = <T,>(initial: T | (() => T)) => {
		const index = this.stateCursor++;
		if (!this.initializedStates.has(index)) {
			this.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
			this.initializedStates.add(index);
		}
		const set = (next: T | ((previous: T) => T)) => {
			const previous = this.states[index] as T;
			this.states[index] =
				typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
			this.stateWrites += 1;
		};
		return [this.states[index] as T, set] as const;
	};

	readonly useRef = <T,>(initial: T) => {
		const index = this.refCursor++;
		if (this.refs[index] === undefined) this.refs[index] = { current: initial };
		return this.refs[index] as { current: T };
	};

	readonly useEffect = (create: () => Cleanup, deps?: readonly unknown[]): void => {
		const index = this.effectCursor++;
		const previous = this.effects[index];
		const changed =
			previous === undefined ||
			deps === undefined ||
			previous.deps === undefined ||
			deps.length !== previous.deps.length ||
			deps.some((dependency, position) => !Object.is(dependency, previous.deps?.[position]));
		if (changed) this.pendingEffects.push({ index, create, deps });
	};

	render(run: () => unknown): void {
		this.stateCursor = 0;
		this.refCursor = 0;
		this.effectCursor = 0;
		this.pendingEffects = [];
		run();
		for (const pending of this.pendingEffects) {
			this.effects[pending.index]?.cleanup?.();
			this.effects[pending.index] = {
				deps: pending.deps,
				cleanup: pending.create()
			};
		}
		this.pendingEffects = [];
	}

	unmount(): void {
		for (const effect of this.effects) effect?.cleanup?.();
		this.effects = [];
	}

	resetForRemount(): void {
		this.unmount();
		this.states = [];
		this.initializedStates.clear();
		this.refs = [];
		this.stateCursor = 0;
		this.refCursor = 0;
		this.effectCursor = 0;
	}
}

const INFO: AppInfo = {
	productName: branding.productName,
	version: '1.5.0',
	company: branding.company,
	companyShort: branding.companyShort,
	companyWebsite: branding.companyWebsite,
	website: branding.website,
	repository: branding.repository,
	brandingUnresolved: false,
	platform: 'win32',
	installedFromStore: false,
	notificationsAvailable: true,
	attribution: { mckay: attribution.mckay, valve: attribution.valve },
	security: { sandbox: true, contextIsolation: true, nodeIntegration: false }
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function mountedAbout() {
	const hooks = new HookHarness();
	vi.resetModules();
	vi.doMock('react', async () => {
		const actual = await vi.importActual<typeof import('react')>('react');
		return {
			...actual,
			useEffect: hooks.useEffect,
			useRef: hooks.useRef,
			useState: hooks.useState
		};
	});
	const { About } = await import('../src/renderer/screens/About');
	return { About, hooks };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.doUnmock('react');
	vi.resetModules();
});

describe('About metadata loading lifecycle', () => {
	it('loads once per mount even when rerenders receive new callback identities', async () => {
		const { About, hooks } = await mountedAbout();
		const firstResult = deferred<AppInfo>();
		const first = vi.fn(() => firstResult.promise);
		const second = vi.fn(() => Promise.resolve(INFO));
		const third = vi.fn(() => Promise.resolve(INFO));
		const render = (onLoad: () => Promise<AppInfo>) =>
			hooks.render(() => About({ onClose: () => undefined, onLoad }));

		render(first);
		render(second);
		render(third);

		expect(first).toHaveBeenCalledTimes(1);
		expect(second, 'a parent rerender started a second metadata request').not.toHaveBeenCalled();
		expect(
			third,
			'a later parent rerender started a third metadata request'
		).not.toHaveBeenCalled();
		hooks.unmount();
		firstResult.resolve(INFO);
		await settle();
	});

	it('loads once again after a real remount', async () => {
		const { About, hooks } = await mountedAbout();
		const first = vi.fn(() => Promise.resolve(INFO));
		const second = vi.fn(() => Promise.resolve(INFO));

		hooks.render(() => About({ onClose: () => undefined, onLoad: first }));
		hooks.resetForRemount();
		hooks.render(() => About({ onClose: () => undefined, onLoad: second }));

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		await settle();
	});

	it('ignores a response that arrives after unmount', async () => {
		const { About, hooks } = await mountedAbout();
		const result = deferred<AppInfo>();

		hooks.render(() => About({ onClose: () => undefined, onLoad: () => result.promise }));
		expect(hooks.stateWrites).toBe(0);
		hooks.unmount();

		result.resolve(INFO);
		await settle();

		expect(hooks.stateWrites, 'an unmounted About screen accepted a late response').toBe(0);
	});
});
