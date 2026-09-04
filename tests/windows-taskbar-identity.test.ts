import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { branding } from '../src/shared/branding';
import { developmentWindowsAppId, portableWindowsAppId } from '../src/main/windows-identity';
import {
	applyWindowsTaskbarIdentity,
	browserWindowIcon,
	windowsTaskbarDetails
} from '../src/main/windows-taskbar-identity';

const ROOT = resolve(__dirname, '..');
const MAIN = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
const ACCOUNT_BROWSER = readFileSync(join(ROOT, 'src/main/browser/electron-host.ts'), 'utf8');

const development = {
	platform: 'win32' as const,
	packaged: false,
	windowsStore: false,
	portable: false,
	portableExecutablePath: undefined,
	applicationPath: ROOT,
	executablePath: join(ROOT, 'node_modules/electron/dist/electron.exe')
};

describe('the taskbar identity shared by every top-level window', () => {
	it('uses the same environment for each constructor icon and its group identity', () => {
		for (const [name, source] of [
			['main', MAIN],
			['account', ACCOUNT_BROWSER]
		] as const) {
			const construction = source.indexOf('new BrowserWindow(');
			const identity = source.indexOf('applyWindowsTaskbarIdentity(window', construction);
			const environment = source.lastIndexOf('const taskbarEnvironment:', construction);
			const environmentBoundary = source.slice(environment, construction);
			const constructorBoundary = source.slice(construction, identity);

			expect(environment, `${name} taskbar environment is missing`).toBeGreaterThanOrEqual(0);
			expect(construction, `${name} BrowserWindow constructor is missing`).toBeGreaterThanOrEqual(
				0
			);
			expect(identity, `${name} taskbar identity boundary is missing`).toBeGreaterThan(
				construction
			);
			expect(environmentBoundary).toContain('platform: process.platform');
			expect(constructorBoundary).toContain(
				'icon: browserWindowIcon(taskbarEnvironment, windowImage)'
			);
			expect(constructorBoundary).not.toContain('icon: windowImage()');
			expect(constructorBoundary).not.toContain('nativeImage.createFromPath');
			expect(source.slice(identity, identity + 100)).toContain(
				'applyWindowsTaskbarIdentity(window, taskbarEnvironment)'
			);
		}
	});

	it('hands ordinary Windows development the tracked ICO without building the fallback', () => {
		const fallback = vi.fn(() => ({ generated: true }));
		const icon = browserWindowIcon(development, fallback);

		expect(icon).toBe(join(ROOT, 'build/icon.ico'));
		expect(isAbsolute(icon as string)).toBe(true);
		expect(existsSync(icon as string), 'the constructor ICO is missing').toBe(true);
		expect(fallback).not.toHaveBeenCalled();
	});

	it.each([
		['installed', { packaged: true }],
		['Store', { packaged: true, windowsStore: true }],
		['portable', { packaged: true, portable: true }],
		['Linux', { platform: 'linux' as const }],
		['macOS', { platform: 'darwin' as const }]
	])('keeps the generated window image for %s', (_name, override) => {
		const generated = { generated: true };
		const fallback = vi.fn(() => generated);

		expect(browserWindowIcon({ ...development, ...override }, fallback)).toBe(generated);
		expect(fallback).toHaveBeenCalledOnce();
	});

	it('uses the real ICO and complete group details in ordinary development', () => {
		const details = windowsTaskbarDetails(development);

		expect(details).toEqual({
			appId: developmentWindowsAppId(branding.appId),
			appIconPath: join(ROOT, 'build/icon.ico'),
			appIconIndex: 0,
			relaunchCommand: `"${development.executablePath}" "${ROOT}"`,
			relaunchDisplayName: `${branding.productName} (Development)`
		});
		expect(isAbsolute(details!.appIconPath)).toBe(true);
		expect(details!.appIconPath).not.toBe(development.executablePath);
		expect(existsSync(details!.appIconPath), 'the development taskbar ICO is missing').toBe(true);
	});

	it('leaves an installed executable on its matching process and shortcut identity', () => {
		const executablePath = join(ROOT, 'release/win-unpacked/Open Desktop Authenticator.exe');
		const details = windowsTaskbarDetails({
			...development,
			packaged: true,
			executablePath
		});

		expect(details).toBeUndefined();
	});

	it('uses the durable outer launcher for a portable icon and relaunch', () => {
		const launcher = join(ROOT, 'release/open-desktop-authenticator-1.5.0-portable.exe');
		const innerExecutable = join(
			process.env.TEMP ?? 'C:\\Temp',
			'oda-inner/Open Desktop Authenticator.exe'
		);
		const details = windowsTaskbarDetails({
			...development,
			packaged: true,
			portable: true,
			portableExecutablePath: launcher,
			executablePath: innerExecutable
		});

		expect(details).toEqual({
			appId: portableWindowsAppId(branding.appId),
			appIconPath: launcher,
			appIconIndex: 0,
			relaunchCommand: `"${launcher}"`,
			relaunchDisplayName: branding.productName
		});
		expect(details!.appIconPath).not.toBe(innerExecutable);
	});

	it('refuses to point a portable identity at the temporary inner executable', () => {
		expect(
			windowsTaskbarDetails({
				...development,
				packaged: true,
				portable: true,
				portableExecutablePath: undefined
			})
		).toBeUndefined();
	});

	it('does not override the Microsoft Store package identity', () => {
		expect(
			windowsTaskbarDetails({ ...development, packaged: true, windowsStore: true })
		).toBeUndefined();
	});

	it('refreshes the AppUserModelID only after the relaunch icon exists', () => {
		const setAppDetails = vi.fn();
		let storedIcon: string | undefined;
		let iconSeenByTaskbar: string | undefined;
		setAppDetails.mockImplementation((details: { appId?: string; appIconPath?: string }): void => {
			// Chromium writes the ID before the icon within each call, and Windows
			// snapshots the group icon when that ID is committed.
			if (details.appId) iconSeenByTaskbar = storedIcon;
			if (details.appIconPath) storedIcon = details.appIconPath;
		});

		applyWindowsTaskbarIdentity({ setAppDetails }, development);

		const details = windowsTaskbarDetails(development)!;
		expect(setAppDetails.mock.calls).toEqual([[details], [{ appId: details.appId }]]);
		expect(iconSeenByTaskbar).toBe(details.appIconPath);
	});

	it.each(['darwin', 'linux'] as const)('does nothing on %s', (platform) => {
		const setAppDetails = vi.fn();

		applyWindowsTaskbarIdentity({ setAppDetails }, { ...development, platform });

		expect(setAppDetails).not.toHaveBeenCalled();
	});

	it('passes the complete ungated runtime identity to both window boundaries', () => {
		for (const [name, source] of [
			['main', MAIN],
			['account', ACCOUNT_BROWSER]
		] as const) {
			const construction = source.indexOf('new BrowserWindow(');
			const environment = source.lastIndexOf('const taskbarEnvironment:', construction);
			const identity = source.indexOf('applyWindowsTaskbarIdentity(window', construction);
			const declaration = source.slice(environment, construction);
			const beforeIdentity = source.slice(construction, identity);

			expect(environment, `${name} taskbar environment is missing`).toBeGreaterThanOrEqual(0);
			expect(identity, `${name} taskbar identity call is missing`).toBeGreaterThan(construction);
			expect(beforeIdentity, `${name} taskbar identity is conditional`).not.toMatch(/\bif\s*\(/);
			expect(beforeIdentity).not.toContain('ODA_WINDOWS_IDENTITY');
			expect(declaration).toContain('platform: process.platform');
			expect(declaration).toContain('packaged: app.isPackaged');
			expect(declaration).toContain(
				'windowsStore: (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true'
			);
			expect(declaration).toContain('process.env.PORTABLE_EXECUTABLE_DIR !== undefined');
			expect(declaration).toContain('portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE');
			expect(declaration).toContain('applicationPath: app.getAppPath()');
			expect(declaration).toContain('executablePath: process.execPath');
			expect(declaration).not.toContain('developmentIdentity');
			expect(declaration).not.toContain('ODA_WINDOWS_IDENTITY');
			expect(source.slice(identity, identity + 100)).toContain(
				'applyWindowsTaskbarIdentity(window, taskbarEnvironment)'
			);
		}
	});

	it('requires every production BrowserWindow constructor to use the shared icon selector', () => {
		const filesBelow = (directory: string): string[] =>
			readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) return filesBelow(path);
				return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
			});
		const constructors: { file: string; icon: string | undefined }[] = [];

		for (const path of filesBelow(join(ROOT, 'src/main'))) {
			const source = ts.createSourceFile(
				path,
				readFileSync(path, 'utf8'),
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS
			);
			const browserWindowNames = new Set<string>();
			for (const statement of source.statements) {
				if (
					ts.isImportDeclaration(statement) &&
					ts.isStringLiteral(statement.moduleSpecifier) &&
					statement.moduleSpecifier.text === 'electron' &&
					statement.importClause?.namedBindings &&
					ts.isNamedImports(statement.importClause.namedBindings)
				) {
					for (const imported of statement.importClause.namedBindings.elements) {
						if ((imported.propertyName ?? imported.name).text === 'BrowserWindow') {
							browserWindowNames.add(imported.name.text);
						}
					}
				}
			}
			const visit = (node: ts.Node): void => {
				if (
					ts.isNewExpression(node) &&
					ts.isIdentifier(node.expression) &&
					browserWindowNames.has(node.expression.text)
				) {
					const options = node.arguments?.[0];
					const icon =
						options && ts.isObjectLiteralExpression(options)
							? options.properties
									.find(
										(property): property is ts.PropertyAssignment =>
											ts.isPropertyAssignment(property) && property.name.getText(source) === 'icon'
									)
									?.initializer.getText(source)
							: undefined;
					constructors.push({ file: relative(ROOT, path), icon });
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}

		expect(constructors, 'the production BrowserWindow inventory changed').toHaveLength(2);
		for (const constructor of constructors) {
			expect(constructor.icon, constructor.file).toBe(
				'browserWindowIcon(taskbarEnvironment, windowImage)'
			);
		}
	});

	it('assigns the main window before any ready-to-show handler can reveal it', () => {
		const construction = MAIN.indexOf('const window = new BrowserWindow(');
		const identity = MAIN.indexOf('applyWindowsTaskbarIdentity(window', construction);
		const reveal = MAIN.indexOf("window.once('ready-to-show'", construction);

		expect(construction).toBeGreaterThanOrEqual(0);
		expect(identity, 'the main window never receives taskbar app details').toBeGreaterThan(
			construction
		);
		expect(reveal).toBeGreaterThan(identity);
		expect(
			MAIN.slice(construction, reveal).match(/applyWindowsTaskbarIdentity\(window/g)
		).toHaveLength(1);
	});
});
