import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('the App wiring invalidates from every account-home navigation surface', () => {
	const source = readFileSync('src/renderer/App.tsx', 'utf8');
	const file = ts.createSourceFile(
		'App.tsx',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX
	);
	let home: ts.JsxSelfClosingElement | undefined;
	const findHome = (node: ts.Node): void => {
		if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'VaultHome') {
			home = node;
			return;
		}
		ts.forEachChild(node, findHome);
	};
	findHome(file);
	const homeProp = (name: string): string => {
		const attribute = home?.attributes.properties.find(
			(candidate) => ts.isJsxAttribute(candidate) && candidate.name.getText(file) === name
		);
		expect(attribute, `${name} is absent from VaultHome`).toBeDefined();
		return attribute?.getText(file) ?? '';
	};

	it('found the complete VaultHome prop block', () => {
		expect(home).toBeDefined();
		expect(home?.attributes.properties.length).toBeGreaterThan(20);
	});

	it.each([
		'onBackUpRevocationCode',
		'onChangeRouting',
		'onShowConfirmations',
		'onRemoveAccount',
		'onChangeAutoConfirm',
		'onImport',
		'onRecover',
		'onEnrol',
		'onMove',
		'onFinishActivation',
		'onSettings',
		'onAbout',
		'onActivity'
	])('%s goes through the synchronous foreground owner', (property) => {
		const handler = homeProp(property);
		expect(handler, `${property} bypasses foreground navigation ownership`).toMatch(
			/(navigateFromAccountHome|openAccountOverlay)/
		);
	});

	it('invalidates a browser open before its first await', () => {
		const handler = homeProp('onOpenBrowser');
		const invalidated = handler.indexOf('leaveAccountHome()');
		const request = handler.indexOf('await api.openAccountBrowser');
		expect(invalidated).toBeGreaterThanOrEqual(0);
		expect(request).toBeGreaterThan(invalidated);
	});

	it('invalidates an export before opening the native dialog', () => {
		expect(homeProp('onExport')).toContain('startAccountExport');
		const start = source.indexOf('const startAccountExport = useCallback');
		const handler = source.slice(start, source.indexOf('/** The account being removed', start));
		const invalidated = handler.indexOf('leaveAccountHome()');
		const request = handler.indexOf('api.exportAccount');
		expect(invalidated, 'Export never revoked the delayed recovery claim').toBeGreaterThanOrEqual(
			0
		);
		expect(request, 'the export request is absent from its VaultHome handler').toBeGreaterThan(
			invalidated
		);
	});

	it('routes every unresolved operation before the pending-activation form', () => {
		const handler = homeProp('onFinishActivation');
		const guard = handler.indexOf('if (account.unresolvedOperation !== undefined)');
		const operation = handler.indexOf('openAccountOverlay(() => setRemovingFor(account))');
		const cleanActivation = handler.indexOf('setResumeEnrollment(account)');

		expect(guard, 'the row status outranks a durable operation record').toBeGreaterThanOrEqual(0);
		expect(
			operation,
			'the operation is not sent to its kind-aware resolution surface'
		).toBeGreaterThan(guard);
		expect(handler.slice(operation, cleanActivation)).toContain('return;');
		expect(
			cleanActivation,
			'a clean pending activation no longer reaches AddAuthenticator'
		).toBeGreaterThan(operation);
		expect(handler.slice(cleanActivation)).toContain("navigateFromAccountHome('enroll')");
	});

	it('passes the complete unresolved record through to preserve its kind and token', () => {
		const handler = homeProp('onFinishActivation');
		expect(handler).toContain('setRemovingFor(account)');

		const start = source.indexOf('if (removingFor) {');
		const removal = source.slice(start, source.indexOf('if (confirmingFor) {', start));
		expect(removal).toContain('account={removingFor}');
		expect(removal).toMatch(
			/api\.resolveAccountOperation\([\s\S]*?removingFor\.steamId64,[\s\S]*?kind,[\s\S]*?operationToken,/
		);
	});
});
