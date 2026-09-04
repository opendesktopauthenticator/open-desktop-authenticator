import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * **The disclosure is the only thing standing between `full` and an unattended
 * screen.**
 *
 * A degrade to `count` while Windows is locked was proposed and deliberately
 * rejected, so nothing else covers this case. The sentence has to name **both**
 * surfaces: an earlier draft named only notification history, which is the
 * smaller of the two, and someone reading it would not learn that a toast
 * appears on the lock screen at all.
 *
 * Asserted against the source text because there is no DOM runner here. That is
 * a weaker test than rendering it — it proves the words exist in the file, not
 * that they reach the screen — so it is paired with the placement assertion
 * below, which is the part that actually goes wrong.
 */
describe('the disclosure beside the notifications switch', () => {
	const source = readFileSync(
		join(__dirname, '..', 'src', 'renderer', 'screens', 'AutoConfirm.tsx'),
		'utf8'
	);

	it('names the lock screen', () => {
		expect(source, 'the disclosure does not mention the lock screen').toContain('lock screen');
	});

	it('names notification history', () => {
		expect(source).toContain('notification history');
	});

	it('says the toast names the trade and its items', () => {
		expect(source).toContain('name the trade and its items');
	});

	it('offers the two quieter options by name', () => {
		expect(source).toContain('Count only');
		expect(source).toContain('Type only');
	});

	/*
	 * **Placement, which is the part that goes wrong.** `full` is the default, so
	 * the sentence has to be read by anyone switching notifications on — not only
	 * by somebody who goes looking at the detail options. If it moved next to the
	 * `full` radio it would be true and unread.
	 */
	it('sits beside the enable switch, not inside the detail group', () => {
		const enableAt = source.indexOf('setNotifyEnabled');
		const disclosureAt = source.indexOf('Windows shows them on the lock screen');
		const detailGroupAt = source.indexOf('<legend>What a notification says</legend>');
		expect(enableAt).toBeGreaterThan(-1);
		expect(disclosureAt).toBeGreaterThan(-1);
		expect(detailGroupAt).toBeGreaterThan(-1);
		expect(disclosureAt, 'the disclosure moved off the enable switch').toBeGreaterThan(enableAt);
		expect(disclosureAt, 'the disclosure moved into the detail group').toBeLessThan(detailGroupAt);
	});
});

/**
 * **A click that navigates nowhere looks broken, and would ship silently.**
 *
 * The unlocked view is a stack of `if`s, and `autoConfirmFor` and `removingFor`
 * are tested *above* `confirmingFor`. Setting the target while either of those
 * is open therefore does nothing at all — no error, no log, just a toast that
 * appears to do nothing when clicked.
 *
 * Asserted against the source because this project has no DOM runner. That is
 * weaker than rendering it, and it is the reason the assertion is about the
 * clears being present in this specific function rather than about the
 * navigation working.
 */
