import { defineConfig } from 'vitest/config';

/**
 * The root suite covers the application only.
 *
 * `spike/` is a separate package with its own dependencies and its own lockfile
 * (§10.2 — reference code, never shipped). Letting the root runner pick up its
 * tests means one command silently exercises two dependency trees, which fails
 * in confusing ways the moment they diverge. CI runs the two suites as separate
 * jobs instead.
 */
export default defineConfig({
	// The renderer is built with `"jsx": "react-jsx"`, so the test runner has to
	// use the same automatic runtime. Left on the default classic transform, JSX
	// in a test compiles to `React.createElement` against a `React` that nothing
	// imports, and every case fails with "React is not defined".
	esbuild: { jsx: 'automatic' },
	test: {
		// `.tsx` as well as `.ts`: a screen test has to contain JSX, and the
		// narrower pattern did not fail loudly — vitest reported "no test files
		// found" for that one path and the full run simply never included it,
		// which is how a test file sits in the tree passing nothing.
		include: ['tests/**/*.test.{ts,tsx}'],
		exclude: ['**/node_modules/**', 'spike/**', 'out/**']
	}
});
