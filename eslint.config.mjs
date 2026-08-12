import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Lint config (§9.1).
 *
 * Beyond ordinary correctness rules, this file mechanically enforces the process
 * boundaries from §11. Those boundaries are the kind of thing that erodes under
 * feature pressure — someone imports `electron` into a renderer component to get
 * one value, and the isolation is gone. A reviewer might catch it. A lint rule
 * always does.
 */
export default tseslint.config(
	{
		// Only generated output is ignored. `site/assets/*.js` was in this list for
		// a while, which meant the one script the public actually executes — the
		// upload and clipboard code — was the single unlinted file in the project.
		// It has its own block below instead.
		ignores: ['out/**', 'dist/**', 'site/dist/**', 'node_modules/**', 'spike/**', 'coverage/**']
	},

	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,

	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			// Unused code is either a mistake or a leftover; both want deleting.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			// `any` defeats the point of strict mode at exactly the boundaries that
			// matter most (IPC payloads, parsed files).
			'@typescript-eslint/no-explicit-any': 'error',
			'no-console': 'off'
		}
	},

	// ── Main process, preload, shared ─────────────────────────────────────────
	{
		files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
		languageOptions: {
			globals: globals.node
		}
	},

	// ── Preload: the tightest boundary in the app ─────────────────────────────
	{
		files: ['src/preload/**/*.ts'],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['node:*', 'fs', 'path', 'child_process', 'os'],
							message:
								'The preload runs sandboxed and must expose no Node surface to the renderer (§11 S6).'
						},
						{
							group: ['**/shared/ipc', '../shared/ipc'],
							// Type imports are erased at compile time and are safe.
							allowTypeImports: true,
							message:
								'shared/ipc imports zod, which a sandboxed preload cannot require — the bridge ' +
								'would die silently. Import channel values from shared/channels instead.'
						}
					]
				}
			]
		}
	},

	// ── Renderer: no Node, no Electron, no direct network ─────────────────────
	{
		files: ['src/renderer/**/*.{ts,tsx}'],
		languageOptions: {
			globals: globals.browser
		},
		plugins: { 'react-hooks': reactHooks },
		rules: {
			...reactHooks.configs.recommended.rules,
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['electron', 'electron/**'],
							message:
								'The renderer has no Electron access. Everything crosses the contextBridge (§11 S6).'
						},
						{
							group: ['node:*', 'fs', 'path', 'child_process', 'os', 'crypto'],
							message: 'The renderer has no Node access (§11 S6).'
						},
						{
							group: ['**/main/**'],
							message:
								'The renderer must not reach into main-process code. Use the IPC contract (§11 S6).'
						}
					]
				}
			],
			// The renderer holds no persistent state at all (§9.2).
			'no-restricted-globals': [
				'error',
				{ name: 'localStorage', message: 'The renderer holds no persistent state (§9.2).' },
				{ name: 'sessionStorage', message: 'The renderer holds no persistent state (§9.2).' },
				{ name: 'indexedDB', message: 'The renderer holds no persistent state (§9.2).' },
				{ name: 'fetch', message: 'All network traffic originates in the main process (§11 S5).' }
			],
			'no-restricted-syntax': [
				'error',
				{
					selector: "NewExpression[callee.name='XMLHttpRequest']",
					message: 'All network traffic originates in the main process (§11 S5).'
				},
				{
					selector: "NewExpression[callee.name='WebSocket']",
					message: 'All network traffic originates in the main process (§11 S5).'
				}
			]
		}
	},

	// ── Tests ─────────────────────────────────────────────────────────────────
	{
		files: ['tests/**/*.ts'],
		languageOptions: { globals: globals.node },
		rules: {
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-empty-function': 'off'
		}
	},

	// Config files run in Node and are not part of the app graph.
	{
		files: ['*.mts', '*.ts'],
		languageOptions: { globals: globals.node }
	},

	// `.mjs` config files are not in any tsconfig project, so type-aware rules
	// have nothing to work from. Lint them syntactically instead of excluding
	// them, which would leave them unchecked entirely.
	{
		files: ['**/*.mjs'],
		// disableTypeChecked carries its own languageOptions, so it must be spread
		// FIRST — spreading it after silently discarded the Node globals below and
		// every `process`/`console` became an undefined-variable error.
		...tseslint.configs.disableTypeChecked,
		languageOptions: {
			// Merge, not replace: disableTypeChecked's own parserOptions are what
			// detach these files from the TS project service. Overwriting the whole
			// block reattached them and every .mjs became "not found by the project".
			...tseslint.configs.disableTypeChecked.languageOptions,
			globals: globals.node
		}
	},

	/*
	 * The site's browser script.
	 *
	 * Ships to the public as-is rather than through the TypeScript build, so it is
	 * in no tsconfig project and the type-aware rules have nothing to work from —
	 * the same situation as the `.mjs` files above, and handled the same way
	 * rather than by excluding it. This is the only code on the domain that a
	 * visitor's browser executes; leaving it unchecked was the wrong trade.
	 */
	{
		files: ['site/assets/**/*.js'],
		...tseslint.configs.disableTypeChecked,
		languageOptions: {
			...tseslint.configs.disableTypeChecked.languageOptions,
			globals: globals.browser,
			ecmaVersion: 2022,
			sourceType: 'script'
		},
		rules: {
			// Merged, not replaced. `disableTypeChecked` carries its own `rules` that
			// switch the type-aware rules off; defining a fresh object here discarded
			// them and eslint then crashed trying to run `await-thenable` with no type
			// information — the same ordering trap the .mjs block above documents.
			...tseslint.configs.disableTypeChecked.rules,
			// It runs on other people's machines with no build step and no
			// transpilation, so the browser APIs it uses are the ones it gets.
			'no-console': 'error'
		}
	},

	// Must stay last: turns off everything Prettier owns.
	prettier
);
