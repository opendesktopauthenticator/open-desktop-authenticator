import {
	app,
	BrowserWindow,
	type Tray,
	clipboard as electronClipboard,
	Menu,
	net,
	powerMonitor,
	session
} from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { branding } from '../shared/branding';
import { isAllowedNavigation, type NavigationTarget } from '../shared/security-policy';
import { setTrustedSender } from './ipc/router';
import { registerAppInfoHandler } from './app-info';
import { VaultService } from './vault/service';
import { registerVaultHandlers, RevocationCeremony } from './vault/ipc';
import { ImportService } from './import/service';
import { registerImportHandlers } from './import/ipc';
import { CodeService } from './codes/service';
import { ClipboardCourier } from './codes/clipboard';
import { registerCodeHandlers } from './codes/ipc';
import { registerUpdateHandlers } from './update/ipc';
import { SteamTransportFactory, type ElectronNetworking } from './net/transport';
import { ConfirmationsService } from './confirmations/service';
import { AutoConfirmEngine } from './confirmations/auto';
import { ActivityLog } from './confirmations/activity';
import { createTray } from './tray';
import { registerConfirmationHandlers } from './confirmations/ipc';
import { SteamClock } from './steam/clock';
import {
	applyContentSecurityPolicy,
	denyAllPermissions,
	hardenAllWebContents,
	hardenApp,
	SECURE_WEB_PREFERENCES
} from './security';

/**
 * Main process entry point.
 *
 * Everything security-relevant happens before the first window is shown, and the
 * posture itself lives in `security.ts` so it can be reviewed and tested as one
 * unit rather than read out of scattered BrowserWindow options.
 */

const isDev = !app.isPackaged;
/** electron-vite sets this in dev; undefined in a packaged build. */
const devServerUrl = process.env.ELECTRON_RENDERER_URL;

/** Where the renderer legitimately lives. One definition, used for both the
 * navigation lock and the IPC sender check. */
const rendererTarget: NavigationTarget =
	isDev && devServerUrl
		? { kind: 'origin', origin: new URL(devServerUrl).origin }
		: // Pinned to the exact file: every file: URL shares the origin "null", so an
			// origin comparison here would allow navigation to any local file.
			{ kind: 'file', href: pathToFileURL(join(__dirname, '../renderer/index.html')).href };

function createMainWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1000,
		height: 700,
		minWidth: 800,
		minHeight: 600,
		show: false,
		title: branding.productName,
		autoHideMenuBar: true,
		webPreferences: {
			...SECURE_WEB_PREFERENCES,
			// The only deliberate relaxation, and only when not packaged.
			devTools: isDev,
			preload: join(__dirname, '../preload/index.js')
		}
	});

	// Show only once painted, so the user never sees an empty frame.
	window.once('ready-to-show', () => window.show());

	// No per-window hardening call here: `hardenAllWebContents` already covers
	// this window via `web-contents-created`, and doing both attached every
	// listener twice.

	if (isDev && devServerUrl) {
		void window.loadURL(devServerUrl);
	} else {
		void window.loadFile(join(__dirname, '../renderer/index.html'));
	}

	return window;
}

