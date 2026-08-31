import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { PUSH_CHANNELS } from '../src/shared/channels';

/**
 * **A subscription that says "subscribed once" has to be able to be.**
 *
 * `onOpenConfirmations` passed an inline arrow straight to `ipcRenderer.on`, so
 * no reference was kept and nothing could ever have removed it — and it
 * returned `void`, so no caller could have tried. The comment above it said
 * "Subscribed once", which was the false premise that made the rest invisible.
 *
 * The renderer's effect depended on `openConfirmationsFor`, which closes over
 * `accounts` and is therefore a new function on every status poll — once a
 * second. So the effect re-ran once a second and added a listener each time,
 * for as long as the window stayed unlocked: roughly 3,600 an hour, each
 * retaining its own `accounts` snapshot, past Node's default
 * `MaxListenersExceededWarning` within the first ten seconds.
 *
 * It was also a correctness bug. A click ran every listener in registration
 * order, oldest first, and `openConfirmationsFor` returns early for an id it
 * cannot find **without clearing `confirmingFor`** — so a stale listener
 * holding a since-removed account set it and the newest listener bailed
 * without undoing that. The window opened the confirmations screen for an
 * account the vault no longer had.
 */

const { listeners } = vi.hoisted(() => ({
	listeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>()
}));

const { exposed } = vi.hoisted(() => ({ exposed: new Map<string, unknown>() }));

vi.mock('electron', () => ({
	contextBridge: {
		exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value)
	},
	ipcRenderer: {
		invoke: () => Promise.resolve(undefined),
		send: () => undefined,
		on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
		},
		removeListener: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
			listeners.set(
				channel,
				(listeners.get(channel) ?? []).filter((candidate) => candidate !== handler)
			);
		}
	}
}));

import '../src/preload/index';

interface PushApi {
	onOpenConfirmations(listener: (steamId64: string) => void): () => void;
}

function api(): PushApi {
	const found = exposed.get('api');
	expect(found, 'the preload exposed nothing under "api"').toBeDefined();
	return found as PushApi;
}

/** Fire the push, exactly as main does. */
function emit(steamId64: string): void {
	for (const handler of [...(listeners.get(PUSH_CHANNELS.openConfirmations) ?? [])]) {
		handler({}, steamId64);
	}
}

function count(): number {
	return (listeners.get(PUSH_CHANNELS.openConfirmations) ?? []).length;
}

beforeEach(() => {
	listeners.clear();
});

describe('subscribing to notification clicks', () => {
	it('hands back something that unsubscribes', () => {
		const seen: string[] = [];
		const off = api().onOpenConfirmations((steamId64) => seen.push(steamId64));
		expect(typeof off, 'there is no way to unsubscribe, so nothing can clean up').toBe('function');

		emit('76561198000000001');
		expect(seen).toEqual(['76561198000000001']);

		off();
		emit('76561198000000002');
		expect(seen, 'the listener kept firing after it was unsubscribed').toEqual([
			'76561198000000001'
		]);
	});

	/*
	 * The leak itself: what matters is not that one unsubscribe works, but that
	 * the count comes back down. An inline arrow cannot be removed by identity,
	 * so this is the assertion that fails without a hoisted handler.
	 */
	it('leaves nothing behind when every subscription is released', () => {
		const offs = Array.from({ length: 50 }, () => api().onOpenConfirmations(() => undefined));
		expect(count()).toBe(50);

		for (const off of offs) {
			off();
		}
		expect(count(), 'listeners accumulated with no way to remove them').toBe(0);
	});

	it('removes only its own', () => {
		const seen: string[] = [];
		const first = api().onOpenConfirmations(() => seen.push('first'));
		api().onOpenConfirmations(() => seen.push('second'));

		first();
		emit('76561198000000001');
		expect(seen, 'unsubscribing one removed another').toEqual(['second']);
	});
});

