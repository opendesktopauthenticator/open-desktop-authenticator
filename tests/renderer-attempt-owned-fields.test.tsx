import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
	accountSummary,
	type AccountSummary,
	type EnrollmentStatus,
	type SignInResult,
	type TransferStatus
} from '../src/shared/ipc';

/**
 * The project intentionally has no browser-DOM test dependency. This runner
 * executes the real screen functions and preserves their hook state between
 * renders; only effects are suppressed so the initial credential forms remain
 * the subject of the test.
 */
class HookHarness {
	private states: unknown[] = [];
	private readonly initialized = new Set<number>();
	private refs: { current: unknown }[] = [];
	private effects: Array<() => void | (() => void)> = [];
	private collectingEffects = false;
	private stateCursor = 0;
	private refCursor = 0;

	readonly useState = <T,>(initial: T | (() => T)) => {
		const index = this.stateCursor++;
		if (!this.initialized.has(index)) {
			this.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
			this.initialized.add(index);
		}
		const set = (next: T | ((previous: T) => T)): void => {
			const previous = this.states[index] as T;
			this.states[index] =
				typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
		};
		return [this.states[index] as T, set] as const;
	};

	readonly useRef = <T,>(initial: T): { current: T } => {
		const index = this.refCursor++;
		if (this.refs[index] === undefined) this.refs[index] = { current: initial };
		return this.refs[index] as { current: T };
	};

	readonly useEffect = (effect: () => void | (() => void)): void => {
		if (this.collectingEffects) this.effects.push(effect);
	};
	readonly useCallback = <T extends (...args: never[]) => unknown>(callback: T): T => callback;

	render<T>(run: () => T): T {
		this.stateCursor = 0;
		this.refCursor = 0;
		return run();
	}

	renderAndStartEffects<T>(run: () => T): T {
		this.collectingEffects = true;
		const rendered = this.render(run);
		this.collectingEffects = false;
		const effects = this.effects;
		this.effects = [];
		for (const effect of effects) effect();
		return rendered;
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

function functionComponent(tree: ReactNode, name: string): ReactElement {
	const component = elements(tree).find(
		(element) => typeof element.type === 'function' && element.type.name === name
	);
	if (!component || typeof component.type !== 'function') {
		throw new Error(`The screen rendered no ${name}`);
	}
	const render = component.type as unknown as (props: unknown) => ReactElement;
	return render(component.props);
}

function byId(tree: ReactNode, id: string): ReactElement {
	const match = elements(tree).find((element) => (element.props as { id?: string }).id === id);
	if (!match) throw new Error(`No rendered element has id ${id}`);
	return match;
}

function firstForm(tree: ReactNode): ReactElement {
	const form = elements(tree).find((element) => element.type === 'form');
	if (!form) throw new Error('The screen rendered no form');
	return form;
}

function button(tree: ReactNode, label: string): ReactElement {
	const match = elements(tree).find(
		(element) => element.type === 'button' && text(element).replace(/\s+/g, ' ').trim() === label
	);
	if (!match) throw new Error(`The screen rendered no “${label}” button in: ${text(tree)}`);
	return match;
}

function click(element: ReactElement): void {
	const onClick = (element.props as { onClick?: () => void }).onClick;
	if (!onClick) throw new Error('The control has no click handler');
	onClick();
}

function disabled(element: ReactElement): boolean {
	return (element.props as { disabled?: boolean }).disabled === true;
}

function change(element: ReactElement, value: string): void {
	const onChange = (element.props as { onChange?: (event: unknown) => void }).onChange;
	if (!onChange) throw new Error('The field has no change handler');
	onChange({ target: { value } });
}

function submit(form: ReactElement): void | Promise<void> {
	const onSubmit = (form.props as { onSubmit?: (event: unknown) => void | Promise<void> }).onSubmit;
	if (!onSubmit) throw new Error('The form has no submit handler');
	return onSubmit({ preventDefault: () => undefined });
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
		return {
			...actual,
			useState: hooks.useState,
			useRef: hooks.useRef,
			useEffect: hooks.useEffect,
			useCallback: hooks.useCallback
		};
	});
	const [
		{ AutoConfirm },
		{ SteamSignIn },
		{ AddAuthenticator },
		{ MoveAuthenticator },
		{ ImportAccounts }
	] = await Promise.all([
		import('../src/renderer/screens/AutoConfirm'),
		import('../src/renderer/screens/SteamSignIn'),
		import('../src/renderer/screens/AddAuthenticator'),
		import('../src/renderer/screens/MoveAuthenticator'),
		import('../src/renderer/screens/ImportAccounts')
	]);
	return { hooks, AutoConfirm, SteamSignIn, AddAuthenticator, MoveAuthenticator, ImportAccounts };
}

