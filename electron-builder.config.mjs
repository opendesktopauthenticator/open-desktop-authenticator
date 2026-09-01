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
 *             Labelled manual-update everywhere it appears: the update check
 *             still runs and still tells it a new version exists, but nothing
 *             fetches or installs one, so the user does the swap by hand.
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
	showNameOnTiles: false,

	/*
	 * **The floor is Chromium's, not electron-builder's.**
	 *
	 * electron-builder defaults both fields to `10.0.14316.0` — Windows 10 1607.
	 * Electron 43 carries a Chromium that has required Windows 10 1809 (build
	 * 17763) since Chrome 110, so on anything in the 14316-17762 band the package
	 * installs and then fails to launch. The Store treats MinVersion as an
	 * acquisition gate, so the default does not merely allow that case: it
	 * advertises the app to those machines and hands them a build that cannot
	 * start. Whoever is on Windows 10 1607 in 2026 gets a broken install and no
	 * explanation for it.
	 *
	 * Found by reading the manifest out of the built appx rather than the config,
	 * which is the only place the value appears — nothing in this repository sets
	 * it, so nothing in this repository showed it.
	 */
	minVersion: '10.0.17763.0',
	maxVersionTested: '10.0.22621.0'
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

/*
 * macOS signing, which is either fully configured or not configured at all.
 *
 * Two independent credentials are needed and they do different jobs. The
 * certificate (`CSC_LINK`) signs the bundle; the App Store Connect key
 * (`APPLE_API_KEY`) is what asks Apple to notarise the signed result. Having
 * one without the other produces a build that looks like it worked:
 * electron-builder signs and skips notarisation, or refuses to notarise and
 * carries on, and what comes out is a `.dmg` that Gatekeeper still blocks on
 * every machine except the one that built it.
 *
 * So the two are checked against each other rather than each on its own, and a
 * half-configured environment stops the build instead of shipping that file.
 * README says this project will not ship an unsigned macOS build; this is the
 * line that makes that true rather than aspirational.
 */
const macCertificate = (process.env.CSC_LINK ?? '') !== '';
const macNotaryKey = (process.env.APPLE_API_KEY ?? '') !== '';

if (macCertificate !== macNotaryKey) {
	const present = macCertificate ? 'CSC_LINK' : 'APPLE_API_KEY';
	const missing = macCertificate ? 'APPLE_API_KEY' : 'CSC_LINK';
	throw new Error(
		`macOS signing is half-configured: ${present} is set but ${missing} is not. ` +
			'Signing and notarisation are separate credentials and both are required — ' +
			'a signed but un-notarised build is blocked by Gatekeeper everywhere except ' +
			'the machine that built it. Set both, or neither.'
	);
}

/**
 * True when this build will be signed and notarised.
 *
 * False is a legitimate state, not a failure: it is what CI does on every
 * release so that macOS packaging is exercised rather than first attempted on
 * the day the certificate arrives. The workflow keeps that build out of the
 * release — see the artifact name in `.github/workflows/release.yml`.
 */
const macSigned = macCertificate && macNotaryKey;

