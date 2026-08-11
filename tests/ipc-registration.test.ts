import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS, IPC_CONTRACT } from '../src/shared/ipc';
import { registeredChannels, __resetRouterForTests } from '../src/main/ipc/router';
import { registerAppInfoHandler } from '../src/main/app-info';
import { registerVaultHandlers } from '../src/main/vault/ipc';
import { registerImportHandlers } from '../src/main/import/ipc';
import { registerCodeHandlers } from '../src/main/codes/ipc';
import { registerConfirmationHandlers } from '../src/main/confirmations/ipc';
import { registerUpdateHandlers } from '../src/main/update/ipc';
import { registerEnrollmentHandlers } from '../src/main/steam/enrollment-ipc';
import type { EnrollmentService } from '../src/main/steam/enrollment';
import type { ConfirmationsService } from '../src/main/confirmations/service';
import { ActivityLog } from '../src/main/confirmations/activity';
import type { VaultService } from '../src/main/vault/service';
import type { ImportService } from '../src/main/import/service';
import type { CodeService } from '../src/main/codes/service';
import type { ClipboardCourier } from '../src/main/codes/clipboard';

/**
 * Every declared channel has a handler behind it.
 *
 * `shared/ipc.ts` declaring a channel and the main process actually answering it
 * are two different things, and the gap between them fails at runtime with
 * "No handler registered" — in the renderer, in a packaged build, on a screen
 * the user is looking at. The compiler cannot catch it: the contract table and
 * the registration calls have no type relationship.
 *
 * So this walks the contract and asserts each entry was claimed by exactly one
 * registrar. It is also what keeps `registeredChannels()` honest — it was
 * exported for a test like this one and then went unused for a whole milestone.
 */

/** Electron, reduced to the parts registration touches. Hoisted above the imports. */
vi.mock('electron', () => {
	const handlers = new Map<string, unknown>();
	return {
		ipcMain: {
			handle: (channel: string, handler: unknown): Map<string, unknown> =>
				handlers.set(channel, handler),
			removeHandler: (channel: string): boolean => handlers.delete(channel)
		},
		app: { getVersion: (): string => '0.0.0' },
		dialog: {
			showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
				Promise.resolve({ canceled: true, filePaths: [] })
		},
		BrowserWindow: { getFocusedWindow: (): undefined => undefined, getAllWindows: () => [] }
	};
});

/**
 * Registration reads nothing off these — the handlers only touch them once
 * invoked, which the vault and import suites cover directly.
 */
const vault = {} as VaultService;
const imports = {} as ImportService;
const codes = {} as CodeService;
const clipboard = {} as ClipboardCourier;

const confirmations = {} as ConfirmationsService;
const activity = new ActivityLog();
const enrollment = {} as EnrollmentService;

function registerEverything(): void {
	registerAppInfoHandler();
	registerVaultHandlers(vault);
	registerImportHandlers(imports);
	registerCodeHandlers(codes, vault, clipboard);
	registerConfirmationHandlers(confirmations, vault, activity);
	registerUpdateHandlers({
		isEnabled: () => false,
		currentVersion: '0.0.0',
		fetchText: () => Promise.reject(new Error('no network in tests'))
	});
	registerEnrollmentHandlers(enrollment, vault, {
		show: () => Promise.resolve(undefined)
	});
}

beforeEach(() => {
	__resetRouterForTests();
});

describe('IPC registration', () => {
	it('starts empty, so the assertions below are not measuring a previous run', () => {
		expect(registeredChannels().size).toBe(0);
	});

	it('registers a handler for every channel in the contract', () => {
		registerEverything();

		const registered = registeredChannels();
		const missing = Object.values(CHANNELS).filter((channel) => !registered.has(channel));

		expect(missing, 'declared in the contract but no handler answers it').toEqual([]);
	});

	it('registers nothing that is not in the contract', () => {
		registerEverything();

		const declared = new Set<string>(Object.keys(IPC_CONTRACT));
		for (const channel of registeredChannels()) {
			expect(declared.has(channel), `${channel} is registered but not declared`).toBe(true);
		}
	});

	it('detects a registrar that was never called', () => {
		// The check above is only worth having if it fails when it should. Register
		// everything EXCEPT confirmations, which is exactly what forgetting a line
		// in `index.ts` looks like, and confirm the gap is spotted.
		registerAppInfoHandler();
		registerVaultHandlers(vault);
		registerImportHandlers(imports);
		registerCodeHandlers(codes, vault, clipboard);

		const registered = registeredChannels();
		const missing = Object.values(CHANNELS).filter((channel) => !registered.has(channel));

		expect(missing).toEqual([
			CHANNELS.activityList,
			CHANNELS.confirmationsList,
			CHANNELS.confirmationsAct,
			CHANNELS.steamSignIn,
			CHANNELS.updateCheck,
			CHANNELS.enrollBegin,
			CHANNELS.enrollEmailCode,
			CHANNELS.enrollActivate,
			CHANNELS.enrollCancel,
			CHANNELS.accountExport,
			CHANNELS.accountDeactivate,
			CHANNELS.accountRecover
		]);
	});

	it('refuses to register the same channel twice', () => {
		// Two registrars claiming one channel means the second silently wins, and
		// which one that is depends on import order.
		registerAppInfoHandler();
		expect(() => registerAppInfoHandler()).toThrow(/already registered/);
	});
});
