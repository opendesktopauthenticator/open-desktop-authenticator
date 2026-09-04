import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * **The other half of `browser-sign-in-race.test.tsx`: the screen has to be
 * installed through the claim.**
 *
 * The defect both files cover: opening account A and then account B, typing a
 * password into the sign-in screen B asked for, and then letting A's older open
 * settle, put A's prompt on screen and **erased what had been typed** — every
 * response wrote one unsequenced `browserSignIn` state, so whichever settled
 * last won. `claimSignInScreen` is the rule that stops it, and the sibling file
 * drives that rule behaviourally by overlapping two claims.
 *
 * This file is the wiring, which fails separately and in ways the rule itself
 * cannot see: a correct sequencer the handler does not use, or uses a moment
 * too late, is the same defect back again with a helper beside it. It is a
 * `.ts` rather than part of the sibling because the web tsconfig — the one that
 * compiles the renderer tests — sets `types: []`, so a `.tsx` test has no
 * `node:fs` to read a file off disk with.
 *
 * Read from the source because a click handler passed to `VaultHome` never runs
 * under `renderToStaticMarkup`, which is the only rendering this suite has.
 * Asserted on the syntax tree rather than by matching text: what matters is the
 * order of the *statements* and where the value flows, and both survive the
 * handler being reworded, renamed or moved down the file.
 */
describe('the handler that opens a browser', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
	const file = ts.createSourceFile(
		'App.tsx',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX
	);

	/**
	 * Comments removed before anything is matched.
	 *
	 * A substring search cannot tell code from prose, and this file is mostly
	 * prose. Delete the claim and leave a sentence behind — "previously claimed
	 * by claimSignInScreen" — and a raw-text search is still satisfied by the
	 * sentence describing what is no longer there.
	 */
	const strip = (text: string): string =>
		text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

	/** The `onOpenBrowser` prop `VaultHome`'s three buttons all call. */
	const handler = (() => {
		let found: ts.ArrowFunction | undefined;
		const visit = (node: ts.Node): void => {
			if (ts.isJsxAttribute(node) && node.name.getText() === 'onOpenBrowser') {
				const initializer = node.initializer;
				if (
					initializer &&
					ts.isJsxExpression(initializer) &&
					initializer.expression &&
					ts.isArrowFunction(initializer.expression)
				) {
					found = initializer.expression;
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		expect(found, 'nothing is passed to VaultHome as onOpenBrowser any more').toBeDefined();
		return found as ts.ArrowFunction;
	})();

	const body = (() => {
		const block = handler.body;
		expect(ts.isBlock(block), 'the open-browser handler is no longer a block').toBe(true);
		return block as ts.Block;
	})();

	const statements = body.statements.map((statement) => strip(statement.getText()));

	/** The name bound to the claim, whatever it has been called. */
	const claimed = (() => {
		for (const statement of body.statements) {
			if (!ts.isVariableStatement(statement)) {
				continue;
			}
			for (const declaration of statement.declarationList.declarations) {
				if (
					declaration.initializer &&
					ts.isIdentifier(declaration.name) &&
					strip(declaration.initializer.getText()).includes('claimSignInScreen(')
				) {
					return declaration.name.text;
				}
			}
		}
		return undefined;
	})();

	/**
	 * **The claim is made before the request, not after the answer.**
	 *
	 * This is the escape that a "does it call the sequencer" test cannot see, and
	 * it is the whole defect written a second way: claim the generation once the
	 * `await` has returned and every answer is the newest there is, including one
	 * that was overtaken while it was in the air. Statement order in the block is
	 * the property, so it holds wherever in the file the handler ends up.
	 */
	it('claims the generation before it asks main to open anything', () => {
		expect(claimed, 'the open-browser handler no longer claims a generation at all').toBeDefined();

		const claimAt = statements.findIndex((text) => text.includes('claimSignInScreen('));
		const requestAt = statements.findIndex((text) => text.includes('openAccountBrowser('));
		expect(requestAt, 'the handler no longer opens a browser').toBeGreaterThan(-1);
		expect(
			claimAt,
			'the generation is claimed after the open has already answered, so every answer is the ' +
				'newest one — an overtaken response still replaces the sign-in screen the user is ' +
				'typing into'
		).toBeLessThan(requestAt);
	});

	/**
	 * Every write of the sign-in screen that puts one *up*.
	 *
	 * `setBrowserSignIn(undefined)` — the success path and the cancel button —
	 * takes a screen down and is not what this is about.
	 */
	const installs = (() => {
		const found: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'setBrowserSignIn' &&
				strip(node.arguments[0]?.getText() ?? '').trim() !== 'undefined'
			) {
				found.push(node);
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
		return found;
	})();

	it('installs the screen only with what the claim handed back', () => {
		expect(
			installs,
			'the sign-in screen is put up somewhere that does not go through the claim, so a ' +
				'response that has been overtaken can still take the screen over'
		).toHaveLength(1);

		const argument = (installs[0] as ts.CallExpression).arguments[0];
		expect(
			argument && ts.isIdentifier(argument),
			'the screen is built inline, past the claim'
		).toBe(true);

		/** The name bound to the claim's answer, whatever it has been called. */
		const prompt = (() => {
			for (const statement of body.statements) {
				if (!ts.isVariableStatement(statement)) {
					continue;
				}
				for (const declaration of statement.declarationList.declarations) {
					const initializer = declaration.initializer;
					if (
						initializer &&
						ts.isIdentifier(declaration.name) &&
						ts.isCallExpression(initializer) &&
						ts.isIdentifier(initializer.expression) &&
						initializer.expression.text === claimed
					) {
						return declaration.name.text;
					}
				}
			}
			return undefined;
		})();
		expect(prompt, 'nothing in the handler asks the claim what the answer may do').toBeDefined();
		expect(
			(argument as ts.Identifier).text,
			'the screen is installed from something the claim did not hand back'
		).toBe(prompt);
	});

	/**
	 * **And guarded, so a superseded answer clears nothing either.**
	 *
	 * The claim returns `undefined` for an answer that has been overtaken.
	 * Passing that straight to `setBrowserSignIn` would take down the sign-in
	 * screen a newer open put up — together with the password already typed into
	 * it — which is the same erasure by a different route.
	 */
	it('leaves a newer screen alone when the answer is superseded', () => {
		const install = installs[0] as ts.CallExpression;
		const argument = (install.arguments[0] as ts.Identifier).text;

		let child: ts.Node = install;
		let parent: ts.Node | undefined = install.parent;
		let guard: ts.IfStatement | undefined;
		while (parent && parent !== body) {
			if (ts.isIfStatement(parent) && parent.thenStatement === child) {
				guard = parent;
				break;
			}
			child = parent;
			parent = parent.parent;
		}

		expect(
			guard,
			'the screen is set unconditionally, so an overtaken answer clears the sign-in screen a ' +
				'newer open put up and destroys the password typed into it'
		).toBeDefined();
		expect(
			strip((guard as ts.IfStatement).expression.getText()),
			'the guard is not the value the claim handed back'
		).toContain(argument);
	});
});
