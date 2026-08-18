import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	AccountSummary,
	CodesList,
	RendererApi,
	UpdateCheckResult,
	VaultStatus
} from '../shared/ipc';
import { CreateVault } from './screens/CreateVault';
import { AccountRouting } from './screens/AccountRouting';
import { Activity } from './screens/Activity';
import { AutoConfirm } from './screens/AutoConfirm';
import { Confirmations } from './screens/Confirmations';
import { RemoveAccount } from './screens/RemoveAccount';
import { About } from './screens/About';
import { Settings } from './screens/Settings';
import { ImportAccounts } from './screens/ImportAccounts';
import { RecoverAccount } from './screens/RecoverAccount';
import { AddAuthenticator } from './screens/AddAuthenticator';
import { MoveAuthenticator } from './screens/MoveAuthenticator';
import { RevocationBackup } from './screens/RevocationBackup';
import { UnlockVault } from './screens/UnlockVault';
import { VaultHome } from './screens/VaultHome';

declare global {
	interface Window {
		/**
		 * Optional on purpose. If the preload script fails — the classic cause is
		 * importing something a sandboxed preload cannot `require` — the bridge is
		 * never exposed and this is `undefined`. Typing it as always-present makes
		 * the compiler agree with a lie, and the app white-screens on a synchronous
		 * TypeError that no `.catch()` can see.
		 */
		api?: RendererApi;
	}
}

/** How often to refresh status, which also drives the auto-lock countdown. */
const STATUS_POLL_MS = 1000;
/** Activity is reported at most this often; a ping per keystroke is pointless. */
const TOUCH_THROTTLE_MS = 15_000;

