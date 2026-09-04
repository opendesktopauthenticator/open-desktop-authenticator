import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * **That the application actually hands its `ProxyConsent` to the import
 * handlers.**
 *
 * `import/ipc.ts` now puts every proxy an import would adopt to the user before
 * anything is written, and `import-proxy-consent.test.ts` proves that end to
 * end. What that suite cannot show is whether the *shipped* app passes the
 * instance the rest of the process shares, because it constructs its own.
 *
 * The parameter is defaulted rather than required, following
 * `registerVaultHandlers`, and a defaulted `ProxyConsent` has no way to ask —
 * so it refuses. Forgetting the argument is therefore fail-closed rather than
 * silent: no proxy is adopted unseen. But it is still wrong. The user loses the
 * ability to say yes at all, with a message about a destination not being
 * approved and no dialog to explain it, and — worse — the refusals never reach
 * the shared approval set, so nothing the user agreed to in Settings or during
 * enrolment is recognised here either.
 *
 * ## Why this reads the source, and how
 *
 * `src/main/index.ts` is the Electron entry point; importing it means importing
 * `app`, `BrowserWindow`, the tray and the updater, which is not something a
 * unit test can stand up. The repo already asserts wiring against that file's
 * text in `routing-teardown.test.ts`, `security-posture.test.ts` and
 * `transfer-screen-wiring.test.ts`.
 *
 * This one does **not** match text. Matching text is how these guards rot: a
 * regex over `registerImportHandlers\(imports, proxyConsent\)` dies when the
 * variable is renamed, when the call is wrapped, when prettier moves the
 * arguments onto separate lines, or when the same characters turn up inside a
 * comment. So the file is parsed with the TypeScript compiler that already
 * builds it, and the assertion is a property of the syntax tree: the call to
 * `registerImportHandlers`, wherever it is and however it is formatted, is
 * given a second argument. Comments cannot satisfy it and layout cannot break
 * it.
 */

const MAIN = join(__dirname, '..', 'src', 'main', 'index.ts');

/** Every call to `name(...)` in the file, as syntax rather than as text. */
function callsTo(name: string): ts.CallExpression[] {
	const source = ts.createSourceFile(
		MAIN,
		readFileSync(MAIN, 'utf8'),
		ts.ScriptTarget.ESNext,
		true
	);

	const found: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			if (node.expression.text === name) {
				found.push(node);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe('main/index.ts wires the import handlers to the shared ProxyConsent', () => {
	it('registers the import handlers at all', () => {
		// The anchor. Without this the assertion below would pass vacuously the day
		// somebody renames the function, and a guard that cannot fail is worse than
		// no guard because it reads like one that can.
		expect(
			callsTo('registerImportHandlers'),
			'nothing in main/index.ts registers the import handlers, so this file is guarding a ' +
				'call that no longer exists'
		).toHaveLength(1);
	});

	it('passes it a consent to ask with', () => {
		const [call] = callsTo('registerImportHandlers');

		expect(
			call?.arguments.length,
			'registerImportHandlers was given only the import service, so it falls back to a ' +
				'ProxyConsent that has no way to ask and therefore refuses every address. Importing ' +
				'a maFile can then never adopt the proxy inside it, and the approvals the user gave ' +
				'in Settings are not recognised here. Pass the application-wide `proxyConsent`, the ' +
				'same one registerVaultHandlers and registerTransferHandlers are given.'
		).toBeGreaterThanOrEqual(2);
	});
});