describe('opening confirmations from a notification', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	/** The body of `openConfirmationsFor`, which is where the rule has to hold. */
	const body = (() => {
		const start = source.indexOf('const openConfirmationsFor = useCallback(');
		expect(start, 'openConfirmationsFor no longer exists').toBeGreaterThan(-1);
		const end = source.indexOf('const confirmationClickClaims', start);
		expect(end, 'openConfirmationsFor changed shape; this test needs rewriting').toBeGreaterThan(
			start
		);
		return source.slice(start, end);
	})();

	it('looks the account up rather than trusting the id', () => {
		expect(body).toContain('confirmationsTargetFor(accounts, steamId64)');
	});

	it('refuses to bypass any child screen navigation lock', () => {
		expect(body).toContain('!notificationTakeoverReady');
		expect(source).toContain('overlayOpen,');
		expect(source).toContain('signInOpen: browserSignIn !== undefined');
		expect(source).toContain('browserOpenContinuation !== undefined');
		expect(source).toContain('accountListBusy: accountListOperationBusy(');
		expect(body).toContain('recoveryBackupAccounts.current.size > 0');
		expect(source).toContain('notificationTakeoverReady');
	});

	it('routes an already-open account through a fresh list before acknowledgement', () => {
		expect(source).toContain('notificationRefreshesOpenAccount(');
		expect(source).toContain('onNotificationRefresh={completeNotificationRefresh}');
		expect(source).toContain('completeNotificationRefresh');
		expect(body.indexOf('!notificationTakeoverReady')).toBeLessThan(
			body.indexOf('setConfirmingFor(account)')
		);
	});

	it('clears the screens that sit above confirmations in the view stack', () => {
		// If one of these is dropped, the click silently does nothing whenever
		// that screen happens to be open.
		expect(body, 'the auto-confirm screen would swallow the navigation').toContain(
			'setAutoConfirmFor(undefined)'
		);
		expect(body, 'the removal screen would swallow the navigation').toContain(
			'setRemovingFor(undefined)'
		);
		expect(body).toContain('setRoutingFor(undefined)');
		expect(body).toContain('setBackupFor(undefined)');
	});

	it('returns to the account list before selecting within it', () => {
		expect(body).toContain("setView('accounts')");
		expect(body.indexOf("setView('accounts')")).toBeLessThan(body.indexOf('setConfirmingFor('));
	});

	it('sets the target last, so nothing clears it afterwards', () => {
		const target = body.indexOf('setConfirmingFor(account)');
		expect(target).toBeGreaterThan(body.indexOf('setAutoConfirmFor(undefined)'));
		expect(target).toBeGreaterThan(body.indexOf('setRemovingFor(undefined)'));
	});

	it('routes both IPC delivery paths through the monotonic click claim', () => {
		const file = ts.createSourceFile(
			'App.tsx',
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX
		);
		const effects: Array<{ fast: boolean; slow: boolean; delegates: number }> = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'useEffect'
			) {
				let delegates = 0;
				const countDelegates = (child: ts.Node): void => {
					if (
						ts.isCallExpression(child) &&
						ts.isPropertyAccessExpression(child.expression) &&
						child.expression.getText() === 'processConfirmationClickRef.current'
					) {
						delegates += 1;
					}
					ts.forEachChild(child, countDelegates);
				};
				countDelegates(node);
				const text = node.getText();
				if (text.includes('onOpenConfirmations') || text.includes('pending.steamId64')) {
					effects.push({
						fast: text.includes('onOpenConfirmations'),
						slow: text.includes('pending.steamId64'),
						delegates
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);

		expect(effects.filter((effect) => effect.fast)).toEqual([
			{ fast: true, slow: false, delegates: 1 }
		]);
		expect(effects.filter((effect) => effect.slow)).toEqual([
			{ fast: false, slow: true, delegates: 1 }
		]);
		expect(source).toContain('const processConfirmationClick = useCallback(');
		expect(source).toContain('claimConfirmationClick(claims, click.token');
	});

	/*
	 * The collection path is what makes a lock survivable, and it is gated on
	 * there being an account list to navigate within — asking a beat too early
	 * would take the intent, fail the lookup, and throw it away.
	 *
	 * **Bounded to the effect, and bounded by structure.** The first version of
	 * this read four hundred characters back from the call and then to the *end of
	 * the file*, so `accounts.length === 0` occurring anywhere in the seven hundred
	 * lines below it satisfied the assertion. Both halves were wrong: a fixed reach
	 * backwards depends on how much prose happens to sit above the call, and an
	 * unbounded slice forwards is not an assertion about this effect at all. So the
	 * slice runs from the `useEffect` that owns the call to that effect's own
	 * dependency array, and the guard has to be found *before* the call inside it.
	 * Peeking is intentionally non-destructive; this ordering prevents a useless
	 * round trip before the renderer has anything it can navigate to.
	 *
	 * Still read from the source rather than rendered: effects do not run under
	 * `renderToStaticMarkup`, which is the only rendering this suite has.
	 */
	/**
	 * The **slow-path** effect, found by structure rather than by index.
	 *
	 * Two effects mention `takePendingConfirmations` now: the fast path calls it
	 * to consume the intent a successful push already handled, and this one
	 * collects an intent nobody was listening for. An `indexOf` picked whichever
	 * happened to be written first in the file, so adding the ack silently
	 * repointed this whole describe at the wrong effect — the assertions kept
	 * passing while they had stopped being about the thing they name.
	 *
	 * The discriminator is what the effect does with the result: this is the one
	 * that navigates from a collected `pending`.
	 */
	const takeEffect = (() => {
		const file = ts.createSourceFile(
			'App.tsx',
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX
		);
		const found: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'useEffect' &&
				node.getText().includes('takePendingConfirmations') &&
				node.getText().includes('pending.steamId64')
			) {
				found.push(node);
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		expect(
			found,
			'no effect collects a pending notification click and navigates to it'
		).toHaveLength(1);
		return found[0] as ts.CallExpression;
	})();

	const collection = (() => {
		const body = (takeEffect.arguments[0] as ts.ArrowFunction).body;
		const deps = takeEffect.arguments[1];
		expect(deps, 'the effect has no dependency array').toBeDefined();
		/*
		 * **Comments stripped, because a substring search cannot tell code from
		 * prose.** Remove the guard and leave a sentence behind — "previously gated
		 * on confirmationAccounts.length === 0" — and an index check on the raw text is still
		 * satisfied by the sentence.
		 */
		const strip = (text: string): string =>
			text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
		return {
			body: strip(body.getText()),
			deps: (deps as ts.Node).getText()
		};
	})();

	/**
	 * The `.then` callback of the collecting effect, as a syntax tree.
	 *
	 * **Text indices could not express the property and never will.** The
	 * assertion below is "the effect decides before it asks main for the click",
	 * and where a *substring* sits is not where control flow short-circuits. Two
	 * escapes were measured on the text version, both leaving the whole suite
	 * green while the click was consumed and lost: hoisting the condition to
	 * `const noAccountsYet = confirmationAccounts.length === 0;` above the call and consuming
	 * it inside the callback, and — once the literal `accounts` was forbidden
	 * after the call — the same hoist, because `noAccountsYet` does not contain
	 * the word.
	 *
	 * So it is asked of the tree instead: nothing inside the callback may read
	 * anything the effect computed before the call. That is the real rule, and it
	 * holds whatever the intermediate value gets named.
	 */
	const collectionCallback = (() => {
		// The same slow-path effect the bounds above found, not whichever mentions
		// the channel first: the fast path calls it too, to acknowledge a push.
		const effect = takeEffect.arguments[0] as ts.ArrowFunction;

		let callback: ts.Node | undefined;
		const findThen = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === 'then' &&
				node.expression.expression.getText().includes('takePendingConfirmations')
			) {
				callback = node.arguments[0];
			}
			ts.forEachChild(node, findThen);
		};
		findThen(effect);
		expect(callback, 'the collected click is no longer handled in a .then').toBeDefined();

		/** Every name the effect binds before it asks main for the click. */
		const declaredInEffect = new Set<string>();
		const body = effect.body;
		if (ts.isBlock(body)) {
			for (const statement of body.statements) {
				if (!ts.isVariableStatement(statement)) {
					continue;
				}
				for (const declaration of statement.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name)) {
						declaredInEffect.add(declaration.name.text);
					}
				}
			}
		}

		const used = new Set<string>();
		const collect = (node: ts.Node): void => {
			if (ts.isIdentifier(node)) {
				used.add(node.text);
			}
			ts.forEachChild(node, collect);
		};
		collect(callback as unknown as ts.Node);

		return { used, declaredInEffect };
	})();

	it('waits for an account list before collecting a pending click', () => {
		const guard = collection.body.indexOf('confirmationAccounts.length === 0');
		expect(
			guard,
			'the effect collects the pending click without waiting for an account list'
		).toBeGreaterThan(-1);
		expect(
			guard,
			'the account list is checked only after IPC, so the renderer asks for a click before ' +
				'it has anything it can navigate to'
		).toBeLessThan(collection.body.indexOf('.takePendingConfirmations()'));
	});

	/**
	 * **The decision is made before the click is asked for, whatever it is named.**
	 *
	 * The index check above is a proxy and both of its escapes were measured on
	 * the real file, each leaving 97 files and 2248 tests green while a click made
	 * during a lock was consumed and thrown away under the former destructive-read
	 * protocol. Peeking is safe now; this still pins the simpler control flow: the
	 * decision to ask belongs before IPC, not in its asynchronous answer.
	 */
	it('decides before it asks, not inside the callback', () => {
		expect(
			[...collectionCallback.used],
			'the handler reads the account list after the click has already been taken'
		).not.toContain('accounts');

		const leaked = [...collectionCallback.used].filter(
			(name) =>
				collectionCallback.declaredInEffect.has(name) &&
				// The only value the effect may legitimately hand its own callback:
				// whether this effect has been torn down since it started.
				name !== 'cancelled'
		);
		expect(
			leaked,
			`the handler reads ${leaked.join(', ')}, computed before the click was taken — a guard ` +
				'hoisted out of the early return still runs too late, whatever it is called'
		).toEqual([]);
	});

	/**
	 * **And not on every status poll.**
	 *
	 * `openConfirmationsFor` closes over `accounts`, which `listAccounts`
	 * replaces with a fresh array every second — so depending on it re-ran this
	 * effect once a second for the life of an unlocked session, asking main for a
	 * pending click each time.
	 *
	 * Peeking is non-destructive now, so this churn no longer loses a click. It
	 * still creates and cancels an IPC round trip every second for no state change.
	 * A stable membership signature changes when the available Steam IDs change,
	 * including a same-length replacement, but not when polling returns a fresh
	 * array containing the same accounts.
	 */
	it('does not re-run on every status poll', () => {
		expect(
			collection.deps,
			'the effect depends on a callback rebuilt every second, so it asks main for a pending ' +
				'click once a second for no state change'
		).not.toContain('openConfirmationsFor');
	});

	it('runs again when the account list arrives', () => {
		// Waiting is only survivable if something wakes the effect back up: gate on
		// a list that starts empty and never re-run, and the intent sits in main
		// until the next launch.
		expect(
			collection.deps,
			'the effect does not depend on the account list, so it never re-runs once the accounts land'
		).toContain('confirmationAccounts');
	});

	it('does not confuse equal list lengths with equal membership', () => {
		expect(
			collection.deps,
			'the effect watches only the number of accounts, so replacing A with B at the same ' +
				"length leaves B's retained click asleep"
		).not.toContain('accounts.length');
		expect(source).toContain(
			'const confirmationAccounts = confirmationAccountMembership(accounts)'
		);
	});
});