function start(): void {
	// Early return, not just app.quit(): quit() does not stop this tick, so a
	// second instance would otherwise go on to register handlers and open a
	// window alongside the one already running.
	if (!hardenApp()) {
		return;
	}

	// Windows identifies an application by its AppUserModelID, not by its window
	// title or executable name. Without this, `branding.appId` exists only as a
	// string in a config file: taskbar pinning breaks, the app groups under a
	// generic "Electron" identity, and anything shell-facing points at the wrong
	// place. It has to be set before any window is created.
	if (process.platform === 'win32') {
		app.setAppUserModelId(branding.appId);
	}

	// Every WebContents, not just the windows we build ourselves.
	hardenAllWebContents(rendererTarget);

	// Electron's default menu carries a Toggle Developer Tools accelerator that
	// works even with the bar hidden. Removing the menu entirely — together with
	// `devTools: false` — closes the "paste this in the console" vector.
	if (!isDev) {
		Menu.setApplicationMenu(null);
	}

	// Only our own renderer may call IPC. Reuses the navigation predicate, so the
	// definition of "us" cannot drift between the two checks.
	setTrustedSender((frameUrl) =>
		isAllowedNavigation(frameUrl, rendererTarget, {
			caseInsensitivePaths: process.platform === 'win32'
		})
	);

	// The lock handler below refers to `imports` and `clipboard`, both constructed
	// after the vault they need. That is fine and not a cycle: the references live
	// inside a closure that cannot run until all three exist.
	const vault = new VaultService({
		file: join(app.getPath('userData'), 'vault.json'),
		onLock: () => {
			// Staged maFile secrets do not outlive the unlocked session. A lock means
			// the user has stopped being present — by choice, by idling, or by
			// shutting the lid — and half-finished import material sitting in memory
			// past that point has no owner watching it.
			imports.discard();

			// A Steam Guard code must not survive on the clipboard past the session
			// that produced it — but only if it is still ours to remove.
			clipboard.clearIfOurs();

			// Cached Steam access tokens are live credentials, and the pending list
			// is what makes acting on a confirmation possible. Neither outlives the
			// unlock that produced it.
			confirmations.forget();

			// And the cookie jars with them. Steam sets cookies on its responses;
			// Chromium keeps them in the per-account session, and a web session that
			// survived the lock would make the lock a smaller thing than it claims.
			transports.forgetAll();

			// The backup ceremony is per sitting: an unlock has to show the code
			// again before it can be marked as written down.
			ceremony.forget();

			// Nothing gets approved on behalf of somebody who is not there. A lock
			// is the clearest statement available that they are not.
			autoConfirm.stop();

			// Reload the renderer on every lock, so the passphrase is always typed
			// into a FRESH page.
			//
			// The renderer displays attacker-influenced text once unlocked — Steam
			// item names, counterparties, confirmation descriptions. If a re-unlock
			// after auto-lock happened in that same document, script injected via
			// that content could capture the passphrase and turn a bounded session
			// compromise into permanent access to the vault file.
			//
			// A reload destroys the document and everything injected into it, so
			// passphrase entry always happens somewhere that has never rendered
			// anything but our own bundle.
			for (const window of BrowserWindow.getAllWindows()) {
				window.webContents.reload();
			}
		}
	});

	const codes = new CodeService(vault);
	const clipboard = new ClipboardCourier({ clipboard: electronClipboard });

	// The adapter is here rather than inside `net/transport.ts` so that module
	// stays free of `electron` and testable without launching an app.
	const networking: ElectronNetworking = {
		// **No cast here, and that is the point.** `ProxyCapableSession` used to
		// declare a `login` event that Electron's `Session` has never had, and an
		// `as unknown as` cast was what stopped the compiler from saying so — proxy
		// credentials went to an event that never fired. With the interface
		// describing only what a real `Session` actually provides, assignment now
		// type-checks on its own, so the compiler verifies the claim this line makes
		// instead of being told to accept it. If a future edit needs the cast back,
		// that is the signal the interface has drifted from Electron again.
		sessionFromPartition: (partition, options) => session.fromPartition(partition, options),
		request: ({ url, method, session: accountSession }) =>
			net.request({ url, method, session: accountSession as unknown as Electron.Session })
	};
	const transports = new SteamTransportFactory(networking);
	const ceremony = new RevocationCeremony();
	// Shares the codes' notion of Steam's time, so a confirmation and a code can
	// never disagree about what "now" is.
	const confirmations = new ConfirmationsService(vault, transports, {
		timeOffsetSeconds: () => codes.timeOffsetSeconds()
	});
	const clock = new SteamClock({ codes, vault, transports });

	const dropAccountRouting = (steamId64: string): void => {
		// Routing changed, so everything tied to the old route goes: the cookie
		// jar, and the cached access token. The stored refresh token is discarded
		// inside the same vault write (settings path) or left alone (import only
		// changes the proxy URL).
		transports.forget(steamId64);
		confirmations.forgetAccount(steamId64);
	};

	// Constructed after the network pieces so a commit that changes routing can
	// drop the stale session through the same seam the settings path uses.
	const imports = new ImportService(vault, { onRoutingChanged: dropAccountRouting });

	const activity = new ActivityLog();
	// The engine used to report into callbacks nobody supplied, so a held-back
	// account-recovery confirmation — the loudest warning this app can raise — was
	// computed and thrown away. These are where it lands.
	const autoConfirm = new AutoConfirmEngine({
		vault,
		confirmations,
		onOutcome: (steamId64, outcome) =>
			activity.recordPass(steamId64, outcome.approved, outcome.held),
		onFailure: (steamId64, reason) => activity.recordFailure(steamId64, reason)
	});

	/** Set only by the tray's Quit item, so `close` knows to stop hiding. */
	let quitting = false;
	/** Held so it is not collected; a garbage-collected Tray disappears. */
	let tray: Tray | undefined;

	void app.whenReady().then(() => {
		applyContentSecurityPolicy(
			session.defaultSession,
			isDev,
			devServerUrl ? new URL(devServerUrl).origin : undefined
		);
		denyAllPermissions(session.defaultSession);

		registerAppInfoHandler();
		registerVaultHandlers(
			vault,
			dropAccountRouting,
			ceremony,
			async () => {
				await clock.ensureSynced();
				// Started only once a vault is open. Before that there is nothing to
				// poll for and nobody to poll on behalf of.
				autoConfirm.start();
			},
			(steamId64) => autoConfirm.reset(steamId64),
			// So the account list can say what is actually known about each
			// account's egress rather than only what was configured for it.
			(steamId64) => transports.routingStatus(steamId64)
		);
		registerImportHandlers(imports);
		registerCodeHandlers(codes, vault, clipboard, clock);
		registerUpdateHandlers({
			// Read at call time, not captured: a vault that is locked has no settings
			// to consult, and "locked" is not consent to make a network request.
			isEnabled: () => vault.isUnlocked() && vault.settings().updateCheck,
			currentVersion: app.getVersion(),
			// Electron's own stack rather than `fetch`, so this obeys the same
			// proxy/network configuration as the rest of the process — and so the one
			// non-Steam request the app makes is not made by a different client than
			// everything else.
			fetchText: async (url) => {
				const response = await net.fetch(url, {
					headers: { Accept: 'application/vnd.github+json', 'User-Agent': branding.binaryName }
				});
				if (!response.ok) {
					throw new Error(`GitHub answered ${response.status}`);
				}
				return response.text();
			}
		});
		registerConfirmationHandlers(confirmations, vault, activity, clock);

		// Polled rather than scheduled: a setTimeout would keep firing on the old
		// timeout after a settings change, and would carry a stale deadline across
		// a machine suspend. One second is far finer than a one-minute minimum.
		const autoLockPoll = setInterval(() => vault.enforceAutoLock(), 1000);
		autoLockPoll.unref();

		app.on('before-quit', () => {
			clearInterval(autoLockPoll);
			autoConfirm.stop();
			// The log outlives a lock on purpose — it is what someone returning
			// wants to read — but not the process.
			activity.clear();
			tray?.destroy();
			// Before locking: the lock handler clears the clipboard too, but quitting
			// may not give a scheduled timer the chance to fire at all.
			clipboard.clearIfOurs();
			vault.lock('shutdown');
		});

		// Lock on suspend and on the OS lock screen (§10.3). Leaving a vault
		// unlocked across a closed lid is the most common way one stays open.
		powerMonitor.on('suspend', () => vault.lock('suspend'));
		powerMonitor.on('lock-screen', () => vault.lock('suspend'));

		const mainWindow = createMainWindow();

		// Closing hides. An authenticator that quits when the window is closed
		// stops producing codes and stops answering confirmations, which is not
		// what anybody means by closing a window — but it must be possible to
		// really quit, which is what `quitting` and the tray's Quit item are for.
		mainWindow.on('close', (event) => {
			if (quitting) {
				return;
			}
			event.preventDefault();
			mainWindow.hide();
		});

		tray = createTray({
			show: () => {
				mainWindow.show();
				mainWindow.focus();
			},
			hide: () => mainWindow.hide(),
			isVisible: () => mainWindow.isVisible(),
			lock: () => vault.lock('manual'),
			isUnlocked: () => vault.isUnlocked(),
			quit: () => {
				quitting = true;
				app.quit();
			}
		});

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createMainWindow();
			}
		});
	});

	// Deliberately NOT quitting here: the window closing is the tray taking over,
	// not the application ending. Quit goes through the tray, which sets
	// `quitting` first so the close handler stands aside.
	app.on('window-all-closed', () => {
		// Left empty on purpose.
	});
}

start();
