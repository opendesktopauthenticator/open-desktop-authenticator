import { describe, expect, it, vi } from 'vitest';

import { electronBrowserHost } from '../src/main/browser/electron-host';
import {
	browserPartitionFor,
	isSteamLoginPage,
	openAccountBrowser,
	type BrowserWindowHandle
} from '../src/main/browser/window';

type Listener = (...args: unknown[]) => void;
type TestContents = {
	navigate(url: string): void;
	prime(url: string): void;
	windowOpen(url: string):
		| { action: 'deny' }
		| {
				action: 'allow';
				createWindow?: (options: { webContents: unknown }) => unknown;
		  };
};

const observed = vi.hoisted(() => ({
	views: [] as {
		label: string;
		contents: TestContents;
		loaded: string[];
		visible: boolean[];
	}[],
	windows: [] as {
		closed: boolean;
		shown: number;
		titles: string[];
	}[],
	ipc: new Map<string, Listener[]>(),
	actions: [] as string[],
	chromeStates: [] as { url?: string }[],
	wipes: [] as string[]
}));

vi.mock('electron', () => {
	class FakeSession {
		constructor(readonly partition: string) {}
		setPermissionRequestHandler(): void {}
		setPermissionCheckHandler(): void {}
		setSpellCheckerEnabled(): void {}
		setUserAgent(): void {}
		setProxy(): Promise<void> {
			return Promise.resolve();
		}
		resolveProxy(): Promise<string> {
			return Promise.resolve('DIRECT');
		}
		clearStorageData(): Promise<void> {
			observed.wipes.push(this.partition);
			return Promise.resolve();
		}
		readonly cookies = {
			set: (): Promise<void> => Promise.resolve()
		};
	}

	const sessions = new Map<string, FakeSession>();
	const sessionFor = (partition: string): FakeSession => {
		const known = sessions.get(partition);
		if (known) return known;
		const made = new FakeSession(partition);
		sessions.set(partition, made);
		return made;
	};

	class FakeContents {
		private readonly listeners = new Map<string, Listener[]>();
		private openHandler:
			| ((details: { url: string }) => {
					action: 'allow' | 'deny';
					createWindow?: (options: { webContents: unknown }) => unknown;
			  })
			| undefined;
		private destroyed = false;
		private url = '';
		label = 'unadopted';
		loaded: string[] = [];
		readonly session: FakeSession;
		readonly navigationHistory = {
			canGoBack: () => false,
			canGoForward: () => false,
			goBack: () => undefined,
			goForward: () => undefined
		};

		constructor(partition: string) {
			this.session = sessionFor(partition);
		}

		loadURL(url: string): Promise<void> {
			this.loaded.push(url);
			this.url = url;
			this.emit('did-start-loading');
			this.emit('did-navigate');
			this.emit('did-stop-loading');
			return Promise.resolve();
		}
		navigate(url: string): void {
			this.loaded.push(url);
			this.url = url;
			this.emit('did-navigate');
		}
		prime(url: string): void {
			this.loaded.push(url);
			this.url = url;
		}
		windowOpen(url: string) {
			return this.openHandler?.({ url }) ?? { action: 'deny' as const };
		}
		getURL(): string {
			return this.url;
		}
		getTitle(): string {
			return this.url;
		}
		isDestroyed(): boolean {
			return this.destroyed;
		}
		isLoading(): boolean {
			return false;
		}
		setUserAgent(): void {}
		setWebRTCIPHandlingPolicy(): void {}
		setWindowOpenHandler(handler: FakeContents['openHandler']): void {
			this.openHandler = handler;
		}
		on(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event) ?? [];
			listeners.push(listener);
			this.listeners.set(event, listeners);
			return this;
		}
		once(event: string, listener: Listener): this {
			const once: Listener = (...args) => {
				this.removeListener(event, once);
				listener(...args);
			};
			return this.on(event, once);
		}
		removeListener(event: string, listener: Listener): void {
			this.listeners.set(
				event,
				(this.listeners.get(event) ?? []).filter((known) => known !== listener)
			);
		}
		send(channel: string, state: { url?: string }): void {
			if (channel === 'browser-chrome:state') observed.chromeStates.push(state);
		}
		focus(): void {
			observed.actions.push(`focus:${this.label}`);
		}
		close(): void {
			if (this.destroyed) return;
			this.destroyed = true;
			this.emit('destroyed');
		}
		stop(): void {}
		reload(): void {}
		private emit(event: string, ...args: unknown[]): void {
			for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
		}
	}

	class WebContentsView {
		readonly webContents: FakeContents;
		private readonly recorded: (typeof observed.views)[number];

		constructor(options: { webPreferences?: { partition?: string }; webContents?: FakeContents }) {
			this.webContents =
				options.webContents ?? new FakeContents(options.webPreferences?.partition ?? '');
			const label = `view-${observed.views.length}`;
			this.webContents.label = label;
			this.recorded = {
				label,
				contents: this.webContents,
				loaded: this.webContents.loaded,
				visible: []
			};
			observed.views.push(this.recorded);
		}
		setBackgroundColor(): void {}
		setBounds(): void {}
		setVisible(visible: boolean): void {
			this.recorded.visible.push(visible);
			observed.actions.push(`visible:${this.recorded.label}:${visible}`);
		}
	}

	class BaseWindow {
		private readonly listeners = new Map<string, Listener[]>();
		private readonly recorded: (typeof observed.windows)[number];
		readonly contentView = {
			addChildView: () => undefined,
			removeChildView: () => undefined
		};

		constructor() {
			this.recorded = { closed: false, shown: 0, titles: [] };
			observed.windows.push(this.recorded);
		}
		on(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event) ?? [];
			listeners.push(listener);
			this.listeners.set(event, listeners);
			return this;
		}
		getContentBounds(): { x: number; y: number; width: number; height: number } {
			return { x: 0, y: 0, width: 1280, height: 860 };
		}
		isDestroyed(): boolean {
			return this.recorded.closed;
		}
		isMinimized(): boolean {
			return false;
		}
		restore(): void {}
		focus(): void {}
		show(): void {
			this.recorded.shown += 1;
		}
		setTitle(title: string): void {
			this.recorded.titles.push(title);
		}
		close(): void {
			if (this.recorded.closed) return;
			observed.actions.push('window:close');
			this.recorded.closed = true;
			for (const listener of [...(this.listeners.get('closed') ?? [])]) listener();
		}
	}

	return {
		BaseWindow,
		WebContentsView,
		ipcMain: {
			on: (channel: string, listener: Listener) => {
				const listeners = observed.ipc.get(channel) ?? [];
				listeners.push(listener);
				observed.ipc.set(channel, listeners);
			},
			removeListener: (channel: string, listener: Listener) => {
				observed.ipc.set(
					channel,
					(observed.ipc.get(channel) ?? []).filter((known) => known !== listener)
				);
			}
		},
		screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
		session: { fromPartition: (partition: string) => sessionFor(partition) },
		nativeImage: { createEmpty: () => ({ addRepresentation: () => undefined }) },
		app: { isPackaged: false },
		shell: { openExternal: () => Promise.resolve() }
	};
});

