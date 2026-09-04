import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function dynamicErrorExpressions(path: string): string[] {
	const source = readFileSync(path, 'utf8');
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const expressions: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isJsxElement(node) &&
			ts.isIdentifier(node.openingElement.tagName) &&
			node.openingElement.tagName.text === 'DynamicError'
		) {
			for (const child of node.children) {
				if (ts.isJsxExpression(child) && child.expression !== undefined) {
					expressions.push(child.expression.getText(file).replace(/\s+/g, ' '));
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return expressions;
}

function rejectionHandlers(path: string): string[] {
	const source = readFileSync(path, 'utf8');
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const handlers: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'catch'
		) {
			handlers.push(node.getText(file));
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return handlers;
}

describe('dynamic error wiring', () => {
	it('does not leave state-backed error strings in silent error paragraphs', () => {
		const renderer = join(process.cwd(), 'src', 'renderer');
		const directory = join(renderer, 'screens');
		const offenders: string[] = [];
		const paths = [
			join(renderer, 'App.tsx'),
			...readdirSync(directory)
				.filter((name: string) => name.endsWith('.tsx'))
				.map((name: string) => join(directory, name))
		];
		for (const path of paths) {
			const name = path.slice(renderer.length + 1);
			const source = readFileSync(path, 'utf8');
			const file = ts.createSourceFile(
				path,
				source,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX
			);
			const visit = (node: ts.Node): void => {
				if (
					ts.isJsxElement(node) &&
					ts.isIdentifier(node.openingElement.tagName) &&
					node.openingElement.tagName.text === 'p'
				) {
					const errorClass = node.openingElement.attributes.properties.some(
						(attribute) =>
							ts.isJsxAttribute(attribute) &&
							attribute.name.getText(file) === 'className' &&
							attribute.initializer !== undefined &&
							ts.isStringLiteral(attribute.initializer) &&
							attribute.initializer.text.split(/\s+/).includes('error')
					);
					const dynamicExpression = node.children.some(
						(child) => ts.isJsxExpression(child) && child.expression !== undefined
					);
					if (errorClass && dynamicExpression) {
						offenders.push(
							`${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
						);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(file);
		}
		expect(offenders, 'dynamic errors without the shared announcement component').toEqual([]);
	});

	it.each([
		['UnlockVault.tsx', 'passphrase', 'unlock-error'],
		['SteamSignIn.tsx', 'steam-password', 'steam-sign-in-error'],
		['AccountRouting.tsx', 'proxy-address', 'routing-error']
	])('%s associates its identifiable field with its dynamic error', (name, fieldId, errorId) => {
		const source = readFileSync(join('src/renderer/screens', name), 'utf8');
		const start = source.indexOf(`id="${fieldId}"`);
		const input = source.slice(start, source.indexOf('/>', start));
		expect(start, `${fieldId} is absent`).toBeGreaterThanOrEqual(0);
		expect(input).toContain('aria-invalid');
		expect(input).toContain(errorId);
		expect(source).toContain(`<DynamicError id="${errorId}"`);
	});
});

describe('VaultHome asynchronous failures', () => {
	const path = join(process.cwd(), 'src', 'renderer', 'screens', 'VaultHome.tsx');
	const source = readFileSync(path, 'utf8');
	const announced = dynamicErrorExpressions(path);
	const rejected = rejectionHandlers(path);
	const appPath = join(process.cwd(), 'src', 'renderer', 'App.tsx');
	const appSource = readFileSync(appPath, 'utf8');
	const appAnnounced = dynamicErrorExpressions(appPath);

	it('derives per-account code failures from the asynchronous code-list result', () => {
		expect(source).toMatch(
			/new Map\(codes\?\.failures\.map\(\(entry\) => \[entry\.steamId64, entry\.reason\]\)\)/
		);
	});

	it.each([
		['copy', 'setCopyError'],
		['browser-open', 'setBrowserError']
	])('%s rejection records a user-visible failure', (_name, setter) => {
		expect(
			rejected.some((handler) => handler.includes(`${setter}(`)),
			`${setter} is not reached from a rejected asynchronous operation`
		).toBe(true);
	});

	it.each([
		['code-list', 'failure'],
		['copy', 'copyError.message'],
		['browser-open', 'browserError.get(account.steamId64)']
	])('%s failure is consumed by DynamicError', (_name, expression) => {
		expect(announced, `${expression} bypasses the shared live-region component`).toContain(
			expression
		);
	});

	it('announces the stale plaintext copy but not an ordinary export completion', () => {
		expect(appSource).toMatch(/result\.state === 'saved' && result\.staleCopy/);
		expect(appAnnounced).toContain('notice.error');
		expect(appAnnounced).not.toContain('notice.status');
		expect(appSource).toContain('{notice.status && <p role="status">{notice.status}</p>}');
	});

	it('records an export rejection in the app-level owner that renders it', () => {
		expect(appSource).toContain('record(exportFailureNoticeFor(account, attempt, err))');
		expect(appAnnounced).toContain('notice.error');
	});
});
