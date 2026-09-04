import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { WINDOWS_TOAST_ACTIVATOR_CLSID } from '../src/main/confirmations/windows-toast-activation';

type BuilderModule = {
	default: {
		productName?: string;
		appx?: {
			customManifestPath?: string;
			customExtensionsPath?: string;
		};
	};
};

const root = join(__dirname, '..');
let builder: BuilderModule['default'];
let manifestPath: string | undefined;
let extensionsPath: string | undefined;
let manifest = '';
let extensions = '';

function requiredFile(relative: string | undefined, label: string): string {
	if (relative === undefined) {
		throw new Error(`${label} is not configured`);
	}
	const absolute = join(root, relative);
	expect(existsSync(absolute), `${label} does not exist at ${relative}`).toBe(true);
	return readFileSync(absolute, 'utf8');
}

const withoutXmlComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, ' ');
let manifestMarkup = '';
let extensionMarkup = '';

beforeAll(async () => {
	({ default: builder } = await import('../electron-builder.config.mjs'));
	manifestPath = builder.appx?.customManifestPath;
	extensionsPath = builder.appx?.customExtensionsPath;
	manifest = requiredFile(manifestPath, 'the custom AppX manifest');
	extensions = requiredFile(extensionsPath, 'the custom AppX extension fragment');
	manifestMarkup = withoutXmlComments(manifest);
	extensionMarkup = withoutXmlComments(extensions);
});

describe('the Store package notification activator', () => {
	it('configures both halves of the AppX manifest override', () => {
		expect(manifestPath).toBe('signing/appx-manifest.xml');
		expect(extensionsPath).toBe('signing/appx-extensions.xml');
	});

	it('keeps every electron-builder template value dynamic', () => {
		for (const macro of [
			'publisher',
			'publisherDisplayName',
			'version',
			'applicationId',
			'identityName',
			'executable',
			'displayName',
			'description',
			'backgroundColor',
			'logo',
			'square150x150Logo',
			'square44x44Logo',
			'lockScreen',
			'defaultTile',
			'splashScreen',
			'arch',
			'resourceLanguages',
			'capabilities',
			'extensions',
			'minVersion',
			'maxVersionTested'
		]) {
			expect(manifestMarkup, `the custom manifest froze builder value ${macro}`).toContain(
				`\${${macro}}`
			);
		}
		// Builder substitutes tokens inside XML comments too. A second occurrence in
		// prose injects the whole fragment into the comment and makes MakeAppx reject
		// the generated manifest before it can validate the declarations themselves.
		expect(manifest.match(/\$\{extensions\}/g)).toHaveLength(1);
	});

	it('declares COM at package scope and marks every extension namespace ignorable', () => {
		const packageStart = manifestMarkup.match(/<Package\b[\s\S]*?>/)?.[0] ?? '';
		expect(packageStart).toContain(
			'xmlns:com="http://schemas.microsoft.com/appx/manifest/com/windows10"'
		);
		const ignorable = /IgnorableNamespaces="([^"]+)"/.exec(packageStart)?.[1]?.split(/\s+/) ?? [];
		expect(ignorable).toEqual(expect.arrayContaining(['uap', 'desktop', 'com', 'rescap']));
	});

	it('registers one COM class and one toast activator with the runtime CLSID', () => {
		expect(extensionMarkup.match(/<com:Extension\b/g)).toHaveLength(1);
		expect(extensionMarkup.match(/Category="windows\.comServer"/g)).toHaveLength(1);
		expect(extensionMarkup.match(/<desktop:Extension\b/g)).toHaveLength(1);
		expect(extensionMarkup.match(/Category="windows\.toastNotificationActivation"/g)).toHaveLength(
			1
		);

		const classId = /<com:Class\b[^>]*\bId="([^"]+)"/.exec(extensionMarkup)?.[1];
		const toastId =
			/<desktop:ToastNotificationActivation\b[^>]*\bToastActivatorCLSID="([^"]+)"/.exec(
				extensionMarkup
			)?.[1];
		expect(classId).toBe(WINDOWS_TOAST_ACTIVATOR_CLSID);
		expect(toastId).toBe(WINDOWS_TOAST_ACTIVATOR_CLSID);
	});

	it('points the COM server at the exact executable electron-builder packages', () => {
		const executable = /<com:ExeServer\b[^>]*\bExecutable="([^"]+)"/.exec(extensionMarkup)?.[1];
		expect(builder.productName).toBeTypeOf('string');
		expect(executable).toBe(`app\\${builder.productName}.exe`);
		expect(extensionMarkup).not.toMatch(/<Extensions\b/);
	});
});