const ACCOUNT: AccountSummary = accountSummary.parse({
	steamId64: '76561198000000001',
	accountName: 'trader',
	status: 'active',
	hasRevocationCode: true,
	hasProxy: true,
	routing: 'verified',
	autoConfirm: {
		marketListings: true,
		trades: true,
		pollIntervalSeconds: 15,
		notify: { enabled: true, detail: 'full' }
	}
});

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

const PENDING_ENROLLMENT: NonNullable<EnrollmentStatus['pending']> = {
	attemptId: ATTEMPT_ID,
	steamId64: ACCOUNT.steamId64,
	accountName: ACCOUNT.accountName,
	state: 'unreadable',
	at: '2026-09-03T00:00:00.000Z',
	stored: false,
	certain: true,
	recovery: 'memory',
	usable: false
};

function transferRecoveryStatus(
	awaiting: NonNullable<TransferStatus['awaiting']>,
	state: NonNullable<TransferStatus['recovery']>['state'],
	requiresPassphrase = false
): TransferStatus {
	return {
		awaiting,
		recovery: {
			attemptId: ATTEMPT_ID,
			state,
			at: '2026-09-03T00:00:00.000Z',
			retained: state === 'replacement' || state === 'unreadable',
			...(requiresPassphrase ? { requiresPassphrase: true } : {})
		}
	};
}

afterEach(() => {
	vi.doUnmock('react');
	vi.resetModules();
});

