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
	test: {
		include: ['tests/**/*.test.ts'],
		exclude: ['**/node_modules/**', 'spike/**', 'out/**']
	}
});
