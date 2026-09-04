/**
 * Types for the packaging configuration, so a test can import it rather than
 * parse it.
 *
 * `tests/builder-exclusions.test.ts` used to pull the `files` entries out of the
 * source text by pairing single quotes. An apostrophe in a comment swallowed
 * every entry between it and the next one, and stripping comments first with a
 * regular expression was worse: `/*` inside a glob opens a comment that runs to
 * the next `*` `/` anywhere in the file. What electron-builder acts on is the
 * array, so the array is what the test reads.
 */
declare const config: {
	files?: unknown[];
	productName?: string;
	win?: {
		signAndEditExecutable?: boolean;
		signExecutable?: boolean;
		[key: string]: unknown;
	};
	appx?: {
		customManifestPath?: string;
		customExtensionsPath?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};
export default config;