describe('fields owned by an in-flight renderer request', () => {
	it('freezes every automatic-confirmation value until its exact save settles', async () => {
		const { hooks, AutoConfirm } = await mountedScreens();
		const gate = deferred<unknown>();
		const onSave = vi.fn(() => gate.promise);
		const props = {
			account: ACCOUNT,
			accounts: [ACCOUNT],
			requireProxies: false,
			notificationsAvailable: true,
			onSave,
			onClose: vi.fn()
		};
		let tree = hooks.render(() => AutoConfirm(props));

		void submit(firstForm(tree));
		tree = hooks.render(() => AutoConfirm(props));
		const inputs = elements(tree).filter((element) => element.type === 'input');

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(inputs.length).toBeGreaterThan(4);
		expect(
			inputs.every((input) => (input.props as { disabled?: boolean }).disabled === true),
			'a control could show a value different from the immutable payload already being saved'
		).toBe(true);
		gate.resolve(undefined);
		await settle();
	});

	it('keeps the Steam password immutable while that sign-in owns it', async () => {
		const { hooks, SteamSignIn } = await mountedScreens();
		const gate = deferred<SignInResult>();
		const onSignIn = vi.fn(() => gate.promise);
		const onSignedIn = vi.fn();
		const props = { accountName: 'trader', onSignIn, onSignedIn, onCancel: vi.fn() };
		let tree = hooks.render(() => SteamSignIn(props));
		change(byId(tree, 'steam-password'), 'secret');
		tree = hooks.render(() => SteamSignIn(props));

		void submit(firstForm(tree));
		tree = hooks.render(() => SteamSignIn(props));
		expect((byId(tree, 'steam-password').props as { disabled?: boolean }).disabled).toBe(true);
		expect(onSignIn).toHaveBeenCalledWith('secret');

		gate.resolve({ ok: true });
		await settle();
		expect(onSignedIn).toHaveBeenCalledTimes(1);
	});

	it('freezes the account, password, and proxy sent by Add authenticator', async () => {
		const { hooks, AddAuthenticator } = await mountedScreens();
		const gate = deferred<{ state: 'needsEmailCode' }>();
		const onBegin = vi.fn(() => gate.promise);
		const props = {
			requireProxies: false,
			onBegin,
			onEmailCode: vi.fn(() => Promise.resolve({ state: 'needsEmailCode' as const })),
			onCancel: vi.fn(() => Promise.resolve()),
			onActivate: vi.fn(() => Promise.resolve({ state: 'activated' as const })),
			onResolve: vi.fn(() => Promise.resolve({ ok: true as const })),
			onClearStale: vi.fn(() => Promise.resolve()),
			onBackup: vi.fn(),
			onClose: vi.fn(),
			onMove: vi.fn()
		};
		let tree = hooks.render(() => AddAuthenticator(props));
		change(byId(tree, 'enroll-account'), 'trader');
		change(byId(tree, 'enroll-password'), 'secret');
		change(byId(tree, 'enroll-proxy'), 'socks5://proxy.example:1080');
		tree = hooks.render(() => AddAuthenticator(props));

		void submit(firstForm(tree));
		tree = hooks.render(() => AddAuthenticator(props));
		for (const id of ['enroll-account', 'enroll-password', 'enroll-proxy']) {
			expect((byId(tree, id).props as { disabled?: boolean }).disabled, id).toBe(true);
		}
		expect(onBegin).toHaveBeenCalledWith('trader', 'secret', 'socks5://proxy.example:1080');

		gate.resolve({ state: 'needsEmailCode' });
		await settle();
	});

	it('freezes the account, password, Guard code, and proxy sent by Move', async () => {
		const { hooks, MoveAuthenticator } = await mountedScreens();
		const gate = deferred<{
			state: 'authenticated';
			steamId64: string;
			accountName: string;
		}>();
		const onAuthenticate = vi.fn(() => gate.promise);
		const props = {
			requireProxies: false,
			onAuthenticate,
			onCancel: vi.fn(() => Promise.resolve()),
			onStartChallenge: vi.fn(() =>
				Promise.resolve({ shape: 'protobuf' as const, sent: true, eresult: 1 })
			),
			onComplete: vi.fn(() =>
				Promise.resolve({
					steamId64: ACCOUNT.steamId64,
					accountName: ACCOUNT.accountName,
					revocationCode: 'R12345',
					timeOffsetSeconds: 0
				})
			),
			onRetryPersist: vi.fn(() =>
				Promise.resolve({
					steamId64: ACCOUNT.steamId64,
					accountName: ACCOUNT.accountName,
					revocationCode: 'R12345',
					timeOffsetSeconds: 0
				})
			),
			onStatus: vi.fn(() => Promise.resolve({})),
			onAcknowledgeBackup: vi.fn(() => Promise.resolve({ ok: true as const })),
			onClose: vi.fn()
		};
		let tree = hooks.render(() => MoveAuthenticator(props));
		change(byId(tree, 'move-account'), 'trader');
		change(byId(tree, 'move-password'), 'secret');
		change(byId(tree, 'move-code'), 'ABCDE');
		change(byId(tree, 'move-proxy'), 'https://proxy.example:8443');
		tree = hooks.render(() => MoveAuthenticator(props));

		const inFlight = submit(firstForm(tree));
		tree = hooks.render(() => MoveAuthenticator(props));
		for (const id of ['move-account', 'move-password', 'move-code', 'move-proxy']) {
			expect((byId(tree, id).props as { disabled?: boolean }).disabled, id).toBe(true);
		}
		expect(onAuthenticate).toHaveBeenCalledWith(
			'trader',
			'secret',
			'ABCDE',
			'https://proxy.example:8443'
		);

		gate.resolve({ state: 'authenticated', steamId64: ACCOUNT.steamId64, accountName: 'trader' });
		await inFlight;
	});

	it('freezes selected imports and proxy adoption after commit captures them', async () => {
		const { hooks, ImportAccounts } = await mountedScreens();
		const report = {
			cancelled: false,
			candidates: [
				{
					stagingId: 'candidate-1',
					sourceName: 'trader.maFile',
					accountName: 'trader',
					steamId64: ACCOUNT.steamId64,
					hasRevocationCode: true,
					hasProxy: true,
					hasSession: true,
					importable: true,
					warnings: []
				}
			],
			rejected: [],
			locked: []
		};
		const gate = deferred<{ outcomes: [] }>();
		const onCommit = vi.fn(() => gate.promise);
		const props = {
			onScan: vi.fn(() => Promise.resolve(report)),
			onUnlock: vi.fn(() => Promise.resolve(report)),
			onCommit,
			onDiscard: vi.fn(() => Promise.resolve()),
			onClose: vi.fn()
		};
		let tree = hooks.render(() => ImportAccounts(props));
		const choose = elements(tree).find(
			(element) => element.type === 'button' && text(element) === 'Choose files…'
		);
		if (!choose) throw new Error('The file picker button is missing');
		(choose.props as { onClick: () => void }).onClick();
		await settle();
		tree = hooks.render(() => ImportAccounts(props));

		let row = functionComponent(tree, 'CandidateRow');
		let checkboxes = elements(row).filter(
			(element) =>
				element.type === 'input' && (element.props as { type?: string }).type === 'checkbox'
		);
		expect(checkboxes).toHaveLength(2);
		(checkboxes[1]?.props as { onChange: () => void }).onChange();
		tree = hooks.render(() => ImportAccounts(props));

		const importButton = elements(tree).find(
			(element) => element.type === 'button' && text(element) === 'Import 1 account'
		);
		if (!importButton) throw new Error('The import button is missing');
		(importButton.props as { onClick: () => void }).onClick();
		expect(onCommit).toHaveBeenCalledWith([
			{ stagingId: 'candidate-1', replaceExisting: false, adoptProxy: true }
		]);

		tree = hooks.render(() => ImportAccounts(props));
		row = functionComponent(tree, 'CandidateRow');
		checkboxes = elements(row).filter(
			(element) =>
				element.type === 'input' && (element.props as { type?: string }).type === 'checkbox'
		);
		expect(
			checkboxes.map((element) => (element.props as { disabled?: boolean }).disabled),
			'the visible import choices can diverge from the immutable payload already being committed'
		).toEqual([true, true]);

		gate.resolve({ outcomes: [] });
		await settle();
	});
});

