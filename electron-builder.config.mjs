import {
	hasUnresolvedStoreIdentity,
	storeIdentity,
	unresolvedStoreFields
} from './store-identity.mjs';

/**
 * How the application is packaged, for three audiences at once.
 *
 * ## Why three Windows targets and not one
 *
 * §4's answer to the clone problem is a chain a stranger can walk, and different
 * strangers walk different parts of it.
 *
 *   appx      The Microsoft Store. Microsoft re-signs the package with its own
 *             certificate, so SmartScreen never warns — not on the first
 *             download, not ever. That matters more here than anywhere, because
 *             this application's entire argument is "the fake SDA downloads are
 *             the dangerous ones", and an installer that makes Windows say
 *             "Windows protected your PC" argues the opposite on the user's
 *             behalf. This is the front door for the people most at risk.
 *
 *   nsis      The GitHub release. For people who do not use the Store, and for
 *             anyone who wants to verify the download themselves against a
 *             published hash. This is the channel /verify describes.
 *
 *   portable  No installer, no writes outside its own directory. For locked-down
 *             machines and for people who want to try it without installing.
 *             Labelled manual-update everywhere it appears, because nothing will
 *             tell it a new version exists.
 *
 * Only the Store build gets a free ride on SmartScreen. The nsis and portable
 * builds warn until reputation accrues, which is a property of the channel and
 * not something a certificate fixes any more — EV stopped bypassing SmartScreen
 * in 2024.
 *
 * ## What is deliberately absent
 *
 * No auto-updater, on any target. `src/main/update/checker.ts` explains why at
 * length: an application that downloads and executes its own replacement is the
 * exact mechanism the clone sites use. The Store target is the one exception,
 * and only because there the replacement is fetched and verified by Windows
 * rather than by us.
 */

const store = {
	...storeIdentity,
	// Tiles inherit the icon; a name burned into the tile art would have to be
	// regenerated for every rename and would disagree with `branding` in between.
	showNameOnTiles: false
};

/**
 * Refuse an appx that would be rejected on upload.
 *
 * Throwing from the config aborts before any packaging work happens, and names
 * the fields, so the failure reads as "the Store account does not exist yet"
 * rather than as a build error.
 */
function requireStoreIdentity() {
	if (hasUnresolvedStoreIdentity()) {
		throw new Error(
			`Cannot build the Microsoft Store package: ${unresolvedStoreFields().join(', ')} ` +
				`${unresolvedStoreFields().length === 1 ? 'is still a placeholder' : 'are still placeholders'}. ` +
				'These come from Partner Center once the Store account exists — see store-identity.mjs. ' +
				'Build the nsis and portable targets instead until then.'
		);
	}
	return store;
}

/** Only demanded when the appx target is actually requested. */
const wantsAppx = process.argv.some((arg) => arg.includes('appx'));

export default {
	appId: 'com.opendesktopauthenticator.desktop',
	productName: 'Open Desktop Authenticator',
	copyright: `Copyright © ${new Date().getFullYear()} MASTERPANEL LLC`,

	directories: {
		output: 'release',
		buildResources: 'build'
	},

	// Only the built output and the manifest. Source, tests, site and infra have
	// no business inside a shipped package, and `infra/` in particular describes
	// a server.
	//
	// The dependency filters are not only about size. The first package shipped
	// 175 test files and 316 TypeScript sources from inside `node_modules` —
	// zod alone carries its whole suite — and a signed installer containing
	// somebody else's tests is a question an auditor is right to ask and we
	// would rather not have to answer. None of it is reachable at runtime:
	// packages are entered through their compiled entry point, and `.d.ts` is a
	// compile-time artifact that Electron never loads.
	files: [
		'out/**/*',
		'package.json',
		'!**/*.map',
		'!node_modules/**/{test,tests,__tests__,spec,example,examples,doc,docs,.github}/**',
		'!node_modules/**/*.{ts,md,markdown,flow,coffee}',
		'!node_modules/**/.*',
		// `.d.ts` sits under the same roots as the code that needs to stay.
		'node_modules/**/*.d.ts'
	],

	asar: true,

	// Nothing here compiles against Node's ABI, so the rebuild step is pure cost
	// and one more thing that can fail differently on a CI runner than locally.
	npmRebuild: false,

	win: {
		icon: 'build/icon.ico',
		// Signing is not configured. The Store target does not need it — Microsoft
		// re-signs — and the direct-download targets ship unsigned until the
		// SignPath Foundation certificate exists. Stated rather than omitted, so
		// nobody reads the absence as an oversight.
		signAndEditExecutable: true,
		target: [
			{ target: 'nsis', arch: ['x64', 'arm64'] },
			{ target: 'portable', arch: ['x64'] }
		]
	},

	nsis: {
		oneClick: false,
		perMachine: false,
		allowToChangeInstallationDirectory: true,
		installerHeader: 'build/installerHeader.bmp',
		installerSidebar: 'build/installerSidebar.bmp',
		// A vault is not application data. Uninstalling must not destroy the thing
		// the user would need to get back into their accounts.
		deleteAppDataOnUninstall: false,
		artifactName: '${productName}-${version}-${arch}-setup.${ext}'
	},

	portable: {
		artifactName: '${productName}-${version}-portable.${ext}'
	},

	appx: wantsAppx ? requireStoreIdentity() : store,

	linux: {
		icon: 'build/icons',
		category: 'Utility;Security',
		/*
		 * Required by the `.deb` target, which refuses to build without a
		 * maintainer — the packaging run that first produced this file failed on
		 * exactly that, after AppImage had already succeeded.
		 *
		 * A role address on the project's own domain, the same one `security.txt`
		 * publishes. Deliberately not an individual's: this string is written into
		 * public package metadata on every machine the `.deb` is installed on.
		 */
		maintainer: 'MASTERPANEL LLC <security@opendesktopauthenticator.com>',
		synopsis: 'Steam Guard codes and confirmations on your desktop',
		target: [
			{ target: 'AppImage', arch: ['x64'] },
			{ target: 'deb', arch: ['x64'] }
		],
		artifactName: '${productName}-${version}-${arch}.${ext}'
	},

	// Releases are published by the workflow from a tag, never from a developer's
	// machine, so the config names the destination and nothing else.
	publish: {
		provider: 'github',
		owner: 'opendesktopauthenticator',
		repo: 'open-desktop-authenticator',
		releaseType: 'draft'
	}
};