/**
 * **And the renderer has to establish it once**, or an unsubscribe only makes
 * the churn tidier: without this the effect still tore down and re-subscribed
 * across the context bridge once a second, ~86,000 times a day, for a
 * subscription that should be made when the bridge appears and never again.
 *
 * Read from the source because effects do not run under
 * `renderToStaticMarkup`, which is the only rendering this suite has. Asserted
 * on the syntax tree rather than by matching text, because the property is
 * which identifiers the dependency array contains — and an array holding
 * `openConfirmationsFor` under any other name is the same defect.
 */
describe('the effect that subscribes', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	const deps = (() => {
		const file = ts.createSourceFile(
			'App.tsx',
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX
		);
		let found: ts.Expression | undefined;
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'useEffect' &&
				node.getText().includes('onOpenConfirmations')
			) {
				found = node.arguments[1];
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		expect(found, 'no useEffect subscribes to notification clicks any more').toBeDefined();
		const array = found as ts.Expression;
		expect(ts.isArrayLiteralExpression(array), 'the effect has no dependency array').toBe(true);
		return (array as ts.ArrayLiteralExpression).elements.map((element) => element.getText());
	})();

	it('depends on the bridge and nothing else', () => {
		expect(
			deps,
			`the subscription is rebuilt whenever ${deps.join(', ')} changes; anything derived from ` +
				'the account list changes once a second'
		).toEqual(['api']);
	});

	/*
	 * And the effect returns the unsubscribe, so React actually calls it. A
	 * stable dependency list makes the teardown rare; it does not make it
	 * unnecessary — the bridge is absent on the first render, and StrictMode
	 * mounts twice in development.
	 */
	/**
	 * **A push that navigated must consume the remembered copy.**
	 *
	 * `ToastClickRouter.activate` retains *and* pushes, always — deliberately,
	 * because a lock reloads this window and the retained copy is the only thing
	 * that survives it. Nothing marked the push as having landed, so the slow
	 * path collected the same intent about a second later and navigated again.
	 *
	 * Usually invisible, and destructive inside that second: the second
	 * navigation is a rollback. Whatever the user did after clicking the toast —
	 * closed the screen, opened Settings, started a removal — is undone by
	 * `setView('accounts')` and the clears beside it.
	 *
	 * **The guard is load-bearing and asserted as such.** `openConfirmationsFor`
	 * returns false when the id is not in the account list yet, which is exactly
	 * the case the slow path exists for; clearing unconditionally would delete
	 * the intent instead of double-using it. So the test is not "does it call
	 * take" but "does it call take only when the navigation worked".
	 */
	it('acknowledges a push that navigated, and only then', () => {
		const file = ts.createSourceFile(
			'App.tsx',
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX
		);

		let listener: ts.Node | undefined;
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === 'onOpenConfirmations'
			) {
				listener = node.arguments[0];
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		expect(listener, 'nothing subscribes to the push any more').toBeDefined();

		const guards: string[] = [];
		const findIf = (node: ts.Node): void => {
			if (ts.isIfStatement(node) && node.thenStatement.getText().includes('takePending')) {
				guards.push(node.expression.getText());
			}
			ts.forEachChild(node, findIf);
		};
		findIf(listener as ts.Node);

		expect(
			(listener as ts.Node).getText(),
			'a push that navigated never consumes the remembered intent, so the slow path ' +
				'navigates a second time about a second later and rolls back whatever the user did'
		).toContain('takePendingConfirmations');
		expect(
			guards,
			'the intent is consumed unconditionally — including when the navigation failed because ' +
				'the account list had not arrived, which deletes the click the slow path exists to collect'
		).toHaveLength(1);
		expect(guards[0], 'the guard is not the navigation result').toContain('openConfirmations');
	});

	it('returns the unsubscribe to React', () => {
		const at = source.indexOf('api.onOpenConfirmations(');
		expect(at).toBeGreaterThan(-1);
		const line = source.slice(source.lastIndexOf('\n', at) + 1, at);
		expect(line.trim(), 'the effect drops the unsubscribe, so React can never call it').toBe(
			'return'
		);
	});
});
