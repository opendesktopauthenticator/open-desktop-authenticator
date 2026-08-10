import { defineConfig } from 'vitest/config';

/**
 * The spike's own runner config.
 *
 * **Its existence is the point.** Without a config here, vitest walks up the
 * directory tree, finds the application's `vitest.config.mts`, and tries to load
 * it — which imports `vitest/config` from the *root* `node_modules`. That
 * happens to work on a developer machine, where the root has already been
 * installed, and fails on a clean checkout where CI installs only this package:
 *
 *     Cannot find package 'vitest' imported from .../vitest.config.mts
 *
 * The spike is a separate package with its own lockfile (§10.2). It has to be
 * runnable knowing nothing about its parent, and this file is what makes that
 * true rather than accidental.
 */
export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		exclude: ['**/node_modules/**', 'dist/**']
	}
});