export function App(): React.JSX.Element {
	const api = window.api;

	const [status, setStatus] = useState<VaultStatus | undefined>();
	const [accounts, setAccounts] = useState<AccountSummary[]>([]);
	const [codes, setCodes] = useState<CodesList | undefined>();
	/** Whether automatic confirmation has left something a person must look at. */
	const [activityUrgent, setActivityUrgent] = useState(false);
	/**
	 * Which unlocked screen is showing. Not persisted anywhere: the main process
	 * reloads this window whenever the vault locks, so an unlock always lands back
	 * on the account list rather than resuming a half-finished import.
	 */
	const [view, setView] = useState<
		'accounts' | 'import' | 'settings' | 'activity' | 'enroll' | 'move' | 'recover' | 'about'
	>('accounts');
	/**
	 * An enrolled-but-unactivated account being resumed, if any.
	 *
	 * Kept here rather than inside the enrollment screen so that leaving it — to
	 * write the revocation code down, which the screen instructs — does not
	 * destroy the only route back to finishing.
	 */
	const [resumeEnrollment, setResumeEnrollment] = useState<AccountSummary | undefined>();
	/**
	 * The account whose backup ceremony is open, if any.
	 *
	 * Only the two fields the ceremony actually needs, rather than a full
	 * `AccountSummary`. Requiring the whole summary is what forced a lookup in the
	 * polled `accounts` list, and made the post-enrollment hand-off depend on a
	 * refresh that had not happened yet.
	 */
	const [backupFor, setBackupFor] = useState<
		{ steamId64: string; accountName: string } | undefined
	>();
	/** The account whose routing is being changed, if any. */
	const [routingFor, setRoutingFor] = useState<AccountSummary | undefined>();
	/** The account whose confirmations are open, if any. */
	const [confirmingFor, setConfirmingFor] = useState<AccountSummary | undefined>();
	/** The account being removed, if any. */
	const [removingFor, setRemovingFor] = useState<AccountSummary | undefined>();
	/** The account whose automatic-confirmation settings are open, if any. */
	const [autoConfirmFor, setAutoConfirmFor] = useState<AccountSummary | undefined>();
	/**
	 * Unrecoverable, and only ever one thing: the bridge to the main process does
	 * not exist, so no screen in this app can function.
	 */
	const fatal = api
		? undefined
		: 'The preload bridge did not load, so this window has no way to reach the main ' +
			'process. This is a build problem, not a configuration one — check that the preload ' +
			'bundle requires nothing but "electron".';

	/**
	 * A poll that failed. Deliberately **not** fatal.
	 *
	 * These are transient by nature — the vault can lock between the status check
	 * and the calls that follow it, and from 0.2 the same loop will touch the
	 * network. Treating one rejected promise as terminal replaced the entire
	 * window with an error screen that nothing could clear, so a moment's
	 * unluckiness needed an application restart. It is shown as a banner over the
	 * live UI instead, and it disappears on the next tick that works.
	 */
	const [pollError, setPollError] = useState<string | undefined>();
	/** Set from app info once the bridge answers. False until then, which is the
	 * safe default: it shows the toggle rather than hiding a real control. */
	const [installedFromStore, setInstalledFromStore] = useState(false);

	/** Latest answer from the update check. Only `updateAvailable` is ever shown. */
	const [update, setUpdate] = useState<UpdateCheckResult | undefined>();

	/**
	 * @param includeCodes fetch Steam Guard codes as well as status and accounts.
	 *
	 * Codes are separable because they are the only slow part: `listCodes` waits on
	 * the Steam clock sync, which on a first call can take a full transport
	 * timeout. Everything else here is local and immediate.
	 *
	 * That mattered on unlock. The unlock screen only stops saying "Unlocking…"
	 * when it unmounts, and it only unmounted once this whole call had finished —
	 * so a slow clock sync read as a stuck unlock for tens of seconds, on the one
	 * screen where the user is already wondering whether they typed it right.
	 *
	 * Accounts are **not** separable in the same way, and that is deliberate:
	 * swapping to the account list before they arrive would show "No accounts yet"
	 * to somebody who has accounts. A moment of a wrong empty state is worse than a
	 * moment of a spinner.
	 */
	const refresh = useCallback(
		async ({ includeCodes = true }: { includeCodes?: boolean } = {}): Promise<void> => {
			if (!api) {
				return;
			}
			const next = await api.getVaultStatus();
			setStatus(next);
			if (!next.unlocked) {
				setAccounts([]);
				// Not merely stale — codes are only meaningful while unlocked, and a
				// locked window must not still be showing the last ones it had.
				setCodes(undefined);
				setActivityUrgent(false);
				return;
			}
			setAccounts((await api.listAccounts()).accounts);
			// Before the early return. The activity log is in memory and costs
			// nothing, and it survives a lock — so skipping it on the unlock path
			// meant an account that had been held back, or an engine that had given
			// up, showed no alert until the next poll on the one screen the user is
			// looking at hardest.
			setActivityUrgent((await api.listActivity()).urgent);
			if (!includeCodes) {
				return;
			}
			// Regenerated on every tick rather than cached until the window rolls over.
			// A code is an HMAC over twenty bytes; recomputing one per second per
			// account costs nothing, and it removes an entire class of bug where the
			// displayed code and its countdown disagree about which window they are in.
			setCodes(await api.listCodes());
		},
		[api]
	);

	// The window title comes from branding, never from HTML — one source of truth
	// while Q1 is unresolved. It doubles as the end-to-end IPC signal: if the
	// title stays "Loading…", the bridge did not complete a round trip.
	useEffect(() => {
		if (!api) {
			return;
		}
		api
			.getAppInfo()
			.then((info) => {
				document.title = info.productName;
				// Which Windows channel installed this. Settings needs it because the
				// update toggle is inert in a Store build, and showing a switch that
				// cannot do anything is the thing this screen already refuses to do
				// for the unimplemented vault options.
				setInstalledFromStore(info.installedFromStore);
			})
			.catch(() => {
				// Status polling below surfaces a broken bridge properly; a failed
				// title is not worth a second error path.
			});
	}, [api]);

	// Poll rather than push. The vault can lock without the renderer doing
	// anything — idle timeout, machine suspend — so the UI has to notice on its
	// own rather than wait to be told.
	useEffect(() => {
		if (!api) {
			return;
		}
		let cancelled = false;
		/**
		 * Whether the previous tick is still running.
		 *
		 * The interval fires every second whether or not the last one finished, and
		 * `refresh` makes four IPC calls in sequence — one of which, `listCodes`,
		 * waits on the Steam clock sync and can take a full transport timeout. So a
		 * single slow sync used to start a new chain every second while the old ones
		 * were still going: dozens of overlapping requests, all racing to `setState`,
		 * with the oldest and stalest able to land last.
		 *
		 * Skipping a tick costs nothing. The next one is a second away, and the state
		 * it would have fetched is the state the in-flight call is already fetching.
		 */
		let inFlight = false;
		const tick = (): void => {
			if (inFlight) {
				return;
			}
			inFlight = true;
			refresh()
				.then(() => {
					if (!cancelled) {
						setPollError(undefined);
					}
				})
				.catch((err: unknown) => {
					if (!cancelled) {
						setPollError(err instanceof Error ? err.message : String(err));
					}
				})
				.finally(() => {
					inFlight = false;
				});
		};
		tick();
		const timer = setInterval(tick, STATUS_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [api, refresh]);

	// Report real interaction so the idle timer measures idleness rather than
	// wall-clock time. Throttled: the point is "someone is here", not a precise
	// event count.
	const lastTouch = useRef(0);
	useEffect(() => {
		if (!api || !status?.unlocked) {
			return;
		}
		const onActivity = (): void => {
			const now = Date.now();
			if (now - lastTouch.current < TOUCH_THROTTLE_MS) {
				return;
			}
			lastTouch.current = now;
			void api.touchVault();
		};
		const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel'];
		events.forEach((name) => window.addEventListener(name, onActivity, { passive: true }));
		return () => events.forEach((name) => window.removeEventListener(name, onActivity));
	}, [api, status?.unlocked]);

	/**
	 * Ask once per unlock, not on a timer.
	 *
	 * The main process caches the answer for hours, so this is cheap — but asking
	 * on a schedule would make the app chatty for no benefit. An update that
	 * lands while somebody is mid-session can wait until the next unlock.
	 */
	useEffect(() => {
		if (!api || !status?.unlocked) {
			return;
		}
		// Never `.catch(setFatal)`. A failed update check is background work the
		// user did not ask for, and it must not be able to replace the screen they
		// are using — the handler already reports failure as a value.
		api
			.checkForUpdate()
			.then((result) => setUpdate(result))
			.catch(() => undefined);
	}, [api, status?.unlocked]);

	if (fatal || !api) {
		return (
			<main className="shell">
				<h1>Something is wrong</h1>
				<p className="error">{fatal}</p>
			</main>
		);
	}

	return (
		<>
			{/* Over the live UI, not instead of it. The next successful tick clears it. */}
			{pollError && (
				<p className="banner error" role="status">
					{pollError}
				</p>
			)}
			{/* Only when there is genuinely something newer. "Up to date" and "could
			    not check" are both answers nobody needs a banner about — and a
			    permanent green tick is exactly the reassurance that stops being
			    read. The link opens in the OS browser; the app never fetches it. */}
			{update?.state === 'updateAvailable' && (
				<p className="banner" role="status">
					<strong>{update.version} is available.</strong> Get it from the signed release on GitHub —
					never from a link anywhere else.{' '}
					<a href={update.url} target="_blank" rel="noreferrer noopener">
						Open the release
					</a>
				</p>
			)}
			{screen()}
		</>
	);

	function screen(): React.JSX.Element {
		if (!api || !status) {
			return (
				<main className="shell">
					<p className="muted">Starting…</p>
				</main>
			);
		}

		if (!status.exists) {
			return (
				<CreateVault
					onCreate={async (passphrase) => {
						await api.createVault(passphrase);
						await refresh({ includeCodes: false });
					}}
					// A vault file can be missing while its backup is not — moved,
					// deleted, or a restore that failed partway. Without this, the only
					// route the screen offered was creating a fresh vault, whose second
					// save copies over the backup that still held every account.
					backupAvailable={status.backupAvailable}
					onRestoreBackup={async (passphrase) => {
						await api.restoreVaultBackup(passphrase);
						await refresh({ includeCodes: false });
					}}
					onAdopt={async () => {
						const result = await api.adoptVaultFile();
						// Adopting makes a vault exist, which swaps this screen for the
						// unlock one. Nothing here can unlock it — the passphrase is the
						// user's and the next screen is where it belongs.
						await refresh({ includeCodes: false });
						return result;
					}}
				/>
			);
		}

		if (!status.unlocked) {
			return (
				<UnlockVault
					backupAvailable={status.backupAvailable}
					onRestoreBackup={async (passphrase) => {
						await api.restoreVaultBackup(passphrase);
						await refresh({ includeCodes: false });
					}}
					onUnlock={async (passphrase) => {
						await api.unlockVault(passphrase);
						// Without codes, so the screen swaps as soon as the vault is open
						// rather than when the Steam clock sync finishes. The next poll,
						// a second later, fills them in.
						await refresh({ includeCodes: false });
					}}
				/>
			);
		}

		if (autoConfirmFor) {
			const current =
				accounts.find((entry) => entry.steamId64 === autoConfirmFor.steamId64) ?? autoConfirmFor;
			return (
				<AutoConfirm
					account={current}
					onSave={(settings) => api.setAccountAutoConfirm(current.steamId64, settings)}
					onClose={() => {
						setAutoConfirmFor(undefined);
						void refresh();
					}}
				/>
			);
		}

		if (removingFor) {
			return (
				<RemoveAccount
					account={removingFor}
					onRemove={(passphrase) => api.removeAccount(removingFor.steamId64, passphrase)}
					onDeactivate={(passphrase, acknowledgement) =>
						api.deactivateAuthenticator(removingFor.steamId64, passphrase, acknowledgement)
					}
					onClose={() => {
						setRemovingFor(undefined);
						void refresh();
					}}
				/>
			);
		}

		if (confirmingFor) {
			return (
				<Confirmations
					account={confirmingFor}
					onList={() => api.listConfirmations(confirmingFor.steamId64)}
					onAct={(action, ids) => api.actOnConfirmations(confirmingFor.steamId64, action, ids)}
					onSignIn={(password) => api.signInToSteam(confirmingFor.steamId64, password)}
					onClose={() => setConfirmingFor(undefined)}
				/>
			);
		}

		if (routingFor) {
			// Re-read from the live list so the screen reflects a change made in it,
			// rather than the snapshot taken when it was opened.
			const current =
				accounts.find((entry) => entry.steamId64 === routingFor.steamId64) ?? routingFor;
			return (
				<AccountRouting
					account={current}
					onSave={(proxyUrl) => api.setAccountProxy(current.steamId64, proxyUrl)}
					onClose={() => {
						setRoutingFor(undefined);
						void refresh();
					}}
				/>
			);
		}

		if (backupFor) {
			return (
				<RevocationBackup
					accountName={backupFor.accountName}
					steamId64={backupFor.steamId64}
					onReveal={(passphrase) => api.revealRevocationCode(backupFor.steamId64, passphrase)}
					onConfirm={() => api.confirmRevocationBackup(backupFor.steamId64)}
					onClose={() => {
						setBackupFor(undefined);
						void refresh();
					}}
				/>
			);
		}

		if (view === 'activity') {
			return (
				<Activity
					accounts={accounts}
					onLoad={() => api.listActivity()}
					onSeen={() => {
						void api.acknowledgeActivity().then(() => setActivityUrgent(false));
					}}
					onOpenAccount={(openFor) => {
						setView('accounts');
						setConfirmingFor(openFor);
					}}
					onClose={() => setView('accounts')}
				/>
			);
		}

		if (view === 'about') {
			return <About onLoad={() => api.getAppInfo()} onClose={() => setView('accounts')} />;
		}

		if (view === 'settings') {
			return (
				<Settings
					installedFromStore={installedFromStore}
					onLoad={() => api.getSettings()}
					onSave={async (settings) => {
						const result = await api.updateSettings(settings);
						// Switching the check off must also take down a banner it already
						// raised. Leaving it up meant the one visible consequence of the
						// setting — the only thing it does that a user can see — carried on
						// for the rest of the session as though nothing had changed.
						if (!settings.updateCheck) {
							setUpdate(undefined);
						}
						return result;
					}}
					onClose={() => setView('accounts')}
				/>
			);
		}

		if (view === 'move') {
			return (
				<MoveAuthenticator
					onAuthenticate={(accountName, password, code, proxyUrl) =>
						api.authenticateTransfer(accountName, password, code, proxyUrl)
					}
					onStartChallenge={() => api.startTransferChallenge()}
					onComplete={(smsCode) => api.completeTransfer(smsCode)}
					onRetryPersist={() => api.retryTransferPersist()}
					onRetryDecode={() => api.retryTransferDecode()}
					onCancel={() => api.cancelTransfer()}
					onClose={() => setView('accounts')}
				/>
			);
		}

		if (view === 'enroll') {
			return (
				<AddAuthenticator
					onMove={() => setView('move')}
					{...(resumeEnrollment
						? {
								resume: {
									steamId64: resumeEnrollment.steamId64,
									accountName: resumeEnrollment.accountName
								}
							}
						: {})}
					onBegin={(accountName, password, proxyUrl) =>
						api.beginEnrollment(accountName, password, proxyUrl)
					}
					onEmailCode={(code) => api.submitEnrollmentEmailCode(code)}
					onCancel={() => api.cancelEnrollment()}
					onActivate={(steamId64, code) => api.activateAuthenticator(steamId64, code)}
					onBackup={(steamId64, accountName) => {
						// Straight into the S12 ceremony for the account just created. The
						// revocation code is the one thing a new enrollment must not leave
						// the user without, and making them go and find it invites skipping.
						//
						// The account is **not** looked up in `accounts` first. That list is
						// polled, so in the seconds after an enrollment it may not contain
						// the new SteamID yet — and the lookup failing meant the button did
						// nothing at all: no navigation, no error, at the exact moment the
						// screen is telling the user this is the one step not to skip. The
						// enrollment screen already knows both values, so it passes them.
						setView('accounts');
						setBackupFor({ steamId64, accountName });
					}}
					onClose={() => {
						setResumeEnrollment(undefined);
						setView('accounts');
					}}
				/>
			);
		}

		if (view === 'recover') {
			return (
				<RecoverAccount
					onRecover={(passphrase) => api.recoverAccount(passphrase)}
					onClose={() => {
						setView('accounts');
						// A restored account has to appear without waiting on the poll —
						// the whole point of the screen is seeing it come back.
						void refresh();
					}}
				/>
			);
		}

		if (view === 'import') {
			return (
				<ImportAccounts
					onScan={() => api.scanMaFiles()}
					onUnlock={(passphrase) => api.unlockImport(passphrase)}
					onCommit={(selections) => api.commitImport(selections)}
					onDiscard={() => api.discardImport()}
					onClose={() => {
						setView('accounts');
						// Imported accounts appear without waiting on the poll, the same way
						// a recovered one does. A second of the list not showing what the
						// previous screen just said it imported reads as a failure.
						void refresh();
					}}
				/>
			);
		}

		return (
			<VaultHome
				accounts={accounts}
				codes={codes}
				msUntilAutoLock={status.msUntilAutoLock}
				onCopyCode={(steamId64) => api.copyCode(steamId64)}
				onBackUpRevocationCode={setBackupFor}
				onChangeRouting={setRoutingFor}
				onShowConfirmations={setConfirmingFor}
				onRemoveAccount={setRemovingFor}
				onChangeAutoConfirm={setAutoConfirmFor}
				onImport={() => setView('import')}
				onRecover={() => setView('recover')}
				onEnrol={() => {
					setResumeEnrollment(undefined);
					setView('enroll');
				}}
				onMove={() => setView('move')}
				onFinishActivation={(account) => {
					setResumeEnrollment(account);
					setView('enroll');
				}}
				onExport={(account) => api.exportAccount(account.steamId64)}
				onSettings={() => setView('settings')}
				onAbout={() => setView('about')}
				onActivity={() => setView('activity')}
				activityUrgent={activityUrgent}
				onLock={() => {
					// The main process reloads this window on lock, so there is nothing to
					// clean up here — the whole document goes.
					void api.lockVault();
				}}
			/>
		);
	}
}