describe('one recovery action owns the Add authenticator screen', () => {
	const propsFor = (overrides: Record<string, unknown>) => ({
		requireProxies: false,
		onBegin: vi.fn(),
		onEmailCode: vi.fn(),
		onCancel: vi.fn(() => Promise.resolve()),
		onActivate: vi.fn(),
		onResolve: vi.fn(),
		onClearStale: vi.fn(),
		onBackup: vi.fn(),
		onClose: vi.fn(),
		onMove: vi.fn(),
		onEnrollmentStatus: vi.fn(() =>
			Promise.resolve({ pending: PENDING_ENROLLMENT } satisfies EnrollmentStatus)
		),
		...overrides
	});

	it('blocks resolution and navigation from the same turn as a recovery retry', async () => {
		const { hooks, AddAuthenticator } = await mountedScreens();
		const gate = deferred<never>();
		const onRetryEnrollment = vi.fn(() => gate.promise);
		const onResolveEnrollment = vi.fn(() => Promise.resolve({ ok: true as const }));
		const props = propsFor({ onRetryEnrollment, onResolveEnrollment });
		hooks.renderAndStartEffects(() => AddAuthenticator(props as never));
		await settle();
		let tree = hooks.render(() => AddAuthenticator(props as never));

		const retry = button(tree, 'Save safety record now');
		const resolve = button(tree, 'I resolved or removed it through Steam');
		const close = button(tree, 'Close');
		click(retry);
		// Use the still-live handlers from the same render. The ref, not a later
		// disabled paint, has to reject this competing action.
		click(resolve);
		click(close);
		await Promise.resolve();
		expect(onRetryEnrollment).toHaveBeenCalledTimes(1);
		expect(onResolveEnrollment).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();

		// A browser does not dispatch the disabled Close handler after this paint.
		// The direct call above proves the same-turn recovery fence; this render
		// proves what the user can actually operate while the promise is pending.
		tree = hooks.render(() => AddAuthenticator(props as never));
		expect(disabled(button(tree, 'Saving…'))).toBe(true);
		expect(disabled(button(tree, 'I resolved or removed it through Steam'))).toBe(true);
		expect(disabled(button(tree, 'Close'))).toBe(true);

		gate.reject(new Error('the recovery disk is full'));
		await settle();
		tree = hooks.render(() => AddAuthenticator(props as never));
		expect(text(tree)).toContain('the recovery disk is full');
	});

	it('blocks retry and navigation from the same turn as a recovery resolution', async () => {
		const { hooks, AddAuthenticator } = await mountedScreens();
		const gate = deferred<never>();
		const onRetryEnrollment = vi.fn(() => Promise.resolve({ state: 'needsEmailCode' as const }));
		const onResolveEnrollment = vi.fn(() => gate.promise);
		const props = propsFor({ onRetryEnrollment, onResolveEnrollment });
		hooks.renderAndStartEffects(() => AddAuthenticator(props as never));
		await settle();
		let tree = hooks.render(() => AddAuthenticator(props as never));

		const retry = button(tree, 'Save safety record now');
		const resolve = button(tree, 'I resolved or removed it through Steam');
		click(resolve);
		click(retry);
		await Promise.resolve();
		expect(onResolveEnrollment).toHaveBeenCalledTimes(1);
		expect(onRetryEnrollment).not.toHaveBeenCalled();

		tree = hooks.render(() => AddAuthenticator(props as never));
		expect(disabled(button(tree, 'Saving…'))).toBe(true);
		expect(disabled(button(tree, 'I resolved or removed it through Steam'))).toBe(true);
		expect(disabled(button(tree, 'Close'))).toBe(true);

		gate.reject(new Error('the safety record changed'));
		await settle();
		tree = hooks.render(() => AddAuthenticator(props as never));
		expect(text(tree)).toContain('the safety record changed');
		expect(props.onClose).not.toHaveBeenCalled();
	});
});