export default {
	/*
	 * **Artifact names use `${name}`, not `${productName}`.**
	 *
	 * `productName` is "Open Desktop Authenticator", with spaces — and GitHub
	 * replaces spaces with dots when it stores a release asset. `SHA256SUMS.txt`
	 * is generated in CI from the staging directory, before that rename, so every
	 * filename in it disagreed with the file a user actually downloads. The
	 * documented way to use it is `sha256sum --check SHA256SUMS.txt`, which then
	 * reports "No such file or directory" for every line — the one file whose
	 * whole job is verification, failing at it.
	 *
	 * Found by verifying a real download by hand, which is the only way it could
	 * have been found: every hash in the file was correct.
	 */
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
		/*
		 * **The three trees `electron-vite` builds, named rather than swept up.**
		 *
		 * This was `out/**` + `/*`, and `out/` is where every bundle lands — including
		 * `out/smoke/` and `out/stress/`, the harnesses that drive a real Electron
		 * window in CI. They are built by separate scripts and never cleaned, so a
		 * package built on a machine that had run them shipped them: test code with
		 * a different threat model, inside a signed application, reachable by
		 * anything that can name a path in the asar.
		 *
		 * Naming the three keeps that shut by default. A fourth build target added
		 * later has to be added here on purpose, which is the right way round for
		 * something that decides what goes inside the installer.
		 */
		'out/main/**/*',
		'out/preload/**/*',
		'out/renderer/**/*',
		'package.json',
		/*
		 * **The notices every shipped dependency's licence requires.**
		 *
		 * MIT says the notice "shall be included in all copies or substantial
		 * portions of the Software", and until this existed that happened by
		 * accident: electron-builder copies whatever a package directory contains,
		 * and most packages keep a `LICENSE` beside their code. The accident had
		 * holes — the `.md` exclusion above strips `LICENSE.md`, which is the only
		 * licence file three of these packages have; three more ship none at all;
		 * and react, react-dom and scheduler are excluded from the asar entirely
		 * while their code goes into the renderer bundle.
		 *
		 * Generated by `scripts/generate-notices.mjs`, which `npm run build` runs,
		 * and compared against a fresh run by
		 * `tests/third-party-notices.test.ts`.
		 */
		'THIRD_PARTY_NOTICES.txt',
		'!**/*.map',
		'!node_modules/**/{test,tests,__tests__,spec,example,examples,doc,docs,.github}/**',
		'!node_modules/**/*.{ts,md,markdown,flow,coffee}',
		'!node_modules/**/.*',
		// **Declarations, in every spelling.** `*.{ts,...}` above catches `.d.ts`
		// and misses `.d.cts` and `.d.mts` entirely — a hundred-odd files that
		// Electron can never load, since a package is entered through its
		// compiled entry point and a declaration is a compile-time artifact.
		'!node_modules/**/*.d.{ts,cts,mts}',
		// **The rest of what a published package carries and an installer does not
		// need.** The directory list above catches `test/` and `examples/` and
		// misses everything named differently: seven files survived it —
		// `@protobufjs/float/bench/*`, `bytebuffer/scripts/build.js` and the same
		// under its bundled `long`, `node-bignumber/example.js`,
		// `protobufjs/ext/descriptor/test.js` and `protobufjs/scripts/postinstall.js`.
		//
		// Twelve kilobytes, so this is about what is in the archive rather than how
		// big it is: a build script and a postinstall hook are code that ships
		// inside a signed application and can never be reached by it, and every
		// file in there is one more thing a reader of the SBOM has to account for.
		//
		// Checked against the installed tree rather than guessed: nothing matched
		// here is an entry point, a `main`, or reachable from one.
		'!node_modules/**/{bench,benchmark,perf,scripts}/**',
		'!node_modules/**/{test,example,bench}.js',
		// **React is bundled, not required.** Vite compiles the renderer into a
		// single file that already contains React and ReactDOM; main and preload
		// import neither. Shipping the packages as well duplicated ~7.5 MB — half
		// the ASAR — of code nothing in the running app resolves. They stay in
		// `dependencies` because the renderer genuinely builds against them.
		'!node_modules/{react,react-dom,scheduler}/**'
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
		artifactName: '${name}-${version}-${arch}-setup.${ext}'
	},

	portable: {
		artifactName: '${name}-${version}-portable.${ext}'
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
		artifactName: '${name}-${version}-${arch}.${ext}'
	},

	/*
	 * macOS.
	 *
	 * One target, not two. The `.zip` that usually sits beside a `.dmg` exists
	 * to feed Squirrel.Mac, and this application has no auto-updater on any
	 * platform — `src/main/update/checker.ts` explains at length why an
	 * application that downloads and executes its own replacement is the exact
	 * mechanism the clone sites use. A second archive nobody can update from is
	 * one more file to hash, attest, sign and explain.
	 *
	 * Both architectures separately rather than one universal binary: a
	 * universal build carries two copies of Electron and roughly doubles the
	 * download, which is a poor trade for an audience that knows which Mac it
	 * owns. This also matches what the Windows side does.
	 */
	mac: {
		icon: 'build/icon.icns',
		category: 'public.app-category.utilities',

		/*
		 * **Required for notarisation, and the reason `entitlements` exists.**
		 *
		 * The Hardened Runtime is not optional — Apple will not notarise without
		 * it — and it switches off the two things V8 needs to run at all. The
		 * plist says what is granted and, at more length, what is not.
		 *
		 * These sit directly on `mac` rather than under a `sign` object: that
		 * move is an electron-builder v27 change and this project is on v26.
		 *
		 * `signing/` rather than `build/`, which is electron-builder's usual home
		 * for this file. Everything in `build/` is generated by
		 * `tools/make-icons.mjs` and `tests/icons.test.ts` regenerates the whole
		 * directory and compares it byte for byte — which is what lets an
		 * authenticator justify committing binaries at all. A hand-written file
		 * in there breaks that check, and the check is worth more than the
		 * convention.
		 */
		hardenedRuntime: true,
		entitlements: 'signing/entitlements.mac.plist',
		entitlementsInherit: 'signing/entitlements.mac.plist',

		// Notarisation is what makes Gatekeeper quiet on a stranger's machine.
		// Off when there are no credentials, so an unsigned CI build packages
		// and proves the target works instead of failing at the last step.
		notarize: macSigned,

		target: [{ target: 'dmg', arch: ['x64', 'arm64'] }]
	},

	dmg: {
		// The same shape as every other artifact here, and the reason is the
		// same: SHA256SUMS.txt is generated from these filenames.
		artifactName: '${name}-${version}-${arch}.${ext}',
		// A window with the app and a symlink to Applications, which is what
		// every macOS user already knows how to do. No custom background art:
		// it would have to be regenerated for every rename, and an installer
		// that looks hand-made is not the impression this one wants to give.
		contents: [
			{ x: 130, y: 220, type: 'file' },
			{ x: 410, y: 220, type: 'link', path: '/Applications' }
		]
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
