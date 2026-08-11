import {
	app,
	BrowserWindow,
	type Tray,
	clipboard as electronClipboard,
	dialog,
	Menu,
	nativeTheme,
	net,
	powerMonitor,
	session
} from 'electron';
import { readFileSync } from 'node:fs';
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
import { EnrollmentService } from './steam/enrollment';
import { registerEnrollmentHandlers } from './steam/enrollment-ipc';
import { createRecoveryHooks, RECOVERY_EXTENSION } from './vault/recovery';
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

/**
 * The window frame's colours, taken from the renderer's palette.
 *
 * Duplicated here as literals because the main process cannot read the
 * stylesheet, and Electron needs them before the first paint. `--bg` and
 * `--muted` in `app.css` are the source of truth; `tests/window-chrome.test.ts`
 * fails if these two drift apart.
 */
const WINDOW_CHROME = { background: '#070a0e', symbol: '#93a89e' } as const;

/** How long to wait on GitHub before giving up on an update check. */
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

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
		// Painted before the renderer has drawn anything, so a resize or a slow
		// first paint shows the app's own black rather than white.
		backgroundColor: WINDOW_CHROME.background,
		// **Windows only, deliberately.** `hidden` removes the OS title bar and
		// `titleBarOverlay` puts the real minimise/maximise/close buttons back on
		// top of our content in colours we choose — so the bar matches the app
		// instead of sitting above it as a white strip.
		//
		// Linux gets the ordinary frame. There, `hidden` would remove the title bar
		// without supplying an overlay, leaving a window with no close button at
		// all: a far worse outcome than a title bar that does not match.
		...(process.platform === 'win32'
			? {
					titleBarStyle: 'hidden' as const,
					titleBarOverlay: {
						color: WINDOW_CHROME.background,
						symbolColor: WINDOW_CHROME.symbol
					}
				}
			: {}),
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

	// **Also reaches the OS dialogs.** The file pickers this app opens — import,
	// export, recovery — are drawn by Windows, not by us, and defaulted to light
	// against an application that is entirely dark. On Linux, which does not get
	// the overlay, this is also what keeps the ordinary frame from being white.
	nativeTheme.themeSource = 'dark';

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

			// A half-finished enrollment holds a live `LoginSession` and cached
			// MobileApp access tokens — credentials every bit as real as the ones
			// above. `EnrollmentService.forget` was written for this and documented
			// as "called when the vault locks"; it was never actually wired here, so
			// a sign-in waiting on an email code, and the tokens behind it, outlived
			// every lock. Sitting directly under the other teardown calls so the
			// omission is visible next time something is added.
			enrollment.forget();

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
		request: ({ url, method, session: accountSession, redirect }) =>
			net.request({
				url,
				method,
				session: accountSession as unknown as Electron.Session,
				...(redirect === undefined ? {} : { redirect })
			})
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
	// The bookkeeping that lets activation correct the file enrollment wrote lives
	// in `createRecoveryHooks`, not here — the part worth testing is how the two
	// callbacks relate across a restart, and that could not be reached while it was
	// application wiring.
	const recovery = createRecoveryHooks({
		userDataPath: () => app.getPath('userData'),
		seal: (plaintext) => vault.sealForBackup(plaintext)
	});

	const imports = new ImportService(vault, {
		onRoutingChanged: dropAccountRouting,
		// An imported account gets the same safety net an enrolled one does. Only
		// enrollment wrote a recovery file, so importing a maFile and later deleting
		// it left the account with none — and those are the accounts most likely to
		// be removed and then wanted back.
		onAccountStored: recovery.writeRecovery
	});

	const enrollment = new EnrollmentService(vault, transports, {
		timeOffsetSeconds: () => codes.timeOffsetSeconds(),
		// Written once, at enrollment, into the app's own data directory. Removal
		// deliberately does not delete it — recovering from that removal is the
		// whole reason it exists.
		// Written once, at enrollment; corrected once, at activation.
		writeRecovery: recovery.writeRecovery,
		updateRecovery: recovery.updateRecovery
	});

	const activity = new ActivityLog();
	// The engine used to report into callbacks nobody supplied, so a held-back
	// account-recovery confirmation — the loudest warning this app can raise — was
	// computed and thrown away. These are where it lands.
	const autoConfirm = new AutoConfirmEngine({
		vault,
		confirmations,
		onOutcome: (steamId64, outcome) =>
			activity.recordPass(steamId64, outcome.approved, outcome.held),
		onFailure: (steamId64, reason, halted) => activity.recordFailure(steamId64, reason, halted)
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
			() => {
				// **Not awaited.** This callback runs inside the `vault:unlock` handler,
				// before it returns, so awaiting the clock sync put a Steam round trip —
				// with a thirty-second transport timeout behind it — between pressing
				// Unlock and the screen changing. Offline, or with a dead proxy, that is
				// half a minute of "Unlocking…" with nothing to press.
				//
				// Nothing is lost by starting it here and letting it finish on its own:
				// `ensureSynced` shares one in-flight promise, and the code and
				// confirmation handlers already await it before they answer. So the
				// first request that genuinely needs the offset still waits for it, and
				// unlocking does not.
				void clock.ensureSynced();

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
		registerEnrollmentHandlers(
			enrollment,
			vault,
			{
				// The OS dialog is the only thing that names a location. The renderer
				// asks for a file; it never says, and is never told, where it went.
				show: async (suggestedName) => {
					const parent = BrowserWindow.getFocusedWindow();
					const options = {
						title: 'Save maFile',
						defaultPath: suggestedName,
						filters: [{ name: 'maFile', extensions: ['maFile'] }]
					};
					const result = await (parent
						? dialog.showSaveDialog(parent, options)
						: dialog.showSaveDialog(options));
					return result.canceled ? undefined : result.filePath;
				}
			},
			dropAccountRouting,
			{
				// The picker is the only thing that names a file, exactly as import.
				// The contents come back, never the path.
				pick: async () => {
					const parent = BrowserWindow.getFocusedWindow();
					const options = {
						title: 'Open a recovery file',
						properties: ['openFile' as const],
						filters: [{ name: 'Recovery file', extensions: [RECOVERY_EXTENSION.replace('.', '')] }]
					};
					const result = await (parent
						? dialog.showOpenDialog(parent, options)
						: dialog.showOpenDialog(options));
					const chosen = result.canceled ? undefined : result.filePaths[0];
					return chosen === undefined ? undefined : readFileSync(chosen, 'utf8');
				}
			}
		);
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
					headers: { Accept: 'application/vnd.github+json', 'User-Agent': branding.binaryName },
					// Bounded, like every Steam request is. Without it a GitHub connection
					// that hangs leaves this handler unresolved for as long as the socket
					// stays open — a leak rather than a stall, since the renderer fires
					// this and forgets it, but there is no reason to hold either.
					signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
					// The URL is derived from `branding.repository` and pinned to
					// api.github.com. Following a redirect would let whatever answers
					// that name send us somewhere else, and the only thing checked
					// afterwards is the shape of the JSON that comes back.
					redirect: 'error'
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
		/**
		 * Said once, the first time the window disappears.
		 *
		 * Hiding to the tray is only safe if the user can find it again, and on
		 * Windows 11 a tray icon a machine has not seen before goes straight into
		 * the hidden overflow behind the chevron. From the user's side the
		 * application simply vanished — and this one is still holding their
		 * authenticator, so "did it quit?" is a genuinely alarming question.
		 *
		 * Once per run, not once per close: a balloon on every close is nagging.
		 */
		let toldAboutTray = false;

		/**
		 * Bring the existing window back when the app is launched a second time.
		 *
		 * `hardenApp` takes the single-instance lock and quits the loser, which
		 * Electron's own documentation pairs with this handler — and without it the
		 * two behaviours combine badly. Closing the window hides to the tray, so
		 * launching again from a shortcut starts a process that silently exits and
		 * leaves the first one hidden: the application appears not to start at all,
		 * while it is still running and holding the vault.
		 *
		 * The tray balloon does not cover this. It fires once per run, so on the
		 * second and every later attempt there is no explanation of any kind.
		 */
		/**
		 * The one way back to the window, shared by everything that offers one.
		 *
		 * The tray click, the tray menu and a second launch all mean "put it back in
		 * front of me", and they were drifting: this one restores a minimised window
		 * and the tray's did not, so the same intent behaved differently depending
		 * on which control the user reached for. Two places that have to agree are
		 * the shape of bug worth removing rather than keeping in step by hand.
		 *
		 * Looked up rather than closed over, because `activate` can replace the
		 * window and a handler holding a destroyed reference would silently do
		 * nothing.
		 */
		/**
		 * The window as it is now, which is not necessarily the one created above.
		 *
		 * Every tray control has to agree about which window it is talking about.
		 * Making only `show` resolve this while `hide` and `isVisible` closed over
		 * the original left the menu deciding its label from one window and acting
		 * on another — the same "two things that must agree" shape the shared
		 * `showMainWindow` was introduced to remove, reintroduced by introducing it.
		 */
		const liveWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0];

		const showMainWindow = (): void => {
			const window = liveWindow();
			if (!window) {
				createMainWindow();
				return;
			}
			if (window.isMinimized()) {
				window.restore();
			}
			window.show();
			window.focus();
		};

		app.on('second-instance', showMainWindow);

		mainWindow.on('close', (event) => {
			if (quitting) {
				return;
			}
			event.preventDefault();
			mainWindow.hide();

			if (!toldAboutTray) {
				toldAboutTray = true;
				tray?.displayBalloon?.({
					title: `${branding.shortName} is still running`,
					content:
						'Closing the window keeps your codes and confirmations working. Find it in the ' +
						'system tray — on Windows you may need the arrow next to the clock to show ' +
						'hidden icons. Quit properly from the tray menu.'
				});
			}
		});

		tray = createTray({
			show: showMainWindow,
			hide: () => liveWindow()?.hide(),
			// No window is not visible. Answering from a destroyed one would throw,
			// and taking the whole tray menu down with it.
			isVisible: () => liveWindow()?.isVisible() ?? false,
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