describe('one recovery action owns every Move authenticator recovery view', () => {
	const propsFor = (status: TransferStatus, overrides: Record<string, unknown>) => ({
		requireProxies: false,
		onAuthenticate: vi.fn(),
		onCancel: vi.fn(() => Promise.resolve()),
		onStartChallenge: vi.fn(),
		onComplete: vi.fn(),
		onRetryPersist: vi.fn(),
		onStatus: vi.fn(() => Promise.resolve(status)),
		onAcknowledgeBackup: vi.fn(),
		onClose: vi.fn(),
		...overrides
	});

	async function mount(
		hooks: HookHarness,
		MoveAuthenticator: (props: never) => ReactElement,
		props: ReturnType<typeof propsFor>
	): Promise<ReactElement> {
		hooks.renderAndStartEffects(() => MoveAuthenticator(props as never));
		await settle();
		return hooks.render(() => MoveAuthenticator(props as never));
	}

	it('freezes the passphrase, both answers, and Close during an unanswered resolution', async () => {
		const { hooks, MoveAuthenticator } = await mountedScreens();
		const status = transferRecoveryStatus('unanswered', 'unanswered', true);
		const gate = deferred<never>();
		const onResolve = vi.fn(() => gate.promise);
		const props = propsFor(status, { onResolve });
		let tree = await mount(hooks, MoveAuthenticator, props);
		change(
			elements(tree).find(
				(element) =>
					element.type === 'input' && (element.props as { type?: string }).type === 'password'
			)!,
			'old-wrong-passphrase'
		);
		tree = hooks.render(() => MoveAuthenticator(props as never));
		const replaced = button(tree, 'The phone no longer has it');
		const notReplaced = button(tree, 'The phone still has Steam Guard — allow another transfer');
		const close = button(tree, 'Close');
		click(replaced);
		click(notReplaced);
		click(close);
		await Promise.resolve();
		expect(onResolve).toHaveBeenCalledTimes(1);
		expect(props.onClose).not.toHaveBeenCalled();
		expect(onResolve).toHaveBeenCalledWith(ATTEMPT_ID, 'replaced', 'old-wrong-passphrase');

		tree = hooks.render(() => MoveAuthenticator(props as never));
		const passphrase = elements(tree).find(
			(element) =>
				element.type === 'input' && (element.props as { type?: string }).type === 'password'
		)!;
		expect(disabled(passphrase)).toBe(true);
		expect(disabled(button(tree, 'The phone no longer has it'))).toBe(true);
		expect(disabled(button(tree, 'The phone still has Steam Guard — allow another transfer'))).toBe(
			true
		);
		expect(disabled(button(tree, 'Close'))).toBe(true);

		gate.reject(new Error('the passphrase did not match'));
		await settle();
		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(text(tree)).toContain('the passphrase did not match');
	});

	it('freezes the passphrase and de-duplicates a persist retry', async () => {
		const { hooks, MoveAuthenticator } = await mountedScreens();
		const status = transferRecoveryStatus('persist', 'replacement', true);
		const gate = deferred<never>();
		const onRetryPersist = vi.fn(() => gate.promise);
		const props = propsFor(status, { onRetryPersist });
		let tree = await mount(hooks, MoveAuthenticator, props);
		const initialPassphrase = elements(tree).find(
			(element) =>
				element.type === 'input' && (element.props as { type?: string }).type === 'password'
		)!;
		expect(
			disabled(button(tree, 'Finish recovery')),
			'a proof-required recovery can be submitted with an empty passphrase'
		).toBe(true);
		expect(onRetryPersist).not.toHaveBeenCalled();
		change(initialPassphrase, 'vault-passphrase');
		tree = hooks.render(() => MoveAuthenticator(props as never));
		const retry = button(tree, 'Finish recovery');
		expect(disabled(retry)).toBe(false);
		click(retry);
		click(retry);
		await Promise.resolve();
		expect(onRetryPersist).toHaveBeenCalledTimes(1);
		expect(onRetryPersist).toHaveBeenCalledWith('vault-passphrase');

		tree = hooks.render(() => MoveAuthenticator(props as never));
		const pendingPassphrase = elements(tree).find(
			(element) =>
				element.type === 'input' && (element.props as { type?: string }).type === 'password'
		)!;
		expect(disabled(pendingPassphrase)).toBe(true);
		expect(disabled(button(tree, 'Working…'))).toBe(true);

		gate.reject(new Error('the vault write failed'));
		await settle();
		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(text(tree)).toContain('the vault write failed');
	});

	it('locks Close and de-duplicates the unreadable resolution', async () => {
		const { hooks, MoveAuthenticator } = await mountedScreens();
		const status = transferRecoveryStatus('unreadable', 'unreadable', true);
		const gate = deferred<never>();
		const onResolve = vi.fn(() => gate.promise);
		const props = propsFor(status, { onResolve });
		let tree = await mount(hooks, MoveAuthenticator, props);
		const passphrase = elements(tree).find(
			(element) =>
				element.type === 'input' && (element.props as { type?: string }).type === 'password'
		)!;
		change(passphrase, 'vault-passphrase');
		tree = hooks.render(() => MoveAuthenticator(props as never));
		const resolve = button(tree, 'I resolved or removed it through Steam Support');
		click(resolve);
		click(resolve);
		await Promise.resolve();
		expect(onResolve).toHaveBeenCalledTimes(1);

		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(
			disabled(
				elements(tree).find(
					(element) =>
						element.type === 'input' && (element.props as { type?: string }).type === 'password'
				)!
			)
		).toBe(true);
		expect(disabled(button(tree, 'I resolved or removed it through Steam Support'))).toBe(true);
		expect(disabled(button(tree, 'Close'))).toBe(true);

		gate.reject(new Error('support resolution was refused'));
		await settle();
		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(text(tree)).toContain('support resolution was refused');
	});

	it('locks Close and de-duplicates cleanup resolution', async () => {
		const { hooks, MoveAuthenticator } = await mountedScreens();
		const status = transferRecoveryStatus('cleanup', 'not-replaced');
		const gate = deferred<never>();
		const onResolve = vi.fn(() => gate.promise);
		const props = propsFor(status, { onResolve });
		let tree = await mount(hooks, MoveAuthenticator, props);
		const resolve = button(tree, 'Clear the safety record');
		click(resolve);
		click(resolve);
		await Promise.resolve();
		expect(onResolve).toHaveBeenCalledTimes(1);

		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(disabled(button(tree, 'Clear the safety record'))).toBe(true);
		expect(disabled(button(tree, 'Close'))).toBe(true);
		gate.reject(new Error('cleanup did not settle'));
		await settle();
		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(text(tree)).toContain('cleanup did not settle');
	});

	it('de-duplicates the unreadable safety-record retry', async () => {
		const { hooks, MoveAuthenticator } = await mountedScreens();
		const status = transferRecoveryStatus('unreadablePersist', 'unreadable');
		const gate = deferred<never>();
		const onRetryPersist = vi.fn(() => gate.promise);
		const props = propsFor(status, { onRetryPersist });
		let tree = await mount(hooks, MoveAuthenticator, props);
		const retry = button(tree, 'Save safety record now');
		click(retry);
		click(retry);
		await Promise.resolve();
		expect(onRetryPersist).toHaveBeenCalledTimes(1);

		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(disabled(button(tree, 'Working…'))).toBe(true);
		gate.reject(new Error('the safety record could not be written'));
		await settle();
		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(text(tree)).toContain('the safety record could not be written');
	});

	it('keeps a rejected recovery-backup retry visible on the completed transfer', async () => {
		const { hooks, MoveAuthenticator } = await mountedScreens();
		const gate = deferred<never>();
		const onRetryPersist = vi.fn(() => gate.promise);
		const props = propsFor(
			{},
			{
				onAuthenticate: vi.fn(() =>
					Promise.resolve({
						state: 'authenticated' as const,
						steamId64: ACCOUNT.steamId64,
						accountName: ACCOUNT.accountName
					})
				),
				onStartChallenge: vi.fn(() =>
					Promise.resolve({ shape: 'protobuf' as const, sent: true, eresult: 1 })
				),
				onComplete: vi.fn(() =>
					Promise.resolve({
						steamId64: ACCOUNT.steamId64,
						accountName: ACCOUNT.accountName,
						revocationCode: 'R12345',
						timeOffsetSeconds: 0,
						recoveryWarning: 'The separate recovery backup still needs saving.'
					})
				),
				onRetryPersist
			}
		);
		hooks.renderAndStartEffects(() => MoveAuthenticator(props as never));
		await settle();
		let tree = hooks.render(() => MoveAuthenticator(props as never));
		change(byId(tree, 'move-account'), ACCOUNT.accountName);
		change(byId(tree, 'move-password'), 'secret');
		change(byId(tree, 'move-code'), 'ABCDE');
		tree = hooks.render(() => MoveAuthenticator(props as never));
		void submit(firstForm(tree));
		await settle();

		tree = hooks.render(() => MoveAuthenticator(props as never));
		click(button(tree, 'Send the code to my phone'));
		await settle();
		tree = hooks.render(() => MoveAuthenticator(props as never));
		change(byId(tree, 'move-sms'), '12345');
		tree = hooks.render(() => MoveAuthenticator(props as never));
		click(button(tree, 'Replace the authenticator'));
		await settle();

		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(text(tree)).toContain('The separate recovery backup still needs saving.');
		click(button(tree, 'Finish recovery backup'));
		await Promise.resolve();
		expect(onRetryPersist).toHaveBeenCalledTimes(1);
		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(disabled(button(tree, 'Saving…'))).toBe(true);

		gate.reject(new Error('the recovery backup is still unwritable'));
		await settle();
		tree = hooks.render(() => MoveAuthenticator(props as never));
		expect(text(tree)).toContain('the recovery backup is still unwritable');
		expect(disabled(button(tree, 'Finish recovery backup'))).toBe(false);
	});
});
