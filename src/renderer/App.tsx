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
import { Settings } from './screens/Settings';
import { ImportAccounts } from './screens/ImportAccounts';
import { AddAuthenticator } from './screens/AddAuthenticator';
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
	const [view, setView] = useState<'accounts' | 'import' | 'settings' | 'activity' | 'enroll'>(
		'accounts'
	);
	/**
	 * An enrolled-but-unactivated account being resumed, if any.
	 *
	 * Kept here rather than inside the enrollment screen so that leaving it — to
	 * write the revocation code down, which the screen instructs — does not
	 * destroy the only route back to finishing.
	 */
	const [resumeEnrollment, setResumeEnrollment] = useState<AccountSummary | undefined>();
	/** The account whose backup ceremony is open, if any. */
	const [backupFor, setBackupFor] = useState<AccountSummary | undefined>();
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
	/** Latest answer from the update check. Only `updateAvailable` is ever shown. */
	const [update, setUpdate] = useState<UpdateCheckResult | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
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
		// Regenerated on every tick rather than cached until the window rolls over.
		// A code is an HMAC over twenty bytes; recomputing one per second per
		// account costs nothing, and it removes an entire class of bug where the
		// displayed code and its countdown disagree about which window they are in.
		setCodes(await api.listCodes());
		// Polled with everything else so the alert appears without the user having
		// to go looking for it — which is the entire point of an alert.
		setActivityUrgent((await api.listActivity()).urgent);
	}, [api]);

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
		const tick = (): void => {
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
						await refresh();
					}}
				/>
			);
		}

		if (!status.unlocked) {
			return (
				<UnlockVault
					backupAvailable={status.backupAvailable}
					onUnlock={async (passphrase) => {
						await api.unlockVault(passphrase);
						await refresh();
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
					onOpenAccount={(openFor) => {
						setView('accounts');
						setConfirmingFor(openFor);
					}}
					onClose={() => setView('accounts')}
				/>
			);
		}

		if (view === 'settings') {
			return (
				<Settings
					onLoad={() => api.getSettings()}
					onSave={(settings) => api.updateSettings(settings)}
					onClose={() => setView('accounts')}
				/>
			);
		}

		if (view === 'enroll') {
			return (
				<AddAuthenticator
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
					onActivate={(steamId64, code) => api.activateAuthenticator(steamId64, code)}
					onBackup={(steamId64) => {
						// Straight into the S12 ceremony for the account just created. The
						// revocation code is the one thing a new enrollment must not leave
						// the user without, and making them go and find it invites skipping.
						const account = accounts.find((entry) => entry.steamId64 === steamId64);
						if (account) {
							setView('accounts');
							setBackupFor(account);
						}
					}}
					onClose={() => {
						setResumeEnrollment(undefined);
						setView('accounts');
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
					onClose={() => setView('accounts')}
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
				onEnrol={() => {
					setResumeEnrollment(undefined);
					setView('enroll');
				}}
				onFinishActivation={(account) => {
					setResumeEnrollment(account);
					setView('enroll');
				}}
				onExport={(account) => {
					void api.exportAccount(account.steamId64);
				}}
				onSettings={() => setView('settings')}
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
