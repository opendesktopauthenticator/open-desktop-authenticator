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
		// Real shell, scrypt and loopback-socket fixtures share this suite. Keep
		// their concurrency bounded instead of scaling subprocess/KDF pressure to
		// every logical core on a large local or hosted runner.
		maxWorkers: 4,
		/*
		 * **Vitest's default is five seconds, and this suite earns more.**
		 *
		 * The line above says why: the cases that cost anything derive a key with
		 * scrypt, and four of them do it twice because a passphrase rotation writes
		 * a vault and a backup. Measured locally they run 1.1-2.0 s. On a hosted
		 * windows runner the same four spent longer than five seconds and the
		 * release gate failed on `vault-rotation-journal` and
		 * `vault-rotation-both-writes-fail` — not on an assertion, on the clock.
		 *
		 * This is the second time the default has cost a green run. The comment at
		 * the top of `tests/steam-login.test.ts` records the first: a ~600 ms cold
		 * import "charged against vitest's five-second default", losing "under a
		 * full parallel run". That was fixed by hoisting the import, which works
		 * when the cost is setup and not when the cost is the test.
		 *
		 * Twenty seconds is roughly ten times the slowest real case, so a test that
		 * has genuinely hung still fails, and fails well inside the ~47 s the whole
		 * suite takes. A test needing less says so with its own third argument.
		 */
		testTimeout: 20_000,
		// `.tsx` as well as `.ts`: a screen test has to contain JSX, and the
		// narrower pattern did not fail loudly — vitest reported "no test files
		// found" for that one path and the full run simply never included it,
		// which is how a test file sits in the tree passing nothing.
		include: ['tests/**/*.test.{ts,tsx}'],
		exclude: ['**/node_modules/**', 'spike/**', 'out/**']
	}
});