/**
 * **A screen holding one account's state must not be handed another account.**
 *
 * `<Confirmations>` had no key, so React reused the instance when the target
 * changed. Its fetch effect depends on the id and re-ran; nothing else did.
 * Clicking account B's notification left A's confirmation list on screen with
 * buttons that now acted on B, A's error text, and — if A was showing the
 * password form — the password already typed into it, with the callback
 * silently repointed at B.
 *
 * Notification click-to-open is what made this reachable in one gesture, but
 * every account-scoped screen holding unsaved input has the same shape.
 *
 * Asserted against the source because this project has no DOM runner. It is a
 * weaker test than rendering the transition, and it is pinned on the one line
 * that decides it.
 */
describe('screens that hold one account state', () => {
	const app = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	/** The props of one JSX element, from its opening tag to the first `/>`. */
	const element = (name: string): string => {
		const start = app.indexOf(`<${name}`);
		expect(start, `${name} is no longer mounted here`).toBeGreaterThan(-1);
		return app.slice(start, app.indexOf('/>', start));
	};

	it.each([
		['Confirmations', 'confirmingFor.steamId64'],
		['SteamSignIn', 'browserSignIn.account.steamId64'],
		['RemoveAccount', 'removingFor.steamId64'],
		['AutoConfirm', 'current.steamId64'],
		['AccountRouting', 'current.steamId64']
	])('%s is keyed by account', (name, key) => {
		expect(
			element(name),
			`${name} would be reused across accounts, carrying the previous one's state`
		).toContain(`key={${key}}`);
	});
});