const ACCOUNT = {
	steamId64: '76561198000000001',
	accountName: 'demo_trader',
	accessToken: 'eyJhbGciOiJFZERTQSJ9.token.signature',
	route: 'direct' as const
};

const SAFE = 'https://steamcommunity.com/my/tradeoffers/';
const LOGIN_URLS = [
	'https://steamcommunity.com/login/home/?goto=my%2Ftradeoffers',
	'https://store.steampowered.com/login/',
	'https://help.steampowered.com/en/wizard/Login',
	'https://login.steampowered.com/jwt/begin'
] as const;

async function twoTabs(): Promise<{
	handle: BrowserWindowHandle;
	window: (typeof observed.windows)[number];
	toolbar: (typeof observed.views)[number];
	first: (typeof observed.views)[number];
	second: (typeof observed.views)[number];
}> {
	observed.views.length = 0;
	observed.windows.length = 0;
	observed.ipc.clear();
	observed.actions.length = 0;
	observed.chromeStates.length = 0;
	observed.wipes.length = 0;

	const handle = await openAccountBrowser(electronBrowserHost, ACCOUNT);
	const [toolbar, first] = observed.views;
	if (!toolbar || !first) throw new Error('the browser did not create its toolbar and first tab');
	const answer = first.contents.windowOpen('https://steamcommunity.com/market/');
	if (answer.action !== 'allow' || !answer.createWindow) {
		throw new Error('the signed-in browser refused an ordinary Steam popup');
	}
	const pending = new (first.contents.constructor as new (partition: string) => TestContents)(
		'pending-popup'
	);
	answer.createWindow({ webContents: pending });
	const second = observed.views[2];
	const window = observed.windows[0];
	if (!second || !window) throw new Error('the browser did not adopt the popup as a second tab');
	second.contents.navigate(SAFE);
	return { handle, window, toolbar, first, second };
}

function select(toolbar: (typeof observed.views)[number], id: number): void {
	for (const listener of observed.ipc.get('browser-chrome:select-tab') ?? []) {
		listener({ sender: toolbar.contents }, id);
	}
}

describe('the browser lifetime login-page guard across tabs', () => {
	it.each(LOGIN_URLS)('closes and wipes when a background tab reaches %s', async (loginUrl) => {
		expect(isSteamLoginPage(loginUrl)).toBe(true);
		const { window, first } = await twoTabs();

		first.contents.navigate(loginUrl);
		await Promise.resolve();

		expect(window.closed, 'the account window survived a background Steam login page').toBe(true);
		expect(observed.wipes).toContain(browserPartitionFor(ACCOUNT.steamId64));
	});

	it('keeps ordinary background navigation out of the active title and address', async () => {
		const { handle, window, first } = await twoTabs();
		const titleBefore = window.titles.at(-1);
		const activeBefore = observed.chromeStates.at(-1)?.url;

		first.contents.navigate('https://example.org/background');

		expect(window.closed).toBe(false);
		expect(window.titles.at(-1), 'a background tab retitled the active window').toBe(titleBefore);
		expect(observed.chromeStates.at(-1)?.url, 'a background tab replaced the active address').toBe(
			activeBefore
		);
		handle.close();
	});

	it('validates a selected tab before making or focusing it', async () => {
		const { window, toolbar, first } = await twoTabs();
		first.contents.prime(LOGIN_URLS[0]);
		observed.actions.length = 0;

		select(toolbar, 1);
		await Promise.resolve();

		expect(window.closed, 'the already-forbidden tab was accepted on selection').toBe(true);
		expect(observed.actions).not.toContain(`visible:${first.label}:true`);
		expect(observed.actions).not.toContain(`focus:${first.label}`);
	});

	it('honours a security rejection before visibility even when close has not settled', async () => {
		const { handle, window, toolbar, first } = await twoTabs();
		// The guard normally starts closing the native window as it rejects. Its
		// return value, not the timing of that native close, must be what keeps this
		// view hidden.
		handle.on('tab-navigated', () => false);
		first.contents.prime(LOGIN_URLS[0]);
		observed.actions.length = 0;

		select(toolbar, 1);

		expect(window.closed).toBe(false);
		expect(observed.actions).not.toContain(`visible:${first.label}:true`);
		expect(observed.actions).not.toContain(`focus:${first.label}`);
		handle.close();
	});
});
