import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, 'src/main/index.ts') }
			}
		}
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, 'src/preload/index.ts'),
					/*
					 * The in-app browser's own chrome — the back, forward, reload and
					 * address strip above the page.
					 *
					 * A second entry rather than a branch inside the first: these two
					 * preloads face different things. `index` bridges the application's
					 * renderer to the vault; this one bridges a toolbar to one window's
					 * navigation and nothing else, and they must not be able to grow
					 * into each other by accident.
					 */
					'browser-chrome': resolve(__dirname, 'src/preload/browser-chrome.ts')
				}
			}
		}
	},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		plugins: [react()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, 'src/renderer/index.html') }
			}
		},
		resolve: {
			alias: {
				'@shared': resolve(__dirname, 'src/shared')
			}
		}
	}
});
